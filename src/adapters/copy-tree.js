'use strict';

// Shared copy-tree engine — the generic "own a tree of files" implementation every asset
// declaring `renderer: "copy-tree"` in core/registry/assets.json needs. Codex's adapter already
// proved this per-file fingerprint/conflict model for agents and hooks (ownedRemovalPlan,
// nativeManagedResources); this module generalizes it so Claude, Gemini, and Codex's own
// tree-shaped assets (skills, rules, agent-specs, templates, scripts, modes, references) share
// one implementation instead of three adapter-specific copies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walkRelFiles(dir, fsImpl) {
  const out = [];
  for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRelFiles(abs, fsImpl).map((rel) => path.join(entry.name, rel)));
    else if (entry.isFile()) out.push(entry.name);
  }
  return out;
}

/** Destination layouts. A copy-tree normally mirrors source paths exactly, but a harness may
 * require a different shape for the same content: Antigravity discovers a custom agent at
 * `.agents/agents/<name>/agent.md`, a directory per agent, so DoFlow's flat `<name>.md` specs were
 * written where that harness never looks. Declared per projection in the registry rather than
 * branched on inside an adapter, so the shape stays visible next to the asset it applies to.
 * @type {Record<string, (sourceRel: string) => string>}
 */
const LAYOUTS = {
  /** `spec-analyst.md` -> `spec-analyst/agent.md` */
  'dir-per-file:agent.md': (sourceRel) => {
    const ext = path.extname(sourceRel);
    return path.join(sourceRel.slice(0, sourceRel.length - ext.length), `agent${ext || '.md'}`);
  },
  /** `RULE_01_SAFETY.md` -> `RULE_01_SAFETY.instructions.md` — GitHub's path-specific
   * instructions are discovered by their `.instructions.md` suffix. */
  'instructions-md': (sourceRel) => {
    const ext = path.extname(sourceRel);
    return `${sourceRel.slice(0, sourceRel.length - ext.length)}.instructions.md`;
  },
  /** `MODE_Orchestration.md` -> `doflow-orchestration.md` — Claude's /config picker lists
   * output styles by file name; the doflow- prefix keeps DoFlow's styles grouped and
   * non-colliding with anything a user authors by hand. */
  'doflow-output-style': (sourceRel) => {
    const ext = path.extname(sourceRel);
    const base = path.basename(sourceRel, ext).replace(/^MODE_/i, '').replace(/_/g, '-').toLowerCase();
    return `doflow-${base}${ext || '.md'}`;
  },
};

/** Resolve a declared layout name to its mapper. Unknown names fail loudly rather than silently
 * mirroring, because a typo would otherwise install to the wrong shape and look like it worked. */
function resolveLayout(name) {
  if (!name) return (rel) => rel;
  const layout = LAYOUTS[name];
  if (!layout) throw new Error(`Unknown copy-tree layout '${name}' (known: ${Object.keys(LAYOUTS).join(', ')})`);
  return layout;
}

/** Destination content transforms. Where a harness reads a supported but different file FORMAT
 * than the shared source authors (Copilot's path-specific instructions require an `applyTo`
 * frontmatter header; OpenCode's markdown agents want their own frontmatter vocabulary), the
 * projection declares a named transform instead of an adapter branching on bytes. A transform is
 * a pure function of (sourceRelPath, sourceBytes) -> Buffer: deterministic, so the fingerprint
 * planTree records is the fingerprint verifyTree re-derives and removeTree re-checks, and so
 * applyTree can re-derive the written bytes from the untouched source at any later retry.
 * @type {Record<string, (sourceRel: string, content: Buffer) => Buffer>}
 */
const TRANSFORMS = {
  /** Shared mode doc -> Claude output style with name/description/keep-coding-instructions */
  'claude-output-styles': renderClaudeOutputStyle,
  /** `<rule>.md` -> `<rule>.instructions.md` body under a Copilot applyTo header */
  'copilot-rule-instructions': (sourceRel, content) => {
    void sourceRel;
    return Buffer.from(`---\napplyTo: '**'\n---\n\n${stripFrontmatter(content.toString('utf8'))}`);
  },
  /** Shared agent spec frontmatter -> only the keys Gemini CLI's subagent schema accepts */
  'gemini-agents': (sourceRel, content) => {
    void sourceRel;
    return Buffer.from(filterGeminiAgentFrontmatter(content.toString('utf8')));
  },
  /** Shared agent spec frontmatter -> OpenCode's markdown-agent vocabulary */
  'opencode-agents': (sourceRel, content) => {
    void sourceRel;
    return Buffer.from(renderOpencodeAgent(content.toString('utf8')));
  },
};

function resolveTransform(name) {
  if (!name) return null;
  const transform = TRANSFORMS[name];
  if (!transform) throw new Error(`Unknown copy-tree transform '${name}' (known: ${Object.keys(TRANSFORMS).join(', ')})`);
  return transform;
}

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\n+/, '');
}

/** Wrap a shared mode document as a Claude output style: system-prompt modifiers keep the
 * built-in engineering instructions (these styles shape HOW DoFlow works, not WHETHER Claude
 * codes). The description is lifted from the document's first `**Purpose**` line so the /config
 * picker explains each style without opening it. */
function renderClaudeOutputStyle(sourceRel, content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const base = path.basename(sourceRel).replace(/\.[^.]+$/, '').replace(/^MODE_/i, '').replace(/_/g, ' ');
  const purpose = text.match(/\*\*Purpose\*\*[:*]*\s*(.+)?/);
  const description = (purpose && purpose[1] ? purpose[1] : `DoFlow ${base} mode`).trim().replace(/\s+/g, ' ');
  return ['---', `name: DoFlow: ${base}`, `description: ${JSON.stringify(description)}`, 'keep-coding-instructions: true', '---', '', text.replace(/\n*$/, ''), ''].join('\n');
}

/** The frontmatter keys Gemini CLI documents for a custom subagent (https://geminicli.com/docs/core/subagents, accessed 2026-10-06).
 * Its agent schema is strict, so a spec key outside this list (DoFlow's `effort`) would be rejected. */
const GEMINI_AGENT_KEYS = new Set(['name', 'description', 'kind', 'tools', 'mcpServers', 'model', 'temperature', 'max_turns', 'timeout_mins']);

/** Keep only Gemini's documented top-level frontmatter keys, with their indented continuation
 * lines, in source order. The body after the closing `---` passes through byte for byte, and a
 * file without frontmatter is returned unchanged. */
function filterGeminiAgentFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?\r?\n)---(?=\r?\n|$)/);
  if (!match) return text;
  let keep = false;
  const kept = match[1].split(/(?<=\n)/).filter((line) => {
    const key = line.match(/^([A-Za-z][A-Za-z0-9_-]*):/);
    if (key) keep = GEMINI_AGENT_KEYS.has(key[1]);
    return keep;
  });
  return `${text.slice(0, text.indexOf('\n') + 1)}${kept.join('')}${text.slice(match[0].length - 3)}`;
}

const OPENCODE_READONLY_AGENTS = new Set(['spec-analyst', 'system-architect', 'quality-guardian', 'research-writer']);

/** Map one core/shared agent-spec file onto OpenCode's documented markdown-agent frontmatter
 * (description / mode / permission; model omitted because OpenCode has no 'inherit'). Unknown
 * spec keys (tools, effort) are dropped rather than passed through, so OpenCode never sees
 * vocabulary it does not define. Body below the frontmatter passes through untouched. */
function renderOpencodeAgent(text) {
  const fm = {};
  let body = text;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      for (const line of text.slice(4, end).split('\n')) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim().replace(/^"|"$/g, '');
      }
      body = text.slice(end + 4).replace(/^\n+/, '');
    }
  }
  const lines = ['---'];
  if (fm.description) lines.push(`description: ${JSON.stringify(fm.description)}`);
  lines.push('mode: subagent');
  if (OPENCODE_READONLY_AGENTS.has(fm.name)) {
    lines.push('permission:', '  edit: deny', '  bash: deny');
  }
  lines.push('---', '', body.replace(/\n*$/, ''), '');
  return lines.join('\n');
}

/** List every source file with its would-be destination and content fingerprint. Does not touch
 * the destination tree beyond checking existence. `relPath` is destination-relative and doubles as
 * the ledger identity, so a layout change relocates the recorded resource too — planTree's
 * relocation handling then removes the old path rather than orphaning it. */
function discoverTree({ sourceDir, destDir, fsImpl = fs, layout, transform }) {
  if (!fsImpl.existsSync(sourceDir)) throw new Error(`copy-tree source is missing: ${sourceDir}`);
  const mapRel = typeof layout === 'function' ? layout : resolveLayout(layout);
  const mapContent = typeof transform === 'function' ? transform : resolveTransform(transform);
  const files = walkRelFiles(sourceDir, fsImpl).map((sourceRel) => {
    const relPath = mapRel(sourceRel);
    const sourceAbs = path.join(sourceDir, sourceRel);
    const destAbs = path.join(destDir, relPath);
    const raw = fsImpl.readFileSync(sourceAbs);
    return { relPath, sourceAbs, destAbs, exists: fsImpl.existsSync(destAbs), fingerprint: sha256(mapContent ? mapContent(sourceRel, raw) : raw) };
  });
  return { files };
}

/**
 * Diff the source tree against `previousResources` (the ledger's prior per-file ownership
 * records: `{relPath, fingerprint}`) to produce create/update/remove changes, refusing to touch
 * any destination file whose on-disk content doesn't match its last-recorded fingerprint (or, for
 * a never-before-owned file, doesn't match the source it would be overwritten with) — the same
 * conflict-safety Codex's adapter already applies to agents and hooks.
 * `operation: 'remove'` skips the source tree entirely and only proposes removals for every
 * previously-owned file, mirroring Codex's `ownedRemovalPlan`.
 * `siblingReplaced` lists the harnesses whose recorded bytes this plan replaces: the file matches
 * neither the source nor this harness's own record, only a sibling's (forced or not).
 */
function planTree({ sourceDir, destDir, previousResources = [], operation = 'apply', fsImpl = fs, layout, transform, force = false, keepModified = false, siblingFingerprints = new Map() }) {
  const prevByPath = new Map(previousResources.map((resource) => [resource.relPath, resource]));
  const changes = [];
  const conflicts = [];
  const kept = [];
  const siblingReplaced = new Set();

  // Fingerprints the CURRENT source would write, keyed by destination. Resolved lazily and only
  // when a recorded fingerprint has already failed to match, so the common removal path still
  // never reads the source tree. A missing source directory is not an error here — an asset can be
  // removed after its source moved — it simply leaves the recorded fingerprint as the only signal.
  let sourceByDest;
  const sourceFingerprint = (destAbs) => {
    if (sourceByDest === undefined) {
      sourceByDest = sourceDir && fsImpl.existsSync(sourceDir)
        ? new Map(discoverTree({ sourceDir, destDir, fsImpl, layout, transform }).files.map((file) => [file.destAbs, file.fingerprint]))
        : new Map();
    }
    return sourceByDest.get(destAbs);
  };

  const proposeRemoval = (prev, { relocated = false } = {}) => {
    // prev's OWN recorded location, not the current destDir — an asset whose nativeDir changed
    // since prev was recorded must be removed from where it actually is, not from where it would
    // land today. Absent (pre-this-fix data, or a caller-constructed previousResources entry with
    // no target) falls back to the old destDir-relative computation, unchanged.
    const destAbs = prev.target ?? path.join(destDir, prev.relPath);
    if (!fsImpl.existsSync(destAbs)) return;
    const current = sha256(fsImpl.readFileSync(destAbs));
    // Untampered on removal means the same two signals the apply path below already accepts: the
    // bytes this harness last recorded, or the bytes the current source would write. The second
    // one matters because a destination tree can be claimed by several harnesses (scripts.doflow
    // is one `<project>/.doflow/scripts` for claude, codex and gemini), so a sibling's update
    // legitimately rewrites files this harness's rows still describe — the same "a sibling
    // changed bytes my row still describes" case the apply path had to be taught, arriving here
    // as an un-releasable claim instead of a refused install. A hand edit matches neither and is
    // still refused. The OBSERVED fingerprint travels with the change so removeTree's own
    // pre-delete re-check agrees with the decision taken here rather than throwing mid-apply.
    const modified = current !== prev.fingerprint && current !== sourceFingerprint(destAbs);
    // A row left behind by an apply (the asset moved, or its source file went away) is released,
    // and a hand edit there is the user's, not DoFlow's: with `keepModified` the file stays where
    // it is, force or not, and only the ledger row goes. The change carries `kept` so removeTree
    // skips it and the caller can say so.
    if (relocated && keepModified && modified) {
      kept.push({ relPath: prev.relPath, target: destAbs });
      changes.push({ relPath: prev.relPath, target: destAbs, operation: 'remove', fingerprint: current, kept: true });
      return;
    }
    if (!force && modified) {
      conflicts.push(`${prev.relPath} was modified outside DoFlow`);
      return;
    }
    changes.push({ relPath: prev.relPath, target: destAbs, operation: 'remove', fingerprint: current });
  };

  if (operation === 'remove') {
    for (const prev of previousResources) proposeRemoval(prev);
    return { changes, conflicts, kept, siblingReplaced: [] };
  }

  const { files } = discoverTree({ sourceDir, destDir, fsImpl, layout, transform });
  const satisfiedAtSameLocation = new Set();
  for (const file of files) {
    const prev = prevByPath.get(file.relPath);
    // prev.target === undefined means "location unknown" (pre-this-fix ledger data, or a
    // caller-constructed previousResources entry) — treat as same-location, matching pre-fix
    // behavior exactly, rather than misreading "no data" as "relocated" and spuriously removing
    // it. Only an explicit, differing target means the asset's nativeDir actually changed.
    const sameLocation = prev !== undefined && (prev.target === undefined || prev.target === file.destAbs);
    if (sameLocation) satisfiedAtSameLocation.add(file.relPath);
    if (file.exists) {
      // A destination file is untampered if it matches the source we are about to write, OR the
      // fingerprint this harness last recorded AT THIS LOCATION. Source-match is checked FIRST and
      // unconditionally: it is the stronger signal, and a present-but-stale `prev` must not shadow
      // it.
      //
      // This matters because guidance.context-layer projects one destination for all three
      // harnesses while ownership is recorded per harness, so a sibling's install legitimately
      // changes bytes that this harness's row still describes. Comparing only against `prev` made
      // that indistinguishable from a hand edit and refused the whole install. Ordering the
      // disjunction this way adds no new notion of safety — it stops a weaker signal from
      // preempting a check that would have passed. Gating the fallback on `sameLocation` (rather
      // than `prev !== undefined` alone, as before) is strictly more precise: a relocated asset's
      // old row describes different bytes at a different path, so it must not be consulted here.
      const current = sha256(fsImpl.readFileSync(file.destAbs));
      const ownRecord = current === file.fingerprint || (sameLocation && current === prev.fingerprint);
      const sibling = ownRecord ? undefined : siblingFingerprints.get(file.destAbs)?.get(current);
      const knownGood = force || ownRecord || sibling !== undefined;
      if (!knownGood) { conflicts.push(`${file.relPath} was modified outside DoFlow`); continue; }
      if (sibling !== undefined) siblingReplaced.add(sibling);
      // A true no-op requires the DESTINATION bytes to equal the incoming source. Comparing only
      // ledger-vs-source fingerprints here (the previous form) let a forced run over a hand-edited
      // destination — force ⇒ knownGood — fall through and silently ignore exactly the drift it
      // was asked to heal.
      if (sameLocation && current === file.fingerprint && prev.fingerprint === file.fingerprint) continue; // unchanged, no-op
    }
    changes.push({ relPath: file.relPath, target: file.destAbs, source: file.sourceAbs,
      operation: sameLocation ? 'update' : 'create', fingerprint: file.fingerprint });
  }
  for (const prev of previousResources) {
    if (!satisfiedAtSameLocation.has(prev.relPath)) proposeRemoval(prev, { relocated: true });
  }
  return { changes, conflicts, kept, siblingReplaced: [...siblingReplaced].sort() };
}

/** Write every create/update change. Preserves the source file's mode (so a hook script's +x
 * bit survives the copy without a separate chmod pass) and mtime, matching this codebase's
 * general convention for a lifecycle-owned write (see src/adapters/claude/index.js's
 * applySettingsAsset for the same pattern applied to a transformed-content file). */
function applyTree({ changes = [], fsImpl = fs, transform }) {
  const mapContent = typeof transform === 'function' ? transform : resolveTransform(transform);
  let applied = 0;
  for (const change of changes) {
    if (change.operation === 'remove') continue;
    fsImpl.mkdirSync(path.dirname(change.target), { recursive: true });
    const sourceStat = fsImpl.statSync(change.source);
    if (mapContent) {
      // Re-derive the bytes from the source at write time instead of copying it: the transform,
      // not the source file, is what the recorded fingerprint describes. Keeps recovery retries
      // correct without ever persisting rendered content in state.
      fsImpl.writeFileSync(change.target, mapContent(path.basename(change.source), fsImpl.readFileSync(change.source)));
      fsImpl.chmodSync(change.target, sourceStat.mode & 0o777);
    } else {
      fsImpl.copyFileSync(change.source, change.target);
      fsImpl.chmodSync(change.target, sourceStat.mode & 0o777);
    }
    fsImpl.utimesSync(change.target, Math.floor(sourceStat.atimeMs / 1000), Math.floor(sourceStat.mtimeMs / 1000));
    applied += 1;
  }
  return { applied };
}

/** Delete every remove change, re-checking each file's fingerprint immediately before deletion —
 * refuses (throws) rather than silently deleting a file modified since planTree ran. */
function removeTree({ changes = [], fsImpl = fs }) {
  let removed = 0;
  for (const change of changes) {
    if (change.operation !== 'remove' || change.kept) continue;
    if (!fsImpl.existsSync(change.target)) continue;
    const current = sha256(fsImpl.readFileSync(change.target));
    if (current !== change.fingerprint) throw new Error(`Refusing to remove modified copy-tree resource: ${change.relPath}`);
    fsImpl.rmSync(change.target, { force: true });
    pruneEmptyAncestors(path.dirname(change.target), { fsImpl });
    removed += 1;
  }
  return { removed };
}

const ANCHOR_DIRS = new Set(['.agents', '.claude', '.codex', '.copilot', '.doflow', '.gemini', '.github', '.kiro', '.opencode', '.pi']);

/** Delete now-empty ancestor directories after a file removal, so a relocated or fully-uninstalled
 * tree doesn't leave a skeleton of empty folders behind. Walks upward only while rmdir succeeds
 * (i.e. the directory is empty, so it holds nothing but what the removal just emptied); stops
 * unconditionally at a directory whose basename is in ANCHOR_DIRS — the dot-folder harness roots,
 * which may hold user content elsewhere. The match is by basename, so a root with another name
 * (`~/.gemini/config`, `~/.pi/agent`, `~/.config/opencode`) is pruned once it is empty; no file is
 * ever lost, since rmdir refuses a folder that holds one. */
function pruneEmptyAncestors(startDir, { fsImpl = fs } = {}) {
  let current = startDir;
  for (;;) {
    const basename = path.basename(current);
    if (!basename || basename === '.' || basename === path.sep || ANCHOR_DIRS.has(basename)) return;
    try { fsImpl.rmdirSync(current); } catch { return; }
    current = path.dirname(current);
  }
}

/** Re-derive ownership resources from what's actually on disk right now, for status/verify. */
function verifyTree({ sourceDir, destDir, fsImpl = fs, layout, transform }) {
  const { files } = discoverTree({ sourceDir, destDir, fsImpl, layout, transform });
  const resources = [];
  const conflicts = [];
  for (const file of files) {
    if (!file.exists) continue;
    const current = sha256(fsImpl.readFileSync(file.destAbs));
    if (current !== file.fingerprint) { conflicts.push(`${file.relPath} does not match source`); continue; }
    resources.push({ relPath: file.relPath, target: file.destAbs, fingerprint: file.fingerprint });
  }
  return { ok: conflicts.length === 0, resources, conflicts };
}

// ---- per-adapter copy-tree glue, shared so codex/claude/gemini don't each carry their own copy ----

/** Filter a harness's asset list down to the ones this engine handles. */
function copyTreeAssets(assets) {
  return (assets || []).filter((asset) => asset?.renderer === 'copy-tree');
}

/** Recursively sort object keys before serializing, so two logically-equal objects with
 * differently-ordered keys (e.g. after a settings file is merged and re-merged) fingerprint
 * identically instead of spuriously registering as changed. */
function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
}

/** Content fingerprint every adapter uses to track what it owns: sha256 of a string as-is, or of
 * a stably key-sorted JSON serialization of anything else. */
function fingerprint(value) {
  return sha256(typeof value === 'string' ? value : JSON.stringify(stableSort(value)));
}

/** Read and parse a native JSON file an adapter merges into. Distinguishes "absent" (safe to
 * create) from "present but unparseable" (a conflict to report, never silently overwritten) —
 * every adapter that merges into a native JSON settings/config file needs exactly this. */
function readJson(file, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(file)) return { exists: false, value: {}, error: null };
  try { return { exists: true, value: JSON.parse(fsImpl.readFileSync(file, 'utf8')), error: null }; }
  catch (error) { return { exists: true, value: null, error: `Invalid JSON in ${file}: ${error.message}` }; }
}

/** Resolve an asset's source directory against the repo root, refusing a path that escapes the
 * repository or does not exist. `harnessName` only shapes the thrown error message. */
function sourceDirFor(asset, context = {}, fsImpl = fs, harnessName = 'Adapter') {
  if (!asset || typeof asset.source !== 'string') throw new Error(`${harnessName} asset requires a source path`);
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : process.cwd();
  const source = path.resolve(repoRoot, asset.source);
  if (!source.startsWith(`${repoRoot}${path.sep}`) || !fsImpl.existsSync(source)) {
    throw new Error(`${harnessName} asset source is unavailable: ${asset.source}`);
  }
  return source;
}

/** Resolve an asset's native destination directory under the harness's already-resolved config dir. */
function copyTreeDestDir(configDir, asset) {
  return path.join(configDir, asset.nativeDir || '');
}

/** Destination of a `../.doflow` shared-tree asset at the scope root (`<project>/.doflow`, or
 * `$HOME/.doflow` globally), for harnesses whose tree root sits more than one level under the scope
 * root. Returns null for any other nativeDir, so the caller falls back to `copyTreeDestDir`. */
function sharedTreeDestDir(rootDir, nativeDir) {
  if (nativeDir !== '../.doflow' && !String(nativeDir || '').startsWith('../.doflow/')) return null;
  const sharedRoot = path.join(rootDir, '.doflow');
  const dest = path.join(rootDir, '.doflow', nativeDir.slice('../.doflow'.length));
  if (dest !== sharedRoot && !dest.startsWith(`${sharedRoot}${path.sep}`)) {
    throw new Error(`shared-tree nativeDir escapes .doflow: ${nativeDir}`);
  }
  return dest;
}

/** The assets that project the one runtime tree several harnesses claim at a scope root. */
const SHARED_RUNTIME_ASSETS = new Set(['scripts.doflow', 'runtime.cli', 'runtime.lib', 'runtime.registry']);

/** For each shared runtime target, the fingerprints other harnesses recorded and which harness
 * recorded each, so an update accepts a runtime tree a sibling wrote (several harnesses claim one
 * `.doflow` file) while bytes no runtime row recorded are still refused as a hand edit. */
function ledgerSiblingFingerprints(resources, harness) {
  const byTarget = new Map();
  for (const resource of resources || []) {
    if (resource.kind !== 'copy-tree-file' || resource.harness === harness || !SHARED_RUNTIME_ASSETS.has(resource.assetId)) continue;
    if (typeof resource.target !== 'string' || typeof resource.fingerprint !== 'string') continue;
    if (!byTarget.has(resource.target)) byTarget.set(resource.target, new Map());
    const byFingerprint = byTarget.get(resource.target);
    if (!byFingerprint.has(resource.fingerprint)) byFingerprint.set(resource.fingerprint, resource.harness);
  }
  return byTarget;
}

/** The one-line plan notice for a plan whose copy-tree results replaced sibling-written files, or
 * an empty list when none did. */
function siblingReplacedNotices(results) {
  const harnesses = [...new Set(results.flatMap((result) => result.siblingReplaced))].sort();
  if (!harnesses.length) return [];
  return [`replaced shared runtime files written by ${harnesses.join(', ')}; reinstall ${harnesses.length > 1 ? 'those harnesses' : 'that harness'} to restore them`];
}

/** Narrow a harness's flat neutral-resource list to one asset's previously-owned copy-tree files. */
function ledgerFileResources(resources, harness, assetId) {
  return (resources || [])
    .filter((resource) => resource.harness === harness && resource.assetId === assetId && resource.kind === 'copy-tree-file')
    .map((resource) => ({ relPath: resource.identity, fingerprint: resource.fingerprint, target: resource.target }));
}

module.exports = { discoverTree, planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, sharedTreeDestDir, ledgerFileResources, ledgerSiblingFingerprints, siblingReplacedNotices, resolveLayout, LAYOUTS, resolveTransform, TRANSFORMS, fingerprint, pruneEmptyAncestors, readJson, sourceDirFor };

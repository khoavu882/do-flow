'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Shared copy-tree engine — the generic "own a tree of files" implementation every asset
// declaring `renderer: "copy-tree"` in core/registry/assets.json needs. Codex's adapter already
// proved this per-file fingerprint/conflict model for agents and hooks (ownedRemovalPlan,
// nativeManagedResources); this module generalizes it so every adapter's
// tree-shaped assets (skills, rules, agent-specs, templates, scripts, modes, references) share
// one implementation instead of adapter-specific copies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { guidanceManifest } = require('./guidance-manifest.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');

function sha256(buf: any): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walkRelFiles(dir: string, fsImpl: any): string[] {
  const out: string[] = [];
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
const LAYOUTS: Record<string, (sourceRel: string) => string> = {
  /** `spec-analyst.md` -> `spec-analyst/agent.md` */
  'dir-per-file:agent.md': (sourceRel: string) => {
    const ext = path.extname(sourceRel);
    return path.join(sourceRel.slice(0, sourceRel.length - ext.length), `agent${ext || '.md'}`);
  },
  /** `RULES.md` -> `RULES.instructions.md` — GitHub's path-specific
   * instructions are discovered by their `.instructions.md` suffix. */
  'instructions-md': (sourceRel: string) => {
    const ext = path.extname(sourceRel);
    return `${sourceRel.slice(0, sourceRel.length - ext.length)}.instructions.md`;
  },
  /** `MODE_Orchestration.md` -> `doflow-orchestration.md` — Claude's /config picker lists
   * output styles by file name; the doflow- prefix keeps DoFlow's styles grouped and
   * non-colliding with anything a user authors by hand. */
  'doflow-output-style': (sourceRel: string) => {
    const ext = path.extname(sourceRel);
    const base = path.basename(sourceRel, ext).replace(/^MODE_/i, '').replace(/_/g, '-').toLowerCase();
    return `doflow-${base}${ext || '.md'}`;
  },
  /** `core-implementer.md` -> `core-implementer.json` — kiro-cli discovers custom agents as
   * `.kiro/agents/<name>.json` (2.27.1 `kiro-cli agent list` did not list `.md` agents). */
  'kiro-agent-json': (sourceRel: string) => {
    const ext = path.extname(sourceRel);
    return `${sourceRel.slice(0, sourceRel.length - ext.length)}.json`;
  },
  /** `rules/RULES.md` -> `RULES.md` for flat rule directories. */
  flat: (sourceRel: string) => path.basename(sourceRel),
};

/** Resolve a declared layout name to its mapper. Unknown names fail loudly rather than silently
 * mirroring, because a typo would otherwise install to the wrong shape and look like it worked. */
function resolveLayout(name: any): (sourceRel: string) => string {
  if (!name) return (rel: string) => rel;
  const layout = LAYOUTS[name];
  if (!layout) throw new Error(`Unknown copy-tree layout '${name}' (known: ${Object.keys(LAYOUTS).join(', ')})`);
  return layout;
}

/** Source-file selectors for projections that intentionally materialize only part of a tree. */
const SELECTORS: Record<string, (sourceDir: string, fsImpl: any) => Set<string>> = {
  // A dangling import that is not generated would install a core set missing a file the entry file
  // names, silently; the selector fails instead (MCP_INDEX.md is generated and exempt) (107-B C-4).
  'guidance-manifest': (sourceDir: string, fsImpl: any) => {
    const { files, dangling } = guidanceManifest(sourceDir, fsImpl);
    if (dangling.length) throw new Error(`guidance-manifest: DOFLOW_CORE.md imports files that do not exist under ${sourceDir}: ${dangling.join(', ')}`);
    return new Set(files);
  },
};

/** Resolve a declared selector name, or return null when a projection mirrors the whole tree. */
function resolveSelect(name: any): ((sourceDir: string, fsImpl: any) => Set<string>) | null {
  if (name == null) return null;
  const selector = SELECTORS[name];
  if (!selector) throw new Error(`Unknown copy-tree select '${name}' (known: ${Object.keys(SELECTORS).join(', ')})`);
  return selector;
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
const TRANSFORMS: Record<string, (sourceRel: string, content: any) => any> = {
  /** Shared mode doc -> Claude output style with name/description/keep-coding-instructions */
  'claude-output-styles': renderClaudeOutputStyle,
  /** `<rule>.md` -> `<rule>.instructions.md` body under a Copilot applyTo header */
  'copilot-rule-instructions': (sourceRel: string, content: any) => {
    void sourceRel;
    return Buffer.from(`---\napplyTo: '**'\n---\n\n${stripFrontmatter(content.toString('utf8'))}`);
  },
  /** `<rule>.md` -> the same body under Antigravity's `trigger: always_on` front-matter. Antigravity
   * silently discards a `.agents/rules/*.md` file without valid front-matter, so the shared core
   * files (which carry none) are loaded only through this header (107-B review C-2). */
  'antigravity-always-on-rules': (sourceRel: string, content: any) => {
    void sourceRel;
    return Buffer.from(`---\ntrigger: always_on\n---\n\n${stripFrontmatter(content.toString('utf8'))}`);
  },
  /** Shared agent spec -> the same file without `access`, plus Claude's read-only limit keys (118 IC-005) */
  'claude-agents': (sourceRel: string, content: any) => {
    void sourceRel;
    return Buffer.from(applyAgentLimits(content.toString('utf8'), 'claude'));
  },
  /** Shared agent spec -> the same file without `access`; Codex's limit is `unenforced` (the TOML carries it), so no keys are added */
  'codex-agents': (sourceRel: string, content: any) => {
    void sourceRel;
    return Buffer.from(applyAgentLimits(content.toString('utf8'), 'codex'));
  },
  /** Shared agent spec -> the same file without `access`, plus Copilot's read-only limit keys (118 IC-005) */
  'copilot-agents': (sourceRel: string, content: any) => {
    void sourceRel;
    return Buffer.from(applyAgentLimits(content.toString('utf8'), 'copilot'));
  },
  /** Shared agent spec -> the same file without `access`; Antigravity's limit is `unenforced`, so no keys are added */
  'antigravity-agents': (sourceRel: string, content: any) => {
    void sourceRel;
    return Buffer.from(applyAgentLimits(content.toString('utf8'), 'antigravity'));
  },
  /** Shared agent spec frontmatter -> OpenCode's markdown-agent vocabulary */
  'opencode-agents': (sourceRel: string, content: any) => {
    void sourceRel;
    return Buffer.from(renderOpencodeAgent(content.toString('utf8')));
  },
  /** Shared agent spec -> kiro-cli custom agent JSON (name, description, prompt, tools, hooks) */
  'kiro-agents': (sourceRel: string, content: any) => {
    void sourceRel;
    return Buffer.from(renderKiroAgent(content.toString('utf8')));
  },
  /** Hook tiers (maint-hooks): the same Kiro agent with no `hooks`, for Kiro outside `hooks.harnesses`. */
  'kiro-agents-content': (sourceRel: string, content: any) => {
    void sourceRel;
    return Buffer.from(renderKiroAgent(content.toString('utf8'), { hooks: false }));
  },
  /** Hook tiers: an authored Kiro agent JSON (core/harnesses/kiro/agents) without its `hooks` key. */
  'kiro-agent-content': (sourceRel: string, content: any) => {
    if (!sourceRel.endsWith('.json')) return content;
    const agent = JSON.parse(content.toString('utf8'));
    delete agent.hooks;
    return Buffer.from(`${JSON.stringify(agent, null, 2)}\n`);
  },
};

/** Row 131: core/registry/contracts.json, read once. Its `agentSkillsSpec` holds the Agent Skills
 * spec keys; each contract's `skillFields` the keys that harness documents. */
const SKILL_CONTRACTS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'contracts.json'), 'utf8'));

/** One `skill-frontmatter-<harness>` transform per contract that lists skillFields: a SKILL.md keeps
 * the spec keys and that harness's skillFields at the top level, and every other top-level key moves
 * under `metadata` as a quoted string. Files other than SKILL.md pass through unchanged. */
for (const contract of SKILL_CONTRACTS.contracts.filter((entry: any) => Array.isArray(entry.skillFields))) {
  const allowed = new Set<string>([...SKILL_CONTRACTS.agentSkillsSpec.skillFields, ...contract.skillFields]);
  TRANSFORMS[`skill-frontmatter-${contract.harness}`] = (sourceRel: string, content: any) => (
    path.basename(sourceRel) === 'SKILL.md' ? Buffer.from(portableSkillFrontmatter(content.toString('utf8'), allowed, sourceRel)) : content);
}

/** Move every top-level frontmatter key outside `allowed` under `metadata:`. A moved value is
 * written as a JSON string (valid YAML), a plain scalar's continuation lines joined with a space; a
 * nested map or a block scalar (`|`, `>`) is not handled, so it throws rather than guess, and so does a
 * flow-style `metadata` (`{...}` on the key's line), which block entries cannot be appended to without a
 * YAML parser. `file` names the source in each error. */
function portableSkillFrontmatter(text: string, allowed: Set<string>, file = 'SKILL.md'): string {
  const match = text.match(/^---\n([\s\S]*?\n)---(?=\n|$)/);
  if (!match) return text;
  const entries: { key: string | null, prefix: number, lines: string[] }[] = [];
  for (const line of match[1].replace(/\n$/, '').split('\n')) {
    // A top-level key, bare or quoted (`"key":`, `'key':`); `prefix` is the length up to its colon.
    const found = line.match(/^(?:"((?:[^"\\]|\\.)+)"|'((?:[^']|'')+)'|([A-Za-z][A-Za-z0-9_-]*))[ \t]*:/);
    const key = found ? (found[1]?.replace(/\\(.)/g, '$1') ?? found[2]?.replace(/''/g, "'") ?? found[3]) : null;
    if (key || !entries.length) entries.push({ key, prefix: found ? found[0].length : 0, lines: [line] });
    else entries[entries.length - 1].lines.push(line);
  }
  const metadataEntry = entries.find((entry) => entry.key === 'metadata');
  if (metadataEntry && /^[ \t]*[^\s#]/.test(metadataEntry.lines[0].slice(metadataEntry.prefix))) {
    throw new Error(`${file}: flow-style metadata cannot take moved keys; write metadata as a block map`);
  }
  const moved = entries.filter((entry) => entry.key && entry.key !== 'metadata' && !allowed.has(entry.key));
  if (!moved.length) return text;
  const metadata = moved.map(({ key, prefix, lines }) => {
    const head = lines[0].slice(prefix).trim();
    if (!head || /^[|>][-+0-9]*$/.test(head)) throw new Error(`${file}: '${key}' has no scalar value to move under metadata`);
    const value = [head, ...lines.slice(1).map((part) => part.trim())].join(' ').trim();
    const scalar = /^"(?:[^"\\]|\\.)*"$/.test(value) ? JSON.parse(value) : value.replace(/^'(.*)'$/, '$1');
    return `  ${/^[A-Za-z][A-Za-z0-9_-]*$/.test(key as string) ? key : JSON.stringify(key)}: ${JSON.stringify(scalar)}`;
  });
  const kept = entries.filter((entry) => !moved.includes(entry));
  const existing = kept.find((entry) => entry.key === 'metadata');
  if (existing) existing.lines.push(...metadata);
  else kept.push({ key: 'metadata', prefix: 9, lines: ['metadata:', ...metadata] });
  return `---\n${kept.flatMap((entry) => entry.lines).join('\n')}\n${text.slice(match[0].length - 3)}`;
}

function resolveTransform(name: any): ((sourceRel: string, content: any) => any) | null {
  if (!name) return null;
  const transform = TRANSFORMS[name];
  if (!transform) throw new Error(`Unknown copy-tree transform '${name}' (known: ${Object.keys(TRANSFORMS).join(', ')})`);
  return transform;
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\n+/, '');
}

/** Wrap a shared mode document as a Claude output style: system-prompt modifiers keep the
 * built-in engineering instructions (these styles shape HOW DoFlow works, not WHETHER Claude
 * codes). The description is lifted from the document's first `**Purpose**` line so the /config
 * picker explains each style without opening it. */
function renderClaudeOutputStyle(sourceRel: string, content: any): string {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const base = path.basename(sourceRel).replace(/\.[^.]+$/, '').replace(/^MODE_/i, '').replace(/_/g, ' ');
  const purpose = text.match(/\*\*Purpose\*\*[:*]*\s*(.+)?/);
  const description = (purpose && purpose[1] ? purpose[1] : `DoFlow ${base} mode`).trim().replace(/\s+/g, ' ');
  return ['---', `name: DoFlow: ${base}`, `description: ${JSON.stringify(description)}`, 'keep-coding-instructions: true', '---', '', text.replace(/\n*$/, ''), ''].join('\n');
}

/** The `apply` keys a harness writes into the file of a `read-only` agent spec (118 IC-003), read from
 * `agentLimits.readOnly` in core/registry/harnesses.json. `null` when the harness's limit is
 * `unenforced`: nothing is written, and the registry says why. The one place adapters learn a limit. */
let harnessAgentLimits: any[] | null = null;
function readOnlyApply(harnessId: string): Record<string, any> | null {
  if (!harnessAgentLimits) {
    harnessAgentLimits = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses;
  }
  const harness = (harnessAgentLimits as any[]).find((item: any) => item.id === harnessId);
  if (!harness) throw new Error(`readOnlyApply: unknown harness '${harnessId}'`);
  const entry = harness.agentLimits?.readOnly;
  return entry?.status === 'native' ? entry.apply : null;
}

/** One frontmatter key as YAML lines: a scalar inline, an array as a flow sequence, an object as an
 * indented block. */
function yamlLines(key: string, value: any, indent: string = ''): string[] {
  if (Array.isArray(value)) return [`${indent}${key}: ${JSON.stringify(value)}`];
  if (value && typeof value === 'object') {
    return [`${indent}${key}:`, ...Object.entries(value).flatMap(([k, v]) => yamlLines(k, v, `${indent}  `))];
  }
  return [`${indent}${key}: ${value}`];
}

/** Rewrite a shared agent spec's frontmatter for one harness: `access` and `tool-scope` are never projected, and a
 * `read-only` spec gains the harness's `apply` keys (a `write` spec gains none). Body and every other
 * key pass through byte for byte; a file without frontmatter is returned unchanged. */
function applyAgentLimits(text: string, harnessId: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?\r?\n)---(?=\r?\n|$)/);
  if (!match) return text;
  const lines = match[1].split(/(?<=\n)/);
  const readOnly = lines.some((line: string) => /^access:\s*read-only\s*$/.test(line));
  const apply = readOnly ? readOnlyApply(harnessId) : null;
  const added = apply ? Object.entries(apply).flatMap(([key, value]) => yamlLines(key, value)).map((line: string) => `${line}\n`) : [];
  const kept = lines.filter((line: string) => !/^(access|tool-scope):/.test(line));
  return `${text.slice(0, text.indexOf('\n') + 1)}${kept.join('')}${added.join('')}${text.slice(match[0].length - 3)}`;
}

/** The command a Kiro hook runs for one front-door script: the project copy when the git root
 * holds one, else the user-scope copy under $HOME. One builder, so the static `doflow` agent
 * (core/harnesses/kiro/agents/doflow.json) and every generated specialist share the exact string. */
function kiroHookCommand(script: string): string {
  return `bash "$(root=$(git rev-parse --show-toplevel 2>/dev/null) && [ -f "$root/.kiro/hooks/${script}" ] && printf '%s/.kiro/hooks/${script}' "$root" || printf '%s/.kiro/hooks/${script}' "$HOME")"`;
}

/** One kiro-cli agent hook entry. */
function kiroHook({ name, trigger, matcher, script, timeout }: { name: string, trigger: string, matcher?: string, script: string, timeout: number }): any {
  return {
    name, trigger, ...(matcher ? { matcher } : {}),
    action: { type: 'command', command: kiroHookCommand(script) }, timeout,
  };
}

/** The three preToolUse hooks every DoFlow-rendered Kiro agent carries. The MCP guard uses the
 * "*" matcher: Kiro documents "@<server>" (every tool of one server) and "*" but no all-MCP
 * matcher, and mcp-tool-guard.sh exits 0 immediately for any non-MCP tool name, so "*" costs one
 * fast no-op for built-in tools and still covers every MCP server. */
function kiroPreToolUseHooks(): any[] {
  return [
    kiroHook({ name: 'doflow-pre-implementation-gate', trigger: 'preToolUse', matcher: 'write', script: 'pre-implement-gate.sh', timeout: 10 }),
    kiroHook({ name: 'doflow-pre-bash-guard', trigger: 'preToolUse', matcher: 'shell', script: 'pre-bash-guard.sh', timeout: 10 }),
    kiroHook({ name: 'doflow-mcp-tool-guard', trigger: 'preToolUse', matcher: '*', script: 'mcp-tool-guard.sh', timeout: 10 }),
  ];
}

/** Map one core/shared agent-spec file onto a kiro-cli custom agent. Spec keys other than
 * name/description (model: inherit, effort) are dropped: Kiro inherits the session model. `access` is
 * never projected; a `read-only` spec replaces `tools: ["*"]` with the harness's `apply.tools`. */
function renderKiroAgent(text: string, { hooks = true }: { hooks?: boolean } = {}): string {
  const fm: Record<string, string> = {};
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
  const limits = fm.access === 'read-only' ? readOnlyApply('kiro') : null;
  const agent = {
    name: fm.name || '', description: fm.description || '',
    prompt: `${body.replace(/\s+$/, '')}\n`,
    tools: limits?.tools ?? ['*'],
    ...(hooks ? { hooks: kiroPreToolUseHooks() } : {}),
  };
  return `${JSON.stringify(agent, null, 2)}\n`;
}

/** Map one core/shared agent-spec file onto OpenCode's documented markdown-agent frontmatter
 * (description / mode / permission; model omitted because OpenCode has no 'inherit'). Unknown
 * spec keys (tools, effort) are dropped rather than passed through, so OpenCode never sees
 * vocabulary it does not define. Body below the frontmatter passes through untouched. */
function renderOpencodeAgent(text: string): string {
  const fm: Record<string, string> = {};
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
  const limits = fm.access === 'read-only' ? readOnlyApply('opencode') : null;
  if (limits) lines.push(...Object.entries(limits).flatMap(([key, value]) => yamlLines(key, value)));
  lines.push('---', '', body.replace(/\n*$/, ''), '');
  return lines.join('\n');
}

/** List every source file with its would-be destination and content fingerprint. Does not touch
 * the destination tree beyond checking existence. `relPath` is destination-relative and doubles as
 * the ledger identity, so a layout change relocates the recorded resource too — planTree's
 * relocation handling then removes the old path rather than orphaning it. */
function discoverTree({ sourceDir, destDir, fsImpl = fs, layout, transform, select }: any): { files: any[] } {
  if (!fsImpl.existsSync(sourceDir)) throw new Error(`copy-tree source is missing: ${sourceDir}`);
  const mapRel = typeof layout === 'function' ? layout : resolveLayout(layout);
  const mapContent = typeof transform === 'function' ? transform : resolveTransform(transform);
  const selected = resolveSelect(select)?.(sourceDir, fsImpl);
  const files = walkRelFiles(sourceDir, fsImpl).filter((sourceRel) => {
    if (!selected) return true;
    return selected.has(sourceRel.split(path.sep).join('/'));
  }).map((sourceRel) => {
    const relPath = mapRel(sourceRel);
    const sourceAbs = path.join(sourceDir, sourceRel);
    const destAbs = path.join(destDir, relPath);
    const raw = fsImpl.readFileSync(sourceAbs);
    return { relPath, sourceAbs, destAbs, exists: fsImpl.existsSync(destAbs), fingerprint: sha256(mapContent ? mapContent(sourceRel, raw) : raw) };
  });
  return { files };
}

/** Selected files that map to one destination cannot both be installed safely. */
function selectedDestinationCollisions(files: any[], sourceDir: string, destDir: string): { destinations: Set<string>, conflicts: string[] } {
  const sourcesByDestination = new Map<string, any[]>();
  for (const file of files) {
    const key = path.resolve(file.destAbs);
    const sources = sourcesByDestination.get(key) || [];
    sources.push(file);
    sourcesByDestination.set(key, sources);
  }

  const destinations = new Set<string>();
  const conflicts: string[] = [];
  for (const [destination, sources] of sourcesByDestination) {
    if (sources.length < 2) continue;
    destinations.add(destination);
    const names = sources.map((file) => path.relative(sourceDir, file.sourceAbs).split(path.sep).join('/'));
    conflicts.push(`selected files ${names.map((name) => `'${name}'`).join(' and ')} map to the same destination '${path.relative(destDir, destination).split(path.sep).join('/')}'`);
  }
  return { destinations, conflicts };
}

/** A file's identity on disk (device + inode), or null when the path does not resolve to one. */
function fileId(file: string, fsImpl: any): string | null {
  try {
    const stat = fsImpl.statSync(file, { bigint: true });
    // An fs stand-in that reports no inode identifies nothing, rather than every file as one.
    if (stat?.dev === undefined || stat?.ino === undefined) return null;
    return `${stat.dev}:${stat.ino}`;
  } catch { return null; }
}

/**
 * A lookup answering "is `target` the same file on disk as one of `paths`, and which one?".
 * A case-insensitive filesystem (APFS, NTFS by default) resolves `Foo.js` and `foo.js` to one
 * file, so a string compare calls them two and a removal of the old spelling deletes the file just
 * written under the new one. Device + inode is the only answer that holds on every filesystem, and
 * a hard link answers the same way. Built on first use, one stat per path; a path that does not
 * exist matches nothing, and `target` never matches itself.
 */
function sameFileIndex(paths: string[], fsImpl: any = fs): (target: string) => string | null {
  let byId: Map<string, string> | undefined;
  return (target: string) => {
    if (byId === undefined) {
      byId = new Map();
      for (const candidate of paths) {
        const id = fileId(candidate, fsImpl);
        if (id !== null && !byId.has(id)) byId.set(id, candidate);
      }
    }
    const id = fileId(target, fsImpl);
    const match = id === null ? undefined : byId.get(id);
    return match !== undefined && match !== target ? match : null;
  };
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
function planTree({ sourceDir, destDir, previousResources = [], operation = 'apply', fsImpl = fs, layout, transform, select, force = false, keepModified = false, siblingFingerprints = new Map() }: any): any {
  const prevByPath = new Map<string, any>(previousResources.map((resource: any) => [resource.relPath, resource]));
  const changes: any[] = [];
  const conflicts: string[] = [];
  const kept: any[] = [];
  const siblingReplaced = new Set<string>();

  // Fingerprints the CURRENT source would write, keyed by destination. Resolved lazily and only
  // when a recorded fingerprint has already failed to match, so the common removal path still
  // never reads the source tree. A missing source directory is not an error here — an asset can be
  // removed after its source moved — it simply leaves the recorded fingerprint as the only signal.
  let sourceByDest: Map<string, string> | undefined;
  const sourceFingerprint = (destAbs: string): string | undefined => {
    if (sourceByDest === undefined) {
      sourceByDest = sourceDir && fsImpl.existsSync(sourceDir)
        ? new Map<string, string>(discoverTree({ sourceDir, destDir, fsImpl, layout, transform, select }).files.map((file): [string, string] => [file.destAbs, file.fingerprint]))
        : new Map();
    }
    return sourceByDest.get(destAbs);
  };

  // Every destination the current source produces, set once the apply path has discovered them.
  let producedSameFile: ((target: string) => string | null) | undefined;

  const proposeRemoval = (prev: any, { relocated = false }: { relocated?: boolean } = {}) => {
    // prev's OWN recorded location, not the current destDir — an asset whose nativeDir changed
    // since prev was recorded must be removed from where it actually is, not from where it would
    // land today. Absent (pre-this-fix data, or a caller-constructed previousResources entry with
    // no target) falls back to the old destDir-relative computation, unchanged.
    const destAbs = prev.target ?? path.join(destDir, prev.relPath);
    if (!fsImpl.existsSync(destAbs)) return;
    const current = sha256(fsImpl.readFileSync(destAbs));
    // A recorded path that is the same file as one the source produces (a case-only rename on a
    // case-insensitive filesystem) is that produced file under its old spelling: deleting it
    // deletes what this run writes. Only the old row is released; the file stays, and the
    // produced path's row is recorded when the run verifies.
    if (relocated && producedSameFile?.(destAbs)) {
      changes.push({ relPath: prev.relPath, target: destAbs, operation: 'remove', fingerprint: current, kept: true });
      return;
    }
    // Untampered on removal means the same two signals the apply path below already accepts: the
    // bytes this harness last recorded, or the bytes the current source would write. The second
    // one matters because a destination tree can be claimed by several harnesses (scripts.doflow
    // is one `<project>/.doflow/scripts` for claude, codex and others), so a sibling's update
    // legitimately rewrites files this harness's rows still describe — the same "a sibling
    // changed bytes my row still describes" case the apply path had to be taught, arriving here
    // as an un-releasable claim instead of a refused install. A hand edit matches neither and is
    // still refused. The OBSERVED fingerprint travels with the change so removeTree's own
    // pre-delete re-check agrees with the decision taken here rather than throwing mid-apply.
    // A third signal, the bytes a sibling harness recorded at this target: in a shared tree the
    // sibling may have written the file last, and calling that a hand edit would keep it under a
    // false label while the lifecycle's runtime prune deletes it on the same proof.
    const modified = current !== prev.fingerprint && current !== sourceFingerprint(destAbs) && !siblingFingerprints.get(destAbs)?.has(current);
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

  const { files } = discoverTree({ sourceDir, destDir, fsImpl, layout, transform, select });
  const collisions = select == null
    ? { destinations: new Set<string>(), conflicts: [] }
    : selectedDestinationCollisions(files, sourceDir, destDir);
  conflicts.push(...collisions.conflicts);
  producedSameFile = sameFileIndex(files.map((file) => file.destAbs), fsImpl);
  const satisfiedAtSameLocation = new Set();
  for (const file of files) {
    if (collisions.destinations.has(path.resolve(file.destAbs))) {
      satisfiedAtSameLocation.add(file.relPath);
      continue;
    }
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
 * general convention for a lifecycle-owned write (see src/adapters/claude/index.ts's
 * applySettingsAsset for the same pattern applied to a transformed-content file). */
function applyTree({ changes = [], fsImpl = fs, transform }: any): { applied: number } {
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

/** Why a removal the runtime prune planned may no longer run, or null when it still may: the
 * prune's plan-time proof (src/lifecycle/index.ts pruneRetiredRuntimeFiles) re-run right before the
 * unlink, so a directory swapped for a symlink, or a file linked to a shipped one, after the plan was
 * made is not deleted through. `guard` is `{ root, source, scope }`: the tree, the source it projects
 * and the scope root the tree must resolve inside (a tree linked out of its scope is refused).
 * One walk of the source and one stat per shipped path per tree per call, cached in `cache`. */
function pruneGuardRefusal(change: any, cache: Map<string, any>, fsImpl: any): string | null {
  const { root, source, scope } = change.pruneGuard;
  const key = `${root}\0${source}\0${scope ?? ''}`;
  if (!cache.has(key)) {
    const produced = fsImpl.existsSync(source) ? discoverTree({ sourceDir: source, destDir: root, fsImpl }).files.map((file: any) => file.destAbs) : [];
    cache.set(key, { realRoot: fsImpl.realpathSync(root), realScope: scope ? fsImpl.realpathSync(scope) : null, sameFile: sameFileIndex(produced, fsImpl) });
  }
  const { realRoot, realScope, sameFile } = cache.get(key);
  if (realScope && !realRoot.startsWith(`${realScope}${path.sep}`)) return `${root} resolves outside the scope root ${scope}`;
  if (!fsImpl.realpathSync(change.target).startsWith(`${realRoot}${path.sep}`)) return `it resolves outside ${root}`;
  const shipped = sameFile(change.target);
  return shipped ? `it is the same file as ${shipped}, which this version ships` : null;
}

/** Delete every remove change, re-checking each file's fingerprint immediately before deletion —
 * refuses (throws) rather than silently deleting a file modified since planTree ran. A removal the
 * runtime prune planned (`pruneGuard`) also re-checks its containment and same-file proof there. */
function removeTree({ changes = [], fsImpl = fs }: any): { removed: number } {
  let removed = 0;
  const guards = new Map<string, any>();
  for (const change of changes) {
    if (change.operation !== 'remove' || change.kept) continue;
    if (!fsImpl.existsSync(change.target)) continue;
    const refusal = change.pruneGuard ? pruneGuardRefusal(change, guards, fsImpl) : null;
    if (refusal) throw new Error(`Refusing to remove copy-tree resource ${change.relPath ?? change.target}: ${refusal}`);
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
function pruneEmptyAncestors(startDir: string, { fsImpl = fs }: { fsImpl?: any } = {}): void {
  let current = startDir;
  for (;;) {
    const basename = path.basename(current);
    if (!basename || basename === '.' || basename === path.sep || ANCHOR_DIRS.has(basename)) return;
    try { fsImpl.rmdirSync(current); } catch { return; }
    current = path.dirname(current);
  }
}

/** Re-derive ownership resources from what's actually on disk right now, for status/verify.
 * `plannedWrites` lists the destinations the run being verified wrote. An absent source file is
 * not reported in general, because a user may delete one, but an absent file this run wrote means
 * the run lost it (a case-only rename once deleted the file it had just written) and is a conflict. */
function verifyTree({ sourceDir, destDir, fsImpl = fs, layout, transform, select, plannedWrites = [] }: any): { ok: boolean, resources: any[], conflicts: string[] } {
  const { files } = discoverTree({ sourceDir, destDir, fsImpl, layout, transform, select });
  const written = new Set(plannedWrites);
  const resources: any[] = [];
  const conflicts: string[] = [];
  const collisions = select == null
    ? { destinations: new Set<string>(), conflicts: [] }
    : selectedDestinationCollisions(files, sourceDir, destDir);
  conflicts.push(...collisions.conflicts);
  for (const file of files) {
    if (collisions.destinations.has(path.resolve(file.destAbs))) continue;
    if (!file.exists) {
      if (written.has(file.destAbs)) conflicts.push(`${file.relPath} was written by this run but is missing`);
      continue;
    }
    const current = sha256(fsImpl.readFileSync(file.destAbs));
    if (current !== file.fingerprint) { conflicts.push(`${file.relPath} does not match source`); continue; }
    resources.push({ relPath: file.relPath, target: file.destAbs, fingerprint: file.fingerprint });
  }
  return { ok: conflicts.length === 0, resources, conflicts };
}

// ---- per-adapter copy-tree glue, shared so each adapter doesn't carry its own copy ----

/** Filter a harness's asset list down to the ones this engine handles. */
function copyTreeAssets(assets: any): any[] {
  return (assets || []).filter((asset: any) => asset?.renderer === 'copy-tree');
}

/** Recursively sort object keys before serializing, so two logically-equal objects with
 * differently-ordered keys (e.g. after a settings file is merged and re-merged) fingerprint
 * identically instead of spuriously registering as changed. */
function stableSort(value: any): any {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
}

/** Content fingerprint every adapter uses to track what it owns: sha256 of a string as-is, or of
 * a stably key-sorted JSON serialization of anything else. */
function fingerprint(value: any): string {
  return sha256(typeof value === 'string' ? value : JSON.stringify(stableSort(value)));
}

/** Read and parse a native JSON file an adapter merges into. Distinguishes "absent" (safe to
 * create) from "present but unparseable" (a conflict to report, never silently overwritten) —
 * every adapter that merges into a native JSON settings/config file needs exactly this. */
function readJson(file: string, { fsImpl = fs }: { fsImpl?: any } = {}): { exists: boolean, value: any, error: string | null } {
  if (!fsImpl.existsSync(file)) return { exists: false, value: {}, error: null };
  try { return { exists: true, value: JSON.parse(fsImpl.readFileSync(file, 'utf8')), error: null }; }
  catch (error: any) { return { exists: true, value: null, error: `Invalid JSON in ${file}: ${error.message}` }; }
}

/** Resolve an asset's source directory against the repo root, refusing a path that escapes the
 * repository or does not exist. `harnessName` only shapes the thrown error message. */
function sourceDirFor(asset: any, context: any = {}, fsImpl: any = fs, harnessName: string = 'Adapter'): string {
  if (!asset || typeof asset.source !== 'string') throw new Error(`${harnessName} asset requires a source path`);
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : process.cwd();
  const source = path.resolve(repoRoot, asset.source);
  if (!source.startsWith(`${repoRoot}${path.sep}`) || !fsImpl.existsSync(source)) {
    throw new Error(`${harnessName} asset source is unavailable: ${asset.source}`);
  }
  return source;
}

/** Resolve an asset's native destination directory under the harness's already-resolved config dir. */
function copyTreeDestDir(configDir: string, asset: any): string {
  return path.join(configDir, asset.nativeDir || '');
}

/** Destination of a `../.doflow` shared-tree asset at the scope root (`<project>/.doflow`, or
 * `$HOME/.doflow` globally), for harnesses whose tree root sits more than one level under the scope
 * root. Returns null for any other nativeDir, so the caller falls back to `copyTreeDestDir`. */
function sharedTreeDestDir(rootDir: string, nativeDir: any): string | null {
  if (nativeDir !== '../.doflow' && !String(nativeDir || '').startsWith('../.doflow/')) return null;
  const sharedRoot = path.join(rootDir, '.doflow');
  const dest = path.join(rootDir, '.doflow', nativeDir.slice('../.doflow'.length));
  if (dest !== sharedRoot && !dest.startsWith(`${sharedRoot}${path.sep}`)) {
    throw new Error(`shared-tree nativeDir escapes .doflow: ${nativeDir}`);
  }
  return dest;
}

/** The assets that project a tree several harnesses claim at one scope root: the runtime, guidance,
 * and shared hooks trees. A harness whose
 * install predates its own rows for a shared tree (Pi gained guidance rows in v1.15.0) can only
 * recognise the bytes a sibling recorded. */
const SHARED_TREE_ASSETS = new Set([
  'scripts.doflow', 'runtime.cli', 'runtime.lib', 'runtime.registry',
  'guidance.context-layer', 'kiro.guidance-tree', 'hooks.shared',
]);

/** For each shared-tree target, the fingerprints other harnesses recorded and which harness
 * recorded each, so an update accepts a runtime, guidance, or shared hooks tree a sibling wrote (several harnesses
 * claim one `.doflow` file) while bytes no such row recorded are still refused as a hand edit. */
function ledgerSiblingFingerprints(resources: any, harness: string): Map<string, Map<string, string>> {
  const byTarget = new Map<string, Map<string, string>>();
  for (const resource of resources || []) {
    if (resource.kind !== 'copy-tree-file' || resource.harness === harness || !SHARED_TREE_ASSETS.has(resource.assetId)) continue;
    if (typeof resource.target !== 'string' || typeof resource.fingerprint !== 'string') continue;
    if (!byTarget.has(resource.target)) byTarget.set(resource.target, new Map());
    const byFingerprint = byTarget.get(resource.target)!;
    if (!byFingerprint.has(resource.fingerprint)) byFingerprint.set(resource.fingerprint, resource.harness);
  }
  return byTarget;
}

/** The one-line plan notice for a plan whose copy-tree results replaced sibling-written files, or
 * an empty list when none did. */
function siblingReplacedNotices(results: any[]): string[] {
  const harnesses = [...new Set(results.flatMap((result) => result.siblingReplaced))].sort();
  if (!harnesses.length) return [];
  return [`replaced shared files written by ${harnesses.join(', ')}; reinstall ${harnesses.length > 1 ? 'those harnesses' : 'that harness'} to restore them`];
}

/** Narrow a harness's flat neutral-resource list to one asset's previously-owned copy-tree files. */
function ledgerFileResources(resources: any, harness: string, assetId: string): any[] {
  return (resources || [])
    .filter((resource: any) => resource.harness === harness && resource.assetId === assetId && resource.kind === 'copy-tree-file')
    .map((resource: any) => ({ relPath: resource.identity, fingerprint: resource.fingerprint, target: resource.target }));
}

module.exports = { readOnlyApply, kiroHook, kiroHookCommand, kiroPreToolUseHooks, walkRelFiles, discoverTree, sameFileIndex, planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, sharedTreeDestDir, ledgerFileResources, ledgerSiblingFingerprints, siblingReplacedNotices, resolveLayout, LAYOUTS, resolveSelect, SELECTORS, resolveTransform, TRANSFORMS, portableSkillFrontmatter, fingerprint, pruneEmptyAncestors, readJson, sourceDirFor };

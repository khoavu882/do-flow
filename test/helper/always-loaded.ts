'use strict';

// The always-loaded measurement helper (074 C15, IC-019), extracted unchanged from
// test/guards/context-budget.test.js so the perf runner can report the same startup byte total
// the G13 guard enforces.
const fs = require('node:fs');
const path = require('node:path');
const { REPO, GUIDANCE } = require('../guards/_shared.ts');
const { GENERATED_EXCLUSIONS, guidanceManifest } = require('../../src/adapters/guidance-manifest.ts');
const { resolveTransform, resolveSelect } = require('../../src/adapters/copy-tree.ts');
const { renderGuidancePointer } = require('../../src/adapters/guidance-pointer.ts');
const { renderMcpIndex } = require('../../src/lifecycle/mcp-index.ts');

/** Newline-separated lines, without the empty line a trailing newline would add. */
function lineCount(text: any) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** `@relative/path.md` at the start of a line — the import syntax DOFLOW_CORE.md actually uses. */
function importsIn(text: any) {
  return [...text.matchAll(/^@(\S+)$/gm)].map(([, target]) => target);
}

/**
 * The always-loaded set, walked transitively from DOFLOW_CORE.md rather than hardcoded.
 *
 * A hardcoded file list is the failure mode this ceiling exists to prevent: it silently stops
 * covering a file the moment someone adds one to the set, which is exactly when the budget most
 * needs to bind. Returns { files, dangling, excluded } — relative to the guidance root.
 */
function alwaysLoaded() {
  const manifest = guidanceManifest(GUIDANCE, fs);
  const files = manifest.files.map((rel: any) => {
    const full = path.join(GUIDANCE, rel);
    const text = fs.readFileSync(full, 'utf8');
    return { rel, lines: lineCount(text), bytes: Buffer.byteLength(text, 'utf8') };
  });
  return { files, dangling: manifest.dangling, excluded: manifest.generated };
}

/** Every `*.md` under `dir` (repo-relative), depth first. */
function markdownUnder(dir: any) {
  return fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry: any) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(rel);
    return entry.name.endsWith('.md') ? [rel] : [];
  });
}

/** Lines and bytes of every `*.md` under a directory, or of one file, after an optional transform. */
function measureSource(sourceRel: any, transform: any) {
  const full = path.join(REPO, sourceRel);
  const names = fs.statSync(full).isDirectory() ? markdownUnder(sourceRel) : [sourceRel];
  return names.reduce((total: any, rel: any) => {
    let bytes = fs.readFileSync(path.join(REPO, rel));
    if (transform) bytes = transform(rel, bytes);
    return { lines: total.lines + lineCount(bytes.toString('utf8')), bytes: total.bytes + bytes.length };
  }, { lines: 0, bytes: 0 });
}

/** Lines, bytes and per-file bytes of every `*.md` under a directory, or of one file, after an optional transform. */
function measureFiles(sourceRel: any, transform?: any) {
  const full = path.join(REPO, sourceRel);
  const names = fs.statSync(full).isDirectory() ? markdownUnder(sourceRel) : [sourceRel];
  return names.map((rel: any) => {
    let bytes = fs.readFileSync(path.join(REPO, rel));
    if (transform) bytes = transform(rel, bytes);
    return { path: rel.split(path.sep).join('/'), lines: lineCount(bytes.toString('utf8')), bytes: bytes.length };
  });
}

/** The generated MCP_INDEX.md at its largest: rendered for every server mcp.json declares, with each
 * server doc it imports. Its real size depends on the install's selection; this is the ceiling. */
function mcpIndexWorstBytes() {
  const servers = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'mcp.json'), 'utf8')).servers;
  const index = renderMcpIndex(servers) ?? '';
  return Buffer.byteLength(index, 'utf8')
    + importsIn(index).reduce((n: any, rel: any) => n + fs.statSync(path.join(GUIDANCE, rel)).size, 0);
}

/** Bytes of a guidance-root file after expanding its @-imports transitively (each file counted once,
 * anchored at the guidance root as DOFLOW_CORE.md's imports are); MCP_INDEX.md at its largest. */
function bytesAfterIncludes(rel: any) {
  const seen = new Set();
  let total = 0;
  const queue = [rel];
  while (queue.length) {
    const next = path.posix.normalize(queue.shift());
    if (seen.has(next)) continue;
    seen.add(next);
    if (GENERATED_EXCLUSIONS.has(next)) { total += mcpIndexWorstBytes(); continue; }
    const full = path.join(GUIDANCE, next);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    total += Buffer.byteLength(text, 'utf8');
    queue.push(...importsIn(text));
  }
  return total;
}

/**
 * What each harness loads before the user types, classified from the registry rather than named per
 * harness (IC-006). A harness's projections and `WHOLESALE_ASSETS` decide which components it pays for:
 *   - `guidance.core`: the pointer plus the @import walk;
 *   - a copy-tree-family projection that declares `select`: the core set after that projection's
 *     transform, listed through the registered selector the projection names (`resolveSelect`, the code
 *     the adapters run), or `selectFiles`, the injection point of the controls;
 *   - a wholesale projection with no `select`: the whole source tree;
 *   - `guidance.codex-pointer`: the pointer, plus the walk when the harness has no selected projection
 *     (the pointer tells the agent to read DOFLOW_CORE.md, so the walk is paid on instruction).
 * A harness no condition matches is refused, so a ninth harness cannot be reported as costing nothing.
 *
 * Each row also lists its `files`: every always-on file with its own `bytes` and its `afterIncludes`
 * bytes (the file plus everything it @-imports, MCP_INDEX.md at its largest; a pointer that imports
 * DOFLOW_CORE.md carries the whole walk). G13 reads the totals; G74 holds `afterIncludes` to the
 * per-file caps and the totals to the chain caps of core/registry/guidance-caps.json. Moved here
 * from context-budget.test.ts so both guards classify a harness the same way.
 */
/** The pointer as a harness installs it at project scope (`{{GUIDANCE}}` filled in), not the token template (107-B C-7). */
const renderedPointer = (rel: any, bytes: any) => Buffer.from(renderGuidancePointer(bytes.toString('utf8'), { scope: 'project', scopeRoot: REPO }));

function alwaysLoadedByHarness({ harnesses, assets }: any, wholesale: any, selectFiles: any = (dir: any, selectName: any) => resolveSelect(selectName)(dir, fs)) {
  const walk = alwaysLoaded().files;
  const walkFiles = walk.map((file: any) => ({ path: `core/shared/guidance/${file.rel}`, lines: file.lines, bytes: file.bytes, afterIncludes: bytesAfterIncludes(file.rel) }));
  const projection = (harness: any, assetId: any) => assets.find((asset: any) => asset.id === assetId)?.projection?.[harness];
  const sourceOf = (assetId: any) => assets.find((asset: any) => asset.id === assetId).source;
  const guidanceRel = (rel: any) => path.relative(GUIDANCE, path.join(REPO, rel)).split(path.sep).join('/');
  const ownImports = (rel: any) => (rel.startsWith('..') ? 0 : bytesAfterIncludes(rel) - fs.statSync(path.join(GUIDANCE, rel)).size);
  const measureSelected = (assetId: any, projected: any) => {
    const source = sourceOf(assetId);
    const transform = resolveTransform(projected.transform);
    return [...selectFiles(path.join(REPO, source), projected.select)].map((rel: any) => {
      let bytes = fs.readFileSync(path.join(REPO, source, rel));
      if (transform) bytes = transform(path.join(source, rel), bytes);
      const sourcePath = path.join(source, rel).split(path.sep).join('/');
      return { path: sourcePath, lines: lineCount(bytes.toString('utf8')), bytes: bytes.length, afterIncludes: bytes.length + ownImports(guidanceRel(sourcePath)) };
    });
  };
  const whole = (files: any) => files.map((file: any) => ({ ...file, afterIncludes: file.bytes + ownImports(guidanceRel(file.path)) }));
  return harnesses.map(({ id }: any): any => {
    const parts: any = [];
    const add = (basis: any, files: any) => parts.push({ basis, files });
    const selectedAssets = assets.filter((asset: any) => asset.projection?.[id]?.select);
    const selected = selectedAssets.length > 0;
    if (projection(id, 'guidance.core')) {
      // This pointer @-imports DOFLOW_CORE.md, so after includes it is the whole walk.
      add('pointer', measureFiles(sourceOf('guidance.core')).map((file: any) => ({ ...file, afterIncludes: file.bytes + bytesAfterIncludes('DOFLOW_CORE.md') })));
      add('+ @import walk', walkFiles);
    }
    if (projection(id, 'guidance.codex-pointer')) {
      add('pointer', measureFiles(sourceOf('guidance.codex-pointer'), renderedPointer).map((file: any) => ({ ...file, afterIncludes: file.bytes })));
      if (!selected) add('+ DOFLOW_CORE.md read on instruction', walkFiles);
    }
    for (const asset of selectedAssets) {
      const projected = asset.projection[id];
      add(`+ core set via ${asset.id} select ${projected.select}${projected.transform ? ` (${projected.transform})` : ''}`,
        measureSelected(asset.id, projected));
    }
    for (const assetId of wholesale[id] ?? []) {
      if (projection(id, assetId)?.select) continue;
      add(`+ whole ${assetId} tree as steering`, whole(measureFiles(sourceOf(assetId))));
    }
    if (!parts.length) throw new Error(`no always-loaded rule for harness ${id}; classify it in alwaysLoadedByHarness`);
    const files = parts.flatMap((part: any) => part.files);
    return {
      harness: id,
      basis: parts.map((part: any) => part.basis).join(' '),
      lines: files.reduce((n: any, file: any) => n + file.lines, 0),
      bytes: files.reduce((n: any, file: any) => n + file.bytes, 0),
      files,
    };
  });
}

const readRegistry = () => ({
  harnesses: JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses,
  assets: JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'assets.json'), 'utf8')).assets,
});

module.exports = {
  GENERATED_EXCLUSIONS, alwaysLoaded, measureSource, lineCount, importsIn, markdownUnder,
  alwaysLoadedByHarness, readRegistry, bytesAfterIncludes, mcpIndexWorstBytes,
};

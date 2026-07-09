'use strict';
// copy.js — install copy engine + dry-run planner.
// PARITY: sync.sh copies dir mappings with `rsync -a src/ dst/` (recursive, no excludes)
// and file mappings with `cp -p`. fs.cpSync({recursive,force}) matches the dir-merge.
const fs = require('node:fs');
const path = require('node:path');

/** Recursively list regular files under dir (absolute paths). */
function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Planned destination file paths (tool-prefixed, posix) for one tool's mappings. */
function planFiles(repoRoot, mappings, tool) {
  const files = [];
  for (const { src, dst } of mappings) {
    const srcAbs = path.join(repoRoot, src);
    if (!fs.existsSync(srcAbs)) continue;
    const st = fs.statSync(srcAbs);
    const dstClean = dst.replace(/\/+$/, '');
    if (st.isDirectory()) {
      for (const f of walkFiles(srcAbs)) {
        const rel = path.relative(srcAbs, f).split(path.sep).join('/');
        files.push([tool, dstClean, rel].filter(Boolean).join('/'));
      }
    } else if (st.isFile()) {
      const destRel = dst.endsWith('/') ? `${dstClean}/${path.basename(srcAbs)}` : dst;
      files.push(`${tool}/${destRel}`);
    }
  }
  return files;
}

/**
 * Security guard: reject any mapping whose destination resolves outside dstRoot (path traversal
 * via a `..`-laden `dst` in mappings.conf, or a symlink-y join). Never delete/write outside the
 * resolved tool dir, in either global or project scope.
 */
function assertWithinRoot(dstRoot, dstAbs, dst) {
  const rootResolved = path.resolve(dstRoot) + path.sep;
  const dstResolved = path.resolve(dstAbs);
  if (dstResolved !== path.resolve(dstRoot) && !(dstResolved + path.sep).startsWith(rootResolved)) {
    throw new Error(`Refusing to write outside install root: '${dst}' resolves to ${dstResolved}, not under ${dstRoot}`);
  }
}

/** Every {srcAbs, dstAbs} file pair a tool's mappings resolve to (dirs expanded). Used by diff.js
 * (the `update` command) — must apply the same traversal guard `installTool` does, since it writes
 * to the same dstAbs paths via copyFilePreservingMeta. */
function resolveFilePairs(repoRoot, mappings, dstRoot) {
  const pairs = [];
  for (const { src, dst } of mappings) {
    const srcAbs = path.join(repoRoot, src);
    if (!fs.existsSync(srcAbs)) continue;
    const st = fs.statSync(srcAbs);
    const dstClean = dst.replace(/\/+$/, '');
    if (st.isDirectory()) {
      for (const f of walkFiles(srcAbs)) {
        const rel = path.relative(srcAbs, f);
        const dstAbs = path.join(dstRoot, dstClean, rel);
        assertWithinRoot(dstRoot, dstAbs, dst);
        pairs.push({ srcAbs: f, dstAbs });
      }
    } else if (st.isFile()) {
      const destRel = dst.endsWith('/') ? `${dstClean}/${path.basename(srcAbs)}` : dst;
      const dstAbs = path.join(dstRoot, destRel);
      assertWithinRoot(dstRoot, dstAbs, dst);
      pairs.push({ srcAbs, dstAbs });
    }
  }
  return pairs;
}

/** Copy one file, then stamp dst's mtime/mode from src — matches `cp -p` / `rsync -a`, both of
 * which preserve mtimes by default. Without this, diff.js's mtime comparison (used by `update`)
 * would see every just-installed file as "changed" on the very next run.
 *
 * mtime is floored to whole seconds (matching diff.js's own whole-second comparison, which in
 * turn matches sync.sh's `stat --format=%Y`) rather than passed through as a `Date`: `st.mtime`
 * rounds mtimeMs to the nearest millisecond, and a source file whose true sub-second fraction is
 * e.g. .9997s rounds up into the next whole second — so dst would silently drift one second ahead
 * of src, and diff.js would see it as "changed" forever after. Passing whole-second numbers to
 * utimesSync (interpreted as Unix seconds) sidesteps the rounding entirely. */
function copyFilePreservingMeta(srcAbs, dstAbs) {
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.copyFileSync(srcAbs, dstAbs);
  const st = fs.statSync(srcAbs);
  fs.utimesSync(dstAbs, Math.floor(st.atimeMs / 1000), Math.floor(st.mtimeMs / 1000));
  fs.chmodSync(dstAbs, st.mode);
}

/** Perform the install copy for one tool (real writes). Returns mappings synced. */
function installTool(repoRoot, mappings, dstRoot) {
  let n = 0;
  for (const { src, dst } of mappings) {
    const srcAbs = path.join(repoRoot, src);
    if (!fs.existsSync(srcAbs)) continue;
    const st = fs.statSync(srcAbs);
    const dstAbs = path.join(dstRoot, dst);
    assertWithinRoot(dstRoot, dstAbs, dst);
    if (st.isDirectory()) {
      fs.mkdirSync(dstAbs, { recursive: true });
      fs.cpSync(srcAbs, dstAbs, { recursive: true, force: true }); // == rsync -a src/ dst/ (content + tree)
      for (const f of walkFiles(srcAbs)) {
        const rel = path.relative(srcAbs, f);
        const copiedDst = path.join(dstAbs, rel);
        const fst = fs.statSync(f);
        // Floored to whole seconds — see copyFilePreservingMeta's comment for why passing
        // fst.mtime (a Date) directly can round a .999x-second mtime into the next second.
        fs.utimesSync(copiedDst, Math.floor(fst.atimeMs / 1000), Math.floor(fst.mtimeMs / 1000)); // fs.cpSync doesn't preserve mtimes itself
      }
      n++;
    } else if (st.isFile()) {
      copyFilePreservingMeta(srcAbs, dstAbs);
      n++;
    }
  }
  return n;
}

module.exports = { walkFiles, planFiles, installTool, assertWithinRoot, resolveFilePairs, copyFilePreservingMeta };

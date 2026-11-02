'use strict';
// 136 B.1, IC-002/003/004/007: the intake engine and its journaled manifest. Every folder is built in a temporary
// directory outside any git repository (NFR-001); nothing is copied from a real user tree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { tempDir } = require('../helper/tmp.ts');
const { loadTaxonomy } = require('../../src/runtime/intake/taxonomy.ts');
const { previewSort, sortFolder, undoRun, listFolder, filePrompt } = require('../../src/runtime/intake/engine.ts');
const { readManifest, manifestFile, IntakeUsageError } = require('../../src/runtime/intake/manifest.ts');

const REPO = path.resolve(__dirname, '../..');
const taxonomy = (): any => loadTaxonomy({ repoRoot: REPO, contributions: false }).taxonomy;
const sha = (data: any): string => `sha256:${nodeCrypto.createHash('sha256').update(data).digest('hex')}`;
/** The clock every test sorts at: a day after the files were written, so none is "recent" unless a test says so. */
const LATER = (): Date => new Date(Date.now() + 86_400_000);

/** A context folder holding `files` (relative path -> text or bytes), every mtime a day old. */
function tree(t: any, files: Record<string, any>, now: Date = LATER()): { dir: string; ctx: string } {
  const dir = tempDir(t, 'doflow-intake-');
  const ctx = path.join(dir, 'feature', 'additional-context');
  fs.mkdirSync(ctx, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(ctx, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const old = new Date(now.getTime() - 2 * 86_400_000);
    fs.utimesSync(file, old, old);
  }
  return { dir, ctx };
}

/** Every file under `ctx` (relative path -> sha256), excluding the `.intake` folder; folders listed with a slash. */
function snapshot(ctx: string): Record<string, string> {
  const out: Record<string, string> = {};
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(ctx, full).split(path.sep).join('/');
      if (rel === '.intake') continue;
      if (e.isDirectory()) { out[`${rel}/`] = 'dir'; walk(full); } else if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else out[rel] = sha(fs.readFileSync(full));
    }
  }(ctx));
  return out;
}

const sort = (ctx: string, extra: any = {}): any => sortFolder({ contextDir: ctx, taxonomy: taxonomy(), now: LATER(), ...extra });
const undo = (ctx: string, extra: any = {}): any => undoRun({ contextDir: ctx, now: LATER(), ...extra });
const manifestOf = (ctx: string): any => JSON.parse(fs.readFileSync(manifestFile(ctx), 'utf8'));
const movesOf = (result: any): any[] => result.moves.map((m: any) => `${m.from}>${m.to}`);

// ── sort ───────────────────────────────────────────────────────────────────────────────────────

test('loose files land in their category folders and the manifest holds one done entry per move (FR-001, FR-004)', (t: any) => {
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01]);
  const { ctx } = tree(t, {
    'qr-voucher-prd.md': '# PRD\n', 'flow.mmd': 'graph TD\n', 'flow.png': Buffer.from([1, 2, 3]),
    'talk.mp3': audio, 'notes.vtt': 'WEBVTT\n', 'spec.pdf': Buffer.from('%PDF'), 'IMG_2026.jpg': Buffer.from([9]),
  });
  const result = sort(ctx);
  assert.equal(result.action, 'sort');
  assert.equal(result.state, 'sorted');
  assert.deepEqual(movesOf(result), [
    'flow.mmd>hld/diagrams/flow.mmd', 'flow.png>hld/diagrams/flow.png', 'notes.vtt>discuss-session/transcripts/notes.vtt',
    'qr-voucher-prd.md>raw-prd/qr-voucher-prd.md', 'spec.pdf>references/spec.pdf', 'talk.mp3>discuss-session/records/talk.mp3',
  ]);
  assert.deepEqual(result.unmatched, ['IMG_2026.jpg']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.createdDirs, ['hld', 'hld/diagrams', 'discuss-session', 'discuss-session/transcripts', 'raw-prd', 'references', 'discuss-session/records']);
  assert.ok(fs.readFileSync(path.join(ctx, 'discuss-session', 'records', 'talk.mp3')).equals(audio));
  assert.ok(!fs.existsSync(path.join(ctx, 'talk.mp3')));
  assert.ok(fs.existsSync(path.join(ctx, 'IMG_2026.jpg')), 'an unmatched file stays at the root');

  const manifest = manifestOf(ctx);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.runs.length, 1);
  const run = manifest.runs[0];
  assert.equal(run.id, result.runId);
  assert.match(run.id, /^run-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  assert.equal(run.action, 'sort');
  assert.ok(run.finishedAt);
  assert.equal(run.moves.length, 6);
  for (const move of run.moves) {
    assert.equal(move.state, 'done');
    assert.equal(move.sha256, sha(fs.readFileSync(path.join(ctx, move.to))));
    assert.equal(move.bytes, fs.statSync(path.join(ctx, move.to)).size);
  }
});

test('a diagram render follows its same-stem source, a lone render stays (companionOf)', (t: any) => {
  const { ctx } = tree(t, { 'a.mmd': 'x', 'a.svg': '<svg/>', 'b.png': Buffer.from([1]), 'c.puml': 'y', 'c.JPG': Buffer.from([2]) });
  const result = sort(ctx);
  assert.deepEqual(movesOf(result), ['a.mmd>hld/diagrams/a.mmd', 'a.svg>hld/diagrams/a.svg', 'c.JPG>hld/diagrams/c.JPG', 'c.puml>hld/diagrams/c.puml']);
  assert.deepEqual(result.unmatched, ['b.png']);
});

test('a render whose source is skipped as recent is not claimed', (t: any) => {
  const now = LATER();
  const { ctx } = tree(t, { 'a.mmd': 'x', 'a.png': Buffer.from([1]) }, now);
  const recent = new Date(now.getTime() - 5000);
  fs.utimesSync(path.join(ctx, 'a.mmd'), recent, recent);
  const result = sort(ctx, { now });
  assert.deepEqual(result.moves, []);
  assert.deepEqual(result.skipped, [{ path: 'a.mmd', reason: 'recent' }]);
  assert.deepEqual(result.unmatched, ['a.png']);
});

test('an existing folder with a known name is reused; no second design folder appears (FR-003)', (t: any) => {
  const { ctx } = tree(t, { 'architecture/old.md': 'old', 'system-architecture.md': 'new' });
  const result = sort(ctx);
  assert.deepEqual(movesOf(result), ['system-architecture.md>architecture/system-architecture.md']);
  assert.deepEqual(result.createdDirs, []);
  assert.ok(!fs.existsSync(path.join(ctx, 'hld')));
});

test('a pre-sorted tree with a .DS_Store is a zero-move no-op, twice, and leaves no .intake folder (FR-002)', (t: any) => {
  const { ctx } = tree(t, {
    '.DS_Store': 'junk', 'raw-prd/qr-voucher.md': 'prd', 'hld/high-level-design.md': 'hld', 'hld/diagrams/01.mmd': 'g', 'hld/diagrams/01.png': Buffer.from([1]),
    'discuss-session/records/call.mp3': Buffer.from([1, 2]), 'discuss-session/transcripts/call.txt': 'words',
  });
  const before = snapshot(ctx);
  for (let i = 0; i < 2; i += 1) {
    const result = sort(ctx);
    assert.deepEqual(result, { action: 'sort', state: 'sorted', runId: null, moves: [], skipped: [], unmatched: [], createdDirs: [] });
    assert.deepEqual(snapshot(ctx), before);
  }
  assert.ok(!fs.existsSync(path.join(ctx, '.intake')), 'a sort with zero moves writes no manifest and no folder');
});

test('hidden files, links and subfolder contents are never moved', (t: any) => {
  const { dir, ctx } = tree(t, { '.hidden-prd.md': 'h', 'sub/prd.md': 'inside', 'prd.md': 'loose' });
  fs.writeFileSync(path.join(dir, 'outside-prd.md'), 'outside');
  fs.symlinkSync(path.join(dir, 'outside-prd.md'), path.join(ctx, 'link-prd.md'));
  const result = sort(ctx);
  assert.deepEqual(movesOf(result), ['prd.md>raw-prd/prd.md']);
  assert.equal(fs.lstatSync(path.join(ctx, 'link-prd.md')).isSymbolicLink(), true);
  assert.ok(fs.existsSync(path.join(ctx, '.hidden-prd.md')));
  assert.ok(fs.existsSync(path.join(ctx, 'sub', 'prd.md')));
  assert.equal(fs.readFileSync(path.join(dir, 'outside-prd.md'), 'utf8'), 'outside');
});

test('a name the manifest cannot hold is skipped as unsupported-name; the rest moves and later calls still work', (t: any) => {
  const { ctx } = tree(t, { 'a\\b-prd.md': 'odd', 'ok-prd.md': 'fine' });
  const result = sort(ctx);
  assert.deepEqual(movesOf(result), ['ok-prd.md>raw-prd/ok-prd.md']);
  assert.deepEqual(result.skipped, [{ path: 'a\\b-prd.md', reason: 'unsupported-name', detail: 'the name cannot be recorded in the manifest' }]);
  assert.equal(fs.readFileSync(path.join(ctx, 'a\\b-prd.md'), 'utf8'), 'odd');
  assert.deepEqual(previewSort({ contextDir: ctx, taxonomy: taxonomy(), now: LATER() }).skipped.map((s: any) => s.reason), ['unsupported-name']);
  const again = sort(ctx);
  assert.deepEqual(again.moves, []);
  assert.deepEqual(again.skipped.map((s: any) => s.reason), ['unsupported-name']);
  assert.deepEqual(undo(ctx).restored, [{ from: 'ok-prd.md', to: 'raw-prd/ok-prd.md' }]);
  assert.ok(fs.existsSync(path.join(ctx, 'a\\b-prd.md')));
});

test('a .intake that is a link or a file is refused by sort, undo and file-prompt and nothing is written outside', (t: any) => {
  for (const kind of ['link', 'file']) {
    const { dir, ctx } = tree(t, { 'a-prd.md': 'one' });
    const outside = path.join(dir, 'elsewhere');
    fs.mkdirSync(outside);
    if (kind === 'link') fs.symlinkSync(outside, path.join(ctx, '.intake')); else fs.writeFileSync(path.join(ctx, '.intake'), 'not a folder');
    for (const call of [() => sort(ctx), () => undo(ctx), () => undo(ctx, { runId: 'run-x' }), () => filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('x') })]) {
      assert.throws(call, (error: any) => error instanceof IntakeUsageError && /not a real folder/.test(error.message), kind);
    }
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the folder');
    assert.equal(fs.readFileSync(path.join(ctx, 'a-prd.md'), 'utf8'), 'one');
    assert.ok(!fs.existsSync(path.join(ctx, 'raw-prd')));
  }
});

test('a taken destination name gets a numbered suffix; neither file is overwritten (FR-006)', (t: any) => {
  const { ctx } = tree(t, { 'raw-prd/prd.md': 'first', 'raw-prd/prd-1.md': 'second', 'prd.md': 'third' });
  const result = sort(ctx);
  assert.deepEqual(movesOf(result), ['prd.md>raw-prd/prd-2.md']);
  assert.equal(fs.readFileSync(path.join(ctx, 'raw-prd', 'prd.md'), 'utf8'), 'first');
  assert.equal(fs.readFileSync(path.join(ctx, 'raw-prd', 'prd-1.md'), 'utf8'), 'second');
  assert.equal(fs.readFileSync(path.join(ctx, 'raw-prd', 'prd-2.md'), 'utf8'), 'third');
  assert.equal(manifestOf(ctx).runs[0].moves[0].to, 'raw-prd/prd-2.md', 'the manifest records the suffixed name');
});

test('a file modified inside the window is skipped as recent; outside it, moved (FR-007, injected clock)', (t: any) => {
  const now = LATER();
  const { ctx } = tree(t, { 'prd.md': 'a', 'brief.md': 'b' }, now);
  const ten = new Date(now.getTime() - 10_000);
  fs.utimesSync(path.join(ctx, 'prd.md'), ten, ten);
  const result = sort(ctx, { now });
  assert.deepEqual(movesOf(result), ['brief.md>raw-prd/brief.md']);
  assert.deepEqual(result.skipped, [{ path: 'prd.md', reason: 'recent' }]);
  assert.ok(fs.existsSync(path.join(ctx, 'prd.md')), 'the recent file stays at the root');

  const later = sort(ctx, { now: new Date(now.getTime() + 120_000) });
  assert.deepEqual(movesOf(later), ['prd.md>raw-prd/prd.md']);

  const zero = { ...taxonomy(), recentWindowSeconds: 0 };
  const { ctx: ctx2 } = tree(t, { 'prd.md': 'a' }, now);
  fs.utimesSync(path.join(ctx2, 'prd.md'), now, now);
  assert.deepEqual(movesOf(sortFolder({ contextDir: ctx2, taxonomy: zero, now })), ['prd.md>raw-prd/prd.md'], 'a window of 0 never skips');
});

test('the same names and times give the same moves (NFR-005)', (t: any) => {
  const files = { 'b-prd.md': 'b', 'a-prd.md': 'a', 'x.mmd': 'x', 'x.png': Buffer.from([1]), 'z.pdf': Buffer.from('z') };
  const now = LATER();
  const strip = (r: any): any => ({ ...r, runId: undefined });
  const one = sort(tree(t, files, now).ctx, { now });
  const two = sort(tree(t, files, now).ctx, { now });
  assert.deepEqual(strip(one), strip(two));
  assert.deepEqual(movesOf(one).slice(0, 2), ['a-prd.md>raw-prd/a-prd.md', 'b-prd.md>raw-prd/b-prd.md'], 'files are taken in byte order');
});

test('a folder name that is a file, or a link, cannot hold a category: the file is reported failed, nothing leaves the folder', (t: any) => {
  const { dir, ctx } = tree(t, { 'hld': 'i am a file', 'x.mmd': 'd', 'raw-prd-note.md': 'n' });
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(ctx, 'raw-prd'));
  const result = sort(ctx);
  assert.deepEqual(result.moves, []);
  assert.deepEqual(result.skipped.map((s: any) => [s.path, s.reason]), [['raw-prd-note.md', 'failed'], ['x.mmd', 'failed']]);
  assert.match(result.skipped[1].detail, /hld exists and is not a plain folder/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'elsewhere')), []);
  assert.ok(fs.existsSync(path.join(ctx, 'x.mmd')));
});

test('an absent folder, a link and a plain file in its place', (t: any) => {
  const dir = tempDir(t, 'doflow-intake-');
  const ctx = path.join(dir, 'additional-context');
  for (const run of [sort, (c: string) => previewSort({ contextDir: c, taxonomy: taxonomy() }), undo, (c: string) => listFolder({ contextDir: c, taxonomy: taxonomy() })]) {
    assert.equal(run(ctx).state, 'absent');
  }
  assert.ok(!fs.existsSync(ctx), 'no action but file-prompt creates the folder');
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), ctx);
  assert.throws(() => sort(ctx), (e: any) => e instanceof IntakeUsageError && /symbolic link/.test(e.message));
  fs.rmSync(ctx);
  fs.writeFileSync(ctx, 'x');
  assert.throws(() => sort(ctx), (e: any) => e instanceof IntakeUsageError && /not a folder/.test(e.message));
});

// ── preview ────────────────────────────────────────────────────────────────────────────────────

test('preview reports the moves a sort would make, writes nothing and takes no lock (FR-008)', (t: any) => {
  const { ctx } = tree(t, { 'prd.md': 'a', 'x.mmd': 'b', 'notes.txt': 'n' });
  const before = snapshot(ctx);
  fs.mkdirSync(path.join(ctx, '.intake'));
  fs.mkdirSync(`${manifestFile(ctx)}.lock`); // another writer holds the lock for the whole preview
  const preview = previewSort({ contextDir: ctx, taxonomy: taxonomy(), now: LATER() });
  fs.rmdirSync(`${manifestFile(ctx)}.lock`);
  assert.equal(preview.action, 'preview');
  assert.equal(preview.runId, null);
  assert.deepEqual(snapshot(ctx), before);
  assert.deepEqual(fs.readdirSync(path.join(ctx, '.intake')), []);

  const real = sort(ctx);
  assert.deepEqual(preview.moves, real.moves, 'the preview names the moves the sort then makes');
  assert.deepEqual(preview.unmatched, real.unmatched);
});

// ── undo ───────────────────────────────────────────────────────────────────────────────────────

test('undo puts every file back with its original hash and removes the folders the run made (FR-005)', (t: any) => {
  const { ctx } = tree(t, { 'prd.md': 'a', 'x.mmd': 'b', 'x.png': Buffer.from([7]), 'talk.mp3': Buffer.from([1, 2, 3]), 'keep.bin': Buffer.from([0]) });
  const before = snapshot(ctx);
  const sorted = sort(ctx);
  assert.notDeepEqual(snapshot(ctx), before);
  const result = undo(ctx);
  assert.equal(result.runId, sorted.runId);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.restored.length, 4);
  assert.deepEqual(snapshot(ctx), before, 'the tree is exactly as it was');
  assert.deepEqual([...result.removedDirs].sort(), [...sorted.createdDirs].sort());
  assert.ok(manifestOf(ctx).runs[0].moves.every((m: any) => m.state === 'undone'));
});

test('undo keeps a folder that is not empty afterwards', (t: any) => {
  const { ctx } = tree(t, { 'prd.md': 'a' });
  sort(ctx);
  fs.writeFileSync(path.join(ctx, 'raw-prd', '.DS_Store'), 'x');
  const result = undo(ctx);
  assert.deepEqual(result.removedDirs, []);
  assert.ok(fs.existsSync(path.join(ctx, 'raw-prd', '.DS_Store')));
  assert.ok(fs.existsSync(path.join(ctx, 'prd.md')));
});

test('undo restores in reverse order and skips a file that changed, reporting it and keeping its entry (FR-005)', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'one', 'b-prd.md': 'two' });
  sort(ctx);
  fs.writeFileSync(path.join(ctx, 'raw-prd', 'a-prd.md'), 'edited by the user');
  const result = undo(ctx);
  assert.deepEqual(result.restored, [{ from: 'b-prd.md', to: 'raw-prd/b-prd.md' }]);
  assert.deepEqual(result.skipped, [{ to: 'raw-prd/a-prd.md', reason: 'changed' }]);
  assert.equal(fs.readFileSync(path.join(ctx, 'raw-prd', 'a-prd.md'), 'utf8'), 'edited by the user');
  assert.deepEqual(result.removedDirs, [], 'raw-prd still holds the edited file');
  const entries = manifestOf(ctx).runs[0].moves;
  assert.deepEqual(entries.map((m: any) => m.state), ['undo-skipped', 'undone']);
  assert.equal(entries[0].reason, 'changed');
});

test('undo skips an entry whose origin is taken or whose file is gone; naming the run retries it', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'one', 'b-prd.md': 'two' });
  const { runId } = sort(ctx);
  fs.writeFileSync(path.join(ctx, 'a-prd.md'), 'a new file at the old path');
  fs.rmSync(path.join(ctx, 'raw-prd', 'b-prd.md'));
  const first = undo(ctx);
  assert.deepEqual(first.skipped.map((s: any) => s.reason).sort(), ['missing', 'origin-taken']);
  assert.deepEqual(first.restored, []);
  // Without a name, a run with no entry left in state done is not picked again.
  assert.equal(undo(ctx).state, 'nothing-to-undo');
  // The developer clears the old path and names the run: the entry that can be restored is.
  fs.rmSync(path.join(ctx, 'a-prd.md'));
  const retry = undo(ctx, { runId });
  assert.deepEqual(retry.restored, [{ from: 'a-prd.md', to: 'raw-prd/a-prd.md' }]);
  assert.deepEqual(retry.skipped.map((s: any) => s.reason), ['missing']);
});

test('a restore that died before it was journaled is recognised and recorded as undone', (t: any) => {
  const { ctx } = tree(t, { 'prd.md': 'a' });
  sort(ctx);
  fs.renameSync(path.join(ctx, 'raw-prd', 'prd.md'), path.join(ctx, 'prd.md'));
  const result = undo(ctx);
  assert.deepEqual(result.restored, [{ from: 'prd.md', to: 'raw-prd/prd.md' }]);
  assert.deepEqual(result.skipped, []);
});

test('undo with no run, an unknown run id, or a file-prompt run', (t: any) => {
  const { ctx } = tree(t, { 'x.bin': 'nothing sorts this' });
  assert.equal(undo(ctx).state, 'nothing-to-undo');
  assert.throws(() => undo(ctx, { runId: 'run-nope' }), /no run 'run-nope'/);
  const filed = filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('ctx'), now: LATER() });
  assert.equal(undo(ctx).state, 'nothing-to-undo', 'a filed prompt is not a move to undo');
  assert.throws(() => undo(ctx, { runId: filed.runId }), (e: any) => e instanceof IntakeUsageError && /never deletes/.test(e.message));
  assert.throws(() => undo(ctx, { runId: 'run-nope' }), /no run/);
  assert.equal(fs.readFileSync(path.join(ctx, filed.path), 'utf8'), 'ctx');
});

test('undo walks only the latest sort run', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'one' });
  const first = sort(ctx);
  fs.writeFileSync(path.join(ctx, 'b-prd.md'), 'two');
  const old = new Date(Date.now() - 86_400_000);
  fs.utimesSync(path.join(ctx, 'b-prd.md'), old, old);
  const second = sort(ctx);
  const result = undo(ctx);
  assert.equal(result.runId, second.runId);
  assert.ok(fs.existsSync(path.join(ctx, 'raw-prd', 'a-prd.md')), 'the earlier run is untouched');
  assert.equal(undo(ctx).runId, first.runId);
});

// ── failure paths ──────────────────────────────────────────────────────────────────────────────

test('a destination hash that differs after the move marks the entry failed, keeps the file there and is never moved again', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'one', 'b-prd.md': 'two' });
  const fsImpl = { ...fs, linkSync(from: string, to: string) { fs.linkSync(from, to); if (to.endsWith('a-prd.md')) fs.appendFileSync(to, ' corrupted'); } };
  const result = sort(ctx, { fsImpl });
  assert.deepEqual(movesOf(result), ['b-prd.md>raw-prd/b-prd.md']);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'failed');
  assert.match(result.skipped[0].detail, /differs from the hash/);
  assert.ok(fs.existsSync(path.join(ctx, 'raw-prd', 'a-prd.md')));
  assert.deepEqual(manifestOf(ctx).runs[0].moves.map((m: any) => m.state), ['failed', 'done']);
  const undone = undo(ctx);
  assert.deepEqual(undone.restored, [{ from: 'b-prd.md', to: 'raw-prd/b-prd.md' }]);
  assert.ok(fs.existsSync(path.join(ctx, 'raw-prd', 'a-prd.md')), 'a failed entry is reported, never moved automatically');
});

test('a rename that throws marks that entry failed and the others still move', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'one', 'b-prd.md': 'two' });
  const fsImpl = { ...fs, linkSync(from: string, to: string) { if (to.endsWith('a-prd.md')) throw Object.assign(new Error('EXDEV: simulated'), { code: 'EXDEV' }); fs.linkSync(from, to); } };
  const result = sort(ctx, { fsImpl });
  assert.deepEqual(movesOf(result), ['b-prd.md>raw-prd/b-prd.md']);
  assert.match(result.skipped[0].detail, /rename failed: EXDEV/);
  assert.ok(fs.existsSync(path.join(ctx, 'a-prd.md')), 'the file is still at its origin');
});

test('a destination folder that cannot be created marks that entry failed, moves nothing else wrongly, and the next run completes', (t: any) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) { t.skip('folder modes are not enforced here'); return; }
  const { ctx } = tree(t, { 'talk.mp3': Buffer.from([0xff, 0xfb, 0x90]), 'a-prd.md': 'one', 'discuss-session/keep.txt': 'mine' });
  const locked = path.join(ctx, 'discuss-session');
  fs.chmodSync(locked, 0o555);
  t.after(() => { try { fs.chmodSync(locked, 0o755); } catch { /* already cleaned up */ } });
  const before = snapshot(ctx);

  const result = sort(ctx);
  assert.deepEqual(movesOf(result), ['a-prd.md>raw-prd/a-prd.md']);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].path, 'talk.mp3');
  assert.equal(result.skipped[0].reason, 'failed');
  assert.match(result.skipped[0].detail, /discuss-session\/records could not be created: EACCES/);
  assert.ok(fs.existsSync(path.join(ctx, 'talk.mp3')), 'the file is still at its origin');
  const manifest = manifestOf(ctx);
  assert.ok(manifest.runs[0].finishedAt);
  assert.deepEqual(manifest.runs[0].moves.map((m: any) => `${m.from}:${m.state}`), ['a-prd.md:done', 'talk.mp3:failed']);
  assert.ok(!manifest.runs.some((run: any) => run.moves.some((m: any) => m.state === 'planned')), 'no planned entry is left behind');
  const after = snapshot(ctx);
  assert.equal(after['talk.mp3'], before['talk.mp3']);
  assert.equal(after['discuss-session/keep.txt'], before['discuss-session/keep.txt']);

  fs.chmodSync(locked, 0o755);
  const next = sort(ctx);
  assert.deepEqual(movesOf(next), ['talk.mp3>discuss-session/records/talk.mp3']);
  assert.deepEqual(next.skipped, []);
  assert.equal(sha(fs.readFileSync(path.join(ctx, 'discuss-session', 'records', 'talk.mp3'))), before['talk.mp3']);
});

test('a destination that appears after the journal entry is never overwritten', (t: any) => {
  const { ctx } = tree(t, { 'prd.md': 'mine' });
  const squat = path.join(ctx, 'raw-prd', 'prd.md');
  const fsImpl = { ...fs, renameSync(from: string, to: string) {
    fs.renameSync(from, to);
    if (to === manifestFile(ctx) && !fs.existsSync(squat) && fs.existsSync(path.join(ctx, 'raw-prd'))) fs.writeFileSync(squat, 'someone else');
  } };
  const result = sort(ctx, { fsImpl });
  assert.deepEqual(result.moves, []);
  assert.match(result.skipped[0].detail, /appeared before the move/);
  assert.equal(fs.readFileSync(squat, 'utf8'), 'someone else');
  assert.equal(fs.readFileSync(path.join(ctx, 'prd.md'), 'utf8'), 'mine');
});

test('a file created at the destination between the check and the move is not overwritten and the move is not done', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'mine', 'b-prd.md': 'other' });
  const squat = path.join(ctx, 'raw-prd', 'a-prd.md');
  // Created after the plan and the journal entry, in the instant before the link: the window a lstat-then-rename lost.
  const fsImpl = { ...fs, linkSync(from: string, to: string) { if (to === squat) fs.writeFileSync(squat, 'someone else'); fs.linkSync(from, to); } };
  const result = sort(ctx, { fsImpl });
  assert.deepEqual(movesOf(result), ['b-prd.md>raw-prd/b-prd.md']);
  assert.match(result.skipped[0].detail, /appeared before the move/);
  assert.equal(fs.readFileSync(squat, 'utf8'), 'someone else');
  assert.equal(fs.readFileSync(path.join(ctx, 'a-prd.md'), 'utf8'), 'mine');
  assert.deepEqual(manifestOf(ctx).runs[0].moves.map((m: any) => m.state), ['failed', 'done']);
});

test('a link that cannot be undone leaves the origin where it was and no second name behind', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'mine' });
  const fsImpl = { ...fs, unlinkSync(file: string) { if (file.endsWith('a-prd.md') && !file.includes('raw-prd')) throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' }); fs.unlinkSync(file); } };
  const result = sort(ctx, { fsImpl });
  assert.deepEqual(result.moves, []);
  assert.match(result.skipped[0].detail, /rename failed: EACCES/);
  assert.equal(fs.readFileSync(path.join(ctx, 'a-prd.md'), 'utf8'), 'mine');
  assert.ok(!fs.existsSync(path.join(ctx, 'raw-prd', 'a-prd.md')));
});

test('a crash between the link and the unlink leaves one file under two names; the next run finishes the move and does not re-sort a duplicate', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'twice' });
  fs.mkdirSync(path.join(ctx, 'raw-prd'));
  fs.linkSync(path.join(ctx, 'a-prd.md'), path.join(ctx, 'raw-prd', 'a-prd.md'));
  fs.mkdirSync(path.join(ctx, '.intake'));
  fs.writeFileSync(manifestFile(ctx), JSON.stringify({ schema: 1, runs: [{
    id: 'run-20261101T000000Z-cccc', action: 'sort', startedAt: 'x', finishedAt: null, source: null, stage: null, createdDirs: ['raw-prd'],
    moves: [{ from: 'a-prd.md', to: 'raw-prd/a-prd.md', sha256: sha('twice'), bytes: 5, at: 'x', state: 'planned', reason: null }],
  }] }));
  const result = sort(ctx);
  assert.deepEqual(result.moves, []);
  assert.equal(manifestOf(ctx).runs[0].moves[0].state, 'done');
  assert.ok(!fs.existsSync(path.join(ctx, 'a-prd.md')), 'the origin name is dropped');
  assert.ok(!fs.existsSync(path.join(ctx, 'raw-prd', 'a-prd-1.md')), 'no duplicate');
  assert.equal(fs.readFileSync(path.join(ctx, 'raw-prd', 'a-prd.md'), 'utf8'), 'twice');
});

test('undo finishes a restore that died between its link and its unlink', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'back' });
  sort(ctx);
  fs.linkSync(path.join(ctx, 'raw-prd', 'a-prd.md'), path.join(ctx, 'a-prd.md'));
  const result = undo(ctx);
  assert.deepEqual(result.restored, [{ from: 'a-prd.md', to: 'raw-prd/a-prd.md' }]);
  assert.equal(fs.readFileSync(path.join(ctx, 'a-prd.md'), 'utf8'), 'back');
  assert.ok(!fs.existsSync(path.join(ctx, 'raw-prd')), 'the emptied folder went');
});

test('undo does not replace an origin that appears between the check and the restore', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'mine' });
  sort(ctx);
  const origin = path.join(ctx, 'a-prd.md');
  const fsImpl = { ...fs, linkSync(from: string, to: string) { if (to === origin) fs.writeFileSync(origin, 'someone else'); fs.linkSync(from, to); } };
  const result = undo(ctx, { fsImpl });
  assert.deepEqual(result.skipped, [{ to: 'raw-prd/a-prd.md', reason: 'origin-taken' }]);
  assert.equal(fs.readFileSync(origin, 'utf8'), 'someone else');
  assert.equal(fs.readFileSync(path.join(ctx, 'raw-prd', 'a-prd.md'), 'utf8'), 'mine');
});

test('a volume that cannot hard-link falls back to a look and a rename for sort, undo and file-prompt, and the journal says so', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'mine', 'b-prd.md': 'other' });
  const noLink = { ...fs, linkSync() { throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' }); } };
  const result = sort(ctx, { fsImpl: noLink });
  assert.deepEqual(movesOf(result), ['a-prd.md>raw-prd/a-prd.md', 'b-prd.md>raw-prd/b-prd.md']);
  assert.deepEqual(manifestOf(ctx).runs[0].moves.map((m: any) => m.fallback), ['rename', 'rename']);
  assert.ok(!fs.existsSync(path.join(ctx, 'a-prd.md')));
  assert.equal(undo(ctx, { fsImpl: noLink }).restored.length, 2);
  assert.equal(manifestOf(ctx).runs[0].moves[0].fallback, 'rename');
  assert.equal(fs.readFileSync(path.join(ctx, 'a-prd.md'), 'utf8'), 'mine');
  const filed = filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('prompt text'), fsImpl: noLink });
  assert.equal(fs.readFileSync(path.join(ctx, filed.path), 'utf8'), 'prompt text');
  assert.equal(manifestOf(ctx).runs[1].moves[0].fallback, 'rename');
  assert.equal(manifestOf(ctx).runs[1].moves[0].state, 'done');
});

test('the fallback still refuses a destination that exists when it looks', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'mine' });
  const squat = path.join(ctx, 'raw-prd', 'a-prd.md');
  const noLink = { ...fs, linkSync(_from: string, to: string) { if (to === squat) fs.writeFileSync(squat, 'someone else'); throw Object.assign(new Error('ENOTSUP: simulated'), { code: 'ENOTSUP' }); } };
  const result = sort(ctx, { fsImpl: noLink });
  assert.deepEqual(result.moves, []);
  assert.match(result.skipped[0].detail, /appeared before the move/);
  assert.equal(fs.readFileSync(squat, 'utf8'), 'someone else');
  assert.equal(fs.readFileSync(path.join(ctx, 'a-prd.md'), 'utf8'), 'mine');
});

test('file-prompt never replaces a file that appears at the destination before the write', (t: any) => {
  const { ctx } = tree(t, {});
  const now = LATER();
  const day = now.toISOString().slice(0, 10);
  const squat = path.join(ctx, 'prompt', `prompt-${day}-01.md`);
  const fsImpl = { ...fs, linkSync(from: string, to: string) { if (to === squat) fs.writeFileSync(squat, 'someone else'); fs.linkSync(from, to); } };
  assert.throws(() => filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('mine'), now, fsImpl }), /destination appeared before the write/);
  assert.equal(fs.readFileSync(squat, 'utf8'), 'someone else');
  assert.equal(manifestOf(ctx).runs[0].moves[0].state, 'failed');
  assert.deepEqual(fs.readdirSync(path.join(ctx, '.intake')).filter((f: string) => f.endsWith('.tmp') && f.startsWith('prompt')), []);
});

test('a lock reclaimed by another writer before the journal rename stops the run: nothing is renamed, written or moved', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'one', 'b-prd.md': 'two' });
  const lock = `${manifestFile(ctx)}.lock`;
  const fsImpl = { ...fs, writeFileSync(file: string, ...rest: any[]) {
    fs.writeFileSync(file, ...rest);
    if (file.startsWith(manifestFile(ctx)) && file.endsWith('.tmp')) fs.rmSync(lock, { recursive: true, force: true });
  } };
  assert.throws(() => sort(ctx, { fsImpl }), (error: any) => error instanceof IntakeUsageError && /taken over by another writer/.test(error.message));
  assert.ok(fs.existsSync(path.join(ctx, 'a-prd.md')) && fs.existsSync(path.join(ctx, 'b-prd.md')), 'no user file moved');
  assert.ok(!fs.existsSync(manifestFile(ctx)), 'the manifest was not renamed into place');
  assert.deepEqual(fs.readdirSync(path.join(ctx, '.intake')).filter((f: string) => f.endsWith('.tmp')), [], 'the temp file is gone');
});

test('a lock reclaimed after the first move stops the run before the second file is touched', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'one', 'b-prd.md': 'two' });
  const lock = `${manifestFile(ctx)}.lock`;
  const fsImpl = { ...fs, linkSync(from: string, to: string) { fs.linkSync(from, to); fs.rmSync(lock, { recursive: true, force: true }); } };
  assert.throws(() => sort(ctx, { fsImpl }), /taken over by another writer/);
  assert.ok(fs.existsSync(path.join(ctx, 'raw-prd', 'a-prd.md')));
  assert.equal(fs.readFileSync(path.join(ctx, 'b-prd.md'), 'utf8'), 'two');
  assert.ok(!fs.existsSync(path.join(ctx, 'raw-prd', 'b-prd.md')));
  assert.deepEqual(manifestOf(ctx).runs[0].moves.map((m: any) => m.state), ['planned'], 'the journal still says planned; the next run settles it');
  assert.deepEqual(sort(ctx).moves.map((m: any) => m.to), ['raw-prd/b-prd.md']);
  assert.equal(manifestOf(ctx).runs[0].moves[0].state, 'done');
});

test('a lock reclaimed before a restore or a filed prompt writes nothing', (t: any) => {
  const { ctx } = tree(t, { 'a-prd.md': 'one' });
  sort(ctx);
  const lock = `${manifestFile(ctx)}.lock`;
  const reclaim = { ...fs, readFileSync(file: any, ...rest: any[]) {
    const data = (fs.readFileSync as any)(file, ...rest);
    if (file === manifestFile(ctx)) fs.rmSync(lock, { recursive: true, force: true });
    return data;
  }, linkSync() { throw new Error('a link must not be attempted'); } };
  assert.throws(() => undo(ctx, { fsImpl: reclaim }), /taken over by another writer/);
  assert.ok(fs.existsSync(path.join(ctx, 'raw-prd', 'a-prd.md')) && !fs.existsSync(path.join(ctx, 'a-prd.md')));
  assert.throws(() => filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('p'), fsImpl: reclaim }), /taken over by another writer/);
  assert.ok(!fs.existsSync(path.join(ctx, 'prompt')) || fs.readdirSync(path.join(ctx, 'prompt')).length === 0, 'no prompt file written');
});

test('planned entries from a dead run are reconciled by the next sort (done when the destination holds the hash, failed when the origin still holds the file)', (t: any) => {
  const { ctx } = tree(t, { 'raw-prd/moved.md': 'arrived', 'stuck-prd.md': 'never moved', 'new-prd.md': 'fresh' });
  fs.mkdirSync(path.join(ctx, '.intake'));
  const entry = (from: string, to: string, content: string): any => ({ from, to, sha256: sha(content), bytes: content.length, at: '2026-11-01T00:00:00.000Z', state: 'planned', reason: null });
  fs.writeFileSync(manifestFile(ctx), JSON.stringify({ schema: 1, runs: [{
    id: 'run-20261101T000000Z-aaaa', action: 'sort', startedAt: '2026-11-01T00:00:00.000Z', finishedAt: null, source: null, stage: null, createdDirs: ['raw-prd'],
    moves: [entry('moved.md', 'raw-prd/moved.md', 'arrived'), entry('stuck-prd.md', 'raw-prd/stuck-prd.md', 'never moved'), entry('ghost.md', 'raw-prd/ghost.md', 'gone')],
  }] }));
  const result = sort(ctx);
  assert.deepEqual(movesOf(result), ['new-prd.md>raw-prd/new-prd.md', 'stuck-prd.md>raw-prd/stuck-prd.md']);
  const dead = manifestOf(ctx).runs[0];
  assert.deepEqual(dead.moves.map((m: any) => m.state), ['done', 'failed', 'failed']);
  assert.match(dead.moves[1].reason, /origin still holds a file/);
  assert.match(dead.moves[2].reason, /neither the origin nor the destination/);
  assert.ok(dead.finishedAt, 'the settled run is finished');
});

test('a sort with nothing to move still settles planned entries', (t: any) => {
  const { ctx } = tree(t, { 'raw-prd/moved.md': 'arrived' });
  fs.mkdirSync(path.join(ctx, '.intake'));
  fs.writeFileSync(manifestFile(ctx), JSON.stringify({ schema: 1, runs: [{
    id: 'run-20261101T000000Z-bbbb', action: 'sort', startedAt: 'x', finishedAt: null, source: null, stage: null, createdDirs: [],
    moves: [{ from: 'moved.md', to: 'raw-prd/moved.md', sha256: sha('arrived'), bytes: 7, at: 'x', state: 'planned', reason: null }],
  }] }));
  const result = sort(ctx);
  assert.equal(result.runId, null);
  assert.equal(manifestOf(ctx).runs[0].moves[0].state, 'done');
});

test('a manifest from a newer schema, a torn one and one naming a path outside the folder are refused untouched', (t: any) => {
  const { ctx } = tree(t, { 'prd.md': 'a' });
  fs.mkdirSync(path.join(ctx, '.intake'));
  const bad = [
    JSON.stringify({ schema: 2, runs: [] }),
    '{ torn',
    JSON.stringify({ schema: 1, runs: [{ id: 'r', action: 'sort', startedAt: 'x', finishedAt: null, source: null, stage: null, createdDirs: [],
      moves: [{ from: 'prd.md', to: '../escaped.md', sha256: sha('a'), bytes: 1, at: 'x', state: 'done', reason: null }] }] }),
  ];
  for (const text of bad) {
    fs.writeFileSync(manifestFile(ctx), text);
    for (const run of [() => sort(ctx), () => undo(ctx), () => filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('x'), now: LATER() })]) {
      assert.throws(run, (e: any) => e instanceof IntakeUsageError);
    }
    assert.equal(fs.readFileSync(manifestFile(ctx), 'utf8'), text, 'the manifest is never rewritten');
    assert.ok(fs.existsSync(path.join(ctx, 'prd.md')));
  }
  assert.throws(() => readManifest(ctx), /never rewritten when it cannot be trusted/);
});

// ── list ───────────────────────────────────────────────────────────────────────────────────────

test('list gives category, kind, size, hash and pointer for every visible file, and never a binary file\'s content (FR-010)', (t: any) => {
  const big = Buffer.alloc(3 * 1024 * 1024 + 5, 7);
  const { dir, ctx } = tree(t, {
    'raw-prd/prd.md': '# prd', 'hld/diagrams/a.mmd': 'g', 'discuss-session/records/call.mp3': big, 'notes.txt': 'loose', 'huge.md': Buffer.alloc(262145, 1),
    'misc/readme.md': 'in an unknown folder', '.DS_Store': 'x', '.intake/manifest.json': '{}', '.hidden/x.md': 'x',
  });
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(ctx, 'dangling.md'));
  const result = listFolder({ contextDir: ctx, taxonomy: taxonomy() });
  assert.equal(result.state, 'listed');
  assert.deepEqual(result.files.map((f: any) => f.path), ['discuss-session/records/call.mp3', 'hld/diagrams/a.mmd', 'huge.md', 'misc/readme.md', 'notes.txt', 'raw-prd/prd.md']);
  const by = Object.fromEntries(result.files.map((f: any) => [f.path, f]));
  assert.deepEqual(by['discuss-session/records/call.mp3'], { path: 'discuss-session/records/call.mp3', category: 'discuss-session', kind: 'binary', bytes: big.length, sha256: sha(big), pointer: false });
  assert.deepEqual([by['hld/diagrams/a.mmd'].category, by['hld/diagrams/a.mmd'].kind, by['hld/diagrams/a.mmd'].pointer], ['hld', 'text', false]);
  assert.deepEqual([by['misc/readme.md'].category, by['misc/readme.md'].pointer], [null, true]);
  assert.deepEqual([by['notes.txt'].category, by['notes.txt'].kind], [null, 'text']);
  assert.equal(by['huge.md'].pointer, false, 'a markdown file over the limit is listed but not a pointer');
  assert.ok(!JSON.stringify(result).includes('AAAA'), 'no content leaves in the listing');
  assert.deepEqual(Object.keys(by['raw-prd/prd.md']).sort(), ['bytes', 'category', 'kind', 'path', 'pointer', 'sha256']);
});

// ── file-prompt ────────────────────────────────────────────────────────────────────────────────

test('file-prompt writes the bytes unchanged, numbers the file per date and keeps provenance in the manifest only (FR-009)', (t: any) => {
  const { ctx } = tree(t, { 'other.bin': 'x' });
  const bytes = Buffer.concat([Buffer.from('Pasted: '), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('\r\nend  \n')]);
  const day = new Date('2026-11-02T10:00:00.000Z');
  const one = filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes, stage: 'discovery', now: day });
  assert.deepEqual([one.action, one.path, one.bytes, one.sha256], ['file-prompt', 'prompt/prompt-2026-11-02-01.md', bytes.length, sha(bytes)]);
  assert.ok(fs.readFileSync(path.join(ctx, one.path)).equals(bytes), 'byte for byte');
  const two = filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('second'), now: day });
  assert.equal(two.path, 'prompt/prompt-2026-11-02-02.md');
  const next = filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('third'), now: new Date('2026-11-03T00:00:01.000Z') });
  assert.equal(next.path, 'prompt/prompt-2026-11-03-01.md');

  const runs = manifestOf(ctx).runs;
  assert.deepEqual(runs.map((r: any) => [r.action, r.source]), [['file-prompt', 'prompt'], ['file-prompt', 'prompt'], ['file-prompt', 'prompt']]);
  assert.equal(runs[0].stage, 'discovery');
  assert.equal(runs[1].stage, null);
  assert.deepEqual(runs[0].moves[0], { from: null, to: one.path, sha256: sha(bytes), bytes: bytes.length, at: day.toISOString(), state: 'done', reason: null });
  assert.deepEqual(runs[0].createdDirs, ['prompt']);
  assert.deepEqual(runs[1].createdDirs, []);
  assert.equal(one.runId, runs[0].id);
  assert.deepEqual(fs.readdirSync(path.join(ctx, '.intake')).sort(), ['manifest.json']);
});

test('file-prompt creates the context folder inside an existing feature folder, and refuses empty input or a missing feature folder', (t: any) => {
  const dir = tempDir(t, 'doflow-intake-');
  fs.mkdirSync(path.join(dir, 'feature'));
  const ctx = path.join(dir, 'feature', 'additional-context');
  const filed = filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('hello'), now: LATER() });
  assert.equal(fs.readFileSync(path.join(ctx, filed.path), 'utf8'), 'hello');
  assert.throws(() => filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.alloc(0) }), /input is empty/);
  assert.throws(() => filePrompt({ contextDir: path.join(dir, 'nofeature', 'additional-context'), taxonomy: taxonomy(), bytes: Buffer.from('x') }), /not a feature folder that exists/);
  assert.ok(!fs.existsSync(path.join(dir, 'nofeature')));
});

test('a filed prompt is not moved by a later sort: it sits in a folder, not at the root', (t: any) => {
  const { ctx } = tree(t, {});
  filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('# prd text\n'), now: LATER() });
  const result = sort(ctx);
  assert.deepEqual(result.moves, []);
  assert.ok(fs.existsSync(path.join(ctx, 'prompt', 'prompt-' + LATER().toISOString().slice(0, 10) + '-01.md')));
});

test('a prompt file reuses an existing prompt folder, and a prompt path held by a file is refused', (t: any) => {
  const { ctx } = tree(t, { 'prompt/keep.md': 'keep' });
  assert.equal(filePrompt({ contextDir: ctx, taxonomy: taxonomy(), bytes: Buffer.from('x'), now: new Date('2026-11-02T00:00:00Z') }).path, 'prompt/prompt-2026-11-02-01.md');
  const { ctx: blocked } = tree(t, { 'prompt': 'a file named prompt' });
  assert.throws(() => filePrompt({ contextDir: blocked, taxonomy: taxonomy(), bytes: Buffer.from('x') }), /prompt folder prompt/);
  assert.equal(fs.readFileSync(path.join(blocked, 'prompt'), 'utf8'), 'a file named prompt');
});

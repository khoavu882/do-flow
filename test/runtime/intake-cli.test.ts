'use strict';
// 136 B.2, IC-001: the `intake` verb through the real dispatcher `doflow-run` (what every harness calls, NFR-002),
// against scratch git repos on a feature branch. Exit 0 done, 1 a finding, 2 a call that cannot proceed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW_RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SCRATCH = suiteTempDir('doflow-intake-cli-');
const HOME = path.join(SCRATCH, 'home');
fs.mkdirSync(HOME, { recursive: true });
const SLUG = '136-demo';
let repoCounter = 0;

const env = (): any => ({
  PATH: process.env.PATH, HOME, USERPROFILE: HOME, TMPDIR: SCRATCH, XDG_CONFIG_HOME: path.join(HOME, '.config'),
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
});

/** A scratch git repo with one commit, on feat/<slug> with its feature folder, or on main with none. */
function makeRepo({ branch = `feat/${SLUG}`, feature = true }: any = {}): { repo: string; ctx: string; feature: string } {
  const repo = path.join(SCRATCH, `repo-${repoCounter++}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...env(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'initial');
  if (branch !== 'main') git('checkout', '-q', '-b', branch);
  const featureDir = path.join(repo, 'agent-docs', 'doflow', SLUG);
  if (feature) {
    fs.mkdirSync(path.join(featureDir, 'intention'), { recursive: true });
    fs.writeFileSync(path.join(featureDir, 'intention', 'requirement.md'), '# Requirement\n');
  }
  return { repo, ctx: path.join(featureDir, 'additional-context'), feature: featureDir };
}

function intake(repo: string, args: string[], input: any = ''): { status: number | null; stdout: string; stderr: string; json: any } {
  const r = spawnSync(bashPath(), [DOFLOW_RUN, 'intake', ...args], { cwd: repo, env: { ...env(), DOFLOW_CONFIG_DIR: path.join(repo, '.doflow') }, input, encoding: 'utf8' });
  let json: any = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** Puts `files` in the context folder with a day-old mtime so the recent-change window does not apply. */
function put(ctx: string, files: Record<string, any>): void {
  const old = new Date(Date.now() - 2 * 86_400_000);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(ctx, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.utimesSync(file, old, old);
  }
}

const sha = (data: any): string => `sha256:${nodeCrypto.createHash('sha256').update(data).digest('hex')}`;
const ls = (dir: string): string[] => fs.readdirSync(dir).sort();

test('sort then undo: exit 0 both ways, --json is the engine object, text is a line per move and a count', () => {
  const { repo, ctx } = makeRepo();
  put(ctx, { 'qr-prd.md': '# prd', 'flow.mmd': 'g', 'photo.jpg': Buffer.from([1]) });

  const preview = intake(repo, ['--action', 'preview', '--json']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.json.action, 'preview');
  assert.equal(preview.json.runId, null);
  assert.deepEqual(preview.json.moves.map((m: any) => m.to), ['hld/diagrams/flow.mmd', 'raw-prd/qr-prd.md']);
  assert.deepEqual(ls(ctx), ['flow.mmd', 'photo.jpg', 'qr-prd.md'], 'a preview moves nothing');
  assert.ok(!fs.existsSync(path.join(ctx, '.intake')));

  const text = intake(repo, ['--action', 'sort']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /moved flow\.mmd -> hld\/diagrams\/flow\.mmd {2}\[hld\]/);
  assert.match(text.stdout, /moved qr-prd\.md -> raw-prd\/qr-prd\.md/);
  assert.match(text.stdout, /2 moved, 0 skipped, 1 unmatched; undo with --action undo --run-id run-/);

  const again = intake(repo, ['--action', 'sort', '--json']);
  assert.equal(again.status, 0, 'a second sort of a sorted folder is a zero-move success');
  assert.deepEqual(again.json, { action: 'sort', state: 'sorted', runId: null, moves: [], skipped: [], unmatched: ['photo.jpg'], createdDirs: [] });

  const undone = intake(repo, ['--action', 'undo', '--json']);
  assert.equal(undone.status, 0, undone.stderr);
  assert.equal(undone.json.restored.length, 2);
  assert.deepEqual(ls(ctx), ['.intake', 'flow.mmd', 'photo.jpg', 'qr-prd.md']);

  const nothing = intake(repo, ['--action', 'undo']);
  assert.equal(nothing.status, 1);
  assert.match(nothing.stdout, /no run left to undo/);
});

test('a recently changed file is skipped and the sort exits 1; undo of a changed file exits 1', () => {
  const { repo, ctx } = makeRepo();
  put(ctx, { 'old-prd.md': 'old' });
  fs.writeFileSync(path.join(ctx, 'new-prd.md'), 'written just now');
  const run = intake(repo, ['--action', 'sort', '--json']);
  assert.equal(run.status, 1);
  assert.deepEqual(run.json.skipped, [{ path: 'new-prd.md', reason: 'recent' }]);
  assert.deepEqual(run.json.moves.map((m: any) => m.to), ['raw-prd/old-prd.md']);
  assert.match(intake(repo, ['--action', 'sort']).stdout, /skipped new-prd\.md \(recent\)/);

  fs.writeFileSync(path.join(ctx, 'raw-prd', 'old-prd.md'), 'edited');
  const undo = intake(repo, ['--action', 'undo', '--json']);
  assert.equal(undo.status, 1);
  assert.deepEqual(undo.json.skipped, [{ to: 'raw-prd/old-prd.md', reason: 'changed' }]);
  assert.equal(fs.readFileSync(path.join(ctx, 'raw-prd', 'old-prd.md'), 'utf8'), 'edited');
});

test('list: a line per file with category, kind, size and hash, and a count; an absent folder is a success', () => {
  const { repo, ctx } = makeRepo();
  const absent = intake(repo, ['--action', 'list', '--json']);
  assert.equal(absent.status, 0);
  assert.deepEqual(absent.json, { action: 'list', state: 'absent', files: [] });
  assert.match(intake(repo, ['--action', 'sort']).stdout, /no additional-context folder/);

  const audio = Buffer.alloc(2048, 3);
  put(ctx, { 'raw-prd/prd.md': '# prd', 'discuss-session/records/call.mp3': audio });
  const list = intake(repo, ['--action', 'list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`discuss-session/records/call\\.mp3 {2}discuss-session {2}binary {2}2048 bytes {2}${sha(audio)}`));
  assert.match(list.stdout, /raw-prd\/prd\.md {2}raw-prd {2}text {2}5 bytes {2}sha256:[0-9a-f]{64} {2}pointer/);
  assert.match(list.stdout, /2 files/);
});

test('file-prompt --stdin writes the bytes unchanged; --file does too; the second file is numbered', () => {
  const { repo, ctx } = makeRepo();
  const bytes = Buffer.from('Pasted context \u00e9\u4e2d\r\n  \n', 'utf8');
  const first = intake(repo, ['--action', 'file-prompt', '--stdin', '--stage', 'discovery', '--json'], bytes);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.json.path, /^prompt\/prompt-\d{4}-\d{2}-\d{2}-01\.md$/);
  assert.ok(fs.readFileSync(path.join(ctx, first.json.path)).equals(bytes), 'byte for byte');
  assert.equal(first.json.sha256, sha(bytes));
  const manifest = JSON.parse(fs.readFileSync(path.join(ctx, '.intake', 'manifest.json'), 'utf8'));
  assert.equal(manifest.runs[0].stage, 'discovery');
  assert.equal(manifest.runs[0].source, 'prompt');

  const source = path.join(SCRATCH, 'held.txt');
  fs.writeFileSync(source, 'from a file');
  const second = intake(repo, ['--action', 'file-prompt', '--file', source, '--json']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.json.path, /-02\.md$/);
  assert.equal(fs.readFileSync(path.join(ctx, second.json.path), 'utf8'), 'from a file');
  assert.match(intake(repo, ['--action', 'file-prompt', '--file', source]).stdout, /^filed prompt\/prompt-.*-03\.md \(11 bytes, sha256:/);
});

test('file-prompt refuses binary, non-UTF-8, oversized and non-regular input with exit 2 and files nothing; a plain text path stays accepted', () => {
  const { repo, ctx } = makeRepo();
  const dir = path.join(SCRATCH, `inputs-${repoCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name: string, data: any): string => { const file = path.join(dir, name); fs.writeFileSync(file, data); return file; };
  const nul = write('nul.md', Buffer.from('looks fine\0but is not'));
  const latin = write('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  const big = write('big.txt', Buffer.alloc(262145, 0x61));
  const edge = write('edge.txt', Buffer.alloc(262144, 0x61));
  const refuse = (args: string[], input: any, pattern: RegExp): void => {
    const r = intake(repo, ['--action', 'file-prompt', ...args], input);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, pattern);
  };
  refuse(['--file', nul], '', /not plain text/);
  refuse(['--file', latin], '', /not plain text/);
  refuse(['--stdin'], Buffer.from([0x68, 0x00, 0x69]), /stdin is not plain text/);
  refuse(['--stdin'], Buffer.from([0xff, 0xfe, 0x41]), /stdin is not plain text/);
  refuse(['--file', big], '', /is 262145 bytes; file-prompt takes at most 262144/);
  refuse(['--stdin'], Buffer.alloc(262145, 0x61), /stdin is 262145 bytes/);
  refuse(['--file', dir], '', /not a regular file/);
  if (process.platform !== 'win32') {
    const fifo = path.join(dir, 'pipe');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const viaLink = path.join(dir, 'pipe-link');
    fs.symlinkSync(fifo, viaLink);
    refuse(['--file', fifo], '', /not a regular file/);
    refuse(['--file', viaLink], '', /not a regular file/);
  }
  assert.ok(!fs.existsSync(ctx), 'nothing was filed');
  const ok = intake(repo, ['--action', 'file-prompt', '--file', edge, '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const link = path.join(dir, 'text-link.txt');
  fs.symlinkSync(write('plain.txt', 'ordinary text'), link);
  assert.equal(intake(repo, ['--action', 'file-prompt', '--file', link, '--json']).status, 0, 'a link to a regular text file is read');
});

test('exit 2: no action, an unknown action, no input, empty input, both inputs, an unreadable file, no active feature', () => {
  const { repo, ctx } = makeRepo();
  const noAction = intake(repo, []);
  assert.equal(noAction.status, 2);
  assert.match(noAction.stderr, /unknown --action 'status'. Valid: sort, preview, undo, list, file-prompt/);
  assert.equal(intake(repo, ['--action', 'shred']).status, 2);
  assert.match(intake(repo, ['--action', 'file-prompt']).stderr, /needs the text from --stdin or --file/);
  assert.match(intake(repo, ['--action', 'file-prompt', '--stdin'], '').stderr, /input is empty/);
  assert.match(intake(repo, ['--action', 'file-prompt', '--stdin', '--file', 'x'], 'x').stderr, /cannot be combined/);
  assert.match(intake(repo, ['--action', 'file-prompt', '--file', path.join(SCRATCH, 'missing.txt')]).stderr, /cannot read --file/);
  assert.equal(intake(repo, ['--action', 'undo', '--run-id', 'run-nope']).status, 0, 'no context folder: absent is a success, whatever the run id');
  put(ctx, { 'prd.md': 'a' });
  assert.equal(intake(repo, ['--action', 'sort']).status, 0);
  assert.match(intake(repo, ['--action', 'undo', '--run-id', 'run-nope']).stderr, /no run 'run-nope'/);

  const json = intake(repo, ['--action', 'shred', '--json']);
  assert.equal(json.status, 2);
  assert.deepEqual([json.json.ok, json.json.status, json.json.exitCode], [false, 'USAGE', 2]);

  const none = makeRepo({ branch: 'main', feature: false });
  assert.equal(intake(none.repo, ['--action', 'sort']).status, 2, 'no active feature');
  assert.ok(!fs.existsSync(path.join(none.repo, 'agent-docs')), 'nothing is created without a feature');
});

test('exit 2: an unknown --slug is the same usage error for every action, and nothing is created', () => {
  const { repo, feature } = makeRepo();
  const messages = new Set<string>();
  for (const action of ['sort', 'preview', 'list', 'undo', 'file-prompt']) {
    const run = intake(repo, ['--action', action, '--slug', 'no-such-feature', ...(action === 'file-prompt' ? ['--stdin'] : [])], 'x');
    assert.equal(run.status, 2, `${action}: ${run.stdout}${run.stderr}`);
    messages.add(run.stderr.replace(/\s+/g, ' ').trim());
  }
  assert.equal(messages.size, 1, [...messages].join(' | '));
  assert.ok(!fs.existsSync(path.join(repo, 'agent-docs', 'doflow', 'no-such-feature')));
  assert.ok(!fs.existsSync(path.join(feature, 'additional-context')));
});

test('exit 2: a manifest from a newer schema is refused and left as it was', () => {
  const { repo, ctx } = makeRepo();
  put(ctx, { 'prd.md': 'a' });
  fs.mkdirSync(path.join(ctx, '.intake'));
  const future = JSON.stringify({ schema: 2, runs: [] });
  fs.writeFileSync(path.join(ctx, '.intake', 'manifest.json'), future);
  for (const action of ['sort', 'undo']) {
    const run = intake(repo, ['--action', action]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /schema 2/);
  }
  assert.equal(fs.readFileSync(path.join(ctx, '.intake', 'manifest.json'), 'utf8'), future);
  assert.ok(fs.existsSync(path.join(ctx, 'prd.md')));
});

test('exit 2: a manifest lock that never frees, and the other writer\'s lock survives', { timeout: 30000 }, () => {
  const { repo, ctx } = makeRepo();
  put(ctx, { 'prd.md': 'a' });
  const lock = path.join(ctx, '.intake', 'manifest.json.lock');
  fs.mkdirSync(lock, { recursive: true });
  const run = intake(repo, ['--action', 'sort']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Could not lock/);
  assert.ok(fs.existsSync(lock));
  assert.ok(fs.existsSync(path.join(ctx, 'prd.md')), 'nothing moved');
  fs.rmSync(lock, { recursive: true });
});

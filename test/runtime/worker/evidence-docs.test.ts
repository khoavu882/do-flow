'use strict';

// 170 IC-008: `worker --action evidence --docs-root` records doc checks, and checksEstablish counts a key with parts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../helper/tmp.ts');
const { executeWorkerCommand, FLAG_ACTIONS } = require('../../../src/runtime/worker/command.ts');
const { checksEstablish } = require('../../helper/worker-evidence.ts');

const FAKE_CLI: any = { skip: process.platform === 'win32' && 'the fake CLI is a POSIX shell script spawned without a shell' };
const NOW: any = new Date('2026-11-17T12:00:00.000Z');
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIB = 1024 * 1024;
const RPC_DOC = '# RPC\n\nRPC mode keeps stdin open.\nClose the stdin to end.\n';

function registry() {
  return { harnesses: [{ id: 'codex', worker: { cli: { status: 'supported', binary: 'codex', versionArgv: ['--version'] } } }], coverage: {} };
}

function project(t: any) {
  const dir = fs.realpathSync(tempDir(t, 'doflow-worker-evidence-docs-'));
  const bin = path.join(dir, 'bin');
  const docs = path.join(dir, 'docs-root');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(docs, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
if [ -n "$FAKE_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_LOG"; fi
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.163.0'; exit 0; fi
if [ "$1" = "check" ]; then printf '%s\\n' 'Usage: codex exec [OPTIONS] [PROMPT]'; exit 0; fi
exit 3
`, { mode: 0o755 });
  fs.writeFileSync(path.join(docs, 'rpc.md'), RPC_DOC);
  fs.writeFileSync(path.join(docs, 'sub', 'turn.md'), 'agent_start begins\nagent_settled ends\n');
  return {
    dir, docs,
    checks: path.join(dir, 'checks.json'),
    out: path.join(dir, 'evidence.json'),
    log: path.join(dir, 'fake.log'),
    env: { ...process.env, PATH: bin, FAKE_LOG: path.join(dir, 'fake.log') },
  };
}

function writeChecks(p: any, checks: any[]) {
  fs.writeFileSync(p.checks, JSON.stringify({
    schema: 'doflow-worker-checks-v1', harness: 'codex', binary: 'codex',
    version: { argv: ['--version'], expect: '^codex-cli \\d+\\.\\d+\\.\\d+' },
    checks,
  }, null, 2));
}

const docCheck = (doc: string, over: any = {}) => ({ id: 'rpc-doc', doc, expect: ['^Close the stdin to end\\.$'], establishes: ['oneShot'], ...over });

const run = (p: any, flags: any = {}) => executeWorkerCommand({
  action: 'evidence', harness: 'codex', out: p.out, checks: p.checks, docsRoot: p.docs,
  env: p.env, cwd: p.dir, registry: registry(), now: () => NOW, ...flags,
});

const calls = (p: any) => (fs.existsSync(p.log) ? fs.readFileSync(p.log, 'utf8').split('\n').filter(Boolean) : []);

test('a doc check passes and records doc, sha256 and matched lines with no exit and no absolute path', FAKE_CLI, async (t) => {
  const p = project(t);
  writeChecks(p, [docCheck('rpc.md'), docCheck('sub/turn.md', { id: 'turn-doc', expect: ['^agent_start', '^agent_settled'], establishes: ['structuredOutput'] })]);
  const result = await run(p);
  assert.equal(result.exit, 0, JSON.stringify(result.body));
  const text = fs.readFileSync(p.out, 'utf8');
  const record = JSON.parse(text);
  assert.deepEqual(record.establishes, ['oneShot', 'structuredOutput']);
  assert.deepEqual(record.checks[0], {
    doc: 'rpc.md', establishes: ['oneShot'], expect: ['^Close the stdin to end\\.$'], id: 'rpc-doc',
    matched: ['Close the stdin to end.'], result: 'pass',
    sha256: crypto.createHash('sha256').update(RPC_DOC).digest('hex'),
  });
  assert.equal(record.checks[1].result, 'pass');
  assert.equal(record.checks[1].matched.length, 2);
  assert.equal('exit' in record.checks[0], false, 'a doc check has no exit');
  assert.equal(text.includes(p.docs), false, 'the written record holds no docs root path');
  assert.equal(text.includes(p.dir), false, 'the written record holds no absolute path at all');
});

test('a doc check whose expect matches nothing fails and establishes nothing', FAKE_CLI, async (t) => {
  const p = project(t);
  writeChecks(p, [docCheck('rpc.md', { expect: ['^nothing like this$'] })]);
  const result = await run(p);
  assert.equal(result.exit, 0);
  const record = JSON.parse(fs.readFileSync(p.out, 'utf8'));
  assert.equal(record.checks[0].result, 'fail');
  assert.deepEqual(record.establishes, []);
});

test('a doc of exactly 1 MiB is read; 1 MiB + 1 is refused', FAKE_CLI, async (t) => {
  const p = project(t);
  const line = 'Close the stdin to end.\n';
  fs.writeFileSync(path.join(p.docs, 'edge.md'), line + 'x'.repeat(MIB - line.length));
  fs.writeFileSync(path.join(p.docs, 'big.md'), line + 'x'.repeat(MIB - line.length + 1));
  writeChecks(p, [docCheck('edge.md')]);
  assert.equal((await run(p)).exit, 0);
  fs.rmSync(p.out);
  writeChecks(p, [docCheck('big.md')]);
  const refused = await run(p);
  assert.equal(refused.exit, 1);
  assert.match(refused.body.reason, /doc-too-large/);
  assert.equal(fs.existsSync(p.out), false);
});

test('a doc path that escapes, is absolute, is not a plain file or leaves through a symlink is refused before the binary runs', FAKE_CLI, async (t) => {
  const p = project(t);
  const outside = path.join(p.dir, 'outside.md');
  fs.writeFileSync(outside, 'Close the stdin to end.\n');
  fs.symlinkSync(outside, path.join(p.docs, 'link.md'));
  fs.symlinkSync(p.dir, path.join(p.docs, 'linkdir'));
  const cases: Array<[string, RegExp, number]> = [
    ['../outside.md', /doc must be a relative path/, 2],
    ['sub/../rpc.md', /doc must be a relative path/, 2],
    [outside, /doc must be a relative path/, 2],
    ['link.md', /doc-outside-root/, 1],
    ['linkdir/outside.md', /doc-outside-root/, 1],
    ['sub', /doc-not-file/, 1],
    ['missing.md', /doc-unreadable/, 1],
  ];
  for (const [doc, reason, exit] of cases) {
    writeChecks(p, [docCheck(doc)]);
    const result = await run(p);
    assert.equal(result.exit, exit, `${doc}: ${JSON.stringify(result.body)}`);
    assert.match(`${result.body.reason} ${result.body.message}`, reason, doc);
    assert.equal(fs.existsSync(p.out), false, `${doc}: no record written`);
  }
  assert.deepEqual(calls(p), [], 'a doc refusal never runs the harness binary');
});

test('a check carries exactly one of argv or doc', FAKE_CLI, async (t) => {
  const p = project(t);
  writeChecks(p, [docCheck('rpc.md', { argv: ['check', '--help'] })]);
  assert.equal((await run(p)).exit, 2);
  writeChecks(p, [{ id: 'none', expect: ['x'], establishes: ['oneShot'] }]);
  assert.equal((await run(p)).exit, 2);
});

test('doc checks without --docs-root are a usage refusal naming the flag', FAKE_CLI, async (t) => {
  const p = project(t);
  writeChecks(p, [docCheck('rpc.md')]);
  const result = await run(p, { docsRoot: undefined });
  assert.equal(result.exit, 2);
  assert.match(result.body.message, /--docs-root/);
  assert.equal(fs.existsSync(p.out), false);
  assert.deepEqual(calls(p), []);
});

test('--docs-root on any other action, or with --worker-run, is a usage refusal', async (t) => {
  const p = project(t);
  assert.deepEqual(FLAG_ACTIONS.docsRoot, { flag: '--docs-root', actions: ['evidence'] });
  for (const action of ['discover', 'probe', 'describe', 'select', 'run', 'status', 'cancel', 'start-session', 'start-options', 'conform', 'login-state']) {
    const result = await executeWorkerCommand({ action, docsRoot: p.docs, env: p.env, cwd: p.dir, registry: registry() });
    assert.equal(result.exit, 2, action);
    assert.match(result.body.message, /--docs-root does not apply to --action/, action);
  }
  const mixed = await executeWorkerCommand({ action: 'evidence', harness: 'codex', out: p.out, workerRun: 'w-0123456789ab', docsRoot: p.docs, env: p.env, cwd: p.dir, registry: registry() });
  assert.equal(mixed.exit, 2);
  assert.match(mixed.body.message, /--docs-root applies only with --checks/);
});

test('a docs root that is not a directory is a usage refusal', FAKE_CLI, async (t) => {
  const p = project(t);
  writeChecks(p, [docCheck('rpc.md')]);
  const result = await run(p, { docsRoot: path.join(p.docs, 'rpc.md') });
  assert.equal(result.exit, 2);
  assert.match(result.body.message, /--docs-root/);
});

// ── checksEstablish: part tokens ────────────────────────────────────────────────────────────────

const SHA = 'a'.repeat(64);
const PARTS = ['argv', 'messages', 'turn', 'close', 'answer'];

/** A scratch repo root holding a Pi-shaped checks.json: one doc check per part token. */
function partsRepo(t: any) {
  const root = tempDir(t, 'doflow-parts-repo-');
  const spec = {
    schema: 'doflow-worker-checks-v1', harness: 'pi', binary: 'pi', version: { argv: ['--version'], expect: '^\\d' },
    checks: PARTS.map((part) => ({ id: `doc-${part}`, doc: `docs/${part}.md`, expect: [`^${part}$`], establishes: [`controlChannel:${part}`] })),
  };
  fs.mkdirSync(path.join(root, 'core', 'worker-evidence', 'pi'), { recursive: true });
  fs.writeFileSync(path.join(root, 'core', 'worker-evidence', 'pi', 'checks.json'), JSON.stringify(spec));
  const record = (omit: string[] = [], over: any = {}) => ({
    checks: spec.checks.filter((c: any) => !omit.includes(c.id)).map((c: any) => ({
      id: c.id, doc: c.doc, sha256: SHA, expect: c.expect, establishes: c.establishes, matched: [c.expect[0].slice(1, -1)], result: 'pass', ...over,
    })),
  });
  return { root, record };
}

test('checksEstablish counts controlChannel only when every required part is established', (t) => {
  const { root, record } = partsRepo(t);
  const answerEntry = { status: 'supported', answer: { id: ['id'] } };
  assert.equal(checksEstablish(record(), 'pi', 'controlChannel', root, answerEntry), true, 'all five parts with an answer entry');
  for (const part of PARTS) {
    assert.equal(checksEstablish(record([`doc-${part}`]), 'pi', 'controlChannel', root, answerEntry), false, `missing ${part}`);
  }
  assert.equal(checksEstablish(record(['doc-answer']), 'pi', 'controlChannel', root, { status: 'supported' }), true, 'four parts suffice without answer');
  assert.equal(checksEstablish(record(['doc-answer']), 'pi', 'controlChannel', root), true, 'no entry given: four parts');
  assert.equal(checksEstablish(record(['doc-turn']), 'pi', 'controlChannel', root, { status: 'supported' }), false);
});

test('checksEstablish rejects a doc check that did not pass, has no matched line, has no sha256, or no longer equals its entry', (t) => {
  const { root, record } = partsRepo(t);
  assert.equal(checksEstablish(record([], { result: 'fail' }), 'pi', 'controlChannel', root), false);
  assert.equal(checksEstablish(record([], { matched: [] }), 'pi', 'controlChannel', root), false);
  assert.equal(checksEstablish(record([], { sha256: 'abc' }), 'pi', 'controlChannel', root), false);
  const edited = record();
  edited.checks[0].doc = 'docs/other.md';
  assert.equal(checksEstablish(edited, 'pi', 'controlChannel', root), false, 'doc differs from the entry');
  const withArgv = record();
  withArgv.checks[0].argv = ['--help'];
  assert.equal(checksEstablish(withArgv, 'pi', 'controlChannel', root), false, 'an argv on a doc entry');
});

test('checksEstablish keeps its argv rules: exit 0 is still required, and a plain key is unchanged', (t) => {
  const root = tempDir(t, 'doflow-plain-repo-');
  const spec = { schema: 'x', checks: [{ id: 'a', argv: ['--help'], expect: ['x'], establishes: ['oneShot'] }] };
  fs.mkdirSync(path.join(root, 'core', 'worker-evidence', 'pi'), { recursive: true });
  fs.writeFileSync(path.join(root, 'core', 'worker-evidence', 'pi', 'checks.json'), JSON.stringify(spec));
  const rec = (exit: number) => ({ checks: [{ id: 'a', argv: ['--help'], exit, expect: ['x'], establishes: ['oneShot'], matched: ['x'], result: 'pass' }] });
  assert.equal(checksEstablish(rec(0), 'pi', 'oneShot', root), true);
  assert.equal(checksEstablish(rec(1), 'pi', 'oneShot', root), false);
});

test('the Pi checks file names only controlChannel part tokens and covers every part', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'worker-evidence', 'pi', 'checks.json'), 'utf8'));
  const docs = spec.checks.filter((c: any) => c.doc);
  assert.ok(docs.length >= 10);
  for (const check of spec.checks.filter((c: any) => c.establishes.some((k: string) => k.startsWith('controlChannel:')))) {
    assert.ok(check.establishes.every((k: string) => /^controlChannel:(argv|messages|turn|close|answer)$/.test(k)), check.id);
  }
  const have = new Set(spec.checks.flatMap((c: any) => c.establishes));
  for (const part of PARTS) assert.ok(have.has(`controlChannel:${part}`), part);
});

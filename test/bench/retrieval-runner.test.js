'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('../../bench/retrieval/runner.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CREDENTIALS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN'];

function verbsDir(t, verbs) {
  const dir = tempDir(t, 'doflow-runner-verbs-');
  for (const [name, body] of Object.entries(verbs)) fs.writeFileSync(path.join(dir, `${name}.ts`), `'use strict';\n${body}\n`);
  return dir;
}

function capture() {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (m) => lines.out.push(m), err: (m) => lines.err.push(m) } };
}

test('exit codes resolve in the order 2, 3, 4, 1', () => {
  const r = runner.resolveExitCode;
  assert.equal(r([]), 0);
  assert.equal(r([0]), 0);
  assert.equal(r([1]), 1);
  assert.equal(r([1, 4]), 4);
  assert.equal(r([4, 3, 1]), 3);
  assert.equal(r([1, 2, 3, 4]), 2);
});

test('an unknown verb, a missing verb and an unknown flag exit 2 and name the culprit', (t) => {
  const dir = verbsDir(t, { verify: 'exports.flags = { config: "value" }; exports.run = () => 0;' });
  for (const [args, pattern] of [
    [['bogus'], /unknown verb "bogus"/],
    [[], /usage: retrieval/],
    [['--json'], /usage: retrieval/],
    [['verify', '--nope'], /unknown flag --nope/],
    [['verify', '--config'], /--config needs a value/],
    [['verify', 'stray'], /unexpected argument "stray"/],
    [['verify', '--json=1'], /--json takes no value/],
  ]) {
    const { lines, io } = capture();
    assert.equal(runner.main(args, { verbsDir: dir, ...io }), 2, args.join(' '));
    assert.match(lines.err.join('\n'), pattern);
  }
  // The six DEC-001 names are the only ones discovered, even if another file sits in the directory.
  const extra = verbsDir(t, { verify: 'exports.run = () => 0;', 'holdout-preconditions': 'exports.run = () => 0;', other: 'exports.run = () => 0;' });
  assert.deepEqual(runner.availableVerbs(extra), ['verify']);
  assert.deepEqual(runner.availableVerbs(path.join(extra, 'missing')), []);
});

test('the verb receives parsed flags and the JSON object starts with verb, ok, exitCode, snapshotId', (t) => {
  const dir = verbsDir(t, {
    run: `exports.flags = { config: 'value', 'delete-plaintext': 'bool' };
exports.run = (ctx) => ({ exitCode: 0, seen: { config: ctx.args.config, del: ctx.args['delete-plaintext'], keep: ctx.keepTmp, json: ctx.json }, lines: ['human text'] });`,
  });
  const snap = path.join(tempDir(t, 'doflow-runner-snap-'), 'snapshot.json');
  fs.writeFileSync(snap, JSON.stringify({ snapshotId: 7 }));
  const { lines, io } = capture();
  assert.equal(runner.main(['run', '--config=A,B', '--delete-plaintext', '--keep-tmp', '--json', '--snapshot', snap], { verbsDir: dir, ...io }), 0);
  const obj = JSON.parse(lines.out.join(''));
  assert.deepEqual(Object.keys(obj).slice(0, 4), ['verb', 'ok', 'exitCode', 'snapshotId']);
  assert.deepEqual(obj, { verb: 'run', ok: true, exitCode: 0, snapshotId: '7', seen: { config: 'A,B', del: true, keep: true, json: true } });
  assert.deepEqual(lines.err, ['human text'], 'with --json human text goes to stderr');
  const human = capture();
  runner.main(['run', '--snapshot', snap], { verbsDir: dir, ...human.io });
  assert.deepEqual(human.lines.out, ['human text']);
});

test('several applicable codes resolve by priority and a nonzero result sets ok false', (t) => {
  const dir = verbsDir(t, { verify: 'exports.run = () => ({ exitCode: 1, codes: [4, 3] });', seal: 'exports.run = () => 1;' });
  const { lines, io } = capture();
  assert.equal(runner.main(['verify', '--json'], { verbsDir: dir, ...io }), 3);
  assert.equal(JSON.parse(lines.out[0]).ok, false);
  assert.equal(runner.main(['seal'], { verbsDir: dir, ...capture().io }), 1);
});

test('a verb that throws exits 2, or the error\'s own exit code, with the message on stderr', (t) => {
  const dir = verbsDir(t, {
    verify: 'exports.run = () => { throw new Error("boom"); };',
    seal: 'exports.run = () => { const e = new Error("sealed"); e.exitCode = 3; throw e; };',
  });
  const a = capture();
  assert.equal(runner.main(['verify', '--json'], { verbsDir: dir, ...a.io }), 2);
  assert.match(a.lines.err[0], /retrieval verify: boom/);
  assert.equal(JSON.parse(a.lines.out[0]).error, 'boom');
  assert.equal(runner.main(['seal'], { verbsDir: dir, ...capture().io }), 3);
});

test('the export directory is deleted on exit unless --keep-tmp, and a directory that already existed is never deleted', (t) => {
  const dir = verbsDir(t, { verify: 'exports.run = (ctx) => { require("node:fs").mkdirSync(ctx.tmp, { recursive: true }); return 0; };' });
  const base = tempDir(t, 'doflow-runner-tmp-');
  const fresh = path.join(base, 'fresh');
  runner.main(['verify', '--tmp', fresh], { verbsDir: dir, ...capture().io });
  assert.equal(fs.existsSync(fresh), false);
  const kept = path.join(base, 'kept');
  runner.main(['verify', '--tmp', kept, '--keep-tmp'], { verbsDir: dir, ...capture().io });
  assert.equal(fs.existsSync(kept), true);
  runner.main(['verify', '--tmp', base], { verbsDir: dir, ...capture().io });
  assert.equal(fs.existsSync(base), true, 'a user-supplied directory that existed before the run is left alone');
});

test('childEnv drops credential-looking names without reading their values', () => {
  const reads = [];
  const real = process.env;
  const seeded = { ...real, ANTHROPIC_API_KEY: 'sentinel', MY_SECRET: 'sentinel', KEEP_ME: 'ok' };
  process.env = new Proxy(seeded, { get: (target, prop) => { reads.push(String(prop)); return target[prop]; } });
  try {
    const env = runner.childEnv({ EXTRA: '1' });
    assert.equal(env.KEEP_ME, 'ok');
    assert.equal(env.EXTRA, '1');
    assert.ok(!('ANTHROPIC_API_KEY' in env) && !('MY_SECRET' in env));
    assert.ok(!reads.includes('ANTHROPIC_API_KEY') && !reads.includes('MY_SECRET'), `credential read: ${reads}`);
  } finally {
    process.env = real;
  }
});

test('offline: running a verb reads no credential variable', (t) => {
  const dir = verbsDir(t, { verify: 'exports.run = () => 0;' });
  const reads = [];
  const real = process.env;
  const seeded = { ...real };
  for (const name of CREDENTIALS) seeded[name] = 'sentinel-do-not-read';
  process.env = new Proxy(seeded, { get: (target, prop) => { reads.push(String(prop)); return target[prop]; } });
  try {
    assert.equal(runner.main(['verify', '--json'], { verbsDir: dir, ...capture().io }), 0);
  } finally {
    process.env = real;
  }
  assert.deepEqual(reads.filter((r) => CREDENTIALS.includes(r)), []);
});

test('offline: no benchmark source opens a socket, makes an HTTP call or names a credential variable', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['results', 'holdout', 'fixtures', 'tasks'].includes(e.name)) walk(full); } else if (e.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(path.join(REPO, 'bench', 'retrieval'));
  assert.ok(files.length > 3);
  const banned = [
    /require\(['"](?:node:)?(?:net|http|https|http2|dgram|tls|dns)['"]\)/,
    /\bfetch\(/,
    /ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY/,
    /\b(?:claude|codex|gemini)\b.*spawn|spawn\w*\(['"](?:claude|codex|gemini|agy)['"]/,
  ];
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of banned) if (re.test(text)) hits.push(`${path.relative(REPO, file)} ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('bench/runner.ts forwards retrieval before its own argument parser', () => {
  const run = spawnSync(process.execPath, [path.join(REPO, 'bench', 'runner.ts'), 'retrieval', 'bogus-verb'], {
    encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'sentinel', OPENAI_API_KEY: 'sentinel' },
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown verb "bogus-verb"/);
  const flag = spawnSync(process.execPath, [path.join(REPO, 'bench', 'runner.ts'), 'retrieval', 'bogus', '--not-a-bench-flag'], { encoding: 'utf8' });
  assert.equal(flag.status, 2, 'a retrieval flag the skill benchmark does not know reaches the retrieval runner');
  assert.match(flag.stderr, /retrieval/);
  const usage = spawnSync(process.execPath, [path.join(REPO, 'bench', 'runner.ts'), '--help'], { encoding: 'utf8' });
  assert.match(usage.stdout, /bench\/runner\.ts retrieval <verb>/);
  assert.match(usage.stdout, /bench\/runner\.ts perf <verb>/);
});

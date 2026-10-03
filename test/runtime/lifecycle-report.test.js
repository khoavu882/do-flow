'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo } = require('../helper/lifecycle-git-fixtures');
const store = require('../../src/runtime/lifecycle/event-store');
const { reportFollowup, listFollowups, FollowupUsageError } = require('../../src/runtime/lifecycle/followup');
const reportStore = require('../../src/runtime/lifecycle/report-store');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const scratch = createScratch('doflow-report-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

// Fake values shaped like real ones; none is a credential.
const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'k1L2m3N4o5P6q7R8s9T0'}`;
const MiB = 1024 * 1024;

let counter = 0;
function newRepo() {
  const repo = makeRepo(scratch, `report-${(counter += 1)}`);
  repo.dir = fs.realpathSync(repo.dir);
  return repo;
}
const eventFiles = (repo) => { try { return fs.readdirSync(path.join(repo.dir, store.EVENTS_REL)).sort(); } catch { return []; } };
const readEvent = (repo, rel) => JSON.parse(fs.readFileSync(path.join(repo.dir, rel), 'utf8'));
const keyOf = (repo) => crypto.createHash('sha256').update(fs.realpathSync(repo.dir)).digest('hex').slice(0, 12);
const bodyFile = (repo, id) => path.join(scratch.xdg, 'doflow', 'reports', keyOf(repo), `${id}.txt`);
const report = (repo, options) => reportFollowup({ root: repo.dir, statement: 'Checkout crashes when the cart holds a removed product', ...options });

function run(cwd, args, { input, env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env || scratch.env(), encoding: 'utf8', input });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// ── the event and the body ─────────────────────────────────────────────────────────────────────

test('a report keeps the body on this machine and puts only a reference, the size and a masked excerpt in the event', () => {
  const repo = newRepo();
  const lateMarker = 'LATE-LINE-NOT-IN-THE-EVENT';
  const body = `TypeError: Cannot read properties of null (reading 'price')\n    at cartTotal (cart.js:88)\n    token=hunter2hunter2\n${'    at frame (x.js:1)\n'.repeat(400)}${lateMarker}\n`;
  const out = report(repo, { input: { text: body }, release: 'v2.3.0', feature: '049-cart-fix' });
  assert.equal(out.ok, true);
  const [created] = out.created;
  assert.match(created.id, /^FU-[0-9a-hjkmnp-tv-z]{6}$/);
  assert.deepEqual(created.source, { kind: 'report', release: 'v2.3.0', feature: '049-cart-fix' });
  assert.deepEqual([created.state, created.body], ['open', 'on-this-machine']);
  assert.ok(created.masked >= 1);
  assert.match(out.next[0], /Settle it now or at \/do maintain/);

  const event = readEvent(repo, out.events[0]);
  assert.equal(event.type, 'followup.added');
  assert.equal(event.by, 'agent');
  assert.deepEqual(Object.keys(event.data).sort(), ['bodyBytes', 'bodyRef', 'excerpt', 'id', 'source', 'statement']);
  assert.equal(event.data.bodyRef, `local:${created.id}`);
  assert.ok(Buffer.byteLength(event.data.excerpt) <= 2048);
  assert.match(event.data.excerpt, /^TypeError: Cannot read properties of null/);
  assert.match(event.data.excerpt, /token=<masked>/);
  assert.equal(JSON.stringify(event).includes(lateMarker), false, 'the late part of the body is not in the project event');
  assert.equal(JSON.stringify(event).includes('hunter2hunter2'), false);

  const file = bodyFile(repo, created.id);
  const stored = fs.readFileSync(file, 'utf8');
  assert.equal(Buffer.byteLength(stored), event.data.bodyBytes);
  assert.equal(created.bodyBytes, event.data.bodyBytes);
  assert.ok(stored.includes(lateMarker));
  assert.equal(stored.includes('hunter2hunter2'), false, 'the stored body is masked');
  assert.match(stored, /token=<masked>/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal(path.relative(repo.dir, file).startsWith('..'), true, 'never inside the repository');
  assert.equal(repo.git('status', '--porcelain'), '?? agent-docs/', 'only the event store appears in the repository');

  const item = listFollowups({ root: repo.dir }).items[0];
  assert.deepEqual([item.state, item.body, item.source.kind], ['open', 'on-this-machine', 'report']);
  fs.rmSync(file);
  const elsewhere = listFollowups({ root: repo.dir }).items[0];
  assert.deepEqual([elsewhere.body, elsewhere.excerpt === event.data.excerpt], ['not-on-this-machine', true], 'on another machine only the excerpt remains');
});

test('the statement is masked before it is stored and counted in `masked`', () => {
  const repo = newRepo();
  const out = report(repo, { statement: `Deploy failed with ${TOKEN} in the log`, input: { text: 'plain body line' } });
  assert.equal(out.created[0].statement.includes(TOKEN), false);
  assert.match(out.created[0].statement, /<masked>/);
  assert.ok(out.created[0].masked >= 1);
  assert.equal(fs.readFileSync(path.join(repo.dir, out.events[0]), 'utf8').includes(TOKEN), false);
});

test('a body over 1 MiB is masked, then cut at a UTF-8 boundary and ends with the marker line', () => {
  const repo = newRepo();
  const big = `${'a log line with a euro sign € and more text\n'.repeat(80000)}password=hunter2hunter2\n`;
  assert.ok(Buffer.byteLength(big) > 2 * MiB);
  const started = Date.now();
  const out = report(repo, { input: { text: big } });
  assert.ok(Date.now() - started < 20000, 'masking a multi-MiB body stays bounded');
  const stored = fs.readFileSync(bodyFile(repo, out.created[0].id));
  assert.ok(stored.length <= MiB);
  assert.equal(stored.length, out.created[0].bodyBytes);
  const text = stored.toString('utf8');
  assert.equal(text.includes('�'), false, 'no character is split by the cut');
  assert.ok(text.endsWith('\n[truncated by doflow at 1 MiB]'));
  // A body whose cut falls inside a three-byte character.
  const wide = report(repo, { statement: 'wide characters', input: { text: '€'.repeat(MiB) } });
  const wideText = fs.readFileSync(bodyFile(repo, wide.created[0].id), 'utf8');
  assert.equal(wideText.includes('�'), false);
  assert.ok(Buffer.byteLength(wideText) <= MiB && wideText.endsWith('[truncated by doflow at 1 MiB]'));
});

test('the excerpt is the first 2048 bytes, cut at a line end when one lies inside the limit, else at a UTF-8 boundary', () => {
  const lines = reportStore.excerptOf(Buffer.from(`${'0123456789'.repeat(20)}\n`.repeat(20)));
  assert.ok(Buffer.byteLength(lines) <= 2048);
  assert.equal(lines.endsWith('0123456789'), true);
  assert.equal(lines.split('\n').every((line) => line.length === 200), true, 'cut at a line end, not mid-line');
  const noBreak = reportStore.excerptOf(Buffer.from('\u{1F600}'.repeat(1000)));
  assert.ok(Buffer.byteLength(noBreak) <= 2048);
  assert.equal(noBreak.includes('�'), false);
  assert.equal(Buffer.byteLength(noBreak), 2048, 'four-byte characters fit 2048 exactly');
  assert.equal(reportStore.excerptOf(Buffer.from('short\n')), 'short');
});

test('the project key is the first 12 hex characters of the SHA-256 of the root real path', () => {
  const repo = newRepo();
  assert.equal(reportStore.projectKey(repo.dir), keyOf(repo));
  assert.match(reportStore.projectKey(repo.dir), /^[0-9a-f]{12}$/);
  assert.equal(reportStore.bodyPath(repo.dir, 'FU-aaaaaa'), bodyFile(repo, 'FU-aaaaaa'));
});

// ── no home, failures ──────────────────────────────────────────────────────────────────────────

test('with no resolvable home the body is not kept: bodyRef is null and the result says so', () => {
  const repo = newRepo();
  for (const env of [{}, { HOME: 'relative/home' }, { XDG_CONFIG_HOME: 'relative/xdg', HOME: scratch.home }]) {
    const out = reportFollowup({ root: repo.dir, statement: 'no home', input: { text: 'a body that stays on no machine' }, env });
    assert.equal(out.created[0].body, 'not-on-this-machine');
    assert.equal(readEvent(repo, out.events[0]).data.bodyRef, null);
    assert.match(out.next.join('\n'), /body was not kept/);
  }
  assert.equal(fs.existsSync(path.dirname(bodyFile(repo, 'FU-aaaaaa'))), false, 'no body folder for this project');
});

test('when the event cannot be written the body file is removed again', () => {
  const repo = newRepo();
  const failing = Object.assign(Object.create(fs), {
    writeFileSync(target, ...rest) {
      if (String(target).includes(`${path.sep}events${path.sep}`)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.writeFileSync(target, ...rest);
    },
  });
  assert.throws(() => report(repo, { input: { text: 'body' }, fsImpl: failing }), /disk full/);
  const dir = path.join(scratch.xdg, 'doflow', 'reports', keyOf(repo));
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  assert.deepEqual(eventFiles(repo), []);
});

// ── input and hygiene ──────────────────────────────────────────────────────────────────────────

test('exactly one body source is required; a missing, binary or non-regular file is refused; nothing is written', () => {
  const repo = newRepo();
  const bin = path.join(scratch.dir, 'blob.bin');
  fs.writeFileSync(bin, Buffer.from([0x48, 0x00, 0x49]));
  for (const input of [{}, { text: 'a', stdin: true }, { file: bin, text: 'a' }, { file: path.join(scratch.dir, 'absent.log') }, { file: bin }, { file: scratch.dir }]) {
    assert.throws(() => report(repo, { input }), FollowupUsageError, JSON.stringify(input));
  }
  assert.deepEqual(eventFiles(repo), []);
  assert.equal(fs.existsSync(path.join(repo.dir, 'agent-docs')), false);
  assert.equal(fs.existsSync(path.dirname(bodyFile(repo, 'FU-aaaaaa'))), false, 'no body folder for this project');
});

test('statement and excerpt hygiene: control and bidirectional characters are refused naming the field', () => {
  const repo = newRepo();
  assert.throws(() => report(repo, { statement: 'safe‮text', input: { text: 'body' } }), /--statement.*control or bidirectional/);
  assert.throws(() => report(repo, { statement: 'two\nlines', input: { text: 'body' } }), /--statement must be one line/);
  assert.throws(() => report(repo, { statement: 'x'.repeat(300), input: { text: 'body' } }), /--statement/);
  assert.throws(() => report(repo, { statement: ' ', input: { text: 'body' } }), /--statement is empty/);
  assert.throws(() => report(repo, { input: { text: '\u001b[31mred\u001b[0m' } }), /first 2 KB.*control/);
  assert.throws(() => report(repo, { input: { text: 'ok⁦hidden⁩' } }), /first 2 KB.*control/);
  assert.throws(() => report(repo, { input: { text: '   \n' } }), /body is empty/);
  assert.throws(() => report(repo, { input: { text: 'b' }, release: '--x' }), /--release/);
  assert.throws(() => report(repo, { input: { text: 'b' }, feature: ['../x'] }), FollowupUsageError);
  assert.throws(() => report(repo, { input: { text: 'b' }, feature: ['a', 'b'] }), /one feature slug/);
  assert.deepEqual(eventFiles(repo), []);
  assert.equal(fs.existsSync(path.dirname(bodyFile(repo, 'FU-aaaaaa'))), false, 'no body folder for this project');
});

test('a tab and a line break are fine in the body and its excerpt', () => {
  const repo = newRepo();
  const out = report(repo, { input: { text: 'col1\tcol2\r\nsecond line\n' } });
  assert.equal(readEvent(repo, out.events[0]).data.excerpt, 'col1\tcol2\r\nsecond line');
});

// ── the verb ───────────────────────────────────────────────────────────────────────────────────

test('the verb: --file, --stdin and --text (with the = form for a leading dash), and the list shows the body here', () => {
  const repo = newRepo();
  const log = path.join(scratch.dir, 'crash.log');
  fs.writeFileSync(log, `TypeError: x is null\n    at f (a.js:1)\napi_key=abcdef123456\n`);
  const viaFile = run(repo.dir, ['followup', '--action', 'report', '--statement', 'crash from a file', '--file', log, '--release', 'v2.3.0', '--feature', '049-cart-fix', '--json']);
  assert.equal(viaFile.status, 0, viaFile.stderr);
  assert.deepEqual(viaFile.json.created[0].source, { kind: 'report', release: 'v2.3.0', feature: '049-cart-fix' });
  assert.equal(viaFile.json.created[0].masked, 1);
  const viaStdin = run(repo.dir, ['followup', '--action', 'report', '--statement', 'crash from stdin', '--stdin', '--json'], { input: '-- starts with a dash\nsecond\n' });
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assert.equal(fs.readFileSync(bodyFile(repo, viaStdin.json.created[0].id), 'utf8'), '-- starts with a dash\nsecond\n');
  const viaText = run(repo.dir, ['followup', '--action', 'report', '--statement', 'crash from text', '--text=-- inline', '--json']);
  assert.equal(viaText.status, 0, viaText.stderr);
  assert.equal(run(repo.dir, ['followup', '--action', 'report', '--statement', 'x', '--text', '-- inline', '--json']).status, 2, 'the space form refuses a value starting with -');

  const listed = run(repo.dir, ['followup', '--action', 'list', '--json']);
  assert.equal(listed.json.count, 3);
  assert.deepEqual(listed.json.items.map((i) => i.body), ['on-this-machine', 'on-this-machine', 'on-this-machine']);
  assert.equal(listed.json.items.every((i) => i.source.kind === 'report'), true);
  const overview = run(repo.dir, ['lifecycle', '--json']);
  assert.equal(overview.json.followups.open, 3);
  assert.equal(overview.json.followups.items.every((i) => i.source.kind === 'report'), true);
  // The scratch home holds the bodies and nothing else was touched.
  assert.equal(fs.readdirSync(path.join(scratch.xdg, 'doflow', 'reports', keyOf(repo))).length, 3);
});

test('the verb: usage errors exit 2 and write nothing; a 17 MiB file reads only its first 16 MiB', () => {
  const repo = newRepo();
  const before = () => fs.existsSync(path.join(repo.dir, 'agent-docs'));
  assert.equal(run(repo.dir, ['followup', '--action', 'report', '--text', 'body', '--json']).status, 2, 'a statement is required');
  assert.equal(run(repo.dir, ['followup', '--action', 'report', '--statement', 'x', '--json']).status, 2, 'a body source is required');
  assert.equal(run(repo.dir, ['followup', '--action', 'report', '--statement', 'x', '--text', 'a', '--stdin', '--json'], { input: 'b' }).status, 2);
  assert.equal(run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', '046-demo', '--statement', 'x', '--file', 'f', '--json']).status, 2, '--file belongs to report');
  assert.equal(run(repo.dir, ['followup', '--action', 'report', '--statement', 'x', '--text', 'body', '-g', '--json']).status, 2);
  assert.equal(before(), false);

  const huge = path.join(scratch.dir, 'huge.log');
  fs.writeFileSync(huge, Buffer.alloc(17 * MiB, 'x\n'));
  const out = run(repo.dir, ['followup', '--action', 'report', '--statement', 'a huge log', '--file', huge, '--json']);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.json.created[0].bodyBytes <= MiB);
  const stored = fs.readFileSync(bodyFile(repo, out.json.created[0].id), 'utf8');
  assert.ok(stored.endsWith('[truncated by doflow at 1 MiB]'));
});

test('an empty XDG_CONFIG_HOME falls back to HOME/.config (the scratch HOME, never the real one)', () => {
  const repo = newRepo();
  assert.equal(run(repo.dir, ['followup', '--action', 'report', '--statement', 'x', '--text', 'body', '--json'], { env: scratch.env({ XDG_CONFIG_HOME: '' }) }).status, 0);
  assert.equal(fs.existsSync(path.join(scratch.home, '.config', 'doflow', 'reports', keyOf(repo))), true, 'HOME/.config is used when XDG_CONFIG_HOME is empty');
});

test('the reports home sits beside the failure home for every environment shape (IC-005 resolves as IC-011 does)', () => {
  const { failureHome } = require('../../src/runtime/failure/home');
  const envs = [{}, { HOME: '/h' }, { HOME: 'rel' }, { XDG_CONFIG_HOME: '/x' }, { XDG_CONFIG_HOME: 'rel', HOME: '/h' }, { XDG_CONFIG_HOME: '', HOME: '/h' }];
  for (const env of envs) {
    const failures = failureHome(env);
    assert.equal(reportStore.reportsHome(env), failures === null ? null : path.join(path.dirname(failures), 'reports'), JSON.stringify(env));
  }
});

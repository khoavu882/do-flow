'use strict';

// Row 170 T4 (design D3, §5.1-§5.3, IC-002, IC-003; owner rulings R-4, R-9, R-10): the channel spool, the channel
// launch and the supervisor's channel branch. Every harness here is the fake channel harness
// (test/helper/fake-channel-harness.ts), run by absolute path through node; no real harness CLI can run. Every process
// group a test starts is ended in its `after`, and the tests that kill a supervisor assert the harness group is gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const spool = require(path.join(SRC, 'worker', 'channel-spool.ts'));

const POSIX: any = { skip: process.platform === 'win32' && 'worker process control and O_NOFOLLOW are not run on win32 (R-10)' };
const RUN = 'w-0123456789ab';
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const at = () => new Date().toISOString();

// ── The spool (IC-003, R-10) ────────────────────────────────────────────────────────────────────

test('spool: a 0700 directory, 0600 files named <ms>-<8 hex>.json, taken oldest first and deleted on take', POSIX, (t: any) => {
  const root = tempDir(t, 'doflow-spool-');
  const dir = spool.createSpool(root, RUN);
  assert.equal(dir, path.join(root, '.doflow', 'state', 'channel-spool', RUN));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.dirname(dir)), 0o700);
  const first = spool.dropMessage(root, RUN, { kind: 'follow-up', requestId: 'rAAAAAAAAAAAAAAAAAAAAA', by: 'console', at: at(), text: 'one' });
  const second = spool.dropMessage(root, RUN, { kind: 'stop', requestId: null, by: 'manual', at: at() });
  assert.match(first.name, /^[0-9]+-[0-9a-f]{8}\.json$/);
  assert.equal(mode(path.join(dir, first.name)), 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((n: string) => n.endsWith('.tmp')), [], 'no temporary file is left');
  assert.deepEqual(spool.waitingNames(root, RUN).length, 2);
  // An older name written later is still taken first: the order is the name's milliseconds, then its hex.
  fs.writeFileSync(path.join(dir, '1-ffffffff.json'), JSON.stringify({ v: 1, kind: 'steer', requestId: null, by: 'console', at: at(), text: 'old' }), { mode: 0o600 });
  const taken = spool.takeMessages(root, RUN);
  const byAge = [first.name, second.name].sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || (a < b ? -1 : 1));
  assert.deepEqual(taken.map((t: any) => t.name), ['1-ffffffff.json', ...byAge], 'oldest name first');
  assert.deepEqual(taken.map((t: any) => [t.ok, t.message.kind]).sort(), [[true, 'follow-up'], [true, 'steer'], [true, 'stop']]);
  assert.equal(taken.find((t: any) => t.message.kind === 'follow-up').message.text, 'one');
  assert.deepEqual(fs.readdirSync(dir), [], 'every taken file is gone');
  assert.deepEqual(spool.takeMessages(root, RUN), []);
  spool.removeSpool(root, RUN);
  assert.equal(fs.existsSync(dir), false);
  spool.removeSpool(root, RUN);
});

test('spool: a symlink, an oversize file, a FIFO and a malformed file are refused and deleted; the link target is untouched', POSIX, (t: any) => {
  const root = tempDir(t, 'doflow-spool-');
  const dir = spool.createSpool(root, RUN);
  const target = path.join(root, 'outside.json');
  fs.writeFileSync(target, JSON.stringify({ v: 1, kind: 'follow-up', requestId: null, by: 'console', at: at(), text: 'from a link' }));
  fs.symlinkSync(target, path.join(dir, '1-00000001.json'));
  fs.writeFileSync(path.join(dir, '2-00000002.json'), 'x'.repeat(spool.FILE_MAX + 1));
  const fifo = spawnSync('mkfifo', [path.join(dir, '3-00000003.json')]);
  fs.writeFileSync(path.join(dir, '4-00000004.json'), '{"v":1,"kind":"bash"}');
  fs.writeFileSync(path.join(dir, 'not-a-message.txt'), 'ignored');
  const taken = spool.takeMessages(root, RUN);
  const expected: any[] = [['1-00000001.json', 'symlink'], ['2-00000002.json', 'too-large'], ['4-00000004.json', 'malformed']];
  if (fifo.status === 0) expected.splice(2, 0, ['3-00000003.json', 'not-a-file']);
  assert.deepEqual(taken.map((t: any) => [t.name, t.ok ? 'taken' : t.reason]), expected);
  assert.deepEqual(fs.readdirSync(dir), ['not-a-message.txt'], 'refused files are deleted, other names are not read');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).text, 'from a link', 'the link target is neither read into the channel nor removed');
});

test('spool: a linked spool directory is refused and removing it removes the link only; drops need an open spool and fit 64 KiB', POSIX, (t: any) => {
  const root = tempDir(t, 'doflow-spool-');
  const store = path.join(root, '.doflow', 'state', 'channel-spool');
  fs.mkdirSync(store, { recursive: true });
  const elsewhere = tempDir(t, 'doflow-spool-elsewhere-');
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'keep');
  fs.symlinkSync(elsewhere, path.join(store, RUN));
  assert.throws(() => spool.takeMessages(root, RUN), { code: 'spool-unsafe' });
  assert.throws(() => spool.dropMessage(root, RUN, { kind: 'stop', requestId: null, by: 'console', at: at() }), { code: 'spool-unsafe' });
  spool.removeSpool(root, RUN);
  assert.equal(fs.existsSync(path.join(store, RUN)), false);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
  assert.throws(() => spool.dropMessage(root, RUN, { kind: 'stop', requestId: null, by: 'console', at: at() }), { code: 'spool-missing' });
  spool.createSpool(root, RUN);
  assert.throws(() => spool.dropMessage(root, RUN, { kind: 'follow-up', requestId: null, by: 'console', at: at(), text: 'x'.repeat(spool.FILE_MAX) }), { code: 'message-too-large' });
  assert.throws(() => spool.dropMessage(root, RUN, { kind: 'bash', requestId: null, by: 'console', at: at() }), { code: 'usage' });
  assert.throws(() => spool.spoolDir(root, '../x'), { code: 'usage' });
});

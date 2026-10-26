'use strict';

// retire-gemini.e2e.test.ts — row 127, end to end through the real CLI (plan.md T-127-B4): the shipped
// registry retires `gemini` into `antigravity`, so a scratch HOME holding a gemini install (the
// synthetic ledger and files of test/helper/retired-ledger.ts, built with the retired adapter's real
// short marker pair) is released by the next install/update/reconcile, `-t gemini` is refused, and a
// rollback hands the released files back byte for byte. Every spawn runs in a scratch HOME.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { buildRetiredLedger, USER_TEXT, USER_HANDLER, USER_KEYS, SHORT_MARKER_START, MARKER_START } = require('../helper/retired-ledger.ts');
const { MARKER_END } = require('../../src/helper/marker-merge.ts');
const { writeLedger, stateRoot } = require('../../src/state/index.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const RETIRED_LINE = (counts: string) => `[RETIRED] gemini → antigravity: ${counts}`;
const REFUSAL = "Target 'gemini' was retired on 2026-10-26; use 'antigravity' (alias agy). Its DoFlow files are released by the next 'doflow install' or 'doflow update' in that scope.";
const DEFERRED = '.gemini/GEMINI.md: handed over on the next run that targets antigravity';

const sha = (bytes: any) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Every file under `dir` mapped to its digest ({} when the directory is absent). */
function digests(dir: string): any {
  if (!fs.existsSync(dir)) return {};
  const walk = (current: string): string[] => fs.readdirSync(current, { withFileTypes: true })
    .flatMap((entry: any) => (entry.isDirectory() ? walk(path.join(current, entry.name)) : [path.join(current, entry.name)]));
  return Object.fromEntries(walk(dir).sort().map((file) => [path.relative(dir, file), sha(fs.readFileSync(file))]));
}

/** A scratch HOME holding a global gemini install; `ledger: false` leaves the state to the first run,
 * `antigravity: false` drops the fixture's antigravity rows so no replacement is installed. */
function cell({ ledger = true, antigravity = true }: any = {}) {
  const scratch = createScratch('doflow-retire-gemini-');
  const home = scratch.home;
  const built = buildRetiredLedger({ root: home, id: 'gemini', scope: 'global' });
  const state = stateRoot({ scope: 'global', homeDir: home });
  if (!antigravity) {
    built.ledger.resources = built.ledger.resources.filter((row: any) => row.harness !== 'antigravity');
    delete built.ledger.targets.antigravity;
  }
  if (ledger) writeLedger(state, built.ledger);
  const run = (args: string[], input = '\n') => {
    const done = spawnSync(process.execPath, [CLI, ...args], { cwd: scratch.dir, env: scratch.env(), input, encoding: 'utf8' });
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, output: `${done.stdout}\n${done.stderr}` };
  };
  const geminiDir = path.join(home, '.gemini');
  return {
    scratch, home, built, state, run, geminiDir,
    ledgerFile: path.join(state, 'ledger.json'),
    ledger: () => JSON.parse(fs.readFileSync(path.join(state, 'ledger.json'), 'utf8')),
    settings: () => JSON.parse(fs.readFileSync(path.join(geminiDir, 'settings.json'), 'utf8')),
    geminiMd: path.join(geminiDir, 'GEMINI.md'),
  };
}

/** What the person's own settings.json content looks like once DoFlow's hook handlers are stripped. */
function assertUserSettingsKept(settings: any) {
  assert.deepEqual(settings.mcpServers, USER_KEYS.mcpServers, 'the person\'s mcpServers entry is kept');
  assert.deepEqual(settings.security, USER_KEYS.security, 'the person\'s other keys are kept');
  assert.deepEqual(settings.hooks, {
    SessionStart: [{ hooks: [USER_HANDLER] }],
    BeforeTool: [{ matcher: '^run_shell_command$', hooks: [USER_HANDLER] }],
  }, 'only the person\'s own handlers remain; a handler list holding only DoFlow\'s is gone');
}

test('(1) install -g -t claude releases the gemini install: scripts and agent deleted, hooks stripped from settings.json, GEMINI.md deferred, then handed to antigravity', () => {
  const c = cell();
  const before = digests(c.geminiDir);
  const original = fs.readFileSync(c.geminiMd, 'utf8');
  assert.equal(original, `${USER_TEXT}\n${SHORT_MARKER_START}\nDoFlow pointer\n${MARKER_END}\n`, 'precondition: the retired adapter\'s short pair');

  // --dry-run: reports the sweep, writes nothing.
  const dry = c.run(['install', '-g', '-f', '--no-backup', '-t', 'claude', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.ok(dry.stdout.includes(RETIRED_LINE('deleted 8, stripped 1, released 1, kept 0')), dry.stdout);
  assert.ok(dry.stdout.includes(`  ${DEFERRED}`), dry.stdout);
  assert.deepEqual(digests(c.geminiDir), before, '--dry-run changes no gemini file');

  const first = c.run(['install', '-g', '-f', '--no-backup', '-t', 'claude']);
  assert.equal(first.status, 0, first.output);
  assert.ok(first.stdout.includes(RETIRED_LINE('deleted 8, stripped 1, released 1, kept 0')), first.stdout);
  assert.ok(first.stdout.includes(`  ${DEFERRED}`), first.stdout);
  assert.ok(!fs.existsSync(path.join(c.geminiDir, 'hooks')), 'the seven hook scripts are deleted');
  assert.ok(!fs.existsSync(path.join(c.geminiDir, 'agents')), 'the agent file is deleted');
  assert.ok(fs.existsSync(c.built.targets.shared), 'a file another harness still claims is released, not deleted');
  assertUserSettingsKept(c.settings());
  assert.equal(fs.readFileSync(c.geminiMd, 'utf8'), original, 'antigravity is installed, so the global GEMINI.md row is deferred and untouched');
  assert.deepEqual(c.ledger().resources.filter((row: any) => row.harness === 'gemini').map((row: any) => row.ownershipIdentity), ['gemini:instructions'],
    'only the deferred row stays in the ledger');

  const second = c.run(['install', '-g', '-f', '--no-backup', '-t', 'antigravity']);
  assert.equal(second.status, 0, second.output);
  assert.ok(second.stdout.includes(RETIRED_LINE('deleted 0, stripped 0, released 1, kept 0')), second.stdout);
  const text = fs.readFileSync(c.geminiMd, 'utf8');
  const start = text.indexOf(MARKER_START);
  assert.equal(text.slice(0, start), `${USER_TEXT}\n`, 'the person\'s text before the section is byte-identical');
  assert.ok(text.endsWith(`${MARKER_END}\n`), 'nothing follows the section');
  assert.equal(text.split('doflow:start').length - 1, 1, 'exactly one DoFlow section');
  assert.ok(!text.includes('DoFlow pointer') && !text.includes(SHORT_MARKER_START), 'the retired span is replaced, not kept beside the new one');
  assert.ok(text.includes(path.join(c.home, '.doflow', 'guidance')), 'the section is antigravity\'s pointer to the global guidance tree');
  const rows = c.ledger().resources.filter((row: any) => row.target === c.geminiMd);
  assert.deepEqual(rows.map((row: any) => [row.harness, row.ownershipIdentity]), [['antigravity', 'doflow:antigravity:instructions:managed-section']]);
  assert.equal(c.ledger().targets.gemini, undefined, 'the retired target leaves the ledger once no deferred row remains');
  assertUserSettingsKept(c.settings());
});

test('(2) a retired target is refused by every verb with the IC-002 message and changes nothing', () => {
  const c = cell();
  const before = { files: digests(c.geminiDir), ledger: fs.readFileSync(c.ledgerFile, 'utf8') };
  for (const verb of ['install', 'update', 'remove', 'status']) {
    const done = c.run([verb, '-g', '-f', '-t', 'gemini']);
    assert.notEqual(done.status, 0, `${verb}: ${done.output}`);
    assert.ok(done.stderr.includes(REFUSAL), `${verb}: ${done.stderr}`);
  }
  assert.deepEqual(digests(c.geminiDir), before.files, 'a refusal changes no file');
  assert.equal(fs.readFileSync(c.ledgerFile, 'utf8'), before.ledger, 'a refusal changes no ledger byte');
});

test('(3) reconcile -g with a lock pinning gemini drops the pin, releases the install and converges', () => {
  const c = cell({ ledger: false });
  const base = c.run(['install', '-g', '-f', '--no-backup', '-t', 'claude']);
  assert.equal(base.status, 0, base.output);
  // Lay the gemini install over the claude one: its rows in the ledger and a pin in the lock.
  const ledger = c.ledger();
  ledger.resources.push(...c.built.ledger.resources.filter((row: any) => row.harness === 'gemini'));
  ledger.targets.gemini = { installed: true };
  writeLedger(c.state, ledger);
  const lockFile = path.join(c.home, '.doflow', 'doflow.lock');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.targets.push({ harness: 'gemini' });
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  const before = digests(c.geminiDir);

  const dry = c.run(['reconcile', '-g', '--dry-run']);
  assert.equal(dry.status, 1, `a drifted state fails a dry run: ${dry.output}`);
  assert.ok(dry.stdout.includes('[WARN] gemini: retired (use antigravity); dropped from the pinned targets'), dry.stdout);
  assert.ok(dry.stdout.includes(RETIRED_LINE('deleted 9, stripped 2, released 0, kept 0')), dry.stdout);
  assert.deepEqual(digests(c.geminiDir), before, '--dry-run changes no gemini file');

  const healed = c.run(['reconcile', '-g', '-f', '--no-backup']);
  assert.equal(healed.status, 0, healed.output);
  assert.ok(healed.stdout.includes(RETIRED_LINE('deleted 9, stripped 2, released 0, kept 0')), healed.stdout);
  assert.ok(healed.stdout.includes('[OK] Reconciliation complete'), healed.stdout);
  assert.ok(!fs.existsSync(path.join(c.geminiDir, 'hooks')), 'the hook scripts are gone');
  assertUserSettingsKept(c.settings());
  assert.equal(fs.readFileSync(c.geminiMd, 'utf8'), USER_TEXT, 'no antigravity here: the retired span is stripped and the person\'s text kept');
  assert.deepEqual(c.ledger().resources.filter((row: any) => row.harness === 'gemini'), []);

  const again = c.run(['reconcile', '-g', '--dry-run']);
  assert.equal(again.status, 0, again.output);
  assert.ok(again.stdout.includes('Observed state matches doflow.lock'), again.stdout);
  assert.ok(!again.stdout.includes('[RETIRED]'), again.stdout);
});

test('(4) rollback restores the released gemini files byte for byte', () => {
  const c = cell();
  const before = digests(c.geminiDir);
  assert.equal(Object.keys(before).length, 10, 'precondition: seven scripts, the agent, settings.json and GEMINI.md');

  const installed = c.run(['install', '-g', '-f', '-t', 'claude']);
  assert.equal(installed.status, 0, installed.output);
  assert.ok(installed.stdout.includes(RETIRED_LINE('deleted 8, stripped 1, released 1, kept 0')), installed.stdout);
  assert.notDeepEqual(digests(c.geminiDir), before, 'the install released files');

  const [backup] = fs.readdirSync(path.join(c.home, '.doflow', 'backups')).filter((name: string) => name.startsWith('install_'));
  assert.ok(backup, 'the install took a backup');
  const restored = c.run(['rollback', backup, '-g', '-f']);
  assert.equal(restored.status, 0, restored.output);
  assert.deepEqual(digests(c.geminiDir), before, 'every gemini file is back, byte-identical');
});

test('(5) a second update -g prints no [RETIRED] line', () => {
  const c = cell({ antigravity: false });
  const first = c.run(['install', '-g', '-f', '--no-backup', '-t', 'claude']);
  assert.equal(first.status, 0, first.output);
  assert.ok(first.stdout.includes(RETIRED_LINE('deleted 9, stripped 2, released 0, kept 0')), `precondition: the first run swept gemini: ${first.stdout}`);
  assert.equal(fs.readFileSync(c.geminiMd, 'utf8'), USER_TEXT, 'no replacement installed: the retired span is stripped, the person\'s text kept');
  assert.deepEqual(c.ledger().resources.filter((row: any) => row.harness === 'gemini'), [], 'no retired row is left to sweep');
  const after = digests(c.geminiDir);

  const second = c.run(['update', '-g', '-f', '--no-backup']);
  assert.equal(second.status, 0, second.output);
  assert.ok(!second.output.includes('[RETIRED]'), second.output);
  assert.deepEqual(digests(c.geminiDir), after, 'the second run changes no gemini file');
});

const KEPT = 'antigravity: kept ~/.gemini/GEMINI.md: changed before handover; --force replaces the DoFlow section';
const REPLACED = '# Rewritten by me\n\nNo DoFlow here.\n';
const sectionRows = (c: any) => c.ledger().resources.filter((row: any) => row.target === c.geminiMd);

/** A gemini install whose global GEMINI.md the person (or a tool) rewrote with no DoFlow markers left. */
function markerlessCell() {
  const c = cell();
  fs.writeFileSync(c.geminiMd, REPLACED);
  return c;
}

test('(6) a GEMINI.md rewritten with no DoFlow markers is handed over as kept: two plain updates leave it byte-identical under a retainedEdit row, --force appends the section', () => {
  const c = markerlessCell();
  for (const round of [1, 2]) {
    const plain = c.run(['update', '-g', '-t', 'antigravity'], 'y\n');
    assert.equal(plain.status, 0, plain.output);
    assert.ok(plain.stdout.includes(KEPT), `round ${round}: ${plain.stdout}`);
    assert.equal(fs.readFileSync(c.geminiMd, 'utf8'), REPLACED, `round ${round}: the file is not written`);
    const rows = sectionRows(c);
    assert.deepEqual(rows.map((row: any) => [row.harness, row.ownershipIdentity, row.retainedEdit]),
      [['antigravity', 'doflow:antigravity:instructions:managed-section', true]], `round ${round}: one antigravity row, retained`);
    assert.equal(rows[0].fingerprint, sha(REPLACED), `round ${round}: the whole-file fingerprint`);
  }
  const forced = c.run(['update', '-g', '-f', '--no-backup', '-t', 'antigravity']);
  assert.equal(forced.status, 0, forced.output);
  const text = fs.readFileSync(c.geminiMd, 'utf8');
  assert.equal(text.slice(0, text.indexOf(MARKER_START)), `${REPLACED}\n`, '--force appends the section after the person\'s text');
  assert.ok(text.endsWith(`${MARKER_END}\n`));
  const [row] = sectionRows(c);
  assert.equal(row.retainedEdit, undefined, '--force clears the flag');
  assert.equal(row.fingerprint, sha(text));
});

test('(7) remove -g -t antigravity of a kept GEMINI.md with no DoFlow markers leaves the file untouched', () => {
  const c = markerlessCell();
  const handover = c.run(['update', '-g', '-t', 'antigravity'], 'y\n');
  assert.equal(handover.status, 0, handover.output);
  assert.equal(sectionRows(c)[0]?.retainedEdit, true, 'precondition: the retained row is recorded');
  const removed = c.run(['remove', '-g', '-f', '--no-backup', '-t', 'antigravity']);
  assert.equal(removed.status, 0, removed.output);
  assert.equal(fs.readFileSync(c.geminiMd, 'utf8'), REPLACED, 'byte-identical');
  assert.deepEqual(sectionRows(c), [], 'no row is left on it');
});

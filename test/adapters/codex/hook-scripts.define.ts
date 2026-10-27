'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('./hook-scripts.shared.ts');

const { SKIP, olderCliPath, cell, sha, scriptNames, installed, staleScripts, gateDecision, ledgerRows } = shared;
const notice = (harness: any) => `refreshed ${harness} hook front doors to match the shared hooks tree`;

/** The cases of IC-037's script rule for `harness` (codex): it deploys a config
 * plus a directory of scripts, and the config can be right while the scripts are not. */
function defineHookScriptTests(harness: any) {
  const other = 'pi';
  const install = (c: any, targets: any, cli?: any) => {
    const done = c.run(['install', 'proj', '-f', '--no-backup', '-t', targets], cli ? { cli } : {});
    assert.equal(done.status, 0, done.output);
  };
  // A harness installed by the older commit: older scripts, and the config already as it is today.
  const installOlder = (c: any) => {
    install(c, `${harness},${other}`, olderCliPath());
    assert.ok(staleScripts(c, harness).includes('pre-implement-gate.sh'), 'the older install carries older scripts');
  };
  // The tree made to change, so an update that names only pi has a reason to look at the doors.
  const moveTree = (c: any) => fs.rmSync(path.join(c.proj, '.doflow', 'shared', 'hooks', 'policies', 'lib.sh'));

  describe(`${harness} hook scripts follow their bytes`, { concurrency: 4 }, () => {
    test(`older scripts beside a current config: \`update -t ${harness}\` replaces them and the door emits a v1 decision`, { skip: SKIP }, () => {
      const c = cell(`${harness}-own`);
      installOlder(c);
      const updated = c.run(['update', 'proj', '-t', harness]);
      assert.equal(updated.status, 0, updated.output);
      assert.deepEqual(staleScripts(c, harness), []);
      const { decision, stderr } = gateDecision(c, harness);
      assert.ok(decision, `the door recorded no decision: ${stderr}`);
      assert.equal(decision.v, 1);
      assert.equal(decision.harness, harness);
      assert.equal(decision.outcome, 'deny');
      assert.equal(decision.code, 'missing-artifacts');
      // From now on each script has a ledger row of its own, owned by this harness.
      const rows = ledgerRows(c).filter((row: any) => row.kind === 'hooks-script');
      assert.deepEqual(rows.map((row: any) => row.identity).sort(), scriptNames(harness).sort());
      for (const row of rows) {
        assert.equal(row.harness, harness);
        assert.equal(String(row.fingerprint).replace(/^sha256:/, ''), sha(fs.readFileSync(installed(c, harness, row.identity))));
      }
    });

    test(`the same through \`update -t ${other}\`: the ${harness} scripts are refreshed as a companion`, { skip: SKIP }, () => {
      const c = cell(`${harness}-companion`);
      installOlder(c);
      moveTree(c);
      const dry = c.run(['update', 'proj', '-t', other, '--dry-run']);
      assert.equal(dry.status, 0, dry.output);
      assert.ok(dry.stdout.includes(`[DRY]   ${harness}: ${notice(harness)}`), dry.stdout);
      assert.ok(staleScripts(c, harness).length > 0, '--dry-run writes nothing');
      const updated = c.run(['update', 'proj', '-t', other]);
      assert.equal(updated.status, 0, updated.output);
      assert.ok(updated.stdout.includes(`[INFO] ${harness}: ${notice(harness)}`), updated.stdout);
      assert.deepEqual(staleScripts(c, harness), []);
      const { decision, stderr } = gateDecision(c, harness);
      assert.ok(decision, `the door recorded no decision: ${stderr}`);
      assert.equal(decision.v, 1);
      assert.equal(decision.harness, harness);
    });

    test('a script edited after DoFlow wrote it refuses the update and the companion refresh; -f overwrites', { skip: SKIP }, () => {
      const c = cell(`${harness}-edited`);
      install(c, `${harness},${other}`);
      const door = installed(c, harness, 'pre-implement-gate.sh');
      fs.appendFileSync(door, '# edited by hand\n');
      const edited = fs.readFileSync(door);
      moveTree(c);
      const treeFile = path.join(c.proj, '.doflow', 'shared', 'hooks', 'policies', 'lib.sh');

      const own = c.run(['update', 'proj', '-t', harness]);
      assert.equal(own.status, 1, own.output);
      assert.ok(own.stderr.includes("hook script 'pre-implement-gate.sh' was modified outside DoFlow"), own.stderr);
      assert.ok(fs.readFileSync(door).equals(edited));

      const companion = c.run(['update', 'proj', '-t', other]);
      assert.equal(companion.status, 1, companion.output);
      assert.ok(companion.stderr.includes("hook script 'pre-implement-gate.sh' was modified outside DoFlow"), companion.stderr);
      assert.ok(companion.stderr.includes(`${harness} hook front doors must move with the shared hooks tree; run: doflow update -t ${other},${harness}`), companion.stderr);
      assert.ok(fs.readFileSync(door).equals(edited));
      assert.equal(fs.existsSync(treeFile), false, 'a refused plan leaves the tree as it was');

      const forced = c.run(['update', 'proj', '-t', other, '-f']);
      assert.equal(forced.status, 0, forced.output);
      assert.deepEqual(staleScripts(c, harness), []);
    });

    test('a removal releases the script rows with the config row, and the ledger holds none of them afterwards', { skip: SKIP }, () => {
      const c = cell(`${harness}-remove`);
      install(c, `${harness},${other}`);
      assert.ok(ledgerRows(c).some((row: any) => row.kind === 'hooks-script' && row.harness === harness));
      const removed = c.run(['remove', 'proj', '-t', harness, '-f']);
      assert.equal(removed.status, 0, removed.output);
      assert.deepEqual(ledgerRows(c).filter((row: any) => row.harness === harness), []);
    });
  });
}

module.exports = { defineHookScriptTests };

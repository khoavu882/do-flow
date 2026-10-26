'use strict';

// retired-harnesses.test.ts — row 127 IC-003: the retirement sweep's plan and apply, one test per
// classification rule and action, the counts and notices, and plan.md T-127-A2 controls (a)-(h).
// The retired id is a synthetic `oldtool` replaced by `antigravity`; no real harness is involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ownershipKey } = require('../../src/state/index.ts');
const { planRetiredHarnesses, applyRetiredHarnesses, retiredReleaseKeys, formatRetiredPlans } = require('../../src/lifecycle/retired-harnesses.ts');
const { buildRetiredLedger, hookCommand, USER_TEXT, USER_HANDLER, USER_KEYS, sha } = require('../helper/retired-ledger.ts');
const { tempDir } = require('../helper/tmp.ts');

function setup(t: any, options: any = {}) {
  const root = tempDir(t, 'doflow-retired-');
  return { root, ...buildRetiredLedger({ root, ...options }) };
}

function plan(fixture: any, extra: any = {}) {
  return planRetiredHarnesses({ registry: fixture.registry, ledger: fixture.ledger, scope: 'global', scopeRoot: fixture.root, livePlanChanges: [], ...extra });
}

/** The single change planned for `row`. */
function changeFor(plans: any[], row: any) {
  const found = plans.flatMap((p) => p.changes).filter((change: any) => change.ownershipKey === ownershipKey(row));
  assert.equal(found.length, 1, `exactly one change for ${row.target}`);
  return found[0];
}

test('rule 1: a target a live change removes or supersedes is drop-row, with no fs effect', (t) => {
  const f = setup(t);
  const plans = plan(f, { livePlanChanges: [
    { harness: 'antigravity', operation: 'remove', target: f.targets.agent },
    { harness: 'antigravity', operation: 'remove', target: path.join(f.root, 'elsewhere'), supersedes: [ownershipKey(f.rows.scripts[0])] },
  ] });
  // (f) the agent file is DoFlow's unchanged bytes, which rule 3 alone would delete
  for (const row of [f.rows.agent, f.rows.scripts[0]]) {
    const change = changeFor(plans, row);
    assert.equal(change.action, 'drop-row');
    assert.equal(change.release, true);
  }
  applyRetiredHarnesses(plans);
  assert.ok(fs.existsSync(f.targets.agent), 'the live change, not the sweep, owns that removal');
  assert.ok(fs.existsSync(f.rows.scripts[0].target));
});

test('rule 2 / control (c): a file a live harness also claims is released: bytes and the live row unchanged', (t) => {
  const f = setup(t);
  const before = fs.readFileSync(f.targets.shared);
  const plans = plan(f);
  const change = changeFor(plans, f.rows.shared);
  assert.equal(change.action, 'release');
  assert.equal(change.release, true);
  assert.equal(change.retired, true);
  assert.equal(change.operation, 'remove');
  assert.ok(!plans.flatMap((p: any) => p.changes).some((c: any) => c.harness === 'antigravity'), 'no change names the live harness');
  assert.ok(!retiredReleaseKeys(plans).has(ownershipKey(f.rows.sharedLive)), 'the antigravity row is kept');
  applyRetiredHarnesses(plans);
  assert.deepEqual(fs.readFileSync(f.targets.shared), before);
});

test('rule 3: unchanged copy-tree and hook-script files are deleted; an absent one is drop-row', (t) => {
  const f = setup(t);
  fs.rmSync(f.rows.scripts[1].target);
  const plans = plan(f);
  assert.equal(changeFor(plans, f.rows.agent).action, 'delete');
  assert.equal(changeFor(plans, f.rows.scripts[0]).action, 'delete');
  assert.equal(changeFor(plans, f.rows.scripts[1]).action, 'drop-row');
  applyRetiredHarnesses(plans);
  assert.ok(!fs.existsSync(f.targets.agent));
  for (const row of f.rows.scripts) assert.ok(!fs.existsSync(row.target), row.target);
});

test('control (a): an edited hook script is kept and named, and its row still leaves the ledger', (t) => {
  const f = setup(t);
  const script = f.rows.scripts[0].target;
  fs.appendFileSync(script, '# my edit\n');
  const plans = plan(f);
  const change = changeFor(plans, f.rows.scripts[0]);
  assert.equal(change.action, 'keep');
  assert.equal(change.reason, 'changed since DoFlow wrote it');
  assert.ok(plans[0].notices.includes(`kept ${path.relative(f.root, script)}: changed since DoFlow wrote it`));
  assert.ok(retiredReleaseKeys(plans).has(ownershipKey(f.rows.scripts[0])));
  applyRetiredHarnesses(plans);
  assert.match(fs.readFileSync(script, 'utf8'), /# my edit/);
});

test('control (e): a target symlinked outside its recorded path is kept, and nothing outside is touched', (t) => {
  const f = setup(t);
  const outside = path.join(tempDir(t, 'doflow-retired-outside-'), 'helper.md');
  fs.copyFileSync(f.targets.agent, outside);   // same bytes, so only containment can keep it
  fs.rmSync(f.targets.agent);
  fs.symlinkSync(outside, f.targets.agent);
  const plans = plan(f);
  const change = changeFor(plans, f.rows.agent);
  assert.equal(change.action, 'keep');
  assert.equal(change.reason, 'resolves outside its recorded path');
  applyRetiredHarnesses(plans);
  assert.ok(fs.lstatSync(f.targets.agent).isSymbolicLink());
  assert.ok(fs.existsSync(outside));
});

test('apply re-checks a whole file and refuses one changed after the plan', (t) => {
  const f = setup(t);
  const plans = plan(f);
  fs.appendFileSync(f.targets.agent, 'late edit\n');
  assert.throws(() => applyRetiredHarnesses(plans), /Refusing to remove modified/);
  assert.match(fs.readFileSync(f.targets.agent, 'utf8'), /late edit/);
});

test('rule 4: a marker section is stripped and the person\'s text kept byte for byte', (t) => {
  const f = setup(t);
  const plans = plan(f);
  assert.equal(changeFor(plans, f.rows.instructions).action, 'strip-section');
  applyRetiredHarnesses(plans);
  assert.equal(fs.readFileSync(f.targets.instructions, 'utf8'), USER_TEXT);
});

test('rule 4: a file without markers is drop-row; control (d): malformed markers are kept and named', (t) => {
  const f = setup(t);
  fs.writeFileSync(f.targets.instructions, USER_TEXT);
  assert.equal(changeFor(plan(f), f.rows.instructions).action, 'drop-row');

  const malformed = `${USER_TEXT}<!-- doflow:start — content below is managed by doflow install/update; edits here are overwritten on the next run -->\nno end\n`;
  fs.writeFileSync(f.targets.instructions, malformed);
  const plans = plan(f);
  const change = changeFor(plans, f.rows.instructions);
  assert.equal(change.action, 'keep');
  assert.equal(change.reason, 'malformed DoFlow markers');
  assert.ok(plans[0].notices.includes(`kept ${path.relative(f.root, f.targets.instructions)}: malformed DoFlow markers`));
  applyRetiredHarnesses(plans);
  assert.equal(fs.readFileSync(f.targets.instructions, 'utf8'), malformed);
});

test('rule 5 / control (b): only the frozen commands leave the hooks key; user handlers and other keys stay byte-identical', (t) => {
  const f = setup(t);
  const plans = plan(f);
  assert.equal(changeFor(plans, f.rows.settings).action, 'strip-hooks');
  applyRetiredHarnesses(plans);
  const text = fs.readFileSync(f.targets.settings, 'utf8');
  const doc = JSON.parse(text);
  assert.deepEqual(doc.hooks, {
    SessionStart: [{ hooks: [USER_HANDLER] }],
    BeforeTool: [{ matcher: '^run_shell_command$', hooks: [USER_HANDLER] }],
  }, 'emptied groups and events go, the user\'s stay');
  for (const key of Object.keys(USER_KEYS)) {
    assert.ok(text.includes(JSON.stringify({ [key]: (USER_KEYS as any)[key] }, null, 2).slice(1, -2)), `${key} serialized unchanged`);
    assert.deepEqual(doc[key], (USER_KEYS as any)[key]);
  }
  assert.deepEqual(Object.keys(doc), ['mcpServers', 'security', 'hooks'], 'key order kept');
});

test('rule 5: the hooks key goes when only DoFlow handlers were in it', (t) => {
  const f = setup(t);
  const doc = { ...USER_KEYS, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('oldtool', 'session-start.sh') }] }] } };
  fs.writeFileSync(f.targets.settings, `${JSON.stringify(doc, null, 2)}\n`);
  applyRetiredHarnesses(plan(f));
  assert.equal(fs.readFileSync(f.targets.settings, 'utf8'), `${JSON.stringify(USER_KEYS, null, 2)}\n`);
});

test('rule 5: unparseable JSON is kept and named; no matching command or no hooks key is drop-row', (t) => {
  const f = setup(t);
  fs.writeFileSync(f.targets.settings, '{ not json');
  let plans = plan(f);
  assert.equal(changeFor(plans, f.rows.settings).action, 'keep');
  assert.equal(changeFor(plans, f.rows.settings).reason, 'not valid JSON');
  applyRetiredHarnesses(plans);
  assert.equal(fs.readFileSync(f.targets.settings, 'utf8'), '{ not json');

  const userOnly = `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [USER_HANDLER] }] } }, null, 2)}\n`;
  fs.writeFileSync(f.targets.settings, userOnly);
  plans = plan(f);
  assert.equal(changeFor(plans, f.rows.settings).action, 'drop-row');
  applyRetiredHarnesses(plans);
  assert.equal(fs.readFileSync(f.targets.settings, 'utf8'), userOnly);

  fs.writeFileSync(f.targets.settings, `${JSON.stringify(USER_KEYS, null, 2)}\n`);
  assert.equal(changeFor(plan(f), f.rows.settings).action, 'drop-row');
});

test('rule 6: an unknown row shape is kept with its kind and renderer named', (t) => {
  const f = setup(t);
  const odd = { ...f.rows.instructions, kind: 'mcp-server', identity: 'x', ownershipIdentity: 'oldtool:mcp:x', projection: { renderer: 'oldtool-mcp' } };
  f.ledger.resources.push(odd);
  const plans = plan(f);
  const change = changeFor(plans, odd);
  assert.equal(change.action, 'keep');
  assert.equal(change.reason, 'unknown row shape mcp-server/oldtool-mcp');
});

test('counts, notices and the IC-003 output lines', (t) => {
  const f = setup(t);
  fs.appendFileSync(f.rows.scripts[0].target, '# edit\n');
  const plans = plan(f);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].harness, 'oldtool');
  assert.equal(plans[0].replacement, 'antigravity');
  // agent + 6 unchanged scripts deleted; section + hooks stripped; shared released; edited script kept
  assert.deepEqual(plans[0].counts, { deleted: 7, stripped: 2, released: 1, kept: 1 });
  const rel = path.relative(f.root, f.rows.scripts[0].target);
  assert.deepEqual(formatRetiredPlans(plans), [
    '[RETIRED] oldtool → antigravity: deleted 7, stripped 2, released 1, kept 1',
    `  kept ${rel}: changed since DoFlow wrote it`,
  ]);
  for (const change of plans[0].changes) {
    assert.equal(change.retired, true);
    assert.equal(change.operation, 'remove');
    assert.equal(change.release === true, ['release', 'keep', 'drop-row'].includes(change.action), `${change.action} release flag`);
  }
});

test('retiredReleaseKeys holds every retired row and no live one', (t) => {
  const f = setup(t);
  const keys = retiredReleaseKeys(plan(f));
  const retiredRows = f.ledger.resources.filter((row: any) => row.harness === 'oldtool');
  assert.deepEqual([...keys].sort(), retiredRows.map(ownershipKey).sort());
});

test('control (g): a second plan over the result is [] and prints nothing; no retired record or rows is [] too', (t) => {
  const f = setup(t);
  const plans = plan(f);
  applyRetiredHarnesses(plans);
  const released = retiredReleaseKeys(plans);
  const after = { ...f.ledger, resources: f.ledger.resources.filter((row: any) => !released.has(ownershipKey(row))) };
  const again = planRetiredHarnesses({ registry: f.registry, ledger: after, scope: 'global', scopeRoot: f.root, livePlanChanges: [] });
  assert.deepEqual(again, []);
  assert.deepEqual(formatRetiredPlans(again), []);
  assert.deepEqual(planRetiredHarnesses({ registry: { harnesses: [], retired: [] }, ledger: f.ledger, scope: 'global', scopeRoot: f.root }), []);
});

test('control (h): JSON hooks are stripped before the scripts they name are deleted', (t) => {
  const f = setup(t);
  const plans = plan(f);
  const events: string[] = [];
  const spy = new Proxy(fs, {
    get(target: any, name: string) {
      const value = target[name];
      if (typeof value !== 'function') return value;
      if (name === 'renameSync') return (from: string, to: string) => { events.push(`write ${to}`); return value.call(target, from, to); };
      if (name === 'rmSync' || name === 'unlinkSync') return (file: string, ...rest: any[]) => { events.push(`delete ${file}`); return value.call(target, file, ...rest); };
      return value.bind(target);
    },
  });
  applyRetiredHarnesses(plans, { fsImpl: spy });
  const settingsWrite = events.indexOf(`write ${f.targets.settings}`);
  const firstScript = events.findIndex((event) => f.rows.scripts.some((row: any) => event === `delete ${row.target}`));
  assert.ok(settingsWrite >= 0, `settings written: ${events.join(', ')}`);
  assert.ok(firstScript >= 0, `scripts deleted: ${events.join(', ')}`);
  assert.ok(settingsWrite < firstScript, `strip before delete: ${events.join(', ')}`);
});

test('the fixture reproduces the frozen gemini hook command strings', () => {
  assert.equal(hookCommand('gemini', 'session-start.sh'), 'bash "$GEMINI_PROJECT_DIR/.gemini/hooks/session-start.sh"');
  assert.equal(typeof sha('x'), 'string');
});

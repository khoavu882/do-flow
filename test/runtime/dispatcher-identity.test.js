'use strict';

// Feature 082 C.6 (IC-035; DEC-012, DEC-031, DEC-042): the dispatcher's `trace_run` rider writes
// the session identity from the environment only, quoted when it matches identity.ts's pattern and
// `null` otherwise, so the run ledger line always parses.
//
// The dispatcher runs under /bin/bash (3.2 on macOS) with PATH set to the scratch bin/ from
// test/helper/dispatch-sandbox.js, holding `node` and the three tools the dispatcher and its trace
// call (dirname, date, mkdir); the node directory is never on PATH (DEC-056, NFR-002). The verb is
// served by a fake CLI script through DOFLOW_CLI, so the only ledger writer is `trace_run`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');
const { IDENTITY_VARS } = require('../helper/fake-harness-cli.js');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const BASH = '/bin/bash';
const SKIP = process.platform === 'win32' ? 'tree cleanup is unverified on win32 (NFR-005)' : false;

function harness(t) {
  const box = makeDispatchSandbox(t, { systemTools: ['dirname', 'date', 'mkdir'] });
  const config = path.join(box.dir, 'config');
  const cli = path.join(box.dir, 'fake-cli.js');
  fs.mkdirSync(config);
  fs.writeFileSync(cli, 'process.stdout.write("fake-out " + process.argv.slice(2).length + "\\n");\n');
  const runsDir = path.join(config, 'state', 'runs');
  /** One dispatched `workflow` verb; `identity` sets (string) or deletes (undefined) each DOFLOW_* value. */
  const dispatch = (identity) => {
    const env = { ...box.env, DOFLOW_CLI: cli, DOFLOW_CONFIG_DIR: config, DOFLOW_FAILURE_CAPTURE: 'off' };
    for (const key of IDENTITY_VARS) {
      if (Object.prototype.hasOwnProperty.call(identity, key)) {
        if (identity[key] === undefined) delete env[key]; else env[key] = identity[key];
      }
    }
    fs.rmSync(runsDir, { recursive: true, force: true });
    const r = spawnSync(BASH, [RUN, 'workflow', '--task-class', 'feature'], { cwd: box.root, env, encoding: 'utf8' });
    const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
    const lines = files.flatMap((f) => fs.readFileSync(path.join(runsDir, f), 'utf8').split('\n').filter(Boolean));
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines };
  };
  return { box, dispatch };
}

/** The one ledger line a dispatch wrote, parsed; fails when it is not one valid JSON line. */
function onlyRecord(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.lines.length, 1, `expected one ledger line, got ${JSON.stringify(r.lines)}`);
  let record;
  assert.doesNotThrow(() => { record = JSON.parse(r.lines[0]); }, `ledger line must parse: ${r.lines[0]}`);
  return record;
}

test('IC-035: a traced verb under a valid identity writes quoted run, lineage and attempt', { skip: SKIP }, (t) => {
  const { box, dispatch } = harness(t);
  const record = onlyRecord(dispatch({ DOFLOW_RUN_ID: 'r-1_A', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '12' }));
  assert.equal(record.verb, 'workflow');
  assert.equal(record.exit_code, 0);
  assert.equal(record.arg_count, 2);
  assert.equal(record.run, 'r-1_A');
  assert.equal(record.lineage, 'main');
  assert.equal(record.attempt, '12');
  // The sandbox's own identity reads the same way.
  const own = onlyRecord(dispatch({}));
  assert.equal(own.run, box.identity.DOFLOW_RUN_ID);
  assert.equal(own.lineage, box.identity.DOFLOW_LINEAGE_ID);
  assert.equal(own.attempt, box.identity.DOFLOW_ATTEMPT);
});

test('IC-035: attempt 0, run local and a value holding a quote each write null and the line parses', { skip: SKIP }, (t) => {
  const { dispatch } = harness(t);
  const cases = [
    [{ DOFLOW_RUN_ID: 'a"b' }, 'run'],
    [{ DOFLOW_RUN_ID: 'r1","x":"y' }, 'run'],
    [{ DOFLOW_LINEAGE_ID: 'm"ain' }, 'lineage'],
    [{ DOFLOW_ATTEMPT: '0' }, 'attempt'],
    [{ DOFLOW_ATTEMPT: '10000' }, 'attempt'],
    [{ DOFLOW_RUN_ID: 'local' }, 'run'],
    [{ DOFLOW_LINEAGE_ID: 'x'.repeat(57) }, 'lineage'],
    [{ DOFLOW_RUN_ID: 'r\\1' }, 'run'],
  ];
  for (const [identity, field] of cases) {
    const record = onlyRecord(dispatch(identity));
    assert.equal(record[field], null, `${JSON.stringify(identity)} must write ${field}: null`);
    assert.equal(record.x, undefined, 'no injected key');
  }
  const none = onlyRecord(dispatch({ DOFLOW_RUN_ID: undefined, DOFLOW_LINEAGE_ID: undefined, DOFLOW_ATTEMPT: undefined }));
  assert.deepEqual([none.run, none.lineage, none.attempt], [null, null, null]);
});

test('IC-035: the verb\'s stdout is byte-identical with and without the identity', { skip: SKIP }, (t) => {
  const { dispatch } = harness(t);
  const withId = dispatch({ DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '1' });
  const without = dispatch({ DOFLOW_RUN_ID: undefined, DOFLOW_LINEAGE_ID: undefined, DOFLOW_ATTEMPT: undefined });
  assert.equal(withId.status, without.status);
  assert.equal(withId.stdout, without.stdout);
  assert.equal(withId.stdout, 'fake-out 3\n');
  assert.equal(withId.stderr, without.stderr);
});

test('IC-035: trace_run starts no process but mkdir and date (NFR-007)', () => {
  const text = fs.readFileSync(RUN, 'utf8');
  const body = text.match(/trace_run\(\)\s*\{([\s\S]*?)\r?\n\}/);
  assert.ok(body, 'trace_run() must be parseable');
  const substitutions = [...body[1].matchAll(/\$\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(substitutions, ['date -u +%Y-%m-%d'], 'the only command substitution is the ledger file date');
  assert.ok(!body[1].includes('`'), 'no backtick substitution');
  // Each value variable is assigned quoted only inside an `if [[ ... =~ ... ]]` test.
  for (const name of ['run_v', 'lineage_v', 'attempt_v']) {
    const assigns = body[1].split('\n').filter((line) => new RegExp(`\\b${name}=`).test(line) && !/^\s*local\b/.test(line));
    assert.ok(assigns.length > 0, `${name} is assigned`);
    for (const line of assigns) assert.match(line, /^\s*if \[\[ .+ =~ .+ \]\]; then \w+_v="\\"/, `${name} assigned outside a [[ =~ ]] test: ${line}`);
  }
});

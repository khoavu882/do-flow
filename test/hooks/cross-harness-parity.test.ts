'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { buildInstallMirror, createScratch, createScratchGitRepo } = require('../helper/hook-fixtures.ts');

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'test/fixtures/hooks');
const scratch = createScratch('doflow-cross-harness-parity-');
after(() => scratch.remove());

const FRONT_DOOR: any = {
  claude: { 'pre-implementation-gate': 'pre-implement-gate' },
  codex: { 'pre-implementation-gate': 'pre-implement-gate' },
  gemini: { 'pre-implementation-gate': 'pre-implement-gate' },
  kiro: { 'pre-implementation-gate': 'pre-implement-gate' },
};
const STEM_POLICY: any = {
  'pre-implement-gate': 'pre-implementation-gate',
  'pre-bash-guard': 'pre-bash-guard',
  'mcp-tool-guard': 'mcp-tool-guard',
  'session-start': 'session-context',
  'stop-check': 'stop-check',
};

function write(file: any, contents: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function makeProject(name: any, artifacts: any) {
  const project = createScratchGitRepo(scratch, name);
  project.run('checkout', '-q', '-b', 'feat/077-g3');
  const feature = path.join(project.root, 'agent-docs/doflow/077-g3');
  fs.mkdirSync(feature, { recursive: true });
  write(path.join(feature, 'intention/requirement.md'), '# requirement\n');
  write(path.join(feature, 'plan.md'), '- [ ] G.3 [US1] parity — owner: test; files: test/hooks/cross-harness-parity.test.ts\n');
  if (artifacts) write(path.join(feature, 'design/design.md'), '# design\n');
  const piFeature = path.join(project.root, 'agent-docs/doflow/pi-gate');
  fs.mkdirSync(piFeature, { recursive: true });
  write(path.join(piFeature, 'intention/requirement.md'), '# requirement\n');
  write(path.join(piFeature, 'plan.md'), '# plan\n');
  if (artifacts) write(path.join(piFeature, 'design/design.md'), '# design\n');
  write(path.join(project.root, '.doflow/state/parity-seed.json'), JSON.stringify({ name, retained: true }) + '\n');
  return project.root;
}

function stateSnapshot(root: any) {
  const target = path.join(root, '.doflow/state');
  if (!fs.existsSync(target)) return null;
  const result: any = [];
  const walk = (dir: any) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else result.push([path.relative(target, full), fs.readFileSync(full, 'base64')]);
    }
  };
  walk(target);
  return result.sort(([a]: any, [b]: any) => a.localeCompare(b));
}

function call(command: any, args: any, options: any) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function fixtureFor(harness: any, policy: any, wantBlock: any = true) {
  if (harness === 'pi') {
    const name: any = ({
      'pre-implementation-gate': wantBlock ? 'edit-deny' : 'edit-allow',
      'pre-bash-guard': wantBlock ? 'bash-deny' : 'bash-allow',
      'mcp-tool-guard': 'nested-mcp-deny',
    } as any)[policy];
    if (!name) return null;
    const filename = path.join(FIXTURES, 'pi/tool_call', `${name}.json`);
    const fixture = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (policy === 'mcp-tool-guard' && !wantBlock) {
      fixture.native.toolName = 'mcp__github__get_issue';
      fixture.native.input = { issue_number: 1 };
    }
    return { stem: 'tool_call', filename, fixture };
  }
  const dir = path.join(FIXTURES, harness);
  for (const stem of fs.readdirSync(dir).sort()) {
    const stemDir = path.join(dir, stem);
    if (!fs.statSync(stemDir).isDirectory() || STEM_POLICY[stem] !== policy) continue;
    for (const name of fs.readdirSync(stemDir).filter((entry: any) => entry.endsWith('.json')).sort()) {
      const filename = path.join(stemDir, name);
      const fixture = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!fixture.native || !fixture.expect) continue;
      const outcome = fixture.expect.decision?.outcome;
      const blocks = outcome === 'deny' || fixture.expect.decision?.effect === 'block' || fixture.expect.result?.block === true;
      const allows = outcome === 'allow';
      if (wantBlock ? blocks : allows) return { stem, filename, fixture };
    }
  }
  return null;
}

function prepareMirror(harness: any, index: any) {
  const mirror = path.join(scratch.dir, `mirror-${index}`);
  buildInstallMirror(mirror);
  return mirror;
}

function executeShell(harness: any, row: any, project: any, mirror: any, index: any) {
  const native = JSON.parse(JSON.stringify(row.fixture.native));
  const trace = path.join(scratch.dir, `trace-${index}.jsonl`);
  const home = path.join(scratch.dir, `home-${index}`);
  const xdg = path.join(scratch.dir, `xdg-${index}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  let command;
  let args;
  if (row.fixture.policyConfig) {
    write(path.join(mirror, '.doflow/shared/hooks/policies', row.fixture.policyConfig.file), row.fixture.policyConfig.contents);
  }
  if (row.fixture.fault === 'stop-exit-2' || row.fixture.fault === 'stop-exit-7') {
    write(path.join(mirror, '.doflow/shared/hooks/policies/stop-check.sh'), `#!/usr/bin/env bash\ncat >/dev/null\nexit ${row.fixture.fault === 'stop-exit-2' ? 2 : 7}\n`);
    fs.chmodSync(path.join(mirror, '.doflow/shared/hooks/policies/stop-check.sh'), 0o755);
  }
  if (row.stem === 'stop-check' && !native.transcript_path && !native.transcriptPath) {
    native.transcript_path = path.join(scratch.dir, `transcript-${index}.jsonl`);
    fs.writeFileSync(native.transcript_path, `${JSON.stringify({ role: 'assistant', content: 'Work is complete.' })}\n`);
  }
  if (harness === 'antigravity') {
    if (Array.isArray(native.workspacePaths)) native.workspacePaths = [project];
    if (native.transcriptPath === '<transcript>') {
      native.transcriptPath = path.join(scratch.dir, `transcript-${index}.jsonl`);
      fs.writeFileSync(native.transcriptPath, `${JSON.stringify({ role: 'assistant', content: '// TODO: finish this work' })}\n`);
    }
    command = process.execPath;
    args = [path.join(mirror, '.doflow/shared/hooks/stream-hook-runner.js'), row.stem === 'stop-check' ? 'Stop' : 'PreToolUse'];
  } else {
    const stem = FRONT_DOOR[harness][row.policy] || row.stem;
    command = 'bash';
    args = [path.join(mirror, `.${harness}/hooks/${stem}.sh`)];
  }
  const result = call(command, args, {
    cwd: project,
    input: `${JSON.stringify(native)}\n`,
    env: {
      ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_PROJECT_DIR: project,
      DOFLOW_AGENT: harness, DOFLOW_BRIDGE_TRACE: trace, GIT_CONFIG_GLOBAL: '/dev/null',
      ...(row.fixture.env || {}),
    },
  });
  const event = native.hook_event_name || (row.stem === 'stop-check' ? 'Stop' : 'PreToolUse');
  let response: any = {};
  try { response = JSON.parse(result.stdout || '{}'); } catch { response = {}; }
  const denied = event === 'Stop' ? (harness === 'antigravity'
    ? response.decision === 'continue'
    : result.status === 2 || Boolean(result.stderr))
    : harness === 'kiro' ? result.status === 2
    : harness === 'antigravity' ? response.decision === 'deny'
      : harness === 'gemini' ? response.decision === 'deny'
        : response.hookSpecificOutput?.permissionDecision === 'deny';
  return { denied, result, native, trace };
}

async function executePi(row: any, project: any, mirror: any, index: any) {
  if (row.fixture.policy === 'mcp-tool-guard') {
    fs.appendFileSync(path.join(mirror, '.doflow/shared/hooks/policies/mcp-policy.conf'), 'github__delete_issue\tParity fixture MCP deny\n');
  }
  const extensionDir = path.join(project, '.pi/extensions');
  fs.mkdirSync(extensionDir, { recursive: true });
  const source = fs.readFileSync(path.join(REPO, 'core/harnesses/pi/extensions/doflow-guard.js'), 'utf8');
  const bridgeUrl = pathToFileURL(path.join(mirror, '.doflow/shared/hooks/bridge/bridge.sh')).href;
  const rendered = source.replace("const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);", `const BRIDGE = new URL(${JSON.stringify(bridgeUrl)});`);
  assert.notEqual(rendered, source, 'Pi extension bridge URL is install-shaped');
  const extensionPath = path.join(extensionDir, 'doflow-guard.mjs');
  fs.writeFileSync(extensionPath, rendered);
  const moduleUrl = `${pathToFileURL(extensionPath).href}?case=${index}`;
  if (row.fixture.policyConfig) write(path.join(mirror, '.doflow/shared/hooks/policies', row.fixture.policyConfig.file), row.fixture.policyConfig.contents);
  let handler: any;
  const { default: register } = await import(moduleUrl);
  register({ on(name: any, callback: any) { assert.equal(name, 'tool_call'); handler = callback; } });
  const result = await handler(row.fixture.native, { cwd: project, sessionManager: { getSessionId: () => 'parity-session' } });
  return { denied: result?.block === true, result, native: row.fixture.native, trace: null };
}

function assertAllowed(harness: any, actual: any) {
  assert.equal(actual.denied, false, `${harness}: canonical input is allowed (${JSON.stringify(actual.result)})`);
  if (harness === 'pi') assert.equal(actual.result, undefined, 'Pi proceed render is undefined');
  else {
    assert.equal(actual.result.status, 0, `${harness}: allow exits 0`);
    let response: any = {};
    try { response = JSON.parse(actual.result.stdout || '{}'); } catch { /* empty native proceed output */ }
    if (harness === 'antigravity') assert.equal(actual.result.stdout === '' || response.decision === 'allow', true, `${harness}: native proceed render`);
    else if (harness === 'codex') assert.deepEqual(response, {}, 'Codex native proceed render is {}');
    else assert.equal(actual.result.stdout, '', `${harness}: native proceed render is empty output`);
  }
}

const blockingRows = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/lifecycle.json'), 'utf8'))
  .coverage.rows.filter((row: any) => row.class === 'blocking');

test('FR-004: each native bridge denies a design-less edit and allows it once all three artifacts exist', async () => {
  const harnesses: any = ['claude', 'codex', 'gemini', 'kiro', 'antigravity', 'pi'];
  const observed: any = [];
  for (const [index, harness] of harnesses.entries()) {
    const denyRow = fixtureFor(harness, 'pre-implementation-gate', true);
    const allowRow = fixtureFor(harness, 'pre-implementation-gate', false);
    assert.ok(denyRow, `${harness}: committed native edit deny fixture exists`);
    assert.ok(allowRow, `${harness}: committed native edit allow fixture exists`);
    const outcomes: any = [];
    for (const artifacts of [false, true]) {
      const project = makeProject(`${harness}-${artifacts ? 'complete' : 'missing'}`, artifacts);
      const mirror = prepareMirror(harness, `${harness}-${artifacts ? 'complete' : 'missing'}`);
      const row = artifacts ? allowRow : denyRow;
      const actual = harness === 'pi'
        ? await executePi(row, project, mirror, index + Number(artifacts))
        : executeShell(harness, row, project, mirror, index + Number(artifacts));
      outcomes.push(actual.denied);
      if (!artifacts) assert.equal(actual.denied, true, `${harness}: native edit is denied without design.md`);
      else assertAllowed(harness, actual);
      observed.push({ harness, artifacts, denied: actual.denied });
    }
    assert.deepEqual(outcomes, [true, false], `${harness}: deny then allow`);
  }
  assert.equal(observed.length, 12);
});

test('NFR-003: blocking pairs agree across harnesses for the same canonical deny and allow input/state', async () => {
  const pairs: any = new Map();
  for (const row of blockingRows) {
    if (!pairs.has(row.policy)) pairs.set(row.policy, new Map());
    pairs.get(row.policy).set(row.harness, row);
  }
  assert.ok(pairs.size > 0, 'blocking pairs are loaded from lifecycle.json');
  let index = 0;
  for (const [policy, harnessRows] of pairs) {
    const harnesses = [...harnessRows.keys()].sort();
    for (const wantBlock of [true, false]) {
      const project = makeProject(`nfr-${policy}-${wantBlock ? 'deny' : 'allow'}`, wantBlock ? false : true);
      const outcomes: any = [];
      for (const harness of harnesses) {
        const row = fixtureFor(harness, policy, wantBlock);
        assert.ok(row, `${harness}/${policy}: committed native ${wantBlock ? 'deny' : 'allow'} fixture exists`);
        const mirror = prepareMirror(harness, `nfr-${index}`);
        const actual = harness === 'pi'
          ? await executePi(row, project, mirror, index)
          : executeShell(harness, row, project, mirror, index);
        if (wantBlock) assert.equal(actual.denied, true, `${harness}/${policy}: native deny shape`);
        else assertAllowed(harness, actual);
        outcomes.push(actual.denied);
        index += 1;
      }
      assert.equal(new Set(outcomes).size, 1, `${policy}: all blocking harnesses agree on ${wantBlock ? 'deny' : 'allow'} for equal project state`);
    }
  }
});

test('negative control: skipping the envelope merge sends an out-of-step denial', () => {
  const row = fixtureFor('claude', 'pre-implementation-gate');
  const project = makeProject('negative-control', false);
  const mirror = prepareMirror('claude', 'negative-control');
  const bridge = path.join(mirror, '.doflow/shared/hooks/bridge/bridge.sh');
  const original = fs.readFileSync(bridge, 'utf8');
  const sabotaged = original.replace('payload="$encoded"', "payload='{}'");
  assert.notEqual(sabotaged, original, 'the temporary bridge contains the envelope merge line');
  fs.writeFileSync(bridge, sabotaged);
  const result = executeShell('claude', row, project, mirror, 'negative-control');
  // DEC-033: a bridge without a v1 envelope reaches the explicit out-of-step deny.
  assert.equal(result.denied, true, 'a bridge that drops its v1 envelope is denied as out of step');
});

test('Stop, turn-end and session-end fixtures plus Pi tool_call leave task state untouched', async () => {
  const relevant: any = [];
  for (const harness of ['claude', 'codex', 'gemini', 'kiro', 'antigravity']) {
    const root = path.join(FIXTURES, harness);
    for (const stem of fs.readdirSync(root)) {
      const dir = path.join(root, stem);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir).filter((entry: any) => entry.endsWith('.json'))) {
        const fixture = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const event = fixture.native?.hook_event_name;
        if (['Stop', 'SessionEnd', 'TurnEnd'].includes(event) && fixture.expect?.taskStateUnchanged) {
          relevant.push({ harness, stem, name, fixture });
        }
      }
    }
  }
  assert.ok(relevant.length > 0, 'corpus includes lifecycle end fixtures with unchanged-state expectations');
  for (const [index, row] of relevant.entries()) {
    const project = makeProject(`end-event-${index}`, false);
    const before = stateSnapshot(project);
    assert.ok(before?.length, `${row.harness}/${row.stem}/${row.name}: state snapshot starts non-empty`);
    const mirror = prepareMirror(row.harness, `end-event-${index}`);
    executeShell(row.harness, row, project, mirror, `end-event-${index}`);
    assert.deepEqual(stateSnapshot(project), before, `${row.harness}/${row.stem}/${row.name}: task state unchanged`);
  }
  const piProject = makeProject('pi-state-unchanged', true);
  const piBefore = stateSnapshot(piProject);
  const piRow = fixtureFor('pi', 'pre-implementation-gate', false);
  assert.ok(piRow, 'Pi has a committed allow tool_call fixture');
  const piMirror = prepareMirror('pi', 'pi-state-unchanged');
  await executePi(piRow, piProject, piMirror, 'pi-state-unchanged');
  assert.deepEqual(stateSnapshot(piProject), piBefore, 'pi/tool_call/allow: state remains byte-identical');
});

// Feature 078, IC-022: the prompt emission is one policy behind every front door, so an equal
// canonical prompt event over an equal store gives Claude and Codex an equal additionalContext.
const SUMMARY_RECORD = '---\ncompacted_at: 2026-10-14T10:00:00Z\nsession_id: WRITER\ntrigger: auto\nbranch: topic\nrole: main\n'
  + 'summary_id: s-20261014T100000Z-Ab12Cd\nrun: local\nlineage: main\nattempt:\nworktree: <worktree>\n---\n\nPARITY-SUMMARY\n';
const GRANT_RECORD = '---\nsummary_id: s-20261014T100000Z-Ab12Cd\ngranted_at: 2026-10-14T10:05:00Z\nfrom_worktree: <worktree>\n'
  + 'from_run: local\nfrom_lineage: main\nto_run: r1\nto_lineage: w1\ncompacted_at: 2026-10-14T10:00:00Z\nbranch: topic\nbytes: 14\n---\n\nPARITY-GRANTED\n';

test('IC-022: equal canonical prompt event and store state give Claude and Codex equal additionalContext', () => {
  const project = fs.realpathSync(createScratchGitRepo(scratch, 'emission-parity').root);
  const lib = path.join(REPO, 'core/harnesses/shared/hooks/policies/lib.sh');
  const hash = call('bash', ['-c', 'source "$1"; cwd_hash "$2"', 'bash', lib, project], { env: { ...process.env, HOME: scratch.dir } }).stdout.trim();
  assert.match(hash, /^[0-9a-f]{16}$/);
  const states: any = [
    { name: 'main session, pending summary', env: {}, file: `summaries/${hash}/local/main/summary.md`, record: SUMMARY_RECORD, expect: /PARITY-SUMMARY/ },
    { name: 'launched worker, pending grant', env: { DOFLOW_SESSION_ROLE: 'worker', DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_ATTEMPT: '1' },
      file: 'grants/r1/w1/s-20261014T100000Z-Ab12Cd.md', record: GRANT_RECORD, expect: /PARITY-GRANTED/ },
  ];
  for (const [index, state] of states.entries()) {
    const contexts: any = {};
    for (const harness of ['claude', 'codex']) {
      const mirror = prepareMirror(harness, `emission-${harness}-${index}`);
      const home = path.join(scratch.dir, `emission-home-${harness}-${index}`);
      const xdg = path.join(scratch.dir, `emission-xdg-${harness}-${index}`);
      fs.mkdirSync(home, { recursive: true });
      write(path.join(xdg, 'doflow/session-env', state.file), state.record.replace('<worktree>', project));
      const result = call('bash', [path.join(mirror, `.${harness}/hooks/user-prompt-submit.sh`)], {
        cwd: project,
        input: `${JSON.stringify({ session_id: 'parity-prompt', cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'continue' })}\n`,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: '/dev/null', DOFLOW_FAILURE_CAPTURE: 'off', ...state.env },
      });
      assert.equal(result.status, 0, `${harness}/${state.name}: ${result.stderr}`);
      const response = JSON.parse(result.stdout || '{}');
      contexts[harness] = response.additionalContext ?? response.hookSpecificOutput?.additionalContext ?? '';
      assert.match(contexts[harness], state.expect, `${harness}/${state.name}: the stored record is emitted`);
      assert.equal(fs.existsSync(path.join(xdg, 'doflow/session-env', state.file)), false, `${harness}/${state.name}: the record is claimed`);
    }
    assert.equal(contexts.codex, contexts.claude, `${state.name}: Claude and Codex emit the same additionalContext`);
  }
});

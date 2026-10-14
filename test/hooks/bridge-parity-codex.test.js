'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { buildInstallMirror, createScratch, createScratchGitRepo } = require('../helper/hook-fixtures');

const REPO = path.resolve(__dirname, '../..');
const ROOT = path.join(REPO, 'test/fixtures/hooks/codex');
const scratch = createScratch('doflow-codex-bridge-parity-');
after(() => scratch.remove());

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function noJqPath() {
  const bin = path.join(scratch.dir, 'no-jq-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const command of ['bash', 'cat', 'dirname', 'date', 'mkdir', 'mktemp', 'rm', 'tr', 'sed', 'grep', 'awk', 'git', 'head', 'tail', 'wc', 'sort', 'cut', 'basename', 'env', 'uname', 'find', 'xargs', 'readlink', 'realpath', 'id', 'hostname', 'sleep', 'cp', 'mv', 'touch', 'chmod', 'tee', 'expr', 'test', 'true', 'false', 'od', 'shasum', 'md5', 'python3', 'perl', 'ps', 'stat', 'whoami']) {
    const executable = spawnSync('which', [command], { encoding: 'utf8' }).stdout.trim();
    if (executable && !fs.existsSync(path.join(bin, command))) fs.symlinkSync(executable, path.join(bin, command));
  }
  return bin;
}

function snapshotTaskState(root) {
  const target = path.join(root, '.doflow/state');
  if (!fs.existsSync(target)) return null;
  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push([path.relative(target, full), fs.readFileSync(full, 'base64')]);
    }
  };
  walk(target);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

function project(name, state) {
  const repo = createScratchGitRepo(scratch, name);
  repo.run('checkout', '-q', '-b', 'feat/077-codex');
  if (state === 'no-design' || state === 'all-artifacts') {
    write(path.join(repo.root, 'agent-docs/doflow/077-codex/intention/requirement.md'), '# requirement\n');
    write(path.join(repo.root, 'agent-docs/doflow/077-codex/plan.md'), '- [ ] D.1 [US1] Codex bridge — owner: test; files: src/a.js\n');
  }
  if (state === 'all-artifacts') write(path.join(repo.root, 'agent-docs/doflow/077-codex/design/design.md'), '# design\n');
  return repo.root;
}

function readFixtures() {
  const rows = [];
  for (const stem of fs.readdirSync(ROOT).sort()) {
    const dir = path.join(ROOT, stem);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
      const fixturePath = path.join(dir, name);
      rows.push({ stem, fixturePath, fixture: JSON.parse(fs.readFileSync(fixturePath, 'utf8')) });
    }
  }
  return rows;
}

function run(row, index) {
  const mirror = path.join(scratch.dir, `mirror-${index}`);
  buildInstallMirror(mirror);
  const native = row.fixture.native;
  const projectRoot = project(`project-${index}`, row.fixture.state || 'none');
  const scriptStem = ({ 'post-tool-use': 'post-edit-lint', 'pre-compact': 'pre-compact', 'session-end': 'session-end' })[row.stem] || row.stem;
  const script = path.join(mirror, '.codex/hooks', `${scriptStem}.sh`);
  assert.ok(fs.existsSync(script), `${row.fixturePath}: installed Codex script exists`);
  const trace = path.join(scratch.dir, `trace-${index}.jsonl`);
  const home = path.join(scratch.dir, `home-${index}`);
  const xdg = path.join(scratch.dir, `xdg-${index}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const before = snapshotTaskState(projectRoot);
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_PROJECT_DIR: projectRoot,
    DOFLOW_AGENT: 'codex', DOFLOW_BRIDGE_TRACE: trace, GIT_CONFIG_GLOBAL: '/dev/null',
    ...(row.fixture.env || {}),
  };
  if (row.fixture.fault === 'jq-missing') env.PATH = noJqPath();
  if (row.fixture.policyConfig) write(path.join(mirror, '.doflow/shared/hooks/policies', row.fixture.policyConfig.file), row.fixture.policyConfig.contents);
  const policyPath = path.join(mirror, '.doflow/shared/hooks/policies', `${row.fixture.policy}.sh`);
  let policyBackup;
  if (['crash-exit-1', 'context-crash-exit-1'].includes(row.fixture.fault)) {
    policyBackup = fs.readFileSync(policyPath);
    write(policyPath, "#!/usr/bin/env bash\ncat >/dev/null\nprintf 'private policy stderr' >&2\nexit 1\n");
    fs.chmodSync(policyPath, 0o755);
  }
  const result = spawnSync('bash', [script], { cwd: projectRoot, env, input: `${JSON.stringify(native)}\n`, encoding: 'utf8' });
  if (policyBackup) fs.writeFileSync(policyPath, policyBackup);
  assert.equal(result.error, undefined, `${row.fixturePath}: ${result.error?.message || ''}`);
  assert.equal(result.status, row.fixture.expect.exit, `${row.fixturePath}: exit`);
  if (row.fixture.expect.stdout !== null) assert.equal(result.stdout || '', row.fixture.expect.stdout, `${row.fixturePath}: stdout`);
  if (row.fixture.expect.stderrIncludes !== null) assert.ok((result.stderr || '').includes(row.fixture.expect.stderrIncludes), `${row.fixturePath}: stderr`);
  if (['crash-exit-1', 'context-crash-exit-1'].includes(row.fixture.fault)) {
    assert.ok(!result.stdout.includes('private policy stderr'), `${row.fixturePath}: raw policy stderr is hidden`);
    if (row.fixture.expect.decision.effect === 'block') {
      const body = JSON.parse(result.stdout);
      assert.equal(body.hookSpecificOutput.permissionDecisionReason, `[${row.fixture.policy}] DoFlow policy error; details: doflow-run failure list`, `${row.fixturePath}: fixed error reason`);
    } else {
      assert.equal(result.stdout, '', `${row.fixturePath}: context fault emits no model-visible text`);
    }
  }
  if (row.fixture.expect.modelVisibleBytesMax !== undefined) {
    const visible = native.hook_event_name === 'Stop' ? result.stderr || '' : result.stdout || '';
    assert.ok(Buffer.byteLength(visible) <= row.fixture.expect.modelVisibleBytesMax, `${row.fixturePath}: model-visible bytes`);
  }
  if (row.fixture.expect.taskStateUnchanged) assert.deepEqual(snapshotTaskState(projectRoot), before, `${row.fixturePath}: task state unchanged`);
  if (row.stem === 'post-tool-use' || row.stem === 'pre-compact' || row.stem === 'session-end') {
    assert.equal(fs.existsSync(trace), false, `${row.fixturePath}: fixture-only event has no bridge decision`);
    return;
  }
  if (row.fixture.fault === 'jq-missing') {
    assert.equal(fs.readFileSync(trace, 'utf8').trim(), '', `${row.fixturePath}: jq absence cannot serialize a bridge trace`);
    const failures = path.join(xdg, 'doflow/failures/events.jsonl');
    assert.match(fs.readFileSync(failures, 'utf8'), /"kind":"dependency-missing:jq"/, `${row.fixturePath}: missing jq is captured`);
    return;
  }
  const decision = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
  assert.equal(decision.harness, 'codex', `${row.fixturePath}: harness`);
  assert.equal(decision.event, native.hook_event_name, `${row.fixturePath}: event`);
  assert.equal(decision.policy, row.fixture.policy, `${row.fixturePath}: policy`);
  for (const [key, value] of Object.entries(row.fixture.expect.decision || {})) assert.equal(decision[key], value, `${row.fixturePath}: decision.${key}`);
  const failures = path.join(xdg, 'doflow/failures/events.jsonl');
  const failurePoints = fs.existsSync(failures)
    ? fs.readFileSync(failures, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind)
    : [];
  assert.deepEqual(failurePoints, row.fixture.expect.failurePoint ? [row.fixture.expect.failurePoint] : [], `${row.fixturePath}: failure point`);
}

const rows = readFixtures();
test('Codex corpus covers wired events, apply_patch allow and deny, and each canonical front door perf surface', () => {
  for (const event of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop', 'SessionEnd']) {
    assert.ok(rows.some(({ fixture }) => fixture.native.hook_event_name === event), `fixture exists for ${event}`);
  }
  for (const stem of ['pre-implement-gate', 'pre-bash-guard', 'mcp-tool-guard', 'session-start', 'user-prompt-submit', 'subagent-audit', 'stop-check']) {
    assert.ok(rows.some((row) => row.stem === stem && path.basename(row.fixturePath) === 'perf.json'), `${stem} perf fixture`);
  }
  for (const name of ['deny', 'allow']) assert.ok(rows.some((row) => row.stem === 'pre-implement-gate' && row.fixture.native.tool_name === 'apply_patch' && path.basename(row.fixturePath) === `apply_patch-${name}.json`), `apply_patch ${name} fixture`);
});
rows.forEach((row, index) => test(`Codex parity ${path.relative(ROOT, row.fixturePath)}`, () => run(row, index)));

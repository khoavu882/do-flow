'use strict';
// The Kiro front doors (core/harnesses/kiro/hooks/*.sh) translate a Kiro payload into the canonical
// one before running the shared policies, which stay untouched. Each case runs the front door from
// an install-shaped mirror (test/hooks/build-install-mirror.sh) under a scratch HOME and
// XDG_CONFIG_HOME, in a scratch git repository.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '../..');
const HOOK_TEST = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0 ? test : test.skip; // needs bash + jq
const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

const scratch = createScratch('doflow-kiro-bridge-');
after(() => scratch.remove());

const mirror = path.join(scratch.dir, 'mirror');
const built = spawnSync('bash', [path.join(REPO, 'test', 'hooks', 'build-install-mirror.sh'), mirror], { encoding: 'utf8' });
assert.equal(built.status, 0, built.stderr);
const HOOKS = path.join(mirror, '.kiro', 'hooks');

function env(extra = {}) {
  return scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null', CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '', CODEX_HOME: '', GEMINI_CONFIG_DIR: '', DOFLOW_PROJECT_DIR: '', DOFLOW_AGENT: '', KIRO_SESSION_ID: '', ...extra });
}

function git(cwd, ...args) {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, env: env(), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

/** Runs one front door with `payload` on stdin. */
function runDoor(door, payload, { cwd = scratch.dir, extra = {} } = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync('bash', [path.join(HOOKS, door)], { cwd, env: env(extra), input, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let counter = 0;
/** A git repo on `feat/900-demo` with a feature folder that has requirement.md but no plan.md. */
function featureRepoMissingPlan() {
  const root = path.join(scratch.dir, `repo-${counter += 1}`);
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'checkout', '-q', '-b', 'feat/900-demo');
  const feature = path.join(root, 'agent-docs', 'doflow', '900-demo', 'intention');
  fs.mkdirSync(feature, { recursive: true });
  fs.writeFileSync(path.join(feature, 'requirement.md'), '# requirement\n');
  return root;
}

HOOK_TEST('pre-implement-gate blocks a Kiro `write` to source while plan.md is missing', () => {
  const root = featureRepoMissingPlan();
  const result = runDoor('pre-implement-gate.sh', { hook_event_name: 'preToolUse', cwd: root, tool_name: 'write', tool_input: { command: 'create', path: path.join(root, 'src', 'a.js'), file_text: 'x' } }, { cwd: root });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /missing requirement\.md, design\.md, or plan\.md/);
});

HOOK_TEST('pre-implement-gate blocks a Kiro `fs_write` to source while plan.md is missing', () => {
  const root = featureRepoMissingPlan();
  const result = runDoor('pre-implement-gate.sh', { cwd: root, tool_name: 'fs_write', tool_input: { path: path.join(root, 'src', 'a.js') } }, { cwd: root });
  assert.equal(result.status, 2, result.stderr);
});

HOOK_TEST('pre-implement-gate allows a Kiro write under agent-docs/ and an unrelated tool', () => {
  const root = featureRepoMissingPlan();
  const doc = runDoor('pre-implement-gate.sh', { cwd: root, tool_name: 'write', tool_input: { path: path.join(root, 'agent-docs', 'doflow', '900-demo', 'plan.md') } }, { cwd: root });
  assert.equal(doc.status, 0, doc.stderr);
  const read = runDoor('pre-implement-gate.sh', { cwd: root, tool_name: 'read', tool_input: { path: path.join(root, 'src', 'a.js') } }, { cwd: root });
  assert.equal(read.status, 0, read.stderr);
});

HOOK_TEST('pre-bash-guard blocks a destructive command for `shell` and `execute_bash`', () => {
  for (const tool of ['shell', 'execute_bash']) {
    const result = runDoor('pre-bash-guard.sh', { tool_name: tool, tool_input: { command: 'rm -rf /' } });
    assert.equal(result.status, 2, `${tool}: ${result.stderr}`);
  }
});

HOOK_TEST('pre-bash-guard allows a harmless shell command', () => {
  const result = runDoor('pre-bash-guard.sh', { tool_name: 'shell', tool_input: { command: 'ls -la' } });
  assert.equal(result.status, 0, result.stderr);
});

HOOK_TEST('mcp-tool-guard sees `@server/tool` as mcp__server__tool and lets built-in tools through', () => {
  const policy = path.join(mirror, '.doflow', 'shared', 'hooks', 'policies', 'mcp-policy.conf');
  const original = fs.readFileSync(policy, 'utf8');
  try {
    fs.writeFileSync(policy, `${original}\n^mcp__evil__drop\tblocked in test\n`);
    const blocked = runDoor('mcp-tool-guard.sh', { tool_name: '@evil/drop', tool_input: {} });
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /tool: mcp__evil__drop/);
    const allowed = runDoor('mcp-tool-guard.sh', { tool_name: '@evil/other', tool_input: {} });
    assert.equal(allowed.status, 0, allowed.stderr);
    const builtin = runDoor('mcp-tool-guard.sh', { tool_name: 'shell', tool_input: { command: 'ls' } });
    assert.equal(builtin.status, 0, builtin.stderr);
  } finally {
    fs.writeFileSync(policy, original);
  }
});

const sessionDir = (id) => path.join(scratch.xdg, 'doflow', 'session-env', 'sessions', id);

HOOK_TEST('session-start takes the session from KIRO_SESSION_ID when the payload has none', () => {
  const root = featureRepoMissingPlan();
  const result = runDoor('session-start.sh', { hook_event_name: 'agentSpawn', cwd: root }, { cwd: root, extra: { KIRO_SESSION_ID: 'kiro-x' } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(sessionDir('kiro-x')), 'session directory for kiro-x exists');
});

HOOK_TEST('session-start prefers the payload session_id over KIRO_SESSION_ID', () => {
  const root = featureRepoMissingPlan();
  const result = runDoor('session-start.sh', { hook_event_name: 'agentSpawn', cwd: root, session_id: 'from-payload' }, { cwd: root, extra: { KIRO_SESSION_ID: 'kiro-ignored' } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(sessionDir('from-payload')));
  assert.equal(fs.existsSync(sessionDir('kiro-ignored')), false);
});

/** The bridge function on its own, through a shell that sources the shipped lib.sh. */
function bridge(payload, extra = {}) {
  const result = spawnSync('bash', ['-c', `source "${path.join(HOOKS, 'lib.sh')}"; kiro_bridge_payload`], { env: env(extra), input: payload, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

HOOK_TEST('kiro_bridge_payload maps names, paths, session and the assistant response', () => {
  const write = JSON.parse(bridge(JSON.stringify({ tool_name: 'fs_write', tool_input: { path: '/p/a.js' } })));
  assert.equal(write.tool_name, 'Write');
  assert.equal(write.tool_input.file_path, '/p/a.js');
  assert.equal(write.tool_input.path, '/p/a.js');

  const keep = JSON.parse(bridge(JSON.stringify({ tool_name: 'write', tool_input: { path: '/p/a.js', file_path: '/p/b.js' } })));
  assert.equal(keep.tool_input.file_path, '/p/b.js', 'an existing file_path is not overwritten');

  for (const tool of ['shell', 'execute_bash', 'execute_cmd']) assert.equal(JSON.parse(bridge(JSON.stringify({ tool_name: tool }))).tool_name, 'Bash');
  assert.equal(JSON.parse(bridge(JSON.stringify({ tool_name: '@git/status' }))).tool_name, 'mcp__git__status');
  assert.equal(JSON.parse(bridge(JSON.stringify({ tool_name: 'read' }))).tool_name, 'read', 'an unmapped name passes through');

  assert.equal(JSON.parse(bridge('{}', { KIRO_SESSION_ID: 's1' })).session_id, 's1');
  assert.equal(JSON.parse(bridge('{"session_id":"keep"}', { KIRO_SESSION_ID: 's1' })).session_id, 'keep');
  assert.equal(JSON.parse(bridge('{"session_id":""}', { KIRO_SESSION_ID: 's1' })).session_id, 's1');
  assert.equal('session_id' in JSON.parse(bridge('{}')), false);

  assert.equal(JSON.parse(bridge('{"assistant_response":"done"}')).last_assistant_message, 'done');
  assert.equal(JSON.parse(bridge('{"assistant_response":"a","last_assistant_message":"b"}')).last_assistant_message, 'b');
});

HOOK_TEST('kiro_bridge_payload prints a payload jq cannot parse unchanged', () => {
  assert.equal(bridge('not json {'), 'not json {\n');
  assert.equal(bridge(''), '\n');
});

HOOK_TEST('pre-implement-gate blocks the V3 write family (str_replace, fs_append, delete_file) while plan.md is missing', () => {
  const root = featureRepoMissingPlan();
  for (const tool of ['str_replace', 'fs_append', 'delete_file']) {
    const result = runDoor('pre-implement-gate.sh', { cwd: root, tool_name: tool, tool_input: { path: path.join(root, 'src', 'a.js') } }, { cwd: root });
    assert.equal(result.status, 2, `${tool}: ${result.stderr}`);
  }
});

HOOK_TEST('pre-bash-guard blocks a destructive command for `execute_pwsh`', () => {
  const result = runDoor('pre-bash-guard.sh', { tool_name: 'execute_pwsh', tool_input: { command: 'rm -rf /' } });
  assert.equal(result.status, 2, result.stderr);
});

HOOK_TEST('kiro_bridge_payload maps the V3 write family and execute_pwsh, and leaves mcp_ IDs unchanged', () => {
  for (const tool of ['fs_append', 'str_replace', 'delete_file', 'write_file']) {
    const mapped = JSON.parse(bridge(JSON.stringify({ tool_name: tool, tool_input: { path: '/p/a.js' } })));
    assert.equal(mapped.tool_name, 'Write', tool);
    assert.equal(mapped.tool_input.file_path, '/p/a.js', tool);
  }
  assert.equal(JSON.parse(bridge(JSON.stringify({ tool_name: 'execute_pwsh' }))).tool_name, 'Bash');
  assert.equal(JSON.parse(bridge(JSON.stringify({ tool_name: 'mcp_evil_drop' }))).tool_name, 'mcp_evil_drop');
  assert.equal(JSON.parse(bridge(JSON.stringify({ tool_name: 'read_file' }))).tool_name, 'read_file');
});

HOOK_TEST('mcp-tool-guard evaluates a V3 `mcp_<server>_<tool>` ID against the policy', () => {
  const policy = path.join(mirror, '.doflow', 'shared', 'hooks', 'policies', 'mcp-policy.conf');
  const original = fs.readFileSync(policy, 'utf8');
  try {
    fs.writeFileSync(policy, `${original}\n^mcp_evil_drop\tblocked in test\n`);
    const blocked = runDoor('mcp-tool-guard.sh', { tool_name: 'mcp_evil_drop', tool_input: {} });
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /tool: mcp_evil_drop/);
    const allowed = runDoor('mcp-tool-guard.sh', { tool_name: 'mcp_evil_other', tool_input: {} });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    fs.writeFileSync(policy, original);
  }
});

HOOK_TEST('stop-check on a V3 payload turns a deny into a JSON block with exit 0, and blocks a message once', () => {
  const payload = { session_id: 's1', assistant_response: '// TODO finish' };
  const first = runDoor('stop-check.sh', payload);
  assert.equal(first.status, 0, first.stderr);
  const decision = JSON.parse(first.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /unfinished-work/);

  const again = runDoor('stop-check.sh', payload);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, '');
});

HOOK_TEST('stop-check on a 2.x payload without session_id keeps exit 2 with the reason on stderr', () => {
  const result = runDoor('stop-check.sh', { hook_event_name: 'stop', assistant_response: '// TODO finish' }, { extra: { KIRO_SESSION_ID: 'kiro-2x' } });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unfinished-work/);
  assert.equal(result.stdout, '');
});

HOOK_TEST('stop-check exits 0 with empty stdout for a clean message on either engine', () => {
  const v3 = runDoor('stop-check.sh', { session_id: 's-clean', assistant_response: 'All done.' });
  assert.equal(v3.status, 0, v3.stderr);
  assert.equal(v3.stdout, '');
  const legacy = runDoor('stop-check.sh', { assistant_response: 'All done.' }, { extra: { KIRO_SESSION_ID: 'kiro-clean' } });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(legacy.stdout, '');
});

HOOK_TEST('doflow.json scopes the MCP guard with the V3 `@mcp` selector', () => {
  const config = JSON.parse(fs.readFileSync(path.join(HOOKS, 'doflow.json'), 'utf8'));
  const guard = config.hooks.find((hook) => hook.name === 'doflow-mcp-tool-guard');
  assert.equal(guard.matcher, '@mcp');
});

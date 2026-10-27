'use strict';

// D.3 of feature 078 (IC-016, IC-022 check-freshness part, DEC-017, FR-009): checks are never
// deduplicated. The pre-implementation gate, pre-bash-guard and mcp-tool-guard are driven through
// the installed front doors of each bridged harness. The same event (same tool-call id) is replayed
// after the state it is judged against changes, and every replay must return the verdict for the
// state that holds at that moment, in both directions. Kiro's two PreToolUse paths (the IDE hook's
// `PreToolUse` and the agent config's `preToolUse`) must both evaluate.
//
// State per policy: the gate reads the project's feature artifacts (design.md present or missing);
// pre-bash-guard and mcp-tool-guard are stateless apart from their installed pattern files
// (blocked-patterns.conf, mcp-policy.conf), so their state is that file in the install mirror.
//
// The project, mirror and front-door execution follow test/hooks/cross-harness-parity.test.js
// (makeProject, prepareMirror, executeShell, executePi); temp dirs come from test/helper/tmp.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { buildInstallMirror, createScratchGitRepo } = require('../helper/hook-fixtures.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'test/fixtures/hooks');
const POLICIES = ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard'];
const STEM: any = { 'pre-implementation-gate': 'pre-implement-gate', 'pre-bash-guard': 'pre-bash-guard', 'mcp-tool-guard': 'mcp-tool-guard' };

// Committed native deny fixtures, by harness and policy. Kiro's IDE path is deny.json
// (`PreToolUse`), its agent-config path agent-deny.json (`preToolUse`).
const FIXTURE: any = {
  claude: { 'pre-implementation-gate': 'claude/pre-implement-gate/deny.json', 'pre-bash-guard': 'claude/pre-bash-guard/deny.json', 'mcp-tool-guard': 'claude/mcp-tool-guard/deny.json' },
  codex: { 'pre-implementation-gate': 'codex/pre-implement-gate/deny.json', 'pre-bash-guard': 'codex/pre-bash-guard/deny.json', 'mcp-tool-guard': 'codex/mcp-tool-guard/deny.json' },
  kiro: { 'pre-implementation-gate': 'kiro/pre-implement-gate/deny.json', 'pre-bash-guard': 'kiro/pre-bash-guard/deny.json', 'mcp-tool-guard': 'kiro/mcp-tool-guard/deny.json' },
  'kiro-agent': { 'pre-implementation-gate': 'kiro/pre-implement-gate/agent-deny.json', 'pre-bash-guard': 'kiro/pre-bash-guard/agent-deny.json', 'mcp-tool-guard': 'kiro/mcp-tool-guard/agent-deny.json' },
  antigravity: { 'pre-implementation-gate': 'antigravity/pre-implement-gate/deny-missing-design.json' },
  pi: { 'pre-implementation-gate': 'pi/tool_call/edit-deny.json', 'pre-bash-guard': 'pi/tool_call/bash-deny.json', 'mcp-tool-guard': 'pi/tool_call/nested-mcp-deny.json' },
};

// One pattern file per verdict. The deny lines match every harness's fixture tool or command
// (claude/codex `mcp__blocked__write`, kiro `@evil/drop` and
// `@evil/delete_repo`, pi `mcp__github__delete_issue`); the allow lines match nothing.
const CONF: any = {
  'pre-bash-guard': {
    file: 'blocked-patterns.conf',
    deny: 'git[[:space:]]+reset[[:space:]]+--hard\tFreshness probe blocked\n',
    allow: '^doflow-freshness-unmatched-probe$\tunused\n',
  },
  'mcp-tool-guard': {
    file: 'mcp-policy.conf',
    deny: '(blocked|evil_+(drop|delete)|delete_issue)\tFreshness probe MCP blocked\n',
    allow: '^doflow-freshness-unmatched-probe$\tunused\n',
  },
};

function write(file: any, contents: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** A scratch area rooted in a tmp.js temp dir, shaped like hook-fixtures' createScratch. */
function scratchFor(t: any) {
  const dir = tempDir(t, 'doflow-check-freshness-');
  return { dir, path: (...parts: any[]) => path.join(dir, ...parts) };
}

/** cross-harness-parity's makeProject: a feat/ checkout whose features lack design.md. */
function makeProject(scratch: any, name: any) {
  const project = createScratchGitRepo(scratch, name);
  project.run('checkout', '-q', '-b', 'feat/078-d3');
  for (const slug of ['078-d3', 'pi-gate']) {
    const feature = path.join(project.root, 'agent-docs/doflow', slug);
    write(path.join(feature, 'intention/requirement.md'), '# requirement\n');
    write(path.join(feature, 'plan.md'), '- [ ] D.3 [US4] freshness — owner: test; files: test/hooks/check-freshness.test.ts\n');
  }
  return project.root;
}

function prepareMirror(scratch: any, name: any) {
  return buildInstallMirror(scratch.path(`mirror-${name}`));
}

/** Put the state the policy reads into the shape that yields `verdict` ('deny' | 'allow'). */
function setState(policy: any, verdict: any, { project, mirror }: any) {
  if (policy === 'pre-implementation-gate') {
    for (const slug of ['078-d3', 'pi-gate']) {
      const design = path.join(project, 'agent-docs/doflow', slug, 'design/design.md');
      if (verdict === 'allow') write(design, '# design\n');
      else fs.rmSync(design, { force: true });
    }
    return;
  }
  const conf = CONF[policy];
  write(path.join(mirror, '.doflow/shared/hooks/policies', conf.file), conf[verdict]);
}

/** The native event for one harness and policy, carrying a fixed tool-call id. */
function eventFor(harness: any, policy: any, id: any) {
  const rel = FIXTURE[harness]?.[policy];
  if (!rel) return null;
  const native = JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8')).native;
  if (harness === 'pi') {
    native.toolCallId = id;
    if (policy === 'pre-bash-guard') native.input = { command: 'git reset --hard' };
  } else {
    native.tool_use_id = id;
    if (policy === 'pre-bash-guard') native.tool_input = { command: 'git reset --hard' };
  }
  return native;
}

/** cross-harness-parity's executeShell, reduced to the three pre-tool policies. */
function runShell(harness: any, policy: any, native: any, { project, mirror, scratch }: any, index: any) {
  const home = scratch.path(`home-${index}`);
  const xdg = scratch.path(`xdg-${index}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const input = JSON.parse(JSON.stringify(native));
  let command = 'bash';
  let args;
  if (harness === 'antigravity') {
    if (Array.isArray(input.workspacePaths)) input.workspacePaths = [project];
    command = process.execPath;
    args = [path.join(mirror, '.doflow/shared/hooks/stream-hook-runner.js'), 'PreToolUse'];
  } else {
    args = [path.join(mirror, `.${harness}/hooks/${STEM[policy]}.sh`)];
  }
  const env: any = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_PROJECT_DIR: project,
    DOFLOW_AGENT: harness, GIT_CONFIG_GLOBAL: '/dev/null',
  };
  delete env.KIRO_SESSION_ID;
  const result = spawnSync(command, args, { cwd: project, input: `${JSON.stringify(input)}\n`, encoding: 'utf8', env });
  assert.equal(result.error, undefined, result.error?.message);
  let response: any = {};
  try { response = JSON.parse(result.stdout || '{}'); } catch { response = {}; }
  const denied = harness === 'kiro' ? result.status === 2
    : harness === 'antigravity' ? response.decision === 'deny'
      : response.hookSpecificOutput?.permissionDecision === 'deny';
  if (!denied) assert.equal(result.status, 0, `${harness}/${policy}: allow exits 0 (${result.stderr})`);
  return denied;
}

/** cross-harness-parity's executePi: the real Pi extension, loaded once, bridged to the mirror. */
async function piHandler({ project, mirror }: any, tag: any) {
  const extensionDir = path.join(project, '.pi/extensions');
  fs.mkdirSync(extensionDir, { recursive: true });
  const source = fs.readFileSync(path.join(REPO, 'core/harnesses/pi/extensions/doflow-guard.js'), 'utf8');
  const bridgeUrl = pathToFileURL(path.join(mirror, '.doflow/shared/hooks/bridge/bridge.sh')).href;
  const rendered = source.replace("const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);", `const BRIDGE = new URL(${JSON.stringify(bridgeUrl)});`);
  assert.notEqual(rendered, source, 'Pi extension bridge URL is install-shaped');
  const extensionPath = path.join(extensionDir, 'doflow-guard.mjs');
  fs.writeFileSync(extensionPath, rendered);
  let handler: any;
  const { default: register } = await import(`${pathToFileURL(extensionPath).href}?case=${tag}`);
  register({ on(name: any, callback: any) { assert.equal(name, 'tool_call'); handler = callback; } });
  return async (native: any) => {
    const result = await handler(native, { cwd: project, sessionManager: { getSessionId: () => 'freshness-session' } });
    if (result !== undefined) assert.equal(result.block, true, 'Pi answer is a block or undefined');
    return result?.block === true;
  };
}

/**
 * Replay ONE event (fixed tool-call id) once per step, setting the state to `step` before each
 * replay. `paths` lists the front doors that receive the event at each step (Kiro: both paths).
 * Returns the observed verdicts, one 'deny' | 'allow' per (step, path).
 */
async function replay(t: any, { harness, policy, steps, mirrorHook }: any) {
  const scratch = scratchFor(t);
  const ctx = { scratch, project: makeProject(scratch, `${harness}-${policy}`), mirror: prepareMirror(scratch, `${harness}-${policy}`) };
  if (mirrorHook) mirrorHook(ctx.mirror);
  const id = `freshness-${harness}-${policy}`;
  const paths = harness === 'kiro' ? ['kiro', 'kiro-agent'] : [harness];
  const pi = harness === 'pi' ? await piHandler(ctx, `${policy}-${Date.now()}-${Math.random()}`) : null;
  const observed = [];
  let index = 0;
  for (const step of steps) {
    setState(policy, step, ctx);
    for (const door of paths) {
      const native = eventFor(door, policy, id);
      assert.ok(native, `${door}/${policy}: committed native deny fixture exists`);
      const denied = pi ? await pi(native) : runShell(door === 'kiro-agent' ? 'kiro' : door, policy, native, ctx, index);
      observed.push(denied ? 'deny' : 'allow');
      index += 1;
    }
  }
  return { observed, expected: steps.flatMap((step: any) => paths.map(() => step)) };
}

/** The freshness assertion every case uses; the negative control proves it fails on a cache. */
function assertFresh(label: any, { observed, expected }: any) {
  assert.deepEqual(observed, expected, `${label}: each replay of the same event id returns the verdict for the current state`);
}

const COVERAGE = [
  ...['claude', 'codex', 'kiro', 'antigravity', 'pi'].map((harness) => [harness, 'pre-implementation-gate']),
  ...['claude', 'codex', 'kiro', 'pi'].flatMap((harness) => [[harness, 'pre-bash-guard'], [harness, 'mcp-tool-guard']]),
];

for (const [harness, policy] of COVERAGE) {
  test(`IC-016: ${harness}/${policy} re-evaluates the same event id after the state changes, deny → allow → deny`, async (t) => {
    assertFresh(`${harness}/${policy}`, await replay(t, { harness, policy, steps: ['deny', 'allow', 'deny'] }));
  });
}

test('IC-016: Kiro\'s two PreToolUse paths both evaluate, including when the state changes between them', async (t) => {
  const scratch = scratchFor(t);
  for (const policy of POLICIES) {
    const ctx = { scratch, project: makeProject(scratch, `kiro-double-${policy}`), mirror: prepareMirror(scratch, `kiro-double-${policy}`) };
    const id = `freshness-kiro-double-${policy}`;
    for (const [first, second] of [['deny', 'allow'], ['allow', 'deny']]) {
      for (const [door1, door2] of [['kiro', 'kiro-agent'], ['kiro-agent', 'kiro']]) {
        setState(policy, first, ctx);
        const one = runShell('kiro', policy, eventFor(door1, policy, id), ctx, `${policy}-${first}-${door1}-1`);
        setState(policy, second, ctx);
        const two = runShell('kiro', policy, eventFor(door2, policy, id), ctx, `${policy}-${first}-${door1}-2`);
        assert.deepEqual([one ? 'deny' : 'allow', two ? 'deny' : 'allow'], [first, second],
          `kiro/${policy}: ${door1} then ${door2} for one event id each evaluate against current state`);
      }
    }
  }
});

// Negative control (plan D.3): a policy that caches its verdict by tool-call id. The wrapper replaces
// the policy in the test's install mirror (never the repo file) and replays the first verdict for a
// repeated id. assertFresh must reject the stale verdicts it produces.
function installEventIdCache(mirror: any, policy: any) {
  const dir = path.join(mirror, '.doflow/shared/hooks/policies');
  fs.renameSync(path.join(dir, `${policy}.sh`), path.join(dir, `${policy}.uncached.sh`));
  write(path.join(dir, `${policy}.sh`), `#!/usr/bin/env bash
here=\${0%/*}
input=$(cat)
key=$(printf '%s' "$input" | jq -j '.tool_use_id // .toolCallId // .doflow_event.correlation.toolCallId // empty' | tr -c 'A-Za-z0-9._-' '_')
cache="$here/.verdict-cache/$key"
if [ -n "$key" ] && [ -f "$cache.code" ]; then
  cat "$cache.out"; cat "$cache.err" >&2; exit "$(cat "$cache.code")"
fi
mkdir -p "$here/.verdict-cache"
bash "$here/${policy}.uncached.sh" <<<"$input" >"$cache.out" 2>"$cache.err" 3>&2
code=$?
printf '%s' "$code" >"$cache.code"
cat "$cache.out"; cat "$cache.err" >&2
exit "$code"
`);
  fs.chmodSync(path.join(dir, `${policy}.sh`), 0o755);
}

for (const [harness, policy] of [['claude', 'pre-implementation-gate'], ['claude', 'pre-bash-guard'], ['claude', 'mcp-tool-guard'], ['kiro', 'pre-implementation-gate'], ['pi', 'pre-implementation-gate']]) {
  test(`negative control: a ${policy} copy that caches by event id gives stale verdicts on ${harness} and fails the freshness assertion`, async (t) => {
    for (const steps of [['deny', 'allow'], ['allow', 'deny']]) {
      const run = await replay(t, { harness, policy, steps, mirrorHook: (mirror: any) => installEventIdCache(mirror, policy) });
      const first = steps[0];
      assert.deepEqual(run.observed, run.expected.map(() => first), `${harness}/${policy}: the cached copy replays the first verdict for every repeat`);
      assert.throws(() => assertFresh(`${harness}/${policy} (cached)`, run), assert.AssertionError, 'assertFresh detects the stale verdict');
    }
  });
}

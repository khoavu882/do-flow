'use strict';

// Feature 088 D.2 (IC-018, IC-001, IC-003, IC-004, IC-006, IC-010, IC-011; FR-001, FR-003, FR-004,
// FR-005, FR-006, NFR-004; G-O2): committed end-to-end canary privacy test.
//
// In one isolated temporary project (`.doflow/state/runs`, `DOFLOW_TELEMETRY=on`, `DOFLOW_CONFIG_DIR`
// pointing at the project's `.doflow`, scratch HOME and XDG_CONFIG_HOME inside the temp tree), unique
// per-run random hex canaries are planted in:
//   1. an environment variable value (`CANARY_SECRET`),
//   2. a command argument (`argv`),
//   3. a directory and file path component (`path`),
//   4. a prompt text passed to a hook (`prompt`),
//   5. tool output printed by a verified command (`output`, assembled at runtime so it is not in argv),
//   6. a fine-tuned model id of the form `ft:<canary>` (`model`), and
//   7. an MCP tool name of the form `mcp__<canary>__tool` (`mcp`),
//   8. the feature slug (`slug`, 091 E.1), and
//   9. a hook session id (`session`, 091 E.1): a T0 identifier the local store and the local analyze
//      view may hold, which the OTLP export must never carry (IC-008 rule 2).
//
// Every O0 telemetry producer is exercised against that single project:
//   (a) `doflow verify` CLI with one passing and one failing check whose command and output hold canaries,
//   (b) the shared hook bridge across `pre-bash-guard` (all 6 harnesses + MCP tool calls) and
//       `user-prompt-submit` (claude and codex),
//   (c) 080 `task-run` `start` and acknowledged `resume`,
//   (d) `doflow trace spans --json` over the resulting project state.
//
// Every file under `.doflow/state/runs/` (including `telemetry/*.jsonl`) and the captured stdout/stderr
// of `trace spans` are byte-searched for each canary (full string AND its first 8 characters): zero
// hits. Every written line is also checked against `core/registry/telemetry.json` for allowlist key
// equality per kind and a 256-byte ceiling per value, plus `leak-scan.ts` as an extra check (S-31).
//
// 091 E.1 (NFR-001, FR-010, IC-008): the same project also feeds `trace analyze --json`,
// `trace analyze --emit evidence`, `trace analyze --emit followups` and
// `trace export --otlp-http --dry-run`; the stdout and stderr of each are searched for every content
// canary (full and first 8 characters) and the dry run also for the session canary: zero hits.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir, removeTree } = require('../helper/tmp');
const { buildInstallMirror } = require('../helper/hook-fixtures');
const { start, pause, resume } = require('../../src/runtime/task-attempts.ts');
const { scanPaths } = require('../../src/runtime/leak-scan.ts');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const FIXTURES = path.join(REPO, 'test/fixtures/hooks');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/telemetry.json'), 'utf8'));
const BASH = '/bin/bash';
const MAX_VALUE_BYTES = 256;

const SURFACES = {
  'claude:pre-bash-guard': { harness: 'claude', event: 'PreToolUse', policy: 'pre-bash-guard', door: '.claude/hooks/pre-bash-guard.sh', fixture: 'claude/pre-bash-guard/perf.json' },
  'codex:pre-bash-guard': { harness: 'codex', event: 'PreToolUse', policy: 'pre-bash-guard', door: '.codex/hooks/pre-bash-guard.sh', fixture: 'codex/pre-bash-guard/perf.json' },
  'gemini:pre-bash-guard': { harness: 'gemini', event: 'BeforeTool', policy: 'pre-bash-guard', door: '.gemini/hooks/pre-bash-guard.sh', fixture: 'gemini/pre-bash-guard/perf.json' },
  'kiro:pre-bash-guard': { harness: 'kiro', event: 'PreToolUse', policy: 'pre-bash-guard', door: '.kiro/hooks/pre-bash-guard.sh', fixture: 'kiro/pre-bash-guard/perf.json' },
  'antigravity:pre-bash-guard': { harness: 'antigravity', event: 'PreToolUse', policy: 'pre-bash-guard', runner: true, fixture: 'antigravity/pre-bash-guard/perf.json' },
  'pi:pre-bash-guard': { harness: 'pi', event: 'tool_call', policy: 'pre-bash-guard', bridge: true, fixture: 'pi/tool_call/perf-bash.json' },
  'claude:user-prompt-submit': { harness: 'claude', event: 'UserPromptSubmit', policy: 'user-prompt-submit', door: '.claude/hooks/user-prompt-submit.sh', fixture: 'claude/user-prompt-submit/perf.json' },
  'codex:user-prompt-submit': { harness: 'codex', event: 'UserPromptSubmit', policy: 'user-prompt-submit', door: '.codex/hooks/user-prompt-submit.sh', fixture: 'codex/user-prompt-submit/perf.json' },
};

const suiteRoot = suiteTempDir('doflow-telemetry-canary-');
after(() => removeTree(suiteRoot));

/**
 * Generates unique per-run canary strings. Each starts with `cnry` + a slot tag digit + 24 random hex
 * characters, so both the full string (29 chars) and its first 8 characters (`cnry<tag><3 hex>`) are
 * unique per slot, unique per run, and contain non-hex characters (`n`, `r`, `y`) that cannot collide
 * with random hex16/hex32 identifiers (`verify_id`, `traceId`, `spanId`).
 */
function createCanaries() {
  const mint = (tag) => `cnry${tag}${crypto.randomBytes(12).toString('hex')}`;
  const raw = {
    env: mint('1'),
    argv: mint('2'),
    path: mint('3'),
    prompt: mint('4'),
    output: mint('5'),
    model: mint('6'),
    mcp: mint('7'),
    slug: mint('8'),
    session: mint('9'),
  };
  return {
    ...raw,
    modelId: `ft:${raw.model}`,
    mcpTool: `mcp__${raw.mcp}__tool`,
  };
}

/** Recursively lists all regular files under `dir`, sorted by relative path. */
function listFilesRec(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRec(full, base));
    else if (entry.isFile()) out.push({ rel: path.relative(base, full), abs: full });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Content canaries: never in any store or output. `slug` and `session` are identifiers, scanned per output. */
const CONTENT_KEYS = ['env', 'argv', 'path', 'prompt', 'output', 'model', 'mcp'];

/** Needles for `keys`: each canary's full string and its first 8 characters, plus the derived model id and MCP name. */
function canaryNeedles(canaries, keys) {
  const needles = [];
  for (const key of keys) {
    const full = canaries[key];
    const prefix8 = full.slice(0, 8);
    assert.equal(prefix8.length, 8, `canary ${key} prefix8 must be 8 chars`);
    needles.push({ label: `${key}:full`, bytes: Buffer.from(full, 'utf8') });
    needles.push({ label: `${key}:prefix8`, bytes: Buffer.from(prefix8, 'utf8') });
  }
  if (keys.includes('model')) {
    needles.push({ label: 'modelId:full', bytes: Buffer.from(canaries.modelId, 'utf8') });
    needles.push({ label: 'modelId:prefix8', bytes: Buffer.from(canaries.modelId.slice(0, 8), 'utf8') });
  }
  if (keys.includes('mcp')) needles.push({ label: 'mcpTool:full', bytes: Buffer.from(canaries.mcpTool, 'utf8') });
  return needles;
}

/** Byte-searches named outputs `[{ name, text }]` for the needles of `keys`; returns one error per hit. */
function scanOutputs(outputs, canaries, keys) {
  const needles = canaryNeedles(canaries, keys);
  const errors = [];
  for (const { name, text } of outputs) {
    const buf = Buffer.from(text || '', 'utf8');
    for (const needle of needles) {
      if (buf.includes(needle.bytes)) errors.push(`canary leak in ${name}: matched ${needle.label}`);
    }
  }
  return errors;
}

/**
 * Scanner over a canary run's outputs:
 *   1. Byte-searches every file under `runsDir` (including `telemetry/*.jsonl`) and `spansStdout` /
 *      `spansStderr` for each canary's full string AND its first 8 characters.
 *   2. Checks non-circular allowlist equality: every key on every written telemetry line is declared
 *      in `registry` for its `kind`, and every declared key for each kind is present.
 *   3. Checks that no value in any written telemetry line exceeds 256 bytes (`MAX_VALUE_BYTES`).
 */
function scanCanaryRun({ runsDir, spansStdout = '', spansStderr = '', canaries, registry = REGISTRY }) {
  const errors = [];
  const files = listFilesRec(runsDir);
  if (files.length === 0) errors.push('no files found under .doflow/state/runs');

  const needles = canaryNeedles(canaries, CONTENT_KEYS);

  const targets = [
    ...files.map((f) => ({ name: `runs/${f.rel}`, buf: fs.readFileSync(f.abs) })),
    { name: 'trace-spans:stdout', buf: Buffer.from(spansStdout, 'utf8') },
    { name: 'trace-spans:stderr', buf: Buffer.from(spansStderr, 'utf8') },
  ];

  for (const target of targets) {
    for (const needle of needles) {
      if (target.buf.includes(needle.bytes)) {
        errors.push(`canary leak in ${target.name}: matched ${needle.label}`);
      }
    }
  }

  const commonKeys = registry.common || [];
  const seenKeysByKind = new Map(Object.keys(registry.kinds).map((k) => [k, new Set()]));
  let totalLines = 0;

  for (const f of files.filter((entry) => entry.rel.endsWith('.jsonl'))) {
    const raw = fs.readFileSync(f.abs, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    lines.forEach((lineText, idx) => {
      totalLines += 1;
      const locator = `runs/${f.rel}:${idx + 1}`;
      let parsed;
      try {
        parsed = JSON.parse(lineText);
      } catch {
        errors.push(`${locator}: invalid JSON`);
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(`${locator}: record is not an object`);
        return;
      }
      const kind = parsed.kind;
      if (typeof kind !== 'string' || !Object.hasOwn(registry.kinds, kind)) {
        errors.push(`${locator}: unknown kind '${String(kind)}'`);
        return;
      }
      const declaredFields = Object.keys(registry.kinds[kind].fields || {});
      const allowed = new Set([...commonKeys, ...declaredFields]);
      for (const [k, v] of Object.entries(parsed)) {
        if (!allowed.has(k)) {
          errors.push(`${locator}: kind ${kind} has undeclared key '${k}'`);
        } else if (!commonKeys.includes(k)) {
          seenKeysByKind.get(kind).add(k);
        }
        const valueStr = typeof v === 'string' ? v : JSON.stringify(v);
        const byteLen = Buffer.byteLength(valueStr, 'utf8');
        if (byteLen > MAX_VALUE_BYTES) {
          errors.push(`${locator}: key '${k}' value length ${byteLen} exceeds ${MAX_VALUE_BYTES} bytes`);
        }
      }
      for (const reqKey of allowed) {
        if (!Object.hasOwn(parsed, reqKey)) {
          errors.push(`${locator}: kind ${kind} is missing declared key '${reqKey}'`);
        }
      }
    });
  }

  if (totalLines === 0) errors.push('zero JSONL lines written under .doflow/state/runs');
  for (const [kind, spec] of Object.entries(registry.kinds)) {
    const seen = seenKeysByKind.get(kind) || new Set();
    for (const key of Object.keys(spec.fields || {})) {
      if (!seen.has(key)) errors.push(`kind ${kind} declared key '${key}' was never written`);
    }
  }

  return errors;
}

/** Runs one complete canary fixture across all four producers in a single temporary project. */
function runCanaryFixture() {
  const canaries = createCanaries();
  const SLUG = `feat-${canaries.slug}`;
  const home = path.join(suiteRoot, 'home');
  const xdg = path.join(suiteRoot, 'xdg');
  const root = path.join(suiteRoot, `proj-${canaries.path}`);
  const configDir = path.join(root, '.doflow');
  const runsDir = path.join(configDir, 'state', 'runs');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'doflow', 'prune'), 'off\n');
  fs.mkdirSync(root, { recursive: true });

  // Build the install mirror so all harness hook front doors and the shared bridge live in `root`.
  buildInstallMirror(root);
  fs.mkdirSync(runsDir, { recursive: true });

  // Clean child environment: explicit DOFLOW_TELEMETRY=on, DOFLOW_CONFIG_DIR, scratch HOME/XDG,
  // run identity, plus the planted env and model canaries.
  const baseEnv = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (k.startsWith('DOFLOW_') || k.startsWith('OTEL_') || k === 'EPOCHREALTIME' || k === 'FORCE_COLOR' || k === 'PI_CODING_AGENT_DIR') {
      delete baseEnv[k];
    }
  }
  const childEnv = (extra = {}) => ({
    ...baseEnv,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    DOFLOW_CONFIG_DIR: configDir,
    DOFLOW_TELEMETRY: 'on',
    DOFLOW_FAILURE_CAPTURE: 'off',
    DOFLOW_RUN_ID: 'r-canary',
    DOFLOW_LINEAGE_ID: 'main',
    DOFLOW_ATTEMPT: '1',
    CANARY_SECRET: canaries.env,
    DOFLOW_MODEL: canaries.modelId,
    OPENAI_MODEL: canaries.modelId,
    ANTHROPIC_MODEL: canaries.modelId,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.test',
    ...extra,
  });

  const git = (...args) => {
    const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: childEnv() });
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  };

  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\n');
  const canarySubdir = path.join(root, 'src', canaries.path);
  fs.mkdirSync(canarySubdir, { recursive: true });
  const sourceRel = `src/${canaries.path}/mod-${canaries.path}.js`;
  fs.writeFileSync(path.join(root, sourceRel), 'module.exports = 1;\n');
  const featurePlan = path.join(root, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(featurePlan), { recursive: true });
  fs.writeFileSync(featurePlan, [
    '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
    `- [ ] A.1 task; owner: core-implementer; files: ${sourceRel}`, '',
  ].join('\n'));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  // Producer (c): task-run start, pause, and acknowledged resume (minting two linked traceIds).
  // Timestamps sit just before the live verify and hook calls so their records join the resumed trace.
  const nowMs = Date.now();
  const tStart = new Date(nowMs - 20_000);
  const tPause = new Date(nowMs - 15_000);
  const tResume = new Date(nowMs - 10_000);
  const attemptsFile = path.join(configDir, 'state', 'task-attempts', `${SLUG}.json`);
  const taskRunCommon = (now) => ({
    file: attemptsFile,
    fsImpl: fs,
    roots: [root],
    slug: SLUG,
    now,
    env: childEnv({ DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: root }),
    cwd: root,
  });
  const gitRunner = (args) => (args[0] === 'symbolic-ref' ? 'feat/088-verification-baseline\n' : null);
  assert.equal(start({ ...taskRunCommon(tStart), by: 'orchestrator' }).disposition, 'started');
  assert.equal(pause({ ...taskRunCommon(tPause), by: 'orchestrator', reason: 'pause' }).disposition, 'paused');
  const asked = resume({ ...taskRunCommon(tResume), gitRunner });
  assert.equal(asked.disposition, 'ack-required');
  assert.equal(resume({ ...taskRunCommon(tResume), ack: asked.digest, by: 'orchestrator', gitRunner }).disposition, 'resumed');

  // Producer (a): verification verb on the tmp repo — one passing run and one failing run.
  // The output canary is split across two string literals in the command expression so that neither
  // the full output canary nor its 8-char prefix appears in the command argument text itself.
  const outPrefix = canaries.output.slice(0, 4);
  const outSuffix = canaries.output.slice(4);
  const outputExpr = `['${outPrefix}','${outSuffix}'].join('')`;
  const runVerify = (fail) => {
    const planRel = `plan-${canaries.path}.md`;
    const planAbs = path.join(root, planRel);
    const testCmd = `node -e "console.log(${outputExpr}); process.exit(${fail ? 1 : 0})" ${canaries.argv} ${canaries.modelId}`;
    const override = {
      parse: null,
      build: `node -e 0 ${canaries.argv}`,
      typecheck: null,
      lint: `node -e 0 ${canaries.path}`,
      test: testCmd,
      testTargeted: 'node -e 0 {pattern}',
    };
    fs.writeFileSync(planAbs, `# Plan\n\n\`\`\`doflow-verification\n${JSON.stringify(override)}\n\`\`\`\n`);
    const res = spawnSync(process.execPath, [
      DOFLOW, 'verify', '--task-id', 'A.1', '--risk', 'LOW',
      '--plan-path', planAbs, '--scope', `${sourceRel},${planRel}`, '--json',
    ], { cwd: root, env: childEnv(), encoding: 'utf8' });
    assert.equal(res.status, fail ? 1 : 0, `verify (fail=${fail}): ${res.stdout}\n${res.stderr}`);
    return res;
  };
  const verifyPass = runVerify(false);
  const verifyFail = runVerify(true);
  // A second failing run of the same class makes a retry-loops finding (retryRun 2), so both batches
  // printed by `trace analyze --emit` hold items for the 091 canary search.
  runVerify(true);

  // Confirm the failing verify check genuinely printed the output canary into the verification failure log.
  const verifyLogDir = path.join(root, '.doflow', 'state', 'verification', 'logs');
  const verifyLogBytes = fs.readdirSync(verifyLogDir)
    .map((f) => fs.readFileSync(path.join(verifyLogDir, f), 'utf8'))
    .join('');
  assert.equal(verifyLogBytes.includes(canaries.output), true, 'verified command printed the output canary');

  // Producer (e, 095): `review --action check` on a record whose path, locators, summaries, sweep and
  // ids carry the content canaries; its review.run line holds counts only.
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: childEnv() }).stdout.trim();
  const reviewFile = path.join(canarySubdir, `findings-${canaries.path}.json`);
  fs.writeFileSync(reviewFile, JSON.stringify({
    schema: 1, row: '095', slug: '095-canary', reviewedHead: head, rounds: 1,
    seats: [{ id: `seat-${canaries.argv}`, findings: [{ id: `F-${canaries.prompt}`, severity: 'blocker', locator: `${sourceRel}:1`, summary: `${canaries.output} ${canaries.modelId}` }] }],
    converged: [{ id: `C-${canaries.mcp}`, from: [`F-${canaries.prompt}`], severity: 'blocker', locator: `${sourceRel}:1`, status: 'open',
      bugClass: `class-${canaries.env}`, sweep: `rg ${canaries.argv} ${canaries.mcpTool}` }],
  }));
  const reviewRes = spawnSync(process.execPath, [DOFLOW, 'review', '--action', 'check', '--path', reviewFile, '--json'],
    { cwd: root, env: childEnv(), encoding: 'utf8' });
  assert.equal(reviewRes.status, 0, `review check: ${reviewRes.stdout}\n${reviewRes.stderr}`);

  // Producer (b): bridge hook path across pre-bash-guard (all 6 harnesses + MCP tool calls) and
  // user-prompt-submit (claude and codex), with planted argv, path, prompt, ft:<canary> and mcp__<canary>__tool.
  const invokeHook = (surface, payload) => {
    const body = JSON.parse(JSON.stringify(payload));
    if (Array.isArray(body.workspacePaths)) body.workspacePaths = [canarySubdir];
    const options = {
      cwd: canarySubdir,
      input: `${JSON.stringify(body)}\n`,
      encoding: 'utf8',
      timeout: 20000,
      env: childEnv({ DOFLOW_AGENT: surface.harness, DOFLOW_PROJECT_DIR: root }),
    };
    let res;
    if (surface.runner) {
      res = spawnSync(process.execPath, [path.join(root, '.doflow/shared/hooks/stream-hook-runner.js'), surface.event], options);
    } else if (surface.bridge) {
      res = spawnSync(BASH, [path.join(root, '.doflow/shared/hooks/bridge/bridge.sh'), surface.harness, surface.event, surface.policy], options);
    } else {
      res = spawnSync(BASH, [path.join(root, surface.door)], options);
    }
    assert.equal(res.error, undefined, `${surface.harness}/${surface.policy}: ${res.error?.message}`);
    assert.equal(res.status, 0, `${surface.harness}/${surface.policy} exited ${res.status}: ${res.stderr}`);
  };

  const bashCmd = `printf "%s" "${canaries.argv}" "${ path.join(canarySubdir, sourceRel) }" "${canaries.modelId}"`;
  for (const surface of Object.values(SURFACES)) {
    const native = JSON.parse(fs.readFileSync(path.join(FIXTURES, surface.fixture), 'utf8')).native;
    native.model = canaries.modelId;
    // The claude surfaces carry the session canary, so their hook lines hold it as `session` (T0).
    if (surface.harness === 'claude') native.session_id = canaries.session;
    if (surface.policy === 'pre-bash-guard') {
      if (surface.harness === 'antigravity') native.toolCall.args.CommandLine = bashCmd;
      else if (surface.harness === 'pi') native.input.command = bashCmd;
      else native.tool_input.command = bashCmd;
    } else if (surface.policy === 'user-prompt-submit') {
      native.prompt = `Run ${canaries.prompt} on ${canarySubdir} with ${canaries.modelId} and ${canaries.mcpTool}`;
    }
    invokeHook(surface, native);
  }

  // Also invoke pre-bash-guard with the MCP tool name `mcp__<canary>__tool` on claude, codex and pi.
  for (const key of ['claude:pre-bash-guard', 'codex:pre-bash-guard', 'pi:pre-bash-guard']) {
    const surface = SURFACES[key];
    const native = JSON.parse(fs.readFileSync(path.join(FIXTURES, surface.fixture), 'utf8')).native;
    native.model = canaries.modelId;
    if (surface.harness === 'pi') {
      native.toolName = canaries.mcpTool;
      native.input = { command: canaries.argv, path: canarySubdir };
    } else {
      native.tool_name = canaries.mcpTool;
      native.tool_input = { command: canaries.argv, file_path: canarySubdir };
    }
    invokeHook(surface, native);
  }

  // Producer (d): `trace spans --json` over the project.
  const spansRes = spawnSync(process.execPath, [DOFLOW, 'trace', 'spans', '--json', root], {
    cwd: root,
    env: childEnv(),
    encoding: 'utf8',
  });
  assert.equal(spansRes.status, 0, `trace spans --json: ${spansRes.stderr}`);

  // 091 outputs over the same project: the analyze view, both batches and the export dry run.
  const cli = (id, args, statuses) => {
    const res = spawnSync(process.execPath, [DOFLOW, ...args, root], { cwd: root, env: childEnv(), encoding: 'utf8' });
    assert.equal(res.error, undefined, `${id}: ${res.error?.message}`);
    assert.ok(statuses.includes(res.status), `${id} exited ${res.status}: ${res.stderr}`);
    return { id, status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  const outputs091 = [
    cli('analyze-json', ['trace', 'analyze', '--json'], [0, 1]),
    cli('analyze-emit-evidence', ['trace', 'analyze', '--emit', 'evidence'], [0, 1]),
    cli('analyze-emit-followups', ['trace', 'analyze', '--emit', 'followups'], [0, 1]),
    cli('export-dry-run', ['trace', 'export', '--otlp-http', '--dry-run'], [0]),
  ];

  return {
    childEnv,
    canaries,
    root,
    configDir,
    runsDir,
    attemptsFile,
    verifyPass,
    verifyFail,
    spansStdout: spansRes.stdout,
    spansStderr: spansRes.stderr,
    spansView: JSON.parse(spansRes.stdout),
    outputs091,
  };
}

let sharedRun;
function getRun() {
  if (!sharedRun) sharedRun = runCanaryFixture();
  return sharedRun;
}

test('G-O2 canary run exercises verify (pass+fail), bridge hooks, task-run start/resume and trace spans with zero canary hits, allowlist equality and <= 256B values', () => {
  const result = getRun();
  const { canaries, runsDir, attemptsFile, spansStdout, spansStderr, spansView } = result;

  // Verify task-run start + resume minted two distinct 32-hex traceIds linked by traceLink.
  const attemptsStore = JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));
  const [runRecord] = Object.values(attemptsStore.runs);
  assert.match(runRecord.traceId, /^[0-9a-f]{32}$/);
  assert.equal(runRecord.history.length, 3);
  assert.match(runRecord.history[0].traceId, /^[0-9a-f]{32}$/);
  assert.equal(runRecord.history[2].traceId, runRecord.traceId);
  assert.equal(runRecord.history[2].traceLink, runRecord.history[0].traceId);

  // Verify trace spans projected both segments and joined the hook and verify records with zero gaps.
  assert.equal(spansView.v, 1);
  assert.equal(spansView.traces.length, 2);
  assert.equal(spansView.traces[1].traceLink, spansView.traces[0].traceId);
  assert.deepEqual(spansView.gaps, []);
  const activeKinds = new Set(spansView.traces[1].spans.map((s) => s.kind));
  for (const kind of ['run', 'hook', 'verify.run', 'verify.tier', 'verify.check']) {
    assert.equal(activeKinds.has(kind), true, `trace spans includes ${kind}`);
  }

  // Verify MCP hook lines recorded tool: null.
  const telemetryFiles = listFilesRec(path.join(runsDir, 'telemetry'));
  assert.ok(telemetryFiles.length >= 1, 'at least one telemetry partition written');
  const writtenLines = telemetryFiles.flatMap((f) => fs.readFileSync(f.abs, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  const hookLines = writtenLines.filter((l) => l.kind === 'hook');
  assert.equal(hookLines.length, 11, '8 allowlisted surface calls + 3 MCP calls wrote 11 hook lines');
  assert.equal(hookLines.filter((l) => l.policy === 'pre-bash-guard' && l.tool === null).length, 3, 'MCP tool calls record tool: null');

  // Run the G-O2 scanner: zero canary hits (full and 8-char prefix), allowlist equality, <= 256B values.
  const errors = scanCanaryRun({ runsDir, spansStdout, spansStderr, canaries });
  assert.deepEqual(errors, []);

  // Extra check (S-31, IC-018): leak-scan.ts finds zero DoFlow-vocabulary leaks across the telemetry files.
  const leakResult = scanPaths({
    paths: telemetryFiles.map((f) => f.abs),
    repoRoot: result.root,
    excludedSegments: [],
  });
  assert.equal(leakResult.scanned.length, telemetryFiles.length);
  assert.deepEqual(leakResult.findings, []);
});

/** The 091 outputs as scan targets: stdout and stderr of each command. */
function outputTargets(outputs) {
  return outputs.flatMap((o) => [{ name: `${o.id}:stdout`, text: o.stdout }, { name: `${o.id}:stderr`, text: o.stderr }]);
}

/** Runs `trace export --otlp-http --dry-run` in process with `registry`, capturing stdout and stderr. */
async function dryRunExport(run, registry) {
  const { handleTraceExport } = require('../../src/runtime/trace/otlp-export.ts');
  const stdout = [];
  const stderr = [];
  const priorExit = process.exitCode;
  try {
    const code = await handleTraceExport({
      positional: [run.root], otlpHttp: true, dryRun: true, env: run.childEnv(), stdout, stderr, registry,
    });
    return { id: 'export-dry-run-inprocess', status: code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    process.exitCode = priorExit;
  }
}

test('091 E.1 NFR-001: trace analyze --json, --emit evidence, --emit followups and the export dry run carry no canary', () => {
  const run = getRun();
  const { canaries, runsDir, outputs091 } = run;
  const byId = Object.fromEntries(outputs091.map((o) => [o.id, o]));

  // Each output is the shape its contract names, so an empty or failed command cannot pass the scan.
  const view = JSON.parse(byId['analyze-json'].stdout);
  assert.equal(view.view, 'analyze');
  assert.ok(view.scopes >= 1, 'the analyze view read the seeded scopes');
  assert.ok(view.detectors.some((d) => d.id === 'retry-loops' && d.findings.length >= 1), 'the seeded retry loop is a finding');
  assert.equal(byId['analyze-json'].status, 1, 'analyze exits 1 when there is a finding');
  assert.ok(JSON.parse(byId['analyze-emit-evidence'].stdout).length >= 1, 'the evidence batch holds the finding');
  assert.ok(JSON.parse(byId['analyze-emit-followups'].stdout).length >= 1, 'the proposal batch holds the finding');
  const requests = JSON.parse(byId['export-dry-run'].stdout);
  const exported = requests.flatMap((r) => r.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
  assert.ok(exported.length >= 1, 'the dry run mapped at least one span');
  const hookSpans = exported.filter((sp) => sp.attributes.some((a) => a.key === 'gen_ai.agent.name' && a.value.stringValue === 'claude'));
  assert.ok(hookSpans.length >= 1, 'the dry run holds a claude hook span, whose local record carries the session canary');
  // C-4: the local view's span ids (digests of locators naming the slug, task ids and worktree key) never leave.
  const localIds = JSON.parse(run.spansStdout).traces.flatMap((tr) => tr.spans.map((sp) => sp.spanId));
  assert.ok(localIds.length >= 1, 'the local view holds span ids');
  const exportedText = byId['export-dry-run'].stdout;
  assert.deepEqual(localIds.filter((id) => exportedText.includes(id)), [], 'no local span id is in the export');
  const exportedIds = new Set(exported.map((sp) => sp.spanId));
  assert.ok(exported.every((sp) => !sp.parentSpanId || exportedIds.has(sp.parentSpanId)), 'every exported parent is in the payload');

  // Every content canary and the feature slug: zero hits in all four outputs.
  assert.deepEqual(scanOutputs(outputTargets(outputs091), canaries, [...CONTENT_KEYS, 'slug']), []);
  // The session id is a T0 identifier: present locally, never exported.
  const telemetryText = listFilesRec(path.join(runsDir, 'telemetry')).map((f) => fs.readFileSync(f.abs, 'utf8')).join('');
  assert.equal(telemetryText.includes(canaries.session), true, 'positive control: the local hook lines hold the session canary');
  assert.deepEqual(scanOutputs(outputTargets([byId['export-dry-run']]), canaries, ['session']), []);

  // Rider R1: the UserPromptSubmit hook lines carry emission metadata and never the prompt canary.
  const promptLines = telemetryText.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((l) => l.kind === 'hook' && l.event === 'UserPromptSubmit');
  assert.equal(promptLines.length, 2, 'claude and codex UserPromptSubmit lines');
  assert.ok(promptLines.some((l) => typeof l.emit_reason === 'string'), 'a UserPromptSubmit line carries emit metadata');
  for (const line of promptLines) {
    const text = JSON.stringify(line);
    assert.equal(text.includes(canaries.prompt.slice(0, 8)), false, 'prompt canary in the UserPromptSubmit line');
  }
});

test('091 E.1 negative control: a planted export mapping for `session` makes the dry-run canary search find the session canary; the banned id rule exports nothing', async () => {
  const run = getRun();
  const { canaries } = run;
  // The same in-process path with the real registry is clean, so the planted entry alone turns it red.
  const clean = await dryRunExport(run, REGISTRY);
  assert.equal(clean.status, 0);
  assert.deepEqual(scanOutputs(outputTargets([clean]), canaries, ['session']), []);

  // C-1: the banned id rule on `session`, in any type, now exports nothing (the mapper fails closed).
  for (const rule of [{ id: true }, { id: 1 }, { id: 'true' }, { vocabulary: 'harness', id: 1 }]) {
    const banned = JSON.parse(JSON.stringify(REGISTRY));
    banned.export.attributes.session = rule;
    const out = await dryRunExport(run, banned);
    assert.equal(out.status, 0);
    assert.deepEqual(scanOutputs(outputTargets([out]), canaries, ['session']), [], `session ${JSON.stringify(rule)} exports nothing`);
  }

  // A well-formed rule whose planted vocabulary lists the canary does export it, so the scan can see a leak.
  const planted = JSON.parse(JSON.stringify(REGISTRY));
  planted.vocabularies.planted_session = [canaries.session];
  planted.export.attributes.session = { vocabulary: 'planted_session' };
  const leaked = await dryRunExport(run, planted);
  assert.equal(leaked.status, 0);
  const errors = scanOutputs(outputTargets([leaked]), canaries, ['session']);
  assert.ok(errors.some((e) => e.includes('matched session:full')), `expected session:full, got: ${errors.join('; ')}`);
  assert.ok(errors.some((e) => e.includes('matched session:prefix8')), `expected session:prefix8, got: ${errors.join('; ')}`);
});

test('negative control 1: a scratch producer that writes the canary command argument into a record turns the scanner red', () => {
  const { canaries, spansStdout, spansStderr } = getRun();
  const scratchRuns = path.join(suiteRoot, 'nc-argv-runs');
  fs.mkdirSync(path.join(scratchRuns, 'telemetry'), { recursive: true });
  for (const f of listFilesRec(getRun().runsDir)) {
    const dest = path.join(scratchRuns, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  const partition = path.join(scratchRuns, 'telemetry', fs.readdirSync(path.join(scratchRuns, 'telemetry'))[0]);
  const badRecord = {
    kind: 'hook',
    harness: 'claude',
    event: 'PreToolUse',
    policy: 'pre-bash-guard',
    verdict: 'allow',
    duration_ms: null,
    timestamp: '2026-10-17T00:00:00.000Z',
    session: canaries.argv,
    tool: 'Bash',
    tool_call_id: null,
    run: 'r-canary',
    lineage: 'main',
    attempt: 1,
  };
  fs.appendFileSync(partition, `${JSON.stringify(badRecord)}\n`, 'utf8');

  const errors = scanCanaryRun({ runsDir: scratchRuns, spansStdout, spansStderr, canaries });
  assert.ok(errors.some((e) => e.includes('matched argv:full')), `expected argv:full error, got: ${errors.join('; ')}`);
  assert.ok(errors.some((e) => e.includes('matched argv:prefix8')), `expected argv:prefix8 error, got: ${errors.join('; ')}`);
});

test('negative control 2: a scratch producer that writes the MCP tool name into a record turns the scanner red', () => {
  const { canaries, spansStdout, spansStderr } = getRun();
  const scratchRuns = path.join(suiteRoot, 'nc-mcp-runs');
  fs.mkdirSync(path.join(scratchRuns, 'telemetry'), { recursive: true });
  for (const f of listFilesRec(getRun().runsDir)) {
    const dest = path.join(scratchRuns, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  const partition = path.join(scratchRuns, 'telemetry', fs.readdirSync(path.join(scratchRuns, 'telemetry'))[0]);
  const badRecord = {
    kind: 'hook',
    harness: 'pi',
    event: 'tool_call',
    policy: 'pre-bash-guard',
    verdict: 'allow',
    duration_ms: null,
    timestamp: '2026-10-17T00:00:00.000Z',
    session: 's1',
    tool: canaries.mcpTool,
    tool_call_id: 'tc1',
    run: 'r-canary',
    lineage: 'main',
    attempt: 1,
  };
  fs.appendFileSync(partition, `${JSON.stringify(badRecord)}\n`, 'utf8');

  const errors = scanCanaryRun({ runsDir: scratchRuns, spansStdout, spansStderr, canaries });
  assert.ok(errors.some((e) => e.includes('matched mcp:full')), `expected mcp:full error, got: ${errors.join('; ')}`);
  assert.ok(errors.some((e) => e.includes('matched mcp:prefix8')), `expected mcp:prefix8 error, got: ${errors.join('; ')}`);
  assert.ok(errors.some((e) => e.includes('matched mcpTool:full')), `expected mcpTool:full error, got: ${errors.join('; ')}`);
});

test('negative control 3: a scratch producer that writes the verified command tool output into a record turns the scanner red', () => {
  const { canaries, spansStdout, spansStderr } = getRun();
  const scratchRuns = path.join(suiteRoot, 'nc-output-runs');
  fs.mkdirSync(path.join(scratchRuns, 'telemetry'), { recursive: true });
  for (const f of listFilesRec(getRun().runsDir)) {
    const dest = path.join(scratchRuns, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  const partition = path.join(scratchRuns, 'telemetry', fs.readdirSync(path.join(scratchRuns, 'telemetry'))[0]);
  const badRecord = {
    timestamp: '2026-10-17T00:00:00.000Z',
    kind: 'verify.check',
    run: 'r-canary',
    lineage: 'main',
    attempt: 1,
    verify_id: '0123456789abcdef',
    tier: canaries.output,
    status: 'FAIL',
  };
  fs.appendFileSync(partition, `${JSON.stringify(badRecord)}\n`, 'utf8');

  const errors = scanCanaryRun({ runsDir: scratchRuns, spansStdout, spansStderr, canaries });
  assert.ok(errors.some((e) => e.includes('matched output:full')), `expected output:full error, got: ${errors.join('; ')}`);
  assert.ok(errors.some((e) => e.includes('matched output:prefix8')), `expected output:prefix8 error, got: ${errors.join('; ')}`);
});

test('scanner self-test: catches an 8-char prefix leak alone, an undeclared key, and a value > 256 bytes', () => {
  const { canaries, spansStdout, spansStderr } = getRun();
  const scratchRuns = path.join(suiteRoot, 'nc-extra-runs');
  fs.mkdirSync(path.join(scratchRuns, 'telemetry'), { recursive: true });
  for (const f of listFilesRec(getRun().runsDir)) {
    const dest = path.join(scratchRuns, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  const partition = path.join(scratchRuns, 'telemetry', fs.readdirSync(path.join(scratchRuns, 'telemetry'))[0]);
  const badRecord = {
    timestamp: '2026-10-17T00:00:00.000Z',
    kind: 'verify.check',
    run: 'r-canary',
    lineage: 'main',
    attempt: 1,
    verify_id: '0123456789abcdef',
    tier: 'a'.repeat(MAX_VALUE_BYTES + 1),
    status: 'PASS',
    undeclared_extra: canaries.prompt.slice(0, 8),
  };
  fs.appendFileSync(partition, `${JSON.stringify(badRecord)}\n`, 'utf8');

  const errors = scanCanaryRun({ runsDir: scratchRuns, spansStdout, spansStderr, canaries });
  assert.ok(errors.some((e) => e.includes('matched prompt:prefix8')) && !errors.some((e) => e.includes('matched prompt:full')));
  assert.ok(errors.some((e) => e.includes("undeclared key 'undeclared_extra'")));
  assert.ok(errors.some((e) => e.includes("key 'tier' value length 257 exceeds 256 bytes")));
});

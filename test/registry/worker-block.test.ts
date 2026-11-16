'use strict';
// 081 IC-001, IC-002, IC-003 (validation) and IC-032 (orchestration fixture): the `worker` block of
// core/registry/harnesses.json and validateWorker. Every rule has one failing case, built from an
// in-memory copy of the shipped registry so a regression in the validator cannot hide behind a file edit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadRegistry, validateRegistry, validateWorker, isRetired, WORKER_KEYS, WORKER_CAPABILITIES, WORKER_OPTIONAL_CAPABILITIES,
} = require('../../src/registry/index.ts');
const { ACTIVE_HARNESS_IDS } = require('../helper/harness-ids.ts');
const ORCHESTRATION_AT_BE752D8 = require('../fixtures/worker/orchestration-be752d8.json');

const REPO = path.resolve(__dirname, '../..');
const HARNESSES = ACTIVE_HARNESS_IDS;
const CODEX_RECORD = 'core/worker-evidence/codex/2026-10-18-cli-check.json';
const LIVE_READ_ONLY = 'core/worker-evidence/codex/2026-10-18-live-run-read-only.json';
const LIVE_EDIT = 'core/worker-evidence/codex/2026-10-18-live-run-edit.json';
// D.1: the free check plus the live-run record(s) that establish each entry; runnableProbe keeps only the free check.
const CODEX_EVIDENCE: any = {
  oneShot: [CODEX_RECORD, LIVE_READ_ONLY, LIVE_EDIT],
  structuredOutput: [CODEX_RECORD, LIVE_READ_ONLY, LIVE_EDIT],
  spawnDenial: [CODEX_RECORD, LIVE_READ_ONLY, LIVE_EDIT],
  readOnly: [CODEX_RECORD, LIVE_READ_ONLY],
  isolatedEdit: [CODEX_RECORD, LIVE_EDIT, 'core/worker-evidence/codex/2026-11-05-sandbox-probe.json'],
  runnableProbe: [CODEX_RECORD],
};
const CODEX_SUPPORTED = ['oneShot', 'structuredOutput', 'readOnly', 'spawnDenial', 'runnableProbe'];
// 142 B.7, B.8: opencode and kiro hold the same five entries on their 2026-11-07 free cli-check (IC-009).
// claude, copilot and pi are absent: their C.1, C.2 and C.3 runs hit a stop rule (usage limit; report `denied`; no live run, model selection not in the recipe), so their five entries are `unknown` again.
const FREE_CHECK_SUPPORTED = ['oneShot', 'structuredOutput', 'readOnly', 'spawnDenial', 'runnableProbe'];
const FREE_CHECK_HARNESSES = ['opencode', 'kiro', 'copilot', 'pi'];
// 147: copilot's checks.json gained the --available-tools expectation, so every copilot entry cites the one record made with it.
const cliRecord = (id: string) => `core/worker-evidence/${id}/2026-11-07-cli-check${id === 'copilot' ? '-available-tools' : id === 'pi' ? '-model' : ''}.json`;
const MODEL_HARNESSES = ['claude', 'copilot', 'pi', 'opencode', 'kiro', 'antigravity']; // 146; antigravity cites its 2026-11-07 cli-check, whose help-model check reads stderr (agy prints --help there)
const FREE_CHECK_RECIPES: any = {
  opencode: {
    oneShot: { argv: ['{prompt}'], promptVia: 'argv' },
    structuredOutput: { argv: ['--standalone', '--format', 'json'], parser: 'opencode-run-json-v1' },
    readOnly: { argv: ['run', '--agent', 'doflow-worker-ro'] },
    spawnDenial: { argv: [] },
    runnableProbe: { argv: ['run', '--help'] },
  },
  pi: {
    oneShot: { argv: ['-p', '--no-session', '--thinking', 'off', '--no-skills', '--no-context-files', '--offline', '{prompt}'], promptVia: 'argv' },
    structuredOutput: { argv: ['--mode', 'json'], parser: 'pi-json-v1' },
    readOnly: { argv: ['--tools', 'read,grep,find,ls'] },
    spawnDenial: { argv: ['--no-extensions', '--no-mcp'] },
    runnableProbe: { argv: ['--help'] },
  },
  copilot: {
    oneShot: { argv: ['--trust-folder', '--no-ask-user', '-p', '{prompt}'], promptVia: 'argv' },
    structuredOutput: { argv: ['--output-format', 'json'], parser: 'copilot-json-v1' },
    readOnly: { argv: ['--available-tools', 'view', 'glob', 'grep', '--deny-tool', 'write', '--deny-tool', 'shell'] },
    spawnDenial: { argv: ['--excluded-tools', 'task'] },
    runnableProbe: { argv: ['--help'] },
  },
  kiro: {
    oneShot: { argv: ['--trust-workspace', '{prompt}'], promptVia: 'argv' },
    structuredOutput: { argv: ['--output-format', 'stream-json'], parser: 'kiro-stream-json-v1' },
    readOnly: { argv: ['chat', '--no-interactive', '--agent', 'doflow-worker-ro'] },
    spawnDenial: { argv: ['--trust-tools=read'] },
    runnableProbe: { argv: ['chat', '--help'] },
  },
};
const PER_HARNESS_REASON = ['oneShot', 'structuredOutput', 'spawnDenial']; // isolatedEdit's reason is pinned in worker-isolated-edit.test.js
const PI_DECIDED = ['loginProbe', 'persistentSession', 'resume', 'steering'];
const BINARIES: any = { claude: 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi', copilot: 'copilot', kiro: 'kiro-cli', antigravity: 'agy' };

/** 172 design §3.3: the five harnesses without a login recipe read `unknown`, each with the help it was checked against and why. */
const LOGIN_UNKNOWN: any = {
  codex: { verification: "Run `codex login --help` and `codex login status --help`; a recipe needs the status command's exit codes or a JSON form stated in its help or published docs.", reason: "`codex login status --help` (0.164.0) documents no exit code and no JSON output, so its answer could only be guessed", hint: "codex login" },
  opencode: { verification: "Run `opencode auth --help` and `opencode auth list --help`; a recipe needs a documented exit code or named output fields for the list.", reason: "`opencode auth list --help` (2.2.7) documents no exit code and does not name the fields a login would be read from", hint: "opencode auth login" },
  copilot: { verification: "Run `copilot --help` and `copilot login --help`; a recipe needs a login status command whose exit meaning its help or published docs state.", reason: "`copilot --help` and `copilot login --help` (1.0.105) list `login` and no status or check command", hint: "copilot login" },
  kiro: { verification: "A person runs `kiro-cli --help` and records any login status command and its exit meaning; agents do not run kiro-cli. The hint `kiro-cli login` is carried from the deleted probe and was not re-checked.", reason: "kiro-cli is never run by DoFlow agents, and no recorded help names a login status command for it", hint: "kiro-cli login" },
  antigravity: { verification: "Run `agy --help`; a recipe needs a login status command whose exit meaning its help or published docs state.", reason: "`agy --help` (agy 1.5.9) lists no auth, login or status command" },
};

/** A supported entry carrying the given recipe fields. */
function supported(recipe: any) {
  return { status: 'supported', evidence: ['test/registry/worker-block.test.ts'], verification: 'Run it.', verifiedOn: '2026-10-15', ...recipe };
}

/** 172 design §3.1: a supported loginProbe is a login recipe; the least one is exit 0 logged in, exit 1 logged out. */
const LOGIN_RECIPE = { output: 'none', answers: [{ exit: 0, state: 'logged-in' }, { exit: 1, state: 'logged-out' }], expiry: 'not-seen' };

/** Validates a fresh copy of the shipped registry after mutating claude's worker block. */
function mutated(mutate: any) {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(registry.harnesses[0].worker, registry.harnesses[0]);
  return validateRegistry(registry, { repoRoot: REPO });
}

function assertReports(result: any, pattern: any) {
  assert.equal(result.ok, false, 'the mutated registry must be rejected');
  const workerErrors = result.errors.filter((line: any) => line.includes(" worker '"));
  assert.match(workerErrors.join('\n'), pattern);
  for (const line of workerErrors) {
    assert.match(line, /^harness 'claude' worker '[^']+': /, `message shape: ${line}`);
    assert.ok(!line.includes(' orchestration'), `no worker message may contain ' orchestration': ${line}`);
  }
}

test('worker: the shipped registry carries the block on every harness and validates', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const workerErrors = registry.validation.errors.filter((line: any) => line.includes(" worker '"));
  assert.deepEqual(workerErrors, []);
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  const modelChecksAt = WORKER_KEYS.indexOf('modelChecks');
  // `modelList` (how the harness's own CLI lists its models) sits between the optional capabilities and modelChecks.
  const expectedKeys = [...WORKER_KEYS.slice(0, modelChecksAt), ...Object.keys(WORKER_OPTIONAL_CAPABILITIES), 'modelList', ...WORKER_KEYS.slice(modelChecksAt)];
  for (const harness of registry.harnesses) assert.deepEqual(Object.keys(harness.worker), expectedKeys, `${harness.id} worker keys`);
});

test('worker: the seven harnesses declare IC-002 values and nothing else as supported', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.ok(Object.keys(BINARIES).every((id) => HARNESSES.includes(id)), 'every BINARIES key is an active id');
  for (const harness of registry.harnesses.filter((h: any) => Object.hasOwn(BINARIES, h.id))) {
    const worker = harness.worker;
    const binary = BINARIES[harness.id];
    assert.equal(worker.profile, null, `${harness.id} profile`);
    assert.deepEqual(worker.modelChecks, [], `${harness.id} modelChecks`);
    assert.equal(worker.cli.status, 'supported');
    assert.equal(worker.cli.binary, binary);
    assert.deepEqual(worker.cli.versionArgv, ['--version']);
    assert.equal(worker.cli.evidence.length, 1);
    assert.ok(worker.cli.evidence[0].startsWith(`bench/inventory/coverage.json → ${binary} --version → `), worker.cli.evidence[0]);
    for (const key of Object.keys(WORKER_CAPABILITIES).filter((name) => name !== 'cli')) {
      if (harness.id === 'codex' && CODEX_SUPPORTED.includes(key)) {
        // IC-008: the six entries the recorded codex cli-check establishes; the record is checked by G41.4.
        assert.equal(worker[key].status, 'supported', `codex ${key}`);
        assert.deepEqual(worker[key].evidence, CODEX_EVIDENCE[key], `codex ${key} evidence`);
        assert.equal(worker[key].verifiedOn, '2026-10-18', `codex ${key} verifiedOn`);
        continue;
      }
      if (MODEL_HARNESSES.includes(harness.id) && key === 'model') {
        // 146: the `--model <id>` flag each CLI lists in --help, recorded by the help-model free check; G41.4 checks the record.
        assert.equal(worker.model.status, 'supported', `${harness.id} model`);
        assert.deepEqual(worker.model.evidence, [harness.id === 'copilot' || harness.id === 'antigravity' ? cliRecord(harness.id) : `core/worker-evidence/${harness.id}/2026-11-07-cli-check-model.json`], `${harness.id} model evidence`);
        assert.deepEqual(worker.model.argv, ['--model', '{model}'], `${harness.id} model argv`);
        assert.equal(worker.model.verifiedOn, '2026-11-07', `${harness.id} model verifiedOn`);
        continue;
      }
      if (FREE_CHECK_HARNESSES.includes(harness.id) && FREE_CHECK_SUPPORTED.includes(key)) {
        // 142 IC-009: the five entries the recorded free cli-check establishes; the record is checked by G41.4.
        assert.equal(worker[key].status, 'supported', `${harness.id} ${key}`);
        // 142 C.4, 145: opencode's and kiro's readOnly and spawnDenial also cite their two 2026-11-07 live runs (G41.5 checks them).
        const live = (harness.id === 'opencode' || harness.id === 'kiro' || harness.id === 'copilot' || harness.id === 'pi') && (key === 'readOnly' || key === 'spawnDenial')
          ? [`core/worker-evidence/${harness.id}/2026-11-07-live-run-read-only.json`, `core/worker-evidence/${harness.id}/2026-11-07-live-run-spawn.json`] : [];
        assert.deepEqual(worker[key].evidence, [cliRecord(harness.id), ...live], `${harness.id} ${key} evidence`);
        assert.equal(worker[key].verifiedOn, '2026-11-07', `${harness.id} ${key} verifiedOn`);
        continue;
      }
      // 168: pi's loginProbe, persistentSession, resume and steering are decided on 2026-11-16 and pinned in pi-worker-truth.test.ts.
      if (harness.id === 'pi' && PI_DECIDED.includes(key)) continue;
      // 172: claude's loginProbe ships as a supported login recipe (design §3.3 plus the LD-1 caveat); this is its exact pin.
      if (harness.id === 'claude' && key === 'loginProbe') {
        const { verification, ...recipe } = worker[key];
        assert.match(verification, /^Run `node bin\/doflow\.js worker --action evidence/, 'claude loginProbe verification');
        assert.deepEqual(recipe, {
          status: 'supported',
          evidence: ['core/worker-evidence/claude/2026-11-16-cli-check-login-recipe.json', recipe.evidence[1]],
          verifiedOn: '2026-11-16',
          argv: ['auth', 'status', '--json'],
          output: 'json',
          answers: [{ exit: 0, state: 'logged-in' }, { exit: 1, state: 'logged-out' }],
          billing: { path: ['authMethod'], values: {
            'claude.ai': { mode: 'subscription', billing: 'free' }, oauth_token: { mode: 'subscription', billing: 'free' },
            api_key: { mode: 'api-key', billing: 'metered' }, api_key_helper: { mode: 'api-key', billing: 'metered' } } },
          expiry: 'not-seen',
          hint: 'claude auth login',
          caveat: 'its help and docs do not show that this check runs offline',
        }, 'claude loginProbe');
        assert.match(recipe.evidence[1], /^https:\/\/code\.claude\.com\/docs\/en\/cli-reference /, 'claude loginProbe docs evidence');
        continue;
      }
      if (key === 'loginProbe') {
        // 172: an unknown loginProbe names the help it was checked against and why no recipe is declared (pinned exactly).
        const { status, evidence, verifiedOn, ...rest } = worker[key];
        assert.deepEqual({ status, evidence, verifiedOn, ...rest }, { status: 'unknown', evidence: [], verifiedOn: '2026-11-16', ...LOGIN_UNKNOWN[harness.id] }, `${harness.id} loginProbe`);
        continue;
      }
      assert.equal(worker[key].status, 'unknown', `${harness.id} ${key}`);
      assert.deepEqual(worker[key].evidence, [], `${harness.id} ${key} evidence`);
      assert.equal(worker[key].verification, `Read ${harness.id}'s headless CLI documentation and \`${binary} --help\`; record the flag and its source`, `${harness.id} ${key}`);
      assert.equal(worker[key].verifiedOn, '2026-10-15', `${harness.id} ${key}`);
      if (PER_HARNESS_REASON.includes(key)) {
        // the four static-gate entries carry a per-harness reason naming the missing evidence (FR-009)
        assert.match(worker[key].reason, new RegExp(`^no (recorded evidence for|captured) ${binary}[ :]`), `${harness.id} ${key} reason`);
      } else {
        assert.equal(worker[key].reason, `no in-repository evidence names this for ${harness.id}; nothing is inferred from another harness or a model name`, `${harness.id} ${key}`);
      }
    }
  }
});

// W2-1 (109 review A-1): the codex recipes are what the dispatcher launches, and the evidence record
// only shows the flags exist. Pin every supported entry, argv included, so widening a sandbox or
// swapping a disabled feature cannot pass with the record untouched.
const CODEX_RECIPES = {
  oneShot: { argv: ['--ephemeral', '-'], promptVia: 'stdin' },
  structuredOutput: {
    argv: ['--json', '-o', '{lastMessageFile}'], parser: 'codex-exec-json-v1',
    quotaSignals: {
      signals: ['usage limit'], unverifiedSignals: ['rate limit', 'quota exceeded', 'too many requests', 'resource_exhausted'],
      basis: 'transcript', evidence: ['core/worker-evidence/codex/2026-11-05-quota-transcript.json'],
    },
  },
  readOnly: { argv: ['exec', '-s', 'read-only'] },
  isolatedEdit: { argv: ['exec', '-s', 'workspace-write'], protectedPaths: ['.git', '.agents', '.codex', '.aws'] },
  spawnDenial: { argv: ['--disable', 'multi_agent', '--disable', 'multi_agent_v2'] },
  runnableProbe: { argv: ['exec', '--help'] },
};

test('worker: the six supported codex entries equal their committed status, evidence, verifiedOn and recipe', () => {
  const codex = loadRegistry({ repoRoot: REPO }).harnesses.find((harness: any) => harness.id === 'codex').worker;
  assert.deepEqual(Object.keys(CODEX_RECIPES).sort(), [...CODEX_SUPPORTED, 'isolatedEdit'].sort());
  for (const [key, recipe] of Object.entries(CODEX_RECIPES)) {
    const { status, evidence, verifiedOn, argv, promptVia, parser, quotaSignals, protectedPaths } = codex[key];
    assert.deepEqual(
      { status, evidence, verifiedOn, argv, promptVia, parser, ...(quotaSignals === undefined ? {} : { quotaSignals }), ...(protectedPaths === undefined ? {} : { protectedPaths }) },
      { status: 'supported', evidence: CODEX_EVIDENCE[key], verifiedOn: '2026-10-18', promptVia: undefined, parser: undefined, ...recipe },
      `codex ${key}`,
    );
  }
});

test('worker: the five supported opencode and kiro entries equal their IC-009 recipe', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  for (const id of FREE_CHECK_HARNESSES) {
    const worker = registry.harnesses.find((harness: any) => harness.id === id).worker;
    assert.deepEqual(Object.keys(FREE_CHECK_RECIPES[id]).sort(), [...FREE_CHECK_SUPPORTED].sort());
    for (const [key, recipe] of Object.entries(FREE_CHECK_RECIPES[id])) {
      const { argv, promptVia, parser } = worker[key];
      assert.deepEqual({ argv, promptVia, parser }, { promptVia: undefined, parser: undefined, ...(recipe as any) }, `${id} ${key}`);
    }
    // nothing beyond the five and the model flag: the unprobed capabilities stay unknown
    for (const key of ['hooksProbe', 'guidanceProbe', 'loginProbe', 'persistentSession', 'resume', 'steering', 'isolatedEdit']) {
      // 168: pi's persistentSession, resume and steering are `unsupported` with evidence (pi-worker-truth.test.ts).
      // 172: pi's loginProbe is a supported login recipe (design §3.3), pinned in pi-worker-truth.test.ts.
      const decided = id === 'pi' && ['persistentSession', 'resume', 'steering'].includes(key);
      const expected = id === 'pi' && key === 'loginProbe' ? 'supported' : decided ? 'unsupported' : 'unknown';
      assert.equal(worker[key].status, expected, `${id} ${key}`);
    }
  }
});

test('worker: every harness orchestration block equals the copy taken at be752d8', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  // The copy is frozen history: it still holds the harnesses retired since be752d8 (row 127).
  const kept = Object.keys(ORCHESTRATION_AT_BE752D8).filter((id) => !isRetired(registry, id));
  assert.ok(kept.length > 0 && kept.every((id) => HARNESSES.includes(id)), `the copy's live ids are active ids: ${kept}`);
  for (const harness of registry.harnesses.filter((h: any) => kept.includes(h.id))) {
    // 118 IC-004 adds `nest` after be752d8; the copy covers the five operations that existed then.
    const { nest: _nest, ...atBe752d8 } = harness.orchestration;
    assert.deepEqual(atBe752d8, ORCHESTRATION_AT_BE752D8[harness.id], `${harness.id} orchestration`);
  }
});

test('worker: validateWorker accepts a full supported recipe in isolation', () => {
  const errors: any = [];
  validateWorker({
    profile: 'user-headless',
    billing: 'unknown',
    cli: supported({ binary: 'fake-cli', versionArgv: ['--version'] }),
    oneShot: supported({ argv: ['-p', '{prompt}'], promptVia: 'argv' }),
    structuredOutput: supported({ argv: ['--json'], parser: 'doflow-jsonl-v1' }),
    readOnly: supported({ argv: ['--read-only'] }),
    spawnDenial: supported({ argv: ['--no-agents'] }),
    runnableProbe: supported({ argv: ['--probe'] }),
    hooksProbe: supported({ argv: ['--hooks'] }),
    guidanceProbe: supported({ argv: ['--guidance'], marker: 'DOFLOW-MARKER' }),
    loginProbe: supported({ argv: ['--whoami'], ...LOGIN_RECIPE }),
    persistentSession: supported({}),
    resume: { status: 'unsupported', evidence: ['docs'], verification: 'Read it.', verifiedOn: '2026-10-15' },
    steering: { status: 'unknown', evidence: [], verification: 'Read it.', verifiedOn: '2026-10-15', reason: 'unread' },
    modelChecks: [{ id: 'hooks-check', argv: ['-p', 'x'], establishes: ['hooksLoaded', 'login'], estimateTokens: 1, timeoutSeconds: 600 }],
  }, "harness 'claude'", errors);
  assert.deepEqual(errors, []);
});

const cases = [
  ['a missing block', (_w: any, harness: any) => { delete harness.worker; }, /worker '\*': worker block is required/],
  ['a missing key', (w: any) => { delete w.loginProbe; }, /worker 'loginProbe': is missing/],
  ['an unknown key', (w: any) => { w.dispatch = {}; }, /worker 'dispatch': is not a worker key/],
  ['a bad status', (w: any) => { w.readOnly.status = 'maybe'; }, /worker 'readOnly': status must be supported, unsupported, or unknown/],
  ['empty evidence on supported', (w: any) => { w.cli.evidence = []; }, /worker 'cli': evidence must not be empty when status is supported/],
  ['a missing reason on unknown', (w: any) => { delete w.hooksProbe.reason; }, /worker 'hooksProbe': requires a reason when status is unknown/],
  ['a recipe field on unknown', (w: any) => { w.hooksProbe.argv = ['--hooks']; }, /worker 'hooksProbe': recipe field 'argv' is allowed only when status is supported/],
  ['a missing required recipe field', (w: any) => { delete w.cli.binary; }, /worker 'cli': requires recipe field 'binary' when status is supported/],
  ['an argv of 33 elements', (w: any) => { w.readOnly = supported({ argv: Array(33).fill('-x') }); }, /worker 'readOnly': argv must have at most 32 elements/],
  ['a NUL in an argv element', (w: any) => { w.readOnly = supported({ argv: ['-x\0y'] }); }, /worker 'readOnly': argv elements must not contain NUL/],
  ['{prompt} twice with promptVia argv', (w: any) => { w.oneShot = supported({ argv: ['{prompt}', '{prompt}'], promptVia: 'argv' }); }, /worker 'oneShot': argv must contain the element '\{prompt\}' exactly once/],
  ['{prompt} absent with promptVia argv', (w: any) => { w.oneShot = supported({ argv: ['-p'], promptVia: 'argv' }); }, /worker 'oneShot': argv must contain the element '\{prompt\}' exactly once/],
  ['{prompt} present with promptVia stdin', (w: any) => { w.oneShot = supported({ argv: ['{prompt}'], promptVia: 'stdin' }); }, /worker 'oneShot': argv must not contain '\{prompt\}' when promptVia is stdin/],
  ['{prompt} in readOnly argv', (w: any) => { w.readOnly = supported({ argv: ['--read-only', '{prompt}'] }); }, /worker 'readOnly': argv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['{prompt} in spawnDenial argv', (w: any) => { w.spawnDenial = supported({ argv: ['{prompt}'] }); }, /worker 'spawnDenial': argv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['{prompt} in structuredOutput argv', (w: any) => { w.structuredOutput = supported({ argv: ['{prompt}'], parser: 'doflow-jsonl-v1' }); }, /worker 'structuredOutput': argv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['{prompt} in cli versionArgv', (w: any) => { w.cli.versionArgv = ['{prompt}']; }, /worker 'cli': versionArgv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['{prompt} in a model check argv', (w: any) => { w.modelChecks = [{ id: 'x', argv: ['{prompt}'], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 1 }]; }, /worker 'modelChecks\[0\]': argv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['a modelList with a status outside the two', (w: any) => { w.modelList = { status: 'unknown' }; }, /worker 'modelList': status must be supported or none-recorded/],
  ['a none-recorded modelList without a reason', (w: any) => { w.modelList = { status: 'none-recorded' }; }, /worker 'modelList': none-recorded requires a reason/],
  ['a none-recorded modelList with an argv', (w: any) => { w.modelList = { status: 'none-recorded', reason: 'x', argv: ['models'] }; }, /worker 'modelList': has unknown field 'argv' for status none-recorded/],
  ['a supported modelList with a parser outside the closed set', (w: any) => { w.modelList = { status: 'supported', argv: ['models'], parse: 'json' }; }, /worker 'modelList': parse must be lines, tsv-first-column or table-column:<name>/],
  ['a supported modelList with an empty argv', (w: any) => { w.modelList = { status: 'supported', argv: [], parse: 'lines' }; }, /worker 'modelList': argv must not be empty/],
  ['a supported modelList with a placeholder', (w: any) => { w.modelList = { status: 'supported', argv: ['models', '{model}'], parse: 'lines' }; }, /worker 'modelList': argv must not contain a placeholder/],
  ['a modelList that is not an object', (w: any) => { w.modelList = 'lines'; }, /worker 'modelList': must be an object/],
  ['an unknown profile', (w: any) => { w.profile = 'headless-ish'; }, /worker 'profile': must be a lifecycle coverage profile or null/],
  ['a bad model-check id', (w: any) => { w.modelChecks = [{ id: 'Bad_Id', argv: [], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 1 }]; }, /worker 'modelChecks\[0\]': id must be a lowercase identifier/],
  ['a duplicate model-check id', (w: any) => {
    const check = { id: 'same', argv: [], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 1 };
    w.modelChecks = [check, { ...check }];
  }, /worker 'modelChecks\[1\]': duplicate id 'same'/],
  ['establishes outside the four facts', (w: any) => { w.modelChecks = [{ id: 'x', argv: [], establishes: ['runnable'], estimateTokens: 1, timeoutSeconds: 1 }]; }, /worker 'modelChecks\[0\]': establishes must be a non-empty subset/],
  ['estimateTokens 0', (w: any) => { w.modelChecks = [{ id: 'x', argv: [], establishes: ['login'], estimateTokens: 0, timeoutSeconds: 1 }]; }, /worker 'modelChecks\[0\]': estimateTokens must be an integer of at least 1/],
  // 165 T1: the `mainSession` descriptor key (a user-started main session): shape, placeholders and the widening-flag deny list.
  ['a mainSession entry holding --dangerously-skip-permissions is refused', (w: any) => { w.mainSession = supported({ argv: ['-p', '--dangerously-skip-permissions'], promptVia: 'stdin', parser: null }); }, /worker 'mainSession': argv must not contain the widening flag '--dangerously-skip-permissions'/],
  ['a mainSession element --add-dir=x is refused', (w: any) => { w.mainSession = supported({ argv: ['-p', '--add-dir=x'], promptVia: 'stdin', parser: null }); }, /worker 'mainSession': argv must not contain the widening flag '--add-dir=x'/],
  ['a mainSession element --dangerously-other is refused by its prefix', (w: any) => { w.mainSession = supported({ argv: ['--dangerously-other'], promptVia: 'stdin', parser: null }); }, /worker 'mainSession': argv must not contain the widening flag '--dangerously-other'/],
  ['{prompt} in a mainSession argv with promptVia stdin', (w: any) => { w.mainSession = supported({ argv: ['-p', '{prompt}'], promptVia: 'stdin', parser: null }); }, /worker 'mainSession': argv must not contain '\{prompt\}' when promptVia is stdin/],
  ['{prompt} absent from a mainSession argv with promptVia argv', (w: any) => { w.mainSession = supported({ argv: ['-p'], promptVia: 'argv', parser: null }); }, /worker 'mainSession': argv must contain the element '\{prompt\}' exactly once/],
  ['an unknown placeholder in a mainSession argv', (w: any) => { w.mainSession = supported({ argv: ['-p', '{cwd}'], promptVia: 'stdin', parser: null }); }, /worker 'mainSession': argv contains the unknown placeholder '\{cwd\}'/],
  ['{model} in a mainSession argv', (w: any) => { w.mainSession = supported({ argv: ['--model', '{model}'], promptVia: 'stdin', parser: null }); }, /worker 'mainSession': argv must not contain '\{model\}' outside model\.argv/],
  ['{lastMessageFile} twice in a mainSession argv', (w: any) => { w.mainSession = supported({ argv: ['-o', '{lastMessageFile}', '{lastMessageFile}'], promptVia: 'stdin', parser: null }); }, /worker 'mainSession': argv must contain '\{lastMessageFile\}' at most once/],
  ['a mainSession without promptVia', (w: any) => { w.mainSession = supported({ argv: ['-p'], parser: null }); }, /worker 'mainSession': requires recipe field 'promptVia' when status is supported/],
  ['a mainSession without parser', (w: any) => { w.mainSession = supported({ argv: ['-p'], promptVia: 'stdin' }); }, /worker 'mainSession': requires recipe field 'parser' when status is supported/],
  ['a mainSession parser that is neither null nor an id', (w: any) => { w.mainSession = supported({ argv: ['-p'], promptVia: 'stdin', parser: '' }); }, /worker 'mainSession': parser must be a parser id or null/],
  ['a supported mainSession without evidence', (w: any) => { w.mainSession = supported({ argv: ['-p'], promptVia: 'stdin', parser: null, evidence: [] }); }, /worker 'mainSession': evidence must not be empty when status is supported/],
  ['an unknown mainSession carrying an argv', (w: any) => { w.mainSession = { status: 'unknown', evidence: [], verification: 'Read it.', verifiedOn: '2026-11-15', reason: 'x', argv: ['--yolo'] }; }, /worker 'mainSession': argv must not contain the widening flag '--yolo'/],
  ['timeoutSeconds 601', (w: any) => { w.modelChecks = [{ id: 'x', argv: [], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 601 }]; }, /worker 'modelChecks\[0\]': timeoutSeconds must be an integer from 1 to 600/],
];

for (const [name, mutate, pattern] of cases) {
  test(`worker: ${name} is reported`, () => { assertReports(mutated(mutate), pattern); });
}

// 165 T1: every widening flag in the owner's deny list is refused, as an exact element and with an `=value` tail.
test('worker: every mainSession deny-list flag is refused, bare and with a value', () => {
  const flags = ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--auto', '--allow-all-tools', '--yolo', '--trust-folder', '--trust-workspace', '--add-dir', '--yolo-mode'];
  for (const flag of flags) {
    for (const element of [flag, `${flag}=1`]) {
      assertReports(mutated((w: any) => { w.mainSession = supported({ argv: ['-p', element], promptVia: 'stdin', parser: null }); }), new RegExp(`worker 'mainSession': argv must not contain the widening flag '${element.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    }
  }
});

// 165 review B-2: seat B's deny-list probe, as a test. A codex `mainSession.argv` of `exec <extra> --json -o {lastMessageFile} -`
// accepted every line below; each is refused, and the shipped argv is not.
test('165 review B-2 probe: every widening line the probe showed accepted is refused in a codex mainSession argv', () => {
  const codex = structuredClone(loadRegistry({ repoRoot: REPO }).harnesses.find((h: any) => h.id === 'codex').worker);
  const errorsOf = (extra: string[]) => {
    const w = structuredClone(codex);
    w.mainSession.argv = ['exec', ...extra, '--json', '-o', '{lastMessageFile}', '-'];
    const errors: string[] = [];
    validateWorker(w, "harness 'codex'", errors);
    return errors;
  };
  assert.deepEqual(errorsOf([]), []);
  const probe = [
    ['--full-auto'], ['-s', 'danger-full-access'], ['--sandbox', 'danger-full-access'], ['-a', 'never'],
    ['-c', 'sandbox_mode="danger-full-access"'], ['--permission-mode', 'bypassPermissions'], ['--allowedTools', 'Bash'],
    ['--allow-all-tools'], ['--dangerously-skip-permissions'], ['--dangerously-bypass-approvals-and-sandbox'], ['--yolo'],
  ];
  for (const extra of probe) {
    const errors = errorsOf(extra);
    assert.equal(errors.length, 1, `${JSON.stringify(extra)} -> ${JSON.stringify(errors)}`);
    assert.match(errors[0], /^harness 'codex' worker 'mainSession': argv must not contain the widening flag '/);
  }
});

test('worker: a mainSession may carry {prompt} once (argv) or {lastMessageFile} once (stdin) and a null parser', () => {
  const errors: any = [];
  validateWorker({
    profile: null, billing: 'unknown',
    cli: supported({ binary: 'fake-cli', versionArgv: ['--version'] }),
    oneShot: supported({ argv: ['{prompt}'], promptVia: 'argv' }),
    structuredOutput: supported({ argv: ['--json'], parser: 'doflow-jsonl-v1' }),
    readOnly: supported({ argv: ['--read-only'] }), spawnDenial: supported({ argv: ['--no-agents'] }), runnableProbe: supported({ argv: ['--probe'] }),
    hooksProbe: supported({ argv: ['--hooks'] }), guidanceProbe: supported({ argv: ['--guidance'], marker: 'M' }), loginProbe: supported({ argv: ['--whoami'], ...LOGIN_RECIPE }),
    persistentSession: supported({}), resume: supported({}), steering: supported({}),
    mainSession: supported({ argv: ['run', '--format', 'json', '--', '{prompt}'], promptVia: 'argv', parser: 'doflow-jsonl-v1' }),
    modelChecks: [],
  }, "harness 'claude'", errors);
  assert.deepEqual(errors, []);
  const second: any = [];
  validateWorker({
    profile: null, billing: 'unknown',
    cli: supported({ binary: 'fake-cli', versionArgv: ['--version'] }),
    oneShot: supported({ argv: ['{prompt}'], promptVia: 'argv' }),
    structuredOutput: supported({ argv: ['--json'], parser: 'doflow-jsonl-v1' }),
    readOnly: supported({ argv: ['--read-only'] }), spawnDenial: supported({ argv: ['--no-agents'] }), runnableProbe: supported({ argv: ['--probe'] }),
    hooksProbe: supported({ argv: ['--hooks'] }), guidanceProbe: supported({ argv: ['--guidance'], marker: 'M' }), loginProbe: supported({ argv: ['--whoami'], ...LOGIN_RECIPE }),
    persistentSession: supported({}), resume: supported({}), steering: supported({}),
    mainSession: supported({ argv: ['exec', '-o', '{lastMessageFile}', '-'], promptVia: 'stdin', parser: null }),
    modelChecks: [],
  }, "harness 'claude'", second);
  assert.deepEqual(second, []);
});

// 165 T1 (owner P-1, P-2): the descriptor each harness declares. The argv holds no model flag (the `model` entry owns it).
const MAIN_SESSION_RECIPES: any = {
  claude: { argv: ['-p', '--output-format', 'text'], promptVia: 'stdin', parser: null },
  codex: { argv: ['exec', '--json', '-o', '{lastMessageFile}', '-'], promptVia: 'stdin', parser: 'codex-exec-json-v1' },
  opencode: { argv: ['run', '--format', 'json', '{prompt}'], promptVia: 'argv', parser: 'opencode-run-json-v1' },
  // 168: pi passes the project-trust flag that makes a headless run load no unapproved project code.
  pi: { argv: ['-p', '--mode', 'json', '--no-approve', '--', '{prompt}'], promptVia: 'argv', parser: 'pi-json-v1' },
};

test('worker: claude, codex, opencode and pi declare a supported mainSession on their 2026-11-15 record; copilot, kiro and antigravity stay unknown with a reason', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  for (const harness of registry.harnesses) {
    const entry = harness.worker.mainSession;
    assert.ok(entry, `${harness.id} carries a mainSession entry`);
    const pinned = harness.id === 'pi'; // 168: pi's entry was re-recorded on 2026-11-16 with the project-trust check
    assert.equal(entry.verifiedOn, pinned ? '2026-11-16' : '2026-11-15', `${harness.id} verifiedOn`);
    if (MAIN_SESSION_RECIPES[harness.id]) {
      const { status, argv, promptVia, parser, evidence } = entry;
      assert.deepEqual({ status, argv, promptVia, parser }, { status: 'supported', ...MAIN_SESSION_RECIPES[harness.id] }, `${harness.id} mainSession`);
      assert.deepEqual(evidence, [pinned ? 'core/worker-evidence/pi/2026-11-16-cli-check-project-trust.json' : `core/worker-evidence/${harness.id}/2026-11-15-cli-check-main-session.json`], `${harness.id} evidence`);
    } else {
      assert.equal(entry.status, 'unknown', `${harness.id} mainSession`);
      assert.ok(entry.reason.length > 20, `${harness.id} reason`);
      assert.deepEqual(entry.evidence, [], `${harness.id} evidence`);
      assert.ok(!Object.hasOwn(entry, 'argv'), `${harness.id} carries no argv`);
    }
  }
  const reasonOf = (id: string) => registry.harnesses.find((harness: any) => harness.id === id).worker.mainSession.reason;
  assert.match(reasonOf('copilot'), /--allow-all-tools/);
  assert.match(reasonOf('kiro'), /quota/);
  assert.match(reasonOf('antigravity'), /headless/);
});

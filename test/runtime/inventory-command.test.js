'use strict';

/**
 * C7 — the `inventory` verb's invocation surface (feature 041, task G.2; IC-001).
 *
 * `test/runtime/inventory-verb.test.js` drives `buildInventoryReport`, which is the report
 * assembler. `handleInventoryCommand` is the layer above it, and IC-001's whole surface lives
 * there and nowhere else: the three exit statuses, the refusal of a scope selector, the
 * machine-readable output flag, and the optional positional project root. None of it was reachable
 * from the assembler's tests, so until this file all four rested on by-hand runs.
 *
 * **Two halves, because the observable differs.**
 *
 * The in-process half calls the handler directly with stdout and stderr captured, following
 * `test/runtime/runtime-retrieval-plan.test.js`'s `callVerb` helper. It observes two things the
 * handler produces: its **return value**, and `process.exitCode`, which `finishRuntime` sets on the
 * way out. Both are restored afterwards — a verb reporting a finding must not make the whole test
 * process exit non-zero. What this half cannot observe is the *process* status, which is the thing
 * IC-001 actually names.
 *
 * The subprocess half therefore spawns the real CLI and reads the status the operating system saw.
 * It is not a duplicate of the first: a handler returning 1 while `bin/doflow.js` exits 0 would pass
 * every in-process assertion here. It is also the only half that can reach the positional's default,
 * because the default is applied in `src/cli/runtime-commands.js` (`path.resolve(o.positional[0] ||
 * '.')`) rather than in the handler, so an in-process call has no working directory to fall back to.
 *
 * **Hermetic throughout, and no absolute finding count anywhere.** `os.homedir()` reads `$HOME` on
 * POSIX, so the subprocess half gets a synthetic global scope from the environment and the
 * in-process half relocates `os.homedir` around the synchronous call (design R7). Nothing reads or
 * writes the real `~/.doflow`. Where a case needs a status rather than a fixture it uses two empty
 * scopes or one seeded copy — never the live install, whose divergence count is a moving number
 * that no test of the invocation surface should depend on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stateRoot, defaultLedger, writeLedger } = require('../../src/state');
const { handleInventoryCommand } = require('../../src/runtime/inventory');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

/** The refusal IC-001 requires of a scope selector, verbatim. */
const GLOBAL_REFUSAL = '-g/--global is not accepted: this verb reads both scopes in one invocation, '
  + 'which is its entire purpose. Re-run without the flag.';

// ------------------------------------------------------------------------------- the two harnesses

/** Real paths from the start: the subprocess half compares a reported root against the child's own
 * `process.cwd()`, which is already resolved, and on macOS `mkdtemp` hands back a symlinked one. */
function scratch(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** The global scope root is derived from the process home directory and is not a parameter
 * (design R7), so a hermetic in-process call relocates it around the synchronous handler. */
function withHomeDir(dir, fn) {
  const original = os.homedir;
  os.homedir = () => dir;
  try { return fn(); } finally { os.homedir = original; }
}

/**
 * Calls the handler in-process, capturing both streams.
 *
 * Returns the handler's return value AND the `process.exitCode` it set, because those are the two
 * observables at this layer — see the header on why the subprocess half exists beside it.
 */
function callVerb({ home, ...options }) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  const originalExitCode = process.exitCode;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  let returned;
  let exitCode;
  try {
    returned = withHomeDir(home, () => handleInventoryCommand({ repoRoot: REPO, ...options }));
    exitCode = process.exitCode;
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = originalExitCode;
  }
  return { returned, exitCode, out: out.join('\n'), err: err.join('\n') };
}

/** Runs the real CLI, with a synthetic home and a chosen working directory. */
function run(args, { home, cwd }) {
  const result = spawnSync(process.execPath, [DOFLOW, 'inventory', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  assert.equal(result.error, undefined, 'the CLI must spawn');
  assert.equal(result.signal, null, 'the CLI must exit rather than be signalled');
  return result;
}

// ------------------------------------------------------------------------------------ the fixtures

/** Two scratch scopes with nothing recorded at either. Not an error and not a finding (IC-001). */
function emptyScopes(label) {
  return { home: scratch(`doflow-inventory-cmd-${label}-home-`), projectRoot: scratch(`doflow-inventory-cmd-${label}-project-`) };
}

/**
 * Two scratch scopes, the project one holding a single claude copy whose key the claude plan really
 * emits, with a fingerprint that is not what the source produces — so it reads `diverged` against a
 * live plan rather than a hand-set flag, and raises the one finding kind `doflow reconcile` can act
 * on. Same recipe as `inventory-verb.test.js`'s `fixtureReport`, kept to one copy because the
 * status, not the count, is what this file is about.
 */
function divergedScopes(label) {
  const home = scratch(`doflow-inventory-cmd-${label}-home-`);
  const projectRoot = scratch(`doflow-inventory-cmd-${label}-project-`);
  const ledger = defaultLedger({ scope: 'project', scopeRoot: projectRoot });
  ledger.targets.claude = { installed: true, lastUpdated: '2026-01-01T00:00:00.000Z' };
  ledger.resources.push({
    harness: 'claude', scope: 'project', assetId: 'skills.doflow',
    ownershipIdentity: 'doflow:claude:copy-tree:skills.doflow:do/SKILL.md',
    target: path.join(projectRoot, '.claude', 'skills', 'do', 'SKILL.md'),
    sourceVersion: 'test', fingerprint: 'sha256:1111111111111111',
    projection: {}, recoveryRef: null, selection: null,
  });
  writeLedger(stateRoot({ scope: 'project', projectRoot, homeDir: projectRoot }), ledger);
  return { home, projectRoot };
}

// ------------------------------------------------------------------- IC-001: exit 0, nothing to act on

test('IC-001 exit 0: the question is answered and nothing requires the caller\'s attention', () => {
  const { home, projectRoot } = emptyScopes('clean');

  const inProcess = callVerb({ home, projectRoot, targets: ['claude'], json: true });
  assert.equal(inProcess.returned, 0, 'the handler returns 0 when it made no finding');
  assert.equal(inProcess.exitCode, 0, 'and sets the same value as the process exit code');
  const report = JSON.parse(inProcess.out);
  assert.equal(report.status, 'CLEAN');
  assert.equal(report.exitCode, 0, 'the report states the status it implies (IC-002)');
  assert.deepEqual(report.findings, [], 'nothing is shadowed, diverged, or outranked');

  const cli = run(['-t', 'claude', projectRoot, '--json'], { home, cwd: REPO });
  assert.equal(cli.status, 0,
    'and the process itself exits 0. Asserted separately because the handler\'s return value and the '
    + `status the OS sees are different observables:\n${cli.stdout}${cli.stderr}`);
});

test('IC-001: a scope with nothing recorded is reported as holding nothing, never as exit 2', () => {
  const { home, projectRoot } = emptyScopes('absent');

  const { returned, out } = callVerb({ home, projectRoot, targets: ['claude'], json: true });

  assert.equal(returned, 0, 'an uninstalled scope is the ordinary state, not a failure');
  const report = JSON.parse(out);
  assert.deepEqual(report.scopes.map((scope) => [scope.scope, scope.present]), [['global', false], ['project', false]],
    'both scopes are reported, each marked absent — IC-001 requires the absence be stated rather than raised');
});

// ---------------------------------------------------------------------- IC-001: exit 1, a finding

test('IC-001 exit 1: the question is answered and the answer is a finding the caller must act on', () => {
  const { home, projectRoot } = divergedScopes('finding');

  const inProcess = callVerb({ home, projectRoot, targets: ['claude'], json: true });
  assert.equal(inProcess.returned, 1, 'the handler returns 1 when it made a finding');
  assert.equal(inProcess.exitCode, 1, 'and sets the same value as the process exit code');
  const report = JSON.parse(inProcess.out);
  assert.equal(report.status, 'FINDINGS');
  assert.deepEqual(report.findings.map((finding) => finding.kind), ['divergence'],
    'the seeded copy diverges from what the current source would produce');

  const cli = run(['-t', 'claude', projectRoot, '--json'], { home, cwd: REPO });
  assert.equal(cli.status, 1,
    `and the process itself exits 1:\n${cli.stdout}${cli.stderr}`);
});

test('IC-001: the human rendering reports the same finding the exit status does', () => {
  const { home, projectRoot } = divergedScopes('human');

  const { returned, out } = callVerb({ home, projectRoot, targets: ['claude'] });

  assert.equal(returned, 1);
  assert.match(out, /DoFlow cross-scope inventory/, 'the verb prints a report when --json is absent');
  assert.match(out, /diverged/, 'and names the currency that produced the status');
  assert.match(out, /doflow reconcile/, 'and states the literal remedy, which it never performs');
});

// --------------------------------------------------- IC-001: exit 2, the verb could not do what was asked

test('IC-001 exit 2: a named harness the registry does not declare', () => {
  const { home, projectRoot } = emptyScopes('unknown');

  const inProcess = callVerb({ home, projectRoot, targets: ['nosuch'] });
  assert.equal(inProcess.returned, 2, 'an undeclared harness is an argument error, not an empty report');
  assert.equal(inProcess.exitCode, 2);
  assert.equal(inProcess.err, "doflow inventory: Unknown registry harness 'nosuch'",
    'the refusal names the id it did not find, so the caller can see the typo');
  assert.equal(inProcess.out, '', 'and no report is printed: the question was not answered');

  const cli = run(['-t', 'nosuch', projectRoot], { home, cwd: REPO });
  assert.equal(cli.status, 2, `and the process itself exits 2:\n${cli.stdout}${cli.stderr}`);
  assert.match(cli.stderr, /Unknown registry harness 'nosuch'/);
});

test('IC-001: a refusal under --json is the seam\'s usage object, not a report', () => {
  const { home, projectRoot } = emptyScopes('unknown-json');

  const { returned, out } = callVerb({ home, projectRoot, targets: ['nosuch'], json: true });

  assert.equal(returned, 2);
  assert.deepEqual(JSON.parse(out), {
    ok: false, status: 'USAGE', exitCode: 2, error: 'usage',
    summary: "Unknown registry harness 'nosuch'",
  }, 'a machine-readable caller must be able to tell a refusal from a clean report without parsing prose');
});

// -------------------------------------------------------------- IC-001: the verb accepts no scope selector

/**
 * IC-001: "It accepts no scope selector, because reading both scopes is the verb's entire purpose
 * and a scope flag would make its one distinguishing behaviour optional."
 *
 * The shared parser accepts `-g`/`--global` for every verb, so the refusal has to be the handler's
 * and it has to be loud. Ignoring the flag silently would answer a different question from the one
 * the caller asked; exit 0 with a report would be worse still, since the caller would read a
 * both-scopes report as the single-scope one it requested.
 */
test('IC-001: -g/--global is refused with exit 2 rather than honoured or ignored', () => {
  const { home, projectRoot } = emptyScopes('global-flag');

  const inProcess = callVerb({ home, projectRoot, global: true });
  assert.equal(inProcess.returned, 2, 'the scope selector is refused, not ignored');
  assert.equal(inProcess.exitCode, 2);
  assert.equal(inProcess.err, `doflow inventory: ${GLOBAL_REFUSAL}`);
  assert.equal(inProcess.out, '', 'no report is printed: a both-scopes report here would be read as the '
    + 'single-scope one the caller asked for');

  for (const flag of ['-g', '--global']) {
    const cli = run([flag, projectRoot], { home, cwd: REPO });
    assert.equal(cli.status, 2, `${flag} must exit 2:\n${cli.stdout}${cli.stderr}`);
    assert.equal(cli.stderr.trim(), `doflow inventory: ${GLOBAL_REFUSAL}`,
      `${flag} reaches the same refusal — both spellings are the same flag to the parser`);
  }
});

test('IC-001: the refusal is stated in the requested shape under --json', () => {
  const { home, projectRoot } = emptyScopes('global-flag-json');

  const { returned, out } = callVerb({ home, projectRoot, global: true, json: true });

  assert.equal(returned, 2);
  assert.deepEqual(JSON.parse(out), {
    ok: false, status: 'USAGE', exitCode: 2, error: 'usage', summary: GLOBAL_REFUSAL,
  });
});

// ------------------------------------------------------------------------- IC-001: the --json flag

test('IC-001: --json emits the report object, in IC-002\'s order, and nothing else', () => {
  const { home, projectRoot } = divergedScopes('json');

  const { out } = callVerb({ home, projectRoot, targets: ['claude'], json: true });

  // The whole of stdout parses: a machine-readable flag that also prints a banner is not one.
  const report = JSON.parse(out);
  assert.deepEqual(Object.keys(report),
    ['status', 'exitCode', 'summary', 'scopes', 'assets', 'unidentified', 'findings', 'repairCoverage'],
    'IC-002 orders the object so a person reading it top to bottom meets the verdict before the '
    + 'supporting detail; the key order is part of the shape, not an accident of assembly');
  assert.equal(typeof report.summary, 'string');
  assert.ok(report.summary.length > 0, 'the verdict is one sentence, stated');
  assert.ok(Array.isArray(report.assets) && Array.isArray(report.findings) && Array.isArray(report.unidentified));
  assert.equal(typeof report.repairCoverage, 'object');

  const cli = run(['-t', 'claude', projectRoot, '--json'], { home, cwd: REPO });
  assert.deepEqual(Object.keys(JSON.parse(cli.stdout)), Object.keys(report),
    'the CLI emits the same object: the flag must not acquire a wrapper on the way through the seam');
});

// ------------------------------------------------- IC-001: the optional positional project root

/**
 * IC-001: "an optional project root, defaulting to the working directory".
 *
 * Only reachable through the CLI, where the default is applied
 * (`src/cli/runtime-commands.js`: `path.resolve(o.positional[0] || '.')`). Both halves of the clause
 * are asserted from one fixture, because the default only means something against an explicit value
 * that overrides it: a verb that reported the working directory whatever it was handed would satisfy
 * the first assertion alone.
 */
test('IC-001: the positional project root defaults to the working directory, and an explicit one overrides it', () => {
  const home = scratch('doflow-inventory-cmd-cwd-home-');
  const cwd = scratch('doflow-inventory-cmd-cwd-default-');
  const elsewhere = scratch('doflow-inventory-cmd-cwd-explicit-');

  const projectRootOf = (result) => {
    assert.equal(result.status, 0, `the run must answer:\n${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout).scopes.find((scope) => scope.scope === 'project').root;
  };

  assert.equal(projectRootOf(run(['-t', 'claude', '--json'], { home, cwd })), cwd,
    'with no positional the project scope is read at the working directory');
  assert.equal(projectRootOf(run(['-t', 'claude', elsewhere, '--json'], { home, cwd })), elsewhere,
    'an explicit positional is read instead of the working directory, so the default is a default '
    + 'rather than the only behaviour');
});

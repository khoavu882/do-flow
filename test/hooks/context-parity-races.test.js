'use strict';

// Feature 078 FR-001 parity for the states a plain peek cannot reach (review L1-10, L2-04): the
// prompt hook (from an install mirror) and emitContext({event: 'prompt'}) committing over a byte
// copy of the same store must render the same context and the same emit decision when
//   - the owner summary is removed between the peek and the claim,
//   - a fitting grant is removed between the peek and the claim,
//   - a pre-078 project summary (IC-014) is present.
// The race is the claim's own rename losing its source: in the hook a test-only `mv` function in a
// mirrored summary-store.sh removes the source first; in-process fs.renameSync does the same. Both
// sides record that the race fired, so a pass cannot come from a race that never happened.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildInstallMirror } = require('../helper/hook-fixtures.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { firstPrompt } = require('../helper/launcher-stand-in.ts');
const { writeSummary } = require('../helper/summary-fixture.ts');
const { emitContext } = require('../../src/runtime/context-pack.ts');
const { grantSummary } = require('../../src/runtime/context/summary-store.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const scratch = createScratch('doflow-context-races-');
const mirror = path.join(scratch.dir, 'mirror');

/** Paths whose rename each race removes first: the owner summary, or a grant addressed to a unit. */
const RACE_SOURCE = {
  summary: /\/summaries\/[^/]+\/[^/]+\/[^/]+\/summary\.md$/,
  grant: /\/grants\/[^/]+\/[^/]+\/s-[^/]+\.md$/,
};

// Test-only: shadows mv inside the hook process when DF_TEST_RACE names a race, removing the
// source that race targets just before the rename, and marking that it did.
const RACE_SHIM = `
mv() {
  local src="" a
  for a in "$@"; do case $a in -*) ;; *) src=$a; break ;; esac; done
  case "\${DF_TEST_RACE:-}:$src" in
    summary:*/summaries/*/summary.md | grant:*/grants/*/s-*.md)
      rm -f -- "$src"
      [ -z "\${DF_TEST_RACE_MARK:-}" ] || printf '%s\\n' "$src" >>"$DF_TEST_RACE_MARK" ;;
  esac
  command mv "$@"
}
`;

test.before(() => {
  buildInstallMirror(mirror);
  fs.appendFileSync(path.join(mirror, '.doflow', 'shared', 'hooks', 'policies', 'summary-store.sh'), RACE_SHIM);
});
test.after(() => scratch.remove());

let seq = 0;
/** A fresh world: a git repository on `main` with one commit and its own store. */
function world() {
  const root = path.join(scratch.dir, `race${seq++}`);
  const w = { root, repo: path.join(root, 'repo'), home: path.join(root, 'home'), xdg: path.join(root, 'xdg') };
  for (const dir of [w.repo, w.home, w.xdg]) fs.mkdirSync(dir, { recursive: true });
  w.repo = fs.realpathSync(w.repo);
  const git = (...args) => {
    const r = spawnSync('git', ['-C', w.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env: scratch.env(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  w.env = envFor(w.home, w.xdg);
  w.store = path.join(w.xdg, 'doflow', 'session-env');
  return w;
}

function envFor(home, xdg, extra = {}) {
  return scratch.env({
    HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: 'off',
    CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '', CODEX_HOME: '', DOFLOW_PROJECT_DIR: '', DOFLOW_AGENT: '',
    DOFLOW_RUN_ID: '', DOFLOW_LINEAGE_ID: '', DOFLOW_ATTEMPT: '', DOFLOW_SESSION_ROLE: '', DOFLOW_WORKTREE: '', DOFLOW_CONTEXT_MAX_BYTES: '',
    DF_TEST_RACE: '', DF_TEST_RACE_MARK: '',
    ...extra,
  });
}

function pending(w, body) {
  const made = writeSummary({ worktree: w.repo, run: 'local', lineage: 'main', compactedAt: '2026-10-14T10:00:00Z', sessionId: 'owner', branch: 'main', body, env: w.env });
  assert.ok(made, 'the summary is written');
}

function copyOf(w) {
  const xdg = path.join(w.root, 'xdg-copy');
  fs.cpSync(w.xdg, xdg, { recursive: true });
  return { ...w, xdg, env: { ...w.env, XDG_CONFIG_HOME: xdg }, store: path.join(xdg, 'doflow', 'session-env') };
}

/** emitContext committing, with fs.renameSync losing `race`'s source; returns the result and how often it fired. */
function emitWithRace(options, race) {
  const real = fs.renameSync;
  let fired = 0;
  if (race) {
    fs.renameSync = function racedRename(from, to) {
      if (RACE_SOURCE[race].test(String(from))) { fs.rmSync(from, { force: true }); fired += 1; }
      return real.call(fs, from, to);
    };
  }
  try {
    return { result: emitContext(options), fired };
  } finally {
    fs.renameSync = real;
  }
}

const LAUNCHED = { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker' };

const STATES = [
  {
    name: 'owner summary removed between peek and claim',
    prepare(w) { pending(w, 'RACE-SUMMARY'); },
    env: {}, race: 'summary', absent: /RACE-SUMMARY|\[Prior session summary/,
  },
  {
    name: 'grant removed between peek and claim',
    prepare(w) {
      pending(w, 'RACE-GRANT');
      grantSummary({ summary: 'pending', toRun: 'r1', toLineage: 'w1', fromWorktree: w.repo, fromRun: 'local', fromLineage: 'main', env: w.env });
    },
    env: LAUNCHED, race: 'grant', absent: /RACE-GRANT|\[Granted summary/,
  },
  {
    name: 'pre-078 project summary present',
    prepare(w) {
      const old = path.join(w.store, 'projects', cwdHash(w.repo), 'last-compact-summary.md');
      fs.mkdirSync(path.dirname(old), { recursive: true });
      fs.writeFileSync(old, '---\ncompacted_at: 2026-01-01T00:00:00Z\nsession_id: OLD\ntrigger: auto\nbranch: main\n---\n\nRACE-LEGACY\n');
      w.legacy = old;
    },
    env: {}, race: null, expect: /RACE-LEGACY/,
  },
];

/** One state through both callers; `root` is the install mirror whose hook runs. */
function compare(harness, state, root = mirror) {
  const w = world();
  const sid = `race-${harness}-${seq}`;
  state.prepare(w);
  const env = { ...w.env, ...state.env };
  spawnSync('bash', [path.join(root, `.${harness}`, 'hooks', 'session-start.sh')], {
    cwd: w.repo, input: `${JSON.stringify({ session_id: sid, cwd: w.repo, hook_event_name: 'SessionStart', source: 'startup' })}\n`, env, encoding: 'utf8',
  });
  const copy = copyOf(w);

  const peeked = emitContext({ event: 'prompt', cwd: w.repo, sessionId: sid, harness, peek: true, env: { ...copy.env, ...state.env } });
  const { result, fired } = emitWithRace({ event: 'prompt', cwd: w.repo, sessionId: sid, harness, env: { ...copy.env, ...state.env } }, state.race);
  const mark = path.join(w.root, 'race-mark');
  const hook = firstPrompt({ mirror: root, harness, sessionId: sid, cwd: w.repo, start: false,
    env: { ...env, DF_TEST_RACE: state.race ?? '', DF_TEST_RACE_MARK: mark } });

  assert.equal(hook.additionalContext, result.text ?? '', 'the hook renders what the authority renders');
  assert.equal(hook.additionalContext !== '', result.decision.emit, 'and decides the same emit');
  assert.doesNotMatch(result.decision.reason, /^fault:/, 'a lost race is that input absent, not a fault');
  if (!result.decision.emit) assert.deepEqual(JSON.parse(hook.stdout), {}, 'a silent decision is {}');
  if (state.race) {
    assert.equal(fired, 1, 'the in-process claim lost its source once');
    assert.equal(fs.readFileSync(mark, 'utf8').trim().split('\n').length, 1, 'the hook claim lost its source once');
    assert.match(peeked.text ?? '', /RACE-/, 'the peek before the race would have delivered it');
    assert.doesNotMatch(hook.additionalContext, state.absent, 'the lost input is absent');
  }
  if (state.expect) {
    assert.match(hook.additionalContext, state.expect, 'the legacy summary is delivered');
    assert.equal(peeked.text, result.text, 'the peek reads the legacy file as the summary the prompt adopts');
    assert.equal(fs.existsSync(w.legacy), false, 'the hook adopted and removed the legacy file');
    assert.equal(fs.existsSync(path.join(copy.store, 'projects', cwdHash(w.repo), 'last-compact-summary.md')), false, 'and so did emitContext');
  }
}

for (const harness of ['claude', 'codex']) {
  for (const state of STATES) {
    test(`FR-001 (${harness}): ${state.name}: the hook and emitContext({event: 'prompt'}) commit the same answer`, () => {
      compare(harness, state);
    });
  }
}

test('negative control: a hook that treats a lost summary claim as a fault fails the parity test', () => {
  const sabotaged = path.join(scratch.dir, 'mirror-lost-claim-fault');
  buildInstallMirror(sabotaged);
  fs.appendFileSync(path.join(sabotaged, '.doflow', 'shared', 'hooks', 'policies', 'summary-store.sh'), RACE_SHIM);
  const file = path.join(sabotaged, '.doflow', 'shared', 'hooks', 'policies', 'emission.sh');
  const text = fs.readFileSync(file, 'utf8');
  const anchor = '      own=none\n      _doflow_em_actions\n    fi\n  fi\n  if [ "$a_grant" = whole ]';
  assert.ok(text.includes(anchor), 'control anchor present');
  fs.writeFileSync(file, text.replace(anchor, '      _doflow_em_release\n      _doflow_em_silent summary\n      return 0\n    fi\n  fi\n  if [ "$a_grant" = whole ]'));
  assert.throws(() => compare('claude', STATES[0], sabotaged), { name: 'AssertionError', message: /^the hook renders what the authority renders/ });
});

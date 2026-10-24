'use strict';

// bash-args.test.js — FU-r4ff7s. The helper scripts' argument loops read only `--flag=value`; a
// space-separated `--slug x` fell through the `*) ;;` arm and the call resolved the ACTIVE feature
// instead of the one named. One shared rule (do-args.sh) now folds `--flag value` into
// `--flag=value` for the flags each script declares; the `=` form, and every call that carried no
// value for a flag, behave as before.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const BASH = path.resolve(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bash');
const script = (name: any) => path.join(BASH, name);

const scratch = createScratch('doflow-bash-args-');
after(() => scratch.remove());

const PLAN = `## 8. Tasks
### Phase A — auth
- [ ] A.1 [P] [US1] build — owner: core-implementer; files: src/a.js
- [ ] A.2 [P] [US1] second — owner: core-implementer; files: src/b.js
`;

/** A scratch project on main with two feature folders, so only an explicit slug can pick one. */
function project() {
  const dir = path.join(scratch.dir, `p-${fs.readdirSync(scratch.dir).length}`);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: any[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: dir, encoding: 'utf8', env: scratch.env() });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  git('commit', '-q', '--allow-empty', '-m', 'two');
  for (const slug of ['001-auth', '002-other']) {
    fs.mkdirSync(path.join(dir, 'agent-docs', 'doflow', slug), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-docs', 'doflow', slug, 'plan.md'), PLAN);
  }
  return dir;
}

function run(name: any, args: any, cwd: any) {
  const res = spawnSync('bash', [script(name), ...args], { cwd, encoding: 'utf8', env: scratch.env(), timeout: 120000 });
  let data = null;
  try { data = JSON.parse(res.stdout); } catch { /* asserted by the caller */ }
  return { status: res.status, data, stdout: res.stdout, stderr: res.stderr };
}

/** The `--flag=value` call and the `--flag value` call answer identically, and the answer is not an error. */
function sameAnswer(name: any, equalsArgs: any, spaceArgs: any, cwd: any, expect: any) {
  const a = run(name, equalsArgs, cwd);
  const b = run(name, spaceArgs, cwd);
  assert.equal(a.status, 0, `${name} ${equalsArgs.join(' ')}: ${a.stdout}${a.stderr}`);
  expect(a.data);
  assert.equal(b.status, a.status, `${name} ${spaceArgs.join(' ')}: ${b.stdout}`);
  assert.deepEqual(b.data, a.data, `${name} ${spaceArgs.join(' ')}`);
}

describe('--flag value resolves like --flag=value', () => {
  test('do-paths.sh --slug', () => {
    const cwd = project();
    sameAnswer('do-paths.sh', ['--json', '--slug=001-auth'], ['--json', '--slug', '001-auth'], cwd, (d: any) => {
      assert.equal(d.feature_slug, '001-auth');
      assert.equal(d.feature_dir, 'agent-docs/doflow/001-auth');
    });
  });

  test('do-paths.sh --slug refuses an unsafe value the same way in both forms', () => {
    const cwd = project();
    const a = run('do-paths.sh', ['--json', '--slug=../x'], cwd);
    const b = run('do-paths.sh', ['--json', '--slug', '../x'], cwd);
    assert.equal(a.status, 2);
    assert.equal(b.status, 2);
    assert.equal(b.data.error, 'invalid-slug');
  });

  test('do-git-state.sh --branch-name --class --slug', () => {
    const cwd = project();
    sameAnswer('do-git-state.sh', ['--branch-name', '--class=feature', '--slug=001-auth'],
      ['--branch-name', '--class', 'feature', '--slug', '001-auth'], cwd, (d: any) => assert.equal(d.name, 'feat/001-auth'));
  });

  test('do-exec-paths.sh --task --slug and --group --tasks --slug', () => {
    const cwd = project();
    sameAnswer('do-exec-paths.sh', ['--task=A.1', '--slug=001-auth'], ['--task', 'A.1', '--slug', '001-auth'], cwd, (d: any) => {
      assert.equal(d.task_id, 'A.1');
      assert.equal(d.feature_dir, 'agent-docs/doflow/001-auth');
    });
    sameAnswer('do-exec-paths.sh', ['--group=A:core-implementer', '--tasks=A.1,A.2', '--slug=002-other'],
      ['--group', 'A:core-implementer', '--tasks', 'A.1,A.2', '--slug', '002-other'], cwd, (d: any) => {
        assert.equal(d.feature_dir, 'agent-docs/doflow/002-other');
      });
  });

  test('do-parallel-check.sh --phase --slug', () => {
    const cwd = project();
    sameAnswer('do-parallel-check.sh', ['--phase=A', '--slug=001-auth'], ['--phase', 'A', '--slug', '001-auth'], cwd, (d: any) => {
      assert.deepEqual(d.parallel_tasks, ['A.1', 'A.2']);
    });
  });

  test('do-review-package.sh --task --base --head --slug', () => {
    const cwd = project();
    sameAnswer('do-review-package.sh', ['--task=A.1', '--base=HEAD~1', '--head=HEAD', '--slug=001-auth'],
      ['--task', 'A.1', '--base', 'HEAD~1', '--head', 'HEAD', '--slug', '001-auth'], cwd, (d: any) => {
        assert.match(d.path, /^agent-docs\/doflow\/001-auth\/exec\/review-/);
        assert.equal(d.commits, 1);
      });
  });

  test('do-task-brief.sh --task --slug --harness', () => {
    const cwd = project();
    sameAnswer('do-task-brief.sh', ['--task=A.1', '--slug=001-auth', '--harness=claude', '--json'],
      ['--task', 'A.1', '--slug', '001-auth', '--harness', 'claude', '--json'], cwd, (d: any) => {
        assert.equal(d.path, 'agent-docs/doflow/001-auth/exec/task-A.1-brief.md');
      });
  });
});

describe('calls that worked before are unchanged', () => {
  test('a bare trailing --slug is still ignored, as before', () => {
    const cwd = project();
    const plain = run('do-paths.sh', ['--json'], cwd);
    const bare = run('do-paths.sh', ['--json', '--slug'], cwd);
    assert.equal(bare.status, plain.status);
    assert.deepEqual(bare.data, plain.data);
  });

  test('--slug followed by another flag takes no value from it', () => {
    const cwd = project();
    const plain = run('do-paths.sh', ['--json'], cwd);
    const flagNext = run('do-paths.sh', ['--slug', '--json'], cwd);
    assert.equal(flagNext.status, plain.status);
    assert.deepEqual(flagNext.data, plain.data);
  });

  test('--slug followed by a value that starts with a dash is not consumed', () => {
    const cwd = project();
    const plain = run('do-paths.sh', ['--json'], cwd);
    const dashed = run('do-paths.sh', ['--json', '--slug', '-flag'], cwd);
    assert.equal(dashed.status, plain.status);
    assert.deepEqual(dashed.data, plain.data);
  });

  test('the --require feature form of do-paths.sh still reads its own value', () => {
    const cwd = project();
    const a = run('do-paths.sh', ['--json', '--require', 'feature', '--slug', '001-auth'], cwd);
    assert.equal(a.status, 0);
    assert.equal(a.data.feature_slug, '001-auth');
  });
});

describe('the shared rule (do-args.sh)', () => {
  const normalize = (flags: any, ...args: any[]) => {
    const res = spawnSync('bash', ['-c', 'set -u; . "$1"; shift; flags="$1"; shift; doflow_normalize_args "$flags" "$@"; for a in ${DOFLOW_ARGS[@]+"${DOFLOW_ARGS[@]}"}; do printf "%s\\0" "$a"; done', 'x', script('do-args.sh'), flags, ...args],
      { encoding: 'utf8', env: scratch.env() });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.split('\0').slice(0, -1);
  };

  test('folds a declared flag with its value and leaves everything else alone', () => {
    assert.deepEqual(normalize('--slug --task', '--json', '--slug', 'a b', '--task=X', 'pos', '--other', 'v'),
      ['--json', '--slug=a b', '--task=X', 'pos', '--other', 'v']);
  });

  test('keeps a declared flag bare when no value follows or the next word is a flag', () => {
    assert.deepEqual(normalize('--slug', '--slug'), ['--slug']);
    assert.deepEqual(normalize('--slug', '--slug', '--json'), ['--slug', '--json']);
    assert.deepEqual(normalize('--slug', '--slug', '-x'), ['--slug', '-x']);
  });

  test('an empty argument list yields an empty array under set -u', () => {
    assert.deepEqual(normalize('--slug'), []);
  });

  test('an empty value is a value', () => {
    assert.deepEqual(normalize('--slug', '--slug', ''), ['--slug=']);
  });
});

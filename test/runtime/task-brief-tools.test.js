'use strict';

// 062 D.1 — the brief generator's tier, tools and report-format block (CH8, IC-018, IC-019).
// do-task-brief.sh runs in a scratch feature with a plan, a requirement and a design. Most cases put a
// fake `doflow-run` beside the copied helpers, so the generator's side of the contract (what it
// passes, where it places the block, what it writes, how it fails open) is driven without the
// registries; one case runs the real dispatcher end to end.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const SCRIPTS = path.resolve(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow');
const HELPERS = ['do-paths.sh', 'do-exec-paths.sh', 'do-task-brief.sh'];
const FEATURE = '001-auth';
const EXEC = `agent-docs/doflow/${FEATURE}/exec`;

const scratch = createScratch('doflow-task-brief-tools-');
after(() => scratch.remove());

const FAKE_RUN = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "\${FAKE_MODE:-ok}" in
  fail) echo "boom" >&2; exit 3 ;;
  garbage) echo "this is not json"; exit 0 ;;
esac
level=2; prev=""
for a in "$@"; do [ "$prev" = "--heading-level" ] && level="$a"; prev="$a"; done
h="$(printf '#%.0s' $(seq 1 "$level"))"
jq -n --arg h "$h" '{markdown: ($h + " Tier and tools\\n\\nFAKE BLOCK\\n\\n" + $h + " Report format\\n\\nFAKE REPORT FORMAT\\n"), record: {schema: 1, stage: "design", owner: "x", missing: [], advice: {kind:"tier", status:"answered", pickId:"adv-1760097600000-3fa2c1"}}}'
`;

const PLAN = `## 1. Approach
Bottom-up.
## 7. Validation Strategy
| Requirement | Verified by |
|---|---|
| FR-001 | integration test on the login route |
## 8. Tasks
### Phase A — auth
- [ ] A.1 [P] [US1] build the handler — owner: core-implementer; tier: frontier; files: src/auth.js
- [ ] A.2 [P] [US1] second — owner: core-implementer; tier: frontier; files: src/b.js
- [ ] A.3 [P] [US1] third — owner: core-implementer; tier: light; files: src/c.js
- [ ] A.4 [P] [US1] fourth — owner: core-implementer; files: src/d.js
- [ ] A.5 [US1] no owner here — files: src/e.js
### Checkpoints
- After Phase A: run the suite
`;

const REQUIREMENT = `## 2. User Stories
- **US1 (P1):** As a user, I want to log in.
## 3. Functional Requirements
| ID | Requirement | Story | Priority | Status |
|---|---|---|---|---|
| FR-001 | login endpoint | US1 | P1 | Live |
**Detail**
- **FR-001:** The system MUST accept a POST.
## 4. Non-Functional Requirements
| ID | Constraint | Kind | Status |
|---|---|---|---|
| NFR-001 | p95 under 200ms | performance | Live |
**Detail**
- **NFR-001 (Latency):** p95 under 200ms.
## 5. Out of Scope
`;

const DESIGN = `## 3. Components & Boundaries
| ID | Component | Kind | Serves | Status |
|---|---|---|---|---|
| CMP1 | auth handler | service | FR-001 | Live |
**Detail**
- **CMP1** → owns credential verification.
## 4. API / Interface Contracts
`;

let counter = 0;
/** A scratch install tree (helpers, optionally a fake dispatcher) beside a scratch project on a feature branch. */
function fixture({ dispatcher = 'fake' } = {}) {
  const dir = path.join(scratch.dir, `case-${counter++}`);
  const bash = path.join(dir, 'tree', 'doflow', 'bash');
  const bin = path.join(dir, 'tree', 'doflow', 'bin');
  const project = path.join(dir, 'project');
  fs.mkdirSync(bash, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  for (const helper of HELPERS) fs.copyFileSync(path.join(SCRIPTS, 'bash', helper), path.join(bash, helper));
  const log = path.join(dir, 'calls.log');
  if (dispatcher === 'fake') {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'doflow-run'), FAKE_RUN, { mode: 0o755 });
  }
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: project, encoding: 'utf8', env: scratch.env() });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('checkout', '-q', '-b', `feat/${FEATURE}`);
  const featureDir = path.join(project, 'agent-docs', 'doflow', FEATURE);
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'plan.md'), PLAN);
  fs.writeFileSync(path.join(featureDir, 'requirement.md'), REQUIREMENT);
  fs.writeFileSync(path.join(featureDir, 'design.md'), DESIGN);

  const brief = (args, env = {}) => {
    const res = spawnSync('bash', [path.join(bash, 'do-task-brief.sh'), ...args], {
      cwd: project, encoding: 'utf8', timeout: 120000, env: scratch.env({ FAKE_LOG: log, ...env }),
    });
    let data = null;
    try { data = JSON.parse(res.stdout); } catch { /* asserted by the caller */ }
    return { status: res.status, data, stdout: res.stdout, stderr: res.stderr };
  };
  const read = (rel) => fs.readFileSync(path.join(project, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(project, rel));
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { dir, bash, bin, project, brief, read, exists, calls };
}

const at = (text, needle) => {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `missing ${JSON.stringify(needle)}`);
  return index;
};
const count = (text, needle) => text.split(needle).length - 1;

describe('single-task mode', () => {
  test('places the block after the verification bar and writes the record at brief_record', () => {
    const f = fixture();
    const res = f.brief(['--task=A.1', `--slug=${FEATURE}`]);
    assert.equal(res.status, 0, res.stderr);
    const md = f.read(`${EXEC}/task-A.1-brief.md`);
    assert.ok(at(md, '## Verification bar') < at(md, '## Tier and tools'));
    assert.ok(at(md, '## Tier and tools') < at(md, '## Report format'));
    assert.match(md, /FAKE BLOCK/);
    assert.equal(count(md, '## Tier and tools'), 1);
    assert.equal(res.data.record, `${EXEC}/task-A.1-brief.json`);
    const record = JSON.parse(f.read(`${EXEC}/task-A.1-brief.json`));
    assert.equal(record.schema, 1);
    assert.deepEqual(record.tasks, [{ id: 'A.1', report: `${EXEC}/task-A.1-report.md` }]);
    assert.deepEqual(record.advice, { kind: 'tier', status: 'answered', pickId: 'adv-1760097600000-3fa2c1' });
    assert.deepEqual(res.data.missing, []);
    assert.equal(res.data.path, `${EXEC}/task-A.1-brief.md`, 'existing JSON fields are kept');
  });

  test('calls the dispatcher once, with the owner and the task line tier', () => {
    const f = fixture();
    f.brief(['--task=A.1', `--slug=${FEATURE}`]);
    const calls = f.calls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^brief-tools /);
    assert.match(calls[0], /--json/);
    assert.match(calls[0], /--owner core-implementer/);
    assert.match(calls[0], /--tier frontier/);
    assert.match(calls[0], /--heading-level 2/);
    assert.match(calls[0], /--tasks A\.1/);
    assert.match(calls[0], new RegExp(`--slug ${FEATURE}`));
    assert.doesNotMatch(calls[0], /--harness/);
  });

  test('passes no tier when the task line carries none', () => {
    const f = fixture();
    f.brief(['--task=A.4', `--slug=${FEATURE}`]);
    assert.doesNotMatch(f.calls()[0], /--tier/);
  });

  test('--harness reaches the verb', () => {
    const f = fixture();
    f.brief(['--task=A.1', '--harness=codex', `--slug=${FEATURE}`]);
    assert.match(f.calls()[0], /--harness codex/);
  });
});

describe('group mode', () => {
  test('puts the ### block at the end of Shared context, with one Shared context', () => {
    const f = fixture();
    const res = f.brief(['--group=A:core-implementer', '--tasks=A.1,A.2', `--slug=${FEATURE}`]);
    assert.equal(res.status, 0, res.stderr);
    const md = f.read(`${EXEC}/group-A-core-implementer-brief.md`);
    assert.equal(count(md, '\n## Shared context'), 1);
    assert.equal(count(md, '### Tier and tools'), 1);
    assert.equal(count(md, '## Tier and tools'), 1, 'only the ### form exists');
    assert.ok(at(md, '### Where this fits') < at(md, '### Tier and tools'));
    assert.ok(at(md, '### Tier and tools') < at(md, '### Report format'));
    assert.ok(at(md, '### Report format') < at(md, '## Task order'));
    assert.match(f.calls()[0], /--heading-level 3/);
    assert.match(f.calls()[0], /--tasks A\.1,A\.2/);
    assert.match(f.calls()[0], /--owner core-implementer/);
    assert.equal(res.data.record, `${EXEC}/group-A-core-implementer-brief.json`);
    const record = JSON.parse(f.read(`${EXEC}/group-A-core-implementer-brief.json`));
    assert.deepEqual(record.tasks, [
      { id: 'A.1', report: `${EXEC}/task-A.1-report.md` },
      { id: 'A.2', report: `${EXEC}/task-A.2-report.md` },
    ]);
    assert.deepEqual(record.advice, { kind: 'tier', status: 'answered', pickId: 'adv-1760097600000-3fa2c1' });
  });

  test('passes the tier when every task carries the same value, none when they disagree', () => {
    const same = fixture();
    same.brief(['--group=A:core-implementer', '--tasks=A.1,A.2', `--slug=${FEATURE}`]);
    assert.equal(same.calls().length, 1);
    assert.match(same.calls()[0], /--tier frontier/);

    const differ = fixture();
    differ.brief(['--group=A:core-implementer', '--tasks=A.1,A.3', `--slug=${FEATURE}`]);
    assert.doesNotMatch(differ.calls()[0], /--tier/);

    const partial = fixture();
    partial.brief(['--group=A:core-implementer', '--tasks=A.1,A.4', `--slug=${FEATURE}`]);
    assert.doesNotMatch(partial.calls()[0], /--tier/, 'a task without tier: means the tasks do not agree');
  });

  test('a single-task group is byte-identical to --task', () => {
    const f = fixture();
    f.brief(['--task=A.1', `--slug=${FEATURE}`]);
    f.brief(['--group=A:core-implementer', '--tasks=A.1', `--slug=${FEATURE}`]);
    const task = f.read(`${EXEC}/task-A.1-brief.md`);
    assert.equal(f.read(`${EXEC}/group-A-core-implementer-brief.md`), task);
    assert.equal(count(task, '## Tier and tools'), 1);
    assert.equal(
      f.read(`${EXEC}/group-A-core-implementer-brief.json`),
      f.read(`${EXEC}/task-A.1-brief.json`),
    );
  });
});

describe('fail-open', () => {
  const REASONS = {
    'dispatcher missing': { options: { dispatcher: 'none' }, env: {}, reason: /dispatcher/ },
    'dispatcher exits non-zero': { options: {}, env: { FAKE_MODE: 'fail' }, reason: /exited 3/ },
    'dispatcher prints non-JSON': { options: {}, env: { FAKE_MODE: 'garbage' }, reason: /unparseable/ },
  };

  for (const [name, { options, env, reason }] of Object.entries(REASONS)) {
    test(`single task, ${name}`, () => {
      const healthy = fixture();
      const baseline = healthy.brief(['--task=A.1', `--slug=${FEATURE}`]);
      const f = fixture(options);
      const res = f.brief(['--task=A.1', `--slug=${FEATURE}`], env);
      assert.equal(res.status, baseline.status, 'the exit code is what it would have been');
      assert.equal(res.status, 0);
      const md = f.read(`${EXEC}/task-A.1-brief.md`);
      assert.match(md, /^## Tier and tools\n\nNot generated: .+\. Name the tier and tools in the dispatch\.$/m);
      assert.match(md, reason);
      assert.match(md, /^## Report format$/m);
      assert.match(md, /^`Tools used: <name>\[=used\|nothing-usable\|unavailable\|skipped:<reason>\], \.\.\.`$/m);
      assert.ok(at(md, '## Verification bar') < at(md, '## Tier and tools'));
      assert.doesNotMatch(md, /FAKE/);
      assert.equal(f.exists(`${EXEC}/task-A.1-brief.json`), false, 'no record is written');
      assert.equal(res.data.record, null);
      assert.equal(res.data.missing.length, 1);
      assert.match(res.data.missing[0], /^brief-tools: /);
      assert.match(res.data.missing[0], reason);
    });

    test(`group, ${name}`, () => {
      const f = fixture(options);
      const res = f.brief(['--group=A:core-implementer', '--tasks=A.1,A.2', `--slug=${FEATURE}`], env);
      assert.equal(res.status, 0);
      const md = f.read(`${EXEC}/group-A-core-implementer-brief.md`);
      assert.equal(count(md, '\n## Shared context'), 1);
      assert.match(md, /^### Tier and tools\n\nNot generated: .+\. Name the tier and tools in the dispatch\.$/m);
      assert.match(md, /^### Report format$/m);
      assert.match(md, /End each task's report with one line/);
      assert.ok(at(md, '### Report format') < at(md, '## Task order'));
      assert.equal(f.exists(`${EXEC}/group-A-core-implementer-brief.json`), false);
      assert.equal(res.data.record, null);
      assert.match(res.data.missing.at(-1), /^brief-tools: /);
    });
  }

  test('a task line with no owner is not sent to the verb', () => {
    const f = fixture();
    const res = f.brief(['--task=A.5', `--slug=${FEATURE}`]);
    assert.equal(res.status, 0);
    assert.equal(f.calls().length, 0);
    assert.match(f.read(`${EXEC}/task-A.5-brief.md`), /Not generated: .*owner/);
    assert.match(res.data.missing.at(-1), /^brief-tools: .*owner/);
    assert.equal(res.data.record, null);
  });

  test('the generator carries no tool, provider, server or tier name', () => {
    const text = fs.readFileSync(path.join(SCRIPTS, 'bash', 'do-task-brief.sh'), 'utf8');
    for (const name of ['semble', 'graphify', 'context7', 'sequential-thinking', 'frontier', 'light', 'standard']) {
      assert.equal(text.includes(name), false, name);
    }
  });
});

describe('real dispatcher', () => {
  test('a brief generated through the installed dispatcher carries the block and a record', () => {
    // The helpers stay in the repo tree so "$script_dir/../bin/doflow-run" is the shipped dispatcher.
    const f = fixture({ dispatcher: 'none' });
    const real = path.join(SCRIPTS, 'bash', 'do-task-brief.sh');
    const res = spawnSync('bash', [real, '--task=A.1', '--harness=claude', `--slug=${FEATURE}`], {
      cwd: f.project, encoding: 'utf8', timeout: 300000, env: scratch.env({ DOFLOW_CLI: path.resolve(__dirname, '..', '..', 'bin', 'doflow.js') }),
    });
    assert.equal(res.status, 0, res.stderr);
    const data = JSON.parse(res.stdout);
    const md = f.read(`${EXEC}/task-A.1-brief.md`);
    assert.match(md, /^## Tier and tools$/m);
    assert.match(md, /^Tier: `frontier` \(task line\)/m);
    assert.match(md, /^## Report format$/m);
    assert.doesNotMatch(md, /Not generated/);
    assert.equal(data.record, `${EXEC}/task-A.1-brief.json`);
    const record = JSON.parse(f.read(`${EXEC}/task-A.1-brief.json`));
    assert.equal(record.harness, 'claude');
    assert.equal(record.owner, 'core-implementer');
    assert.equal(record.tierSource, 'task');
    assert.deepEqual(record.tasks, [{ id: 'A.1', report: `${EXEC}/task-A.1-report.md` }]);
  });
});

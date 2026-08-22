'use strict';

// G11 — evaluation coverage. A skill with no bench cases is a skill whose behaviour nobody can
// measure, which is exactly the state feature 008 exists to leave behind: the Phase D prose
// rewrite accepts behaviour drift, and that is only an acceptable trade when the drift is visible.
// A skill added later without cases would silently shrink the measured surface, so this guard
// reads the shipped skill list rather than any hand-maintained inventory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillFiles } = require('./_shared');

const REPO = path.resolve(__dirname, '..', '..');
const BENCH = path.join(REPO, 'bench');
// bench/ became local-only (gitignored) in b56406f: fresh clones legitimately lack it. The guard
// suite degrades to one skipped test there instead of crashing the offline default suite.
const HAS_BENCH = fs.existsSync(path.join(BENCH, 'runner.js'));
const runner = HAS_BENCH ? require('../../bench/runner.js') : null;
const { WorktreeManager, SKILL_SOURCE_FILE, SANDBOX_SKILLS_DIR, sha256File } = require('../../src/runtime/worktree.js');

// With no local bench/, only the harness-independent contracts below the conditional run; the
// corpus/provenance checks need bench files that legitimately may not exist in this checkout.
if (HAS_BENCH) {

function casesFor(skill) {
  const file = path.join(BENCH, skill, 'evals.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('G11: every shipped skill has a bench case file', () => {
  const missing = skillFiles()
    .map(({ name }) => name)
    .filter((name) => casesFor(name) === null);
  assert.deepEqual(
    missing,
    [],
    `skills with no bench/<skill>/evals.json: ${missing.join(', ')}\n` +
      'Add cases, or the skill ships with behaviour nobody measures.',
  );
});

test('G11: every skill has both triggering and behavioural coverage', () => {
  const gaps = [];
  for (const { name } of skillFiles()) {
    const data = casesFor(name);
    if (!data) continue; // reported by the previous test; not double-counted here
    const kinds = new Set((data.evals || []).map((e) => e.kind));
    const missing = ['triggering', 'behavioral'].filter((k) => !kinds.has(k));
    if (missing.length) gaps.push(`${name} (missing: ${missing.join(', ')})`);
  }
  assert.deepEqual(
    gaps,
    [],
    `Triggering coverage answers "does it fire on the right request"; behavioural coverage answers\n` +
      `"is it correct once it fires". One without the other measures half the risk.\n${gaps.join('\n')}`,
  );
});

test('G11: case files are well formed and internally consistent', () => {
  const problems = [];
  for (const { name } of skillFiles()) {
    const data = casesFor(name);
    if (!data) continue;
    if (data.skill_name !== name) {
      problems.push(`${name}: skill_name is "${data.skill_name}"`);
    }
    const ids = new Set();
    for (const e of data.evals || []) {
      const where = `${name}/${e.id}`;
      if (ids.has(e.id)) problems.push(`${where}: duplicate id`);
      ids.add(e.id);
      if (!e.name) problems.push(`${where}: missing descriptive name`);
      if (!e.prompt) problems.push(`${where}: missing prompt`);
      if (!['triggering', 'behavioral'].includes(e.kind)) {
        problems.push(`${where}: kind must be triggering or behavioral, got "${e.kind}"`);
      }
      if (!Array.isArray(e.assertions) || e.assertions.length === 0) {
        problems.push(`${where}: no assertions — a case that asserts nothing cannot fail`);
      }
      for (const a of e.assertions || []) {
        if (!a.text) problems.push(`${where}: an assertion has no text`);
        // A regex that does not compile fails at grading time, long after it was written, and
        // reads as a failed assertion rather than a broken one. Catch it here instead.
        if (a.type === 'output_matches' || a.type === 'output_not_matches') {
          try {
            new RegExp(a.pattern, a.flags || 'm');
          } catch (err) {
            problems.push(`${where}: invalid regex /${a.pattern}/ — ${err.message}`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

// ---------------------------------------------------------------------------
// G11b — skill provenance (plan task A.5).
//
// The harness's only job is detecting drift, so the one failure it must never have is measuring a
// different tree than the one being changed. That is not hypothetical: Claude Code merges skills
// policy → user → project and the name lookup takes the first match, so `~/.claude/skills/<name>/`
// wins over any project-scope copy (verified against 2.1.226, and observed live). Twelve of the
// thirteen installed skills currently differ from `core/shared/skills/`. A Phase D re-run that
// resolved the installed copies would compare old against old and print a null delta reading as
// "no regression".
//
// These tests hold the two properties that make that impossible to reintroduce quietly: the sandbox
// carries this repo's skills, and a run that cannot prove which SKILL.md it read is never graded as
// if it could.
// ---------------------------------------------------------------------------

test('G11b: every planned run is told to load its skill from the sandbox, by path', () => {
  const cfg = runner.loadConfig();
  const plan = runner.buildPlan(cfg, { iteration: 'guard' });
  assert.ok(plan.runCount > 0, 'the plan produced no runs');

  const problems = [];
  for (const run of plan.runs) {
    const where = `${run.skill}/${run.evalId}`;
    const expectedFile = path.join(run.sandbox.workingDir, SANDBOX_SKILLS_DIR, run.skill, 'SKILL.md');
    if (!run.skills) { problems.push(`${where}: no skills block — the run cannot know where its skill lives`); continue; }
    if (run.skills.resolution !== 'sandbox-path') problems.push(`${where}: resolution is "${run.skills.resolution}", not sandbox-path`);
    if (run.skills.skillFile !== expectedFile) problems.push(`${where}: skillFile ${run.skills.skillFile} is not inside the run's own sandbox`);
    // The hash is what lets grading tell a source-resolved run from a globally-resolved one, so a
    // stale or absent one silently disarms the check.
    const actual = sha256File(path.join(REPO, cfg.skillsRoot, run.skill, 'SKILL.md'));
    if (run.skills.sourceSha256 !== actual) problems.push(`${where}: sourceSha256 does not match ${cfg.skillsRoot}/${run.skill}/SKILL.md`);
    if (!/do not invoke/i.test(run.skills.instruction || '')) {
      problems.push(`${where}: the instruction does not tell the agent to avoid bare-name invocation, which resolves ~/.claude/skills/`);
    }
    if (!(run.saveOutputs || []).includes(runner.RUN_SOURCE_FILE)) {
      problems.push(`${where}: saveOutputs omits ${runner.RUN_SOURCE_FILE} — the run would leave no provenance`);
    }
    if (!/createSandbox\(/.test(run.sandbox.create || '')) {
      problems.push(`${where}: sandbox.create does not project this repo's skills (expected createSandbox)`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('G11b: the plan states why bare-name invocation is not an option', () => {
  const r = runner.SKILL_RESOLUTION;
  assert.equal(r.rule, 'sandbox-path');
  // Without the reason recorded, the next person to touch this reasonably assumes project scope
  // wins — which is the assumption that produced the defect.
  assert.match(r.why, /~\/\.claude\/skills/, 'the plan must name the copy that would otherwise win');
  assert.ok(Array.isArray(r.dispatchedAgentMust) && r.dispatchedAgentMust.length >= 2);
  assert.match(r.dispatchedAgentMustNot, /Skill tool|by name/i);
});

test('G11b: a sandbox is projected from this repo, byte for byte', () => {
  // A real projection through the shipped installer, not a hand-copy: a copy that only moved
  // SKILL.md would pass a hash check while leaving every `references/` path in it dangling.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bench-guard-'));
  try {
    const mgr = new WorktreeManager(REPO, tmp);
    fs.mkdirSync(path.join(tmp, 'sandbox'), { recursive: true });
    const manifest = mgr.projectSkills('sandbox');

    const shipped = skillFiles().map(({ name }) => name).sort();
    assert.deepEqual(Object.keys(manifest.skills).sort(), shipped, 'the sandbox does not carry every shipped skill');
    assert.deepEqual(manifest.mismatches, [], 'projected skills differ from source');

    for (const name of shipped) {
      const src = fs.readFileSync(path.join(REPO, 'core', 'shared', 'skills', name, 'SKILL.md'));
      const dst = fs.readFileSync(path.join(tmp, 'sandbox', SANDBOX_SKILLS_DIR, name, 'SKILL.md'));
      assert.ok(src.equals(dst), `${name}: the sandbox copy is not this repo's source`);
    }
    assert.ok(fs.existsSync(path.join(tmp, 'sandbox', SKILL_SOURCE_FILE)), 'the sandbox recorded no skill-source manifest');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G11b: grading flags a run that resolved skills outside its sandbox', () => {
  const cfg = runner.loadConfig();
  const skill = skillFiles()[0].name;
  const sourceSha = runner.skillSourceSha256(cfg, skill);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bench-prov-'));
  const mk = (name, record) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.txt'), 'ran');
    if (record) fs.writeFileSync(path.join(dir, runner.RUN_SOURCE_FILE), JSON.stringify(record));
    return runner.verifySkillSource(cfg, skill, runner.loadRunContext(dir));
  };
  try {
    const sandboxPath = path.join(REPO, '.doflow', 'worktrees', 'bench-x', SANDBOX_SKILLS_DIR, skill, 'SKILL.md');

    assert.equal(mk('ok', { skill, path: sandboxPath, sha256: sourceSha }).status, 'verified');

    // The regression this guard exists for: the Skill tool silently serving the installed copy.
    const global = mk('global', { skill, path: path.join(os.homedir(), '.claude', 'skills', skill, 'SKILL.md'), sha256: 'f'.repeat(64) });
    assert.equal(global.status, 'global-fallback');

    // A stale sandbox is a different fault from a global one and must not be conflated with it.
    assert.equal(mk('stale', { skill, path: sandboxPath, sha256: '0'.repeat(64) }).status, 'mismatch');

    // Silence is what the defect looked like, so it can never read as a pass.
    const missing = mk('silent', null);
    assert.equal(missing.status, 'unrecorded');
    assert.notEqual(missing.status, 'verified');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G11b: the run contract in bench/README.md still requires provenance', () => {
  // The dispatched agent reads the README and the plan, not this test file. If the contract stops
  // asking for the record, every future run is `unrecorded` and the harness is blind again.
  const readme = fs.readFileSync(path.join(BENCH, 'README.md'), 'utf8');
  const section = readme.split('## What a dispatched run must save')[1] || '';
  assert.ok(section, 'bench/README.md lost its "What a dispatched run must save" section');
  assert.match(section.split('\n##')[0], new RegExp(runner.RUN_SOURCE_FILE.replace('.', '\\.')));
});

}

test('G11: the bench harness is not wired into the default test command', () => {
  // npm test is pure offline Node in ~14s. Pulling paid model calls into it would make the suite
  // cost money and stop being runnable in CI without credentials.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /^node --test\b/, 'npm test must stay the offline node runner');
  assert.ok(pkg.scripts.bench, 'the bench harness needs its own npm script');
  assert.ok(
    !pkg.scripts.test.includes('bench'),
    'npm test must not invoke the bench harness — it makes paid model calls',
  );
  // Discovery must be scoped, not bare. `node --test` with no argument walks the whole repo, and
  // once bench/runs/ is committed that sweep picks up captured artifacts: a case whose deliverable
  // was an edited `*.test.js` gets executed as part of the suite. That is not a hypothetical — it
  // is how this assertion came to be written. Scoping to test/ is what keeps the suite's contents
  // decided by this directory rather than by whatever a bench case last produced.
  assert.match(
    pkg.scripts.test, /(^|\s)"?test\//,
    'npm test must scope discovery to test/ — an unscoped `node --test` also runs any *.test.js '
    + 'captured under bench/runs/',
  );
});

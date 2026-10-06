'use strict';

// G11 — evaluation coverage. A skill with no bench cases is a skill whose behaviour nobody can
// measure, which is exactly the state feature 008 exists to leave behind: the Phase D prose
// rewrite accepts behaviour drift, and that is only an acceptable trade when the drift is visible.
// A skill added later without cases would silently shrink the measured surface, so this guard
// reads the shipped skill list rather than any hand-maintained inventory.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillFiles } = require('./_shared');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const BENCH = path.join(REPO, 'bench');
// The corpus is tracked (review R6): runner, per-skill eval definitions, and the sanitized
// baseline ship with the repo, so a fresh clone can validate the corpus offline and these checks
// run unconditionally. Only run transcripts and reports stay local (bench/runs/, bench/reports/).
const HAS_BENCH = fs.existsSync(path.join(BENCH, 'runner.js'));
const runner = HAS_BENCH ? require('../../bench/runner.js') : null;
// buildPlan reads git state in-process; node --test gives each file its own process, so the scratch
// environment keeps it off the developer's HOME and global git config.
const scratch = createScratch('doflow-bench-guard-');
scratch.apply();
after(() => {
  scratch.restore();
  scratch.remove();
});
const { WorktreeManager, SKILL_SOURCE_FILE, SANDBOX_SKILLS_DIR, sha256File } = require('../../src/runtime/worktree.js');

test('G11/R6: the evaluation corpus is present — a clean clone can reproduce the baseline', () => {
  assert.ok(HAS_BENCH, 'bench/runner.js must be tracked; the corpus stopped being local-only under review R6');
  assert.ok(fs.existsSync(path.join(BENCH, 'baseline', 'baseline.json')), 'the sanitized baseline must be tracked');
  assert.ok(fs.existsSync(path.join(BENCH, 'config.json')), 'the pinned-model config must be tracked (FR-017 comparability)');
});

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

// An assertion whose `type` the runner does not know grades `passed: null` with "unknown assertion
// type" and is left for the grader subagent, so a misspelt type reads as a manual check instead of
// failing anywhere. Naming the type here is what makes the misspelling a suite failure.
function unknownAssertionTypes(filesByName, known) {
  const problems = [];
  for (const [name, data] of Object.entries(filesByName)) {
    for (const e of data.evals || []) {
      for (const a of e.assertions || []) {
        if (a.type !== undefined && !known.includes(a.type)) problems.push(`${name}/${e.id}: unknown assertion type "${a.type}"`);
      }
    }
  }
  return problems;
}

test('G11: every assertion type is one the runner knows', () => {
  const problems = unknownAssertionTypes(allCaseFiles(), runner.ASSERTION_TYPES);
  assert.deepEqual(problems, [],
    'an unknown type grades passed:null and reads as a manual check:\n  ' + problems.join('\n  '));
});

test('G11 control: an unknown assertion type is reported with its case', () => {
  const fixture = { x: { evals: [{ id: 7, assertions: [{ text: 't', type: 'skill_not_routd', skill: 'x' }, { text: 'u', type: 'skill_not_routed', skill: 'x' }, { text: 'v' }] }] } };
  assert.deepEqual(unknownAssertionTypes(fixture, runner.ASSERTION_TYPES), ['x/7: unknown assertion type "skill_not_routd"']);
});

// Every case names its side, and every skill keeps at least one case on the held-out side. The side
// is what lets a tuner iterate against one half and be judged on the other; a skill with no held-out
// case has nothing to be judged on, and a case with no side is silently counted as neither.
function splitProblems(filesByName, splits) {
  const problems = [];
  for (const [name, data] of Object.entries(filesByName)) {
    for (const e of data.evals || []) {
      if (!splits.includes(e.split)) problems.push(`${name}/${e.id}: split must be one of ${splits.join(', ')}, got ${JSON.stringify(e.split)}`);
    }
    if (!(data.evals || []).some((e) => e.split === 'heldout')) problems.push(`${name}: no heldout case`);
  }
  return problems;
}

// A should-not-trigger case carries skill_resolved (the run judged THIS repo's description) and
// skill_not_routed (it decided the request does not route here). Together they decide on by-path
// runs, where skill_not_invoked is undecided, so a skill without one has no measured false-positive
// surface.
function shouldNotTriggerGaps(filesByName) {
  const gaps = [];
  for (const [name, data] of Object.entries(filesByName)) {
    const has = (e, type) => (e.assertions || []).some((a) => a.type === type && a.skill === name);
    const found = (data.evals || []).some((e) => e.kind === 'triggering' && has(e, 'skill_not_routed') && has(e, 'skill_resolved'));
    if (!found) gaps.push(name);
  }
  return gaps;
}

function allCaseFiles() {
  const filesByName = {};
  for (const { name } of skillFiles()) {
    const data = casesFor(name);
    if (data) filesByName[name] = data;
  }
  return filesByName;
}

test('G11: every case has a side, and every skill has a held-out case', () => {
  const problems = splitProblems(allCaseFiles(), runner.SPLITS);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('G11 control: a missing or invalid side, and a skill without a held-out case, are reported', () => {
  const fixture = {
    a: { evals: [{ id: 1, split: 'train' }, { id: 2 }] },
    b: { evals: [{ id: 1, split: 'holdout' }, { id: 2, split: 'heldout' }] },
    c: { evals: [{ id: 1, split: 'train' }] },
  };
  assert.deepEqual(splitProblems(fixture, runner.SPLITS), [
    'a/2: split must be one of train, heldout, got undefined',
    'a: no heldout case',
    'b/1: split must be one of train, heldout, got "holdout"',
    'c: no heldout case',
  ]);
});

test('G11: every skill has a should-not-trigger case that decides on by-path runs', () => {
  const gaps = shouldNotTriggerGaps(allCaseFiles());
  assert.deepEqual(gaps, [],
    `skills with no triggering case carrying both skill_not_routed and skill_resolved for themselves: ${gaps.join(', ')}`);
});

test('G11 control: a skill missing either assertion, or carrying one for another skill, is reported', () => {
  const trig = (...assertions) => ({ evals: [{ id: 1, kind: 'triggering', assertions }] });
  const resolved = (skill) => ({ type: 'skill_resolved', skill });
  const notRouted = (skill) => ({ type: 'skill_not_routed', skill });
  const fixture = {
    ok: trig(resolved('ok'), notRouted('ok')),
    onlyResolved: trig(resolved('onlyResolved')),
    onlyNotRouted: trig(notRouted('onlyNotRouted')),
    otherSkill: trig(resolved('ok'), notRouted('ok')),
    behavioral: { evals: [{ id: 1, kind: 'behavioral', assertions: [resolved('behavioral'), notRouted('behavioral')] }] },
  };
  assert.deepEqual(shouldNotTriggerGaps(fixture), ['onlyResolved', 'onlyNotRouted', 'otherSkill', 'behavioral']);
});

// The ceiling is what lets `plan` refuse a run set whose known projected usage is over budget and
// `report` warn about one. A block that is missing or malformed would turn both checks off without
// anyone having chosen that, so the loader refuses it and this fails the suite first.
test('G11: the config declares a valid token ceiling', () => {
  assert.doesNotThrow(() => runner.loadCeiling(runner.loadConfig()));
});

test('G11 control: a missing or malformed ceiling is refused', () => {
  const cfg = runner.loadConfig();
  for (const costCeiling of [undefined, null, { unit: 'usd', maxTokensPerRun: 1 }, { unit: 'total_tokens' }, { unit: 'total_tokens', maxTokensPerRun: -5 }]) {
    assert.throws(() => runner.loadCeiling({ ...cfg, costCeiling }), /costCeiling is invalid/);
  }
});

// Feature 028 (IC-004). Coverage above asks whether every skill has cases of both kinds; it cannot
// see a case REMOVED, RENAMED or RE-SIDED without the baseline being re-captured, because coverage
// still passes while the committed baseline silently stops describing the committed corpus. This
// asserts the comparison the harness exports rather than reimplementing it here: a maintainer running
// `npm run bench parity` and this guard must evaluate the same code, or the two drift and the gate
// stops meaning anything.
//
// A case ADDED without a baseline result is pending, not a failure: no offline change can give it a
// result, so failing here would make every corpus addition break the suite until a paid capture ran.
// Pending cases are printed as diagnostics so they stay visible.
function parityDifferences(parity) {
  return [
    ...parity.missingFromCorpus.map((c) => `${c.key} in baseline, absent from corpus (${c.kind}: ${c.name})`),
    ...parity.changed.map((c) => `${c.key} differs: corpus ${c.corpus.kind}/${c.corpus.name}/${c.corpus.split} vs baseline ${c.baseline.kind}/${c.baseline.name}/${c.baseline.split}`),
    ...parity.duplicates.map((d) => `${d.key} appears ${d.entries} times in the baseline ${d.field}`),
    // `note` carries the reason when both counts are null — a baseline that is absent rather than
    // disagreeing. Rendering it the way cmdParity does keeps one shared comparison reported the same
    // way by both of its callers.
    ...(parity.countMismatch
      ? [`case counts disagree: baseline.caseCount=${parity.countMismatch.baselineCaseCount}, `
        + `baseline entries=${parity.countMismatch.baselineEntries}`
        + `${parity.countMismatch.note ? ` (${parity.countMismatch.note})` : ''}`]
      : []),
  ];
}

test('G11/028: the committed baseline still describes the committed corpus; new cases are pending', (t) => {
  const parity = runner.baselineParity(runner.loadConfig());
  for (const c of parity.pending) {
    t.diagnostic(`pending ${c.key} (${c.kind}, ${c.split}: ${c.name}) awaits a paid baseline capture`);
  }
  const differences = parityDifferences(parity);
  assert.deepEqual(differences, [],
    'the committed baseline no longer describes the committed corpus — re-capture it with '
    + '`node bench/runner.js baseline --from <iteration>`:\n  ' + differences.join('\n  '));
  assert.ok(parity.ok, 'baselineParity reported differences without listing any, which is a bug in the comparison itself');
});

test('G11/028 control: removed, renamed, kind-changed, re-sided and miscounted cases are reported, a pending case is not', () => {
  const entry = (key, name, kind, split) => ({ key, skill: key.split('/')[0], evalId: Number(key.split('/')[1]), name, kind, split });
  const baseline = {
    caseCount: 2,
    results: [
      { key: 'x/1', skill: 'x', evalId: 1, evalName: 'one', kind: 'triggering', split: 'train' },
      { key: 'x/2', skill: 'x', evalId: 2, evalName: 'two', kind: 'behavioral', split: 'train' },
    ],
  };
  const corpus = (...entries) => new Map(entries.map((e) => [e.key, e]));
  const one = entry('x/1', 'one', 'triggering', 'train');
  const two = entry('x/2', 'two', 'behavioral', 'train');

  const pendingOnly = runner.compareParity(corpus(one, two, entry('x/3', 'three', 'triggering', 'heldout')), baseline);
  assert.deepEqual(parityDifferences(pendingOnly), [], 'a pending case must not be reported as a difference');
  assert.equal(pendingOnly.pending.length, 1);

  assert.equal(parityDifferences(runner.compareParity(corpus(one), baseline)).length, 1, 'a removed case must fail');
  assert.equal(parityDifferences(runner.compareParity(corpus(one, { ...two, name: 'renamed' }), baseline)).length, 1, 'a renamed case must fail');
  assert.equal(parityDifferences(runner.compareParity(corpus(one, { ...two, kind: 'triggering' }), baseline)).length, 1, 'a kind change must fail');
  assert.equal(parityDifferences(runner.compareParity(corpus(one, { ...two, split: 'heldout' }), baseline)).length, 1, 'a split change must fail');
  assert.equal(parityDifferences(runner.compareParity(corpus(one, two), { ...baseline, caseCount: 3 })).length, 1, 'a wrong caseCount must fail');
  assert.equal(parityDifferences(runner.compareParity(corpus(one, two), { caseCount: 3, results: [...baseline.results, baseline.results[1]] })).length, 1, 'a duplicate baseline entry must fail');
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

// A without-skill run is only a measurement of what the skill adds if the skill really is withheld:
// the right run kind, a withheld resolution, an instruction that forbids reading and invoking it, a
// create step that deletes the sandbox copies, and a sandbox and output directory of its own so it
// cannot overwrite its with-skill pair. A bare plan must hold none, so the arm is always opted into.
function withoutSkillProblems(armPlan, barePlan) {
  const problems = [];
  const withSkill = (r) => armPlan.runs.find((x) => x.arm === 'with-skill' && x.skill === r.skill && x.evalId === r.evalId);
  for (const run of armPlan.runs.filter((r) => r.arm === 'without-skill')) {
    const where = `${run.skill}/${run.evalId}`;
    const pair = withSkill(run);
    if (run.kind !== 'behavioral') problems.push(`${where}: a without-skill run must be behavioral, got ${run.kind}`);
    if (!run.skills || run.skills.resolution !== 'withheld') problems.push(`${where}: resolution is not withheld`);
    const instruction = (run.skills && run.skills.instruction) || '';
    if (!/do not invoke/i.test(instruction)) problems.push(`${where}: the instruction does not forbid invoking the skill`);
    if (!/do not read/i.test(instruction)) problems.push(`${where}: the instruction does not forbid reading the skill`);
    const create = (run.sandbox && run.sandbox.create) || '';
    if (!/createSandbox\(/.test(create)) problems.push(`${where}: sandbox.create does not create a sandbox`);
    for (const p of (run.skills && run.skills.withheldPaths) || []) {
      const rel = path.relative(run.sandbox.workingDir, p).split(path.sep).join('/');
      if (!create.includes(rel)) problems.push(`${where}: sandbox.create does not delete ${rel}`);
    }
    if (!run.skills || (run.skills.withheldPaths || []).length !== 2) problems.push(`${where}: expected the two withheld paths`);
    if (!pair) problems.push(`${where}: no with-skill run to pair with`);
    else {
      if (run.sandbox.id === pair.sandbox.id) problems.push(`${where}: shares its sandbox id with the with-skill run`);
      if (run.outputDir === pair.outputDir) problems.push(`${where}: shares its outputDir with the with-skill run`);
    }
  }
  if (barePlan.runs.some((r) => r.arm === 'without-skill')) problems.push('a bare plan holds a without-skill run');
  return problems;
}

test('G11b: without-skill runs withhold the skill and stay apart from their with-skill pair', () => {
  const cfg = runner.loadConfig();
  const armPlan = runner.buildPlan(cfg, { iteration: 'guard', arm: 'without-skill' });
  assert.ok(armPlan.runs.some((r) => r.arm === 'without-skill'), 'the arm plan holds no without-skill run');
  const problems = withoutSkillProblems(armPlan, runner.buildPlan(cfg, { iteration: 'guard' }));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('G11b control: a without-skill run that does not withhold the skill is reported', () => {
  const cfg = runner.loadConfig();
  const bare = runner.buildPlan(cfg, { iteration: 'guard' });
  const armPlan = JSON.parse(JSON.stringify(runner.buildPlan(cfg, { iteration: 'guard', arm: 'without-skill' })));
  const broken = armPlan.runs.find((r) => r.arm === 'without-skill');
  const pair = armPlan.runs[armPlan.runs.indexOf(broken) - 1];
  broken.kind = 'triggering';
  broken.skills.resolution = 'sandbox-path';
  broken.skills.instruction = 'Handle the request.';
  broken.sandbox.create = 'echo no sandbox';
  broken.sandbox.id = pair.sandbox.id;
  broken.outputDir = pair.outputDir;
  const problems = withoutSkillProblems(armPlan, { runs: [broken] });
  for (const fragment of ['must be behavioral', 'not withheld', 'forbid invoking', 'forbid reading', 'does not create a sandbox', 'does not delete', 'shares its sandbox id', 'shares its outputDir', 'a bare plan holds']) {
    assert.ok(problems.some((p) => p.includes(fragment)), `the guard did not report: ${fragment}`);
  }
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
  // Discovery is scoped by a directory argument, not a shell glob: `node --test test/` recurses
  // exactly test/ on every platform (directory recursion has been in the runner since Node 18,
  // and no shell expansion is involved), while a bare `node --test` walks the whole repository
  // and would execute captured *.test.js artifacts under bench/runs/. The former wrapper
  // (scripts/run-tests.js) that did this walk by hand was removed with the rest of scripts/.
  assert.strictEqual(
    pkg.scripts.test, 'node --test test/',
    'npm test must scope discovery to test/ via the directory argument — an unscoped node --test '
    + 'also executes any *.test.js a bench case produced under bench/runs/',
  );
  assert.ok(pkg.scripts.bench, 'the bench harness needs its own npm script');
  assert.ok(
    !pkg.scripts.test.includes('bench'),
    'npm test must not invoke the bench harness — it makes paid model calls',
  );
});

test('G11/034: an outputs-scoped assertion is graded from outputs/, not gated on a transcript', () => {
  // Review finding. gradeAssertion decided `needsTranscript` from the assertion TYPE alone, while
  // scopeFor() routes `in: 'outputs'` to the artifacts and never reads the transcript. A run that
  // produced artifacts but no transcript.txt therefore failed every outputs-scoped assertion with
  // "no transcript.txt saved for this run" — 15 of them across four skills in the shipped corpus —
  // understating the pass rate and pointing a baseline delta at the wrong file.
  const dir = fs.mkdtempSync(path.join(scratch.dir, 'grade-'));
  fs.mkdirSync(path.join(dir, 'outputs'));
  fs.writeFileSync(path.join(dir, 'outputs', 'design.md'), 'a clean design with no forbidden token\n');
  const ctx = runner.loadRunContext(dir);
  ctx.cfg = runner.loadConfig();
  ctx.skill = 'do-design';
  assert.equal(ctx.hasTranscript, false, 'the fixture must have no transcript, which is the whole point');

  const scoped = runner.gradeAssertion(
    { text: 'no C4Context', type: 'output_not_matches', pattern: 'C4Context', in: 'outputs' }, ctx);
  assert.equal(scoped.passed, true,
    `an outputs-scoped assertion is decidable from the artifact alone; got: ${scoped.evidence}`);

  // The other half: a transcript-scoped assertion with no transcript must still fail, or this fix
  // would have removed the check instead of narrowing it.
  const unscoped = runner.gradeAssertion({ text: 'transcript says X', type: 'output_matches', pattern: 'X' }, ctx);
  assert.equal(unscoped.passed, false, 'a transcript-scoped assertion with no transcript must still fail');
  assert.match(unscoped.evidence, /no transcript\.txt/);
});

test('G11/034: no shipped document claims the bench corpus is ignored by Git', () => {
  // The corpus went local-only twice, and after re-tracking it three documents still said it was
  // ignored — CLAUDE.md, bench/README.md and docs/architecture.md's repository map. Two survived the
  // feature whose whole purpose was correcting that claim, because they sat in sections nobody was
  // editing at the time.
  const docs = [
    path.join(REPO, 'bench', 'README.md'),
    path.join(REPO, 'docs', 'architecture.md'),
  ].filter((f) => fs.existsSync(f));
  const offenders = [];
  for (const doc of docs) {
    // Inside bench/README.md every line is about bench by context — the original offending sentence
    // said "This directory is local-only", naming bench nowhere. Requiring the word here is what let a
    // first version of this guard pass on the very text it exists to catch.
    const subjectIsBench = doc.includes(`${path.sep}bench${path.sep}`);
    for (const [i, line] of fs.readFileSync(doc, 'utf8').split('\n').entries()) {
      if (!subjectIsBench && !/bench/i.test(line)) continue;
      // A claim that bench is ignored, as opposed to the true statement that runs/ and reports/ are.
      if (/ignored by git|local-only/i.test(line) && !/runs\/|reports\//.test(line)) {
        offenders.push(`${path.relative(REPO, doc)}:${i + 1} — ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'the corpus is tracked; only bench/runs/ and bench/reports/ are ignored:\n  ' + offenders.join('\n  '));
});

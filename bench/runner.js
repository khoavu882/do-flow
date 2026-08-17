#!/usr/bin/env node
'use strict';

/**
 * DoFlow evaluation harness runner (plan.md task A.1, requirement FR-016/FR-017/FR-018).
 *
 * Scope boundary: this runner owns case management, programmatic assertion grading, baseline
 * storage, and per-task delta reporting. It does NOT spawn model runs — those are subagent
 * dispatches driven by the orchestrating skill, the same division `skill-creator` uses. Keeping
 * the split here means the harness stays runnable offline (list/coverage/grade/report all work
 * with no API access) and only the dispatch step costs money.
 *
 * Output format deliberately matches skill-creator's: grading.json uses `text`/`passed`/`evidence`
 * because its aggregate_benchmark.py and eval-viewer/generate_review.py depend on those exact
 * field names. Reusing that machinery rather than reimplementing it is NFR-008 applied to our own
 * tooling.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Skills DoFlow ships, from the source of truth rather than a hand-maintained list — a hardcoded
 * inventory here would be exactly the drift the guard suite exists to prevent. */
function discoverSkills(cfg) {
  const root = path.join(REPO_ROOT, cfg.skillsRoot);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** Cases for one skill, or null when the skill has no bench directory yet. */
function loadCases(cfg, skill) {
  const file = path.join(REPO_ROOT, cfg.benchRoot, skill, 'evals.json');
  if (!fs.existsSync(file)) return null;
  const data = readJson(file);
  if (data.skill_name !== skill) {
    throw new Error(`${file}: skill_name "${data.skill_name}" does not match directory "${skill}"`);
  }
  return data;
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function workingTreeClean() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return out.trim() === '';
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Assertion evaluation
// ---------------------------------------------------------------------------

/**
 * Assertion kinds this runner can decide without a model. Anything else is left to the grader
 * subagent — forcing a programmatic check onto a judgment call produces a confidently wrong
 * number, which is worse than an honest "manual".
 */
const PROGRAMMATIC = {
  file_exists: (a, ctx) => {
    const target = path.resolve(ctx.runDir, a.path);
    return { passed: fs.existsSync(target), evidence: `checked ${path.relative(ctx.runDir, target)}` };
  },
  file_absent: (a, ctx) => {
    const target = path.resolve(ctx.runDir, a.path);
    return { passed: !fs.existsSync(target), evidence: `checked ${path.relative(ctx.runDir, target)}` };
  },
  output_matches: (a, ctx) => {
    const re = new RegExp(a.pattern, a.flags || 'm');
    const hit = re.test(ctx.transcript);
    return { passed: hit, evidence: hit ? `matched /${a.pattern}/` : `no match for /${a.pattern}/` };
  },
  output_not_matches: (a, ctx) => {
    const re = new RegExp(a.pattern, a.flags || 'm');
    const hit = re.test(ctx.transcript);
    return { passed: !hit, evidence: hit ? `unexpectedly matched /${a.pattern}/` : `absent as required` };
  },
  skill_invoked: (a, ctx) => {
    const hit = ctx.invokedSkills.includes(a.skill);
    return { passed: hit, evidence: `invoked: [${ctx.invokedSkills.join(', ') || 'none'}]` };
  },
  skill_not_invoked: (a, ctx) => {
    const hit = ctx.invokedSkills.includes(a.skill);
    return { passed: !hit, evidence: `invoked: [${ctx.invokedSkills.join(', ') || 'none'}]` };
  },
};

/**
 * A run directory holds whatever the dispatched subagent saved. `transcript.txt` and
 * `invoked_skills.json` are optional: a missing input makes dependent assertions fail with a
 * stated reason rather than silently passing, because a check nobody could run is not a pass.
 */
function loadRunContext(runDir) {
  const transcriptFile = path.join(runDir, 'transcript.txt');
  const invokedFile = path.join(runDir, 'invoked_skills.json');
  return {
    runDir,
    transcript: fs.existsSync(transcriptFile) ? fs.readFileSync(transcriptFile, 'utf8') : '',
    invokedSkills: fs.existsSync(invokedFile) ? readJson(invokedFile) : [],
    hasTranscript: fs.existsSync(transcriptFile),
  };
}

function gradeAssertion(assertion, ctx) {
  const kind = assertion.type || 'manual';
  if (kind === 'manual') {
    return { text: assertion.text, passed: null, evidence: 'manual — left for the grader subagent' };
  }
  const fn = PROGRAMMATIC[kind];
  if (!fn) {
    return { text: assertion.text, passed: null, evidence: `unknown assertion type "${kind}"` };
  }
  const needsTranscript = kind === 'output_matches' || kind === 'output_not_matches';
  if (needsTranscript && !ctx.hasTranscript) {
    return { text: assertion.text, passed: false, evidence: 'no transcript.txt saved for this run' };
  }
  const { passed, evidence } = fn(assertion, ctx);
  return { text: assertion.text, passed, evidence };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCoverage(cfg, opts) {
  const skills = discoverSkills(cfg);
  const rows = skills.map((skill) => {
    const cases = loadCases(cfg, skill);
    const evals = cases ? cases.evals : [];
    return {
      skill,
      hasCases: cases !== null,
      total: evals.length,
      triggering: evals.filter((e) => e.kind === 'triggering').length,
      behavioral: evals.filter((e) => e.kind === 'behavioral').length,
    };
  });
  const missing = rows.filter((r) => !r.hasCases || r.triggering === 0 || r.behavioral === 0);
  if (opts.json) {
    console.log(JSON.stringify({ skills: rows, missing: missing.map((m) => m.skill) }, null, 2));
  } else {
    for (const r of rows) {
      const mark = r.hasCases && r.triggering && r.behavioral ? 'ok  ' : 'GAP ';
      console.log(`${mark}${r.skill.padEnd(20)} ${String(r.total).padStart(2)} cases  (${r.triggering} triggering, ${r.behavioral} behavioral)`);
    }
    console.log(`\n${rows.length} skills, ${missing.length} with incomplete coverage`);
  }
  return missing.length === 0 ? 0 : 1;
}

function cmdList(cfg, opts) {
  const skills = opts.skill ? [opts.skill] : discoverSkills(cfg);
  const out = [];
  for (const skill of skills) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals) {
      out.push({ skill, id: e.id, kind: e.kind, name: e.name, prompt: e.prompt });
    }
  }
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else out.forEach((c) => console.log(`${c.skill}/${c.id} [${c.kind}] ${c.name}`));
  return 0;
}

/**
 * Emit the dispatch plan the orchestrator turns into subagent runs. Each entry carries everything
 * a run needs and where to save its outputs, so the orchestrator does no path arithmetic of its
 * own — the same reason skills call one resolver instead of computing paths inline.
 */
function cmdPlan(cfg, opts) {
  if (!opts.iteration) {
    console.error('bench plan: --iteration <name> is required (e.g. --iteration baseline)');
    return 2;
  }
  const skills = opts.skill ? [opts.skill] : discoverSkills(cfg);
  const runs = [];
  for (const skill of skills) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals) {
      // Every run is sandboxed. 21 of the shipped cases invoke skills that write files, create
      // branches, or commit; without isolation a baseline capture would mutate the very tree
      // being measured. The id is the worktree name, so it must satisfy WorktreeManager's charset.
      const sandboxId = `bench-${opts.iteration}-${skill}-${e.id}`.replace(/[^A-Za-z0-9._-]/g, '-');
      runs.push({
        skill,
        evalId: e.id,
        evalName: e.name,
        kind: e.kind,
        prompt: e.prompt,
        expectedOutput: e.expected_output,
        model: cfg.model,
        sandbox: {
          required: true,
          id: sandboxId,
          create: `node -e "new (require('./src/runtime/worktree.js').WorktreeManager)(process.cwd()).create('${sandboxId}')"`,
          remove: `node -e "new (require('./src/runtime/worktree.js').WorktreeManager)(process.cwd()).remove('${sandboxId}')"`,
          workingDir: path.join('.doflow', 'worktrees', sandboxId),
        },
        outputDir: path.join(cfg.benchRoot, 'runs', opts.iteration, skill, `eval-${e.id}-${e.name}`),
        saveOutputs: ['transcript.txt', 'invoked_skills.json', 'outputs/'],
      });
    }
  }
  const plan = {
    iteration: opts.iteration,
    model: cfg.model,
    commit: currentCommit(),
    workingTreeClean: workingTreeClean(),
    runCount: runs.length,
    runs,
  };
  console.log(JSON.stringify(plan, null, 2));
  return 0;
}

function cmdGrade(cfg, opts) {
  if (!opts.iteration) {
    console.error('bench grade: --iteration <name> is required');
    return 2;
  }
  const iterRoot = path.join(REPO_ROOT, cfg.benchRoot, 'runs', opts.iteration);
  if (!fs.existsSync(iterRoot)) {
    console.error(`bench grade: no runs found at ${path.relative(REPO_ROOT, iterRoot)}`);
    return 2;
  }
  let graded = 0;
  let manual = 0;
  const skills = opts.skill ? [opts.skill] : discoverSkills(cfg);
  for (const skill of skills) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals) {
      const runDir = path.join(iterRoot, skill, `eval-${e.id}-${e.name}`);
      if (!fs.existsSync(runDir)) continue;
      const ctx = loadRunContext(runDir);
      const expectations = (e.assertions || []).map((a) => gradeAssertion(a, ctx));
      manual += expectations.filter((x) => x.passed === null).length;
      const decided = expectations.filter((x) => x.passed !== null);
      writeJson(path.join(runDir, 'grading.json'), {
        skill,
        eval_id: e.id,
        eval_name: e.name,
        expectations,
        pass_rate: decided.length ? decided.filter((x) => x.passed).length / decided.length : null,
      });
      graded += 1;
    }
  }
  console.log(`graded ${graded} run(s); ${manual} assertion(s) left for the grader subagent`);
  return 0;
}

/** Freeze an iteration as the committed baseline (FR-018). Records the commit it was taken at so
 * the "baseline predates the rewrite" property is checkable after the fact rather than trusted. */
function cmdBaseline(cfg, opts) {
  const from = opts.from || 'baseline';
  const iterRoot = path.join(REPO_ROOT, cfg.benchRoot, 'runs', from);
  if (!fs.existsSync(iterRoot)) {
    console.error(`bench baseline: no runs found at ${path.relative(REPO_ROOT, iterRoot)}`);
    return 2;
  }
  const results = collectResults(cfg, iterRoot);
  const clean = workingTreeClean();
  const baseline = {
    capturedFrom: from,
    model: cfg.model,
    commit: currentCommit(),
    workingTreeClean: clean,
    caseCount: results.length,
    results,
  };
  writeJson(path.join(REPO_ROOT, cfg.baselineDir, 'baseline.json'), baseline);
  if (clean === false) {
    console.warn('warning: working tree was dirty at capture; the recorded commit does not fully describe what ran');
  }
  console.log(`baseline written: ${results.length} case(s) at commit ${baseline.commit || 'unknown'}`);
  return 0;
}

function collectResults(cfg, iterRoot) {
  const results = [];
  for (const skill of discoverSkills(cfg)) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals) {
      const gradingFile = path.join(iterRoot, skill, `eval-${e.id}-${e.name}`, 'grading.json');
      if (!fs.existsSync(gradingFile)) continue;
      const g = readJson(gradingFile);
      results.push({
        key: `${skill}/${e.id}`,
        skill,
        evalId: e.id,
        evalName: e.name,
        kind: e.kind,
        passRate: g.pass_rate,
        expectations: g.expectations.map((x) => ({ text: x.text, passed: x.passed })),
      });
    }
  }
  return results;
}

/**
 * Per-task delta against the baseline. Reports each case individually rather than only an
 * aggregate mean — an aggregate hides the case where two skills move in opposite directions, and
 * the prompting guide's experiment protocol calls that out specifically.
 */
function cmdReport(cfg, opts) {
  const baselineFile = path.join(REPO_ROOT, cfg.baselineDir, 'baseline.json');
  if (!fs.existsSync(baselineFile)) {
    console.error('bench report: no baseline captured yet — run `bench baseline` first');
    return 2;
  }
  const against = opts.iteration;
  if (!against) {
    console.error('bench report: --iteration <name> is required (the run to compare against the baseline)');
    return 2;
  }
  const baseline = readJson(baselineFile);
  const currentRoot = path.join(REPO_ROOT, cfg.benchRoot, 'runs', against);
  if (!fs.existsSync(currentRoot)) {
    console.error(`bench report: no runs found at ${path.relative(REPO_ROOT, currentRoot)}`);
    return 2;
  }
  const current = collectResults(cfg, currentRoot);
  const byKey = new Map(baseline.results.map((r) => [r.key, r]));
  const rows = [];
  for (const c of current) {
    const b = byKey.get(c.key);
    rows.push({
      key: c.key,
      kind: c.kind,
      baseline: b ? b.passRate : null,
      current: c.passRate,
      delta: b && b.passRate !== null && c.passRate !== null ? c.passRate - b.passRate : null,
      status: !b ? 'new' : b.passRate === c.passRate ? 'unchanged' : c.passRate > b.passRate ? 'improved' : 'regressed',
    });
  }
  const dropped = baseline.results.filter((b) => !current.some((c) => c.key === b.key));
  const report = {
    baselineCommit: baseline.commit,
    baselineModel: baseline.model,
    currentIteration: against,
    currentCommit: currentCommit(),
    currentModel: cfg.model,
    modelComparable: baseline.model === cfg.model,
    rows,
    droppedCases: dropped.map((d) => d.key),
    summary: {
      improved: rows.filter((r) => r.status === 'improved').length,
      regressed: rows.filter((r) => r.status === 'regressed').length,
      unchanged: rows.filter((r) => r.status === 'unchanged').length,
      new: rows.filter((r) => r.status === 'new').length,
      dropped: dropped.length,
    },
  };
  const outFile = path.join(REPO_ROOT, cfg.reportsDir, `${against}-vs-baseline.json`);
  writeJson(outFile, report);

  if (!report.modelComparable) {
    console.warn(`warning: baseline ran on ${baseline.model}, this run on ${cfg.model} — the delta is not a clean comparison`);
  }
  console.log(`| case | kind | baseline | current | delta | status |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const r of rows) {
    const fmt = (v) => (v === null ? '—' : v.toFixed(2));
    const d = r.delta === null ? '—' : (r.delta > 0 ? '+' : '') + r.delta.toFixed(2);
    console.log(`| ${r.key} | ${r.kind} | ${fmt(r.baseline)} | ${fmt(r.current)} | ${d} | ${r.status} |`);
  }
  const s = report.summary;
  console.log(`\n${s.improved} improved, ${s.regressed} regressed, ${s.unchanged} unchanged, ${s.new} new, ${s.dropped} dropped`);
  console.log(`report: ${path.relative(REPO_ROOT, outFile)}`);
  // Drift is reported, never blocking (requirement A1) — a regression is information, not a gate.
  return 0;
}

// ---------------------------------------------------------------------------

const USAGE = `doflow bench — evaluation harness for the shipped skills

  node bench/runner.js coverage [--json]              which skills have triggering + behavioral cases
  node bench/runner.js list [--skill S] [--json]      enumerate cases
  node bench/runner.js plan --iteration N [--skill S] emit the subagent dispatch plan (JSON)
  node bench/runner.js grade --iteration N [--skill S] grade programmatic assertions of a finished run
  node bench/runner.js baseline [--from N]            freeze an iteration as the committed baseline
  node bench/runner.js report --iteration N           per-case delta of a run against the baseline

Model is pinned in bench/config.json so runs stay comparable. This command is deliberately not
part of \`npm test\`: the dispatch step makes paid model calls.`;

function parseArgs(argv) {
  const opts = { json: false };
  let cmd = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--') && cmd === null) cmd = a;
    else if (a === '--json') opts.json = true;
    else if (a === '--skill') opts.skill = argv[++i];
    else if (a === '--iteration') opts.iteration = argv[++i];
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return { cmd, opts };
}

function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (opts.help || !cmd) {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  const cfg = loadConfig();
  switch (cmd) {
    case 'coverage': return cmdCoverage(cfg, opts);
    case 'list': return cmdList(cfg, opts);
    case 'plan': return cmdPlan(cfg, opts);
    case 'grade': return cmdGrade(cfg, opts);
    case 'baseline': return cmdBaseline(cfg, opts);
    case 'report': return cmdReport(cfg, opts);
    default:
      console.error(`unknown command "${cmd}"\n`);
      console.log(USAGE);
      return 2;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { discoverSkills, loadCases, loadConfig, gradeAssertion, collectResults };

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
 * Skill provenance (task A.5) is part of grading, not a side note: a run that cannot name the
 * SKILL.md it followed cannot support a claim about this repo, because the Skill tool resolves
 * `~/.claude/skills/` ahead of anything project-local. `plan` states the by-path contract, sandbox
 * creation projects this repo's skills, and `grade` classifies every run's recorded source.
 *
 * Output format deliberately matches skill-creator's: grading.json uses `text`/`passed`/`evidence`
 * because its aggregate_benchmark.py and eval-viewer/generate_review.py depend on those exact
 * field names. Reusing that machinery rather than reimplementing it is NFR-008 applied to our own
 * tooling.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const {
  SKILL_SOURCE_FILE,
  SANDBOX_SKILLS_DIR,
  sha256File,
} = require('../src/runtime/worktree.js');

const REPO_ROOT = path.resolve(__dirname, '..');

/** What a dispatched run must write to prove which SKILL.md it actually followed. */
const RUN_SOURCE_FILE = 'skill_source.json';

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
/**
 * Which text a regex assertion reads. Default is the transcript, but that is the WRONG scope for a
 * negative assertion and the baseline sweep proved it: `do-design/2` scored 0/3 while behaving
 * perfectly, because its transcript said "none use the `C4Context`/`C4Container` diagram types" and
 * `output_not_matches C4Context` fired on the very sentence demonstrating compliance. Same for
 * `do-implement/3`: "grepped for `not implemented` — none found".
 *
 * A transcript legitimately discusses what it avoided; a produced artifact either contains the
 * forbidden string or it does not. So `"in": "outputs"` concatenates every file the run produced
 * and matches against that instead. Prefer it for anything phrased as an absence.
 */
function scopeFor(assertion, ctx) {
  if (assertion.in !== 'outputs') return { text: ctx.transcript, where: 'transcript' };
  if (!ctx.outputsText) return { text: '', where: 'outputs/ (empty — no artifacts produced)' };

  // `file` narrows an absence check to the one artifact under test.
  //
  // Concatenating all of outputs/ was right when a run produced a single artifact and wrong as soon
  // as it produced evidence beside it. do-design/2 asserts the design does not use C4Context; the
  // run wrote a correct design.md with zero occurrences AND an evidence ledger recording the claim
  // "does not use the C4Context or C4Container diagram type" — so the record of compliance failed
  // the compliance check. The better the provenance discipline gets, the more often that fires,
  // because evidence about not doing X necessarily contains X.
  if (assertion.file) {
    const match = ctx.outputFiles.find((f) => f.endsWith(assertion.file));
    if (!match) return { text: '', where: `outputs/${assertion.file} (not produced)` };
    return { text: safeRead(match), where: `outputs/${assertion.file}` };
  }
  return { text: ctx.outputsText, where: `outputs/ (${ctx.outputFiles.length} file(s))` };
}

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
    const { text, where } = scopeFor(a, ctx);
    const re = new RegExp(a.pattern, a.flags || 'm');
    const hit = re.test(text);
    return { passed: hit, evidence: hit ? `matched /${a.pattern}/ in ${where}` : `no match for /${a.pattern}/ in ${where}` };
  },
  output_not_matches: (a, ctx) => {
    const { text, where } = scopeFor(a, ctx);
    const re = new RegExp(a.pattern, a.flags || 'm');
    const hit = re.test(text);
    return { passed: !hit, evidence: hit ? `unexpectedly matched /${a.pattern}/ in ${where}` : `absent from ${where} as required` };
  },
  // The by-path equivalent of "the skill was invoked".
  //
  // A.5 established that a case must read the skill file directly, because invoking it by name
  // resolves ~/.claude/skills/, which differs from this tree in 12 of 13 skills. So
  // `invoked_skills.json` is empty by contract, and asking whether a skill was *invoked* asks a
  // question the harness forbids answering yes to. What a by-path run can prove — and proves with
  // a hash rather than a self-report — is that it read this repo's copy of the named skill.
  skill_resolved: (a, ctx) => {
    if (!ctx.cfg) return { passed: null, evidence: 'grading context carries no config — cannot verify provenance' };
    const v = verifySkillSource(ctx.cfg, a.skill, ctx);
    return { passed: v.status === 'verified', evidence: `${a.skill}: ${v.status} — ${v.evidence}` };
  },
  // Kept, but they refuse to answer for a by-path run instead of inventing a verdict.
  //
  // Both were silently broken by A.5's contract, in opposite and equally bad directions:
  // `skill_invoked` failed 13 of 13 times with identical evidence while the skills behaved
  // correctly, and `skill_not_invoked` passed vacuously every time because an empty array trivially
  // excludes everything. A negative assertion that cannot fail is worse than a missing one — it
  // reads as coverage. `passed: null` routes both to the grader instead.
  skill_invoked: (a, ctx) => {
    if (ctx.invokedSkills.length === 0 && ctx.skillSource) {
      return { passed: null, evidence: `by-path run (skill_source.json present, invoked_skills empty) — use skill_resolved for '${a.skill}'` };
    }
    const hit = ctx.invokedSkills.includes(a.skill);
    return { passed: hit, evidence: `invoked: [${ctx.invokedSkills.join(', ') || 'none'}]` };
  },
  skill_not_invoked: (a, ctx) => {
    if (ctx.invokedSkills.length === 0 && ctx.skillSource) {
      return { passed: null, evidence: `by-path run — an empty invoked_skills list excludes everything, so this would pass without checking anything` };
    }
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
  const sourceFile = path.join(runDir, RUN_SOURCE_FILE);
  const outputsDir = path.join(runDir, 'outputs');
  const outputFiles = fs.existsSync(outputsDir) ? walkFiles(outputsDir) : [];
  let skillSource = null;
  if (fs.existsSync(sourceFile)) {
    try {
      skillSource = readJson(sourceFile);
    } catch {
      skillSource = { malformed: true };
    }
  }
  return {
    runDir,
    transcript: fs.existsSync(transcriptFile) ? fs.readFileSync(transcriptFile, 'utf8') : '',
    invokedSkills: fs.existsSync(invokedFile) ? readJson(invokedFile) : [],
    hasTranscript: fs.existsSync(transcriptFile),
    skillSource,
    outputFiles,
    // Concatenated so one regex sweeps every artifact — an assertion about what a run produced
    // rarely cares which file it landed in, and naming the file would couple the case to a layout
    // the skill under test is free to change.
    outputsText: outputFiles.map((f) => safeRead(f)).join('\n'),
  };
}

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Binary or unreadable artifacts contribute nothing rather than throwing — a run that produced a
 * PNG should not crash grading of the markdown beside it. */
function safeRead(file) {
  try {
    const buf = fs.readFileSync(file);
    return buf.includes(0) ? '' : buf.toString('utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Skill provenance (plan task A.5)
// ---------------------------------------------------------------------------

/**
 * The hash a run must have read. `core/shared/skills/<skill>/SKILL.md` is the tree Phase D
 * rewrites, so it is the only source whose measurement means anything.
 */
/**
 * The hash a run's recorded skill SHOULD have matched.
 *
 * `atCommit` is what makes a frozen iteration re-gradeable. Without it this compared against the
 * working tree, so the moment the skills changed — which is the entire point of the Phase D
 * rewrite — every case in the committed baseline flipped to `mismatch`. That verdict was wrong in
 * a way worth naming: it conflates "this run measured the wrong thing" with "this run measured the
 * previous thing, deliberately, which is what a baseline IS". A baseline that cannot survive the
 * change it exists to measure is not a baseline.
 *
 * Falls back to the working tree when no commit is recorded, which is correct for a fresh
 * iteration graded against the tree that produced it.
 */
function skillSourceSha256(cfg, skill, atCommit = null) {
  const rel = path.posix.join(cfg.skillsRoot, skill, 'SKILL.md');
  if (atCommit) {
    const show = spawnSync('git', ['show', `${atCommit}:${rel}`], { cwd: REPO_ROOT, encoding: 'buffer' });
    if (show.status !== 0) return null;
    return crypto.createHash('sha256').update(show.stdout).digest('hex');
  }
  const file = path.join(REPO_ROOT, rel);
  return fs.existsSync(file) ? sha256File(file) : null;
}

/** A path is sandbox-resolved when it lives under a bench worktree. Anything else — most obviously
 * `~/.claude/skills/` — is a copy this repo does not control. */
function isSandboxPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  // Tolerant of a repo-relative record even though the contract asks for an absolute one: a run
  // that read the right file should not be reported as a global fallback over a leading slash.
  return /(^|\/)\.doflow\/worktrees\//.test(norm) && norm.includes(`/${SANDBOX_SKILLS_DIR.replace(/\\/g, '/')}/`);
}

/**
 * Decide, from what the run itself recorded, which SKILL.md it followed.
 *
 * This exists because the harness previously could not answer that question at all. Claude Code
 * resolves a bare skill name from `~/.claude/skills/` before any project-scope copy and takes the
 * first match, so an unverified run is not "probably fine" — it is the *expected* failure mode. A
 * missing record is therefore reported as `unrecorded`, never as a pass: silence is what the defect
 * looked like.
 *
 * Statuses: `verified` (sandbox path, hash matches source) · `global-fallback` (resolved outside
 * the sandbox — this is the regression A.5 exists to catch) · `mismatch` (sandbox path, stale or
 * edited content) · `unrecorded` (the run saved no `skill_source.json`).
 */
function verifySkillSource(cfg, skill, ctx) {
  const expected = skillSourceSha256(cfg, skill, ctx.sourceAt || null);
  const rec = ctx.skillSource;
  if (!rec || rec.malformed) {
    return {
      status: 'unrecorded',
      expectedSha256: expected,
      recordedSha256: null,
      recordedPath: null,
      evidence: rec
        ? `${RUN_SOURCE_FILE} is not valid JSON — cannot tell which skill this run measured`
        : `no ${RUN_SOURCE_FILE} saved — cannot tell whether this run read the repo's skill or ~/.claude/skills/`,
    };
  }
  const recordedPath = rec.path || null;
  const recordedSha256 = rec.sha256 || null;
  const sandboxed = recordedPath !== null && isSandboxPath(recordedPath);
  const hashOk = expected !== null && recordedSha256 === expected;

  if (sandboxed && hashOk) {
    return { status: 'verified', expectedSha256: expected, recordedSha256, recordedPath, evidence: `read ${recordedPath} (matches ${cfg.skillsRoot}/${skill}/SKILL.md)` };
  }
  if (!sandboxed) {
    // Two shapes, one status. Content that happens to match source is still not a sandboxed read:
    // one of the thirteen installed skills is currently byte-identical to source, so hash alone
    // would let exactly that skill pass while resolving globally.
    return {
      status: 'global-fallback',
      expectedSha256: expected,
      recordedSha256,
      recordedPath,
      evidence: hashOk
        ? `${recordedPath} matches source but is outside the run's sandbox — the run did not use its own isolated copy`
        : `${recordedPath || 'no path recorded'} is outside the run's sandbox — this run measured a copy this repo does not control`,
    };
  }
  return {
    status: 'mismatch',
    expectedSha256: expected,
    recordedSha256,
    recordedPath,
    evidence: `${recordedPath} is in the sandbox but hashes ${recordedSha256} against source ${expected} — the sandbox is stale or the file was edited mid-run`,
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

const WT_REQUIRE = "const{WorktreeManager}=require('./src/runtime/worktree.js');const m=new WorktreeManager(process.cwd());";

/**
 * The rule every dispatched run has to follow, stated once at the top of the plan rather than
 * duplicated across 33 entries.
 *
 * It says "read the file" rather than "invoke the skill" because invoking by name cannot be made to
 * resolve this repo's copy. Claude Code merges skills in the order policy → user → project and the
 * lookup takes the first match, so `~/.claude/skills/<name>/` always wins a name collision;
 * verified against 2.1.226 and observed live. Nested project skills are worse than useless here:
 * discovery skips gitignored directories, and `.doflow/` is gitignored, so the sandbox's own
 * `.claude/skills/` is never even scanned. Path-based loading is not a workaround around a bug we
 * could fix — it is the only resolution the harness controls.
 */
const SKILL_RESOLUTION = {
  rule: 'sandbox-path',
  summary:
    "Every run must read its skill from its own sandbox, by path, and record which file it read. " +
    'Invoking the bare skill name resolves the globally installed copy instead.',
  why:
    'Claude Code resolves skills user-scope-first and takes the first name match, so ' +
    '~/.claude/skills/<name>/SKILL.md shadows any project copy. 12 of the 13 installed skills ' +
    "currently differ from this repo's source, so a name-resolved run measures the wrong tree.",
  dispatchedAgentMustNot: 'invoke /<skill> by name, or rely on the Skill tool, to load the skill under test',
  dispatchedAgentMust: [
    'read <sandbox>/.claude/skills/<skill>/SKILL.md and follow it as the skill body',
    `write ${RUN_SOURCE_FILE} into the run's outputDir recording the absolute path read and its sha256`,
  ],
  runRecordSchema: {
    file: RUN_SOURCE_FILE,
    fields: { skill: 'string', path: 'absolute path to the SKILL.md actually read', sha256: 'sha256 of that file' },
    example: { skill: 'do-code-review', path: '/abs/.doflow/worktrees/<id>/.claude/skills/do-code-review/SKILL.md', sha256: '<64 hex>' },
  },
  gradedAs: 'bench grade classifies each run verified | global-fallback | mismatch | unrecorded; anything but verified is flagged, and an absent record is never treated as a pass',
};

function buildPlan(cfg, opts) {
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
      const workingDir = path.join('.doflow', 'worktrees', sandboxId);
      const skillFile = path.join(workingDir, SANDBOX_SKILLS_DIR, skill, 'SKILL.md');
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
          // createSandbox = worktree + a real `doflow install` of this repo's skills into it, so
          // the sandbox carries the tree under test rather than whatever is globally installed.
          create: `node -e "${WT_REQUIRE}const r=m.createSandbox('${sandboxId}');console.log(r.path+' skills='+r.manifest.skillCount)"`,
          remove: `node -e "${WT_REQUIRE}m.remove('${sandboxId}')"`,
          workingDir,
        },
        // Restated per run because a dispatched subagent receives one entry, not the whole plan.
        skills: {
          resolution: SKILL_RESOLUTION.rule,
          dir: path.join(workingDir, SANDBOX_SKILLS_DIR),
          skillFile,
          sourceSha256: skillSourceSha256(cfg, skill),
          sandboxManifest: path.join(workingDir, SKILL_SOURCE_FILE),
          instruction: e.kind === 'triggering'
            // A triggering case asks whether the request should route here at all, which is a
            // judgment about the skill's own description. Reading it from the sandbox measures this
            // repo's wording; letting the Skill tool route would measure the installed description
            // instead — the same substitution, one level up.
            ? `Read the frontmatter of ${skillFile} and decide from THAT description whether this request routes to ${skill}. Record the decision. Do NOT invoke /${skill} by name — that would judge ~/.claude/skills/${skill}/'s description, not this repo's.`
            : `Read ${skillFile} and follow it. Do NOT invoke /${skill} by name — that resolves ~/.claude/skills/${skill}/, not this repo.`,
          mustRecord: RUN_SOURCE_FILE,
        },
        outputDir: path.join(cfg.benchRoot, 'runs', opts.iteration, skill, `eval-${e.id}-${e.name}`),
        saveOutputs: ['transcript.txt', 'invoked_skills.json', RUN_SOURCE_FILE, 'outputs/'],
      });
    }
  }
  return {
    iteration: opts.iteration,
    model: cfg.model,
    commit: currentCommit(),
    workingTreeClean: workingTreeClean(),
    skillResolution: SKILL_RESOLUTION,
    skillSourceRoot: cfg.skillsRoot,
    runCount: runs.length,
    runs,
  };
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
  console.log(JSON.stringify(buildPlan(cfg, opts), null, 2));
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
  // Which commit's skills this iteration measured. Recorded on first grade and reused after, so a
  // re-grade months later reproduces the same verdicts instead of silently re-basing on HEAD. An
  // explicit --source-at overrides and re-records, which is how an iteration captured before this
  // field existed gets its provenance back.
  const stampFile = path.join(iterRoot, 'iteration.json');
  let stamp = fs.existsSync(stampFile) ? readJson(stampFile) : null;
  if (opts['source-at']) {
    stamp = { ...(stamp || {}), sourceAt: opts['source-at'] };
    fs.writeFileSync(stampFile, `${JSON.stringify(stamp, null, 2)}\n`);
  }
  const sourceAt = stamp && stamp.sourceAt ? stamp.sourceAt : null;
  if (sourceAt) {
    console.log(`grading against skills as of ${sourceAt} (recorded in ${path.relative(REPO_ROOT, stampFile)})`);
  }

  let graded = 0;
  let manual = 0;
  const unverified = [];
  const skills = opts.skill ? [opts.skill] : discoverSkills(cfg);
  for (const skill of skills) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals) {
      const runDir = path.join(iterRoot, skill, `eval-${e.id}-${e.name}`);
      if (!fs.existsSync(runDir)) continue;
      const ctx = loadRunContext(runDir);
      // skill_resolved needs both to reach verifySkillSource; attached here rather than threaded
      // through loadRunContext, which is also used by callers that have no case in hand.
      ctx.cfg = cfg;
      ctx.skill = skill;
      ctx.sourceAt = sourceAt;
      const expectations = (e.assertions || []).map((a) => gradeAssertion(a, ctx));
      manual += expectations.filter((x) => x.passed === null).length;
      const decided = expectations.filter((x) => x.passed !== null);
      // Provenance is recorded beside the expectations rather than inside them: a run that measured
      // the wrong skill has an invalid pass rate, not a lower one, and folding it into the rate
      // would silently reprice every case in the committed baseline.
      const skillSource = verifySkillSource(cfg, skill, ctx);
      if (skillSource.status !== 'verified') unverified.push(`${skill}/${e.id}: ${skillSource.status} — ${skillSource.evidence}`);
      writeJson(path.join(runDir, 'grading.json'), {
        skill,
        eval_id: e.id,
        eval_name: e.name,
        skill_source: skillSource,
        expectations,
        pass_rate: decided.length ? decided.filter((x) => x.passed).length / decided.length : null,
      });
      graded += 1;
    }
  }
  console.log(`graded ${graded} run(s); ${manual} assertion(s) left for the grader subagent`);
  if (unverified.length) {
    console.warn(
      `\nwarning: ${unverified.length} of ${graded} run(s) cannot prove they measured this repo's skills.\n` +
        `A run with no verified ${RUN_SOURCE_FILE} may have resolved ~/.claude/skills/ instead, whose\n` +
        'contents differ from this tree — its pass rate is not evidence about the source under test.',
    );
    for (const u of unverified) console.warn(`  ${u}`);
  }
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
  const unverified = results.filter((r) => r.sourceStatus !== 'verified');
  // The commit the runs MEASURED, not HEAD at freeze time. Those differ whenever a baseline is
  // frozen or re-frozen after the tree moved on — which is exactly when a baseline matters. The
  // first freeze of this iteration stamped the current HEAD onto runs captured two commits earlier,
  // quietly claiming they measured skills they had never seen.
  const stampFile = path.join(iterRoot, 'iteration.json');
  const stamp = fs.existsSync(stampFile) ? readJson(stampFile) : null;
  const measured = stamp && stamp.sourceAt ? stamp.sourceAt : null;
  const baseline = {
    capturedFrom: from,
    model: cfg.model,
    commit: measured || currentCommit(),
    commitSource: measured ? `${path.relative(REPO_ROOT, stampFile)} — the commit these runs were graded against` : 'HEAD at freeze time',
    workingTreeClean: clean,
    caseCount: results.length,
    // FR-018 wants a baseline that predates the rewrite; it is only a usable reference if it also
    // measured the tree being rewritten. Recording the count makes that checkable later instead of
    // inferred from the capture date.
    sourceVerifiedCount: results.length - unverified.length,
    sourceUnverified: unverified.map((r) => `${r.key}: ${r.sourceStatus}`),
    results,
  };
  writeJson(path.join(REPO_ROOT, cfg.baselineDir, 'baseline.json'), baseline);
  if (clean === false) {
    console.warn('warning: working tree was dirty at capture; the recorded commit does not fully describe what ran');
  }
  if (unverified.length) {
    console.warn(
      `warning: ${unverified.length} of ${results.length} case(s) cannot prove they measured ${cfg.skillsRoot}.\n` +
        'Such a baseline is a record of some run, but not a pre-rewrite reference for this tree.',
    );
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
        // Runs graded before A.5 carry no provenance at all, which is itself the finding — they are
        // reported as `unrecorded` rather than quietly assumed good.
        sourceStatus: g.skill_source ? g.skill_source.status : 'unrecorded',
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
      baselineSource: b ? b.sourceStatus || 'unrecorded' : null,
      currentSource: c.sourceStatus,
      // A delta between two runs of unknown provenance is arithmetic, not evidence. Naming that on
      // the row keeps a null delta from reading as "no regression" — the exact misreading A.5 fixes.
      sourceComparable: Boolean(b) && c.sourceStatus === 'verified' && (b.sourceStatus || 'unrecorded') === 'verified',
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
      sourceIncomparable: rows.filter((r) => !r.sourceComparable).length,
    },
  };
  const outFile = path.join(REPO_ROOT, cfg.reportsDir, `${against}-vs-baseline.json`);
  writeJson(outFile, report);

  if (!report.modelComparable) {
    console.warn(`warning: baseline ran on ${baseline.model}, this run on ${cfg.model} — the delta is not a clean comparison`);
  }
  console.log(`| case | kind | baseline | current | delta | status | source |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const fmt = (v) => (v === null ? '—' : v.toFixed(2));
    const d = r.delta === null ? '—' : (r.delta > 0 ? '+' : '') + r.delta.toFixed(2);
    const src = r.sourceComparable ? 'verified' : `${r.baselineSource || '—'}→${r.currentSource}`;
    console.log(`| ${r.key} | ${r.kind} | ${fmt(r.baseline)} | ${fmt(r.current)} | ${d} | ${r.status} | ${src} |`);
  }
  const s = report.summary;
  console.log(`\n${s.improved} improved, ${s.regressed} regressed, ${s.unchanged} unchanged, ${s.new} new, ${s.dropped} dropped`);
  if (s.sourceIncomparable) {
    console.warn(
      `\nwarning: ${s.sourceIncomparable} of ${rows.length} row(s) compare runs that cannot both prove they read\n` +
        `${cfg.skillsRoot}. Treat those deltas as unmeasured, not as "no change".`,
    );
  }
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
    else if (a === '--source-at') opts['source-at'] = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    // An unrecognised flag used to be dropped on the floor. That is how `--source-at` appeared to
    // do nothing on its first run: grading re-based on HEAD, reported 33 mismatches, and exited 0
    // as though the request had been honoured. A typo in a flag name must not look like a result.
    else if (a.startsWith('--')) {
      console.error(`bench: unknown option '${a}'`);
      process.exit(2);
    }
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

module.exports = {
  discoverSkills,
  loadCases,
  loadConfig,
  gradeAssertion,
  collectResults,
  buildPlan,
  loadRunContext,
  verifySkillSource,
  skillSourceSha256,
  SKILL_RESOLUTION,
  RUN_SOURCE_FILE,
};

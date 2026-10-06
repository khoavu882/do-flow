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

/** What a triggering run must write to record whether it judged the request to route to its skill. */
const RUN_ROUTING_FILE = 'routing.json';

/** What the orchestrating agent writes beside a run's records: the usage its task notification reported. */
const RUN_TIMING_FILE = 'timing.json';

/** The two ways a case is run. `without-skill` withholds the skill under test to measure what the
 * skill adds, and is only emitted on request for behavioral cases. */
const ARMS = ['with-skill', 'without-skill'];

/** The suffixes that keep a without-skill run's directory and sandbox apart from its with-skill pair. */
const WITHOUT_SKILL_DIR_SUFFIX = '--without-skill';
const WITHOUT_SKILL_SANDBOX_SUFFIX = '-noskill';

/** The two sides of the corpus. Every case carries one; a baseline capture freezes it. */
const SPLITS = ['train', 'heldout'];

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

/** Where run iterations live, and where the committed baseline is. `opts.runsRoot` and
 * `opts.baselineFile` exist so a fixture can point a command at a temporary directory; `parseArgs`
 * never sets them, so the command line cannot redirect a real capture. */
function runsRootOf(cfg, opts) {
  return opts.runsRoot || path.join(REPO_ROOT, cfg.benchRoot, 'runs');
}

function baselineFileOf(cfg, opts) {
  return opts.baselineFile || path.join(REPO_ROOT, cfg.baselineDir, 'baseline.json');
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
  // The by-path answer to "should this request NOT route here". `skill_not_invoked` cannot give it:
  // it is undecided on every by-path run. A triggering run instead records its routing decision in
  // routing.json, and this reads that record. It never returns null on a with-skill run, and a
  // missing or unreadable record fails rather than passes: silence cannot read as "not routed".
  skill_not_routed: (a, ctx) => {
    const rec = ctx.routing;
    if (!rec) return { passed: false, evidence: `no ${RUN_ROUTING_FILE} saved: the run recorded no routing decision` };
    if (rec.malformed || typeof rec !== 'object' || Array.isArray(rec)) {
      return { passed: false, evidence: `${RUN_ROUTING_FILE} is not a JSON object: the run's routing decision cannot be read` };
    }
    if (typeof rec.routed !== 'boolean') {
      return { passed: false, evidence: `${RUN_ROUTING_FILE} has no boolean routed: the run's routing decision cannot be read` };
    }
    if (rec.skill !== a.skill) {
      return { passed: false, evidence: `${RUN_ROUTING_FILE} records skill ${JSON.stringify(rec.skill)}, not ${a.skill}` };
    }
    return rec.routed
      ? { passed: false, evidence: `${RUN_ROUTING_FILE}: ${a.skill} routed, the request should not route here` }
      : { passed: true, evidence: `${RUN_ROUTING_FILE}: ${a.skill} not routed` };
  },
};

const WITHHELD_UNDECIDED = {
  skill_resolved: 'withheld arm: the skill was withheld from this run',
  skill_invoked: 'withheld arm: the skill was withheld from this run',
  skill_not_invoked: 'withheld arm: the skill was withheld from this run',
  skill_not_routed: 'withheld arm: no description was judged',
};

/** Every assertion type the runner decides or defers. A case file naming any other type would grade
 * `passed: null` silently, so the guard suite checks case files against this list. */
const ASSERTION_TYPES = [...Object.keys(PROGRAMMATIC), 'manual'];

/**
 * A run directory holds whatever the dispatched subagent saved. `transcript.txt` and
 * `invoked_skills.json` are optional: a missing input makes dependent assertions fail with a
 * stated reason rather than silently passing, because a check nobody could run is not a pass.
 */
function loadRunContext(runDir) {
  const transcriptFile = path.join(runDir, 'transcript.txt');
  const invokedFile = path.join(runDir, 'invoked_skills.json');
  const sourceFile = path.join(runDir, RUN_SOURCE_FILE);
  const routingFile = path.join(runDir, RUN_ROUTING_FILE);
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
  let routing = null;
  if (fs.existsSync(routingFile)) {
    try {
      routing = readJson(routingFile);
    } catch {
      routing = { malformed: true };
    }
  }
  return {
    runDir,
    transcript: fs.existsSync(transcriptFile) ? fs.readFileSync(transcriptFile, 'utf8') : '',
    invokedSkills: fs.existsSync(invokedFile) ? readJson(invokedFile) : [],
    hasTranscript: fs.existsSync(transcriptFile),
    skillSource,
    hasSkillSource: fs.existsSync(sourceFile),
    routing,
    outputFiles,
    // Concatenated so one regex sweeps every artifact — an assertion about what a run produced
    // rarely cares which file it landed in, and naming the file would couple the case to a layout
    // the skill under test is free to change.
    outputsText: outputFiles.map((f) => safeRead(f)).join('\n'),
  };
}

const validTokens = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * What a run cost, read only from a valid `timing.json`. Each field is validated on its own and an
 * absent, unreadable or invalid one is null: a value nobody reported is unknown, and counting it as 0
 * would make an unmeasured run look free. Other keys in the file are ignored, so a file in another
 * tool's shape (for example `total_duration_seconds`) is `invalid` rather than misread.
 */
function readUsage(runDir) {
  const file = path.join(runDir, RUN_TIMING_FILE);
  const unknown = (status, evidence) => ({ total_tokens: null, duration_ms: null, status, evidence });
  if (!fs.existsSync(file)) return unknown('unrecorded', `no ${RUN_TIMING_FILE} saved: usage is unknown`);
  let rec;
  try {
    rec = readJson(file);
  } catch {
    return unknown('malformed', `${RUN_TIMING_FILE} is not valid JSON: usage is unknown`);
  }
  const obj = rec !== null && typeof rec === 'object' && !Array.isArray(rec) ? rec : {};
  const total_tokens = validTokens(obj.total_tokens);
  const duration_ms = Number.isFinite(obj.duration_ms) && obj.duration_ms >= 0 ? obj.duration_ms : null;
  if (total_tokens === null && duration_ms === null) {
    return unknown('invalid', `${RUN_TIMING_FILE} has no valid total_tokens (integer >= 0) or duration_ms (number >= 0): usage is unknown`);
  }
  if (total_tokens === null || duration_ms === null) {
    return { total_tokens, duration_ms, status: 'partial', evidence: `${RUN_TIMING_FILE} has no valid ${total_tokens === null ? 'total_tokens' : 'duration_ms'}: that value is unknown` };
  }
  return { total_tokens, duration_ms, status: 'recorded', evidence: `${RUN_TIMING_FILE}: ${total_tokens} total_tokens, ${duration_ms} ms` };
}

/** Totals over runs, summing only values that are known. A null is counted as unknown and never adds
 * 0 to a sum, so the totals stay lower bounds rather than quietly understating an unmeasured run. */
function summarizeUsage(usages) {
  const out = { knownTokens: 0, knownTokenRuns: 0, unknownTokenRuns: 0, knownDurationMs: 0, knownDurationRuns: 0, unknownDurationRuns: 0 };
  for (const u of usages) {
    if (u && u.total_tokens !== null && u.total_tokens !== undefined) {
      out.knownTokens += u.total_tokens;
      out.knownTokenRuns += 1;
    } else out.unknownTokenRuns += 1;
    if (u && u.duration_ms !== null && u.duration_ms !== undefined) {
      out.knownDurationMs += u.duration_ms;
      out.knownDurationRuns += 1;
    } else out.unknownDurationRuns += 1;
  }
  return out;
}

/** The token ceiling a plan or report checks usage against. Refused rather than defaulted: a missing
 * or malformed block would otherwise turn the check off without anyone having chosen that. */
function loadCeiling(cfg) {
  const c = cfg.costCeiling;
  const refuse = (reason) => new Error(`bench/config.json costCeiling is invalid: ${reason}`);
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw refuse('the block is missing');
  if (c.unit !== 'total_tokens') throw refuse(`unit must be total_tokens, got ${JSON.stringify(c.unit)}`);
  if (!Number.isInteger(c.maxTokensPerRun) || c.maxTokensPerRun <= 0) {
    throw refuse(`maxTokensPerRun must be a positive integer, got ${JSON.stringify(c.maxTokensPerRun)}`);
  }
  return { unit: c.unit, maxTokensPerRun: c.maxTokensPerRun };
}

/**
 * Known usage against the budget for a set of runs. `breached` is true as soon as the known total
 * exceeds the budget, since unknown runs can only add to it, and false only when every run is known:
 * a total that leaves runs out cannot show the budget was kept, so that case is null.
 */
function ceilingState(ceiling, usages) {
  const budget = ceiling.maxTokensPerRun * usages.length;
  const s = summarizeUsage(usages);
  return {
    unit: ceiling.unit,
    maxTokensPerRun: ceiling.maxTokensPerRun,
    budget,
    knownTokens: s.knownTokens,
    unknownRuns: s.unknownTokenRuns,
    breached: s.knownTokens > budget ? true : s.unknownTokenRuns === 0 ? false : null,
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

/**
 * Decide, from what a without-skill run recorded, whether the skill really was withheld from it.
 *
 * The sandbox no longer holds the skill, but `~/.claude/skills/` is outside it and a by-name lookup
 * reaches it, so withholding is checked rather than assumed. A run that reads the skill's SKILL.md
 * anywhere is `leaked` and its pass rate is not a without-skill measurement; one that saved no
 * record, one that is not an object, or one naming another skill is `unrecorded`, never `withheld`,
 * because silence is not proof. A skill listed in `invoked_skills.json` is `leaked` as well.
 */
function classifyWithheld(skill, ctx) {
  const unrecorded = (evidence) => ({ status: 'unrecorded', recordedPath: null, evidence });
  const leaked = (evidence, recordedPath = null) => ({ status: 'leaked', recordedPath, evidence });
  // A skill the run loaded through the Skill tool is a leak whatever else it recorded.
  if (Array.isArray(ctx.invokedSkills) && ctx.invokedSkills.includes(skill)) {
    return leaked('invoked_skills.json lists the skill: the run loaded it');
  }
  const rec = ctx.skillSource;
  if (!ctx.hasSkillSource) return unrecorded(`no ${RUN_SOURCE_FILE} saved — cannot tell whether the skill was withheld`);
  if (rec && rec.malformed) return unrecorded(`${RUN_SOURCE_FILE} is not valid JSON — cannot tell whether the skill was withheld`);
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    return unrecorded(`${RUN_SOURCE_FILE} is not a JSON object — cannot tell whether the skill was withheld`);
  }
  if (rec.skill !== undefined && rec.skill !== skill) {
    return unrecorded(`${RUN_SOURCE_FILE} records skill ${JSON.stringify(rec.skill)}, not ${skill} — cannot tell whether ${skill} was withheld`);
  }
  const recordedPath = rec.path === undefined ? null : rec.path;
  if (rec.withheld !== true || recordedPath !== null) {
    return leaked(
      recordedPath !== null ? `${RUN_SOURCE_FILE} records a path (${recordedPath}): the run read a skill file` : `${RUN_SOURCE_FILE} does not record withheld: true`,
      recordedPath,
    );
  }
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const read = new RegExp(`skills[\\\\/]${escaped}[\\\\/]SKILL\\.md`);
  const where = read.test(ctx.transcript) ? 'transcript' : read.test(ctx.outputsText) ? 'outputs' : null;
  if (where) return leaked(`the ${where} names skills/${skill}/SKILL.md: the run reached the skill`);
  return { status: 'withheld', recordedPath: null, evidence: `${RUN_SOURCE_FILE} records withheld: true and no skills/${skill}/SKILL.md was read` };
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
  // A without-skill run has no description to judge and no skill to have read, so a verdict on any of
  // these would be invented. They are left undecided, and the rest of the case grades as usual.
  if (ctx.arm === 'without-skill' && WITHHELD_UNDECIDED[kind]) {
    return { text: assertion.text, passed: null, evidence: WITHHELD_UNDECIDED[kind] };
  }
  // Scope, not just type. scopeFor() routes `in: 'outputs'` to the artifacts under outputs/ and never
  // reads the transcript, so gating those on hasTranscript failed 15 shipped assertions across four
  // skills whenever a run produced artifacts but no transcript — understating the pass rate and
  // pointing a baseline delta at the wrong file.
  const needsTranscript = (kind === 'output_matches' || kind === 'output_not_matches')
    && assertion.in !== 'outputs';
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
      if (opts.split && e.split !== opts.split) continue;
      out.push({ skill, id: e.id, kind: e.kind, split: e.split, name: e.name, prompt: e.prompt });
    }
  }
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else out.forEach((c) => console.log(`${c.skill}/${c.id} [${c.kind}, ${c.split}] ${c.name}`));
  return 0;
}

const WT_REQUIRE = "const{WorktreeManager}=require('./src/runtime/worktree.js');const m=new WorktreeManager(process.cwd());";

/**
 * The rule every dispatched run has to follow, stated once at the top of the plan rather than
 * duplicated across every entry.
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

/**
 * The same case run with the skill under test withheld. The create step deletes the skill's copies
 * from the sandbox after `createSandbox` projected them, so the bench carries no change to the
 * worktree code. The tracked copy is marked skip-worktree so its deletion does not show in the
 * sandbox's `git status` or `git diff`, where the path would read as the run reaching the skill.
 * `~/.claude/skills` is outside any sandbox and cannot be removed this way; a run that reaches it is
 * caught at grading as `leaked`, not prevented here.
 *
 * The request is the case's prompt without its leading `/<skill>` token, which names the very skill
 * being withheld. A case with nothing left has no request to measure and yields no run.
 */
function withoutSkillRun(cfg, skill, e, withSkill) {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prompt = e.prompt.replace(new RegExp(`^/${escaped}(?=\\s|$)\\s*`), '');
  if (prompt.trim() === '') return null;
  const sandboxId = `${withSkill.sandbox.id}${WITHOUT_SKILL_SANDBOX_SUFFIX}`;
  const workingDir = path.join('.doflow', 'worktrees', sandboxId);
  const skillDirs = [path.posix.join(...SANDBOX_SKILLS_DIR.split(path.sep), skill), path.posix.join(cfg.skillsRoot, skill)];
  return {
    skill,
    evalId: e.id,
    evalName: e.name,
    kind: e.kind,
    split: e.split,
    arm: 'without-skill',
    prompt,
    expectedOutput: e.expected_output,
    model: cfg.model,
    sandbox: {
      required: true,
      id: sandboxId,
      create: `node -e "${WT_REQUIRE}const r=m.createSandbox('${sandboxId}');const fs=require('fs'),p=require('path'),cp=require('child_process'),D=[${skillDirs.map((d) => `'${d}'`).join(',')}];for(const d of D)fs.rmSync(p.join(r.path,d),{recursive:true,force:true});const o=cp.execFileSync('git',['ls-files','-z','--',...D],{cwd:r.path});if(o.length)cp.execFileSync('git',['update-index','--skip-worktree','-z','--stdin'],{cwd:r.path,input:o});console.log(r.path+' withheld=${skill}')"`,
      remove: `node -e "${WT_REQUIRE}m.remove('${sandboxId}')"`,
      workingDir,
    },
    skills: {
      resolution: 'withheld',
      skill,
      withheldPaths: skillDirs.map((d) => path.join(workingDir, d)),
      instruction:
        `The skill ${skill} is withheld for this run. Do NOT read any file under a skills/${skill}/ directory (in this sandbox, in ${cfg.skillsRoot} or in ~/.claude/skills), ` +
        `and do NOT invoke /${skill} or the Skill tool for it. Handle the request without it. Write ${RUN_SOURCE_FILE} as {"skill": "${skill}", "withheld": true}.`,
      mustRecord: RUN_SOURCE_FILE,
    },
    outputDir: `${withSkill.outputDir}${WITHOUT_SKILL_DIR_SUFFIX}`,
    saveOutputs: ['transcript.txt', 'invoked_skills.json', RUN_SOURCE_FILE, 'outputs/'],
  };
}

const CEILING_ENFORCEMENT =
  'The orchestrating agent stops dispatching once the recorded total_tokens of this iteration reach budget; runs not dispatched are reported as not run.';

function buildPlan(cfg, opts) {
  const ceiling = loadCeiling(cfg);
  const skills = opts.skill ? [opts.skill] : discoverSkills(cfg);
  const runs = [];
  for (const skill of skills) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals) {
      if (opts.split && e.split !== opts.split) continue;
      // Every run is sandboxed. Shipped cases invoke skills that write files, create branches, or
      // commit; without isolation a baseline capture would mutate the very tree
      // being measured. The id is the worktree name, so it must satisfy WorktreeManager's charset.
      const sandboxId = `bench-${opts.iteration}-${skill}-${e.id}`.replace(/[^A-Za-z0-9._-]/g, '-');
      const workingDir = path.join('.doflow', 'worktrees', sandboxId);
      const skillFile = path.join(workingDir, SANDBOX_SKILLS_DIR, skill, 'SKILL.md');
      runs.push({
        skill,
        evalId: e.id,
        evalName: e.name,
        kind: e.kind,
        split: e.split,
        arm: 'with-skill',
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
            ? `Read the frontmatter of ${skillFile} and decide from THAT description whether this request routes to ${skill}. Record the decision. Do NOT invoke /${skill} by name — that would judge ~/.claude/skills/${skill}/'s description, not this repo's. Write the decision to ${RUN_ROUTING_FILE} as {"skill": "${skill}", "routed": true or false}.`
            : `Read ${skillFile} and follow it. Do NOT invoke /${skill} by name — that resolves ~/.claude/skills/${skill}/, not this repo.`,
          mustRecord: RUN_SOURCE_FILE,
        },
        outputDir: path.join(cfg.benchRoot, 'runs', opts.iteration, skill, `eval-${e.id}-${e.name}`),
        saveOutputs: ['transcript.txt', 'invoked_skills.json', RUN_SOURCE_FILE, 'outputs/', ...(e.kind === 'triggering' ? [RUN_ROUTING_FILE] : [])],
      });
      const without = opts.arm === 'without-skill' && e.kind === 'behavioral' ? withoutSkillRun(cfg, skill, e, runs[runs.length - 1]) : null;
      if (without) runs.push(without);
    }
  }
  // Each run is projected at what the committed baseline recorded for the same case. A case with no
  // baseline result, or a result with no usage, is unknown rather than free.
  const baselineFile = baselineFileOf(cfg, opts);
  const baseline = fs.existsSync(baselineFile) ? readJson(baselineFile) : null;
  const recordedBy = (field) => new Map((baseline && Array.isArray(baseline[field]) ? baseline[field] : []).map((r) => [r.key, r]));
  const recorded = { 'with-skill': recordedBy('results'), 'without-skill': recordedBy('withoutSkillResults') };
  const projection = ceilingState(
    ceiling,
    runs.map((r) => {
      const hit = recorded[r.arm].get(`${r.skill}/${r.evalId}`);
      return { total_tokens: validTokens(hit && hit.usage ? hit.usage.total_tokens : null), duration_ms: null };
    }),
  );
  return {
    iteration: opts.iteration,
    model: cfg.model,
    commit: currentCommit(),
    workingTreeClean: workingTreeClean(),
    skillResolution: SKILL_RESOLUTION,
    skillSourceRoot: cfg.skillsRoot,
    filters: { skill: opts.skill || null, split: opts.split || null, arm: opts.arm || null },
    costCeiling: {
      unit: projection.unit,
      maxTokensPerRun: projection.maxTokensPerRun,
      budget: projection.budget,
      projectedKnownTokens: projection.knownTokens,
      projectedUnknownRuns: projection.unknownRuns,
      breached: projection.breached,
      enforcement: CEILING_ENFORCEMENT,
    },
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
  let plan;
  try {
    plan = buildPlan(cfg, opts);
  } catch (err) {
    console.error(`bench: ${err.message}`);
    return 2;
  }
  const c = plan.costCeiling;
  if (c.breached === true) {
    console.error(
      `bench plan: projected usage ${c.projectedKnownTokens} total_tokens from ${plan.runCount - c.projectedUnknownRuns} run(s) with known usage exceeds the budget ${c.budget} ` +
        `(${c.maxTokensPerRun} x ${plan.runCount} runs, bench/config.json costCeiling); ${c.projectedUnknownRuns} run(s) unknown`,
    );
    return 2;
  }
  if (c.breached === null) {
    console.error(`warning: cost projection unknown for ${c.projectedUnknownRuns} of ${plan.runCount} run(s); the orchestrating agent enforces the budget at dispatch`);
  }
  console.log(JSON.stringify(plan, null, 2));
  return 0;
}

function cmdGrade(cfg, opts) {
  if (!opts.iteration) {
    console.error('bench grade: --iteration <name> is required');
    return 2;
  }
  const iterRoot = path.join(runsRootOf(cfg, opts), opts.iteration);
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
  let usageUnknown = 0;
  let usageIncomplete = 0;
  const counts = { 'with-skill': 0, 'without-skill': 0 };
  const unverified = [];
  const unwithheld = [];
  const skills = opts.skill ? [opts.skill] : discoverSkills(cfg);
  for (const skill of skills) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals) {
      for (const arm of ARMS) {
        // Only a behavioral case has a without-skill run, so a stray directory for a triggering case
        // is not graded as one.
        if (arm === 'without-skill' && e.kind !== 'behavioral') continue;
        const runDir = path.join(iterRoot, skill, `eval-${e.id}-${e.name}${arm === 'without-skill' ? WITHOUT_SKILL_DIR_SUFFIX : ''}`);
        if (!fs.existsSync(runDir)) continue;
        const ctx = loadRunContext(runDir);
        // skill_resolved needs both to reach verifySkillSource; attached here rather than threaded
        // through loadRunContext, which is also used by callers that have no case in hand.
        ctx.cfg = cfg;
        ctx.skill = skill;
        ctx.sourceAt = sourceAt;
        ctx.arm = arm;
        const expectations = (e.assertions || []).map((a) => gradeAssertion(a, ctx));
        manual += expectations.filter((x) => x.passed === null).length;
        const decided = expectations.filter((x) => x.passed !== null);
        // Provenance is recorded beside the expectations rather than inside them: a run that measured
        // the wrong skill has an invalid pass rate, not a lower one, and folding it into the rate
        // would silently reprice every case in the committed baseline.
        let skillSource;
        if (arm === 'without-skill') {
          skillSource = classifyWithheld(skill, ctx);
          if (skillSource.status !== 'withheld') unwithheld.push(`${skill}/${e.id} (without-skill): ${skillSource.status} — ${skillSource.evidence}`);
        } else {
          skillSource = verifySkillSource(cfg, skill, ctx);
          if (skillSource.status !== 'verified') unverified.push(`${skill}/${e.id}: ${skillSource.status} — ${skillSource.evidence}`);
        }
        const usage = readUsage(runDir);
        // Counted as summarizeUsage counts: unknown is a missing total_tokens; a known total_tokens with
        // no duration_ms is incomplete.
        if (usage.total_tokens === null) usageUnknown += 1;
        else if (usage.status !== 'recorded') usageIncomplete += 1;
        writeJson(path.join(runDir, 'grading.json'), {
          skill,
          eval_id: e.id,
          eval_name: e.name,
          arm,
          split: e.split,
          skill_source: skillSource,
          expectations,
          pass_rate: decided.length ? decided.filter((x) => x.passed).length / decided.length : null,
          usage,
        });
        graded += 1;
        counts[arm] += 1;
      }
    }
  }
  console.log(`graded ${graded} run(s) (${counts['with-skill']} with-skill, ${counts['without-skill']} without-skill); ${manual} assertion(s) left for the grader subagent; usage unknown for ${usageUnknown} run(s)${usageIncomplete ? `; usage incomplete for ${usageIncomplete} run(s)` : ''}`);
  if (unverified.length) {
    console.warn(
      `\nwarning: ${unverified.length} of ${counts['with-skill']} with-skill run(s) cannot prove they measured this repo's skills.\n` +
        `A run with no verified ${RUN_SOURCE_FILE} may have resolved ~/.claude/skills/ instead, whose\n` +
        'contents differ from this tree — its pass rate is not evidence about the source under test.',
    );
    for (const u of unverified) console.warn(`  ${u}`);
  }
  if (unwithheld.length) {
    console.warn(
      `\nwarning: ${unwithheld.length} of ${counts['without-skill']} without-skill run(s) are not withheld.\n` +
        'A run that may have reached the skill is not a without-skill measurement.',
    );
    for (const u of unwithheld) console.warn(`  ${u}`);
  }
  return 0;
}

/** Freeze an iteration as the committed baseline (FR-018). Records the commit it was taken at so
 * the "baseline predates the rewrite" property is checkable after the fact rather than trusted. */
function cmdBaseline(cfg, opts) {
  const from = opts.from || 'baseline';
  const iterRoot = path.join(runsRootOf(cfg, opts), from);
  if (!fs.existsSync(iterRoot)) {
    console.error(`bench baseline: no runs found at ${path.relative(REPO_ROOT, iterRoot)}`);
    return 2;
  }
  const results = collectResults(cfg, iterRoot);
  const withoutSkillResults = collectResults(cfg, iterRoot, 'without-skill');
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
    usageSummary: { withSkill: summarizeUsage(results.map((r) => r.usage)), withoutSkill: summarizeUsage(withoutSkillResults.map((r) => r.usage)) },
    results,
    withoutSkillResults,
  };
  writeJson(baselineFileOf(cfg, opts), baseline);
  if (clean === false) {
    console.warn('warning: working tree was dirty at capture; the recorded commit does not fully describe what ran');
  }
  if (unverified.length) {
    console.warn(
      `warning: ${unverified.length} of ${results.length} case(s) cannot prove they measured ${cfg.skillsRoot}.\n` +
        'Such a baseline is a record of some run, but not a pre-rewrite reference for this tree.',
    );
  }
  console.log(`baseline written: ${results.length} case(s)${withoutSkillResults.length ? ` and ${withoutSkillResults.length} without-skill result(s)` : ''} at commit ${baseline.commit || 'unknown'}`);
  return 0;
}

/** The two usage values a result keeps. A grading written before usage was captured has none, which
 * reads as unknown rather than 0. */
function resultUsage(g) {
  const u = g && g.usage ? g.usage : {};
  return { total_tokens: u.total_tokens ?? null, duration_ms: u.duration_ms ?? null };
}

function collectResults(cfg, iterRoot, arm = 'with-skill') {
  const results = [];
  for (const skill of discoverSkills(cfg)) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals) {
      if (arm === 'without-skill' && e.kind !== 'behavioral') continue;
      const dir = `eval-${e.id}-${e.name}${arm === 'without-skill' ? WITHOUT_SKILL_DIR_SUFFIX : ''}`;
      const gradingFile = path.join(iterRoot, skill, dir, 'grading.json');
      if (!fs.existsSync(gradingFile)) continue;
      const g = readJson(gradingFile);
      results.push({
        key: `${skill}/${e.id}`,
        skill,
        evalId: e.id,
        evalName: e.name,
        kind: e.kind,
        split: e.split,
        passRate: g.pass_rate,
        // Runs graded before A.5 carry no provenance at all, which is itself the finding — they are
        // reported as `unrecorded` rather than quietly assumed good.
        sourceStatus: g.skill_source ? g.skill_source.status : 'unrecorded',
        expectations: g.expectations.map((x) => ({ text: x.text, passed: x.passed })),
        usage: resultUsage(g),
      });
    }
  }
  return results;
}

/**
 * What the skill adds on behavioral cases, per skill: the mean pass rate with it against without it,
 * over the cases where both arms are decided and each arm's provenance holds (the with-skill run
 * `verified`, the without-skill run `withheld`). A case that fails either condition is left out, not
 * counted as 0, so a leaked or unrecorded run cannot move the delta.
 */
function armDeltas(withResults, withoutResults) {
  const behavioral = (rs) => rs.filter((r) => r.kind === 'behavioral');
  const withB = behavioral(withResults);
  const withoutB = behavioral(withoutResults);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return [...new Set([...withB, ...withoutB].map((r) => r.skill))].sort().map((skill) => {
    const w = withB.filter((r) => r.skill === skill);
    const wo = withoutB.filter((r) => r.skill === skill);
    const paired = w.flatMap((r) => {
      const other = wo.find((o) => o.key === r.key);
      const ok = other && r.passRate !== null && other.passRate !== null
        && r.sourceStatus === 'verified' && other.sourceStatus === 'withheld';
      return ok ? [{ key: r.key, withSkill: r.passRate, withoutSkill: other.passRate }] : [];
    });
    if (paired.length === 0) {
      return {
        skill,
        pairedCases: [],
        withSkill: null,
        withoutSkill: null,
        delta: null,
        reason: wo.length === 0 ? 'no without-skill results' : w.length === 0 ? 'no with-skill results' : 'no case with both arms decided, verified and withheld',
      };
    }
    const withSkill = mean(paired.map((p) => p.withSkill));
    const withoutSkill = mean(paired.map((p) => p.withoutSkill));
    return { skill, pairedCases: paired.map((p) => p.key), withSkill, withoutSkill, delta: withSkill - withoutSkill, reason: null };
  });
}

/** A baseline with no `results` array describes no cases, so every row would read as pending. */
function requireBaselineResults(baseline) {
  if (!baseline || !Array.isArray(baseline.results)) throw new Error('the baseline has no results array');
}

/**
 * The report for one iteration against the baseline. Pure: the caller reads the baseline and the
 * graded runs, so a fixture can exercise it without touching bench/baseline or bench/runs.
 *
 * A case the baseline has no result for is `pending`, not "new": it is waiting on a paid capture,
 * and nothing about it is a delta.
 */
function buildReport({ baseline, withResults, withoutResults = [], cfg, iteration, commit }) {
  requireBaselineResults(baseline);
  const byKey = new Map(baseline.results.map((r) => [r.key, r]));
  const rows = [];
  for (const c of withResults) {
    const b = byKey.get(c.key);
    rows.push({
      key: c.key,
      kind: c.kind,
      split: c.split,
      baseline: b ? b.passRate : null,
      current: c.passRate,
      delta: b && b.passRate !== null && c.passRate !== null ? c.passRate - b.passRate : null,
      // A rate that is null on either side has no delta, so it is not a movement in either direction.
      status: !b ? 'pending' : b.passRate === null || c.passRate === null || b.passRate === c.passRate ? 'unchanged' : c.passRate > b.passRate ? 'improved' : 'regressed',
      baselineSource: b ? b.sourceStatus || 'unrecorded' : null,
      currentSource: c.sourceStatus,
      // A delta between two runs of unknown provenance is arithmetic, not evidence. Naming that on
      // the row keeps a null delta from reading as "no regression" — the exact misreading A.5 fixes.
      sourceComparable: Boolean(b) && c.sourceStatus === 'verified' && (b.sourceStatus || 'unrecorded') === 'verified',
      usage: resultUsage(c),
    });
  }
  const dropped = baseline.results.filter((b) => !withResults.some((c) => c.key === b.key));
  const pending = rows.filter((r) => r.status === 'pending').length;
  return {
    baselineCommit: baseline.commit,
    baselineModel: baseline.model,
    currentIteration: iteration,
    currentCommit: commit,
    currentModel: cfg.model,
    modelComparable: baseline.model === cfg.model,
    rows,
    droppedCases: dropped.map((d) => d.key),
    summary: {
      improved: rows.filter((r) => r.status === 'improved').length,
      regressed: rows.filter((r) => r.status === 'regressed').length,
      unchanged: rows.filter((r) => r.status === 'unchanged').length,
      pending,
      dropped: dropped.length,
      sourceIncomparable: rows.filter((r) => r.status !== 'pending' && !r.sourceComparable).length,
    },
    pendingNote: pending > 0
      ? `${pending} case(s) are pending: they await a paid baseline capture and carry no baseline result`
      : null,
    usage: {
      withSkill: summarizeUsage(withResults.map(resultUsage)),
      withoutSkill: summarizeUsage(withoutResults.map(resultUsage)),
    },
    ceiling: ceilingState(loadCeiling(cfg), [...withResults, ...withoutResults].map(resultUsage)),
    armDelta: armDeltas(withResults, withoutResults),
  };
}

/**
 * Per-task delta against the baseline. Reports each case individually rather than only an
 * aggregate mean — an aggregate hides the case where two skills move in opposite directions, and
 * the prompting guide's experiment protocol calls that out specifically.
 */
function cmdReport(cfg, opts) {
  try {
    loadCeiling(cfg);
  } catch (err) {
    console.error(`bench: ${err.message}`);
    return 2;
  }
  const baselineFile = baselineFileOf(cfg, opts);
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
  try {
    requireBaselineResults(baseline);
  } catch (err) {
    console.error(`bench report: ${err.message} (${path.relative(REPO_ROOT, baselineFile)})`);
    return 2;
  }
  const currentRoot = path.join(runsRootOf(cfg, opts), against);
  if (!fs.existsSync(currentRoot)) {
    console.error(`bench report: no runs found at ${path.relative(REPO_ROOT, currentRoot)}`);
    return 2;
  }
  const withoutResults = collectResults(cfg, currentRoot, 'without-skill');
  const report = buildReport({ baseline, withResults: collectResults(cfg, currentRoot), withoutResults, cfg, iteration: against, commit: currentCommit() });
  const { rows } = report;
  const outFile = path.resolve(REPO_ROOT, cfg.reportsDir, `${against}-vs-baseline.json`);
  writeJson(outFile, report);

  if (!report.modelComparable) {
    console.warn(`warning: baseline ran on ${baseline.model}, this run on ${cfg.model} — the delta is not a clean comparison`);
  }
  console.log(`| case | kind | split | baseline | current | delta | status | source | tokens |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const fmt = (v) => (v === null ? '—' : v.toFixed(2));
    const d = r.delta === null ? '—' : (r.delta > 0 ? '+' : '') + r.delta.toFixed(2);
    const src = r.sourceComparable ? 'verified' : `${r.baselineSource || '—'}→${r.currentSource}`;
    const tokens = r.usage.total_tokens === null ? 'unknown' : r.usage.total_tokens;
    console.log(`| ${r.key} | ${r.kind} | ${r.split} | ${fmt(r.baseline)} | ${fmt(r.current)} | ${d} | ${r.status} | ${src} | ${tokens} |`);
  }
  const s = report.summary;
  console.log(`\n${s.improved} improved, ${s.regressed} regressed, ${s.unchanged} unchanged, ${s.pending} pending, ${s.dropped} dropped`);
  if (report.pendingNote) console.log(report.pendingNote);
  const u = report.usage.withSkill;
  console.log(`usage: ${u.knownTokens} total_tokens over ${u.knownTokenRuns} run(s); unknown for ${u.unknownTokenRuns} run(s)`);
  if (withoutResults.length) {
    const w = report.usage.withoutSkill;
    console.log(`usage without-skill: ${w.knownTokens} total_tokens over ${w.knownTokenRuns} run(s); unknown for ${w.unknownTokenRuns} run(s)`);
  }
  const c = report.ceiling;
  const knownRuns = report.usage.withSkill.knownTokenRuns + report.usage.withoutSkill.knownTokenRuns;
  if (c.breached === true) {
    console.warn(`warning: ceiling exceeded: ${c.knownTokens} total_tokens over ${knownRuns} run(s) with known usage against the budget ${c.budget} (${c.maxTokensPerRun} x ${c.budget / c.maxTokensPerRun} runs)`);
  } else if (c.breached === null) {
    console.log(`ceiling: not exceeded by the ${knownRuns} run(s) with known usage; ${c.unknownRuns} run(s) unknown`);
  } else {
    console.log('ceiling: within budget');
  }
  if (s.sourceIncomparable) {
    console.warn(
      `\nwarning: ${s.sourceIncomparable} of ${rows.length - s.pending} compared row(s) compare runs that cannot both prove they read\n` +
        `${cfg.skillsRoot}. Treat those deltas as unmeasured, not as "no change".`,
    );
  }
  if (withoutResults.length) {
    const fmt = (v) => (v === null ? '—' : v.toFixed(2));
    console.log('\n| skill | paired | with | without | delta |');
    console.log('|---|---|---|---|---|');
    for (const a of report.armDelta) {
      const d = a.delta === null ? '—' : (a.delta > 0 ? '+' : '') + a.delta.toFixed(2);
      console.log(`| ${a.skill} | ${a.pairedCases.length} | ${fmt(a.withSkill)} | ${fmt(a.withoutSkill)} | ${d} |`);
    }
  }
  console.log(`report: ${path.relative(REPO_ROOT, outFile)}`);
  // Drift is reported, never blocking (requirement A1) — a regression is information, not a gate.
  return 0;
}

// ---------------------------------------------------------------------------

const USAGE = `doflow bench — evaluation harness for the shipped skills

  node bench/runner.js coverage [--json]              which skills have triggering + behavioral cases
  node bench/runner.js parity [--json]                does the committed baseline still describe the corpus
  node bench/runner.js list [--skill S] [--split train|heldout] [--json]
                                                      enumerate cases
  node bench/runner.js plan --iteration N [--skill S] [--split train|heldout] [--arm without-skill]
                                                      emit the subagent dispatch plan (JSON)
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
    else if (a === '--split') {
      opts.split = argv[++i];
      if (!SPLITS.includes(opts.split)) {
        console.error('bench: --split must be train or heldout');
        process.exit(2);
      }
    }
    else if (a === '--arm') {
      opts.arm = argv[++i];
      if (opts.arm !== 'without-skill') {
        console.error('bench: --arm must be without-skill');
        process.exit(2);
      }
    }
    else if (a === '--source-at') opts['source-at'] = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    // An unrecognised flag is refused. Dropping it would let a misspelt flag such as --source-at
    // re-base grading on HEAD, report every case as a mismatch and exit 0 as though the request had
    // been honoured.
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
  // Accepted only where it filters something; elsewhere it would be dropped on the floor, which is
  // the failure the unknown-option refusal above exists to prevent.
  if (opts.split && cmd !== 'plan' && cmd !== 'list') {
    console.error(`bench ${cmd}: --split is not accepted`);
    return 2;
  }
  if (opts.arm && cmd !== 'plan') {
    console.error(`bench ${cmd}: --arm is not accepted`);
    return 2;
  }
  const cfg = loadConfig();
  switch (cmd) {
    case 'coverage': return cmdCoverage(cfg, opts);
    case 'parity': return cmdParity(cfg, opts);
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

// ---------------------------------------------------------------------------
// Baseline parity (IC-002 of feature 028-bench-corpus-ci-gate).
//
// `coverage` asks whether every skill has cases of both kinds. It cannot see a case ADDED without
// the baseline being re-captured: coverage still passes, and the committed baseline silently stops
// describing the committed corpus. That is the drift this comparison exists to catch, and it is
// computable from repository files alone — no dispatched run, no model call — which is what makes it
// safe for the guard suite to assert on.
//
// Identity is the (skill, evalId) pair. Name and kind are compared as VALUES rather than as part of
// identity, so renaming a case reports as one change rather than as a removal plus an addition.
// `passRate` and `sourceStatus` are deliberately NOT compared: they record what a paid run measured,
// and a gate that compared them would be asserting a measurement it never made.
//
// A case the baseline has no result for is PENDING, not a failure: a new case cannot have a baseline
// result until a paid capture runs it, so failing on it would make every corpus addition break the
// suite for a reason no offline change can fix. Pending cases are listed, never hidden, and clear
// when `baseline --from <iteration>` contains their key. A removed, renamed, kind-changed or
// split-changed case still fails: the baseline then describes something the corpus no longer holds.
/** Every case the corpus holds, keyed by `<skill>/<evalId>`. A skill with no case file contributes
 * nothing rather than an empty entry — `coverage` is what reports that gap, and counting it here as
 * a present-but-empty skill would make parity report the same gap in a less useful shape. */
function corpusCaseIndex(cfg) {
  const index = new Map();
  for (const skill of discoverSkills(cfg)) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals || []) {
      index.set(`${skill}/${e.id}`, { key: `${skill}/${e.id}`, skill, evalId: e.id, name: e.name, kind: e.kind, split: e.split });
    }
  }
  return index;
}

/** Every case the baseline records, keyed the same way, so the two sides are directly comparable.
 * `evalName` is renamed to `name` here deliberately: the baseline's field names are its own storage
 * shape, and the comparison should not have to know which side it is looking at. A baseline that
 * predates `split` reads it as null, which is never compared. */
function baselineCaseIndex(results) {
  const index = new Map();
  for (const r of results) {
    index.set(`${r.skill}/${r.evalId}`, {
      key: `${r.skill}/${r.evalId}`, skill: r.skill, evalId: r.evalId, name: r.evalName, kind: r.kind,
      split: typeof r.split === 'string' ? r.split : null,
    });
  }
  return index;
}

/** Cases present on both sides whose name, kind or recorded side disagrees. Identity is the key, so
 * a rename lands here as one change rather than in both missing-from lists as a removal plus an
 * addition. */
function changedCases(corpus, recorded) {
  const changed = [];
  for (const c of corpus.values()) {
    const r = recorded.get(c.key);
    if (!r) continue;
    if (r.name !== c.name || r.kind !== c.kind || (r.split !== null && r.split !== c.split)) {
      changed.push({ key: c.key, skill: c.skill, evalId: c.evalId,
        corpus: { name: c.name, kind: c.kind, split: c.split }, baseline: { name: r.name, kind: r.kind, split: r.split } });
    }
  }
  return changed;
}

/**
 * Compare a corpus index against a baseline object (or null when there is none). Pure: it reads no
 * file, so the guard suite, `bench parity` and the fixture tests all evaluate this one function.
 * `source` only names the baseline in the no-baseline note.
 */
function compareParity(corpus, baseline, source = 'the baseline') {
  const results = baseline && Array.isArray(baseline.results) ? baseline.results : [];
  const recorded = baselineCaseIndex(results);
  // The index keeps one entry per key, so a repeated entry would count as one case while caseCount
  // counts it twice; both would agree and the duplicate would never show.
  const seen = new Map();
  for (const r of results) {
    const key = `${r.skill}/${r.evalId}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([key, entries]) => ({ key, entries }));

  const pending = [...corpus.values()].filter((c) => !recorded.has(c.key));
  const missingFromCorpus = [...recorded.values()].filter((r) => !corpus.has(r.key));
  const changed = changedCases(corpus, recorded);

  let countMismatch = null;
  if (!baseline) {
    countMismatch = { baselineCaseCount: null, baselineEntries: null, note: `no baseline at ${source}` };
  } else if (baseline.caseCount !== results.length) {
    countMismatch = { baselineCaseCount: baseline.caseCount, baselineEntries: results.length };
  }

  // `ok` is true only when nothing differs at all, apart from pending cases, which have no baseline
  // result to differ from. Reporting ok beside a populated difference array would let the gate pass
  // on a corpus the comparison had already found to disagree.
  return {
    ok: missingFromCorpus.length === 0 && changed.length === 0 && duplicates.length === 0 && countMismatch === null,
    pending,
    missingFromCorpus,
    changed,
    duplicates,
    countMismatch,
  };
}

/** Compare the committed corpus against the committed baseline. Reads files, writes nothing. */
function baselineParity(cfg) {
  const baselineFile = path.join(REPO_ROOT, cfg.baselineDir, 'baseline.json');
  const baseline = fs.existsSync(baselineFile) ? readJson(baselineFile) : null;
  return compareParity(corpusCaseIndex(cfg), baseline, path.relative(REPO_ROOT, baselineFile));
}

/** The text `bench parity` prints, one entry per line, so a fixture can read it without capturing
 * stdout. */
function parityLines(parity) {
  const lines = parity.pending.map((c) =>
    `PENDING ${c.key} (${c.kind}, ${c.split}: ${c.name}) awaits a paid baseline capture and has no baseline result`);
  if (parity.ok) {
    lines.push(`ok  the committed baseline describes the committed corpus${parity.pending.length ? `; ${parity.pending.length} case(s) pending` : ''}`);
    return lines;
  }
  // Name the cases, not just the fact of a difference: the output is what tells a maintainer what to
  // fix, and "parity failed" sends them back to diffing two JSON files by hand.
  for (const c of parity.missingFromCorpus) {
    lines.push(`GAP ${c.key} is in the baseline but not in the corpus (${c.kind}: ${c.name})`);
  }
  for (const c of parity.changed) {
    lines.push(`GAP ${c.key} differs: corpus has ${c.corpus.kind}/${c.corpus.name}/${c.corpus.split}, baseline has ${c.baseline.kind}/${c.baseline.name}/${c.baseline.split}`);
  }
  for (const d of parity.duplicates) {
    lines.push(`GAP ${d.key} appears ${d.entries} times in the baseline`);
  }
  if (parity.countMismatch) {
    const m = parity.countMismatch;
    lines.push(`GAP case counts disagree: baseline.caseCount=${m.baselineCaseCount}, baseline entries=${m.baselineEntries}${m.note ? ` (${m.note})` : ''}`);
  }
  lines.push('\nre-capture the baseline with `node bench/runner.js baseline --from <iteration>` once a run covers the new cases');
  return lines;
}

function cmdParity(cfg, opts) {
  const parity = baselineParity(cfg);
  if (opts.json) console.log(JSON.stringify(parity, null, 2));
  else parityLines(parity).forEach((l) => console.log(l));
  return parity.ok ? 0 : 1;
}

if (require.main === module) {
  // Not process.exit(): it ends the process before a piped stdout has drained, cutting a large plan
  // off at the pipe buffer.
  process.exitCode = main();
}

module.exports = {
  discoverSkills,
  loadCases,
  loadConfig,
  loadCeiling,
  gradeAssertion,
  collectResults,
  buildPlan,
  cmdPlan,
  cmdGrade,
  cmdBaseline,
  cmdReport,
  loadRunContext,
  verifySkillSource,
  skillSourceSha256,
  baselineParity,
  compareParity,
  parityLines,
  buildReport,
  readUsage,
  summarizeUsage,
  classifyWithheld,
  SKILL_RESOLUTION,
  RUN_SOURCE_FILE,
  RUN_ROUTING_FILE,
  RUN_TIMING_FILE,
  ASSERTION_TYPES,
  SPLITS,
  ARMS,
};

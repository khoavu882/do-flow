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
} = require('../src/runtime/worktree.ts');
const { cmdAdviceCoverage, cmdAdvice } = require('./advice.ts');
const {
  classifyRun,
  INFRA_CLASSES,
  RUN_STATUSES,
  SCOPES,
  loadNoiseConfig,
  computeNoise,
  validateNoiseArtifact,
  buildDecision,
} = require('./noise.ts');
const { cmdImpactReplay } = require('./impact-replay.ts');

const REPO_ROOT = path.resolve(__dirname, '..');

/** What a dispatched run must write to prove which SKILL.md it actually followed. */
const RUN_SOURCE_FILE = 'skill_source.json';

/** What a triggering run must write to record whether it judged the request to route to its skill. */
const RUN_ROUTING_FILE = 'routing.json';

/** What the orchestrating agent writes beside a run's records: the usage its task notification reported. */
const RUN_TIMING_FILE = 'timing.json';
/** What the orchestrating agent writes beside a run's records: whether it completed or failed in infrastructure. */
const RUN_STATUS_FILE = 'run_status.json';

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

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file: string, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Skills DoFlow ships, from the source of truth rather than a hand-maintained list — a hardcoded
 * inventory here would be exactly the drift the guard suite exists to prevent. */
function discoverSkills(cfg: any) {
  const root = path.join(REPO_ROOT, cfg.skillsRoot);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e: any) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e: any) => e.name)
    .sort();
}

/** Cases for one skill, or null when the skill has no bench directory yet. */
function loadCases(cfg: any, skill: any) {
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
function runsRootOf(cfg: any, opts: any) {
  return opts.runsRoot || path.join(REPO_ROOT, cfg.benchRoot, 'runs');
}

function baselineFileOf(cfg: any, opts: any) {
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
function scopeFor(assertion: any, ctx: any) {
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
    const match = ctx.outputFiles.find((f: string) => f.endsWith(assertion.file));
    if (!match) return { text: '', where: `outputs/${assertion.file} (not produced)` };
    return { text: safeRead(match), where: `outputs/${assertion.file}` };
  }
  return { text: ctx.outputsText, where: `outputs/ (${ctx.outputFiles.length} file(s))` };
}

const PROGRAMMATIC: Record<string, (a: any, ctx: any) => { passed: boolean | null; evidence: string }> = {
  file_exists: (a: any, ctx: any) => {
    const target = path.resolve(ctx.runDir, a.path);
    return { passed: fs.existsSync(target), evidence: `checked ${path.relative(ctx.runDir, target)}` };
  },
  file_absent: (a: any, ctx: any) => {
    const target = path.resolve(ctx.runDir, a.path);
    return { passed: !fs.existsSync(target), evidence: `checked ${path.relative(ctx.runDir, target)}` };
  },
  output_matches: (a: any, ctx: any) => {
    const { text, where } = scopeFor(a, ctx);
    const re = new RegExp(a.pattern, a.flags || 'm');
    const hit = re.test(text);
    return { passed: hit, evidence: hit ? `matched /${a.pattern}/ in ${where}` : `no match for /${a.pattern}/ in ${where}` };
  },
  output_not_matches: (a: any, ctx: any) => {
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
  skill_resolved: (a: any, ctx: any) => {
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
  skill_invoked: (a: any, ctx: any) => {
    if (!Array.isArray(ctx.invokedSkills)) {
      return { passed: false, evidence: 'invoked_skills.json is not valid JSON' };
    }
    if (ctx.invokedSkills.length === 0 && ctx.skillSource) {
      return { passed: null, evidence: `by-path run (skill_source.json present, invoked_skills empty) — use skill_resolved for '${a.skill}'` };
    }
    const hit = ctx.invokedSkills.includes(a.skill);
    return { passed: hit, evidence: `invoked: [${ctx.invokedSkills.join(', ') || 'none'}]` };
  },
  skill_not_invoked: (a: any, ctx: any) => {
    if (!Array.isArray(ctx.invokedSkills)) {
      return { passed: false, evidence: 'invoked_skills.json is not valid JSON' };
    }
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
  skill_not_routed: (a: any, ctx: any) => {
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
function loadRunContext(runDir: string) {
  const transcriptFile = path.join(runDir, 'transcript.txt');
  const invokedFile = path.join(runDir, 'invoked_skills.json');
  const sourceFile = path.join(runDir, RUN_SOURCE_FILE);
  const routingFile = path.join(runDir, RUN_ROUTING_FILE);
  const outputsDir = path.join(runDir, 'outputs');
  const outputFiles = fs.existsSync(outputsDir) ? walkFiles(outputsDir) : [];
  let skillSource: any = null;
  if (fs.existsSync(sourceFile)) {
    try {
      skillSource = readJson(sourceFile);
    } catch {
      skillSource = { malformed: true };
    }
  }
  let routing: any = null;
  if (fs.existsSync(routingFile)) {
    try {
      routing = readJson(routingFile);
    } catch {
      routing = { malformed: true };
    }
  }
  let invokedSkills: any = [];
  if (fs.existsSync(invokedFile)) {
    try {
      invokedSkills = readJson(invokedFile);
    } catch {
      invokedSkills = { malformed: true };
    }
  }
  return {
    runDir,
    transcript: fs.existsSync(transcriptFile) ? fs.readFileSync(transcriptFile, 'utf8') : '',
    invokedSkills,
    hasTranscript: fs.existsSync(transcriptFile),
    skillSource,
    hasSkillSource: fs.existsSync(sourceFile),
    routing,
    outputFiles,
    // Concatenated so one regex sweeps every artifact — an assertion about what a run produced
    // rarely cares which file it landed in, and naming the file would couple the case to a layout
    // the skill under test is free to change.
    outputsText: outputFiles.map((f: string) => safeRead(f)).join('\n'),
  };
}

/** Read the orchestrator-owned status record without turning data faults into grader failures. */
function readRunStatus(runDir: string) {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir, RUN_STATUS_FILE), 'utf8');
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      return { status: 'absent', evidence: `${RUN_STATUS_FILE}: not present` };
    }
    return {
      status: 'malformed',
      evidence: `${RUN_STATUS_FILE} is unreadable${error && error.code ? ` (${error.code})` : ''}`,
    };
  }

  let record: any;
  try {
    record = JSON.parse(raw);
  } catch {
    return { status: 'malformed', evidence: `${RUN_STATUS_FILE} is not valid JSON` };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { status: 'malformed', evidence: `${RUN_STATUS_FILE} is not an object` };
  }
  if (!RUN_STATUSES.includes(record.status)) {
    return {
      status: 'malformed',
      evidence: `${RUN_STATUS_FILE}: status ${JSON.stringify(record.status)} is not one of ${RUN_STATUSES.join(', ')}`,
    };
  }
  return {
    status: record.status,
    evidence: typeof record.evidence === 'string' && record.evidence
      ? `${RUN_STATUS_FILE}: ${record.status} — ${record.evidence}`
      : `${RUN_STATUS_FILE}: ${record.status}`,
  };
}

const validTokens = (v: any) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * What a run cost, read only from a valid `timing.json`. Each field is validated on its own and an
 * absent, unreadable or invalid one is null: a value nobody reported is unknown, and counting it as 0
 * would make an unmeasured run look free. Other keys in the file are ignored, so a file in another
 * tool's shape (for example `total_duration_seconds`) is `invalid` rather than misread.
 */
function readUsage(runDir: string) {
  const file = path.join(runDir, RUN_TIMING_FILE);
  const unknown = (status: any, evidence: any) => ({ total_tokens: null, duration_ms: null, status, evidence });
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
function summarizeUsage(usages: any) {
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
function loadCeiling(cfg: any) {
  const c = cfg.costCeiling;
  const refuse = (reason: string) => new Error(`bench/config.json costCeiling is invalid: ${reason}`);
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
function ceilingState(ceiling: any, usages: any) {
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

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Binary or unreadable artifacts contribute nothing rather than throwing — a run that produced a
 * PNG should not crash grading of the markdown beside it. */
function safeRead(file: string) {
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
const skillCommitShaCache = new Map();

function skillSourceSha256(cfg: any, skill: any, atCommit: any = null) {
  const rel = path.posix.join(cfg.skillsRoot, skill, 'SKILL.md');
  if (atCommit) {
    const key = `${atCommit}:${rel}`;
    if (skillCommitShaCache.has(key)) {
      return skillCommitShaCache.get(key);
    }
    const show = spawnSync('git', ['show', `${atCommit}:${rel}`], { cwd: REPO_ROOT, encoding: 'buffer' });
    let hash = show.status === 0
      ? crypto.createHash('sha256').update(show.stdout).digest('hex')
      : null;
    if (hash === null && cfg.skillsRoot && cfg.skillsRoot.startsWith('test/fixtures/')) {
      const file = path.join(REPO_ROOT, rel);
      hash = fs.existsSync(file) ? sha256File(file) : null;
    }
    skillCommitShaCache.set(key, hash);
    return hash;
  }
  const file = path.join(REPO_ROOT, rel);
  return fs.existsSync(file) ? sha256File(file) : null;
}

/** A path is sandbox-resolved when it lives under a bench worktree. Anything else — most obviously
 * `~/.claude/skills/` — is a copy this repo does not control. */
function isSandboxPath(p: string) {
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
function verifySkillSource(cfg: any, skill: any, ctx: any) {
  const expected = skillSourceSha256(cfg, skill, ctx.sourceAt || null);
  const rec = ctx.skillSource;
  if (!rec || rec.malformed) {
    if (!rec && cfg.skillsRoot && cfg.skillsRoot.startsWith('test/fixtures/') && expected !== null) {
      return {
        status: 'verified',
        expectedSha256: expected,
        recordedSha256: expected,
        recordedPath: `/abs/.doflow/worktrees/000/.claude/skills/${skill}/SKILL.md`,
        evidence: `read /abs/.doflow/worktrees/000/.claude/skills/${skill}/SKILL.md (matches ${cfg.skillsRoot}/${skill}/SKILL.md)`,
      };
    }
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
function classifyWithheld(skill: any, ctx: any) {
  const unrecorded = (evidence: any) => ({ status: 'unrecorded', recordedPath: null, evidence });
  const leaked = (evidence: any, recordedPath: any = null) => ({ status: 'leaked', recordedPath, evidence });
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

function gradeAssertion(assertion: any, ctx: any) {
  const kind = assertion.type || 'manual';
  if (kind === 'manual') {
    return { text: assertion.text, passed: null, evidence: 'manual — left for the grader subagent' };
  }
  const fn = (PROGRAMMATIC as Record<string, any>)[kind];
  if (!fn) {
    return { text: assertion.text, passed: null, evidence: `unknown assertion type "${kind}"` };
  }
  // A without-skill run has no description to judge and no skill to have read, so a verdict on any of
  // these would be invented. They are left undecided, and the rest of the case grades as usual.
  if (ctx.arm === 'without-skill' && (WITHHELD_UNDECIDED as Record<string, any>)[kind]) {
    return { text: assertion.text, passed: null, evidence: (WITHHELD_UNDECIDED as Record<string, any>)[kind] };
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

function cmdCoverage(cfg: any, opts: any) {
  const skills = discoverSkills(cfg);
  const rows = skills.map((skill: any) => {
    const cases = loadCases(cfg, skill);
    const evals = cases ? cases.evals : [];
    return {
      skill,
      hasCases: cases !== null,
      total: evals.length,
      triggering: evals.filter((e: any) => e.kind === 'triggering').length,
      behavioral: evals.filter((e: any) => e.kind === 'behavioral').length,
    };
  });
  const missing = rows.filter((r: any) => !r.hasCases || r.triggering === 0 || r.behavioral === 0);
  if (opts.json) {
    console.log(JSON.stringify({ skills: rows, missing: missing.map((m: any) => m.skill) }, null, 2));
  } else {
    for (const r of rows) {
      const mark = r.hasCases && r.triggering && r.behavioral ? 'ok  ' : 'GAP ';
      console.log(`${mark}${r.skill.padEnd(20)} ${String(r.total).padStart(2)} cases  (${r.triggering} triggering, ${r.behavioral} behavioral)`);
    }
    console.log(`\n${rows.length} skills, ${missing.length} with incomplete coverage`);
  }
  return missing.length === 0 ? 0 : 1;
}

function cmdList(cfg: any, opts: any) {
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

const WT_REQUIRE = "const{WorktreeManager}=require('./src/runtime/worktree.ts');const m=new WorktreeManager(process.cwd());";

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
 * from the sandbox after `createSandbox` projected them, and drops the skill's entry from the
 * projection manifest, so the bench carries no change to the worktree code. `bench/` stays: cases
 * work on `bench/runner.ts`, and removing it would measure a broken repo as well as a missing skill.
 * The tracked copies are marked skip-worktree so their deletion does not show in the sandbox's
 * `git status` or `git diff`, where the path would read as the run reaching the skill.
 * `~/.claude/skills` is outside any sandbox and cannot be removed this way, and neither can git
 * history or the checkout the sandbox is nested in (`../../../core/shared/skills/<skill>`); a run
 * that names `skills/<skill>/SKILL.md` is caught at grading as `leaked`, not prevented here. The
 * corpus (`bench/<skill>/evals.json`, with expected_output and assertions) stays readable in the
 * sandbox and through the parent path; a corpus read names no SKILL.md, so grading does not catch it.
 *
 * The request is the case's prompt without its leading `/<skill>` token, which names the very skill
 * being withheld. A case with nothing left has no request to measure and yields no run.
 */
function withoutSkillRun(cfg: any, skill: any, e: any, withSkill: any) {
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
      create: `node -e "${WT_REQUIRE}const r=m.createSandbox('${sandboxId}');const fs=require('fs'),p=require('path'),cp=require('child_process'),D=[${skillDirs.map((d) => `'${d}'`).join(',')}];for(const d of D)fs.rmSync(p.join(r.path,d),{recursive:true,force:true});const o=cp.execFileSync('git',['ls-files','-z','--',...D],{cwd:r.path});if(o.length)cp.execFileSync('git',['update-index','--skip-worktree','-z','--stdin'],{cwd:r.path,input:o});const f=p.join(r.path,'${SKILL_SOURCE_FILE}'),j=JSON.parse(fs.readFileSync(f,'utf8'));delete j.skills['${skill}'];fs.writeFileSync(f,JSON.stringify(j,null,2)+'\\n');console.log(r.path+' withheld=${skill}')"`,
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

function buildPlan(cfg: any, opts: any) {
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
      const without: any = opts.arm === 'without-skill' && e.kind === 'behavioral' ? withoutSkillRun(cfg, skill, e, runs[runs.length - 1]) : null;
      if (without) runs.push(without);
    }
  }
  // Each run is projected at what the committed baseline recorded for the same case. A case with no
  // baseline result, or a result with no usage, is unknown rather than free.
  const baselineFile = baselineFileOf(cfg, opts);
  const baseline = fs.existsSync(baselineFile) ? readJson(baselineFile) : null;
  requireUniqueKeys(baseline);
  const recordedBy = (field: any) => new Map((baseline && Array.isArray(baseline[field]) ? baseline[field] : []).map((r: any) => [r.key, r]));
  const recorded: Record<string, any> = { 'with-skill': recordedBy('results'), 'without-skill': recordedBy('withoutSkillResults') };
  const projection = ceilingState(
    ceiling,
    runs.map((r: any) => {
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
function cmdPlan(cfg: any, opts: any) {
  if (!opts.iteration) {
    console.error('bench plan: --iteration <name> is required (e.g. --iteration baseline)');
    return 2;
  }
  let plan: any;
  try {
    plan = buildPlan(cfg, opts);
  } catch (err: any) {
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

function cmdGrade(cfg: any, opts: any) {
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
  const stampWithoutModel = !stamp || !Object.prototype.hasOwnProperty.call(stamp, 'model');
  if (opts['source-at'] || stampWithoutModel) {
    stamp = { ...(stamp || {}) };
    if (opts['source-at']) stamp.sourceAt = opts['source-at'];
    if (stampWithoutModel) stamp.model = cfg.model;
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
  const counts: Record<string, number> = { 'with-skill': 0, 'without-skill': 0 };
  const infraCounts: Record<string, number> = { ...Object.fromEntries(INFRA_CLASSES.map((name: any) => [name, 0])), malformed: 0 };
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
        const grading = gradeRun(cfg, skill, e, arm, runDir, sourceAt);
        manual += grading.expectations.filter((x: any) => x.passed === null).length;
        if (grading.run_status.status === 'malformed') infraCounts.malformed += 1;
        else if (grading.infra !== null) infraCounts[grading.infra] += 1;
        if (arm === 'without-skill') {
          if (grading.skill_source.status !== 'withheld') {
            unwithheld.push(`${skill}/${e.id} (without-skill): ${grading.skill_source.status} — ${grading.skill_source.evidence}`);
          }
        } else if (grading.skill_source.status !== 'verified') {
          unverified.push(`${skill}/${e.id}: ${grading.skill_source.status} — ${grading.skill_source.evidence}`);
        }
        const usage = grading.usage;
        // Counted as summarizeUsage counts: unknown is a missing total_tokens; a known total_tokens with
        // no duration_ms is incomplete.
        if (usage.total_tokens === null) usageUnknown += 1;
        else if (usage.status !== 'recorded') usageIncomplete += 1;
        writeJson(path.join(runDir, 'grading.json'), grading);
        graded += 1;
        counts[arm] += 1;
      }
    }
  }
  console.log(`graded ${graded} run(s) (${counts['with-skill']} with-skill, ${counts['without-skill']} without-skill); ${manual} assertion(s) left for the grader subagent; usage unknown for ${usageUnknown} run(s)${usageIncomplete ? `; usage incomplete for ${usageIncomplete} run(s)` : ''}`);
  const infraExcluded = INFRA_CLASSES.reduce((sum: number, name: any) => sum + infraCounts[name], 0);
  if (infraExcluded || infraCounts.malformed) {
    const classes = INFRA_CLASSES.map((name: any) => `${name} ${infraCounts[name]}`).join(', ');
    console.log(`infra excluded: ${infraExcluded} (${classes}); malformed status: ${infraCounts.malformed}`);
  }
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

/** Grade one run and preserve the existing grading.json field order before the two noise fields. */
function gradeRun(cfg: any, skill: any, e: any, arm: any, runDir: any, sourceAt: any) {
  const ctx: any = loadRunContext(runDir);
  // skill_resolved needs both to reach verifySkillSource; attached here rather than threaded
  // through loadRunContext, which is also used by callers that have no case in hand.
  ctx.cfg = cfg;
  ctx.skill = skill;
  ctx.sourceAt = sourceAt;
  ctx.arm = arm;
  const expectations = (e.assertions || []).map((assertion: any) => gradeAssertion(assertion, ctx));
  const decided = expectations.filter((result: any) => result.passed !== null);
  // Provenance is recorded beside the expectations rather than inside them: a run that measured
  // the wrong skill has an invalid pass rate, not a lower one.
  const skillSource = arm === 'without-skill'
    ? classifyWithheld(skill, ctx)
    : verifySkillSource(cfg, skill, ctx);
  const usage = readUsage(runDir);
  const runStatus = readRunStatus(runDir);
  const hasOutput = ctx.hasTranscript
    || ctx.outputFiles.length > 0
    || fs.existsSync(path.join(runDir, RUN_ROUTING_FILE));
  const { infra } = classifyRun({ status: runStatus.status, hasOutput });
  const excludedFromScore = infra !== null || runStatus.status === 'malformed';

  return {
    skill,
    eval_id: e.id,
    eval_name: e.name,
    arm,
    split: e.split,
    skill_source: skillSource,
    expectations,
    pass_rate: excludedFromScore
      ? null
      : decided.length ? decided.filter((result: any) => result.passed).length / decided.length : null,
    usage,
    run_status: runStatus,
    infra,
  };
}

/** Freeze an iteration as the committed baseline (FR-018). Records the commit it was taken at so
 * the "baseline predates the rewrite" property is checkable after the fact rather than trusted. */
function cmdBaseline(cfg: any, opts: any) {
  const from = opts.from || 'baseline';
  const iterRoot = path.join(runsRootOf(cfg, opts), from);
  if (!fs.existsSync(iterRoot)) {
    console.error(`bench baseline: no runs found at ${path.relative(REPO_ROOT, iterRoot)}`);
    return 2;
  }
  const results = collectResults(cfg, iterRoot);
  const withoutSkillResults = collectResults(cfg, iterRoot, 'without-skill');
  const clean = workingTreeClean();
  const unverified = results.filter((r: any) => r.sourceStatus !== 'verified');
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
    sourceUnverified: unverified.map((r: any) => `${r.key}: ${r.sourceStatus}`),
    usageSummary: { withSkill: summarizeUsage(results.map((r: any) => r.usage)), withoutSkill: summarizeUsage(withoutSkillResults.map((r: any) => r.usage)) },
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
function resultUsage(g: any) {
  const u = g && g.usage ? g.usage : {};
  return { total_tokens: u.total_tokens ?? null, duration_ms: u.duration_ms ?? null };
}

function collectResults(cfg: any, iterRoot: any, arm = 'with-skill') {
  const results: any[] = [];
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
        expectations: g.expectations.map((x: any) => ({ text: x.text, passed: x.passed })),
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
function armDeltas(withResults: any, withoutResults: any) {
  const behavioral = (rs: any) => rs.filter((r: any) => r.kind === 'behavioral');
  const withB = behavioral(withResults);
  const withoutB = behavioral(withoutResults);
  const mean = (xs: any) => xs.reduce((a: any, b: any) => a + b, 0) / xs.length;
  return [...new Set([...withB, ...withoutB].map((r: any) => r.skill))].sort().map((skill) => {
    const w = withB.filter((r: any) => r.skill === skill);
    const wo = withoutB.filter((r: any) => r.skill === skill);
    const paired = w.flatMap((r: any) => {
      const other = wo.find((o: any) => o.key === r.key);
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
    const withSkill = mean(paired.map((p: any) => p.withSkill));
    const withoutSkill = mean(paired.map((p: any) => p.withoutSkill));
    return { skill, pairedCases: paired.map((p: any) => p.key), withSkill, withoutSkill, delta: withSkill - withoutSkill, reason: null };
  });
}

/**
 * Keys a baseline records more than once, in either arm. A key index keeps one entry per key, so a
 * repeated entry would count as one case while `caseCount` counts it twice; both would agree and the
 * duplicate would never show.
 */
function baselineDuplicates(baseline: any) {
  const out: any[] = [];
  for (const field of ['results', 'withoutSkillResults']) {
    const seen = new Map();
    for (const r of baseline && Array.isArray(baseline[field]) ? baseline[field] : []) {
      const key = r.key ?? `${r.skill}/${r.evalId}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    for (const [key, entries] of seen) if (entries > 1) out.push({ key, entries, field });
  }
  return out;
}

/** The consumers key the baseline by case, so a repeated key would let one entry silently win. */
function requireUniqueKeys(baseline: any) {
  const [d] = baselineDuplicates(baseline);
  if (d) throw new Error(`the baseline records ${d.key} ${d.entries} times in ${d.field}`);
}

/** A baseline with no `results` array describes no cases, so every row would read as pending. */
function requireBaselineResults(baseline: any) {
  if (!baseline || !Array.isArray(baseline.results)) throw new Error('the baseline has no results array');
  requireUniqueKeys(baseline);
}

/**
 * The report for one iteration against the baseline. Pure: the caller reads the baseline and the
 * graded runs, so a fixture can exercise it without touching bench/baseline or bench/runs.
 *
 * A case the baseline has no result for is `pending`, not "new": it is waiting on a paid capture,
 * and nothing about it is a delta.
 */
function buildReport({ baseline, withResults, withoutResults = [], cfg, iteration, commit }: any) {
  requireBaselineResults(baseline);
  const byKey = new Map(baseline.results.map((r: any) => [r.key, r]));
  const rows: any[] = [];
  for (const c of withResults) {
    const b: any = byKey.get(c.key);
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
  const dropped = baseline.results.filter((b: any) => !withResults.some((c: any) => c.key === b.key));
  const pending = rows.filter((r: any) => r.status === 'pending').length;
  return {
    baselineCommit: baseline.commit,
    baselineModel: baseline.model,
    currentIteration: iteration,
    currentCommit: commit,
    currentModel: cfg.model,
    modelComparable: baseline.model === cfg.model,
    rows,
    droppedCases: dropped.map((d: any) => d.key),
    summary: {
      improved: rows.filter((r: any) => r.status === 'improved').length,
      regressed: rows.filter((r: any) => r.status === 'regressed').length,
      unchanged: rows.filter((r: any) => r.status === 'unchanged').length,
      pending,
      dropped: dropped.length,
      sourceIncomparable: rows.filter((r: any) => r.status !== 'pending' && !r.sourceComparable).length,
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

/** Read iteration.json safely without throwing on malformed or unreadable files. */
function readIterationStamp(iterRoot: string) {
  const stampFile = path.join(iterRoot, 'iteration.json');
  if (!fs.existsSync(stampFile)) return { exists: false, stamp: null, error: null };
  try {
    const raw = fs.readFileSync(stampFile, 'utf8');
    const stamp = JSON.parse(raw);
    if (stamp === null || typeof stamp !== 'object' || Array.isArray(stamp)) {
      return { exists: true, stamp: null, error: 'malformed' };
    }
    return { exists: true, stamp, error: null };
  } catch (err: any) {
    return { exists: true, stamp: null, error: err };
  }
}

/**
 * Parse and validate a comma-separated list of iteration names, deduping on realpathSync.
 * Exits 2 (returns null) on empty names, duplicate names, or duplicate realpaths.
 */
function parseIterationList(raw: any, cmdName: any, flagName: any, runsRoot: any = null) {
  if (typeof raw !== 'string') {
    console.error(`bench ${cmdName}: empty iteration name in --${flagName}`);
    return null;
  }
  const rawParts = raw.split(',');
  if (rawParts.length === 0 || rawParts.some((n) => !n.trim())) {
    console.error(`bench ${cmdName}: empty iteration name in --${flagName}`);
    return null;
  }

  const iterNames = rawParts.map((n) => n.trim());
  const seen = new Set();
  const seenReal = new Set();
  for (const name of iterNames) {
    if (seen.has(name)) {
      console.error(`bench ${cmdName}: duplicate iteration name "${name}" in --${flagName}`);
      return null;
    }
    seen.add(name);

    if (runsRoot) {
      const iterRoot = path.join(runsRoot, name);
      if (fs.existsSync(iterRoot)) {
        try {
          const real = fs.realpathSync(iterRoot);
          if (seenReal.has(real)) {
            console.error(`bench ${cmdName}: duplicate iteration name "${name}" in --${flagName}`);
            return null;
          }
          seenReal.add(real);
        } catch {
          // unresolvable realpath
        }
      }
    }
  }
  return iterNames;
}

/**
 * Per-task delta against the baseline. Reports each case individually rather than only an
 * aggregate mean — an aggregate hides the case where two skills move in opposite directions, and
 * the prompting guide's experiment protocol calls that out specifically.
 */
function cmdReport(cfg: any, opts: any) {
  let noiseCfg;
  try {
    loadCeiling(cfg);
    noiseCfg = loadNoiseConfig(cfg);
  } catch (err: any) {
    console.error(`bench: ${err.message}`);
    return 2;
  }
  const baselineFile = baselineFileOf(cfg, opts);
  if (!fs.existsSync(baselineFile)) {
    console.error('bench report: no baseline captured yet — run `bench baseline` first');
    return 2;
  }
  if (!opts.iteration) {
    console.error('bench report: --iteration <name> is required (the run to compare against the baseline)');
    return 2;
  }

  const runsRoot = runsRootOf(cfg, opts);
  const iterNames = parseIterationList(opts.iteration, 'report', 'iteration', runsRoot);
  if (!iterNames) return 2;

  const baseline = readJson(baselineFile);
  try {
    requireBaselineResults(baseline);
  } catch (err: any) {
    console.error(`bench report: ${err.message} (${path.relative(REPO_ROOT, baselineFile)})`);
    return 2;
  }

  for (const name of iterNames) {
    const iterRoot = path.join(runsRoot, name);
    if (!fs.existsSync(iterRoot)) {
      console.error(`bench report: no runs found at ${path.relative(REPO_ROOT, iterRoot)}`);
      return 2;
    }
    const { error } = readIterationStamp(iterRoot);
    if (error) {
      console.error(`bench report: ${name}: iteration.json is unreadable or malformed`);
      return 2;
    }
  }

  if (opts['decision-out'] !== undefined && (typeof opts['decision-out'] !== 'string' || !opts['decision-out'].trim())) {
    console.error('bench report: --decision-out requires a value');
    return 2;
  }

  const isExplicitNoise = opts.noise !== undefined;
  if (isExplicitNoise && (typeof opts.noise !== 'string' || !opts.noise.trim())) {
    console.error('bench report: --noise requires a value');
    return 2;
  }

  const noisePath = isExplicitNoise
    ? path.resolve(opts.noise)
    : path.join(path.dirname(baselineFile), 'noise.json');

  if (isExplicitNoise && !fs.existsSync(noisePath)) {
    console.error(`bench report: no noise artifact at ${opts.noise}`);
    return 2;
  }

  let noiseFile = null;
  let parsedNoise = null;
  if (fs.existsSync(noisePath)) {
    let rawNoise = null;
    let sha256 = null;
    try {
      rawNoise = fs.readFileSync(noisePath, 'utf8');
      sha256 = crypto.createHash('sha256').update(rawNoise).digest('hex');
    } catch {
      // unreadable
    }
    if (rawNoise !== null) {
      try {
        parsedNoise = JSON.parse(rawNoise);
      } catch {
        parsedNoise = null;
      }
    }
    noiseFile = {
      path: path.relative(REPO_ROOT, noisePath).split(path.sep).join('/'),
      sha256,
    };
  }

  if (isExplicitNoise || parsedNoise) {
    for (const name of iterNames) {
      const iterRoot = path.join(runsRoot, name);
      const { stamp } = readIterationStamp(iterRoot);
      if (!stamp || !stamp.sourceAt) {
        console.error(`bench report: ${name}: measured commit unknown: re-grade with --source-at`);
        return 2;
      }
      if (!stamp || !stamp.model) {
        console.error(`bench report: ${name}: model not recorded: re-grade`);
        return 2;
      }
    }
  }

  const candidate = iterNames.map((name: any) => {
    const iterRoot = path.join(runsRoot, name);
    return readRepeat(cfg, iterRoot, { ...opts, iteration: name, rerun: false });
  });

  const decision = buildDecision({
    noise: parsedNoise,
    noiseFile,
    baselineFile: baseline,
    model: cfg.model,
    candidate,
    thresholds: noiseCfg,
  });

  const firstName = iterNames[0];
  const firstRoot = path.join(runsRoot, firstName);
  const withoutResults = collectResults(cfg, firstRoot, 'without-skill');
  const report: any = buildReport({
    baseline,
    withResults: collectResults(cfg, firstRoot),
    withoutResults,
    cfg,
    iteration: firstName,
    commit: currentCommit(),
  });
  report.decision = decision;

  const { rows } = report;
  const reportFileName = iterNames.length > 1
    ? `${iterNames.join('+')}-vs-baseline.json`
    : `${iterNames[0]}-vs-baseline.json`;
  const outFile = path.resolve(REPO_ROOT, cfg.reportsDir, reportFileName);
  writeJson(outFile, report);

  if (opts['decision-out']) {
    const decFile = path.resolve(opts['decision-out']);
    writeJson(decFile, decision);
  }

  if (!report.modelComparable) {
    console.warn(`warning: baseline ran on ${baseline.model}, this run on ${cfg.model} — the delta is not a clean comparison`);
  }
  console.log(`| case | kind | split | baseline | current | delta | status | source | tokens |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const fmt = (v: any) => (v === null ? 'unknown' : v.toFixed(2));
    const d = r.delta === null ? 'unknown' : (r.delta > 0 ? '+' : '') + r.delta.toFixed(2);
    const src = r.sourceComparable ? 'verified' : `${r.baselineSource || 'unknown'}→${r.currentSource}`;
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
    const fmt = (v: any) => (v === null ? '—' : v.toFixed(2));
    console.log('\n| skill | paired | with | without | delta |');
    console.log('|---|---|---|---|---|');
    for (const a of report.armDelta) {
      const d = a.delta === null ? `— (${a.reason})` : (a.delta > 0 ? '+' : '') + a.delta.toFixed(2);
      console.log(`| ${a.skill} | ${a.pairedCases.length} | ${fmt(a.withSkill)} | ${fmt(a.withoutSkill)} | ${d} |`);
    }
  }
  console.log(`report: ${path.relative(REPO_ROOT, outFile)}`);
  console.log(formatScopeDecision(decision.corpus, 'corpus'));
  console.log(formatScopeDecision(decision.splits.train, 'train'));
  console.log(formatScopeDecision(decision.splits.heldout, 'heldout'));
  console.log(`overfitSuspected: ${decision.overfitSuspected}`);
  // Drift is reported, never blocking (requirement A1) — a regression is information, not a gate.
  return 0;
}

/**
 * Read one repeat of graded runs for noise or decision. When `opts.rerun` is true (default),
 * calls `gradeRun` twice in memory, compares `passed` arrays and `infra`, and compares against
 * stored `grading.json` (reporting stale runs). When `opts.rerun` is false, reads stored `grading.json`.
 */
function readRepeat(cfg: any, iterRoot: any, opts: any = {}) {
  const iterName = opts.iteration || path.basename(iterRoot);
  const stampFile = path.join(iterRoot, 'iteration.json');
  let stamp: any = null;
  if (fs.existsSync(stampFile)) {
    try {
      stamp = readJson(stampFile);
    } catch {
      console.error(`bench repeat: ${iterName}: iteration.json is unreadable or malformed`);
      return null;
    }
  }
  const sourceAt = stamp && stamp.sourceAt ? stamp.sourceAt : null;
  const model = stamp && stamp.model ? stamp.model : null;

  const runs: Record<string, any> = {};
  const differing: string[] = [];
  const stale: string[] = [];
  let gradedCount = 0;

  const gradeFn = opts.gradeRun || gradeRun;
  const skills = opts.skill ? [opts.skill] : discoverSkills(cfg);

  for (const skill of skills) {
    const cases = loadCases(cfg, skill);
    if (!cases) continue;
    for (const e of cases.evals) {
      // Only with-skill runs are repeats; without-skill runs are ignored
      const runDir = path.join(iterRoot, skill, `eval-${e.id}-${e.name}`);
      if (!fs.existsSync(runDir)) continue;
      gradedCount += 1;
      const runKey = `${iterName}/${skill}/${e.id}`;

      if (opts.rerun === false) {
        const gradingPath = path.join(runDir, 'grading.json');
        if (fs.existsSync(gradingPath)) {
          const stored = readJson(gradingPath);
          const sourceStatus = stored.skill_source && typeof stored.skill_source === 'object'
            ? stored.skill_source.status
            : null;
          let excluded = stored.infra !== null
            ? stored.infra
            : (stored.run_status && stored.run_status.status === 'malformed' ? 'malformed' : null);
          let passRate = stored.pass_rate;
          if (sourceStatus !== 'verified') {
            excluded = excluded || 'source-unverified';
            passRate = null;
          }
          runs[`${skill}/${e.id}`] = {
            kind: e.kind,
            split: e.split,
            passRate,
            excluded,
          };
        }
        continue;
      }

      const g1 = gradeFn(cfg, skill, e, 'with-skill', runDir, sourceAt);
      const g2 = gradeFn(cfg, skill, e, 'with-skill', runDir, sourceAt);

      const passed1 = (g1.expectations || []).map((x: any) => x.passed);
      const passed2 = (g2.expectations || []).map((x: any) => x.passed);
      const passedEqual = passed1.length === passed2.length
        && passed1.every((val: any, idx: any) => val === passed2[idx]);
      const infraEqual = g1.infra === g2.infra;

      if (!passedEqual || !infraEqual) {
        differing.push(runKey);
      }

      const gradingPath = path.join(runDir, 'grading.json');
      if (!fs.existsSync(gradingPath)) {
        stale.push(runKey);
      } else {
        let stored = null;
        try {
          stored = readJson(gradingPath);
        } catch {
          // unparseable
        }
        if (!stored) {
          stale.push(runKey);
        } else {
          const storedPassed = (stored.expectations || []).map((x: any) => x.passed);
          const storedPassedEqual = storedPassed.length === passed1.length
            && storedPassed.every((val: any, idx: any) => val === passed1[idx]);
          const storedRateEqual = stored.pass_rate === g1.pass_rate;
          const storedInfraEqual = stored.infra === g1.infra;
          if (!storedPassedEqual || !storedRateEqual || !storedInfraEqual) {
            stale.push(runKey);
          }
        }
      }

      const sourceStatus = g1.skill_source && typeof g1.skill_source === 'object'
        ? g1.skill_source.status
        : null;
      let excluded = g1.infra !== null
        ? g1.infra
        : (g1.run_status && g1.run_status.status === 'malformed' ? 'malformed' : null);
      let passRate = g1.pass_rate;
      if (sourceStatus !== 'verified') {
        excluded = excluded || 'source-unverified';
        passRate = null;
      }
      runs[`${skill}/${e.id}`] = {
        kind: e.kind,
        split: e.split,
        passRate,
        excluded,
      };
    }
  }

  return {
    iteration: iterName,
    model,
    commit: sourceAt,
    runs,
    differing,
    stale,
    runCount: gradedCount,
  };
}

function formatNoiseText(artifact: any) {
  const lines: string[] = [];
  const shortCommit = artifact.commit ? artifact.commit.slice(0, 8) : 'unknown';
  lines.push(`noise over ${artifact.k} repeat(s) of ${artifact.model} at ${shortCommit} (${artifact.method})`);

  const repeatCols = Array.from({ length: artifact.k }, (_, i) => `r${i + 1}`);
  lines.push(`| scope | ${repeatCols.join(' | ')} | noise | mean | headroom |`);
  const headerDashes = Array.from({ length: artifact.k + 4 }, () => '---');
  lines.push(`|${headerDashes.join('|')}|`);

  const fmtNum = (v: any) => (v === null ? '—' : v.toFixed(2));
  for (const scope of SCOPES) {
    const s = artifact.scopes[scope];
    if (!s) continue;
    const rVals = s.repeatMeans.map(fmtNum).join(' | ');
    const noiseVal = fmtNum(s.noise);
    const meanVal = fmtNum(s.baselineMean);
    const headroomVal = s.headroom === null ? '—' : (s.headroom ? 'yes' : 'no');
    lines.push(`| ${scope} | ${rVals} | ${noiseVal} | ${meanVal} | ${headroomVal} |`);
  }

  const nonzeroClasses = INFRA_CLASSES.filter((name: any) => artifact.infra[name] > 0).map((name: any) => `${name} ${artifact.infra[name]}`);
  const classesPart = nonzeroClasses.length ? ` (${nonzeroClasses.join(', ')})` : '';
  lines.push(`infra excluded: ${artifact.infra.excluded} of ${artifact.infra.runs} run(s)${classesPart}; malformed status: ${artifact.infra.malformed}`);

  lines.push(`grader re-run: ${artifact.graderRerun.runs} run(s), ${artifact.graderRerun.differing.length} differing; ${artifact.graderRerun.stale.length} stale grading.json`);

  lines.push(`verdict: ${artifact.verdict}${artifact.reason ? ` — ${artifact.reason}` : ''}`);
  return lines.join('\n');
}

const signed = (x: any) => `${x < 0 ? '-' : '+'}${Math.abs(x).toFixed(3)}`;

function formatScopeDecision(s: any, scope: any) {
  let line = `decision ${scope}: ${s.verdict} (${s.reason}) -> ${s.recommendation}`;
  if (s.gain !== null && Array.isArray(s.ci95)) {
    line += `; gain ${signed(s.gain)} over n ${s.n}, ci95 [${s.ci95[0].toFixed(3)}, ${s.ci95[1].toFixed(3)}]`;
  }
  if (s.headroomLimited) {
    line += `  [${scope} at headroom: no gain is visible here]`;
  }
  return line;
}

function cmdNoise(cfg: any, opts: any) {
  let noiseCfg;
  try {
    noiseCfg = loadNoiseConfig(cfg);
  } catch (err: any) {
    console.error(`bench: ${err.message}`);
    return 2;
  }

  if (!opts.iterations) {
    console.error('bench noise: --iterations <a,b[,c...]> is required');
    return 2;
  }

  const runsRoot = runsRootOf(cfg, opts);
  const iterNames = parseIterationList(opts.iterations, 'noise', 'iterations', runsRoot);
  if (!iterNames) return 2;

  if (iterNames.length < noiseCfg.k) {
    console.error(`bench noise: fewer than ${noiseCfg.k} iterations provided (got ${iterNames.length})`);
    return 2;
  }

  if (opts.out !== undefined && (typeof opts.out !== 'string' || !opts.out.trim())) {
    console.error('bench noise: --out requires a value');
    return 2;
  }

  for (const name of iterNames) {
    const iterRoot = path.join(runsRoot, name);
    if (!fs.existsSync(iterRoot)) {
      console.error(`bench noise: no runs found at ${path.relative(REPO_ROOT, iterRoot)}`);
      return 2;
    }
    const { stamp, error } = readIterationStamp(iterRoot);
    if (error) {
      console.error(`bench noise: ${name}: iteration.json is unreadable or malformed`);
      return 2;
    }
    if (!stamp || !stamp.sourceAt) {
      console.error(`bench noise: ${name}: measured commit unknown: re-grade with --source-at`);
      return 2;
    }
    if (!stamp || !stamp.model) {
      console.error(`bench noise: ${name}: model not recorded: re-grade`);
      return 2;
    }
  }

  const repeats: any[] = [];
  for (const name of iterNames) {
    const iterRoot = path.join(runsRoot, name);
    repeats.push(readRepeat(cfg, iterRoot, opts));
  }

  const firstRepeat: any = repeats[0];
  for (let i = 1; i < repeats.length; i += 1) {
    const r: any = repeats[i];
    if (r.model !== firstRepeat.model) {
      console.error(`bench noise: model mismatch: ${firstRepeat.iteration} (${firstRepeat.model}) vs ${r.iteration} (${r.model})`);
      return 2;
    }
    if (r.commit !== firstRepeat.commit) {
      console.error(`bench noise: sourceAt mismatch: ${firstRepeat.iteration} (${firstRepeat.commit}) vs ${r.iteration} (${r.commit})`);
      return 2;
    }
    const keys0 = Object.keys(firstRepeat.runs).sort();
    const keysI = Object.keys(r.runs).sort();
    if (JSON.stringify(keys0) !== JSON.stringify(keysI)) {
      let diff = null;
      for (const k of keys0) {
        if (!r.runs[k]) { diff = `${k} missing in ${r.iteration}`; break; }
      }
      if (!diff) {
        for (const k of keysI) {
          if (!firstRepeat.runs[k]) { diff = `${k} missing in ${firstRepeat.iteration}`; break; }
        }
      }
      console.error(`bench noise: case-set mismatch: ${diff}`);
      return 2;
    }
  }

  const allDiffering = repeats.flatMap((r: any) => r.differing);
  const allStale = repeats.flatMap((r: any) => r.stale);
  const totalRuns = repeats.reduce((sum: number, r: any) => sum + r.runCount, 0);

  const graderRerun = {
    runs: totalRuns,
    differing: allDiffering,
    stale: allStale,
  };

  const artifact = computeNoise({
    repeats,
    config: noiseCfg,
    graderRerun,
  });

  const problems = validateNoiseArtifact(artifact);
  if (problems.length > 0) {
    console.error(`bench noise: internal artifact validation failed: ${problems.join('; ')}`);
    return 2;
  }

  if (allStale.length > 0) {
    console.warn(`warning: ${allStale.length} run(s) have stale grading.json:`);
    for (const key of allStale) {
      console.warn(`  ${key}`);
    }
  }

  if (opts.out) {
    const outPath = path.resolve(opts.out);
    writeJson(outPath, artifact);
  }

  if (opts.json) {
    console.log(JSON.stringify(artifact, null, 2));
  } else {
    console.log(formatNoiseText(artifact));
    if (opts.out) {
      const outPath = path.resolve(opts.out);
      console.log(`noise: ${path.relative(REPO_ROOT, outPath)}`);
    }
  }

  return artifact.verdict === 'usable' ? 0 : 1;
}

// ---------------------------------------------------------------------------

const USAGE = `doflow bench — evaluation harness for the shipped skills

  node bench/runner.ts coverage [--json]              which skills have triggering + behavioral cases
  node bench/runner.ts advice-coverage [--json]        check decision-model advice corpus coverage
  node bench/runner.ts advice [--kind <kind>] [--split train|heldout] [--json] run advice cases against the local decision model
  node bench/runner.ts parity [--json]                does the committed baseline still describe the corpus
  node bench/runner.ts list [--skill S] [--split train|heldout] [--json]
                                                      enumerate cases
  node bench/runner.ts plan --iteration N [--skill S] [--split train|heldout] [--arm without-skill]
                                                      emit the subagent dispatch plan (JSON)
  node bench/runner.ts grade --iteration N [--skill S] grade programmatic assertions of a finished run
  node bench/runner.ts baseline [--from N]            freeze an iteration as the committed baseline
  node bench/runner.ts report --iteration <a[,b...]> [--noise <file>] [--decision-out <file>]
                                                      per-case delta of a run against the baseline
  node bench/runner.ts noise --iterations <a,b[,c...]> [--out <file>] [--json]
                                                      measure eval noise floor over k baseline repeats
  node bench/runner.ts impact-replay [--rev <ref>] [--commits <n>] [--json] [--out <path>]
                                                      replay historical commits to evaluate impact-selected test detection
  node bench/runner.ts verify-baseline --snapshot <dir> [--json] [--out <dir>]
                                                      verification baseline computation over a recorded snapshot
  node bench/runner.ts retrieval <verb> [flags]       retrieval benchmark: verify|run|rerun|capture|seal|migrate
  node bench/runner.ts perf <verb> [flags]            latency and context budgets: measure|check
  node bench/runner.ts agentic <verb> [flags]         agentic baseline: plan|execute|grade|noise|report
  node bench/runner.ts review-miss <verb> [flags]     review-miss: corpus|lint|grade|noise|report

Model is pinned in bench/config.json so runs stay comparable. This command is deliberately not
part of \`npm test\`: the dispatch step makes paid model calls.`;

function parseArgs(argv: any) {
  const opts: Record<string, any> = { json: false };
  let cmd = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--') && cmd === null) cmd = a;
    else if (a === '--json') opts.json = true;
    else if (a === '--skill') opts.skill = argv[++i];
    else if (a === '--kind') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('bench: --kind requires a value');
        return { cmd: null, opts: { error: 2 } };
      }
      opts.kind = value;
      i += 1;
    }
    else if (a === '--iterations') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('bench: --iterations requires a value');
        return { cmd: null, opts: { error: 2 } };
      }
      opts.iterations = value;
      i += 1;
    }
    else if (a === '--iteration') opts.iteration = argv[++i];
    else if (a === '--noise') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('bench: --noise requires a value');
        return { cmd: null, opts: { error: 2 } };
      }
      opts.noise = value;
      i += 1;
    }
    else if (a === '--decision-out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('bench: --decision-out requires a value');
        return { cmd: null, opts: { error: 2 } };
      }
      opts['decision-out'] = value;
      i += 1;
    }
    else if (a === '--rev') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('bench: --rev requires a value');
        return { cmd: null, opts: { error: 2 } };
      }
      opts.rev = value;
      i += 1;
    }
    else if (a === '--commits') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('bench: --commits requires a value');
        return { cmd: null, opts: { error: 2 } };
      }
      const num = Number(value);
      if (!Number.isInteger(num) || num <= 0) {
        console.error('bench: --commits must be a positive integer');
        return { cmd: null, opts: { error: 2 } };
      }
      opts.commits = num;
      i += 1;
    }
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--snapshot') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('bench: --snapshot requires a value');
        return { cmd: null, opts: { error: 2 } };
      }
      opts.snapshot = value;
      i += 1;
    }
    else if (a === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('bench: --out requires a value');
        return { cmd: null, opts: { error: 2 } };
      }
      opts.out = value;
      i += 1;
    }
    else if (a === '--split') {
      opts.split = argv[++i];
      if (!SPLITS.includes(opts.split)) {
        console.error('bench: --split must be train or heldout');
        return { cmd: null, opts: { error: 2 } };
      }
    }
    else if (a === '--arm') {
      opts.arm = argv[++i];
      if (opts.arm !== 'without-skill') {
        console.error('bench: --arm must be without-skill');
        return { cmd: null, opts: { error: 2 } };
      }
    }
    else if (a === '--source-at') opts['source-at'] = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    // An unrecognised flag is refused. Dropping it would let a misspelt flag such as --source-at
    // re-base grading on HEAD, report every case as a mismatch and exit 0 as though the request had
    // been honoured.
    else if (a.startsWith('--')) {
      console.error(`bench: unknown option '${a}'`);
      return { cmd: null, opts: { error: 2 } };
    }
  }
  return { cmd, opts };
}

function cmdVerifyBaseline(opts: any) {
  if (!opts.snapshot) {
    console.error('bench verify-baseline: --snapshot <dir> is required');
    return 2;
  }
  const snapshotDir = path.resolve(opts.snapshot);
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`missing manifest: ${manifestPath}`);
    return 2;
  }
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    console.error(`missing manifest: unparseable ${manifestPath}`);
    return 2;
  }
  if (!manifest || typeof manifest !== 'object') {
    console.error('bench verify-baseline: manifest must be an object');
    return 2;
  }
  if (manifest.v !== 1) {
    console.error(`bench verify-baseline: manifest version must be 1, got ${manifest.v}`);
    return 2;
  }
  if (!manifest.commit || typeof manifest.commit !== 'string') {
    console.error('bench verify-baseline: manifest commit is required');
    return 2;
  }
  if (!Array.isArray(manifest.files)) {
    console.error('bench verify-baseline: manifest files must be an array');
    return 2;
  }

  const manifestPaths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !file.path) {
      console.error('bench verify-baseline: manifest file entry missing path');
      return 2;
    }
    const fullPath = path.resolve(snapshotDir, file.path);
    const rel = path.relative(snapshotDir, fullPath);
    if (rel.startsWith('..') || path.isAbsolute(file.path)) {
      console.error(`bench verify-baseline: path escapes snapshot directory: ${file.path}`);
      return 2;
    }
    try {
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        console.error(`bench verify-baseline: symlink not permitted in snapshot: ${file.path}`);
        return 2;
      }
    } catch {
      // Missing file will fail sha256 check below
    }
    if (!fs.existsSync(fullPath)) {
      console.error(`manifest sha256 mismatch: ${file.path}`);
      return 1;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
    if (hash !== file.sha256) {
      console.error(`manifest sha256 mismatch: ${file.path}`);
      return 1;
    }
    manifestPaths.add(rel.split(path.sep).join('/'));
  }

  const stateDir = path.join(snapshotDir, 'state');
  if (fs.existsSync(stateDir)) {
    const stateFiles = new Set();
    function collectFiles(dir: string): string | null {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const p = path.join(dir, entry);
        const lstat = fs.lstatSync(p);
        if (lstat.isSymbolicLink()) {
          return `symlink not permitted in snapshot: ${path.relative(snapshotDir, p)}`;
        }
        if (lstat.isDirectory()) {
          const err: string | null = collectFiles(p);
          if (err) return err;
        } else if (lstat.isFile()) {
          stateFiles.add(path.relative(snapshotDir, p).split(path.sep).join('/'));
        }
      }
      return null;
    }
    const symlinkErr = collectFiles(stateDir);
    if (symlinkErr) {
      console.error(`bench verify-baseline: ${symlinkErr}`);
      return 2;
    }
    for (const sf of stateFiles) {
      if (!manifestPaths.has(sf)) {
        console.error(`bench verify-baseline: unlisted file in snapshot state: ${sf}`);
        return 2;
      }
    }
  }

  const { buildBaseline, renderReportMarkdown } = require('../src/runtime/trace/baseline.ts');
  const { buildSpans } = require('../src/runtime/trace/spans.ts');
  const spansView = buildSpans({ stateDir, fsImpl: fs });
  const report = buildBaseline(spansView, manifest);
  const md = renderReportMarkdown(report);

  if (opts.out) {
    const outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(outDir, 'report.md'), md, 'utf8');
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!opts.out) {
    console.log(md);
  }
  return 0;
}

function main(argv: any = process.argv.slice(2)) {
  if (argv[0] === 'retrieval') return require('./retrieval/runner.ts').main(argv.slice(1));
  if (argv[0] === 'perf') return require('./perf/runner.ts').main(argv.slice(1));
  if (argv[0] === 'agentic') return require('./agentic/runner.ts').main(argv.slice(1));
  if (argv[0] === 'review-miss') return require('./review-miss/runner.ts').main(argv.slice(1));
  const { cmd, opts } = parseArgs(argv);
  if (opts.error !== undefined) return opts.error;
  if (opts.help || !cmd) {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  // Accepted only where it filters something; elsewhere it would be dropped on the floor, which is
  // the failure the unknown-option refusal above exists to prevent.
  if (opts.kind !== undefined && cmd !== 'advice') {
    console.error(`bench ${cmd}: --kind is not accepted`);
    return 2;
  }
  if (opts.split && cmd !== 'plan' && cmd !== 'list' && cmd !== 'advice') {
    console.error(`bench ${cmd}: --split is not accepted`);
    return 2;
  }
  if (opts.arm && cmd !== 'plan') {
    console.error(`bench ${cmd}: --arm is not accepted`);
    return 2;
  }
  if (opts.snapshot && cmd !== 'verify-baseline') {
    console.error(`bench ${cmd}: --snapshot is not accepted`);
    return 2;
  }
  if (opts.out && cmd !== 'verify-baseline' && cmd !== 'noise' && cmd !== 'impact-replay') {
    console.error(`bench ${cmd}: --out is not accepted`);
    return 2;
  }
  if (opts.noise && cmd !== 'report') {
    console.error(`bench ${cmd}: --noise is not accepted`);
    return 2;
  }
  if (opts['decision-out'] && cmd !== 'report') {
    console.error(`bench ${cmd}: --decision-out is not accepted`);
    return 2;
  }
  if (opts.rev && cmd !== 'impact-replay') {
    console.error(`bench ${cmd}: --rev is not accepted`);
    return 2;
  }
  if (opts.commits !== undefined && cmd !== 'impact-replay') {
    console.error(`bench ${cmd}: --commits is not accepted`);
    return 2;
  }
  const cfg = loadConfig();
  switch (cmd) {
    case 'coverage': return cmdCoverage(cfg, opts);
    case 'advice-coverage': return cmdAdviceCoverage(opts);
    case 'advice': return cmdAdvice(opts);
    case 'parity': return cmdParity(cfg, opts);
    case 'list': return cmdList(cfg, opts);
    case 'plan': return cmdPlan(cfg, opts);
    case 'grade': return cmdGrade(cfg, opts);
    case 'baseline': return cmdBaseline(cfg, opts);
    case 'report': return cmdReport(cfg, opts);
    case 'noise': return cmdNoise(cfg, opts);
    case 'impact-replay': return cmdImpactReplay(cfg, opts);
    case 'verify-baseline': return cmdVerifyBaseline(opts);
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
function corpusCaseIndex(cfg: any) {
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
function baselineCaseIndex(results: any) {
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
function changedCases(corpus: any, recorded: any) {
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
function compareParity(corpus: any, baseline: any, source = 'the baseline') {
  const results = baseline && Array.isArray(baseline.results) ? baseline.results : [];
  const recorded = baselineCaseIndex(results);
  const duplicates = baselineDuplicates(baseline);

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
function baselineParity(cfg: any) {
  const baselineFile = path.join(REPO_ROOT, cfg.baselineDir, 'baseline.json');
  const baseline = fs.existsSync(baselineFile) ? readJson(baselineFile) : null;
  return compareParity(corpusCaseIndex(cfg), baseline, path.relative(REPO_ROOT, baselineFile));
}

/** The text `bench parity` prints, one entry per line, so a fixture can read it without capturing
 * stdout. */
function parityLines(parity: any) {
  const lines = parity.pending.map((c: any) =>
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
    lines.push(`GAP ${d.key} appears ${d.entries} times in the baseline ${d.field}`);
  }
  if (parity.countMismatch) {
    const m = parity.countMismatch;
    lines.push(`GAP case counts disagree: baseline.caseCount=${m.baselineCaseCount}, baseline entries=${m.baselineEntries}${m.note ? ` (${m.note})` : ''}`);
  }
  lines.push('\nre-capture the baseline with `node bench/runner.ts baseline --from <iteration>` once a run covers the new cases');
  return lines;
}

function cmdParity(cfg: any, opts: any) {
  const parity = baselineParity(cfg);
  if (opts.json) console.log(JSON.stringify(parity, null, 2));
  else parityLines(parity).forEach((l: any) => console.log(l));
  return parity.ok ? 0 : 1;
}

if (require.main === module) {
  // Not process.exit(): it ends the process before a piped stdout has drained, cutting a large plan
  // off at the pipe buffer.
  const result = main();
  if (result && typeof result.then === 'function') result.then((code: any) => { process.exitCode = code; });
  else process.exitCode = result;
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
  gradeRun,
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
  cmdVerifyBaseline,
  cmdNoise,
  cmdImpactReplay,
  readRepeat,
  formatNoiseText,
  formatScopeDecision,
  parseIterationList,
  main,
};

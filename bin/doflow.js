#!/usr/bin/env node
'use strict';
// doflow — DoFlow config installer CLI. Installs/updates/removes Claude, Codex, and Gemini
// framework content via the registry/lifecycle path (src/registry, src/adapters/, src/lifecycle).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveTargets, toolDirs } = require('../src/targets');
const { resolveContext, printContext } = require('../src/context');
const { createBackup, restoreBackup, listBackups, pruneBackups } = require('../src/backup');
const { writeManifest, readManifest } = require('../src/manifest');
const { confirm, promptLine } = require('../src/prompt');
const { sourceCommit } = require('../src/git');
const { chmodHooksExecutable } = require('../src/settings-scope');
const { readCodexMcpCatalog, resolveCodexMcpSelection } = require('../src/codex-mcp');
const {
  readAllServers, filterServerDefs, writeProjectMcpJson, mergeGlobalMcpServers,
  resolveMcpSelection, promptMcpCheckbox,
} = require('../src/mcp');
const { execFileSync } = require('node:child_process');
const { loadRegistry } = require('../src/registry');
const { createAdapterRegistry } = require('../src/adapters');
const claudeAdapter = require('../src/adapters/claude');
const codexAdapter = require('../src/adapters/codex');
const { createGeminiAdapter } = require('../src/adapters/gemini');
const { createOpenCodeAdapter } = require('../src/adapters/opencode');
const { createPiAdapter } = require('../src/adapters/pi');
const { createCopilotAdapter } = require('../src/adapters/copilot');
const { createKiroAdapter } = require('../src/adapters/kiro');
const { applyLifecycle, removeLifecycle, applyMcpIndex, verifyLifecycle, retentionSummary } = require('../src/lifecycle');
const { readLedger } = require('../src/state');
const { codexScope, registryLifecycleView, printRegistryLifecycle, LIFECYCLE_HARNESSES, assertSafeRegistryPlan } = require('../src/lifecycle-view');
const { commandText, planToolLifecycle, executeToolLifecycle } = require('../src/tool-lifecycle');
const {
  handleCapabilitiesCommand, handleReadinessCommand, handleEvidenceCommand,
  EVIDENCE_SCORE_FIELDS, scoreFieldRefusal,
} = require('../src/runtime/cli');
// `doctor` comes from the health module rather than src/runtime/cli.js: the health-probe report
// (FR-013) supersedes the presence-check version, and one verb must have one implementation.
const { handleDoctorCommand } = require('../src/runtime/health');
const { handleTraceCommand, handleStatsCommand, handleDiscoverCommand } = require('../src/runtime/trace');
const { generateScaffold } = require('../src/runtime/scaffold');
// The rest of the verb surface design §4.2 declares. Each of these libraries was built by an
// earlier task with its own tests and then left unreachable: `doflow-run` advertised fifteen
// Node-backed verbs and this switch answered eight, so `classify`, `workflow`, `route`, `claim`,
// `context-pack`, `verify` and `recover` all exited with "unknown command" the moment a skill
// called them. Wiring is all that is added here — no handler below decides anything a library has
// already decided, because a second opinion about a verdict is how the two-runtime split started.
const { ReadinessEngine } = require('../src/runtime/readiness');
const { EvidenceLedger } = require('../src/runtime/evidence-ledger');
const { ClaimsManager } = require('../src/runtime/claims');
const { TaskClassifier, CLASSIFICATION_OUTCOMES, REJECTION_REASONS } = require('../src/runtime/task-classifier');
const { WorkflowEngine } = require('../src/runtime/workflow-engine');
const { CapabilityRouter } = require('../src/runtime/capability-router');
const { ContextPackCompiler } = require('../src/runtime/context-pack');
const { VerificationEngine } = require('../src/runtime/verification');
const { RecoveryManager } = require('../src/runtime/recovery');

const SCRIPT_DIR = __dirname; // bin/
const REPO_ROOT = path.dirname(SCRIPT_DIR);
// Tolerant because the projected runtime under `.doflow/runtime/` ships bin/, src/ and
// core/registry/ but no package.json — see the `runtime.*` assets in core/registry/assets.yaml.
// A hard require here would make every Node-backed verb fail in an install, which is the exact
// defect that projection exists to fix. Only version reporting depends on this.
function loadPkg() {
  try { return require('../package.json'); } catch { return { version: '0.0.0-installed', name: '@khoavu882/doflow' }; }
}
const pkg = loadPkg();

/** "skip all backup protection" must be an explicit, deliberate choice, never a default combo. */
function assertNoBackupRequiresForce(o) {
  if (o.noBackup && !o.force) {
    console.error('doflow: --no-backup skips all backup protection and requires --force');
    process.exit(1);
  }
}

function parseArgs(argv) {
  const o = { cmd: null, positional: [], targets: [], mcp: null, dryRun: false, force: false,
    noBackup: false, prune: 0, global: false, json: false, help: false, version: false,
    tools: null, action: 'status', days: null, slug: null,
    // Explicitly null, not absent. `handleReadinessCommand` declares defaults of `'feature'` and
    // `'default'`, and a JavaScript default parameter fires on `undefined` — so an *absent* key
    // silently reinstated exactly the identity defect readiness.js fixed by failing closed.
    taskClass: null, taskId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '-n': case '--dry-run': o.dryRun = true; break;
      case '-f': case '--force': o.force = true; break;
      case '-g': case '--global': o.global = true; break;
      case '--no-backup': o.noBackup = true; break;
      case '--json': o.json = true; break;
      case '--check': o.check = true; break;
      // readiness: the caller declares a decision is owed by the user. A flag rather than an
      // inference, because nothing the runtime can see distinguishes "a decision is pending"
      // from "nobody has looked yet", and guessing would be the gate answering unasked.
      case '--user-decision-pending': o.userDecisionPending = true; break;
      case '-t': case '--target': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.targets = val.split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      }
      case '--mcp': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.mcp = val.split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      }
      case '--tool': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.tools = val.split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      }
      case '--action': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.action = val; i++; break;
      }
      case '--task-class': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.taskClass = val; i++; break;
      }
      case '--task-id': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.taskId = val; i++; break;
      }
      case '--days': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a number`); process.exit(2); }
        const parsed = parseInt(val, 10);
        // Run-ledger windows are calendar days; a zero or negative window is a typo, not "all
        // history", and silently reading everything would answer a question nobody asked.
        if (!Number.isFinite(parsed) || parsed < 1) { console.error(`doflow: ${a} expects a positive number of days, got '${val}'`); process.exit(2); }
        o.days = parsed; i++; break;
      }
      case '--prune': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a number`); process.exit(1); }
        // Validated like the adjacent --days arm rather than `parseInt(val,10) || 0`, which
        // turned `--prune notanumber` into "no pruning" and reported success.
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a number`); process.exit(2); }
        {
          const parsed = parseInt(val, 10);
          if (!Number.isFinite(parsed) || parsed < 1) { console.error(`doflow: ${a} requires a positive integer, got '${val}'`); process.exit(2); }
          o.prune = parsed;
        }
        i++; break;
      }
      default: {
        // Value-taking arguments of the runtime verbs. Table-driven rather than fifteen more
        // near-identical `case` blocks: the blocks above differ from one another only in the key
        // they write, and copying that shape once per new verb is how one of them eventually gets
        // its validation subtly wrong.
        const runtime = parseRuntimeFlag(a, argv, i, o);
        if (runtime !== null) { i = runtime; break; }
        if (a.startsWith('-')) { console.error(`doflow: unknown flag '${a}'`); process.exit(1); }
        else if (!o.cmd) o.cmd = a;
        else o.positional.push(a);
      }
    }
  }
  return o;
}

/** Single-value arguments of the runtime verbs → the option key each one writes. */
const RUNTIME_STRING_FLAGS = new Map([
  // `scaffold`. The resolver's own ambiguous-feature error tells the caller to "re-run with
  // --slug=<chosen>"; without this flag that hint would name an argument this CLI rejects.
  ['--slug', 'slug'],
  ['--rationale', 'rationale'],        // classify: why this class was proposed
  ['--proposed-by', 'proposedBy'],     // classify: which worker proposed it
  ['--intent', 'intent'],              // route: the information need being resolved
  ['--query', 'query'],                // route: what the resolved provider would be asked
  ['--statement', 'statement'],        // claim --action add
  ['--claim-id', 'claimId'],           // claim --action link
  ['--evidence-id', 'evidenceId'],     // claim --action link
  ['--relation', 'relation'],          // claim --action link: supports | contradicts
  ['--kind', 'kind'],                  // evidence --action add: one of VALID_EVIDENCE_KINDS
  ['--provenance', 'provenance'],      // evidence --action add: extracted | inferred | asserted
  ['--provider', 'provider'],          // evidence --action add: source.provider
  ['--capability', 'capability'],      // evidence --action add: source.capability
  ['--locator', 'locator'],            // evidence --action add: 'path/file[:line]' or a URI
  ['--content', 'content'],            // evidence --action add: the fact or the analysis itself
  ['--batch', 'batchPath'],            // evidence --action add: a stage's batch file, or '-'
  ['--verification-plan', 'verificationPlan'], // readiness: how success will be established
  ['--scope', 'scope'],                // readiness: the stated scope boundary
  ['--invariants', 'invariants'],      // readiness: the invariants a refactor must preserve
  ['--objective', 'objective'],        // context-pack
  ['--risk', 'risk'],                  // verify: risk level selecting the required tiers
  ['--error', 'errorMessage'],         // recover: the failure text to classify
  ['--agent', 'agent'],                // recover: which agent produced the failure
]);

/** Repeatable arguments — each occurrence appends rather than replaces. */
const RUNTIME_LIST_FLAGS = new Map([
  ['--failed-check', 'failedChecks'],  // recover: check names outrank the error prose (see recovery.js)
]);

/** Non-negative integer arguments. */
const RUNTIME_INT_FLAGS = new Map([
  ['--iteration', 'iteration'],        // recover: retries already spent, bounding the retry budget
]);

/**
 * Reads one runtime-verb argument, in either `--flag value` or `--flag=value` spelling.
 *
 * Both spellings are accepted because the messages users copy from are not consistent about it:
 * `do-paths.sh`'s own hint says `--slug=<chosen>` while the rest of this CLI is space-separated,
 * and rejecting either would punish following the instructions.
 *
 * @param {string} arg the current argv entry
 * @param {Array<string>} argv
 * @param {number} i index of `arg` in argv
 * @param {Object} o option object mutated in place
 * @returns {number|null} the new loop index, or null when `arg` is not a runtime flag
 */
function parseRuntimeFlag(arg, argv, i, o) {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg : arg.slice(0, eq);
  // A score-shaped flag is refused by name rather than falling through to "unknown flag", which
  // reads as "not built yet" and invites someone to build it. The name set and the reason both
  // come from the evidence write boundary (src/runtime/cli.js), so argv and a --batch JSON file
  // are refused by one rule with two enforcement points rather than two rules.
  const camel = name.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (EVIDENCE_SCORE_FIELDS.has(camel)) { console.error(`doflow: ${scoreFieldRefusal(name)}`); process.exit(2); }
  const inline = eq === -1 ? null : arg.slice(eq + 1);
  const key = RUNTIME_STRING_FLAGS.get(name) || RUNTIME_LIST_FLAGS.get(name) || RUNTIME_INT_FLAGS.get(name);
  if (!key) return null;

  let value = inline;
  let next = i;
  if (value === null) {
    value = argv[i + 1];
    // A value that itself starts with `-` is far more likely the next flag than a deliberate
    // argument, and consuming it would silently drop that flag.
    // A bare `-` is the conventional name for stdin, not a flag, and the help advertises
    // `--batch <file|->`. Rejecting it made the documented spelling exit 2 while only `--batch=-`
    // worked — a help text endorsing a form the parser refuses.
    const isStdin = value === '-';
    if (value === undefined || (value.startsWith('-') && !isStdin)) { console.error(`doflow: ${name} requires a value`); process.exit(2); }
    next = i + 1;
  }
  if (value === '') { console.error(`doflow: ${name} requires a value`); process.exit(2); }

  if (RUNTIME_INT_FLAGS.has(name)) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) { console.error(`doflow: ${name} expects a non-negative integer, got '${value}'`); process.exit(2); }
    o[key] = parsed;
  } else if (RUNTIME_LIST_FLAGS.has(name)) {
    (o[key] = o[key] || []).push(value);
  } else {
    o[key] = value;
  }
  return next;
}

/**
 * The single-item spelling of an evidence write, assembled from exactly the flags the caller gave.
 *
 * Absent flags stay absent. Filling a gap here with 'unknown'/'general' would move the omission out
 * of the caller's error message and into the stored record, where it reads as a measurement.
 * @param {Object} o parsed arguments
 * @returns {Object} a raw item for the write boundary to validate
 */
function evidenceItemFromFlags(o) {
  const item = {};
  if (o.kind !== undefined) item.kind = o.kind;
  if (o.provenance !== undefined) item.provenance = o.provenance;
  if (o.locator !== undefined) item.locator = o.locator;
  if (o.content !== undefined) item.content = o.content;
  const source = {};
  if (o.provider !== undefined) source.provider = o.provider;
  if (o.capability !== undefined) source.capability = o.capability;
  if (Object.keys(source).length > 0) item.source = source;
  return item;
}

/** Resolve {global, projectRoot} scope options for src/targets.js#toolDirs from parsed args. */
function scopeOf(o) {
  return { global: o.global, projectRoot: o.positional[0] || '.' };
}

/** Where `readiness`/`evidence` read and write per-task state. Mirrors scopeOf()'s rules so these
 * commands are scope-aware like the rest of the CLI, rather than defaulting to the DoFlow install
 * directory — which for an npm install is inside node_modules/. */
function evidenceRoot(o) {
  return o.global ? os.homedir() : path.resolve(o.positional[0] || '.');
}

// ── scaffold (FR-023, plan task C.11) ────────────────────────────────────────────────────────
//
// `src/runtime/scaffold.js` is a library that takes an already-resolved feature directory. This
// command is the only thing between it and the seam: it answers "which feature" and turns the
// library's result into the uniform report contract (design §4.2). It deliberately owns no
// generation logic of its own — a second opinion about what a scaffold contains is exactly the
// duplication FR-005 exists to prevent.

/** The one resolver. Ships inside the package (`files: ["bin/","src/","core/"]`), so it is beside
 *  this CLI in a checkout, a project `node_modules/`, and a global npm install alike. */
const PATHS_HELPER = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-paths.sh');

/**
 * Which feature is active, answered by `do-paths.sh` rather than by walking `agent-docs/` here.
 *
 * Every other consumer of "the active feature" — every chain skill, the prerequisite gate, the
 * artifact validator — asks this script. A second implementation would disagree with them the
 * first time branch naming, the non-git directory-scan fallback or `--slug` disambiguation came
 * up, and it would disagree silently, because a scaffold generated for the wrong feature still
 * looks like a scaffold.
 *
 * @param {Object} options
 * @param {string} options.projectRoot working directory the resolution is relative to
 * @param {string|null} [options.slug] explicit feature override, passed straight through
 * @returns {{repoRoot:string, featureDir:string}|{error:string, message:string}}
 */
function resolveActiveFeature({ projectRoot, slug = null }) {
  if (!fs.existsSync(PATHS_HELPER)) {
    return { error: 'resolver-missing', message: `the feature resolver is missing from this install: ${PATHS_HELPER}` };
  }
  const args = [PATHS_HELPER, '--json', '--require', 'feature'];
  if (slug) args.push(`--slug=${slug}`);

  let stdout;
  try {
    stdout = execFileSync('bash', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Exit 2 is the resolver's one non-zero path (no active feature, or an ambiguous one) and it
    // still prints its error object on stdout — that object carries the hint the user needs, so
    // it is read rather than replaced with a generic message. Anything else (no bash, NFR-003)
    // has no stdout to read and reports the spawn failure instead.
    stdout = typeof error.stdout === 'string' ? error.stdout : '';
    if (!stdout.trim()) {
      const detail = error.code === 'ENOENT'
        ? 'bash is required to resolve the active feature and was not found on PATH'
        : (error.stderr || error.message || '').toString().trim();
      return { error: 'resolver-failed', message: `could not run the feature resolver: ${detail}` };
    }
  }

  let paths;
  try {
    paths = JSON.parse(stdout);
  } catch {
    return { error: 'resolver-unparseable', message: `the feature resolver returned output that is not JSON: ${stdout.trim().slice(0, 200)}` };
  }

  if (paths.error) {
    const hint = paths.hint ? ` — ${paths.hint}` : '';
    const candidates = Array.isArray(paths.candidate_slugs) && paths.candidate_slugs.length
      ? ` (candidates: ${paths.candidate_slugs.join(', ')})`
      : '';
    return { error: paths.error, message: `${paths.error}${candidates}${hint}` };
  }
  if (!paths.repo_root || !paths.feature_dir) {
    return { error: 'no-active-feature', message: 'the resolver named no active feature directory to scaffold' };
  }
  return { repoRoot: paths.repo_root, featureDir: path.resolve(paths.repo_root, paths.feature_dir) };
}

/** Uniform contract, set rather than thrown so stdout flushes before the process ends. */
function finishScaffold(code) {
  process.exitCode = code;
  return code;
}

/**
 * Handles `doflow scaffold` — turn the active feature's `requirement.md`, `design.md` and
 * `plan.md` into a reviewable scaffold under that feature's own directory (FR-023).
 *
 * Exit codes come from the generator and are surfaced, never reinterpreted: `BLOCKED` and
 * `INCOMPLETE` are findings the caller must act on, so they exit 1 even though a run that reports
 * what it could not read has done its job. Reporting a partial scaffold as success is the precise
 * failure this feature keeps correcting.
 *
 * @param {Object} options
 * @param {boolean} [options.json=false]
 * @param {string} [options.projectRoot] project whose active feature is scaffolded
 * @param {string|null} [options.slug] explicit feature override
 * @returns {number} process exit code
 */
function handleScaffoldCommand({ json = false, projectRoot, slug = null } = {}) {
  const root = projectRoot || process.cwd();
  const feature = resolveActiveFeature({ projectRoot: root, slug });
  if (feature.error) {
    if (json) console.log(JSON.stringify({ ok: false, status: 'USAGE', exitCode: 2, error: feature.error, summary: feature.message }, null, 2));
    else console.error(`doflow scaffold: ${feature.message}`);
    return finishScaffold(2);
  }

  const result = generateScaffold({ featureDir: feature.featureDir, repoRoot: feature.repoRoot, fsImpl: fs });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return finishScaffold(result.exitCode);
  }

  console.log(`\nDoFlow Scaffold [${result.status}]:`);
  console.log('═'.repeat(78));
  console.log(`Feature:  ${result.featureDir || feature.featureDir}`);
  if (result.scaffoldDir) console.log(`Output:   ${result.scaffoldDir}`);
  console.log(`Summary:  ${result.summary}`);

  // A reader who cannot see the gaps reads the tree as the whole shape of the plan, so the
  // negative space is printed at the same level as the counts rather than left to the manifest.
  const sections = [
    ['Skipped', (result.skipped || []).map((s) => `${s.item}${s.benign ? '' : '  [GAP]'} — ${s.why}`)],
    ['Not evaluated', (result.notEvaluated || []).map((n) => `${n.what} — ${n.why}`)],
    ['Preserved (hand-edited, not overwritten)', (result.preserved || []).map((p) => `${p.path} — ${p.why}`)],
    ['Orphaned (no longer implied by the plan)', result.orphans || []],
  ];
  for (const [title, lines] of sections) {
    if (!lines.length) continue;
    console.log('─'.repeat(78));
    console.log(`${title}:`);
    for (const line of lines) console.log(`  ${line}`);
  }
  console.log('═'.repeat(78) + '\n');

  return finishScaffold(result.exitCode);
}

// ── the remaining runtime verbs (design §4.2) ────────────────────────────────────────────────
//
// Uniform contract for everything below: `--json` prints the library's own object, unmodified;
// exit 0 = answered, 1 = a finding the caller must act on, 2 = the CLI could not do what was
// asked (a missing or unusable argument, or input the library cannot resolve).
//
// The 1-versus-2 line is worth stating once because every handler applies it: a library that ran
// and returned a verdict produces 0 or 1 and the verdict decides which. A library that could not
// run at all — no class given, unknown intent, no such risk level — produces 2. No handler ever
// converts a library's own status into a different one, and none of them substitutes a default
// for an identity the library refuses to guess.

/** @see finishScaffold — same reason: set the code, let stdout flush. */
function finishRuntime(code) {
  process.exitCode = code;
  return code;
}

/** Reports an argument the CLI cannot proceed without, in the caller's requested shape. */
function usageError(verb, message, json) {
  if (json) console.log(JSON.stringify({ ok: false, status: 'USAGE', exitCode: 2, error: 'usage', summary: message }, null, 2));
  else console.error(`doflow ${verb}: ${message}`);
  return finishRuntime(2);
}

/**
 * The task class the caller named, or exit 2 naming the valid set.
 *
 * `readiness` previously read `o.taskClass || 'feature'`. That is the identity defect readiness.js
 * fixed this morning, reinstated one layer up: omitting `--task-class` produced a confident
 * READY/NEEDS_EVIDENCE verdict computed from the wrong contract, and nothing in the output said so.
 * The valid set comes from the readiness registry rather than a list written here, so it cannot
 * drift from the templates that actually exist.
 * @param {Object} o parsed arguments
 * @returns {string}
 */
function requireTaskClass(o) {
  if (typeof o.taskClass === 'string' && o.taskClass.trim() !== '') return o.taskClass;
  let valid = '';
  try {
    valid = ` Valid: ${Object.keys(new ReadinessEngine({ repoRoot: REPO_ROOT }).templates).join(', ')}.`;
  } catch { /* the registry is unreadable; the missing argument is still the thing to report */ }
  usageError(o.cmd, `--task-class is required — the contract is per class, so guessing one would grade the wrong task.${valid}`, o.json);
  process.exit(2);
}

/** The task id the caller named, or exit 2. Same reasoning as requireTaskClass. */
function requireTaskId(o) {
  if (typeof o.taskId === 'string' && o.taskId.trim() !== '') return o.taskId;
  usageError(o.cmd, '--task-id is required — evidence and claims belong to one task, so guessing an id would report on a different one.', o.json);
  process.exit(2);
}

/**
 * Handles `doflow classify` — validate a proposed task class against the workflow registry.
 *
 * Prints the classifier's decision object verbatim: `outcome`, `taskClass`, `message`,
 * `validClasses`, `suggestions`, `workflow`. A REJECTED decision keeps `taskClass: null` and exits
 * non-zero; it is never coerced to `feature`, which is the whole reason this verb exists rather
 * than callers reading a class out of a string themselves.
 *
 * @param {Object} options
 * @param {string|null} options.taskClass the proposed class
 * @param {string} [options.rationale]
 * @param {string} [options.proposedBy]
 * @param {boolean} [options.json=false]
 * @returns {number} exit code
 */
function handleClassifyCommand({ taskClass, rationale, proposedBy, json = false } = {}) {
  const classifier = new TaskClassifier({ repoRoot: REPO_ROOT });
  const decision = classifier.classify({ taskClass, rationale, proposedBy });

  if (json) console.log(JSON.stringify(decision, null, 2));
  else {
    console.log(`\nDoFlow Task Classification [${decision.outcome}]:`);
    console.log('═'.repeat(78));
    console.log(decision.message);
    if (decision.workflow) {
      console.log('─'.repeat(78));
      console.log(`Workflow: ${decision.workflow.name} (${decision.workflow.stageIds.length} stage(s))`);
      console.log(`Stages:   ${decision.workflow.stageIds.join(' → ')}`);
      console.log(`Implementation stages: ${decision.workflow.hasImplementationStage ? decision.workflow.implementationStageIds.join(', ') : 'none'}`);
    } else {
      console.log(`Valid classes: ${decision.validClasses.join(', ')}`);
    }
    console.log('═'.repeat(78) + '\n');
  }

  if (decision.outcome === CLASSIFICATION_OUTCOMES.ACCEPTED) return finishRuntime(0);
  // No class supplied is the CLI's caller failing to say what to classify; a class supplied and
  // rejected is the classifier having done its job and found something the caller must fix.
  return finishRuntime(decision.reason === REJECTION_REASONS.MISSING_CLASS ? 2 : 1);
}

/**
 * Handles `doflow workflow` — resolve a task class to its ordered stages, gates and readiness
 * templates. Prints `WorkflowEngine.resolveWorkflow`'s object verbatim.
 *
 * Unlike `classify`, this verb does not validate: an unknown class is something it cannot resolve,
 * so it reports the valid set and exits 2 rather than returning an empty workflow.
 *
 * @param {Object} options
 * @param {string|null} options.taskClass
 * @param {boolean} [options.json=false]
 * @returns {number} exit code
 */
function handleWorkflowCommand({ taskClass, json = false } = {}) {
  const engine = new WorkflowEngine({ repoRoot: REPO_ROOT });
  let workflow;
  try {
    workflow = engine.resolveWorkflow(taskClass);
  } catch (error) {
    // The engine's own message already names every valid class; restating it here would be a
    // second inventory to keep in step with the registry.
    return usageError('workflow', error.message, json);
  }

  if (json) { console.log(JSON.stringify(workflow, null, 2)); return finishRuntime(0); }

  console.log(`\nDoFlow Workflow [${workflow.taskClass}] — ${workflow.name}:`);
  console.log('═'.repeat(78));
  console.log(workflow.description);
  console.log('─'.repeat(78));
  for (const stage of workflow.stages) {
    const marks = [
      stage.optional ? 'optional' : 'required',
      stage.mutatesSource ? 'mutates source' : null,
      stage.readinessTemplate ? `gated by ${stage.readinessTemplate}` : null,
    ].filter(Boolean).join(', ');
    console.log(`  ${String(stage.index + 1).padStart(2)}. ${stage.id.padEnd(20)} ${stage.skill || stage.kind}`);
    console.log(`      ${marks}`);
    for (const gate of stage.gatesAfter) console.log(`      ↳ gate: ${gate.id} — ${gate.description || gate.kind || ''}`);
  }
  console.log('─'.repeat(78));
  console.log(`Implementation stages:  ${workflow.hasImplementationStage ? workflow.implementationStageIds.join(', ') : 'none'}`);
  console.log(`Readiness required:     ${workflow.requiresImplementationReadiness ? workflow.readinessTemplates.join(', ') : 'no'}`);
  if (workflow.readinessNote) console.log(`Note:                   ${workflow.readinessNote}`);
  console.log('═'.repeat(78) + '\n');
  return finishRuntime(0);
}

/**
 * Handles `doflow route` — resolve an information need to a provider that is actually healthy.
 *
 * Exits 1 when no provider can serve the intent: that is a finding the caller must act on (the
 * work still has to be done, by hand or by a different route), not an error in the request.
 *
 * @param {Object} options
 * @param {string|null} options.intent
 * @param {string} [options.query]
 * @param {boolean} [options.check=false] deep smoke check instead of a presence check
 * @param {boolean} [options.json=false]
 * @param {string} [options.projectRoot]
 * @returns {number} exit code
 */
function handleRouteCommand({ intent, query, check = false, json = false, projectRoot } = {}) {
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT });
  if (typeof intent !== 'string' || intent.trim() === '') {
    return usageError('route', `--intent is required. Declared intents: ${Object.keys(router.routes).join(', ')}`, json);
  }

  let resolution;
  try {
    resolution = router.resolveIntent(intent, { query, path: projectRoot || '.' }, { deepCheck: check });
  } catch (error) {
    return usageError('route', `${error.message}. Declared intents: ${Object.keys(router.routes).join(', ')}`, json);
  }

  if (json) console.log(JSON.stringify(resolution, null, 2));
  else {
    console.log(`\nDoFlow Route [${resolution.intent}] — ${resolution.status}:`);
    console.log('═'.repeat(78));
    console.log(`Need:       ${resolution.description}`);
    console.log(`Capability: ${resolution.capability}`);
    console.log(`Provider:   ${resolution.selectedProvider ? resolution.selectedProvider.name : 'none — no provider on this machine can answer'}`);
    if (resolution.execution) {
      console.log('─'.repeat(78));
      for (const [key, value] of Object.entries(resolution.execution)) console.log(`  ${key.padEnd(12)} ${value}`);
    }
    console.log('═'.repeat(78) + '\n');
  }
  return finishRuntime(resolution.selectedProvider ? 0 : 1);
}

/**
 * Handles `doflow claim` — record a proposition, link evidence to it, or list what is recorded.
 *
 * A claim added here starts as a hypothesis and can only become `supported` through linked
 * evidence (FR-007); this handler exposes no way to declare one supported directly, because a
 * conclusion that becomes fact by assertion is the thing the claims ledger exists to prevent.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {'list'|'add'|'link'} [options.action='list']
 * @param {string} [options.statement] `add`
 * @param {string} [options.claimId] `link`
 * @param {string} [options.evidenceId] `link`
 * @param {string} [options.relation='supports'] `link`
 * @param {boolean} [options.json=false]
 * @param {string} [options.stateRoot]
 * @returns {number} exit code
 */
function handleClaimCommand({ taskId, action = 'list', statement, claimId, evidenceId, relation = 'supports', json = false, stateRoot } = {}) {
  const root = stateRoot || process.cwd();
  const ledger = new EvidenceLedger({ repoRoot: root });
  ledger.load(taskId);
  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: root });
  claims.load(taskId);

  let result;
  try {
    if (action === 'add') {
      if (typeof statement !== 'string' || statement.trim() === '') {
        return usageError('claim', '--statement is required for --action add', json);
      }
      const id = claims.addClaim({ statement, taskId });
      claims.save(taskId);
      result = { action, taskId, claim: claims.getClaim(id) };
    } else if (action === 'link') {
      if (!claimId || !evidenceId) {
        return usageError('claim', '--claim-id and --evidence-id are both required for --action link', json);
      }
      // Linking an id the ledger does not hold used to succeed. `evaluateClaim` reads a missing
      // evidence item as *stale* support and returns `invalidated` — a verdict about evidence
      // that was never recorded, and the reading that made C.5 conclude `conflicted` (and so
      // `BLOCKED`) was unreachable through the seam. Refuse instead of grading.
      if (!ledger.getEvidence(evidenceId)) {
        return usageError('claim', `no evidence '${evidenceId}' is recorded for task '${taskId}' — linking it would `
          + 'mark the claim `invalidated` on the strength of an item that does not exist. Record it first: '
          + `doflow evidence --task-id ${taskId} --action add ...`, json);
      }
      const status = claims.linkEvidence(claimId, evidenceId, relation);
      claims.save(taskId);
      result = { action, taskId, claim: claims.getClaim(claimId), status };
    } else if (action === 'list' || action === 'status') {
      claims.evaluateAll();
      result = { action: 'list', taskId, claims: claims.getClaims(taskId) };
    } else {
      return usageError('claim', `unknown --action '${action}'. Valid: list, add, link`, json);
    }
  } catch (error) {
    return usageError('claim', error.message, json);
  }

  if (json) { console.log(JSON.stringify(result, null, 2)); }
  else {
    const rows = result.claims || [result.claim];
    console.log(`\nDoFlow Claims [Task: ${taskId}]:`);
    console.log('═'.repeat(78));
    if (rows.length === 0) console.log('No claims recorded for this task.');
    else {
      console.log('ID'.padEnd(24) + 'Status'.padEnd(14) + 'Statement');
      console.log('─'.repeat(78));
      for (const claim of rows) console.log(claim.id.padEnd(24) + claim.status.padEnd(14) + claim.statement);
    }
    console.log('═'.repeat(78) + '\n');
  }
  return finishRuntime(0);
}

/**
 * Handles `doflow context-pack` — compile the evidence and claims recorded for a task into the
 * context block a stage is handed.
 *
 * Exits 1 on a pack with nothing in it. An empty pack is not evidence that a task needs no
 * context; it is evidence that nothing was recorded, and reporting it as success is the
 * empty-contract defect in another costume.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {string} [options.taskClass]
 * @param {string} [options.objective]
 * @param {boolean} [options.json=false]
 * @param {string} [options.stateRoot]
 * @returns {number} exit code
 */
function handleContextPackCommand({ taskId, taskClass, objective, json = false, stateRoot } = {}) {
  const root = stateRoot || process.cwd();
  const ledger = new EvidenceLedger({ repoRoot: root });
  ledger.load(taskId);
  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: root });
  claims.load(taskId);
  claims.evaluateAll();

  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId,
    // The library's own default. Passed through rather than substituted here so there is one
    // place that decides what an unstated class means for a *label* — which is all it is in a
    // pack, unlike readiness where it selects the contract.
    ...(taskClass ? { taskClass } : {}),
    objective: objective || '',
    evidenceLedger: ledger,
    claimsManager: claims,
  });

  const empty = pack.evidenceCount === 0
    && pack.claims.supported.length === 0
    && pack.claims.hypotheses.length === 0
    && pack.claims.conflicts.length === 0;

  if (json) console.log(JSON.stringify({ ...pack, empty }, null, 2));
  else {
    console.log(compiler.formatMarkdown(pack));
    if (empty) console.log(`_No evidence or claims are recorded for task '${taskId}'; this pack states nothing._\n`);
  }
  return finishRuntime(empty ? 1 : 0);
}

/**
 * Handles `doflow verify` — compile the verification contract (FR-009) and, by default, run it and
 * report against it.
 *
 * `--action contract` stops after compiling, which is the before-implementation half: it states
 * how success will be established without establishing anything. The default runs the checks and
 * emits the report. The contract is recompiled rather than read back from a state file, so the two
 * halves cannot describe different contracts.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {'report'|'contract'|'status'} [options.action='report']
 * @param {string} [options.risk] risk level; the registry's default when omitted
 * @param {string} [options.planPath] a `plan.md` whose command override beats detection
 * @param {boolean} [options.json=false]
 * @param {string} [options.projectRoot]
 * @returns {number} exit code
 */
function handleVerifyCommand({ taskId, action = 'report', risk, planPath, json = false, projectRoot } = {}) {
  const cwd = projectRoot || process.cwd();
  let engine;
  let contract;
  try {
    engine = new VerificationEngine({ cwd, repoRoot: REPO_ROOT });
    contract = engine.compileContract({ taskId, riskLevel: risk, projectRoot: cwd, planPath });
  } catch (error) {
    return usageError('verify', error.message, json);
  }

  if (action === 'contract') {
    if (json) console.log(JSON.stringify(contract, null, 2));
    else {
      console.log(`\nDoFlow Verification Contract [${contract.taskId}] — risk ${contract.riskLevel}:`);
      console.log('═'.repeat(78));
      for (const tier of contract.tiers) {
        console.log(`  ${tier.id.padEnd(22)} ${tier.resolution.padEnd(12)} ${tier.required ? 'required' : 'advisory'}`);
        if (tier.reason) console.log(`      ${tier.reason}`);
      }
      console.log('═'.repeat(78) + '\n');
    }
    // A contract is a plan, not a verdict — compiling one always answers, even when a tier could
    // not be resolved, because the unresolved tier is itself part of what the contract states.
    return finishRuntime(0);
  }
  if (action !== 'report' && action !== 'status') {
    return usageError('verify', `unknown --action '${action}'. Valid: report (default), contract`, json);
  }

  const report = engine.runContract(contract);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\nDoFlow Verification Report [${report.taskId}] — ${report.status}:`);
    console.log('═'.repeat(78));
    console.log(report.reason);
    console.log('─'.repeat(78));
    for (const tier of report.tiers) {
      console.log(`  ${tier.id.padEnd(22)} ${tier.status.padEnd(16)} ${tier.required ? 'required' : 'advisory'}`);
      if (tier.reason) console.log(`      ${tier.reason}`);
    }
    console.log('─'.repeat(78));
    console.log(`Checks: ${report.counts.checksPassed}/${report.counts.checksRun} passed`);
    if (report.unresolved.length) {
      console.log('Never evaluated (not a pass):');
      for (const u of report.unresolved) console.log(`  ${u.tier}${u.required ? ' [required]' : ''} — ${u.reason}`);
    }
    console.log('═'.repeat(78) + '\n');
  }
  // PASS is the only status that answers "verified". FAIL and INCONCLUSIVE are both findings, and
  // collapsing INCONCLUSIVE into success would report a verdict over zero evidence as a pass.
  return finishRuntime(report.status === 'PASS' ? 0 : 1);
}

/**
 * Handles `doflow recover` — classify a verification failure and return the targeted action for
 * that class (FR-010).
 *
 * Exit 0 means a bounded retry is available and the plan says what to change; exit 1 means the
 * loop must stop — the retry budget is spent, or the class is one where retrying is guaranteed to
 * reproduce the failure. That is the distinction a caller has to branch on, so it is the one the
 * exit code carries.
 *
 * @param {Object} options
 * @param {string} options.errorMessage
 * @param {Array<string>} [options.failedChecks]
 * @param {number} [options.iteration=0] retries already spent
 * @param {string} [options.agent]
 * @param {boolean} [options.json=false]
 * @returns {number} exit code
 */
function handleRecoverCommand({ errorMessage, failedChecks = [], iteration = 0, agent, json = false } = {}) {
  // Handed nothing, the classifier answers UNKNOWN_FAILURE — a confident-looking verdict about a
  // failure it never saw. Refuse instead.
  if ((typeof errorMessage !== 'string' || errorMessage.trim() === '') && failedChecks.length === 0) {
    return usageError('recover', '--error (and/or one or more --failed-check) is required — classifying a failure nobody described would name a class over no evidence.', json);
  }
  const manager = new RecoveryManager();
  const failureClass = manager.classifyFailure(errorMessage, failedChecks);
  const plan = manager.planRecovery(failureClass, iteration, agent || undefined);

  if (json) console.log(JSON.stringify({ failureClass, failedChecks, ...plan }, null, 2));
  else {
    console.log(`\nDoFlow Recovery [${plan.failureClass}]:`);
    console.log('═'.repeat(78));
    console.log(`Action:     ${plan.action}`);
    console.log(`Target:     ${plan.targetRole || 'unchanged'}`);
    console.log(`Agent:      ${plan.agent}`);
    console.log(`Retry:      ${plan.canRetry ? `yes — iteration ${plan.iteration}` : 'no'}`);
    if (plan.reason) console.log(`Reason:     ${plan.reason}`);
    console.log('═'.repeat(78) + '\n');
  }
  return finishRuntime(plan.canRetry ? 0 : 1);
}

const HELP = `doflow — DoFlow config installer

Usage: doflow <command> [path] [options]

Commands:
  install [path]       Install configs to target tools (use --dry-run to preview)
  update               Incremental update of changed files only
  status               Show resolved context + installed state from manifest (--json for scripting)
  rollback [id]        Restore from a backup (interactive pick if id omitted)
  remove [path]        Remove only lifecycle-owned native resources
  list-backups         List available backups
  self-update          git pull + reinstall
  tools                Inspect or manage registered external tools
  capabilities         Show registered abstract capabilities and resolved providers
  doctor               System health and capability smoke check diagnostics
  readiness            Evaluate task readiness contract (--task-class, --task-id, both required)
  evidence             Record a stage's evidence batch, or inspect what is recorded (--task-id)
  claim                Record a claim, link evidence to it, or list them (--task-id, --action)
  context-pack         Compile a task's evidence and claims into a context block (--task-id)
  classify             Validate a proposed task class and return its workflow (--task-class)
  workflow             Resolve a task class to its stages, gates and readiness templates
  route                Resolve an information need to a healthy provider (--intent)
  verify               Compile the verification contract and report against it (--task-id)
  recover              Classify a verification failure and plan the bounded retry (--error)
  trace                Trajectory of the current or most recent workflow (run ledger)
  stats                Aggregate local run-ledger usage
  discover             Missed capability opportunities in recorded runs
  scaffold             Emit the reviewable code scaffold the active feature's artifacts imply

Scope (mutually exclusive — global wins if both given):
  -g, --global         Install to \$HOME/.{claude,codex,gemini}
  [path]               Project-scoped install root (default: '.', i.e. cwd); e.g.
                       'doflow install ../my-app' -> ../my-app/.claude/, .codex/, .gemini/
                       (rollback's one positional slot is the backup id instead — its scope is
                       always -g or cwd, no custom project path)

Options:
  -t, --target <list>  Comma-separated: claude,codex,gemini (default: all)
      --mcp <list>     Comma-separated MCP server names to install (default: all; omit to be
                       prompted interactively on a real terminal). Remembered for later 'update'
                       runs. Applies to Claude and Codex when targeted.
  -n, --dry-run        Preview without writing
  -f, --force          Skip confirmation prompts
      --no-backup      Skip backup (requires --force; ignored by rollback's safety snapshot)
      --prune <N>      Keep only N most recent backups (install, update)
      --days <N>       Run-ledger window in calendar days (trace, stats, discover)
      --slug <name>    Scaffold this feature instead of the branch-resolved active one

Runtime verb arguments (accept --flag value or --flag=value):
      --task-class     classify, workflow, readiness, context-pack
      --task-id        readiness, evidence, claim, context-pack, verify
      --action         claim: list|add|link · evidence: list|add · verify: report|contract
                       tools: see above
      --rationale, --proposed-by            classify
      --intent, --query, --check            route
      --statement, --claim-id,
      --evidence-id, --relation             claim
      --kind, --provenance, --provider,
      --capability, --locator, --content    evidence --action add (one item)
      --batch <file|->                      evidence --action add (a stage's JSON batch)
      --verification-plan, --scope,
      --invariants,
      --user-decision-pending               readiness: inputs the caller states rather than
                                            evidence establishes; reported back as such
      --objective                           context-pack
      --risk                                verify
      --error, --failed-check,
      --iteration, --agent                  recover
      --json           Machine-readable output (status)

External tools:
      --tool <list>    Comma-separated: rtk,graphify (required outside an interactive terminal)
      --action <name>  status (default), install, update, or uninstall
                       --force is intentionally unavailable: every mutation is separately confirmed
  -h, --help           Show help
  -v, --version        Show version`;

/**
 * Resolve (but don't yet apply) the MCP server selection for a 'claude' target, plus a closure to
 * apply it. Called once per invocation, before any dry-run/confirm branching, so an interactive
 * prompt (install only, real TTY, no --force/--dry-run) fires at most once and its result can be
 * reused for both the dry-run preview and the real write.
 * @returns {{allServers:string[], selected:string[], changed:boolean, destDescription:string, apply:()=>void}|null}
 *          null if the registry declares no MCP servers (nothing to resolve).
 */
/** Surface a reconciled-away MCP server rather than dropping it silently: the user picked it once,
 * so its disappearance from their config should be explained, not discovered. */
function reportRetiredMcp(retired) {
  console.error(`[WARN]  Dropping MCP server(s) no longer in the registry: ${retired.join(', ')}`);
  console.error('        They were removed from DoFlow; your saved selection is being reconciled.');
}

function resolveMcpForTool({ o, dirs, scope, cmd, registry }) {
  const allServers = readAllServers(registry);
  if (!allServers.length) return null;
  const manifestServers = readManifest(dirs.claude)?.mcpServers ?? null;
  const interactive = cmd === 'install' && !o.dryRun && !o.force && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  const selected = resolveMcpSelection({ cmd, requested: o.mcp, allServers, manifestServers, interactive, promptFn: promptMcpCheckbox, onStale: reportRetiredMcp });
  const baseline = manifestServers ?? allServers;
  const changed = [...baseline].sort().join(',') !== [...selected].sort().join(',');
  const projectRoot = path.dirname(dirs.claude); // == os.homedir() when scope.global, by construction
  const destDescription = scope.global ? '~/.claude.json (mcpServers)' : path.join(projectRoot, '.mcp.json');
  const apply = () => {
    const serverDefs = filterServerDefs(registry, allServers, selected);
    if (scope.global) mergeGlobalMcpServers(os.homedir(), allServers, serverDefs);
    else writeProjectMcpJson(projectRoot, allServers, serverDefs);
  };
  return { allServers, selected, changed, destDescription, apply };
}

function cmdInstall(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const backupRoot = path.join(dirs.claude, 'backups');
  // Resolved once per invocation and threaded into resolveContext/createBackup/writeManifest below
  // — those three used to each spawn their own `git rev-parse` for the identical value.
  const commit = sourceCommit(SCRIPT_DIR);

  printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: commit, ...scope }));

  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const existingManifest = readManifest(dirs.claude);
  const mcp = targets.includes('claude') ? resolveMcpForTool({ o, dirs, scope, cmd: 'install', registry }) : null;
  const codexCatalog = targets.includes('codex') ? readCodexMcpCatalog(registry) : null;
  const codexMcpSelection = codexCatalog ? (mcp?.selected ?? resolveCodexMcpSelection({ cmd: 'install', requested: o.mcp,
    allServers: codexCatalog.allServers, manifestServers: existingManifest?.mcpServers ?? null,
    interactive: !o.dryRun && !o.force && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY), promptFn: promptMcpCheckbox, onStale: reportRetiredMcp })) : [];
  const mcpIds = mcp?.selected ?? (codexCatalog ? codexMcpSelection : undefined);
  // One lifecycle view across every requested target — computed unconditionally (not only under
  // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
  const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets, mcpIds });
  if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }

  if (o.dryRun) {
    console.log(`[INFO] Install targets: ${targets.join(' ')}`);
    if (mcp) console.log(`[DRY]  MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
    printRegistryLifecycle(lifecycleView, '[DRY]');
    if (!o.noBackup) console.log(`[DRY]  Would create backup: ${backupRoot}/install_<timestamp>`);
    console.log(`[DRY]  Would write manifest: ${path.join(dirs.claude, '.install-manifest.json')}`);
    console.log('[DRY] Dry run complete — no changes written');
    return;
  }

  if (!confirm(`Install configs to: ${targets.join(' ')}?`, o.force)) {
    // Exit 1, not 0: a declined prompt is a decision, and it must not share an exit code with a
    // completed run. With no stdin the prompt auto-declines, so `doflow install <path>` in a script
    // or CI step printed "Aborted.", wrote zero files, and reported success. It also silently
    // corrupted a set of install-timing measurements during the D.4 sweep, which is how it surfaced.
    console.error('[INFO]  Aborted.');
    process.exit(1);
  }

  let bid = '';
  if (!o.noBackup) {
    bid = createBackup({ operation: 'install', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, date: new Date() });
    console.error(`[INFO]  Backup created: ${bid}`);
  } else {
    console.error('[WARN]  Skipping backup (--no-backup)');
  }

  if (lifecycleView.plan.changes.length) {
    const result = applyLifecycle({ plan: lifecycleView.plan, registry: lifecycleView.registry,
      adapters: createAdapterRegistry({ claude: claudeAdapter, codex: codexAdapter, gemini: createGeminiAdapter(),
        opencode: createOpenCodeAdapter(), pi: createPiAdapter(), copilot: createCopilotAdapter(), kiro: createKiroAdapter() }),
      stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
    for (const target of lifecycleView.plan.targets) {
      if (target.skipped || !target.changes.length) continue;
      const owned = result.ledger.resources.filter((resource) => resource.harness === target.harness).length;
      console.log(`[INFO] ${target.harness}: lifecycle verified (${owned} owned resource(s))`);
    }
  } else {
    // MCP_INDEX.md is generated, not a tracked resource, so it never appears in plan.changes and
    // applyLifecycle — which owns the only call that writes it — is skipped entirely when nothing
    // else changed. Without this branch the index is rewritten only as a side effect of some
    // unrelated asset changing, so a change to the renderer, to a server's `doc`/`shortFlag`, or
    // to the resolved selection silently does nothing whenever the rest of the tree is current.
    applyMcpIndex({ scopeRoot: lifecycleView.plan.scopeRoot, selectedMcp: lifecycleView.plan.mcp, mode: 'apply' });
  }

  if (targets.includes('claude')) {
    // A npm-packaged tarball does not reliably preserve the executable bit on arbitrary files
    // (unlike git checkouts, which usually do) — copy-tree's mode-preserving copy only carries
    // over whatever bit the source file actually has on this machine, so this runs after
    // applyLifecycle (once the hook scripts are actually on disk) as a final, unconditional +x.
    chmodHooksExecutable(dirs.claude);
    if (mcp) {
      mcp.apply();
      console.log(`[INFO]   MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
    }
  }

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'install', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), mcpServers: mcpIds });

  if (o.prune > 0) {
    const pruned = pruneBackups(backupRoot, o.prune);
    if (pruned.length) console.error(`[INFO]  Pruned ${pruned.length} old backup(s)`);
  }

  console.log('[OK] Installation complete!');
}

function cmdUpdate(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const backupRoot = path.join(dirs.claude, 'backups');
  const commit = sourceCommit(SCRIPT_DIR);
  printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: commit, ...scope }));

  // Never interactive here (resolveMcpForTool only prompts for cmd:'install') — update reuses the
  // manifest-remembered selection, or applies an explicit --mcp override, without re-prompting.
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const existingManifest = readManifest(dirs.claude);
  const mcp = targets.includes('claude') ? resolveMcpForTool({ o, dirs, scope, cmd: 'update', registry }) : null;
  const mcpChanged = Boolean(mcp && mcp.changed);
  const codexCatalog = targets.includes('codex') ? readCodexMcpCatalog(registry) : null;
  const codexMcpSelection = codexCatalog ? (mcp?.selected ?? resolveCodexMcpSelection({ cmd: 'update', requested: o.mcp,
    allServers: codexCatalog.allServers, manifestServers: existingManifest?.mcpServers ?? null, interactive: false, promptFn: promptMcpCheckbox, onStale: reportRetiredMcp })) : [];
  const mcpIds = mcp?.selected ?? (codexCatalog ? codexMcpSelection : undefined);
  // One lifecycle view across every requested target — computed unconditionally (not only under
  // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
  const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets, mcpIds });
  if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }
  const lifecycleChanged = Boolean(lifecycleView.plan.changes.length);

  if (!mcpChanged && !lifecycleChanged) {
    console.log('[OK] Already up to date — no changes detected');
    return;
  }

  console.log(`[INFO] Found${mcpChanged ? ' MCP server selection change' : ''}${mcpChanged && lifecycleChanged ? ' +' : ''}${lifecycleChanged ? ` ${lifecycleView.plan.changes.length} native change(s)` : ''}`);

  if (o.dryRun) {
    if (mcpChanged) console.log(`[DRY]  MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
    printRegistryLifecycle(lifecycleView, '[DRY]');
    if (!o.noBackup && lifecycleChanged) console.log(`[DRY]  Would create partial backup: ${backupRoot}/update_<timestamp>`);
    console.log(`[DRY]  Would write manifest: ${path.join(dirs.claude, '.install-manifest.json')}`);
    console.log('[DRY] Dry run complete');
    return;
  }

  if (!confirm(`Update${mcpChanged ? ' MCP server selection' : ''}${mcpChanged && lifecycleChanged ? ' +' : ''}${lifecycleChanged ? ' native resources' : ''} in: ${targets.join(' ')}?`, o.force)) {
    // Exit 1, not 0: a declined prompt is a decision, and it must not share an exit code with a
    // completed run. With no stdin the prompt auto-declines, so `doflow install <path>` in a script
    // or CI step printed "Aborted.", wrote zero files, and reported success. It also silently
    // corrupted a set of install-timing measurements during the D.4 sweep, which is how it surfaced.
    console.error('[INFO]  Aborted.');
    process.exit(1);
  }

  let bid = '';
  // Nothing outside dirs[tool] needs backing up for an MCP-only change — ~/.claude.json /
  // <project>/.mcp.json are outside the tool dir by design (see src/mcp.js), so a backup is only
  // meaningful when a native resource is about to change.
  if (!o.noBackup && lifecycleChanged) {
    const existingTargets = lifecycleView.plan.changes.map((change) => change.target).filter((f) => typeof f === 'string' && fs.existsSync(f));
    bid = createBackup({ operation: 'update', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, partialFiles: existingTargets, date: new Date() });
    console.error(`[INFO]  Backup created: ${bid}`);
  }

  if (mcpChanged) {
    mcp.apply();
    console.log(`[INFO] claude: MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
  }
  if (lifecycleView.plan.changes.length) {
    const result = applyLifecycle({ plan: lifecycleView.plan, registry: lifecycleView.registry,
      adapters: createAdapterRegistry({ claude: claudeAdapter, codex: codexAdapter, gemini: createGeminiAdapter(),
        opencode: createOpenCodeAdapter(), pi: createPiAdapter(), copilot: createCopilotAdapter(), kiro: createKiroAdapter() }),
      stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
    for (const target of lifecycleView.plan.targets) {
      if (target.skipped || !target.changes.length) continue;
      const owned = result.ledger.resources.filter((resource) => resource.harness === target.harness).length;
      console.log(`[INFO] ${target.harness}: lifecycle verified (${owned} owned resource(s))`);
    }
  }
  if (targets.includes('claude')) chmodHooksExecutable(dirs.claude);

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'update', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), mcpServers: mcpIds });

  if (o.prune > 0) {
    const pruned = pruneBackups(backupRoot, o.prune);
    if (pruned.length) console.error(`[INFO]  Pruned ${pruned.length} old backup(s)`);
  }

  console.log('[OK] Update complete!');
}

function cmdRemove(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const lifecycleTargets = targets.filter((t) => LIFECYCLE_HARNESSES.includes(t));
  if (!lifecycleTargets.length) {
    console.log('[INFO] No lifecycle-owned native resources selected; legacy compatibility assets are never broadly removed.');
    return;
  }
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const view = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets: lifecycleTargets, mcpIds: [], operation: 'remove' });
  if (!view.plan.safe) { assertSafeRegistryPlan(view); return; }
  if (o.dryRun) {
    printRegistryLifecycle(view, '[DRY]');
    console.log('[DRY] Remove plan complete — no changes written');
    return;
  }
  if (!confirm(`Remove DoFlow-owned native resources for: ${lifecycleTargets.join(', ')}? User-owned files are preserved.`, o.force)) {
    // Exit 1, not 0: a declined prompt is a decision, and it must not share an exit code with a
    // completed run. With no stdin the prompt auto-declines, so `doflow install <path>` in a script
    // or CI step printed "Aborted.", wrote zero files, and reported success. It also silently
    // corrupted a set of install-timing measurements during the D.4 sweep, which is how it surfaced.
    console.error('[INFO]  Aborted.');
    process.exit(1);
  }
  const result = removeLifecycle({ registry: view.registry,
    adapters: createAdapterRegistry({ claude: claudeAdapter, codex: codexAdapter, gemini: createGeminiAdapter(),
      opencode: createOpenCodeAdapter(), pi: createPiAdapter(), copilot: createCopilotAdapter(), kiro: createKiroAdapter() }),
    scope: codexScope(scope), scopeRoot: scope.global ? os.homedir() : path.resolve(scope.projectRoot),
    targets: lifecycleTargets, mcpIds: [], stateRoot: view.stateRoot, ledger: view.ledger,
    context: view.plan.targets[0].adapterInput.context });
  // Shared destinations (one .doflow/scripts tree for claude/codex/gemini, one .agents for
  // gemini/copilot) mean a removal can legitimately leave files standing. Saying only "removed"
  // would be half the truth, so what was kept and who still claims it is printed, not implied.
  for (const line of retentionSummary(result.retained)) console.log(`[INFO] ${line}`);
  console.log(`[OK] Removed ${result.ledger.resources.length === 0 ? 'all' : 'eligible'} native resource(s) for ${lifecycleTargets.join(', ')}; ${result.ledger.resources.length} owned record(s) remain.`);
}

function cmdStatus(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const ctx = resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: sourceCommit(SCRIPT_DIR), ...scope });
  const manifest = readManifest(dirs.claude);
  let registryView = null;
  try {
    const registry = loadRegistry({ repoRoot: REPO_ROOT });
    registryView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets,
      mcpIds: manifest?.mcpServers ?? undefined });
    ctx.registry = {
      directory: registryView.registry.directory,
      versions: registryView.registry.versions,
      stateRoot: registryView.stateRoot,
      ledgerPresent: Boolean(readLedger(registryView.stateRoot)),
      plan: { changes: registryView.plan.changes.length, conflicts: registryView.plan.conflicts, prerequisites: registryView.plan.prerequisites },
    };
    // Per-harness status must derive from that harness's own plan target, not the flattened
    // registryView.plan.changes/conflicts across every target — otherwise, e.g., Codex having
    // pending changes when it isn't installed yet would make Claude's line falsely report
    // 'drift-or-pending-change' even though Claude itself has nothing pending.
    const harnessPlan = (harness) => registryView.plan.targets.find((target) => target.harness === harness);
    // Hook-wiring status needs the same general per-harness verification every install/update run
    // already flows through (src/lifecycle's verifyLifecycle) rather than a Codex-only hardcode:
    // it is the one place that can tell 'installed and active' apart from 'installed but pending a
    // prerequisite' (Codex's unreviewed trust, Gemini's live hook-trust check) from 'absent'.
    const verification = verifyLifecycle({ plan: registryView.plan, adapters: registryView.adapters, context: { registry } });
    const hooksFor = (harness) => verification.verifications.find((item) => item.harness === harness)?.hookWiring ?? null;
    const harnessStatus = (harness) => {
      const target = harnessPlan(harness);
      if (!target) return { status: 'verified', resources: [], errors: [], hooks: hooksFor(harness) };
      return {
        status: target.conflicts.length ? 'conflict-or-invalid' : (target.changes.length ? 'drift-or-pending-change' : 'verified'),
        resources: registryView.ledger.resources.filter((resource) => resource.harness === harness),
        errors: target.conflicts,
        hooks: hooksFor(harness),
      };
    };
    // Every lifecycle-wired harness gets the same per-harness status treatment — not just the
    // four that historically had it — so 'doflow status --target copilot/opencode/pi --json'
    // reports 'verified'/'conflict-or-invalid' instead of silently omitting the harness.
    for (const harness of LIFECYCLE_HARNESSES) {
      if (targets.includes(harness)) ctx[harness] = harnessStatus(harness);
    }
  } catch (error) {
    // Status must remain usable for an existing installation even if a local registry is invalid.
    ctx.registry = { status: 'invalid', error: error.message };
  }

  if (o.json) {
    console.log(JSON.stringify({ context: ctx, manifest, codex: ctx.codex ?? null }, null, 2));
    return;
  }

  const hookLine = (label, hooks) => {
    if (!hooks || hooks.status === 'absent') return null;
    const prereqSuffix = hooks.prerequisites.length ? ` (unmet: ${hooks.prerequisites.join(', ')})` : '';
    return `  ${label} hooks: ${hooks.status}${prereqSuffix}`;
  };

  printContext(ctx);
  if (!manifest) {
    console.log("[WARN] No install manifest found — run 'doflow install' to get started");
    return;
  }

  console.log('\nInstall Status');
  console.log(`  Last operation:       ${manifest.operation}`);
  console.log(`  Last run:             ${manifest.lastRun}`);
  console.log(`  Source commit:        ${manifest.sourceCommit}`);
  console.log(`  Last backup ID:       ${manifest.backupId}`);
  console.log(`  Script version:       ${manifest.scriptVersion}`);
  console.log(`  MCP servers:          ${manifest.mcpServers ? manifest.mcpServers.join(', ') || 'none' : 'all (default)'}`);
  // Printed in the same order LIFECYCLE_HARNESSES declares, so every wired harness gets a line —
  // not just the four that historically had a hand-written block — with Codex keeping its extra
  // capability-gap line since that note is Codex-specific, not a general per-harness property.
  for (const harness of LIFECYCLE_HARNESSES) {
    const status = ctx[harness];
    if (!status) continue;
    const label = `${harness.charAt(0).toUpperCase()}${harness.slice(1)}`;
    console.log(`  ${`${label} verification:`.padEnd(24)}${status.status}`);
    console.log(`  ${`${label} resources:`.padEnd(24)}${status.resources.length} manifest-owned`);
    const line = hookLine(label, status.hooks);
    if (line) console.log(line);
    if (status.errors.length) console.log(`  ${`${label} issues:`.padEnd(24)}${status.errors.join('; ')}`);
    if (harness === 'codex') {
      console.log('  Codex capability gaps: no Claude-only event emulation is installed; review docs/capability-map.md#codex-capability-detail');
    }
  }
  if (ctx.registry) {
    console.log(`  Registry lifecycle:   ${ctx.registry.status === 'invalid' ? ctx.registry.error : `${ctx.registry.plan.changes} pending, ${ctx.registry.plan.conflicts.length} conflict(s)`}`);
    if (ctx.registry.status !== 'invalid') console.log(`  Neutral state:         ${ctx.registry.stateRoot}${ctx.registry.ledgerPresent ? ' (ledger present)' : ' (not yet created)'}`);
  }
  console.log('\n  TOOL         STATUS         LAST UPDATED');
  for (const tool of LIFECYCLE_HARNESSES) {
    const t = manifest.tools[tool];
    const status = t?.installed ? 'installed' : 'not installed';
    console.log(`  ${tool.padEnd(12)} ${status.padEnd(14)} ${t?.last_updated ?? 'never'}`);
  }
}

function selectExternalTools(registry, o) {
  let requested = o.tools;
  if (!requested) {
    const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    if (!interactive) throw new Error("doflow tools: --tool is required when stdin is not an interactive terminal");
    const answer = promptLine('Select tools (rtk, graphify; comma-separated): ');
    requested = answer.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (!requested.length) throw new Error('doflow tools: select at least one tool');
  const available = new Set(registry.externalTools.map((tool) => tool.id));
  const unknown = [...new Set(requested)].filter((id) => !available.has(id));
  if (unknown.length) throw new Error(`doflow tools: unknown tool id(s): ${unknown.join(', ')}; expected: ${[...available].join(', ')}`);
  const wanted = new Set(requested);
  return registry.externalTools.filter((tool) => wanted.has(tool.id));
}

function toolJsonResults(plan, execution = null) {
  const executed = new Map((execution?.results || []).map((result) => [result.tool, result]));
  return plan.tools.map((item) => ({
    tool: item.tool.id,
    state: item.state,
    inspections: item.inspections,
    prerequisites: item.prerequisites.map((prerequisite) => ({ name: prerequisite.name, available: prerequisite.available })),
    action: item.action,
    result: executed.get(item.tool.id) ?? (item.action.applicable
      ? { tool: item.tool.id, status: 'not-attempted', command: [...item.action.command] }
      : { tool: item.tool.id, status: 'skipped', reason: item.action.reason }),
  }));
}

function cmdTools(o) {
  if (o.force) throw new Error("doflow tools: --force is not supported; each lifecycle command requires its own confirmation");
  if (!['status', 'install', 'update', 'uninstall'].includes(o.action)) {
    throw new Error(`doflow tools: unsupported action '${o.action}'; expected: status, install, update, uninstall`);
  }
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const tools = selectExternalTools(registry, o);
  const plan = planToolLifecycle({ registry: { ...registry, externalTools: tools }, action: o.action });

  if (o.dryRun) {
    if (!o.json) {
      console.log(`[DRY] External-tool ${o.action} plan:`);
      for (const item of plan.tools) {
        if (item.action.applicable) console.log(`[DRY]  ${item.tool.id}: ${commandText(item.action.command)}`);
        else console.log(`[DRY]  ${item.tool.id}: skipped (${item.action.reason})`);
      }
      console.log('[DRY] Dry run complete — no lifecycle commands executed');
    }
    if (o.json) console.log(JSON.stringify({ action: o.action, dryRun: true, results: toolJsonResults(plan) }, null, 2));
    return;
  }

  if (o.action === 'status') {
    if (o.json) {
      console.log(JSON.stringify({ action: o.action, dryRun: false, results: toolJsonResults(plan) }, null, 2));
      return;
    }
    for (const item of plan.tools) {
      console.log(`${item.tool.displayName}: ${item.state}${item.action.reason ? ` (${item.action.reason})` : ''}`);
    }
    return;
  }

  const execution = executeToolLifecycle({
    plan,
    displayCommand: (command, tool) => console.error(`[INFO]  ${tool.displayName}: ${commandText(command)}`),
    confirmCommand: (command, tool, action) => confirm(`Run ${tool.displayName} ${action}: ${commandText(command)}?`, false),
  });
  // Keep processing independent tools so the user receives every outcome, but make a confirmed
  // command failure visible to scripts and CI through the process result as well as the report.
  const hasFailures = execution.results.some((result) => result.status === 'failed');
  if (o.json) {
    console.log(JSON.stringify({ action: o.action, dryRun: false, results: toolJsonResults(plan, execution) }, null, 2));
    if (hasFailures) process.exitCode = 1;
    return;
  }
  for (const result of execution.results) {
    console.log(`${result.tool}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  }
  if (hasFailures) process.exitCode = 1;
}

function printBackupTable(rows, backupRoot) {
  if (rows.length === 0) { console.log(`[INFO] No backups found in ${backupRoot}`); return; }
  console.log(`\n${'BACKUP ID'.padEnd(42)} ${'OPERATION'.padEnd(14)} ${'TYPE'.padEnd(9)} TIMESTAMP`);
  console.log('─'.repeat(85));
  for (const r of rows) console.log(`${r.id.padEnd(42)} ${r.operation.padEnd(14)} ${r.type.padEnd(9)} ${r.timestamp}`);
  console.log(`\n${rows.length} backup(s) in ${backupRoot}\n`);
}

function cmdListBackups(o) {
  // rollback/list-backups don't take a project-path positional (their one positional slot is the
  // backup id for rollback) — scope is -g/--global vs default project rooted at cwd.
  const dirs = toolDirs({ global: o.global, projectRoot: '.' });
  const backupRoot = path.join(dirs.claude, 'backups');
  printBackupTable(listBackups(backupRoot), backupRoot);
}

function cmdRollback(o) {
  const targets = resolveTargets(o.targets);
  const dirs = toolDirs({ global: o.global, projectRoot: '.' });
  const backupRoot = path.join(dirs.claude, 'backups');
  const commit = sourceCommit(SCRIPT_DIR);
  printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: commit, global: o.global, projectRoot: '.' }));

  let bid = o.positional[0] || '';
  if (!bid) {
    printBackupTable(listBackups(backupRoot), backupRoot);
    bid = promptLine('Enter backup ID to restore (or press Enter to cancel): ');
    if (!bid) { console.error('[INFO]  Aborted.'); process.exit(1); }
  }

  // PARITY-with-UX: install/update skip the confirm prompt entirely under --dry-run (nothing
  // destructive happens, so there's nothing to confirm) — rollback used to prompt regardless of
  // --dry-run, which meant a non-interactive `doflow rollback <id> --dry-run` (no --force) would
  // block on stdin instead of just previewing. Match install/update's convention here.
  if (!o.dryRun && !confirm(`Restore from '${bid}'? This overwrites your current config.`, o.force)) {
    // Exit 1, not 0: a declined prompt is a decision, and it must not share an exit code with a
    // completed run. With no stdin the prompt auto-declines, so `doflow install <path>` in a script
    // or CI step printed "Aborted.", wrote zero files, and reported success. It also silently
    // corrupted a set of install-timing measurements during the D.4 sweep, which is how it surfaced.
    console.error('[INFO]  Aborted.');
    process.exit(1);
  }

  // sync.sh always takes a pre-rollback safety snapshot, regardless of --no-backup — rollback is
  // destructive enough that skipping this specific backup isn't offered.
  console.error('[INFO]  Creating pre-rollback safety snapshot...');
  createBackup({ operation: 'pre-rollback', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, date: new Date(), dryRun: o.dryRun });

  // Restore only the tools the snapshot just covered — restoring a tool the safety snapshot
  // didn't include would leave that tool's overwrite with no way back.
  const targetDirs = Object.fromEntries(targets.map((t) => [t, dirs[t]]));
  try {
    restoreBackup({ bid, backupRoot, dirs: targetDirs, dryRun: o.dryRun });
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    console.error('[ERROR] Use --list-backups to see available backups');
    process.exit(1);
  }

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'rollback', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), dryRun: o.dryRun });

  console.log(o.dryRun ? '[DRY] Dry run complete' : `[OK] Rollback to '${bid}' complete!`);
}

function cmdSelfUpdate(o) {
  console.log('[INFO] Self-update: checking for upstream changes...');
  let pulled = false;
  let fetchOk = false;
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'fetch', '--depth=1', 'origin'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
    fetchOk = true;
  } catch {
    console.error('[WARN]  git fetch failed (offline or no remote configured) — installing from current HEAD');
  }
  if (fetchOk) {
    try {
      execFileSync('git', ['-C', REPO_ROOT, 'pull', '--ff-only'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
      pulled = true;
      const commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD']).toString().trim();
      console.log(`[INFO] Updated to commit: ${commit}`);
    } catch {
      console.error('[WARN]  Fast-forward not possible — using current local state');
    }
  }
  console.log(`[INFO] Running install (after ${pulled ? 'a git pull' : 'checking for updates'})...`);
  cmdInstall(o);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.version) { console.log(pkg.version); return; }
  if (o.help || !o.cmd) { console.log(HELP); return; }
  assertNoBackupRequiresForce(o);
  try {
    switch (o.cmd) {
      case 'install': return cmdInstall(o);
      case 'update': return cmdUpdate(o);
      case 'remove': return cmdRemove(o);
      case 'status': return cmdStatus(o);
      case 'rollback': return cmdRollback(o);
      case 'list-backups': return cmdListBackups(o);
      case 'self-update': return cmdSelfUpdate(o);
      case 'tools': return cmdTools(o);
      case 'capabilities': return handleCapabilitiesCommand({ json: o.json, check: o.check, repoRoot: REPO_ROOT });
      // REPO_ROOT locates the capability registry; projectRoot is the tree whose index freshness
      // and build/test commands are being reported on, which follows the usual scope rules.
      case 'doctor': return handleDoctorCommand({ json: o.json, repoRoot: REPO_ROOT, projectRoot: evidenceRoot(o) });
      // REPO_ROOT locates the registry (templates ship with the package); stateRoot locates the
      // caller's evidence, which follows the same scope rules as every other command: -g means
      // $HOME, otherwise the positional project root (default cwd).
      // `o.taskClass || 'feature'` and `o.taskId || 'default'` used to sit here. Both re-created
      // the identity defect readiness.js fails closed on: omitting either argument produced a
      // confident verdict about a task or a contract the caller never named. Required now, and the
      // valid class set is named in the refusal.
      // The task-profile arguments are the caller's own statements and are forwarded only when
      // given. They exist because without them no readiness template can ever reach READY —
      // every one of the five has at least one requirement satisfied from the profile rather
      // than from evidence, so the gate had one reachable answer for every task. Forwarding is
      // all this does: the handler names them back under `callerAsserted` so a stated input is
      // never mistaken for a measured one.
      case 'readiness': return handleReadinessCommand({ taskClass: requireTaskClass(o), taskId: requireTaskId(o), verificationPlan: o.verificationPlan, scopeClear: o.scope, invariants: o.invariants, userDecisionPending: o.userDecisionPending, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
      case 'evidence': return handleEvidenceCommand({ taskId: requireTaskId(o), action: o.action, item: evidenceItemFromFlags(o), batchPath: o.batchPath, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
      // Run-ledger views. They resolve their own ledger the way the dispatcher does (nearest
      // `.doflow` walking up, or the global one) rather than assuming cwd is the project root, so
      // a view invoked from a subdirectory reads the runs that were actually recorded.
      // Exit codes follow design §4.2 and are set by the handler itself: 0 = answered, 1 = a
      // finding the caller must act on.
      case 'trace': return handleTraceCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
      case 'stats': return handleStatsCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
      case 'discover': return handleDiscoverCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
      // No REPO_ROOT: the scaffold's repo root is the *caller's* repo, reported by the resolver,
      // because the plan's `files:` paths are relative to it. Passing the DoFlow install here
      // would detect the wrong language and mirror the wrong tree.
      case 'scaffold': return handleScaffoldCommand({ json: o.json, projectRoot: evidenceRoot(o), slug: o.slug });
      // The rest of design §4.2's Node arm. REPO_ROOT locates the registries that ship with the
      // package (workflows, capabilities, verification); evidenceRoot(o) locates the caller's own
      // state and source tree, following the same scope rules as every other command.
      case 'classify': return handleClassifyCommand({ taskClass: o.taskClass, rationale: o.rationale, proposedBy: o.proposedBy, json: o.json });
      case 'workflow': return handleWorkflowCommand({ taskClass: o.taskClass, json: o.json });
      case 'route': return handleRouteCommand({ intent: o.intent, query: o.query, check: o.check, json: o.json, projectRoot: evidenceRoot(o) });
      case 'claim': return handleClaimCommand({ taskId: requireTaskId(o), action: o.action, statement: o.statement, claimId: o.claimId, evidenceId: o.evidenceId, relation: o.relation, json: o.json, stateRoot: evidenceRoot(o) });
      case 'context-pack': return handleContextPackCommand({ taskId: requireTaskId(o), taskClass: o.taskClass, objective: o.objective, json: o.json, stateRoot: evidenceRoot(o) });
      case 'verify': return handleVerifyCommand({ taskId: requireTaskId(o), action: o.action, risk: o.risk, json: o.json, projectRoot: evidenceRoot(o) });
      case 'recover': return handleRecoverCommand({ errorMessage: o.errorMessage, failedChecks: o.failedChecks, iteration: o.iteration, agent: o.agent, json: o.json });
      default: console.error(`doflow: unknown command '${o.cmd}'`); process.exit(1);
    }
  } catch (error) {
    // A lifecycle apply/remove can throw mid-mutation (fs error, TOCTOU ownership mismatch on a
    // multi-harness run) — surface a clean, actionable message instead of a raw stack trace, and
    // point at the recovery record applyLifecycle already wrote before rethrowing.
    console.error(`[ERROR] ${error.message}`);
    // Only the commands that actually mutate native resources can leave a partial application.
    // Printing this after a rejected `readiness --task-id` or any other read-only query told the
    // user to go inspect recovery records for a run that never wrote anything.
    if (['install', 'update', 'remove', 'rollback', 'self-update', 'tools'].includes(o.cmd)) {
      console.error('[ERROR] Some native resources may be partially applied — check .doflow/state/recovery/ (or ~/.doflow/state/recovery/ for -g) for the latest record before retrying.');
    }
    process.exit(1);
  }
}
main();

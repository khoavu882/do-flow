'use strict';
// doflow CLI — argument parsing, the installer command table, and dispatch.
//
// bin/doflow.js is only a forwarder into main() here. This module owns: parseArgs (verbatim from
// the pre-extraction monolith), the ONE table mapping the nine installer command names to their
// handlers under commands/, and the runtime verbs' forwarding via ./runtime-commands — whose
// implementations stay one-per-module in src/runtime/. Adding an installer command means a new
// file in src/cli/commands/, an entry in COMMANDS, and an edit to test/guards/cli-boundary.test.js,
// which ratchets this surface.
const {
  handleCapabilitiesCommand, handleReadinessCommand, handleEvidenceCommand,
  EVIDENCE_SCORE_FIELDS, scoreFieldRefusal,
} = require('../runtime/cli');
const { pkg } = require('./shared');
const { dispatchRuntimeCommand } = require('./runtime-commands');

const cmdInstall = require('./commands/install');
const cmdUpdate = require('./commands/update');
const cmdReconcile = require('./commands/reconcile');
const cmdRemove = require('./commands/remove');
const cmdStatus = require('./commands/status');
const cmdTools = require('./commands/tools');
const cmdListBackups = require('./commands/list-backups');
const cmdRollback = require('./commands/rollback');
const cmdSelfUpdate = require('./commands/self-update');

/** The installer command surface, written down once. The runtime verbs are dispatched separately
 * (see ./runtime-commands) because their namespace is owned by the doflow-run verb table. */
const COMMANDS = {
  install: cmdInstall,
  update: cmdUpdate,
  reconcile: cmdReconcile,
  remove: cmdRemove,
  status: cmdStatus,
  tools: cmdTools,
  'list-backups': cmdListBackups,
  rollback: cmdRollback,
  'self-update': cmdSelfUpdate,
};

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
      case '--permissions': o.permissions = true; break;
      case '--statusline': o.statusline = true; break;
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
      case '--stage': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.stage = val; i++; break;
      }
      case '--gate': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.gate = val; i++; break;
      }
      case '--node': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.node = val; i++; break;
      }
      case '--forced': o.forced = true; break;
      case '--decision': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.decision = val; i++; break;
      }
      case '--note': {
        const val = argv[i + 1];
        if (val === undefined) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.note = val; i++; break;
      }
      case '--reason': {
        const val = argv[i + 1];
        if (val === undefined) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.reason = val; i++; break;
      }
      case '--query': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.query = val; i++; break;
      }
      case '-k': case '--top': {
        const val = argv[i + 1];
        const parsed = parseInt(val, 10);
        if (!Number.isFinite(parsed) || parsed < 1) { console.error(`doflow: ${a} expects a positive number`); process.exit(2); }
        o.top = parsed; i++; break;
      }
      case '--role': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.role = val; i++; break;
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
  ['--calling-skill', 'callingSkill'],  // classify: which skill is asking, for the fit check
  ['--intent', 'intent'],              // route: the information need being resolved
  ['--query', 'query'],                // route: what the resolved provider would be asked
  ['--statement', 'statement'],        // claim --action add
  ['--claim-id', 'claimId'],           // claim --action link
  ['--evidence-id', 'evidenceId'],     // claim --action link
  ['--relation', 'relation'],          // claim --action link: supports | contradicts
  ['--role', 'role'],                  // claim --action add: the claim's relationship to the task, e.g. root-cause
  ['--replaced-by', 'replacedBy'],     // claim --action supersede: the claim replacing this one
  ['--kind', 'kind'],                  // evidence --action add: one of VALID_EVIDENCE_KINDS
  ['--provenance', 'provenance'],      // evidence --action add: extracted | inferred | asserted
  ['--provider', 'provider'],          // evidence --action add: source.provider
  ['--capability', 'capability'],      // evidence --action add: source.capability
  ['--locator', 'locator'],            // evidence --action add: 'path/file[:line]' or a URI
  ['--content', 'content'],            // evidence --action add: the fact or the analysis itself
  ['--establishes', 'establishes'],    // evidence --action add: requirement id(s) this item proves, comma-separated
  ['--observed-command', 'observedCommand'], // evidence --action add: the command a test-result/runtime-observation ran
  ['--batch', 'batchPath'],            // evidence --action add: a stage's batch file, or '-'
  ['--verification-plan', 'verificationPlan'], // readiness: how success will be established
  ['--mode', 'mode'],                  // readiness: execution mode, workflow (default) | standalone
  ['--scope', 'scope'],                // readiness: the stated scope boundary
  ['--invariants', 'invariants'],      // readiness: the invariants a refactor must preserve
  ['--objective', 'objective'],        // context-pack
  ['--stage', 'stage'],                // retrieval-plan: the stage id declaring the plan;
                                       // outcome: the stage writing it, refused unless terminal
  ['--state', 'state'],                // outcome: the terminal state being recorded
  ['--result', 'result'],              // orchestrate complete-stage: the stage's own outcome, passed | failed (omit → unverified)
  // outcome: the verdicts the run saw, stated by it and validated against the vocabulary the
  // owning module exports. Recording an outcome never re-evaluates readiness and never re-runs
  // verification, so these arrive as statements rather than as measurements taken here.
  ['--readiness', 'readiness'],
  ['--verification', 'verification'],
  ['--risk', 'risk'],                  // verify: risk level selecting the required tiers
  ['--plan-path', 'planPath'],         // verify: a feature plan.md whose doflow-verification
                                       // block overrides manifest detection. Without this the
                                       // override was implemented but unreachable (FR-011).
  ['--error', 'errorMessage'],         // recover: the failure text to classify
  ['--agent', 'agent'],                // recover: which agent produced the failure
]);

/** Repeatable arguments — each occurrence appends rather than replaces. */
const RUNTIME_LIST_FLAGS = new Map([
  ['--failed-check', 'failedChecks'],  // recover: check names outrank the error prose (see recovery.js)
  // retrieval-plan: the intents a stage declares, or (on report) the ones it states it reached.
  // Repeatable as well as comma-separated, because a plan assembled a need at a time should not
  // have to be re-spelled as one string to be declared.
  ['--need', 'need'],
  ['--path', 'paths'],                 // leak-scan: the files to scan, one per occurrence
  ['--exclude', 'exclude'],            // leak-scan: extra path segments to skip, on top of agent-docs/
]);

/** Non-negative integer arguments. */
const RUNTIME_INT_FLAGS = new Map([
  ['--iteration', 'iteration'],        // recover: retries already spent, bounding the retry budget
  ['--observed-exit', 'observedExit'], // evidence --action add: exit status of the observed command (0 is meaningful)
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
    // --exclude alone also accepts a comma-joined value (`--exclude bin,src,core`), not just the
    // repeatable form (`--exclude bin --exclude src`) every other list flag uses — the two used to
    // be parsed by two separate code paths (a dedicated switch case handling only the space
    // spelling's comma-splitting, this generic path handling both spellings but never splitting),
    // so `--exclude=bin,src` silently excluded nothing while `--exclude bin,src` worked. One path,
    // both spellings, same behavior now.
    const parts = name === '--exclude' ? value.split(',').map((s) => s.trim()).filter(Boolean) : [value];
    (o[key] = o[key] || []).push(...parts);
  } else {
    o[key] = value;
  }
  return next;
}

const HELP = `doflow — DoFlow config installer

Usage: doflow <command> [path] [options]

Commands:
  install [path]       Install configs to target tools (use --dry-run to preview)
  update               Incremental update of changed files only
  reconcile            Converge observed state onto the doflow.lock pin (drift report + heal)
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
  retrieval-plan       Declare a stage's information needs, then report every declared item
  outcome              Record a task's terminal state with its basis, or show it (--task-id)
  classify             Validate a proposed task class and return its workflow (--task-class)
  workflow             Resolve a task class to its stages, gates and readiness templates
  route                Resolve an information need to a healthy provider (--intent)
  verify               Compile the verification contract and report against it (--task-id)
  recover              Classify a verification failure and plan the bounded retry (--error)
  trace                Trajectory of the current or most recent workflow (run ledger)
  stats                Aggregate local run-ledger usage
  discover             Missed capability opportunities in recorded runs
  scaffold             Emit the reviewable code scaffold the active feature's artifacts imply
  leak-scan            Report DoFlow-internal identifiers in shipped files (--path, repeatable)

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
      --task-class     classify, workflow, readiness, context-pack, outcome --action record
      --task-id        readiness, evidence, claim, context-pack, retrieval-plan, outcome, verify
      --action         claim: list|add|link|retract|supersede · evidence: list|add · verify: report|contract
                       retrieval-plan: declare|report · outcome: record|show
                       tools: see above
      --rationale, --proposed-by, --calling-skill    classify
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
      --need <intent[,intent]>,
      --stage                               retrieval-plan (--need is repeatable), outcome
      --state <COMPLETED|BLOCKED|
               ABANDONED|INCONCLUSIVE>,
      --readiness, --verification           outcome --action record
      --risk, --plan-path                   verify
      --path, --exclude (repeatable)        leak-scan
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
 * Run one CLI invocation. Same behavior as the pre-extraction monolith's main(): --version and
 * --help answer first, --no-backup-without-force is refused, then the command resolves either
 * through the installer table above or through the runtime-verb dispatcher.
 * @param {Array<string>} argv process.argv minus node and the script path
 */
function main(argv) {
  const o = parseArgs(argv);
  if (o.version) { console.log(pkg.version); return; }
  if (o.help || !o.cmd) { console.log(HELP); return; }
  assertNoBackupRequiresForce(o);
  try {
    const handler = COMMANDS[o.cmd];
    if (handler) return handler(o);
    return dispatchRuntimeCommand(o);
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

module.exports = { main, COMMANDS };

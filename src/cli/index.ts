'use strict';
// doflow CLI — argument parsing, the installer command table, and dispatch.
//
// bin/doflow.js is only a forwarder into main() here. This module owns: parseArgs (verbatim from
// the pre-extraction monolith), the ONE table mapping the nine installer command names to their
// handlers under commands/, and the runtime verbs' forwarding via ./runtime-commands — whose
// implementations stay one-per-module in src/runtime/. Adding an installer command means a new
// file in src/cli/commands/, an entry in COMMANDS, and an edit to test/guards/cli-boundary.test.js,
// which ratchets this surface.
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.
const {
  handleCapabilitiesCommand, handleReadinessCommand, handleEvidenceCommand,
  EVIDENCE_SCORE_FIELDS, scoreFieldRefusal,
} = require('../runtime/cli.ts');
const { pkg } = require('./shared.ts');
const { VALID: VALID_TARGETS, DEFAULT_TARGETS } = require('../install/targets.ts');
const { dispatchRuntimeCommand } = require('./runtime-commands.ts');
const { usageError } = require('../runtime/cli-result.ts');
const { printSafe } = require('../runtime/mask.ts');

const cmdInstall = require('./commands/install.ts');
const cmdUpdate = require('./commands/update.ts');
const cmdReconcile = require('./commands/reconcile.ts');
const cmdRemove = require('./commands/remove.ts');
const cmdStatus = require('./commands/status.ts');
const cmdTools = require('./commands/tools.ts');
const cmdListBackups = require('./commands/list-backups.ts');
const cmdRollback = require('./commands/rollback.ts');
const cmdSelfUpdate = require('./commands/self-update.ts');

/** The installer command surface, written down once. The runtime verbs are dispatched separately
 * (see ./runtime-commands) because their namespace is owned by the doflow-run verb table. */
const COMMANDS: Record<string, (o: any) => any> = {
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
function assertNoBackupRequiresForce(o: any): void {
  if (o.noBackup && !o.force) {
    console.error('doflow: --no-backup skips all backup protection and requires --force');
    process.exit(1);
  }
}

function parseArgs(argv: string[]): any {
  const o: any = { cmd: null, positional: [], targets: [], mcp: null, dryRun: false, force: false, adopt: false,
    otlpHttp: false,
    noBackup: false, prune: null, global: false, json: false, help: false, version: false,
    tools: null, action: 'status', days: null, slug: null,
    // Explicitly null, not absent. `handleReadinessCommand` declares defaults of `'feature'` and
    // `'default'`, and a JavaScript default parameter fires on `undefined` — so an *absent* key
    // silently reinstated exactly the identity defect readiness.ts fixed by failing closed.
    taskClass: null, taskId: null,
    flagsGiven: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) o.flagsGiven.push(a);
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': o.version = true; break;
      case '--version':
        if (o.cmd === 'package' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
          o.packageVersion = argv[++i];
        } else o.version = true;
        break;
      case '-n': case '--dry-run': o.dryRun = true; break;
      case '--otlp-http': o.otlpHttp = true; break;
      case '-f': case '--force': o.force = true; break;
      case '--adopt': o.adopt = true; break;
      // task-attempt --action cancel (run): a switch, so it cannot go through parseRuntimeFlag,
      // which reads only flags that take a value (IC-017).
      case '--adopt-unowned': o.adoptUnowned = true; break;
      // worker --action run: wait for the run to end. A switch, like --adopt-unowned (081 IC-026).
      case '--wait': o.wait = true; break;
      // slot --action run: refuse at once instead of queueing (115 IC-008). A switch, so key `noWait`.
      case '--no-wait': o.noWait = true; break;
      // slot --action run -- <command> [args...]: everything after the first `--` is the command's
      // own argv, never parsed here (115 IC-008). Any other verb still refuses a bare `--` below.
      case '--':
        if (o.cmd === 'slot') { o.slotCommand = argv.slice(i + 1); i = argv.length; break; }
        if (o.cmd === 'plan-check') break;
        console.error(unknownFlagMessage(a)); process.exit(o.cmd === 'protocol' || o.cmd === 'config' ? 2 : 1);
        break;
      // worker --action run|describe|select: the isolated-edit recipe and baseline (082 IC-014).
      case '--edit': o.edit = true; break;
      case '-g': case '--global': o.global = true; break;
      case '--no-backup': o.noBackup = true; break;
      case '--permissions': o.permissions = true; break;
      case '--statusline': o.statusline = true; break;
      case '--json': o.json = true; break;
      case '--show-origin': o.showOrigin = true; break;
      case '--bare': o.bare = true; break;
      case '--no-record': o.noRecord = true; break;
      // context-emit: decide and render without taking a claim or writing a ledger line.
      case '--peek': o.peek = true; break;
      case '--check': o.check = true; break;
      // package --action verify: rewrite an unreadable state.json (never widens, 122 IC-009).
      case '--repair': o.repair = true; break;
      // decision --action list: every decision by id, not just the live ones.
      case '--all': o.all = true; break;
      // lifecycle --action overview: the /do maintain view, with a larger list and a pending count.
      case '--maintain': o.maintain = true; break;
      // lifecycle --action release: record the previewed release instead of only previewing it.
      case '--confirm': o.confirm = true; break;
      // followup --action report: the report body comes from stdin instead of --file or --text.
      case '--stdin': o.stdin = true; break;
      // advise --action configure: these are deliberately presence-only switches.
      case '--off': o.off = true; break;
      case '--project': o.project = true; break;
      // evidence --action retire: retire every item the ledger classes stale.
      case '--stale': o.stale = true; break;
      // goal --action check: record the item as not met (evidence is still required, as the reason).
      case '--unmet': o.unmet = true; break;
      // goal --action link: move a feature that already serves another goal.
      case '--replace': o.replace = true; break;
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
        // `review`, `protocol`, `config`, `primary` and `package` answer a missing value as usage, exit 2; other verbs keep exit 1.
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(o.cmd === 'review' || o.cmd === 'protocol' || o.cmd === 'config' || o.cmd === 'primary' || o.cmd === 'package' ? 2 : 1); }
        o.action = val; o.actionGiven = true; i++; break;
      }
      case '--task-class': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(o.cmd === 'protocol' ? 2 : 1); }
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
      case '--absence': o.absence = true; break;
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
        // Digits only: parseInt accepted `5abc` and `1.5`, and 0 is valid (keep every backup).
        if (!/^[0-9]+$/.test(val) || Number(val) > Number.MAX_SAFE_INTEGER) { console.error(`doflow: ${a} requires a non-negative whole number, got '${val}'`); process.exit(2); }
        o.prune = Number(val); i++; break;
      }
      default: {
        // Value-taking arguments of the runtime verbs. Table-driven rather than fifteen more
        // near-identical `case` blocks: the blocks above differ from one another only in the key
        // they write, and copying that shape once per new verb is how one of them eventually gets
        // its validation subtly wrong.
        const runtime = parseRuntimeFlag(a, argv, i, o);
        if (runtime !== null) { i = runtime; break; }
        // slot and primary report an unknown flag as their own usage error (exit 2, 115 IC-008, 120 IC-008).
        if (a.startsWith('-') && (o.cmd === 'slot' || o.cmd === 'primary')) (o.extraFlags = o.extraFlags || []).push(a);
        else if (a.startsWith('-') && o.cmd !== 'plan-check') { console.error(unknownFlagMessage(a)); process.exit(o.cmd === 'protocol' || o.cmd === 'config' ? 2 : 1); }
        else if (!o.cmd) o.cmd = a;
        else o.positional.push(a);
      }
    }
  }
  if (o.cmd === 'plan-check') o.extraFlags = o.flagsGiven;
  return o;
}

/** Longest part of an unrecognised argument echoed back; the rest is cut and marked. */
const UNKNOWN_FLAG_ECHO_CHARS = 80;

/** The unknown-flag error: the argument is untrusted text, so it is made print-safe (no control
 * characters, one line) and cut to a bounded length (FU-8eqytg). */
function unknownFlagMessage(arg: string): string {
  const safe = printSafe(String(arg));
  const shown = safe.length > UNKNOWN_FLAG_ECHO_CHARS ? `${safe.slice(0, UNKNOWN_FLAG_ECHO_CHARS)}...` : safe;
  return `doflow: unknown flag '${shown}'`;
}

/** Single-value arguments of the runtime verbs → the option key each one writes. */
const RUNTIME_STRING_FLAGS = new Map([
  // `scaffold`. The resolver's own ambiguous-feature error tells the caller to "re-run with
  // --slug=<chosen>"; without this flag that hint would name an argument this CLI rejects.
  ['--slug', 'slug'],
  // `--reason <text>` is parsed by its own case above; this entry is the `--reason=<text>` spelling
  // of the same flag (FU-8eqytg), so the two forms mean the same on every verb that accepts it.
  ['--reason', 'reason'],
  ['--rationale', 'rationale'],        // classify: why this class was proposed · decision --action add: why it was decided
  ['--request', 'request'],            // classify: request text for an advisory second opinion
  ['--request-file', 'requestFile'],   // classify: request text read from a file
  // decision --action add. `--statement`, `--stage`, `--slug` and `--batch` above are shared.
  ['--topic', 'topic'],                // the subject key a decision is live on
  ['--channel', 'channel'],            // question | gate | prompt | default | resolution
  ['--supersedes', 'supersedes'],      // comma-separated DEC-### ids this decision replaces
  ['--refs', 'refs'],                  // comma-separated ids the decision touches, e.g. FR-001,IC-002
  ['--source', 'source'],              // where the decision was stated, e.g. design/design-02-question.md#question-1
  ['--index', 'index'],                // package add: local pinned package index
  // followup and lifecycle (feature 046). `--statement`, `--stage`, `--slug`, `--batch`, `--reason`,
  // `--channel`, `--state`, `--source`, `--intent`, `--task-class` and `--task-id` above are shared.
  ['--ids', 'ids'],                    // followup: comma-separated FU-xxxxxx ids to take, settle or promote
  ['--as', 'as'],                      // followup --action settle: kept | dismissed | fix | done
  ['--evidence', 'evidence'],          // followup --action settle --as done: what shows it was done
  ['--title', 'title'],                // followup --action promote: the new intent's title
  ['--release', 'release'],            // followup --action add --source release: the release tag
  ['--take', 'take'],                  // lifecycle --action init: comma-separated FU ids the feature takes
  ['--goal', 'goal'],                  // lifecycle --action init: the goal the feature serves
  ['--since', 'since'],                // lifecycle --action overview --maintain: ISO time the pass started
  ['--file', 'file'],                  // followup --action report: the report body, read as text (at most 16 MiB)
  ['--text', 'text'],                  // followup --action report: the report body inline (a value starting with - needs --text=...) · goal --action item: the checklist item
  ['--tag', 'tag'],                    // lifecycle --action release: the version tag (`--version` is the CLI's own flag)
  ['--fp', 'fp'],                      // failure --action settle: the 16 hex characters of an entry
  ['--set', 'set'],                    // failure --action capture: on | off
  ['--proposed-by', 'proposedBy'],     // classify: which worker proposed it
  ['--calling-skill', 'callingSkill'],  // classify: which skill is asking, for the fit check
  ['--intent', 'intent'],              // route: the information need being resolved
  ['--query', 'query'],                // route: what the resolved provider would be asked
  ['--statement', 'statement'],        // claim --action add
  ['--claim-id', 'claimId'],           // claim --action link
  ['--evidence-id', 'evidenceId'],     // claim --action link · evidence --action supersede
  ['--relation', 'relation'],          // claim --action link: supports | contradicts
  ['--role', 'role'],                  // claim --action add: the claim's relationship to the task, e.g. root-cause
  ['--replaced-by', 'replacedBy'],     // claim --action supersede: the claim replacing this one ·
                                        // evidence --action supersede: the evidence replacing this one
  ['--kind', 'kind'],                  // evidence --action add: one of VALID_EVIDENCE_KINDS · advise --action ask
  ['--server', 'server'],              // advise: MCP server for the mcp-need kind
  ['--state-file', 'stateFile'],       // advise: request state from a UTF-8 file
  ['--questions-file', 'questionsFile'], // advise: ad hoc question set JSON
  ['--static', 'staticAnswer'],        // advise: explicit caller answer for comparison
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
  ['--scope', 'scope'],                // readiness: the stated scope boundary; verify: the declared
                                       // change scope, <path>[,<path>...], unioned with the plan's bound
  ['--invariants', 'invariants'],      // readiness: the invariants a refactor must preserve
  ['--objective', 'objective'],        // context-pack
  ['--mandatory-file', 'mandatoryFile'], // context-pack: caller-supplied mandatory fields
  ['--max-bytes', 'maxBytes'],         // context-pack: per-call cap in bytes
  ['--expand', 'expand'],              // context-pack: pointer id to expand
  // 078 context-emit (IC-005). Identity is read from the environment only; no flag sets it.
  ['--event', 'event'],                // context-emit: launch | prompt | delta
  ['--cwd', 'cwd'],                    // context-emit: the working directory the emission is for
  ['--session', 'session'],            // context-emit: the harness session id
  ['--nudge', 'nudge'],                // context-emit: nudge | suppress | none
  // 078 context-grant (IC-013). `--max-bytes` above is shared.
  ['--summary', 'summary'],            // context-grant: a summary id, or pending
  ['--to-run', 'toRun'],               // context-grant: the recipient run id
  ['--to-lineage', 'toLineage'],       // context-grant: the recipient lineage id
  ['--from-worktree', 'fromWorktree'], // context-grant: source scope worktree (default DOFLOW_WORKTREE or cwd)
  ['--from-run', 'fromRun'],           // context-grant: source scope run (default DOFLOW_RUN_ID or local)
  ['--from-lineage', 'fromLineage'],   // context-grant: source scope lineage (default DOFLOW_LINEAGE_ID or main)
  ['--stage-id', 'stageId'],           // research-request: active feature stage
  ['--question', 'question'],           // research-request: external question
  ['--blocking', 'blocking'],           // research-request: true | false
  ['--request-id', 'requestId'],       // research-request: request to resolve
  ['--outcome', 'researchOutcome'],    // research-request: answered | unresolved
  ['--gap', 'gap'],                     // research-request: unresolved reason
  ['--stage', 'stage'],                // retrieval-plan: the stage id declaring the plan;
                                       // outcome: the stage writing it, refused unless terminal
  ['--status', 'attemptStatus'],       // retrieval-plan: attempt status (EMPTY|UNREACHED|UNVERIFIED)
  ['--state', 'state'],                // outcome: the terminal state being recorded
  ['--result', 'result'],              // orchestrate complete-stage: the stage's own outcome, passed | failed (omit → unverified)
  // outcome: the verdicts the run saw, stated by it and validated against the vocabulary the
  // owning module exports. Recording an outcome never re-evaluates readiness and never re-runs
  // verification, so these arrive as statements rather than as measurements taken here.
  ['--readiness', 'readiness'],
  ['--verification', 'verification'],
  ['--risk', 'risk'],                  // verify: risk level selecting the required tiers
  ['--pick-id', 'pickId'],             // advise --action outcome: retained pick to label
  ['--actual', 'actual'],              // advise --action outcome: observed outcome
  ['--model', 'model'],                // advise --action configure: installed decision-capable model
  ['--endpoint', 'endpoint'],          // advise --action configure: loopback Ollama endpoint
  ['--owner', 'owner'],                // brief-tools: the agent type the brief is for
  ['--tier', 'tier'],                  // brief-tools: the task line's tier (light | standard | frontier)
  ['--harness', 'harness'],            // brief-tools: the harness the brief is for
  ['--policy', 'policy'],              // enforcement: lifecycle policy id
  ['--profile', 'profile'],             // enforcement profile; retrieve --scope code: lexical-only|hybrid
  ['--root', 'root'],                    // retrieve --scope code: project root (never harness-home)
  ['--index-action', 'indexAction'],    // retrieve --scope code: explicit build|refresh
  ['--model-path', 'modelPath'],         // retrieve --scope code: verified existing local Semble model
  ['--heading-level', 'headingLevel'], // brief-tools: 2 (default) or 3
  ['--tasks', 'tasks'],               // brief-tools: comma-separated plan task ids for tier advice
  ['--plan-path', 'planPath'],         // verify: a feature plan.md whose doflow-verification
                                       // block overrides manifest detection. Without this the
                                       // override was implemented but unreachable (FR-011).
  ['--verification-input', 'verificationInput'], // verify: manifest JSON file for explicit structuralChecks/requirements (IC-022)
  ['--verification-phase', 'verificationPhase'], // verify: postimplementation (IC-022)
  ['--baseline-ref', 'baselineRef'],             // verify: explicit ancestor commit or ref to measure change against (IC-022)
  ['--base', 'base'],                  // review --action start: the commit or ref the changed paths are measured from (095b IC-001)
  ['--preset', 'preset'],              // review --action start: a review preset id to run with, never looser than the decided one (119 IC-005)
  ['--layer', 'layer'],                // config validate|set|unset: user | project | local, checked in handleConfigCommand (119 IC-008)
  ['--prepared-run', 'preparedRun'],   // config validate: a prepared-run file to check, writes nothing (119 IC-010)
  ['--error', 'errorMessage'],         // recover: the failure text to classify
  ['--agent', 'agent'],                // recover: which agent produced the failure
  ['--task', 'task'],                  // task-attempt: the plan task id, e.g. A.1
  ['--token', 'token'],                // task-attempt finish|release: the fencing token claim returned
  // 080 task-attempt (IC-017). Read as text and validated in handleTaskAttemptCommand, so an
  // integer is digits only (`5abc` and `-1` are usage) rather than what parseInt makes of it.
  ['--owner-override', 'ownerOverride'], // claim: why someone other than the declared owner takes the task
  ['--epoch', 'epoch'],                // claim: the run epoch the caller was handed
  ['--reserve-tokens', 'reserveTokens'], // claim: tokens held against the run's budget while active
  ['--exec-worktree', 'execWorktree'], // claim: the worktree the attempt executes in
  ['--tokens', 'tokens'],              // finish|release|report-usage: tokens the attempt used, as reported
  ['--tokens-basis', 'tokensBasis'],   // finish|release|report-usage: measured | estimated
  ['--budget-attempts', 'budgetAttempts'], // start: the run's attempt limit
  ['--budget-tokens', 'budgetTokens'], // start: the run's token limit
  ['--by', 'by'],                      // start|pause|cancel|reopen|resume: who acts on the run
  ['--ack', 'ack'],                    // resume: the digest the unacknowledged resume reported
  // 081 worker (IC-025, IC-026). Read as text and validated in handleWorkerCommand.
  // `--need`, `--harness`, `--budget-tokens`, `--task`, `--token`, `--by` and `--reason` are shared.
  ['--prompt-file', 'promptFile'],     // worker run: the brief the worker receives
  ['--timeout-seconds', 'timeoutSeconds'], // worker run: 1 to 14400
  ['--worker-run', 'workerRun'],       // worker status|cancel: a w-<12 hex> run id
  ['--checks', 'checks'],              // worker evidence: checks file
  ['--out', 'out'],                    // worker evidence: output record path
  ['--model-check', 'modelCheck'],     // worker probe: a declared model-check id
  // 082 dispatch (IC-001, IC-038) and worker --child-of (IC-015). Read as text and validated in
  // executeDispatchCommand / handleWorkerCommand. `--slug`, `--by`, `--reason`, `--mode`,
  // `--reserve-tokens`, `--budget-attempts`, `--budget-tokens`, `--harness`, `--need`, `--status`,
  // `--summary`, `--tokens`, `--tokens-basis`, `--prompt-file`, `--request-id`, `--task`, `--token`,
  // `--ack`, `--request` and `--exec-worktree` are shared.
  ['--concurrency', 'concurrency'],    // dispatch start: 1 to 4
  ['--billing-cap', 'billingCap'],     // dispatch start: free-only worker billing ceiling
  ['--fallback', 'fallback'],         // dispatch start|resume: quota fallback mode off | ask | auto (106 IC-005)
  ['--ladder', 'ladder'],             // dispatch start: worker rungs, comma-separated harness ids (106 IC-005)
  ['--verify-argv', 'verifyArgv'],     // dispatch start: the verification argv as a JSON array
  ['--verify-seconds', 'verifySeconds'], // dispatch start: 1 to 14400
  ['--attempt-seconds', 'attemptSeconds'], // dispatch start: 1 to 14280
  ['--max-seconds', 'maxSeconds'],     // dispatch run: 1 to 14400
  ['--spawn-grant', 'spawnGrant'],     // dispatch start: the spawn grant declaration as JSON
  ['--dispatch', 'dispatch'],          // dispatch submit: a d-<12 hex> dispatch id
  ['--child-of', 'childOf'],           // worker run: the granter's w-<12 hex> run id
  ['--run', 'run'],                    // trace spans, trace analyze, trace export: keep one run key or run id (088 IC-011, 091 IC-001, 091 IC-006)
  ['--emit', 'emit'],                  // trace analyze: print a batch for an existing verb, evidence | followups (091 IC-001)
  ['--row', 'row'],                    // roadmap: restricts the step to one in-flight row (108 IC-001)
  ['--draft', 'draft'],                // roadmap seed: the draft file to check, apply or amend (113 IC-001)
  ['--id', 'id'],                      // package --action list|show|update: the package id
  ['--plan', 'planId'],                // package --action add|update: apply the plan file with this 16-hex plan id (122 IC-006)
  ['--points', 'points'],             // package --action new: point[:local] entries, comma-separated
  ['--dir', 'dir'],                   // package --action new: authored package target directory
  ['--name', 'name'],                  // slot: the slot's name, 1 to 64 characters of a-z, 0-9 and - (115 IC-008)
  ['--label', 'label'],                // slot --action run: the holder's label, at most 80 characters (115 IC-008)
]);

/** Repeatable arguments — each occurrence appends rather than replaces. */
const RUNTIME_LIST_FLAGS = new Map([
  ['--mcp-outcome', 'mcpOutcome'],     // orchestrate handoff: <server>=<outcome>, one per MCP server the step names
  ['--failed-check', 'failedChecks'],  // recover: check names outrank the error prose (see recovery.js)
  // retrieval-plan: the intents a stage declares, or (on report) the ones it states it reached.
  // Repeatable as well as comma-separated, because a plan assembled a need at a time should not
  // have to be re-spelled as one string to be declared.
  ['--need', 'need'],
  ['--path', 'paths'],                 // leak-scan: the files to scan, one per occurrence
  ['--exclude', 'exclude'],            // leak-scan: extra path segments to skip · lifecycle --action release: slugs left out
  ['--exclude-family', 'excludeFamily'], // model-role: model family to exclude from review candidates
  ['--feature', 'feature'],            // lifecycle --action release: a feature slug to add, one per occurrence
  ['--item', 'item'],                  // goal --action add: a checklist item, one per occurrence · goal --action check: the one item id (C3)
  ['--blocker', 'blocker'],            // dispatch submit: one blocker line per occurrence, at most 20
]);

/** Non-negative integer arguments. */
const RUNTIME_INT_FLAGS = new Map([
  ['--iteration', 'iteration'],        // recover: retries already spent, bounding the retry budget
  ['--observed-exit', 'observedExit'], // evidence --action add: exit status of the observed command (0 is meaningful)
  ['--timeout', 'timeout'],            // slot --action run: seconds to wait for the slot; the verb checks 1 to 86400 (115 IC-008)
]);

/**
 * Reads one runtime-verb argument, in either `--flag value` or `--flag=value` spelling.
 *
 * Both spellings are accepted because the messages users copy from are not consistent about it:
 * `do-paths.sh`'s own hint says `--slug=<chosen>` while the rest of this CLI is space-separated,
 * and rejecting either would punish following the instructions.
 *
 * Returns the new loop index, or null when `arg` is not a runtime flag.
 */
function parseRuntimeFlag(arg: string, argv: string[], i: number, o: any): number | null {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg : arg.slice(0, eq);
  // A score-shaped flag is refused by name rather than falling through to "unknown flag", which
  // reads as "not built yet" and invites someone to build it. The name set and the reason both
  // come from the evidence write boundary (src/runtime/cli.ts), so argv and a --batch JSON file
  // are refused by one rule with two enforcement points rather than two rules.
  const camel = name.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (EVIDENCE_SCORE_FIELDS.has(camel)) { console.error(`doflow: ${scoreFieldRefusal(name)}`); process.exit(2); }
  const inline = eq === -1 ? null : arg.slice(eq + 1);
  const key = RUNTIME_STRING_FLAGS.get(name) || RUNTIME_LIST_FLAGS.get(name) || RUNTIME_INT_FLAGS.get(name);
  if (!key) return null;

  let value: any = inline;
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
    // --exclude and --exclude-family both accept comma lists or repeated flags. Keep --exclude's
    // existing trimming, empty-item filtering, and split behavior unchanged for its callers.
    const parts = name === '--exclude' || name === '--exclude-family'
      ? value.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [value];
    (o[key] = o[key] || []).push(...parts);
  } else if (name === '--evidence-id' && o.cmd === 'research-request') {
    (o.evidenceIds = o.evidenceIds || []).push(value);
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
  enforcement          Report lifecycle policy enforcement coverage (--harness, --policy)
  doctor               System health and capability smoke check diagnostics
  readiness            Evaluate task readiness contract (--task-class, --task-id, both required)
  evidence             Record a stage's evidence batch, or inspect what is recorded (--task-id)
  claim                Record a claim, link evidence to it, or list them (--task-id, --action)
  context-pack         Compile a task's evidence and claims into a context block (--task-id)
  context-emit         Decide and render one launch, prompt or delta emission (--event, --cwd)
  context-grant        Grant one compacted summary to a launched run and lineage (--summary, --to-run, --to-lineage)
  retrieval-plan       Declare a stage's information needs, attempt retrieval, then report every declared item
  outcome              Record a task's terminal state with its basis, or show it (--task-id)
  classify             Validate a proposed task class and return its workflow (--task-class)
  workflow             Resolve a task class to its stages, gates and readiness templates
  orchestrate          Start or resume a run: complete stages, decide gates (--action)
  research-request     Open, list or resolve a feature-stage research question (--task-id)
  task-attempt         Claim, finish, release, run controls, resume, inspect, reopen or report usage on a plan's task attempts (--action, --slug)
  worker               Discover, probe, describe, select, run, status or cancel an external headless worker on a claimed task (--action)
  dispatch             Run a feature's task graph: start, step, run, submit, spawn, pause, inspect, cancel, takeover or resume (--action)
  retrieve             BM25 guidance search by default; use --scope code for scoped project retrieval (--query)
  model-role           Resolve a model role to ranked provider candidates (--role, --exclude-family)
  advise               Route decision questions to the configured local model (--action)
  brief-tools          Tier, tools and report-format block for a dispatch brief (--owner)
  route                Resolve an information need to a healthy provider (--intent)
  verify               Compile the verification contract and report against it (--task-id)
  recover              Classify a verification failure and plan the bounded retry (--error)
  trace                Trajectory of the current or most recent workflow (run ledger);
                       trace spans [<project>] the span view; trace analyze [<project>] its detectors (exit 1 on a finding);
                       trace export --otlp-http [<project>] export spans via OTLP/HTTP
  stats                Aggregate local run-ledger usage
  indicators           Per-stage and per-gate timings from the orchestration record
  discover             Missed capability opportunities in recorded runs
  inventory            Shadowed copies, drift and unmanaged files across both install scopes
  storage              Report stored data and retention bounds (--action report|prune|upkeep)
  config               Show each setting's effective value and where it came from, print the settings schema, or validate, set or unset one (exit 0 ok, 1 refused, 2 usage):
                       config [list] [--show-origin] [--json] [-g] [<project path>]   read-only
                       config schema [--json]   every key with its type, values, default, scope and whether config set may write it, the locked invariants and the presets
                       config validate <key> <json-value> [--layer user|project|local] [--json]   check a value, writes nothing
                       config validate --prepared-run <file> [--json]   check a prepared-run file (task class, settings, presets), one entry per fault, writes nothing
                       config set <key> <json-value> --layer user|project|local [--json]   validate, then write that layer's file; refuses security-relevant and invariant.* keys
                       config unset <key> --layer user|project|local [--json]   remove the key from that layer's file
  scaffold             Emit the reviewable code scaffold the active feature's artifacts imply
  decision             Register, list or compact the active feature's decisions (--action init|add|list|compact)
  followup             Record, list, take, settle, promote or report what a feature left unfinished (--action add|list|take|settle|promote|report)
  lifecycle            Open follow-ups, feature tracking, releases and status for the project (--action overview|init|release|status|merged)
  goal                 Add, check, link, list or close a goal and its checklist (--action add|item|check|link|list|done)
  failure              List, settle or switch off the failures DoFlow captured on this machine (--action list|settle|capture)
                       (a value beginning with '-' must be written --flag=value)
  roadmap              Session-driven autopilot runner (--action render|status|next|audit [--check] [--row <id>] [--run <id>]);
                       roadmap seed --action check|apply|amend --draft <path> [--json] validates and writes new rows
  plan-check           Check a plan's task lines the way the task-attempt ledger reads them: plan-check <plan path> [--json]
  review               Validate a feature's review/findings.json; print errors, advisories and counts (exit 0 valid, 1 invalid, 2 usage):
                       review --action check [--slug <name> | --path <findings.json>] [--json]
                       review --action start [--slug <name>] [--base <ref>] [--json] [--preset <id>]   verify precondition and review protocol; --base must be the review's base (exit 0 ok or not applicable, 1 refused, 2 usage)
  protocol             Print the review and debate protocol presets, or the one a run would use (read-only, writes nothing):
                       protocol --action list [--kind review|debate] [--json]
                       protocol --action resolve --kind review|debate [--task-class <id>] [--risk <level>] [--preset <id>] [--json]   (exit 0 resolved, 1 refused, 2 usage)
  primary              Resolve which harness and model the main session runs (read-only):
                       primary --action resolve [--json]   (exit 0, 1 refused, 2 usage)
  package              List the contribution points a package may fill, check a package directory, show the packages, add and update a local package, or turn it on and off:
                       package --action points [--json]
                       package --action check --path <dir> [--json]   (read-only; exit 0 clean, 1 findings, 2 usage)
                       package --action list [--id <id>] [--json]   (read-only; exit 0, 1 when a package is neither active nor disabled)
                       package --action show --id <id> [--json]   (read-only; exit 0, 1 unknown id, 2 no --id)
                       package --action add --source <spec> [--json]   (plans a local or granted remote source; exit 0, 1 refused, 2 usage)
                       package --action add --index <file> --id <id> [--version <v>] [--json]   (selects a pinned source; needs a fetch grant)
                       package --action add --plan <planId> [--json]   (stores the package and records it disabled; exit 0, 1 refused, e.g. digest-mismatch)
                       package --action update --id <id> | --plan <planId> [--json]   (plan a new copy from the recorded source, or apply the plan; a changed digest above inert prints the new trust line)
                       package --action new --id <id> --points <point[:local],...> [--dir <path>] [--json]   (writes an authored package folder only; exit 0 created, 1 refused, 2 usage)
                       package --action enable|disable --id <id> [--json]   (sets the lock bit; enable prints the resulting state, and for needs-trust the exact grant line and file; exit 0, 1 incompatible or unknown, 2 no --id)
                       package --action trust|exempt --id <id> [--json]   (prints the grant line a person appends to grants.jsonl and writes nothing; exempt exits 1 while the host is inside the range)
                       package --action revoke --id <id> [--json]   (records a revocation in state.json; only a later trust line counts)
                       package --action remove --id <id> [--json]   (disables, deletes the store entry and lock row, records a revocation and a removed tombstone, then lists the settings, records and grant lines that still name the package and rewrites none; exit 0, 1 unknown id or the bundled package, 2 no --id)
                       package --action verify [--repair] [--json]   (re-hashes enabled third-party entries and records suspensions; exit 0 intact, 1 findings; --repair rewrites an unreadable state.json)
  slot                 Named machine-wide queue, one holder at a time (--action run|list|release);
                       slot --action run --name <name> [--label <text>] [--timeout <s>] [--no-wait] -- <command> [args...]
                       slot --action release --name <name> --by <who> --reason <text>
  models               Synchronize, list, or inspect observed models across workers (--action sync|list|describe)
  leak-scan            Report DoFlow-internal identifiers in shipped files (--path, repeatable)

Scope (mutually exclusive — global wins if both given):
  -g, --global         Install to each target's user-level directory under \$HOME (e.g. \$HOME/.claude),
                       and the shared runtime to \$HOME/.doflow
  [path]               Project-scoped install root (default: '.', i.e. cwd); e.g.
                       'doflow install ../my-app' -> each target's project files, plus
                       ../my-app/.doflow
                       (rollback's one positional slot is the backup id instead — its scope is
                       always -g or cwd, no custom project path)

Options:
  -t, --target <list>  Comma-separated: ${VALID_TARGETS.join(',')} (default: ${DEFAULT_TARGETS.join(',')})
      --mcp <list>     Comma-separated MCP server names, or all or none, for every targeted
                       harness that takes MCP servers (all of them). Default: none, or the
                       selection a harness has recorded in doflow.lock, or the servers an
                       installed harness already has; a real terminal prompts on install.
                       Recorded per harness.
  -n, --dry-run        Preview without writing
  -f, --force          Skip confirmation prompts
      --adopt          Record ownership of resources that exist with no ledger record, instead
                       of refusing them. Not --force: a resource whose record disagrees with
                       the file is still a conflict. For a tree installed before the neutral
                       ledger existed, which nothing else can re-adopt
      --no-backup      Skip backup (requires --force; ignored by rollback's safety snapshot)
      --prune <N>      Keep the N newest backups after install, update or reconcile (default 3; 0 keeps all)
      --days <N>       Run-ledger window in calendar days (trace, stats, discover)
      --run <key|id>   trace spans, trace analyze, trace export: keep the traces of one run key or run id
      --emit evidence|followups
                       trace analyze: print only the batch for evidence --action add --batch -,
                       or for followup --action add --batch <file> (with --task-id, cites its evidence)
      --otlp-http      trace export: export spans to an OpenTelemetry collector via OTLP/HTTP JSON
      --slug <name>    Scaffold this feature instead of the branch-resolved active one

Runtime verb arguments (accept --flag value or --flag=value):
      --task-class     classify, workflow, readiness, context-pack, outcome --action record, protocol --action resolve
      --task-id        readiness, evidence, claim, context-pack, retrieval-plan, outcome, verify, advise, retrieve,
                       trace analyze --emit followups (the ledger read for evidence ids)
      --action         claim: list|add|link|retract|supersede · evidence: list|add|supersede|retire
                       verify: report|contract · retrieval-plan: declare|report|attempt
                       outcome: record|show · advise: ask|outcome|configure · tools: see above
                       followup: add|list|take|settle|promote|report
                       task-attempt: claim|finish|release|status|start|pause|cancel|resume|inspect|reopen|report-usage
                       worker: discover|probe|describe|select|run|status|cancel|evidence
                       dispatch: start|step|run|submit|spawn|pause|inspect|cancel|takeover|resume
                       lifecycle: overview|init|release|status|merged
                       goal: add|item|check|link|list|done
                       failure: list|settle|capture
                       roadmap: render|status|next|audit (seed: check|apply|amend)
                       slot: run|list|release
                       models: sync|list|describe
                       review: check|start
                       protocol: list|resolve
                       primary: resolve
                       package: points|check|list|show|add|update|enable|disable|trust|exempt|revoke|verify|remove
      --task, --token, --owner, --mode,
      --result, --evidence-id, --reason     task-attempt (claim: --task --owner --mode manual|sequential|subagent
                                            [--owner-override <reason>] [--epoch <n>=1+] [--reserve-tokens <n>]
                                            [--exec-worktree <path>];
                                            finish: --task --token --result COMPLETED|BLOCKED|ABANDONED|INCONCLUSIVE|FAILED
                                            [--evidence-id] [--reason, required with FAILED];
                                            release: --task --token --reason; finish and release also
                                            [--tokens <n> --tokens-basis measured|estimated];
                                            start: --by [--budget-attempts <n>=1+] [--budget-tokens <n>=1+];
                                            pause: --by --reason; cancel: --by --reason, one attempt with
                                            --task --token, else the run [--adopt-unowned];
                                            reopen: --task --token --by --reason;
                                            report-usage: --task --token --tokens <n> --tokens-basis
                                            measured|estimated, once on an ended attempt with no usage;
                                            resume: report and digest, then --ack sha256:<hex> --by [--reason];
                                            inspect: graph, task states, budgets and run totals.
                                            Exit 0 applied or read; 1 refused, stale or ack-required, the
                                            disposition in the JSON; 2 usage or an unreadable store or plan)
      --rationale, --proposed-by, --calling-skill    classify
      --request <text>, --request-file <file>  classify (mutually exclusive; optional second opinion)
      --intent, --query, --check            route
      --statement, --claim-id,
      --evidence-id, --relation             claim
      --kind, --provenance, --provider,
      --capability, --locator, --content,
      --absence                             evidence --action add (one item)
      --need <intent>                       evidence --action add (bind evidence to retrieval needs)
      --scope code --profile lexical-only|hybrid,
      --root <project>, --index-action build|refresh,
      --model-path <local-dir>              retrieve code scope (guidance remains the default)
      --batch <file|->                      evidence --action add (a stage's JSON batch)
      --evidence-id, --replaced-by          evidence --action supersede (retire one item, point
                                            forward to the item that replaces it)
      --stale                               evidence --action retire (retire every item the ledger
                                            classes stale, with no replacement; fresh items stay)
      --verification-plan, --scope,
      --invariants,
      --user-decision-pending               readiness: inputs the caller states rather than
                                            evidence establishes; reported back as such
      --objective                           context-pack
      --event, --cwd, --session, --harness,
      --nudge, --max-bytes, --task-id,
      --slug, --peek                        context-emit (identity comes from the environment only)
      --summary, --to-run, --to-lineage,
      --from-worktree, --from-run,
      --from-lineage, --max-bytes           context-grant
      --need <intent[,intent]>,
      --stage, --status                     retrieval-plan (--need is repeatable), outcome
      --mcp-outcome <server>=<outcome>      orchestrate --action handoff, repeatable: used | nothing-usable |
                                            skipped:<reason> | unavailable (a server left out only warns)
      --state <COMPLETED|BLOCKED|
               ABANDONED|INCONCLUSIVE>,
      --readiness, --verification           outcome --action record
      --risk, --plan-path, --scope,
      --verification-input,
      --verification-phase,
      --baseline-ref                     verify
      --owner, --tier, --harness, --tasks <id,...>,
      --heading-level 2|3                   brief-tools (--slug names the feature whose run gives the stage)
      --kind, --state, --state-file,
      --questions-file, --server,
      --static                           advise --action ask
      --pick-id, --actual                advise --action outcome
      --model, --endpoint, --project,
      --off                              advise --action configure
      --path, --exclude (repeatable)        leak-scan
      --slug | --path                       review --action check (at most one; with neither, the active feature)
      --path <dir>                          package --action check (exactly one package directory)
      --id <id>                             package --action list (one package), show, update (required unless --plan), enable, disable, trust, exempt, revoke and remove
      --source <spec>                       package --action add (local dir, git:https://<host>/<repo>[#<subdir>]@<ref>, npm:<name>@<version or range>)
      --index <file>, --version <v>          package --action add --id <id> (local pinned index; default highest compatible stable version)
      --plan <planId>                       package --action add and update (apply the plan; it is kept for 24 hours)
      --points <point[:local],...>           package --action new (open points and optional local ids)
      --dir <path>                          package --action new (default: <project>/.doflow/package/<id>/)
      --repair                              package --action verify (rewrite an unreadable state.json; every grant line present is revoked, never widened)
      --base <ref>                          review --action start (measure the changed paths from this commit, which must be the review's base; --path is refused)
      --preset <id>                         review --action start, protocol --action resolve (run this preset; refused when looser than the decided protocol)
      --prepared-run <file>                 config validate (check a prepared-run file instead of one key; exit 2 with a key, value or --layer)
      --layer user|project|local            config validate, set, unset (which settings file; project and local are the current project's .doflow/settings.json and settings.local.json)
      --kind review|debate, --risk <level>  protocol (--kind filters list and selects what resolve decides; --risk is the change's risk level)
      --ids, --as, --evidence, --title,
      --release, --source, --channel        followup (add, list, take, settle, promote)
      --file <path|->, --stdin, --text,
      --feature                             followup --action report (the body comes from exactly one; - is stdin)
      --take, --goal, --intent, --since,
      --maintain                            lifecycle (overview, init)
      --goal, --statement, --item (repeatable),
      --text, --evidence, --unmet, --slug,
      --replace, --reason, --channel        goal (add, item, check, link, list, done)
      --tag, --confirm, --feature,
      --exclude (repeatable), --reason      lifecycle (release, merged)
      --fp, --as, --reason, --set, --all    failure (list, settle, capture)
      --harness, --need (repeatable),
      --model-check, --budget-tokens,
      --task, --token, --prompt-file,
      --timeout-seconds, --wait, --edit,
      --child-of, --request, --exec-worktree,
      --worker-run, --by, --reason,
      --checks, --out                       worker (probe: [--model-check <id> --budget-tokens <n>];
                                            describe: --harness [--edit]; select: [--edit];
                                            run: --harness --task --token
                                            --prompt-file [--timeout-seconds 1-14400] [--wait] [--edit]
                                            [--child-of <w-id> --request <d-id.cN> --exec-worktree <path>];
                                            status, cancel: --worker-run or --task --token;
                                            cancel also --by --reason;
                                            evidence: --harness --out and exactly one of --checks <file>
                                            (free CLI checks) or --worker-run <w-id> (an ended run).
                                            Exit 0 done; 1 refused or
                                            none-eligible, the disposition in the JSON; 2 usage)
      --slug, --by, --reason, --concurrency,
      --mode, --verify-argv, --verify-seconds,
      --attempt-seconds, --reserve-tokens,
      --budget-attempts, --budget-tokens,
      --spawn-grant, --harness, --need,
      --max-seconds, --dispatch, --status,
      --summary, --blocker (repeatable),
      --tokens, --tokens-basis, --prompt-file,
      --request-id, --task, --ack           dispatch (start: --by [--concurrency 1-4] [--mode auto|sequential|manual]
                                            [--verify-argv <json>] [--verify-seconds <n>] [--attempt-seconds <n>]
                                            [--reserve-tokens <n>] [--budget-attempts <n>] [--budget-tokens <n>]
                                            [--spawn-grant <json>] [--harness <id>] [--need <id>];
                                            step: [--by]; run: [--by] [--max-seconds 1-14400];
                                            submit: --dispatch <d-id> --status success|failure --summary <text>
                                            [--blocker <text>] [--tokens <n> --tokens-basis measured|estimated];
                                            spawn: --prompt-file --reserve-tokens <n>, or --request-id;
                                            pause, cancel: --by --reason; takeover: --task --by --reason;
                                            resume: report and digest, then --ack sha256:<hex> --by [--reason];
                                            inspect. Exit 0 done; 1 refused, stale or ack-required, the
                                            disposition in the JSON; 2 usage or an unreadable store or plan)
      --error, --failed-check,
      --iteration, --agent                  recover
      --name, --label, --timeout,
      --no-wait, --by, --reason             slot (run: --name [--label <text>] [--timeout 1-86400] [--no-wait] -- <command> [args...],
                                            everything after -- is the command's own argv; list; release: --name --by
                                            --reason. Exit: run passes the command's code, 75 when busy or timed out;
                                            release 1 while the holder is alive; 2 usage)
      --json           Machine-readable output (status)

External tools:
      --tool <list>    Comma-separated: rtk,graphify (required outside an interactive terminal)
      --action <name>  status (default), install, update, or uninstall
                       --force is intentionally unavailable: every mutation is separately confirmed
  -h, --help           Show help
  -v, --version        Show version`;

// The names a failure may be recorded under (IC-011): the installer table and the verbs HELP lists,
// so a record can only ever carry a name from DoFlow's own tables and never an argument value.
const COMMAND_NAMES = new Set([...Object.keys(COMMANDS), ...[...HELP.matchAll(/^  ([a-z][a-z-]*) {2,}\S/gm)].map((m) => m[1])]);

/** `name` when it is one of DoFlow's own command names, else `unknown`. */
function commandName(name: any): string { return typeof name === 'string' && COMMAND_NAMES.has(name) ? name : 'unknown'; }

/**
 * Run one CLI invocation. Same behavior as the pre-extraction monolith's main(): --version and
 * --help answer first, --no-backup-without-force is refused, then the command resolves either
 * through the installer table above or through the runtime-verb dispatcher.
 */
async function main(argv: string[]): Promise<any> {
  const o = parseArgs(argv);
  if (o.version) { console.log(pkg.version); return; }
  if (o.help || !o.cmd) { console.log(HELP); return; }
  assertNoBackupRequiresForce(o);
  if (o.cmd === 'classify' && o.request !== undefined && o.requestFile !== undefined) {
    return usageError('classify', '--request and --request-file are mutually exclusive; provide only one.', o.json);
  }
  try {
    const handler = COMMANDS[o.cmd];
    if (handler) return handler(o);
    return await dispatchRuntimeCommand(o);
  } catch (error: any) {
    // Recorded silently when it is a programming error (IC-016); the output and exit status below
    // are the same whether or not anything was written.
    // Required here, not at load, so a CLI whose failure modules cannot be loaded still runs as today.
    try { require('../runtime/failure/capture.ts').captureError(error, { command: commandName(o.cmd), exit: 1 }); } catch { /* best-effort */ }
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

module.exports = { main, COMMANDS, commandName, parseArgs };

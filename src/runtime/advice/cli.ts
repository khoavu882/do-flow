'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { finishRuntime, usageError } = require('../cli-result.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadAdviceRegistry } = require('./registry.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { resolveRoots } = require('../storage/roots.ts');
const { resolveSetting } = require('./config.ts');
const { loadSettings } = require('../settings/resolve.ts');
const { writeLayer } = require('../settings/write.ts');
const { createAdviceClient } = require('./client.ts');
const { interceptDecisionPoint } = require('./shadow-dispatcher.ts');
const { resolveShadowConfig } = require('./shadow-config.ts');
const { profileAdvisorCap, capMode } = require('./mode.ts');
const { materializeKind, validateQuestionSet, validateStaticAnswer } = require('./kinds.ts');
const { findPick, appendOutcome, wasShown, FOLLOWED } = require('./record.ts');
const { removedKeyDiagnostics } = require('./retired.ts');
const { strengthWords } = require('./strength.ts');
const { buildReport, renderText } = require('./report.ts');
const { inWorkerSession } = require('../context/identity.ts');
const { projectLayerSource } = require('../settings/project-layers.ts');
const { handleReplay } = require('./replay/run.ts');
const { flagsAnswer, renderFlagsText } = require('./flags.ts');

function loadSources(repoRoot: any) {
  const read = (name: any) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'core/registry', name), 'utf8'));
  return {
    workflows: read('workflows.json'),
    verification: read('verification.json'),
    mcp: read('mcp.json'),
  };
}

/**
 * Two roots, kept apart (review R-02): the stores (picks, results) are keyed by `projectRoot`, the main checkout, as every
 * other advice caller keys them; the settings come from the layer projectLayerSource names for `settingsRoot`, the
 * checkout's own toplevel (its own `.doflow`, or the main checkout's when it inherits). `roots['project-doflow']`, which
 * advice reads only for settings, and the returned `settingsRoot` both point at that layer's checkout.
 */
function loadRuntime({ projectRoot, settingsRoot, global = false }: any = {}) {
  const advice = loadAdviceRegistry({ repoRoot: REPO_ROOT });
  const storage = loadStorageRegistry({ repoRoot: REPO_ROOT });
  const projectLayers = projectLayerSource(settingsRoot);
  const layerRoot = projectLayers.layersFrom ? path.dirname(projectLayers.layersFrom) : settingsRoot;
  const roots = {
    ...resolveRoots({ registry: storage, projectRoot, global }),
    'project-doflow': resolveRoots({ registry: storage, projectRoot: layerRoot, global })['project-doflow'],
  };
  const sources = loadSources(REPO_ROOT);
  const adviceRegistry = advice.ok ? advice.registry : null;
  return { adviceRegistry, adviceError: advice.ok ? null : advice.detail, storage, roots, sources, projectLayers, settingsRoot: layerRoot || undefined };
}

/** The JSON body of a response, with the removed-setting diagnostics (retired.ts) in `warnings` when there are any. */
function jsonBody(value: any, options: any) {
  return JSON.stringify(options?.warnings?.length ? { ...value, warnings: options.warnings } : value, null, 2);
}

function emitResult(result: any, { json, kind, warnings }: any) {
  if (result.reason === 'over-limit') {
    return usageError('advise', result.detail || 'request exceeds an advice limit', json);
  }
  if (json) {
    console.log(jsonBody(result, { warnings }));
  } else if (result.status === 'answered') {
    for (const answer of result.answers) {
      const staticText = answer.staticAnswer === null ? '' : ` Static answer: ${answer.staticAnswer}.`;
      console.log(`Advice (${kind}): ${answer.pick}, ${strengthWords(answer.strength)}.${staticText}`);
    }
  } else if (result.status === 'off' || result.status === 'shadow') {
    console.log(`Advice (${kind}): status: ${result.status}; the static answer stands.`);
  } else {
    console.log(`Advice (${kind}): none; the static answer stands.`);
  }
  return finishRuntime(0);
}

function isPresent(value: any) {
  return value !== undefined && value !== null;
}

function readState({ state, stateFile, json }: any) {
  if (isPresent(state) === isPresent(stateFile)) {
    usageError('advise', 'provide exactly one of --state or --state-file', json);
    return null;
  }
  if (isPresent(state)) return state;
  try {
    const content = fs.readFileSync(stateFile, 'utf8');
    if (!content.length) throw new Error('file is empty');
    return content;
  } catch (error: any) {
    usageError('advise', `cannot read state file ${stateFile}: ${error.message}`, json);
    return null;
  }
}

function readQuestions(file: any, json: any) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.questions)) {
      throw new Error('expected an object with a questions array');
    }
    return parsed.questions;
  } catch (error: any) {
    usageError('advise', `cannot read questions file ${file}: ${error.message}`, json);
    return null;
  }
}

function parseAskInput(options: any) {
  const hasKind = typeof options.kind === 'string' && options.kind.length > 0;
  const hasQuestionsFile = isPresent(options.questionsFile);
  if (hasKind === hasQuestionsFile) {
    usageError('advise', 'provide exactly one of --kind or --questions-file', options.json);
    return null;
  }
  const state = readState({ state: options.state, stateFile: options.stateFile, json: options.json });
  if (state === null) return null;
  if (options.server !== undefined && !hasKind) {
    usageError('advise', '--server is only valid with --kind mcp-need', options.json);
    return null;
  }
  if (options.staticAnswer !== undefined && !hasKind) {
    usageError('advise', '--static is only valid with a named --kind', options.json);
    return null;
  }
  return { state, hasKind, hasQuestionsFile };
}

function endpointSource(userSetting: any, endpoint: any) {
  if (userSetting?.decidedBy?.user) {
    try {
      const file = JSON.parse(fs.readFileSync(userSetting.decidedBy.user, 'utf8'));
      if (file.endpoint === endpoint) return userSetting.decidedBy.user;
    } catch { /* an invalid file will be reported by its resolver/writer */ }
  }
  return 'provider default';
}

function inspectFailure(inspected: any, { endpoint, model, provider }: any) {
  if (inspected.endpoint.state === 'refused') return inspected.endpoint.message;
  if (inspected.endpoint.state !== 'reached') {
    return `advise: provider ${provider.id} did not answer at ${endpoint}; start it yourself and re-run. Nothing was written.`;
  }
  if (!inspected.endpoint.versionOk) {
    return `advise: provider ${provider.id} version ${inspected.endpoint.version || 'unknown'} at ${endpoint} is older than ${provider.minVersion}. Nothing was written.`;
  }
  if (!inspected.model.installed) {
    return `advise: model ${model} is not installed at provider ${provider.id}; install it with that provider's own tool and re-run. Nothing was written.`;
  }
  if (!inspected.model.decisionCapable) {
    const capable = inspected.models
      .filter((entry: any) => Array.isArray(entry.capabilities) && entry.capabilities.includes(provider.capability))
      .map((entry: any) => entry.name);
    return `advise: model ${model} is not decision-capable; decision-capable here: ${capable.length ? capable.join(', ') : 'none'}. Nothing was written.`;
  }
  return null;
}

function writeFailure(message: any, json: any) {
  if (json) console.log(JSON.stringify({ ok: false, error: 'write-failed', message }, null, 2));
  else if (message.startsWith('decision model: endpoint ') || message.startsWith('advise:')) console.error(message);
  else console.error(`advise: ${message}`);
  return finishRuntime(1);
}

async function handleConfigure(options: any, runtime: any) {
  const { adviceRegistry, adviceError, roots, sources, projectLayers } = runtime;
  const { json, project, global, force } = options;
  const hasModel = typeof options.model === 'string' && options.model.length > 0;
  const hasOff = options.off === true;
  if (hasModel && hasOff) return usageError('advise', 'cannot combine --model and --off', json);
  if (!hasModel && !hasOff) return usageError('advise', 'provide exactly one of --model or --off', json);
  if (project && options.endpoint !== undefined) return usageError('advise', '--endpoint cannot be used with --project', json);
  if (hasOff && options.endpoint !== undefined) return usageError('advise', '--endpoint cannot be used with --off', json);
  if (project && (global || !options.projectRoot)) return usageError('advise', '--project requires a project root', json);
  if (adviceError || !adviceRegistry) return writeFailure(`advice registry is invalid: ${adviceError || 'missing registry'}`, json);

  if (!project && !roots['config-home']) return usageError('advise', 'no config home resolves; set an absolute HOME or XDG_CONFIG_HOME, or use --project', json);

  const file = project
    ? path.join(projectLayers.layersFrom || roots['project-doflow'], 'settings.json')
    : path.join(roots['config-home'], 'settings.json');
  const fsImpl = fs;
  const inheritedFromMain = !!project && projectLayers.checkout === 'main';
  const discloseWrite = (setting: any) => {
    const result: any = { written: file, setting };
    if (inheritedFromMain) result.inheritedFromMainCheckout = true;
    if (json) console.log(jsonBody(result, options));
    else if (inheritedFromMain) console.log(`(inherited from the main checkout)`);
  };
  if (hasOff) {
    const written = writeLayer({ file, set: { 'advice.enabled': false }, force, fsImpl });
    if (!written.ok) return writeFailure(written.detail, json);
    const effective = resolveSetting({ adviceRegistry, roots, fsImpl });
    if (json) discloseWrite(effective);
    else console.log(project
      ? `Decision model for this project: off (wrote ${file}${inheritedFromMain ? ' (inherited from the main checkout)' : ''}).`
      : `Decision model off (wrote ${file}).`);
    return finishRuntime(0);
  }

  let userRoots = roots;
  if (project) userRoots = { ...roots, 'project-doflow': null };
  const userSetting = resolveSetting({ adviceRegistry, roots: userRoots, fsImpl });
  if (project && userSetting.state !== 'on') {
    return writeFailure('turn the decision model on at user level first; a project cannot enable it', json);
  }
  const providerId = userSetting.provider ?? loadSettings({ global: true }).get('advice.provider', 'global').value;
  const provider = adviceRegistry.providers.find((entry: any) => entry.id === providerId);
  if (!provider) return writeFailure(`provider '${providerId}' is not in core/registry/advice.json`, json);
  const endpoint = project
    ? userSetting.endpoint
    : options.endpoint || userSetting.endpoint || provider.defaultEndpoint;
  const endpointFile = options.endpoint ? '--endpoint' : endpointSource(userSetting, endpoint);
  const client = createAdviceClient({ adviceRegistry, roots, sources });
  const inspected = await client.inspect({ endpoint, model: options.model, provider: provider.id, minVersion: provider.minVersion, file: endpointFile });
  const failure = inspectFailure(inspected, { endpoint, model: options.model, provider });
  if (failure) return writeFailure(failure, json);

  const setting = project
    ? { 'advice.model': options.model }
    : { 'advice.enabled': true, 'advice.provider': provider.id, 'advice.endpoint': endpoint, 'advice.model': options.model };
  const written = writeLayer({ file, set: setting, force, fsImpl });
  if (!written.ok) return writeFailure(written.detail, json);
  const effective = resolveSetting({ adviceRegistry, roots, fsImpl });
  if (json) discloseWrite(effective);
  else console.log(project
    ? `Decision model for this project: ${options.model} (wrote ${file}${inheritedFromMain ? ' (inherited from the main checkout)' : ''}).`
    : `Decision model on: ${options.model} at ${endpoint} (wrote ${file}).`);
  return finishRuntime(0);
}

async function handleAsk(options: any, runtime: any) {
  const parsed = parseAskInput(options);
  if (!parsed) return finishRuntime(2);
  const { adviceRegistry, adviceError } = runtime;
  if (adviceError || !adviceRegistry) {
    const result = {
      status: 'off', reason: 'config-invalid', detail: adviceError || 'advice registry is missing',
      provider: null, model: null, endpoint: null, decidedBy: { user: null, project: null }, durationMs: 0, answers: [],
    };
    return emitResult(result, { json: options.json, kind: options.kind || 'adhoc', warnings: options.warnings });
  }

  let kind = 'adhoc';
  let questionSet;
  let questionError = null;
  if (parsed.hasKind) {
    kind = options.kind;
    const built = materializeKind(kind, { adviceRegistry, sources: runtime.sources, server: options.server });
    if (!built.ok && built.reason === 'usage-error') return usageError('advise', built.detail, options.json);
    if (built.ok) questionSet = { state: parsed.state, questions: [built.question] };
    else {
      questionSet = { state: parsed.state, questions: [] };
      questionError = built.detail;
    }
    if (options.staticAnswer !== undefined && built.ok) {
      const validation = validateStaticAnswer(built.question, options.staticAnswer);
      if (!validation.ok) return usageError('advise', validation.detail, options.json);
    }
  } else {
    const questions = readQuestions(options.questionsFile, options.json);
    if (!questions) return finishRuntime(2);
    questionSet = { state: parsed.state, questions };
    const validation = validateQuestionSet(questionSet, { adviceRegistry });
    if (!validation.ok) return usageError('advise', validation.detail, options.json);
  }

  const result = await askThroughDispatcher({
    options, runtime, parsed, questionSet, kind, questionError,
  });
  return emitResult(result, { json: options.json, kind, warnings: options.warnings });
}

/** The shape client.ask returns, for an ask that made no model call (off, or shadow where the child asks). */
function noCallResult(status: string, reason: string | null, detail: string | null, setting: any) {
  return {
    status, reason, detail,
    provider: setting?.provider ?? null, model: setting?.model ?? null, endpoint: setting?.endpoint ?? null,
    decidedBy: setting?.decidedBy ?? { user: null, project: null }, durationMs: 0, answers: [],
  };
}

/**
 * One ask, through the one dispatcher path (row 174). A named kind runs in the mode `advice.kinds.<kind>` and the
 * rollout profile's cap give it: off asks nothing, shadow hands the call to the detached child and shows nothing; show
 * and act print the model's answer once the kind's local result stands at show or act (175 IC-009: the ask is a show
 * surface; below the standing the call is a shadow one, with its LOCAL_RESULT_UNMET warning). An ad hoc question set has
 * no kind setting: the profile cap alone decides between off, shadow and the direct ask.
 */
async function askThroughDispatcher({ options, runtime, parsed, questionSet, kind, questionError }: any) {
  const { adviceRegistry, roots, sources } = runtime;
  const env = options.env || process.env;
  const projectRoot = options.projectRoot || undefined;
  const { settingsRoot } = runtime;
  const setting = resolveSetting({ adviceRegistry, roots, env });
  if (setting.state !== 'on') return noCallResult('off', setting.reason, setting.notes?.[0] || null, setting);

  // The client's own state limit (client.ts), checked here too because a shadow call is asked in the detached child,
  // after this command has printed; a state over the limit stays a usage error whichever mode the kind runs in.
  const stateBytes = Buffer.byteLength(questionSet.state, 'utf8');
  if (stateBytes > adviceRegistry.limits.maxStateBytes) {
    return {
      ...noCallResult('unavailable', 'over-limit', `state is ${stateBytes} bytes; the limit is ${adviceRegistry.limits.maxStateBytes} (core/registry/advice.json limits.maxStateBytes)`, setting),
    };
  }
  const client = createAdviceClient({ adviceRegistry, roots, sources });
  const cap = profileAdvisorCap({ projectRoot: settingsRoot, env });
  if (!parsed.hasKind && capMode(cap, 'act') === 'act') {
    // No kind setting and no cap on the advisor: the direct ask, bounded by timeoutMs (client.ts).
    return client.ask({ questionSet, kind, staticAnswer: options.staticAnswer, caller: 'advise', taskId: options.taskId, record: true });
  }
  const shadowConfig = parsed.hasKind
    ? resolveShadowConfig(kind, { projectRoot: settingsRoot, env, roots, global: options.global })
    : { kind, mode: capMode(cap, 'act') === 'shadow' ? 'shadow' : 'off', model: null };
  // The client's own reply, kept so a shown or act answer prints as it always did; the dispatcher asks through this
  // wrapper, and reads the model build's digest through the same client.
  let reply: any = null;
  const adviceClient = {
    ask: async (askOptions: any) => { reply = await client.ask(askOptions); return reply; },
    modelDigest: (digestOptions: any) => client.modelDigest(digestOptions),
  };
  const intercepted = await interceptDecisionPoint({
    kind, caller: 'advise', state: questionSet.state, staticPick: options.staticAnswer ?? '', staticAnswer: options.staticAnswer,
    questionSet, adviceRegistry, taskId: options.taskId ?? null, projectRoot, settingsRoot, env, surface: 'show',
  }, { adviceClient, roots, shadowConfig });
  if (intercepted.mode === 'off') return noCallResult('off', null, null, setting);
  if (intercepted.mode === 'shadow') return noCallResult('shadow', intercepted.warning || null, null, setting);
  // Show and act: the client's own reply, with the pick id the dispatcher recorded; a question the materialiser could
  // not build keeps its own diagnostic.
  if (!reply) return { ...noCallResult('off', 'timeout', null, setting), status: 'unavailable' };
  if (questionError && reply.reason === 'config-invalid') reply = { ...reply, detail: questionError };
  if (reply.status !== 'answered') return reply;
  if (!intercepted.advisorPick) return { ...reply, status: 'unavailable', reason: 'malformed-reply', answers: [] };
  return { ...reply, answers: reply.answers.map((answer: any, index: number) => (index === 0 ? { ...answer, pickId: intercepted.pickId } : answer)) };
}

/**
 * `--action outcome` (175 IC-010): `--actual` (an option of the pick) and `--followed` (FOLLOWED), at least one. The
 * followed label is only for a pick the person was shown (record.ts `wasShown`).
 */
function handleOutcome(options: any, runtime: any) {
  const { json } = options;
  if (typeof options.pickId !== 'string' || !options.pickId) return usageError('advise', '--pick-id is required', json);
  const given = (value: any) => typeof value === 'string' && value !== '';
  const actual = given(options.actual) ? options.actual : undefined;
  const followed = given(options.followed) ? options.followed : undefined;
  if (actual === undefined && followed === undefined) return usageError('advise', '--actual or --followed is required', json);
  if (followed !== undefined && !FOLLOWED.includes(followed)) return usageError('advise', `--followed must be one of: ${FOLLOWED.join(', ')}`, json);
  const found = findPick({ pickId: options.pickId, roots: runtime.roots });
  if (!found) {
    if (json) console.log(JSON.stringify({ ok: false, error: 'not-found', message: `no pick ${options.pickId} in the retained record` }, null, 2));
    else console.error(`advise: no pick ${options.pickId} in the retained record`);
    return finishRuntime(1);
  }
  if (actual !== undefined && !found.pick.options?.includes(actual)) {
    return usageError('advise', `--actual must be one of: ${(found.pick.options || []).join(', ')}`, json);
  }
  if (followed !== undefined && !wasShown(found.pick)) {
    return usageError('advise', `--followed: this pick was never shown (mode ${found.pick.mode ?? 'unrecorded'}); record what was done with --actual`, json);
  }
  const written = appendOutcome({ pickId: options.pickId, actual, followed, source: 'caller', roots: runtime.roots, store: found.store });
  if (!written) return writeFailure(`could not record outcome for ${options.pickId}`, json);
  const labels = { ...(actual !== undefined ? { actual } : {}), ...(followed !== undefined ? { followed } : {}) };
  if (json) console.log(jsonBody({ pickId: options.pickId, ...labels, recorded: true, file: written.file }, options));
  else console.log(`Recorded outcome for ${options.pickId}: ${[actual !== undefined ? `actual ${actual}` : null, followed ?? null].filter(Boolean).join(', ')}.`);
  return finishRuntime(0);
}

function handleReport(options: any, runtime: any) {
  const { json } = options;
  const { adviceRegistry, adviceError, roots } = runtime;
  if (adviceError || !adviceRegistry) return writeFailure(`advice registry cannot be read: ${adviceError || 'missing'}`, json);
  // A kind nothing asks (an empty askedBy) has no record to report; a pick of a kind since removed still shows below.
  const ids = (adviceRegistry.kinds || []).filter((entry: any) => entry.askedBy?.length > 0).map((entry: any) => entry.id);
  if (options.kind !== undefined && options.kind !== null && !ids.includes(options.kind) && options.kind !== 'adhoc') {
    return usageError('advise', `unknown --kind '${options.kind}'; known kinds: ${ids.join(', ')}`, json);
  }
  const report = buildReport({
    roots, kinds: ids, kind: options.kind ?? null, global: options.global === true,
    registry: adviceRegistry, sources: runtime.sources, projectRoot: options.projectRoot || null,
  });
  console.log(json ? jsonBody(report, options) : renderText(report));
  return finishRuntime(0);
}

/**
 * `--action flags` (177 IC-010): the instructs-reader flags past the show bar, read from recorded picks (flags.ts). Writes
 * nothing; the one network call is the trust lookup's model listing. Exit 0 shown or not; 1 registry unreadable; 2 usage.
 */
async function handleFlags(options: any, runtime: any) {
  const { json } = options;
  const { adviceRegistry, adviceError, roots, sources } = runtime;
  if (adviceError || !adviceRegistry) return writeFailure(`advice registry cannot be read: ${adviceError || 'missing'}`, json);
  const answer = await flagsAnswer({
    registry: adviceRegistry, roots, sources, projectRoot: options.projectRoot, settingsRoot: runtime.settingsRoot, env: options.env || process.env,
    global: options.global === true, limit: options.limit, kind: options.kind,
    client: createAdviceClient({ adviceRegistry, roots, sources }),
  });
  if (answer.exit === 2) return usageError('advise', answer.message, json);
  console.log(json ? jsonBody(answer.json, options) : renderFlagsText(answer));
  return finishRuntime(0);
}

async function handleAdviseCommand(options: any = {}) {
  const action = options.actionGiven ? options.action : 'ask';
  if (!['ask', 'outcome', 'configure', 'report', 'replay', 'flags'].includes(action)) return usageError('advise', `unknown action '${action}'`, options.json);
  if (action === 'configure' && inWorkerSession(options.env || process.env)) {
    const message = "configure changes the user's decision-model settings and is not run from a worker session; a person runs it from their own terminal";
    if (options.json) console.log(JSON.stringify({ ok: false, error: 'worker-session', message }, null, 2));
    else console.error(`advise: ${message}`);
    return finishRuntime(1);
  }
  try {
    const projectRoot = options.global ? null : path.resolve(options.projectRoot || process.cwd());
    // The checkout whose settings layer applies (its own toplevel); the stores stay keyed by projectRoot.
    const settingsRoot = options.global ? null : path.resolve(options.settingsRoot || projectRoot);
    const runtime = loadRuntime({ projectRoot, settingsRoot, global: options.global });
    // A removed setting key still in a settings file: said once on stderr in text mode, in `warnings` of the JSON body in --json.
    const warnings = removedKeyDiagnostics(runtime.roots, runtime.adviceRegistry);
    if (!options.json) for (const line of warnings) console.error(`advise: ${line}`);
    const shaped = { ...options, projectRoot, warnings };
    if (action === 'configure') return await handleConfigure(shaped, runtime);
    if (action === 'outcome') return handleOutcome(shaped, runtime);
    if (action === 'report') return handleReport(shaped, runtime);
    if (action === 'replay') return await handleReplay(shaped, runtime, { inspectFailure });
    if (action === 'flags') return await handleFlags(shaped, runtime);
    return await handleAsk(shaped, runtime);
  } catch (error: any) {
    return writeFailure(error?.message || 'advice command failed', options.json);
  }
}

module.exports = { handleAdviseCommand };

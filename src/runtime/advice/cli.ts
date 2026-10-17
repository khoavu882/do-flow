'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

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
const { materializeKind, validateQuestionSet, validateStaticAnswer } = require('./kinds.ts');
const { findPick, appendOutcome } = require('./record.ts');
const { strengthWords } = require('./strength.ts');
const { projectLayerSource } = require('../settings/project-layers.ts');

function loadSources(repoRoot: any) {
  const read = (name: any) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'core/registry', name), 'utf8'));
  return {
    workflows: read('workflows.json'),
    verification: read('verification.json'),
    mcp: read('mcp.json'),
  };
}

function loadRuntime({ projectRoot, global = false }: any = {}) {
  const advice = loadAdviceRegistry({ repoRoot: REPO_ROOT });
  const storage = loadStorageRegistry({ repoRoot: REPO_ROOT });
  const roots = resolveRoots({ registry: storage, projectRoot, global });
  const projectLayers = projectLayerSource(projectRoot);
  const sources = loadSources(REPO_ROOT);
  const adviceRegistry = advice.ok ? advice.registry : null;
  return { adviceRegistry, adviceError: advice.ok ? null : advice.detail, storage, roots, sources, projectLayers };
}

function emitDeprecatedNotes(runtime: any): void {
  if (!runtime.adviceRegistry) return;
  const setting = resolveSetting({ adviceRegistry: runtime.adviceRegistry, roots: runtime.roots, fsImpl: fs, includeDeprecated: true });
  for (const note of setting.notes || []) {
    if (/ is deprecated; set ".+" in .+ \(read through 2\.x\)$/.test(note)) console.error(`note: ${note}`);
  }
}

function emitResult(result: any, { json, kind }: any) {
  if (result.reason === 'over-limit') {
    return usageError('advise', result.detail || 'request exceeds an advice limit', json);
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === 'answered') {
    for (const answer of result.answers) {
      const staticText = answer.staticAnswer === null ? '' : ` Static answer: ${answer.staticAnswer}.`;
      console.log(`Advice (${kind}): ${answer.pick}, ${strengthWords(answer.strength)}.${staticText}`);
    }
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
    return `advise: Ollama did not answer at ${endpoint}; start it yourself and re-run. Nothing was written.`;
  }
  if (!inspected.endpoint.versionOk) {
    return `advise: Ollama ${inspected.endpoint.version || 'unknown'} at ${endpoint} is older than ${provider.minVersion}. Nothing was written.`;
  }
  if (!inspected.model.installed) {
    return `advise: model ${model} is not installed; run 'ollama pull ${model}' yourself. Nothing was written.`;
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
  emitDeprecatedNotes(runtime);

  const file = project
    ? path.join(projectLayers.layersFrom || roots['project-doflow'], 'settings.json')
    : path.join(roots['config-home'], 'settings.json');
  const fsImpl = fs;
  const inheritedFromMain = !!project && projectLayers.checkout === 'main';
  const discloseWrite = (setting: any) => {
    const result: any = { written: file, setting };
    if (inheritedFromMain) result.inheritedFromMainCheckout = true;
    if (json) console.log(JSON.stringify(result, null, 2));
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
  const { adviceRegistry, adviceError, roots, sources } = runtime;
  if (adviceError || !adviceRegistry) {
    const result = {
      status: 'off', reason: 'config-invalid', detail: adviceError || 'advice registry is missing',
      provider: null, model: null, endpoint: null, decidedBy: { user: null, project: null }, durationMs: 0, answers: [],
    };
    return emitResult(result, { json: options.json, kind: options.kind || 'adhoc' });
  }

  let kind = 'adhoc';
  let questionSet;
  let questionError = null;
  if (parsed.hasKind) {
    kind = options.kind;
    const built = materializeKind(kind, { adviceRegistry, sources, server: options.server });
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

  const client = createAdviceClient({ adviceRegistry, roots, sources });
  const result = await client.ask({
    questionSet, kind, staticAnswer: options.staticAnswer, caller: 'advise', taskId: options.taskId,
    record: true,
  });
  // Preserve the kind materialiser's source-specific diagnostic while the client owns miss recording.
  if (questionError && result.reason === 'config-invalid') result.detail = questionError;
  return emitResult(result, { json: options.json, kind });
}

function handleOutcome(options: any, runtime: any) {
  const { json } = options;
  if (typeof options.pickId !== 'string' || !options.pickId) return usageError('advise', '--pick-id is required', json);
  if (typeof options.actual !== 'string' || !options.actual) return usageError('advise', '--actual is required', json);
  const found = findPick({ pickId: options.pickId, roots: runtime.roots });
  if (!found) {
    if (json) console.log(JSON.stringify({ ok: false, error: 'not-found', message: `no pick ${options.pickId} in the retained record` }, null, 2));
    else console.error(`advise: no pick ${options.pickId} in the retained record`);
    return finishRuntime(1);
  }
  if (!found.pick.options?.includes(options.actual)) {
    return usageError('advise', `--actual must be one of: ${found.pick.options.join(', ')}`, json);
  }
  const written = appendOutcome({
    pickId: options.pickId, actual: options.actual, source: 'caller', roots: runtime.roots, store: found.store,
  });
  if (!written) return writeFailure(`could not record outcome for ${options.pickId}`, json);
  if (json) console.log(JSON.stringify({ pickId: options.pickId, actual: options.actual, recorded: true, file: written.file }, null, 2));
  else console.log(`Recorded outcome ${options.actual} for ${options.pickId}.`);
  return finishRuntime(0);
}

async function handleAdviseCommand(options: any = {}) {
  const action = options.actionGiven ? options.action : 'ask';
  if (!['ask', 'outcome', 'configure'].includes(action)) return usageError('advise', `unknown action '${action}'`, options.json);
  try {
    const projectRoot = options.global ? null : path.resolve(options.projectRoot || process.cwd());
    const runtime = loadRuntime({ projectRoot, global: options.global });
    const shaped = { ...options, projectRoot };
    if (action === 'configure') return await handleConfigure(shaped, runtime);
    if (action === 'outcome') return handleOutcome(shaped, runtime);
    emitDeprecatedNotes(runtime);
    return await handleAsk(shaped, runtime);
  } catch (error: any) {
    return writeFailure(error?.message || 'advice command failed', options.json);
  }
}

module.exports = { handleAdviseCommand };

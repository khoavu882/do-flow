'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const ADVICE_FILE = 'core/registry/advice.json';
const MODELS_FILE = 'core/registry/models.json';
const ADAPTER_DIR = 'src/runtime/advice/providers';
// The adapter is a sibling module of this file, so it has this file's own extension: `.ts` in a
// checkout, `.js` in the package `build:package` stages (every module there is stripped to `.js`).
const ADAPTER_EXT = path.extname(__filename);
const TIER_KIND = 'tier';
const CALL_BUILT = 'call';
const MODES = ['off', 'shadow', 'act'];
// The rerank label alphabet (rerank.ts LABELS): at most this many candidates.
const RERANK_LABELS = 16;
const LADDER_LEVELS = 5;
// The exclusive upper bound of each threshold list: a probability, and a score on the 0 to 4 ladder.
const THRESHOLD_LISTS: Record<string, number> = { confidenceBelow: 1, expectedBelow: 4 };
const LIMIT_FIELDS = ['maxStateBytes', 'maxBodyBytes', 'minQuestions', 'maxQuestions', 'minOptions', 'maxOptions'];
const BAND_FIELDS: Record<string, string[]> = {
  choice: ['clearAt', 'splitWithin'],
  yesno: ['clearAbove', 'clearBelow', 'splitFrom', 'splitTo'],
};

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addError(errors: string[], key: string, message: string): void {
  errors.push(`${key} ${message}`);
}

function isNumber(value: any): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

// The pass bar (141 IC-001). Optional: a registry without it loads, and every verdict then reads as stale.
function validateGate(gate: any, errors: string[]): void {
  if (!isObject(gate)) { addError(errors, 'gate', 'must be an object'); return; }
  if (!Number.isInteger(gate.version) || gate.version < 1) addError(errors, 'gate.version', 'must be an integer of at least 1');
  if (gate.illustrative !== true) addError(errors, 'gate.illustrative', 'must be true');
  if (!Number.isInteger(gate.minCases) || gate.minCases < 1) addError(errors, 'gate.minCases', 'must be an integer of at least 1');
  if (!isNumber(gate.validShareMin) || gate.validShareMin <= 0 || gate.validShareMin > 1) {
    addError(errors, 'gate.validShareMin', 'must be a number above 0 and at most 1');
  }
  const quality = gate.quality;
  if (!isObject(quality)) {
    addError(errors, 'gate.quality', 'must be an object');
  } else {
    if (!isNumber(quality.lowerBoundAbove)) addError(errors, 'gate.quality.lowerBoundAbove', 'must be a finite number');
    if (!isNumber(quality.nonInferiorityDelta) || quality.nonInferiorityDelta < 0) {
      addError(errors, 'gate.quality.nonInferiorityDelta', 'must be a number of at least 0');
    }
    if (!isNumber(quality.confidence) || quality.confidence <= 0 || quality.confidence > 1) {
      addError(errors, 'gate.quality.confidence', 'must be a number above 0 and at most 1');
    }
    if (!Number.isInteger(quality.resamples) || quality.resamples < 1000) addError(errors, 'gate.quality.resamples', 'must be an integer of at least 1000');
    if (!Number.isInteger(quality.seed)) addError(errors, 'gate.quality.seed', 'must be an integer');
  }
  const latency = gate.latency;
  if (!isObject(latency)) {
    addError(errors, 'gate.latency', 'must be an object');
  } else {
    const caps = latency.p95CapMs;
    if (!isObject(caps) || !Number.isInteger(caps.default)) {
      addError(errors, 'gate.latency.p95CapMs', 'must be an object with an integer default');
    } else {
      for (const [id, cap] of Object.entries(caps)) {
        if (!Number.isInteger(cap) || (cap as number) <= 0) addError(errors, 'gate.latency.p95CapMs', `${id} must be a positive integer`);
      }
    }
    if (!isNumber(latency.ratioMax) || latency.ratioMax < 1) addError(errors, 'gate.latency.ratioMax', 'must be a number of at least 1');
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isPositiveInteger(value: any): boolean {
  return Number.isInteger(value) && value > 0;
}

// `scoreLadder` (141 IC-001): the five ladder levels and the instruction that names the candidate by `<label>`.
function validateScoreLadder(ladder: any, kind: any, base: string, errors: string[]): void {
  if (!isObject(ladder)) { addError(errors, `${base}.scoreLadder`, 'must be an object'); return; }
  if (typeof ladder.instructions !== 'string' || !ladder.instructions.includes('<label>')) {
    addError(errors, `${base}.scoreLadder.instructions`, 'must be a string that contains <label>');
  }
  const criteria = ladder.criteria;
  if (!Array.isArray(criteria) || criteria.length !== LADDER_LEVELS
    || criteria.some((line: any) => typeof line !== 'string' || !line.trim()) || new Set(criteria).size !== LADDER_LEVELS) {
    addError(errors, `${base}.scoreLadder.criteria`, `must be exactly ${LADDER_LEVELS} distinct non-empty strings`);
  } else if (isPositiveInteger(kind.params?.criteriaBytes)
    && criteria.reduce((sum: number, line: string) => sum + utf8Bytes(line), 0) > kind.params.criteriaBytes) {
    addError(errors, `${base}.scoreLadder.criteria`, 'must total at most params.criteriaBytes bytes');
  }
}

// `thresholds` (141 IC-001): counted by the report and the gate runner, applied to nothing.
function validateThresholds(thresholds: any, base: string, errors: string[]): void {
  if (!isObject(thresholds)) { addError(errors, `${base}.thresholds`, 'must be an object'); return; }
  if (thresholds.illustrative !== true) addError(errors, `${base}.thresholds.illustrative`, 'must be true');
  for (const [field, upper] of Object.entries(THRESHOLD_LISTS)) {
    const list = thresholds[field];
    if (!Array.isArray(list) || list.length > 6 || list.some((value: any) => !isNumber(value) || value <= 0 || value >= upper)) {
      addError(errors, `${base}.thresholds.${field}`, `must be a list of at most 6 numbers above 0 and below ${upper}`);
    }
  }
}

// `params` of the rerank kind (141 IC-001), with the two request-size rules against limits.maxBodyBytes.
function validateRerankParams(params: any, limits: any, base: string, errors: string[]): void {
  if (!['choice', 'ladder'].includes(params.arm)) addError(errors, `${base}.params.arm`, 'must be choice or ladder');
  for (const field of ['minCandidates', 'maxCandidates', 'candidateBytes', 'queryBytes', 'criteriaBytes']) {
    if (!isPositiveInteger(params[field])) addError(errors, `${base}.params.${field}`, 'must be a positive integer');
  }
  if (Number.isInteger(params.minCandidates) && Number.isInteger(limits?.minOptions) && params.minCandidates < limits.minOptions) {
    addError(errors, `${base}.params.minCandidates`, 'must be at least limits.minOptions');
  }
  if (Number.isInteger(params.minCandidates) && Number.isInteger(params.maxCandidates) && params.minCandidates > params.maxCandidates) {
    addError(errors, `${base}.params.minCandidates`, 'must not exceed params.maxCandidates');
  }
  if (Number.isInteger(params.maxCandidates)) {
    if (params.maxCandidates > RERANK_LABELS) addError(errors, `${base}.params.maxCandidates`, `must be at most ${RERANK_LABELS}`);
    if (Number.isInteger(limits?.maxOptions) && params.maxCandidates > limits.maxOptions) {
      addError(errors, `${base}.params.maxCandidates`, 'must be at most limits.maxOptions');
    }
  }
  const { maxCandidates, candidateBytes, queryBytes, criteriaBytes } = params;
  const maxBody = limits?.maxBodyBytes;
  if ([maxCandidates, candidateBytes, queryBytes, criteriaBytes, maxBody].every(isPositiveInteger)) {
    if (maxCandidates * candidateBytes + queryBytes > maxBody / 2) {
      addError(errors, `${base}.params`, 'maxCandidates * candidateBytes + queryBytes must be at most half of limits.maxBodyBytes (choice arm)');
    }
    if (maxCandidates * (candidateBytes + criteriaBytes) + queryBytes > (maxBody * 3) / 4) {
      addError(errors, `${base}.params`, 'maxCandidates * (candidateBytes + criteriaBytes) + queryBytes must be at most three quarters of limits.maxBodyBytes (ladder arm)');
    }
  }
}

// `params` of the claim-support kind (141 IC-001): both byte caps, and the state they build must fit limits.maxStateBytes.
const CLAIM_STATE_OVERHEAD = 64;
function validateClaimSupportParams(params: any, limits: any, base: string, errors: string[]): void {
  for (const field of ['claimBytes', 'passageBytes']) {
    if (!isPositiveInteger(params[field])) addError(errors, `${base}.params.${field}`, 'must be a positive integer');
  }
  if (isPositiveInteger(params.claimBytes) && isPositiveInteger(params.passageBytes) && isPositiveInteger(limits?.maxStateBytes)
    && params.claimBytes + params.passageBytes + CLAIM_STATE_OVERHEAD > limits.maxStateBytes) {
    addError(errors, `${base}.params`, `claimBytes + passageBytes + ${CLAIM_STATE_OVERHEAD} must be at most limits.maxStateBytes`);
  }
}

function validateCallBuiltFields(kind: any, registry: any, base: string, errors: string[]): void {
  const callBuilt = kind.criteriaFrom === CALL_BUILT;
  if (Object.hasOwn(kind, 'maxMode') && !MODES.includes(kind.maxMode)) addError(errors, `${base}.maxMode`, `must be one of ${MODES.join(', ')}`);
  if (Object.hasOwn(kind, 'budgetMs')
    && (!Number.isInteger(kind.budgetMs) || kind.budgetMs < 100 || (Number.isInteger(registry.timeoutMs) && kind.budgetMs > registry.timeoutMs))) {
    addError(errors, `${base}.budgetMs`, 'must be an integer from 100 to timeoutMs');
  }
  if (Object.hasOwn(kind, 'description') && (typeof kind.description !== 'string' || !kind.description.trim())) {
    addError(errors, `${base}.description`, 'must be a non-empty string');
  }
  if (Object.hasOwn(kind, 'params')) {
    const params = kind.params;
    if (!callBuilt && !Object.hasOwn(kind, 'maxMode')) {
      addError(errors, `${base}.params`, 'is allowed only with criteriaFrom call or maxMode');
    } else if (!isObject(params)) {
      addError(errors, `${base}.params`, 'must be an object');
    } else if (kind.id === 'rerank') {
      validateRerankParams(params, registry.limits, base, errors);
    } else if (kind.id === 'claim-support') {
      validateClaimSupportParams(params, registry.limits, base, errors);
    } else {
      for (const [field, value] of Object.entries(params)) {
        if (field !== 'arm' && !isPositiveInteger(value)) addError(errors, `${base}.params.${field}`, 'must be a positive integer');
      }
    }
  }
  if (Object.hasOwn(kind, 'scoreLadder')) validateScoreLadder(kind.scoreLadder, kind, base, errors);
  else if (callBuilt && isObject(kind.params) && Object.hasOwn(kind.params, 'arm')) {
    addError(errors, `${base}.scoreLadder`, 'is required on a criteriaFrom call kind that offers the ladder arm');
  }
  if (Object.hasOwn(kind, 'thresholds')) validateThresholds(kind.thresholds, base, errors);
}

function validateAdviceRegistry(registry: any, { repoRoot = REPO_ROOT, models, fsImpl = fs }: any = {}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(registry)) return { ok: false, errors: ['registry must be an object'] };

  if (registry.version !== 1) addError(errors, 'version', 'must be 1');
  for (const key of ['timeoutMs', 'probeTimeoutMs']) {
    if (!Number.isInteger(registry[key]) || registry[key] < 100 || registry[key] > 30000) {
      addError(errors, key, 'must be an integer from 100 to 30000');
    }
  }
  if (!Number.isInteger(registry.doctorBudgetMs) || registry.doctorBudgetMs <= 0) {
    addError(errors, 'doctorBudgetMs', 'must be a positive integer');
  }

  const limits = registry.limits;
  if (!isObject(limits)) {
    addError(errors, 'limits', 'must be an object');
  } else {
    for (const field of LIMIT_FIELDS) {
      if (!Number.isInteger(limits[field]) || limits[field] <= 0) addError(errors, `limits.${field}`, 'must be a positive integer');
    }
    for (const [min, max] of [['minQuestions', 'maxQuestions'], ['minOptions', 'maxOptions']]) {
      if (Number.isInteger(limits[min]) && Number.isInteger(limits[max]) && limits[min] > limits[max]) {
        addError(errors, `limits.${min}`, `must not exceed limits.${max}`);
      }
    }
    if (Number.isInteger(limits.maxBodyBytes) && limits.maxBodyBytes >= 65536) {
      addError(errors, 'limits.maxBodyBytes', 'must be below 65536');
    }
    if (Number.isInteger(limits.maxOptions) && limits.maxOptions > 26) {
      addError(errors, 'limits.maxOptions', 'must be at most 26');
    }
    if (typeof limits.questionName !== 'string') {
      addError(errors, 'limits.questionName', 'must be a regular expression string');
    } else {
      try { new RegExp(limits.questionName); } catch { addError(errors, 'limits.questionName', 'must compile'); }
    }
  }

  const strength = registry.strength;
  if (!isObject(strength)) {
    addError(errors, 'strength', 'must be an object');
  } else {
    for (const [type, fields] of Object.entries(BAND_FIELDS)) {
      const bands = strength[type];
      if (!isObject(bands)) {
        addError(errors, `strength.${type}`, 'must be an object');
        continue;
      }
      for (const field of fields) {
        if (typeof bands[field] !== 'number' || !Number.isFinite(bands[field]) || bands[field] < 0 || bands[field] > 1) {
          addError(errors, `strength.${type}.${field}`, 'must be a number from 0 to 1');
        }
      }
    }
    const yesno = strength.yesno;
    if (isObject(yesno) && ['clearBelow', 'splitFrom', 'splitTo', 'clearAbove'].every((field: string) => typeof yesno[field] === 'number')) {
      if (!(yesno.clearBelow < yesno.splitFrom && yesno.splitFrom < yesno.splitTo && yesno.splitTo < yesno.clearAbove)) {
        addError(errors, 'strength.yesno', 'bands must satisfy clearBelow < splitFrom < splitTo < clearAbove');
      }
    }
  }

  if (Object.hasOwn(registry, 'gate')) validateGate(registry.gate, errors);

  if (!models) {
    try { models = JSON.parse(fsImpl.readFileSync(path.join(repoRoot, MODELS_FILE), 'utf8')); }
    catch (error: any) { addError(errors, MODELS_FILE, `could not be loaded: ${error.message}`); }
  }
  const modelProviders = Array.isArray(models?.providers) ? new Set(models.providers.map((provider: any) => provider?.id).filter((id: any) => typeof id === 'string')) : new Set();

  if (!Array.isArray(registry.providers) || registry.providers.length === 0) {
    addError(errors, 'providers', 'must be a non-empty array');
  } else {
    const adapterRoot = path.resolve(repoRoot, ADAPTER_DIR);
    registry.providers.forEach((provider: any, index: number) => {
      const base = `providers[${index}]`;
      if (!isObject(provider)) { addError(errors, base, 'must be an object'); return; }
      for (const field of ['id', 'adapter', 'modelProvider', 'defaultEndpoint', 'route', 'minVersion', 'capability']) {
        if (typeof provider[field] !== 'string' || !provider[field].trim()) addError(errors, `${base}.${field}`, 'must be a non-empty string');
      }
      if (typeof provider.adapter === 'string') {
        if (!/^[a-z][a-z0-9-]*$/.test(provider.adapter)) {
          addError(errors, `${base}.adapter`, 'must be a safe adapter id');
        } else {
          const adapterFile = path.resolve(adapterRoot, `${provider.adapter}${ADAPTER_EXT}`);
          if (!adapterFile.startsWith(`${adapterRoot}${path.sep}`) || !fsImpl.existsSync(adapterFile)) {
            addError(errors, `${base}.adapter`, `must name a file under ${ADAPTER_DIR}`);
          }
        }
      }
      if (typeof provider.modelProvider === 'string' && !modelProviders.has(provider.modelProvider)) {
        addError(errors, `${base}.modelProvider`, `must name a provider in ${MODELS_FILE}`);
      }
    });
  }

  if (!Array.isArray(registry.kinds) || registry.kinds.length === 0) {
    addError(errors, 'kinds', 'must be a non-empty array');
  } else {
    const ids = new Set();
    for (const [index, kind] of registry.kinds.entries()) {
      const base = `kinds[${index}]`;
      if (!isObject(kind)) { addError(errors, base, 'must be an object'); continue; }
      if (typeof kind.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(kind.id)) addError(errors, `${base}.id`, 'must be a safe kind id');
      else if (ids.has(kind.id)) addError(errors, `${base}.id`, `duplicates '${kind.id}'`);
      else ids.add(kind.id);
      if (!['choice', 'yesno'].includes(kind.type)) addError(errors, `${base}.type`, 'must be choice or yesno');
      if (typeof kind.instructions !== 'string' || !kind.instructions.trim()) addError(errors, `${base}.instructions`, 'must be a non-empty string');
      // A yes/no kind whose own `no` and `yes` texts are its options (claim-support, 141 IC-001) needs neither source.
      const ownOptions = kind.type === 'yesno' && !Object.hasOwn(kind, 'criteria') && !Object.hasOwn(kind, 'criteriaFrom');
      if (ownOptions) {
        for (const field of ['no', 'yes']) {
          if (typeof kind[field] !== 'string' || !kind[field].trim()) addError(errors, `${base}.${field}`, 'must be a non-empty string when the kind has no criteria or criteriaFrom');
        }
      } else if (Object.hasOwn(kind, 'criteria') === Object.hasOwn(kind, 'criteriaFrom')) {
        addError(errors, base, 'must have exactly one of criteria or criteriaFrom');
      }
      if (Object.hasOwn(kind, 'criteria') && (!isObject(kind.criteria) || Object.values(kind.criteria).some((value: any) => typeof value !== 'string' || !value.trim()))) {
        addError(errors, `${base}.criteria`, 'must map option ids to non-empty descriptions');
      }
      if (Object.hasOwn(kind, 'criteriaFrom') && (typeof kind.criteriaFrom !== 'string' || !kind.criteriaFrom.trim())) {
        addError(errors, `${base}.criteriaFrom`, 'must be a non-empty string');
      }
      validateCallBuiltFields(kind, registry, base, errors);
      if (typeof kind.staticFrom !== 'string') addError(errors, `${base}.staticFrom`, 'must be a string');
      if (!Array.isArray(kind.askedBy) || kind.askedBy.some((caller: any) => typeof caller !== 'string')) addError(errors, `${base}.askedBy`, 'must be an array of strings');
    }

    const tier = registry.kinds.find((kind: any) => kind?.id === TIER_KIND);
    const dispatchTiers = models?.dispatchTiers?.tiers;
    if (!tier || !isObject(tier.criteria) || !Array.isArray(dispatchTiers)
      || JSON.stringify(Object.keys(tier.criteria)) !== JSON.stringify(dispatchTiers)) {
      addError(errors, 'kinds.tier.criteria', 'keys must equal models.dispatchTiers.tiers in order');
    }
  }

  return { ok: errors.length === 0, errors };
}

function loadAdviceRegistry({ repoRoot = REPO_ROOT, file, fsImpl = fs }: any = {}): { ok: boolean; registry?: any; reason?: string; detail?: string } {
  const root = path.resolve(repoRoot);
  const target = file || path.join(root, ADVICE_FILE);
  let registry: any;
  try {
    registry = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  } catch (error: any) {
    return { ok: false, reason: 'config-invalid', detail: `${target}: ${error.message}` };
  }
  const validation = validateAdviceRegistry(registry, { repoRoot: root, fsImpl });
  if (!validation.ok) return { ok: false, reason: 'config-invalid', detail: validation.errors.join('; ') };
  return { ok: true, registry };
}

module.exports = { loadAdviceRegistry, validateAdviceRegistry };

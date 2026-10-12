'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const ADVICE_FILE = 'core/registry/advice.json';
const MODELS_FILE = 'core/registry/models.json';
const ADAPTER_DIR = 'src/runtime/advice/providers';
const TIER_KIND = 'tier';
const LIMIT_FIELDS = ['maxStateBytes', 'maxBodyBytes', 'minQuestions', 'maxQuestions', 'minOptions', 'maxOptions'];
const BAND_FIELDS = {
  choice: ['clearAt', 'splitWithin'],
  yesno: ['clearAbove', 'clearBelow', 'splitFrom', 'splitTo'],
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addError(errors, key, message) {
  errors.push(`${key} ${message}`);
}

function validateAdviceRegistry(registry, { repoRoot = REPO_ROOT, models, fsImpl = fs } = {}) {
  const errors = [];
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
    if (isObject(yesno) && ['clearBelow', 'splitFrom', 'splitTo', 'clearAbove'].every((field) => typeof yesno[field] === 'number')) {
      if (!(yesno.clearBelow < yesno.splitFrom && yesno.splitFrom < yesno.splitTo && yesno.splitTo < yesno.clearAbove)) {
        addError(errors, 'strength.yesno', 'bands must satisfy clearBelow < splitFrom < splitTo < clearAbove');
      }
    }
  }

  if (!models) {
    try { models = JSON.parse(fsImpl.readFileSync(path.join(repoRoot, MODELS_FILE), 'utf8')); }
    catch (error) { addError(errors, MODELS_FILE, `could not be loaded: ${error.message}`); }
  }
  const modelProviders = Array.isArray(models?.providers) ? new Set(models.providers.map((provider) => provider?.id).filter((id) => typeof id === 'string')) : new Set();

  if (!Array.isArray(registry.providers) || registry.providers.length === 0) {
    addError(errors, 'providers', 'must be a non-empty array');
  } else {
    const adapterRoot = path.resolve(repoRoot, ADAPTER_DIR);
    registry.providers.forEach((provider, index) => {
      const base = `providers[${index}]`;
      if (!isObject(provider)) { addError(errors, base, 'must be an object'); return; }
      for (const field of ['id', 'adapter', 'modelProvider', 'defaultEndpoint', 'route', 'minVersion', 'capability']) {
        if (typeof provider[field] !== 'string' || !provider[field].trim()) addError(errors, `${base}.${field}`, 'must be a non-empty string');
      }
      if (typeof provider.adapter === 'string') {
        if (!/^[a-z][a-z0-9-]*$/.test(provider.adapter)) {
          addError(errors, `${base}.adapter`, 'must be a safe adapter id');
        } else {
          const adapterFile = path.resolve(adapterRoot, `${provider.adapter}.js`);
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
      if (Object.hasOwn(kind, 'criteria') === Object.hasOwn(kind, 'criteriaFrom')) addError(errors, base, 'must have exactly one of criteria or criteriaFrom');
      if (Object.hasOwn(kind, 'criteria') && (!isObject(kind.criteria) || Object.values(kind.criteria).some((value) => typeof value !== 'string' || !value.trim()))) {
        addError(errors, `${base}.criteria`, 'must map option ids to non-empty descriptions');
      }
      if (Object.hasOwn(kind, 'criteriaFrom') && (typeof kind.criteriaFrom !== 'string' || !kind.criteriaFrom.trim())) {
        addError(errors, `${base}.criteriaFrom`, 'must be a non-empty string');
      }
      if (typeof kind.staticFrom !== 'string') addError(errors, `${base}.staticFrom`, 'must be a string');
      if (!Array.isArray(kind.askedBy) || kind.askedBy.some((caller) => typeof caller !== 'string')) addError(errors, `${base}.askedBy`, 'must be an array of strings');
    }

    const tier = registry.kinds.find((kind) => kind?.id === TIER_KIND);
    const dispatchTiers = models?.dispatchTiers?.tiers;
    if (!tier || !isObject(tier.criteria) || !Array.isArray(dispatchTiers)
      || JSON.stringify(Object.keys(tier.criteria)) !== JSON.stringify(dispatchTiers)) {
      addError(errors, 'kinds.tier.criteria', 'keys must equal models.dispatchTiers.tiers in order');
    }
  }

  return { ok: errors.length === 0, errors };
}

function loadAdviceRegistry({ repoRoot = REPO_ROOT, file, fsImpl = fs } = {}) {
  const root = path.resolve(repoRoot);
  const target = file || path.join(root, ADVICE_FILE);
  let registry;
  try {
    registry = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  } catch (error) {
    return { ok: false, reason: 'config-invalid', detail: `${target}: ${error.message}` };
  }
  const validation = validateAdviceRegistry(registry, { repoRoot: root, fsImpl });
  if (!validation.ok) return { ok: false, reason: 'config-invalid', detail: validation.errors.join('; ') };
  return { ok: true, registry };
}

module.exports = { loadAdviceRegistry, validateAdviceRegistry };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveSetting } = require('./config.ts');
const { resolveRoots } = require('../storage/roots.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');

type AdviceKindMode = 'off' | 'shadow' | 'act';

interface KindShadowConfig {
  kind: string;
  mode: AdviceKindMode;
  model: string | null;
  provider: string;
  endpoint: string;
  decidedBy: {
    mode: string | null;
    model: string | null;
  };
}

interface ShadowConfigOptions {
  projectRoot?: string;
  env?: Record<string, string>;
  fsImpl?: any;
  roots?: any;
  global?: boolean;
}

function getSettingValue(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.hasOwn(obj, key)) return obj[key];
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (!cur || typeof cur !== 'object') return undefined;
    const p = parts[i];
    if (Object.hasOwn(cur, p)) {
      cur = cur[p];
    } else {
      const rest = parts.slice(i).join('.');
      if (Object.hasOwn(cur, rest)) {
        return cur[rest];
      }
      return undefined;
    }
  }
  return cur;
}

function readJsonFile(filePath: string, fsImpl: any): any {
  try {
    const text = fsImpl.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveShadowConfig(
  kind: string,
  options?: ShadowConfigOptions
): KindShadowConfig {
  const fsImpl = options?.fsImpl || fs;
  const env = options?.env || (options?.projectRoot ? {} : process.env);
  const projectRoot = options?.projectRoot || process.cwd();

  let storageRegistry: any = null;
  try {
    const loaded = loadStorageRegistry({ fsImpl });
    if (loaded?.ok) storageRegistry = loaded.registry;
  } catch {
    // best-effort registry loading
  }

  let roots = options?.roots;
  if (!roots && storageRegistry) {
    try {
      roots = resolveRoots({ registry: storageRegistry, projectRoot, global: options?.global, env });
    } catch {
      roots = null;
    }
  }

  // 1. Resolve global advice setting (baseline defaults)
  let globalSetting: any = null;
  try {
    globalSetting = resolveSetting({
      roots,
      storageRegistry,
      projectRoot,
      global: options?.global,
      env,
      fsImpl,
    });
  } catch {
    globalSetting = null;
  }

  // 2. Discover configuration files across layers (project local -> project -> user)
  const candidateFiles: Array<{ layer: string; path: string }> = [];

  if (projectRoot) {
    candidateFiles.push({
      layer: 'local',
      path: path.join(projectRoot, '.doflow', 'settings.local.json'),
    });
    candidateFiles.push({
      layer: 'project',
      path: path.join(projectRoot, '.doflow', 'settings.json'),
    });
  }

  const userConfigDir = roots?.['config-home']
    ? path.join(roots['config-home'], 'doflow')
    : (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'doflow') : (env.HOME ? path.join(env.HOME, '.config', 'doflow') : null));

  if (userConfigDir) {
    candidateFiles.push({
      layer: 'user',
      path: path.join(userConfigDir, 'settings.json'),
    });
  }

  const loadedCandidates: Array<{ layer: string; filePath: string; content: any }> = [];
  for (const { layer, path: filePath } of candidateFiles) {
    const content = readJsonFile(filePath, fsImpl);
    if (content) {
      loadedCandidates.push({ layer, filePath, content });
    }
  }

  // Provider and endpoint: candidate files -> globalSetting -> defaults
  let resolvedProvider: string | null = null;
  let resolvedEndpoint: string | null = null;

  for (const { content } of loadedCandidates) {
    if (!resolvedProvider) {
      const p = getSettingValue(content, 'advice.provider');
      if (typeof p === 'string' && p.trim()) resolvedProvider = p.trim();
    }
    if (!resolvedEndpoint) {
      const ep = getSettingValue(content, 'advice.endpoint');
      if (typeof ep === 'string' && ep.trim()) resolvedEndpoint = ep.trim();
    }
  }

  const defaultProvider = resolvedProvider || globalSetting?.provider || 'ollama';
  const defaultEndpoint = resolvedEndpoint || globalSetting?.endpoint || 'http://127.0.0.1:11434';
  const defaultModel = globalSetting?.model || null;

  // 3. Check advice.enabled: if explicitly false in any candidate layer, force mode = 'off'
  let explicitDisabledBy: string | null = null;
  for (const { layer, filePath, content } of loadedCandidates) {
    const enabledVal = getSettingValue(content, 'advice.enabled');
    if (enabledVal === false) {
      explicitDisabledBy = `${layer}:${filePath}`;
      break;
    }
  }

  let resolvedMode: AdviceKindMode = 'off';
  let modeDecidedBy: string | null = null;

  if (explicitDisabledBy) {
    resolvedMode = 'off';
    modeDecidedBy = explicitDisabledBy;
  } else {
    // Resolve mode: advice.kinds.<kind>
    for (const { layer, filePath, content } of loadedCandidates) {
      const modeVal = getSettingValue(content, `advice.kinds.${kind}`);
      if (modeVal === 'act' || modeVal === 'shadow' || modeVal === 'off') {
        resolvedMode = modeVal as AdviceKindMode;
        modeDecidedBy = `${layer}:${filePath}`;
        break;
      }
    }
  }

  // 4. Resolve model: advice.models.<kind> / advice.model.<kind> -> advice.model (string) -> defaultModel
  let resolvedModel: string | null = null;
  let modelDecidedBy: string | null = null;

  // Check per-kind model override
  for (const { layer, filePath, content } of loadedCandidates) {
    const kindModel =
      getSettingValue(content, `advice.models.${kind}`) ??
      getSettingValue(content, `advice.model.${kind}`);
    if (typeof kindModel === 'string' && kindModel.trim()) {
      resolvedModel = kindModel.trim();
      modelDecidedBy = `${layer}:${filePath}`;
      break;
    }
  }

  // Fallback to general advice.model (string) from candidate files
  if (!resolvedModel) {
    for (const { layer, filePath, content } of loadedCandidates) {
      const generalModel = getSettingValue(content, 'advice.model');
      if (typeof generalModel === 'string' && generalModel.trim()) {
        resolvedModel = generalModel.trim();
        modelDecidedBy = `${layer}:${filePath}`;
        break;
      }
    }
  }

  // Fallback to defaultModel from global setting
  if (!resolvedModel) {
    resolvedModel = defaultModel;
    modelDecidedBy = globalSetting?.decidedBy?.project || globalSetting?.decidedBy?.user || null;
  }

  return {
    kind,
    mode: resolvedMode,
    model: resolvedModel,
    provider: defaultProvider,
    endpoint: defaultEndpoint,
    decidedBy: {
      mode: modeDecidedBy,
      model: modelDecidedBy,
    },
  };
}

module.exports = {
  resolveShadowConfig,
};

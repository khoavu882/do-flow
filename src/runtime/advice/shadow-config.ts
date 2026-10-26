'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveSetting } = require('./config.ts');
const { resolveRoots } = require('../storage/roots.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { configHome } = require('../config-home.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

type AdviceKindMode = 'off' | 'shadow' | 'act';

interface KindShadowConfig {
  kind: string;
  mode: AdviceKindMode;
  /**
   * true when a settings layer has `advice.kinds.<kind>`, valid or not, or a layer could not be read; callers route
   * through the dispatcher only then, so an unreadable config never takes the legacy ask.
   */
  kindSet: boolean;
  model: string | null;
  decidedBy: {
    mode: string | null;
    model: string | null;
  };
  /** Why the mode is off when a layer could not be read or held an invalid value; empty otherwise. */
  diagnostics: string[];
}

interface ShadowConfigOptions {
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  fsImpl?: any;
  roots?: Record<string, string> | null;
  global?: boolean;
}

type LayerRead = { content: Record<string, unknown> } | { missing: true } | { error: string };

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

/** An absent file is missing; an unreadable file, bad JSON or a non-object value is an error (fail closed). */
function readJsonFile(filePath: string, fsImpl: any): LayerRead {
  let text: string;
  try {
    text = fsImpl.readFileSync(filePath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { missing: true };
    return { error: `could not be read (${error?.code || error?.message || 'unknown error'})` };
  }
  try {
    const content = JSON.parse(text);
    if (!content || typeof content !== 'object' || Array.isArray(content)) return { error: 'is not a JSON object' };
    return { content };
  } catch {
    return { error: 'is not valid JSON' };
  }
}

function resolveShadowConfig(
  kind: string,
  options?: ShadowConfigOptions
): KindShadowConfig {
  const fsImpl = options?.fsImpl || fs;
  const env = options?.env ?? process.env;
  const projectRoot = options?.projectRoot || process.cwd();

  let storageRegistry: any = null;
  try {
    storageRegistry = loadStorageRegistry({ repoRoot: REPO_ROOT, fsImpl });
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

  // 1. The advice setting's model is the fallback when no layer names one for this kind.
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

  const userHome = roots?.['config-home'] || configHome(env).dir;
  const userConfigDir = userHome;

  if (userConfigDir) {
    candidateFiles.push({
      layer: 'user',
      path: path.join(userConfigDir, 'settings.json'),
    });
  }

  const loadedCandidates: Array<{ layer: string; filePath: string; content: any }> = [];
  const diagnostics: string[] = [];
  for (const { layer, path: filePath } of candidateFiles) {
    const read = readJsonFile(filePath, fsImpl);
    if ('content' in read) loadedCandidates.push({ layer, filePath, content: read.content });
    else if ('error' in read) diagnostics.push(`${layer} settings ${filePath} ${read.error}; advice.kinds.${kind} is off`);
  }

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

  const kindSet = diagnostics.length > 0
    || loadedCandidates.some(({ content }) => getSettingValue(content, `advice.kinds.${kind}`) !== undefined);
  let resolvedMode: AdviceKindMode = 'off';
  let modeDecidedBy: string | null = null;

  if (explicitDisabledBy) {
    resolvedMode = 'off';
    modeDecidedBy = explicitDisabledBy;
  } else if (diagnostics.length === 0) {
    // The first layer that has advice.kinds.<kind> decides; an invalid value there is off, never a lower layer's value.
    for (const { layer, filePath, content } of loadedCandidates) {
      const modeVal = getSettingValue(content, `advice.kinds.${kind}`);
      if (modeVal === undefined) continue;
      modeDecidedBy = `${layer}:${filePath}`;
      if (modeVal === 'act' || modeVal === 'shadow' || modeVal === 'off') resolvedMode = modeVal;
      else diagnostics.push(`${layer} settings ${filePath} has invalid advice.kinds.${kind} ${JSON.stringify(modeVal)} (expected off, shadow or act); it is off`);
      break;
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
    kindSet,
    model: resolvedModel,
    decidedBy: {
      mode: modeDecidedBy,
      model: modelDecidedBy,
    },
    diagnostics,
  };
}

module.exports = {
  resolveShadowConfig,
};

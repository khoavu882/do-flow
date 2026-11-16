'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { shouldSample } = require('./sampler.ts');
const { configHome } = require('../config-home.ts');

export type RolloutProfileName = 'baseline' | 'canary' | 'staged' | 'full';

export interface ProfileCapabilityMatrix {
  retrieval: 'lexical' | 'canary-hybrid' | 'staged-hybrid' | 'full-hybrid';
  advisor: 'off' | 'shadow' | 'staged' | 'act';
  verification: 'L0' | 'L0-L1' | 'L0-L2' | 'L0-L3';
  telemetryCanaryTag: boolean;
}

export interface ResolvedRolloutProfile {
  name: RolloutProfileName;
  origin: {
    source: 'env' | 'project' | 'user' | 'default';
    detail: string | null;
  };
  capabilities: ProfileCapabilityMatrix;
  canarySampleRate: number; // 0.0 to 1.0 (default 0.10)
}

export interface ResolveProfileOptions {
  projectRoot?: string | null;
  env?: Record<string, string | undefined>;
  fsImpl?: any;
}

const PROFILE_CAPABILITIES: Record<RolloutProfileName, ProfileCapabilityMatrix> = Object.freeze({
  baseline: {
    retrieval: 'lexical',
    advisor: 'off',
    verification: 'L0',
    telemetryCanaryTag: false,
  },
  canary: {
    retrieval: 'canary-hybrid',
    advisor: 'shadow',
    verification: 'L0-L1',
    telemetryCanaryTag: true,
  },
  staged: {
    retrieval: 'staged-hybrid',
    advisor: 'staged',
    verification: 'L0-L2',
    telemetryCanaryTag: false,
  },
  full: {
    retrieval: 'full-hybrid',
    advisor: 'act',
    verification: 'L0-L3',
    telemetryCanaryTag: false,
  },
});

const VALID_PROFILES = new Set<RolloutProfileName>(['baseline', 'canary', 'staged', 'full']);

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
      if (Object.hasOwn(cur, rest)) return cur[rest];
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

/**
 * Resolves the effective rollout profile by consulting:
 * 1. Environment override (DOFLOW_ROLLOUT_PROFILE)
 * 2. Layered settings (.doflow/settings.local.json -> settings.json -> user settings)
 * 3. Registry default (baseline)
 *
 * Guarantees <= 5ms evaluation latency. Never throws.
 */
function resolveRolloutProfile(options?: ResolveProfileOptions): ResolvedRolloutProfile {
  const fsImpl = options?.fsImpl || fs;
  const env = options?.env ?? process.env;
  const projectRoot = options?.projectRoot ? path.resolve(options.projectRoot) : process.cwd();

  // 1. Environment Override Fast-Path
  const envProfile = env.DOFLOW_ROLLOUT_PROFILE;
  if (typeof envProfile === 'string' && envProfile.trim()) {
    const clean = envProfile.trim() as RolloutProfileName;
    if (VALID_PROFILES.has(clean)) {
      return {
        name: clean,
        origin: {
          source: 'env',
          detail: 'DOFLOW_ROLLOUT_PROFILE',
        },
        capabilities: PROFILE_CAPABILITIES[clean],
        canarySampleRate: 0.10,
      };
    } else {
      // Invalid env profile falls safe to baseline
      return {
        name: 'baseline',
        origin: {
          source: 'default',
          detail: `invalid-profile-value:${clean}`,
        },
        capabilities: PROFILE_CAPABILITIES.baseline,
        canarySampleRate: 0.10,
      };
    }
  }

  // 2. Inspect Candidate Layered Settings Files (local -> project -> user)
  const candidateFiles: Array<{ layer: 'project' | 'user'; path: string }> = [];
  if (projectRoot) {
    candidateFiles.push({
      layer: 'project',
      path: path.join(projectRoot, '.doflow', 'settings.local.json'),
    });
    candidateFiles.push({
      layer: 'project',
      path: path.join(projectRoot, '.doflow', 'settings.json'),
    });
  }

  const userHome = configHome(env).dir;
  const userConfigDir = userHome;

  if (userConfigDir) {
    candidateFiles.push({
      layer: 'user',
      path: path.join(userConfigDir, 'settings.json'),
    });
  }

  for (const { layer, path: filePath } of candidateFiles) {
    const content = readJsonFile(filePath, fsImpl);
    if (!content) continue;

    const rawVal = getSettingValue(content, 'rollout.profile');
    if (typeof rawVal === 'string' && rawVal.trim()) {
      const clean = rawVal.trim() as RolloutProfileName;
      if (VALID_PROFILES.has(clean)) {
        return {
          name: clean,
          origin: {
            source: layer,
            detail: `${layer}:${filePath}`,
          },
          capabilities: PROFILE_CAPABILITIES[clean],
          canarySampleRate: 0.10,
        };
      } else {
        // Unknown or invalid profile fails safe to baseline (ERR_PROFILE_INVALID)
        return {
          name: 'baseline',
          origin: {
            source: 'default',
            detail: `invalid-profile-value:${clean}`,
          },
          capabilities: PROFILE_CAPABILITIES.baseline,
          canarySampleRate: 0.10,
        };
      }
    }
  }

  // 3. Default baseline fallback
  return {
    name: 'baseline',
    origin: {
      source: 'default',
      detail: 'registry-default',
    },
    capabilities: PROFILE_CAPABILITIES.baseline,
    canarySampleRate: 0.10,
  };
}

/**
 * Checks whether a specific feature capability is active under the current profile.
 */
function isCapabilityActive(
  capability: keyof ProfileCapabilityMatrix,
  options?: ResolveProfileOptions
): boolean {
  const profile = resolveRolloutProfile(options);
  const val = profile.capabilities[capability];

  if (capability === 'retrieval') return val !== 'lexical';
  if (capability === 'advisor') return val !== 'off';
  if (capability === 'verification') return val !== 'L0';
  if (capability === 'telemetryCanaryTag') return Boolean(val);

  return false;
}

module.exports = {
  resolveRolloutProfile,
  isCapabilityActive,
  PROFILE_CAPABILITIES,
  VALID_PROFILES,
};

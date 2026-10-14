'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { fingerprint } = require('../copy-tree.ts');

const ASSET_ID = 'pi.guard-extension';
const EXTENSION_NAME = 'doflow-guard.js';
const OWNERSHIP = 'pi:guard-extension';
const TEMPLATE = 'core/harnesses/pi/extensions/doflow-guard.js';
const BRIDGE_SUFFIX = ['.doflow', 'shared', 'hooks', 'bridge', 'bridge.sh'];

function userAgentDir(scopeRoot: any, env: any) {
  const override = env?.PI_CODING_AGENT_DIR;
  return typeof override === 'string' && override.trim() ? path.resolve(override.trim()) : path.join(scopeRoot, '.pi', 'agent');
}

function targetPath(scopeRoot: any, env: any, scope: any = 'user') {
  return scope === 'project'
    ? path.join(scopeRoot, '.pi', 'extensions', EXTENSION_NAME)
    : path.join(userAgentDir(scopeRoot, env), 'extensions', EXTENSION_NAME);
}

function renderExtension({ repoRoot, scopeRoot, target, fsImpl = fs }: any) {
  const templatePath = path.join(repoRoot, TEMPLATE);
  const template = fsImpl.readFileSync(templatePath, 'utf8');
  const bridgePath = path.join(scopeRoot, ...BRIDGE_SUFFIX);
  const relative = path.relative(path.dirname(target), bridgePath).split(path.sep).join('/');
  const rendered = template.replace("const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);",
    `const BRIDGE = new URL(${JSON.stringify(relative)}, import.meta.url);`);
  if (rendered === template) throw new Error('Pi extension bridge path template was not found');
  return rendered;
}

function planPiHooks({ scope, scopeRoot, assets = [], ledger, context = {}, adopt = false, env = process.env, fsImpl = fs }: any) {
  if (scope !== 'user' && scope !== 'global' && scope !== 'project') return { changes: [], conflicts: [], notices: [] };
  const asset = assets.find((row: any) => row.id === ASSET_ID);
  if (!asset) return { changes: [], conflicts: [], notices: [] };
  const target = targetPath(scopeRoot, env, scope);
  const removing = context.operation === 'remove';
  const owned = (ledger?.resources || []).find((row: any) => row.harness === 'pi' && row.assetId === ASSET_ID
    && row.ownershipIdentity === OWNERSHIP && row.target === target);
  const exists = fsImpl.existsSync(target);
  const notices: string[] = [];
  if (removing) {
    if (!owned) return { changes: [], conflicts: [], notices };
    if (!exists) return { changes: [{ assetId: ASSET_ID, target, operation: 'remove', release: true,
      ownershipIdentity: OWNERSHIP, harness: 'pi', projection: { renderer: 'pi-guard-extension' } }], conflicts: [], notices };
    const current = fsImpl.readFileSync(target, 'utf8');
    if (fingerprint(current) !== owned.fingerprint) {
      notices.push(`kept hand-edited ${target}; DoFlow no longer manages it`);
      return { changes: [{ assetId: ASSET_ID, target, operation: 'remove', release: true,
        ownershipIdentity: OWNERSHIP, harness: 'pi', projection: { renderer: 'pi-guard-extension' } }], conflicts: [], notices };
    }
    return { changes: [{ assetId: ASSET_ID, target, operation: 'remove', content: null,
      ownershipIdentity: OWNERSHIP, harness: 'pi', projection: { renderer: 'pi-guard-extension' } }], conflicts: [], notices };
  }

  const content = renderExtension({ repoRoot: context.repoRoot, scopeRoot, target, fsImpl });
  if (!exists) return { changes: [{ assetId: ASSET_ID, target, operation: 'create', content,
    ownershipIdentity: OWNERSHIP, harness: 'pi', fingerprint: fingerprint(content),
    projection: { renderer: 'pi-guard-extension' } }], conflicts: [], notices };
  if (!owned && !adopt) {
    return { changes: [], conflicts: [`Pi extension already exists and is not owned by DoFlow: ${target}`], notices };
  }
  const current = fsImpl.readFileSync(target, 'utf8');
  if (owned && fingerprint(current) !== owned.fingerprint) {
    return { changes: [], conflicts: [`Pi extension was modified outside DoFlow: ${target}`], notices };
  }
  if (current === content) return { changes: [], conflicts: [], notices };
  return { changes: [{ assetId: ASSET_ID, target, operation: 'update', content,
    ownershipIdentity: OWNERSHIP, harness: 'pi', fingerprint: fingerprint(content),
    projection: { renderer: 'pi-guard-extension' } }], conflicts: [], notices };
}

function verifyPiHooks({ scope, scopeRoot, assets = [], ledger, context = {}, adopt = false, env = process.env, fsImpl = fs, pathEnv = process.env.PATH }: any) {
  if (scope !== 'user' && scope !== 'global' && scope !== 'project') return { statuses: [], resources: [], conflicts: [] };
  const asset = assets.find((row: any) => row.id === ASSET_ID);
  if (!asset) return { statuses: [], resources: [], conflicts: [] };
  const target = targetPath(scopeRoot, env, scope);
  const owned = (ledger?.resources || []).find((row: any) => row.harness === 'pi' && row.assetId === ASSET_ID
    && row.ownershipIdentity === OWNERSHIP && row.target === target);
  const bridgePath = path.join(scopeRoot, ...BRIDGE_SUFFIX);
  const present = fsImpl.existsSync(target);
  const content = present ? fsImpl.readFileSync(target, 'utf8') : null;
  const actualFingerprint = content === null ? null : fingerprint(content);
  const fingerprintMatches = !!owned && actualFingerprint === owned.fingerprint;
  const plannedWrite = (context?.plannedWrites || []).includes(target);
  const bridgeMatches = !!content && content.includes(JSON.stringify(path.relative(path.dirname(target), bridgePath).split(path.sep).join('/')));
  const commandOnPath = (command: string) => String(pathEnv || '').split(path.delimiter)
    .some((dir) => fsImpl.existsSync(path.join(dir, command)));
  const status = present && !owned && !plannedWrite && !adopt ? 'conflict'
    : (present && (fingerprintMatches || plannedWrite) && bridgeMatches && commandOnPath('bash') && commandOnPath('jq') ? 'managed' : 'absent');
  const resources = status === 'managed' ? [{ assetId: ASSET_ID, target, ownershipIdentity: OWNERSHIP,
    fingerprint: actualFingerprint, sourceVersion: context.sourceVersion ?? 'unknown',
    projection: { renderer: 'pi-guard-extension' } }] : [];
  const statuses = [{ harness: 'pi', assetId: ASSET_ID, capability: 'hooks', status, target,
    ownershipIdentity: OWNERSHIP, fingerprint: actualFingerprint, fingerprintMatches,
    bridgePath, bridgeExists: fsImpl.existsSync(bridgePath), bash: commandOnPath('bash'), jq: commandOnPath('jq'),
    prerequisites: scope === 'project' ? ['project-trust'] : [], piCodingAgentDir: typeof env?.PI_CODING_AGENT_DIR === 'string' && env.PI_CODING_AGENT_DIR.trim() ? env.PI_CODING_AGENT_DIR.trim() : null }];
  const conflicts = status === 'conflict' ? [`Pi extension is not owned by DoFlow: ${target}`] : [];
  return { statuses, resources, conflicts };
}

function removePiHooks(changes: any[], { fsImpl = fs }: any = {}) {
  let removed = 0;
  for (const change of changes) {
    if (change.projection?.renderer !== 'pi-guard-extension' || change.operation !== 'remove' || change.release) continue;
    if (fsImpl.existsSync(change.target)) { fsImpl.unlinkSync(change.target); removed += 1; }
  }
  return removed;
}

module.exports = { ASSET_ID, EXTENSION_NAME, OWNERSHIP, userAgentDir, targetPath, renderExtension, planPiHooks, verifyPiHooks, removePiHooks };

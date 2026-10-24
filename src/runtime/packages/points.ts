'use strict';

/**
 * The contribution point registry (122 IC-002): `core/registry/contribution-points.json` read on its own, not
 * through `loadRegistry`, so a bad file disables only non-bundled packages and never fails an installer command
 * (the advice pattern, 063 DEC-025). `loadPoints` returns an error result and never throws; the caller reports
 * it. `POINT_VALIDATORS` is a literal map so module reachability stays auditable, as `ADAPTERS` in
 * `src/runtime/advice/client.ts` is. A point is `open` once its validator is registered here (PN-6); a reserved
 * point refuses every entry with `point-reserved`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { validatePreset } = require('../review/protocols.ts');
const { skillValidator, agentValidator } = require('./instruction.ts');

const POINTS_FILE = 'core/registry/contribution-points.json';

const TOP_KEYS = ['version', 'trustPolicyVersion', 'forbiddenFields', 'limits', 'points', 'bundled'];
const LIMIT_KEYS = ['files', 'bytes', 'fileBytes', 'pathLength'];
const POINT_KEYS = ['id', 'versions', 'tier', 'status', 'entry', 'validator', 'combine', 'consumer', 'referencedBy', 'slice', 'opensWith'];
const BUNDLED_KEYS = ['id', 'dir', 'contentDigest'];
const TIERS = ['inert', 'instruction', 'executable'];
const STATUSES = ['open', 'reserved'];
const ENTRIES = ['file', 'dir'];
const COMBINES = ['add-only'];
const POINT_ID = /^[a-z][a-z0-9-]*$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** A preset contributed under a preset point: the point fixes the kind, the body goes through the one preset validator. */
function presetValidator(kind: string) {
  return (id: string, preset: any, context: any = {}): string[] => {
    const errors: string[] = validatePreset(id, preset, context);
    if (preset && typeof preset === 'object' && preset.kind !== kind) {
      errors.push(`presets.${id}.kind must be '${kind}' for a ${kind}-preset contribution`);
    }
    return errors;
  };
}

// Keep this map literal: a validator is reachable only if it is named here.
const POINT_VALIDATORS: Record<string, (id: string, entry: any, context?: any) => string[]> = Object.freeze({
  'review-preset-v1': presetValidator('review'),
  'debate-preset-v1': presetValidator('debate'),
  'skill-v1': skillValidator,
  'agent-v1': agentValidator,
});

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const isPositiveInt = (value: any): boolean => Number.isInteger(value) && value > 0;
const isNonEmptyString = (value: any): boolean => typeof value === 'string' && value.length > 0;

/** Validate a parsed point registry against the closed IC-002 shape. Errors name the field; never throws. */
function validatePoints(registry: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(registry)) return { ok: false, errors: ['registry must be an object'] };
  for (const key of Object.keys(registry)) if (!TOP_KEYS.includes(key)) errors.push(`registry has unknown key '${key}'`);

  if (registry.version !== 1) errors.push('version must be 1');
  if (!isPositiveInt(registry.trustPolicyVersion)) errors.push('trustPolicyVersion must be a positive integer');

  if (!Array.isArray(registry.forbiddenFields) || !registry.forbiddenFields.every(isNonEmptyString)) {
    errors.push('forbiddenFields must be an array of non-empty strings');
  } else if (new Set(registry.forbiddenFields).size !== registry.forbiddenFields.length) {
    errors.push('forbiddenFields must not repeat a name');
  }

  if (!isObject(registry.limits)) errors.push('limits must be an object');
  else {
    for (const key of Object.keys(registry.limits)) if (!LIMIT_KEYS.includes(key)) errors.push(`limits has unknown key '${key}'`);
    for (const key of LIMIT_KEYS) if (!isPositiveInt(registry.limits[key])) errors.push(`limits.${key} must be a positive integer`);
  }

  if (!Array.isArray(registry.points) || registry.points.length === 0) errors.push('points must be a non-empty array');
  else {
    const seen = new Set<string>();
    registry.points.forEach((point: any, i: number) => {
      const where = `points[${i}]`;
      if (!isObject(point)) { errors.push(`${where} must be an object`); return; }
      for (const key of Object.keys(point)) if (!POINT_KEYS.includes(key)) errors.push(`${where} has unknown key '${key}'`);
      if (typeof point.id !== 'string' || !POINT_ID.test(point.id)) errors.push(`${where}.id must match ${POINT_ID}`);
      else if (seen.has(point.id)) errors.push(`${where}.id '${point.id}' is a duplicate point id`);
      else seen.add(point.id);
      const versions = point.versions;
      if (!Array.isArray(versions) || !versions.every(isPositiveInt) || versions.some((v: number, j: number) => j > 0 && v <= versions[j - 1])) {
        errors.push(`${where}.versions must be an ascending array of positive integers`);
      }
      if (!TIERS.includes(point.tier)) errors.push(`${where}.tier must be one of ${TIERS.join(', ')}`);
      if (!STATUSES.includes(point.status)) errors.push(`${where}.status must be one of ${STATUSES.join(', ')}`);
      if (!ENTRIES.includes(point.entry)) errors.push(`${where}.entry must be one of ${ENTRIES.join(', ')}`);
      if (!COMBINES.includes(point.combine)) errors.push(`${where}.combine must be one of ${COMBINES.join(', ')}`);
      if (point.validator === null) {
        if (point.status === 'open') errors.push(`${where}.validator is required on an open point`);
      } else if (typeof point.validator !== 'string' || !Object.hasOwn(POINT_VALIDATORS, point.validator)) {
        errors.push(`${where}.validator '${point.validator}' is not a key of POINT_VALIDATORS (${Object.keys(POINT_VALIDATORS).join(', ')})`);
      }
      if (point.status === 'open' && Array.isArray(versions) && versions.length === 0) errors.push(`${where}.versions must not be empty on an open point`);
      if (point.consumer !== null && !isNonEmptyString(point.consumer)) errors.push(`${where}.consumer must be a module path or null`);
      if (!Array.isArray(point.referencedBy) || !point.referencedBy.every(isNonEmptyString)) errors.push(`${where}.referencedBy must be an array of settings keys`);
      if (!isNonEmptyString(point.slice)) errors.push(`${where}.slice must be a non-empty string`);
      if (point.status === 'reserved' && !isNonEmptyString(point.opensWith)) errors.push(`${where}.opensWith is required on a reserved point`);
      else if ('opensWith' in point && !isNonEmptyString(point.opensWith)) errors.push(`${where}.opensWith must be a non-empty string`);
    });
  }

  if (!Array.isArray(registry.bundled)) errors.push('bundled must be an array');
  else {
    registry.bundled.forEach((entry: any, i: number) => {
      const where = `bundled[${i}]`;
      if (!isObject(entry)) { errors.push(`${where} must be an object`); return; }
      for (const key of Object.keys(entry)) if (!BUNDLED_KEYS.includes(key)) errors.push(`${where} has unknown key '${key}'`);
      if (!isNonEmptyString(entry.id)) errors.push(`${where}.id must be a non-empty string`);
      if (!isNonEmptyString(entry.dir)) errors.push(`${where}.dir must be a non-empty string`);
      if (typeof entry.contentDigest !== 'string' || !DIGEST.test(entry.contentDigest)) errors.push(`${where}.contentDigest must be 64 lower-case hex characters`);
    });
  }
  return { ok: errors.length === 0, errors };
}

/** Read and validate the point registry. An error result, never a throw: the caller reports it and disables non-bundled packages. */
function loadPoints({ repoRoot = REPO_ROOT, file, fsImpl = fs }: any = {}): { ok: boolean; registry?: any; errors: string[] } {
  const target = file || path.join(path.resolve(repoRoot), POINTS_FILE);
  let registry: any;
  try {
    registry = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  } catch (error: any) {
    return { ok: false, errors: [`${target}: ${error.message}`] };
  }
  const checked = validatePoints(registry);
  return checked.ok ? { ok: true, registry, errors: [] } : { ok: false, errors: checked.errors.map((e) => `${target}: ${e}`) };
}

/** One row per point for `package --action points`. */
function pointRows(registry: any): any[] {
  return registry.points.map((p: any) => ({
    id: p.id, versions: p.versions, tier: p.tier, status: p.status, entry: p.entry, opensWith: p.opensWith ?? null,
  }));
}

/**
 * Judge one manifest contribution entry against the registry (IC-002, IC-020). Returns an IC-004 finding, or null
 * when the point is open and the version supported. `index` locates the entry in `contributions[]`.
 */
function judgeContribution(registry: any, entry: any, { packageId, index }: { packageId: string; index: number }): any {
  const point = registry.points.find((p: any) => p.id === entry?.point);
  const open = registry.points.filter((p: any) => p.status === 'open').map((p: any) => p.id);
  const finding = (field: string, code: string, message: string, allowed: any) => (
    { package: packageId, field: `contributions[${index}].${field}`, code, severity: 'error', message, allowed });
  if (!point) return finding('point', 'undeclared-point', `point '${entry?.point}' is not declared; open points: ${open.join(', ')}`, open);
  if (point.status === 'reserved') {
    return finding('point', 'point-reserved', `point '${point.id}' is reserved and opens with ${point.opensWith}; it accepts no contribution yet`, open);
  }
  if (!point.versions.includes(entry.version)) {
    return finding('version', 'unsupported-point-version', `point '${point.id}' does not support version ${entry.version}; supported: ${point.versions.join(', ')}`, point.versions);
  }
  return null;
}

module.exports = { loadPoints, validatePoints, judgeContribution, pointRows, POINT_VALIDATORS, POINTS_FILE };

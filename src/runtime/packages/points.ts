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
const { projectedName, qualifiedId } = require('../../helper/package-ids.ts');
const { dominates } = require('../review/dominance.ts');
const { SEGMENT } = require('./digest.ts');

const POINTS_FILE = 'core/registry/contribution-points.json';

const TOP_KEYS = ['version', 'trustPolicyVersion', 'forbiddenFields', 'limits', 'points', 'bundled'];
const LIMIT_KEYS = ['files', 'bytes', 'fileBytes', 'pathLength'];
const POINT_KEYS = ['id', 'versions', 'tier', 'status', 'entry', 'validator', 'combine', 'consumer', 'referencedBy', 'slice', 'opensWith', 'template'];
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
      if (point.status === 'open') {
        if (!Object.hasOwn(point, 'template')) errors.push(`${where}.template is required on an open point`);
        else if (point.template !== `package-templates/${point.id}`) errors.push(`${where}.template must be package-templates/${point.id} on an open point`);
      } else if (Object.hasOwn(point, 'template')) errors.push(`${where}.template is refused on a reserved point`);
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
 * Check the templates named by open points, plus the package README when checking the complete registry.
 * Template defects are scaffold findings and do not affect loading installed packages.
 */
function templateFindings({ registry, repoRoot = REPO_ROOT, pointId, fsImpl = fs }: any = {}): any[] {
  const findings: any[] = [];
  const add = (field: string, message: string, allowed: any = 'a valid package template'): void => {
    findings.push({ package: null, field, code: 'template-invalid', severity: 'error', message, allowed });
  };
  const placeholders = new Set(['package', 'local', 'qualified', 'projected', 'version', 'host']);
  const validatePlaceholders = (text: string, field: string, isReadme = false): void => {
    const allowed = isReadme ? new Set([...placeholders, 'contributions', 'next']) : placeholders;
    const matches = text.match(/\{\{[^{}]*\}\}/g) ?? [];
    for (const match of matches) {
      if (!allowed.has(match.slice(2, -2))) add(field, `unknown template placeholder ${match}`, [...allowed]);
    }
    if (text.replace(/\{\{[^{}]*\}\}/g, '').includes('{{')) add(field, 'template contains an unclosed placeholder', [...allowed]);
  };
  const readTemplateFiles = (root: string, field: string): Array<{ rel: string; abs: string }> => {
    const files: Array<{ rel: string; abs: string }> = [];
    const visit = (dir: string, relDir: string): void => {
      let entries: any[];
      try {
        entries = fsImpl.readdirSync(dir, { withFileTypes: true });
      } catch (error: any) {
        add(field, `cannot read template files: ${error.message}`);
        return;
      }
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        let stat: any;
        try {
          stat = fsImpl.lstatSync(abs);
        } catch (error: any) {
          add(`${field}.${rel}`, `cannot inspect template entry: ${error.message}`);
          continue;
        }
        if (stat.isSymbolicLink()) {
          add(`${field}.${rel}`, `${rel} is a symbolic link`, 'regular files and directories only');
        } else if (stat.isDirectory()) {
          visit(abs, rel);
        } else if (stat.isFile()) {
          files.push({ rel, abs });
        } else {
          add(`${field}.${rel}`, `${rel} is a special file`, 'regular files and directories only');
        }
      }
    };
    visit(root, '');
    return files;
  };
  const root = path.resolve(repoRoot);
  const points = Array.isArray(registry?.points) ? registry.points : [];
  const selected = pointId === undefined ? points.filter((point: any) => point?.status === 'open') : points.filter((point: any) => point?.id === pointId);
  for (const point of selected) {
    if (point?.status !== 'open' || typeof point.id !== 'string') continue;
    const baseField = `templates.${point.id}`;
    const templateDir = path.join(root, 'core', 'registry', String(point.template ?? `package-templates/${point.id}`));
    let dirStat: any;
    try {
      dirStat = fsImpl.lstatSync(templateDir);
    } catch {
      add(baseField, `template directory is missing: ${path.relative(root, templateDir)}`);
      continue;
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      add(baseField, 'template path must be a regular directory');
      continue;
    }

    const configPath = path.join(templateDir, 'template.json');
    let configText = '';
    let config: any = null;
    try {
      configText = fsImpl.readFileSync(configPath, 'utf8');
      config = JSON.parse(configText);
    } catch (error: any) {
      add(`${baseField}.template.json`, `template.json is not valid JSON: ${error.message}`);
    }
    if (config !== null) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        add(`${baseField}.template.json`, 'template.json must be an object');
      } else {
        for (const key of Object.keys(config)) {
          if (!['template', 'path', 'programs'].includes(key)) add(`${baseField}.template.json`, `template.json has unknown key '${key}'`, ['template', 'path', 'programs']);
        }
        if (config.template !== 1) add(`${baseField}.template.json`, 'template must be 1', 1);
        const qualified = qualifiedId('acme', point.id);
        const projected = qualified ? projectedName(qualified) : null;
        if (typeof config.path !== 'string' || !config.path || config.path.startsWith('/') || config.path.includes('\\')) {
          add(`${baseField}.path`, 'path must be a POSIX relative pattern');
        } else {
          if (!config.path.includes('{{local}}') && !config.path.includes('{{projected}}')) {
            add(`${baseField}.path`, 'path must contain {{local}} or {{projected}}');
          }
          const sample = config.path
            .replaceAll('{{package}}', 'acme')
            .replaceAll('{{local}}', point.id)
            .replaceAll('{{qualified}}', qualified ?? 'acme.invalid')
            .replaceAll('{{projected}}', projected ?? 'acme-invalid')
            .replaceAll('{{version}}', '0.1.0')
            .replaceAll('{{host}}', '2.0.0');
          const segments = sample.split('/');
          if (segments.some((segment: string) => !segment || !SEGMENT.test(segment))) {
            add(`${baseField}.path`, 'path segments must match the package path grammar');
          }
          if (sample.length > (registry?.limits?.pathLength ?? 0)) {
            add(`${baseField}.path`, `path exceeds the ${registry?.limits?.pathLength ?? 0} character path limit`);
          }
          const rawLast = config.path.split('/').pop();
          if (point.id === 'skill' && rawLast !== '{{projected}}') {
            add(`${baseField}.path`, 'skill path must end in {{projected}}');
          }
          if (point.id === 'agent' && rawLast !== '{{projected}}.md') {
            add(`${baseField}.path`, 'agent path must end in {{projected}}.md');
          }
        }
        const executable = point.tier === 'executable';
        if (executable !== Object.hasOwn(config, 'programs')) {
          add(`${baseField}.programs`, executable ? 'programs is required on an executable point' : 'programs is refused on a non-executable point', executable ? 'an array of program declarations' : 'no programs key');
        }
        if (Object.hasOwn(config, 'programs')) {
          if (!Array.isArray(config.programs)) add(`${baseField}.programs`, 'programs must be an array');
          else config.programs.forEach((program: any, index: number) => {
            const field = `${baseField}.programs[${index}]`;
            if (!program || typeof program !== 'object' || Array.isArray(program)) {
              add(field, 'program declaration must be an object');
              return;
            }
            if (typeof program.id !== 'string' || !program.id) add(`${field}.id`, 'program id must be a non-empty string');
            const hasBinary = typeof program.binary === 'string' && program.binary.length > 0;
            const hasPath = typeof program.path === 'string' && program.path.length > 0;
            if (hasBinary === hasPath) add(field, 'program declaration must have exactly one of binary or path', ['binary', 'path']);
            if (typeof program.argv !== 'string' || !program.argv) add(`${field}.argv`, 'program argv must be a non-empty string');
            for (const key of Object.keys(program)) if (!['id', 'binary', 'path', 'argv'].includes(key)) add(field, `program declaration has unknown key '${key}'`);
          });
        }
      }
    }
    validatePlaceholders(configText, `${baseField}.template.json`);

    const filesDir = path.join(templateDir, 'files');
    const files = readTemplateFiles(filesDir, `${baseField}.files`);
    if (point.entry === 'file' && files.length !== 1) add(`${baseField}.files`, 'a file-entry template must hold exactly one regular file');
    if (point.entry === 'dir' && files.length < 1) add(`${baseField}.files`, 'a directory-entry template must hold at least one regular file');
    let totalBytes = 0;
    for (const file of files) {
      const field = `${baseField}.${file.rel}`;
      let bytes: any;
      let text: string;
      try {
        bytes = fsImpl.readFileSync(file.abs);
        text = bytes.toString('utf8');
      } catch (error: any) {
        add(field, `cannot read template file: ${error.message}`);
        continue;
      }
      if (!Buffer.from(text, 'utf8').equals(bytes)) add(field, 'template file is not valid UTF-8');
      totalBytes += bytes.length;
      if (bytes.length > (registry?.limits?.fileBytes ?? 0)) add(field, `file exceeds the ${registry?.limits?.fileBytes ?? 0} byte limit`);
      if (file.rel.length > (registry?.limits?.pathLength ?? 0)) add(field, `file path exceeds the ${registry?.limits?.pathLength ?? 0} character limit`);
      validatePlaceholders(text, field);
    }
    if (files.length > (registry?.limits?.files ?? 0)) add(`${baseField}.files`, `template has more than ${registry?.limits?.files ?? 0} files`);
    if (totalBytes > (registry?.limits?.bytes ?? 0)) add(`${baseField}.files`, `template exceeds the ${registry?.limits?.bytes ?? 0} byte limit`);
  }

  if (pointId === undefined) {
    const readmePath = path.join(root, 'core', 'registry', 'package-templates', 'README.md');
    const field = 'templates.README.md';
    try {
      const bytes = fsImpl.readFileSync(readmePath);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) add(field, 'README template is not valid UTF-8');
      for (const heading of ['## What and why', '## Contributions', '## Check, add and trust', '## Editing after it is added']) {
        if (!text.split(/\r?\n/).includes(heading)) add(field, `README template is missing '${heading}'`);
      }
      if (!/edit[\s\S]*check[\s\S]*update --id[\s\S]*update --plan/i.test(text)) add(field, 'README must describe the edit, check, update --id, update --plan loop');
      if (!/above inert[\s\S]*new trust line/i.test(text)) add(field, 'README must require a new trust line for changed content above inert');
      validatePlaceholders(text, field, true);
    } catch (error: any) {
      add(field, `README template cannot be read: ${error.message}`);
    }
  }
  return findings;
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

module.exports = { loadPoints, validatePoints, judgeContribution, pointRows, templateFindings, POINT_VALIDATORS, POINTS_FILE };

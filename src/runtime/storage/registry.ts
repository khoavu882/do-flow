'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');

const ROOT_BASES = new Set(['project', 'home', 'xdg-config']);
const ENTRIES = new Set(['file', 'dir', 'record']);
const RULES: Map<string, string[]> = new Map([
  ['count-and-age', ['keepNewest', 'maxAgeDays']],
  ['work', ['finishedDays']],
  ['date-partition', ['maxAgeDays']],
  ['recovery', ['keepNewest']],
  ['lifecycle-settled', ['defaultHours']],
  ['report-orphan', ['orphanGraceHours', 'foreignMaxAgeDays']],
  ['age', ['maxAgeDays']],
  ['existing', []],
  ['control', []],
]);
// open-work keeps logs an unfinished task's record names; unfinished-run keeps a worker-model file
// while its worker run or dispatch is not terminal or cannot be resolved (row 120 IC-005).
const PROTECTS = new Set(['open-work', 'unfinished-run']);
const MOMENTS = new Set(['verb', 'session', 'verify', 'install', 'lifecycle-verb', 'uninstall']);
const STORE_ID = /^[a-z][a-z0-9-]*$/;

function isObject(value: any): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function positiveInteger(value: any): boolean { return Number.isInteger(value) && value > 0; }
function error(errors: string[], where: string, message: string): void { errors.push(`${where}: ${message}`); }

/** Validates the closed IC-001 storage declaration document without touching the filesystem. */
function validateStorageRegistry(registry: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(registry)) return { ok: false, errors: ['registry: must be an object'] };
  if (registry.version !== 1) error(errors, 'version', 'must be 1');
  if (typeof registry.description !== 'string' || !registry.description.trim()) error(errors, 'description', 'must be a non-empty string');
  const settings = registry.settings;
  if (!isObject(settings)) error(errors, 'settings', 'must be an object');
  else {
    if (settings.optOutFile !== 'prune') error(errors, 'settings.optOutFile', 'must be prune');
    for (const field of ['upkeepIntervalHours', 'passBudgetMs', 'maxRemovalsPerPass', 'passLockStaleSeconds', 'orphanGraceHours', 'staleTmpHours']) {
      if (!positiveInteger(settings[field])) error(errors, `settings.${field}`, 'must be a positive integer');
    }
    if (!isObject(settings.ignoreFile) || settings.ignoreFile.name !== '.gitignore'
      || !Array.isArray(settings.ignoreFile.lines) || settings.ignoreFile.lines.some((line: any) => typeof line !== 'string')) {
      error(errors, 'settings.ignoreFile', 'must name .gitignore and contain string lines');
    }
  }
  const roots = registry.roots;
  if (!isObject(roots) || Object.keys(roots).length === 0) error(errors, 'roots', 'must be a non-empty object');
  else for (const [id, root] of Object.entries(roots) as [string, any][]) {
    if (!isObject(root) || !ROOT_BASES.has(root.base) || !Array.isArray(root.segments)
      || root.segments.some((segment: any) => typeof segment !== 'string' || !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) {
      error(errors, `roots.${id}`, 'must have a known base and safe path segments');
    }
  }
  if (!Array.isArray(registry.stores)) error(errors, 'stores', 'must be an array');
  else {
    const ids = new Set();
    registry.stores.forEach((store: any, index: number) => {
      const where = `stores[${index}]`;
      if (!isObject(store)) { error(errors, where, 'must be an object'); return; }
      if (typeof store.id !== 'string' || !STORE_ID.test(store.id)) error(errors, `${where}.id`, 'must match ^[a-z][a-z0-9-]*$');
      else if (ids.has(store.id)) error(errors, `${where}.id`, `duplicate id '${store.id}'`); else ids.add(store.id);
      if (typeof store.root !== 'string' || !roots?.[store.root]) error(errors, `${where}.root`, 'must name a declared root');
      if (typeof store.path !== 'string' || store.path.startsWith('/') || store.path.split('/').some((part: string) => part === '..' || !part && store.path !== '')) error(errors, `${where}.path`, 'must be relative, slash-separated, and contain no ..');
      if (!ENTRIES.has(store.entry)) error(errors, `${where}.entry`, 'must be file, dir, or record');
      if (typeof store.match !== 'string' || !store.match.startsWith('^') || !store.match.endsWith('$')) error(errors, `${where}.match`, 'must be an anchored regular expression');
      else { try { new RegExp(store.match); } catch { error(errors, `${where}.match`, 'must compile'); } }
      if (!RULES.has(store.rule)) error(errors, `${where}.rule`, 'must name a known rule kind');
      if (!isObject(store.bound)) error(errors, `${where}.bound`, 'must be an object');
      else {
        for (const field of RULES.get(store.rule) || []) if (!positiveInteger(store.bound[field])) error(errors, `${where}.bound.${field}`, 'must be a positive integer');
        if (['existing', 'control'].includes(store.rule) && (typeof store.bound.text !== 'string' || !store.bound.text)) error(errors, `${where}.bound.text`, 'must be a non-empty string');
        if (store.rule === 'existing' && store.bound.value !== undefined && !positiveInteger(store.bound.value)) error(errors, `${where}.bound.value`, 'must be a positive integer when present');
        if (store.rule === 'count-and-age' && store.bound.either !== undefined && typeof store.bound.either !== 'boolean') error(errors, `${where}.bound.either`, 'must be a boolean when present');
        const allowed = new Set([
          ...(RULES.get(store.rule) || []),
          ...(['existing', 'control'].includes(store.rule) ? ['text'] : []),
          ...(store.rule === 'existing' ? ['value'] : []),
          ...(store.rule === 'count-and-age' ? ['either'] : []),
        ]);
        for (const key of Object.keys(store.bound)) {
          if (!allowed.has(key)) error(errors, `${where}.bound`, `unknown key '${key}'`);
        }
      }
      if (store.protect !== null && !PROTECTS.has(store.protect)) error(errors, `${where}.protect`, 'must be open-work, unfinished-run or null');
      if (!Array.isArray(store.moments) || store.moments.some((moment: any) => !MOMENTS.has(moment)) || new Set(store.moments).size !== store.moments.length) error(errors, `${where}.moments`, 'must be a unique subset of known moments');
      if (store.rule === 'existing' && store.moments?.length) error(errors, `${where}.moments`, 'must be empty for existing stores');
      if (!Array.isArray(store.writers) || store.writers.some((writer: any) => typeof writer !== 'string' || !writer)) error(errors, `${where}.writers`, 'must be an array of repository-relative paths');
      else if (!store.writers.length && store.rule !== 'control' && !store.id.startsWith('user-settings-')) error(errors, `${where}.writers`, 'may be empty only for control or user-settings stores');
      if (store.rule === 'existing') {
        if (!isObject(store.source) || typeof store.source.file !== 'string' || !store.source.file
          || typeof store.source.pattern !== 'string' || !store.source.pattern) {
          error(errors, `${where}.source`, 'requires a non-empty file and literal or template pattern');
        } else if (store.source.pattern.includes('{value}') && !positiveInteger(store.bound?.value)) {
          error(errors, `${where}.bound.value`, 'must be a positive integer for a {value} source pattern');
        }
      }
    });
  }
  if (!Array.isArray(registry.externalWriters)) error(errors, 'externalWriters', 'must be an array');
  else registry.externalWriters.forEach((writer: any, index: number) => {
    if (!isObject(writer) || typeof writer.file !== 'string' || !writer.file || typeof writer.reason !== 'string' || !writer.reason.trim()) error(errors, `externalWriters[${index}]`, 'requires a file and non-empty reason');
  });
  return { ok: errors.length === 0, errors };
}

/** Loads and fails closed on an IC-001 storage registry. */
function loadStorageRegistry({ repoRoot, file, fsImpl = fs }: any = {}): any {
  const target = file || path.join(path.resolve(repoRoot || process.cwd()), 'core', 'registry', 'storage.json');
  let registry: any;
  try { registry = JSON.parse(fsImpl.readFileSync(target, 'utf8')); } catch (cause: any) { throw new Error(`Could not load storage registry '${target}': ${cause.message}`); }
  const validation = validateStorageRegistry(registry);
  if (!validation.ok) throw new Error(`Invalid storage registry:\n- ${validation.errors.join('\n- ')}`);
  return registry;
}

/** Renders IC-001's canonical human-readable bound for a store. */
/** Renders an existing-store source pattern for G26's literal source check. */
function renderSourcePattern(store: any): string {
  const pattern = store?.source?.pattern;
  if (typeof pattern !== 'string') throw new Error('Existing store has no source pattern');
  return pattern.includes('{value}') ? pattern.replaceAll('{value}', String(store.bound.value)) : pattern;
}

function formatBound(store: any): string {
  const bound = store.bound;
  switch (store.rule) {
    case 'count-and-age': return `keep newest ${bound.keepNewest}; prune entries older than ${bound.maxAgeDays} days`;
    case 'work': return `prune finished work after ${bound.finishedDays} days`;
    case 'date-partition': return `prune partitions older than ${bound.maxAgeDays} days`;
    case 'recovery': return `keep newest ${bound.keepNewest}, plus the snapshot named by the ledger`;
    case 'lifecycle-settled': return `retain settled events for ${bound.defaultHours} hours`;
    case 'report-orphan': return `prune orphan bodies after ${bound.orphanGraceHours} hours; foreign folders after ${bound.foreignMaxAgeDays} days`;
    case 'age': return `prune inactive directories after ${bound.maxAgeDays} days`;
    case 'existing':
    case 'control': return bound.text;
    default: throw new Error(`Unknown storage rule '${store.rule}'`);
  }
}

module.exports = { loadStorageRegistry, validateStorageRegistry, renderSourcePattern, formatBound, RULES };

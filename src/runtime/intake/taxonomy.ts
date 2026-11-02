'use strict';

/**
 * The intake taxonomy (136 IC-005): `core/registry/intake.json` read on its own, not through `loadRegistry`,
 * so a bad file turns intake off with a reason and never fails an installer command (the transcripts pattern,
 * `src/runtime/transcripts/registry.ts`). `validateTaxonomy` checks the closed shape and the id and name
 * uniqueness; `loadTaxonomy` returns the core categories in file order, then the valid `intake-category`
 * contributions of active packages (IC-006). A rule matches on a file's name and extension only, never on its content.
 */

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const INTAKE_FILE = 'core/registry/intake.json';

const TOP_KEYS = ['version', 'description', 'recentWindowSeconds', 'pointerMaxBytes', 'textExtensions', 'promptCategory', 'categories'];
const CATEGORY_KEYS = ['id', 'names', 'summary', 'rules'];
const RULE_KEYS = ['extensions', 'namePattern', 'into', 'companionOf'];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EXTENSION = /^[a-z0-9]+$/;
const NAME_MAX = 40;
const INTO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys(value: any, allowed: string[], where: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${where}.${key} is not an allowed key (allowed: ${allowed.join(', ')})`);
  }
}

function extensionList(value: any, where: string, errors: string[], { required }: { required: boolean }): void {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    errors.push(`${where} must be ${required ? 'a non-empty' : 'an'} array of lower-case extensions without a dot`);
    return;
  }
  for (const ext of value) {
    if (typeof ext !== 'string' || !EXTENSION.test(ext)) errors.push(`${where} entry ${JSON.stringify(ext)} must be a lower-case extension without a dot`);
  }
  if (new Set(value).size !== value.length) errors.push(`${where} names an extension twice`);
}

function validateRule(rule: any, where: string, errors: string[]): void {
  if (!isObject(rule)) { errors.push(`${where} must be an object`); return; }
  unknownKeys(rule, RULE_KEYS, where, errors);
  extensionList(rule.extensions, `${where}.extensions`, errors, { required: true });
  if (Object.hasOwn(rule, 'namePattern')) {
    if (typeof rule.namePattern !== 'string' || rule.namePattern === '') {
      errors.push(`${where}.namePattern must be a non-empty regular expression string`);
    } else {
      try { new RegExp(rule.namePattern, 'i'); } catch (error: any) { errors.push(`${where}.namePattern does not compile (${error.message})`); }
    }
  }
  if (Object.hasOwn(rule, 'into')) {
    const into = rule.into;
    const segments = typeof into === 'string' ? into.split('/') : [];
    if (typeof into !== 'string' || segments.some((segment: string) => !INTO_SEGMENT.test(segment) || segment === '..')) {
      errors.push(`${where}.into must be a relative sub-path of plain names, with no '..', no leading dot and no empty segment`);
    }
  }
  if (Object.hasOwn(rule, 'companionOf')) {
    extensionList(rule.companionOf, `${where}.companionOf`, errors, { required: true });
    if (Object.hasOwn(rule, 'into')) errors.push(`${where} has companionOf, so it follows its companion and takes no into`);
  }
}

/**
 * The shape errors of one category (IC-005, and IC-006's contributed entry): closed keys, a lower-kebab `id`
 * and `names`, a summary, and valid rules. Uniqueness across categories is the caller's, who sees them all.
 */
function validateCategory(category: any, where: string): string[] {
  const errors: string[] = [];
  if (!isObject(category)) return [`${where} must be an object`];
  unknownKeys(category, CATEGORY_KEYS, where, errors);
  for (const key of CATEGORY_KEYS) {
    if (!Object.hasOwn(category, key)) errors.push(`${where}.${key} is missing`);
  }
  const kebab = (value: any): boolean => typeof value === 'string' && value.length <= NAME_MAX && KEBAB.test(value);
  if (Object.hasOwn(category, 'id') && !kebab(category.id)) errors.push(`${where}.id must be lower-kebab, at most ${NAME_MAX} characters`);
  if (Object.hasOwn(category, 'names')) {
    if (!Array.isArray(category.names) || !category.names.every(kebab)) errors.push(`${where}.names must be an array of lower-kebab names, at most ${NAME_MAX} characters each`);
  }
  if (Object.hasOwn(category, 'summary') && (typeof category.summary !== 'string' || category.summary.trim() === '')) {
    errors.push(`${where}.summary must be a non-empty string`);
  }
  if (Object.hasOwn(category, 'rules')) {
    if (!Array.isArray(category.rules)) errors.push(`${where}.rules must be an array`);
    else category.rules.forEach((rule: any, i: number) => validateRule(rule, `${where}.rules[${i}]`, errors));
  }
  return errors;
}

/** Checks the registry's shape, then that every id and name is used once across all categories. */
function validateTaxonomy(registry: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(registry)) return { ok: false, errors: ['registry must be an object'] };
  unknownKeys(registry, TOP_KEYS, 'registry', errors);
  for (const key of TOP_KEYS) {
    if (!Object.hasOwn(registry, key)) errors.push(`registry.${key} is missing`);
  }
  if (Object.hasOwn(registry, 'version') && registry.version !== 1) errors.push('version must be 1');
  if (Object.hasOwn(registry, 'description') && (typeof registry.description !== 'string' || registry.description.trim() === '')) {
    errors.push('description must be a non-empty string');
  }
  if (Object.hasOwn(registry, 'recentWindowSeconds') && !(Number.isInteger(registry.recentWindowSeconds) && registry.recentWindowSeconds >= 0)) {
    errors.push('recentWindowSeconds must be an integer of 0 or more');
  }
  if (Object.hasOwn(registry, 'pointerMaxBytes') && !(Number.isInteger(registry.pointerMaxBytes) && registry.pointerMaxBytes > 0)) {
    errors.push('pointerMaxBytes must be a positive integer');
  }
  if (Object.hasOwn(registry, 'textExtensions')) extensionList(registry.textExtensions, 'textExtensions', errors, { required: true });
  if (!Array.isArray(registry.categories) || registry.categories.length === 0) {
    errors.push('categories must be a non-empty array');
    return { ok: false, errors };
  }
  registry.categories.forEach((category: any, i: number) => errors.push(...validateCategory(category, `categories[${i}]`)));
  const owner = new Map<string, string>();
  const claim = (name: any, id: any): void => {
    if (typeof name !== 'string') return;
    if (owner.has(name)) errors.push(`'${name}' is used by both '${owner.get(name)}' and '${id}'; ids and names are unique across categories`);
    else owner.set(name, String(id));
  };
  for (const category of registry.categories) {
    if (!isObject(category)) continue;
    claim(category.id, category.id);
    if (Array.isArray(category.names)) for (const name of category.names) claim(name, category.id);
  }
  const prompt = registry.categories.find((category: any) => isObject(category) && category.id === registry.promptCategory);
  if (!prompt) errors.push(`promptCategory '${registry.promptCategory}' is not a category id`);
  else if (Array.isArray(prompt.rules) && prompt.rules.length > 0) errors.push(`the prompt category '${prompt.id}' must have no rules`);
  return { ok: errors.length === 0, errors };
}

/**
 * Returns `{ ok: true, taxonomy }` with the core categories in file order, each marked `origin: 'core'`, followed by
 * the categories active packages contribute (IC-006), or `{ ok: false, reason: 'config-invalid', detail }` when the
 * core file cannot be read or fails its shape. A contribution is tried after every core category, in ascending
 * qualified-id order; its `id` becomes the qualified id, which is also its folder name. One whose id or names
 * collide with a core category or an earlier contribution is left out and named in `problems`. The core list never
 * depends on the package view: `contributionsFor` yields nothing when the point registry fails to load.
 * `contributions: false` skips the package view. `view`, `homeDir`, `env`, `projectRoot` and `tmpDir` reach it.
 */
function loadTaxonomy({ repoRoot = REPO_ROOT, file, fsImpl = fs, contributions = true, problems, view, homeDir, env, projectRoot, tmpDir }: any = {}): { ok: boolean; taxonomy?: any; reason?: string; detail?: string } {
  const target = file || path.join(path.resolve(repoRoot), INTAKE_FILE);
  let registry: any;
  try {
    registry = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  } catch (error: any) {
    return { ok: false, reason: 'config-invalid', detail: `${target}: ${error.message}` };
  }
  const validation = validateTaxonomy(registry);
  if (!validation.ok) return { ok: false, reason: 'config-invalid', detail: validation.errors.join('; ') };
  const categories = registry.categories.map((category: any) => ({ ...category, origin: 'core' }));
  if (contributions) {
    const used = new Set<string>(categories.flatMap((category: any) => [category.id, ...category.names]));
    const { contributionsFor } = require('../packages/contributions.ts');
    for (const contribution of contributionsFor('intake-category', 1, { repoRoot, fsImpl, view, homeDir, env, projectRoot, tmpDir, problems })) {
      const id = contribution.qualifiedId;
      const clash = [id, ...contribution.data.names].find((name: string) => used.has(name));
      if (clash !== undefined) {
        problems?.push(`intake-category contribution '${id}' is left out: '${clash}' is already the id or a name of another category`);
        continue;
      }
      for (const name of [id, ...contribution.data.names]) used.add(name);
      categories.push({ ...contribution.data, id, origin: id });
    }
  }
  return { ok: true, taxonomy: { ...registry, categories } };
}

/**
 * The folder a category files into: the first of its id and known names that is already a folder in the
 * context folder, else its id (FR-003, IC-005). `existing` is the set of folder names found there.
 */
function categoryFolder(category: any, existing: Set<string>): string {
  return [category.id, ...category.names].find((name: string) => existing.has(name)) ?? category.id;
}

module.exports = { loadTaxonomy, validateTaxonomy, validateCategory, categoryFolder, INTAKE_FILE };

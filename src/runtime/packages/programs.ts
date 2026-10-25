'use strict';

/**
 * IC-018 program declarations: check executable contributions on open points at supported versions,
 * their declared programs, and each declaration's launch shape. This module never spawns a process.
 * `launchSpec` builds the shell-free spec that the D.3 launcher uses, with arguments, cwd, and
 * environment supplied by core.
 */

const fs = require('node:fs');
const path = require('node:path');
const { isLocalId } = require('../../helper/package-ids.ts');
const { SEGMENT, SEGMENT_GRAMMAR } = require('./digest.ts');

const ARGV_SHAPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  worker: Object.freeze(['worker-recipe']),
  'capability-provider': Object.freeze(['capability-cli']),
});
const BINARY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROGRAM_KEYS = ['id', 'binary', 'path', 'argv'];
const platform = require('node:process').platform;

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate IC-018 program declarations and each executable contribution's program references. */
function programFindings(
  manifest: any,
  { root = null, pointsRegistry, fsImpl = fs, packageId = null }: any,
): any[] {
  const findings: any[] = [];
  const add = (field: string, code: string, message: string, allowed: any) =>
    findings.push({ package: packageId, field, code, severity: 'error', message, allowed });
  const contributions = Array.isArray(manifest?.contributions) ? manifest.contributions : [];
  const executable = contributions
    .map((entry: any, index: number) => ({ entry, index, point: pointsRegistry.points.find((item: any) => item.id === entry?.point) }))
    .filter((item: any) => item.point?.tier === 'executable'
      && item.point.status === 'open'
      && item.point.versions.includes(item.entry?.version));

  if (executable.length === 0) return findings;

  function isCliCapability(entry: any, point: any): boolean {
    if (point?.id !== 'capability-provider') return false;
    if (Array.isArray(entry?.programs) && entry.programs.length > 0) return true;
    if (!root || !entry?.file || typeof entry.file !== 'string') return false;
    try {
      const real = path.join(root, entry.file);
      const text = fsImpl.readFileSync(real, 'utf8');
      const parsed = JSON.parse(text);
      return parsed?.kind === 'cli';
    } catch {
      return false;
    }
  }

  const needsPrograms = executable.some(({ entry, point }: any) => {
    if (point?.id === 'capability-provider') {
      return isCliCapability(entry, point);
    }
    return true;
  });

  const rawPrograms = manifest?.programs;
  if (rawPrograms === undefined) {
    if (needsPrograms) {
      add('programs', 'program-invalid', 'programs must be an array of at most 16 declarations', 'an array of 0 to 16 program declarations');
    }
  } else if (!Array.isArray(rawPrograms) || rawPrograms.length > 16) {
    add('programs', 'program-invalid', 'programs must be an array of at most 16 declarations', 'an array of 0 to 16 program declarations');
  }

  const declarations = Array.isArray(rawPrograms) ? rawPrograms : [];
  const declaredIds = new Set<string>();
  const seenIds = new Set<string>();
  declarations.forEach((program: any, index: number) => {
    const field = `programs[${index}]`;
    if (!isObject(program)) {
      add(field, 'program-invalid', 'a program declaration must be an object', 'an object with id, binary or path, and argv');
      return;
    }
    for (const key of Object.keys(program)) {
      if (!PROGRAM_KEYS.includes(key)) add(`${field}.${key}`, 'program-invalid', `'${key}' is not a program declaration field`, PROGRAM_KEYS);
    }

    const validId = isLocalId(program.id);
    if (!validId) {
      add(`${field}.id`, 'program-invalid', 'program id must be a local id', 'a local id');
    } else if (seenIds.has(program.id)) {
      add(`${field}.id`, 'program-invalid', `program id '${program.id}' is declared more than once`, 'a unique local id');
    } else {
      seenIds.add(program.id);
      declaredIds.add(program.id);
    }

    const hasBinary = Object.hasOwn(program, 'binary');
    const hasPath = Object.hasOwn(program, 'path');
    if (hasBinary === hasPath) {
      add(field, 'program-invalid', 'exactly one of binary or path is required', ['binary', 'path']);
    } else if (hasBinary) {
      if (typeof program.binary !== 'string' || program.binary.length > 64 || !BINARY.test(program.binary)) {
        add(`${field}.binary`, 'program-invalid', 'binary must be a bare executable name of at most 64 characters', '^[A-Za-z0-9][A-Za-z0-9._-]*$ (at most 64 characters)');
      }
    } else {
      validateProgramPath(program.path, `${field}.path`);
    }
  });

  for (const { entry, index, point } of executable) {
    const field = `contributions[${index}].programs`;
    const refs = entry?.programs;
    if (!Array.isArray(refs) || refs.length === 0) {
      if (point?.id === 'capability-provider' && !isCliCapability(entry, point)) {
        continue;
      }
      add(field, 'program-undeclared', 'an executable contribution must name every program it launches', [...declaredIds]);
      continue;
    }
    refs.forEach((id: any) => {
      if (typeof id !== 'string' || !declaredIds.has(id)) {
        add(field, 'program-undeclared', `program '${String(id)}' is not declared`, [...declaredIds]);
      }
    });
  }

  declarations.forEach((program: any, index: number) => {
    if (!isObject(program)) return;
    const field = `programs[${index}].argv`;
    const usingPoints = executable.filter(({ entry }: any) =>
      Array.isArray(entry?.programs) && entry.programs.includes(program.id));
    let allowed: string[];
    if (usingPoints.length > 0) {
      const shapes = usingPoints.map(({ point }: any) => ARGV_SHAPES[point.id] ?? []);
      allowed = shapes.length === 0 ? [] : [...shapes[0]].filter((shape) => shapes.every((list: readonly string[]) => list.includes(shape)));
    } else {
      allowed = [...new Set<string>(executable.flatMap(({ point }: any) => [...(ARGV_SHAPES[point.id] ?? [])]))];
    }
    if (typeof program.argv !== 'string' || !allowed.includes(program.argv)) {
      add(field, 'program-invalid', 'argv must name a shape defined by the executable point using this program', allowed);
    }
  });

  return findings;

  function validateProgramPath(rel: any, field: string): void {
    const limits = pointsRegistry.limits;
    if (typeof rel !== 'string' || rel.length === 0) {
      add(field, 'program-invalid', 'path must be a non-empty POSIX package-relative path', 'a package-relative path to an executable regular file');
      return;
    }
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      add(field, 'path-escapes-root', `${rel} leaves the package root`, 'a path inside the package root');
      return;
    }
    if (rel.length > limits.pathLength || rel.split('/').some((segment: string) => !SEGMENT.test(segment))) {
      add(field, 'program-invalid', `${rel} breaks the package path rules`, `${SEGMENT_GRAMMAR} per segment, at most ${limits.pathLength} characters`);
      return;
    }
    if (!root) return;

    let rootReal: string;
    let real: string;
    try {
      rootReal = fsImpl.realpathSync(root);
      real = fsImpl.realpathSync(path.join(root, rel));
    } catch (error: any) {
      add(field, 'file-missing', `${rel} does not exist: ${error?.message || String(error)}`, 'an existing regular file');
      return;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      add(field, 'path-escapes-root', `${rel} resolves outside the package root`, 'a path inside the package root');
      return;
    }
    let stat: any;
    try {
      stat = fsImpl.statSync(real);
    } catch (error: any) {
      add(field, 'file-missing', `${rel} cannot be read: ${error?.message || String(error)}`, 'an existing regular file');
      return;
    }
    if (!stat.isFile()) {
      add(field, 'program-invalid', `${rel} is not a regular file`, 'an executable regular file');
      return;
    }
    if (platform !== 'win32' && (stat.mode & 0o111) === 0) {
      add(field, 'program-invalid', `${rel} has no execute bit`, 'a file with at least one execute bit');
    }
  }
}

/** Build a shell-free launch description using only the declared executable and core-provided arguments. */
function launchSpec({ program, storeEntry, recipeArgv, cwd, env }: any): any {
  if (!Array.isArray(recipeArgv) || recipeArgv.some((arg: any) => typeof arg !== 'string')) {
    throw new TypeError('recipeArgv must be an array of strings');
  }
  let file: string;
  if (typeof program?.binary === 'string') {
    file = program.binary;
  } else if (typeof program?.path === 'string') {
    const root = path.resolve(storeEntry);
    file = path.resolve(root, program.path);
    if (file !== root && !file.startsWith(root + path.sep)) {
      throw new Error('program path leaves the store entry');
    }
  } else {
    throw new TypeError('program must declare a binary or path');
  }
  return {
    file,
    args: [...recipeArgv],
    options: { shell: false, cwd, env, windowsHide: true },
  };
}

module.exports = { ARGV_SHAPES, programFindings, launchSpec };

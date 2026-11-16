'use strict';

// 169 design §4: the descriptor grammar for the parts of a model binding beyond the model id. `worker.provider` and
// `worker.effort` are capability entries with a closed transport (a flag, or a separator joined to the model id), and
// `worker.modelList` gains `columns` and `providerInId`. This file holds the constants once (the runtime's model-choice
// module imports them) and the static checks of §4.4; `validateWorker` in index.ts calls it. Pure; no runtime require.
//
// Ceilings, accepted: rule 4 substitutes each declared level (or the sample value `sample` for `per-model` levels and
// for a provider) into the transport argv and runs the widening and secret matchers on the result, so a `per-model` or
// provider value that is only widening for one specific string is not caught here; the launcher checks the final argv.

const { wideningProblem } = require('./widening-flags.ts');
const { secretProblem } = require('./secret-flags.ts');

/** How a part reaches the harness: its own flag, or a separator joined to the model id (prefix for a provider, suffix for an effort). */
const TRANSPORT_KINDS = Object.freeze(['flag', 'id-prefix', 'id-suffix']);
const SEPARATORS = Object.freeze(['/', ':', '#', '@']);
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EFFORT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** The fields a `modelList.columns` entry may fill, each with the fixed converter its value goes through (§4.3). */
const COLUMN_TARGETS = Object.freeze({
  provider: 'token',
  displayName: 'cleanName',
  contextTokens: 'size',
  maxOutputTokens: 'size',
  reasoning: 'yes-no',
  imageInput: 'yes-no',
  effortLevels: 'comma-list',
} as Record<string, string>);

const FLAG_RE = /^(?:--[A-Za-z0-9][A-Za-z0-9-]*|-[A-Za-z0-9])$/;
const KEY_ASSIGNMENT_RE = /^([A-Za-z0-9_.-]{1,64})=\{effort\}$/;
const COLUMN_HEADER_RE = /^[a-z][a-z0-9-]*$/;
const LEVELS_MAX = 16;
const ENTRY_MAX_BYTES = 2048;
const SAFETY_ARGV = Object.freeze(['readOnly', 'spawnDenial', 'isolatedEdit']);
const RECIPE_ARGV = Object.freeze(['oneShot', 'structuredOutput', 'mainSession']);
const SAMPLE_VALUE = 'sample';

type Fail = (key: string, message: string) => void;
const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasPlaceholder = (text: string): boolean => /\{[^{}]*\}/.test(text);

/** `modelList.columns` and `modelList.providerInId` of a `supported` listing: their own shape (§4.3). */
function validateModelListColumns(entry: any, fail: Fail): void {
  if (Object.hasOwn(entry, 'providerInId') && entry.providerInId !== true) fail('modelList', 'providerInId must be true');
  if (!Object.hasOwn(entry, 'columns')) return;
  const columns = entry.columns;
  if (!isObject(columns)) { fail('modelList', 'columns must be an object'); return; }
  const idColumn = typeof entry.parse === 'string' && entry.parse.startsWith('table-column:') ? entry.parse.slice('table-column:'.length) : null;
  if (idColumn === null) fail('modelList', 'columns requires parse table-column:<name>');
  const targets = Object.keys(columns);
  if (targets.length === 0) { fail('modelList', 'columns must name at least one target'); return; }
  const seen = new Set<string>();
  for (const target of targets) {
    if (!Object.hasOwn(COLUMN_TARGETS, target)) { fail('modelList', `columns has unknown target '${target}'`); continue; }
    const header = columns[target];
    if (typeof header !== 'string' || !COLUMN_HEADER_RE.test(header)) { fail('modelList', `columns.${target} header must match ${COLUMN_HEADER_RE}`); continue; }
    if (header === idColumn) fail('modelList', `columns.${target} header must not be the id column '${idColumn}'`);
    if (seen.has(header)) fail('modelList', 'columns headers must be distinct');
    seen.add(header);
  }
}

function levelsProblem(levels: any): string | null {
  if (levels === 'per-model') return null;
  if (!Array.isArray(levels) || levels.length < 1 || levels.length > LEVELS_MAX
    || levels.some((level: any) => typeof level !== 'string' || !EFFORT_RE.test(level)) || new Set(levels).size !== levels.length) {
    return `levels must be 1 to ${LEVELS_MAX} distinct names or "per-model"`;
  }
  return null;
}

/** The transport flag of a `flag` entry whose argv has its exact shape, or null (and the problem is reported). */
function checkFlagArgv(key: string, entry: any, fail: Fail): string | null {
  const effort = key === 'effort';
  const argv = entry.argv;
  const value = Array.isArray(argv) ? argv[1] : undefined;
  const valueOk = effort ? value === '{effort}' || (typeof value === 'string' && KEY_ASSIGNMENT_RE.test(value)) : value === '{provider}';
  if (!Array.isArray(argv) || argv.length !== 2 || typeof argv[0] !== 'string' || !FLAG_RE.test(argv[0]) || !valueOk) {
    fail(key, effort ? 'via flag requires argv [<flag>, "{effort}"] or [<flag>, "<key>={effort}"]' : 'via flag requires argv [<flag>, "{provider}"]');
    return null;
  }
  return argv[0];
}

/** Rule 3: where a transport flag may appear in the other recipes of the block. */
function checkFlagPlacement(key: string, flag: string, worker: any, fail: Fail): void {
  for (const name of SAFETY_ARGV) {
    const argv = worker[name]?.argv;
    if (Array.isArray(argv) && argv.some((item: any) => item === flag || (typeof item === 'string' && item.startsWith(`${flag}=`)))) {
      fail(key, `transport flag '${flag}' must not appear in ${name}`);
    }
  }
  for (const name of RECIPE_ARGV) {
    const argv = worker[name]?.argv;
    if (!Array.isArray(argv)) continue;
    argv.forEach((item: any, index: number) => {
      if (typeof item !== 'string') return;
      let value: string | undefined;
      if (item === flag) value = argv[index + 1];
      else if (item.startsWith(`${flag}=`)) value = item.slice(flag.length + 1);
      else return;
      if (typeof value !== 'string' || value === '' || hasPlaceholder(value) || value.startsWith('-')) {
        fail(key, `transport flag '${flag}' in ${name} must be followed by a fixed value (or written ${flag}=<value>)`);
      }
    });
  }
}

/** Rule 4: the transport argv with each value substituted must not be a widening flag or print a secret. */
function checkSubstitutions(key: string, entry: any, worker: any, declared: any, secretDeclared: any, fail: Fail): void {
  const effort = key === 'effort';
  const listed = effort && Array.isArray(entry.levels);
  const values: string[] = listed ? entry.levels : [SAMPLE_VALUE];
  const what = listed ? 'levels value' : 'sample value';
  const assignment = effort ? KEY_ASSIGNMENT_RE.exec(entry.argv[1]) : null;
  for (const value of values) {
    const argv = entry.argv.map((item: string) => item.replace(effort ? '{effort}' : '{provider}', value));
    // A config-override carrier: `<key>=<value>` is read by the same matcher a `--config key=value` pair is.
    const carriers = [argv, ...(assignment ? [['--config', `${assignment[1]}=${value}`]] : [])];
    for (const candidate of carriers) {
      const widening = wideningProblem(candidate, { binary: worker.cli?.binary, declared });
      if (widening) { fail(key, `${what} '${value}' makes the transport argv contain the widening flag '${widening}'`); return; }
    }
    const secret = secretProblem(argv, { binary: worker.cli?.binary, declared: secretDeclared });
    if (secret) { fail(key, `${what} '${value}' makes the transport argv contain the secret-printing flag or command '${secret}'`); return; }
  }
}

/** Rule 2 for one supported `provider` or `effort` entry; returns the transport flag when it is a well-formed `flag` entry. */
function checkTransport(key: string, entry: any, fail: Fail): string | null {
  const effort = key === 'effort';
  const kinds = effort ? ['flag', 'id-suffix'] : ['flag', 'id-prefix'];
  const via = entry.via;
  if (!Object.hasOwn(entry, 'via')) return null; // 'requires recipe field' is reported by validateWorker
  if (!kinds.includes(via)) { fail(key, `via must be ${kinds[0]} or ${kinds[1]}`); return null; }
  let flag: string | null = null;
  if (via === 'flag') {
    if (Object.hasOwn(entry, 'separator')) fail(key, "via flag takes no 'separator'");
    flag = checkFlagArgv(key, entry, fail);
  } else {
    if (Object.hasOwn(entry, 'argv')) fail(key, `via ${via} takes no 'argv'`);
    if (!Object.hasOwn(entry, 'separator')) fail(key, `via ${via} requires 'separator'`);
    else if (!SEPARATORS.includes(entry.separator)) fail(key, `separator must be one of ${SEPARATORS.join(' ')}`);
  }
  if (effort) {
    if (Object.hasOwn(entry, 'levels')) {
      const problem = levelsProblem(entry.levels);
      if (problem) fail(key, problem);
    }
    if (Object.hasOwn(entry, 'offLevel')) {
      if (!Array.isArray(entry.levels)) fail(key, 'offLevel is allowed only with a list of levels');
      else if (!entry.levels.includes(entry.offLevel)) fail(key, 'offLevel must be one of levels');
    }
    if (Object.hasOwn(entry, 'mayLower') && typeof entry.mayLower !== 'boolean') fail(key, 'mayLower must be a boolean');
  }
  return flag;
}

/** Design §4.4 rules 1 to 7 for a worker block. `declared` and `secretDeclared` are the block's own flag lists. */
function validateModelParts(worker: any, fail: Fail, { declared = [], secretDeclared = [] }: { declared?: any; secretDeclared?: any } = {}): void {
  const supported = (entry: any) => isObject(entry) && entry.status === 'supported';
  for (const key of ['provider', 'effort']) {
    const entry = worker[key];
    if (!isObject(entry)) continue;
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (bytes > ENTRY_MAX_BYTES) fail(key, `entry is ${bytes} bytes serialized; the limit is ${ENTRY_MAX_BYTES}`);
    if (entry.status !== 'supported') continue;
    if (!supported(worker.model)) fail(key, "requires worker 'model' to be supported");
    const flag = checkTransport(key, entry, fail);
    if (flag === null) continue;
    checkFlagPlacement(key, flag, worker, fail);
    checkSubstitutions(key, entry, worker, declared, secretDeclared, fail);
  }

  const list = worker.modelList;
  if (!isObject(list) || list.status !== 'supported') return;
  const columns = isObject(list.columns) ? list.columns : {};
  if (Object.hasOwn(columns, 'provider') && !supported(worker.provider)) fail('modelList', "columns.provider requires worker 'provider' to be supported");
  if (list.providerInId === true) {
    if (!supported(worker.provider)) fail('modelList', "providerInId requires worker 'provider' to be supported");
    else if (worker.provider.via !== 'id-prefix') fail('modelList', "providerInId requires worker 'provider' via id-prefix");
  }
  for (const target of ['effortLevels', 'reasoning']) {
    if (Object.hasOwn(columns, target) && !supported(worker.effort)) fail('modelList', `columns.${target} requires worker 'effort' to be supported`);
  }
}

module.exports = {
  TRANSPORT_KINDS, SEPARATORS, PROVIDER_RE, EFFORT_RE, COLUMN_TARGETS, FLAG_RE, KEY_ASSIGNMENT_RE, COLUMN_HEADER_RE, LEVELS_MAX, ENTRY_MAX_BYTES,
  validateModelParts, validateModelListColumns,
};

'use strict';

// G45 - telemetry
// contract (feature 088, IC-001, IC-002, IC-018; FR-001, FR-007, NFR-001, NFR-006, NFR-010).
//
// `core/registry/telemetry.json` is the one list of keys a telemetry line may carry. This guard fails
// when the registry and what the repository writes disagree: a key written but not declared (or the
// reverse), a node process on a shell hook path, a network client in the runtime, a skill that sends
// the model to a trace view, a dependency, or a telemetry store the retention registry does not
// declare. Each check is a pure function so the self-tests can run it on planted input.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir, suiteTempDir, removeTree } = require('../helper/tmp');
const { TelemetryWriter } = require('../../src/runtime/trace/telemetry.ts');
const { RunLedger } = require('../../src/runtime/trace/ledger.ts');
const { attributeRule } = require('../../src/runtime/trace/otlp-map.ts');

const REGISTRY_FILE = 'core/registry/telemetry.json';
const WRITER_FILE = 'src/runtime/trace/telemetry.ts';
const FIXTURE_DIR = 'test/fixtures/telemetry';
const TUPLE_FIXTURE_FIELDS = {
  hook: ['role', 'worker_run', 'test_class', 'tool_duration_ms', 'emit_reason', 'emit_bytes', 'emit_digest'],
  'verify.run': ['dispatch_run'],
  'review.run': ['task', 'rounds', 'seats', 'seat_findings', 'converged', 'blocker', 'should_fix', 'note', 'open', 'fixed', 'refuted', 'user_accepted', 'pre_existing', 'escaped', 'confirmed', 'plausible', 'unverified_blockers', 'bug_classes', 'advisories', 'errors'],
};
const TYPE_ATOMS = new Set(['token', 'id', 'uint', 'int', 'hex16', 'hex32', 'iso8601ms', 'date', 'null']);
const FIELD_KEY = /^[a-z][a-z0-9_]*$/;
const READ_ONLY_TYPES = new Set(['runkey']); // recordFields only: a run key is `<hex16>/<run>/<lineage>`

// --- G45.1: the allowlist equals what is written ------------------------------------------------

/** The registry is well formed: classes, names, types and vocabularies all resolve. */
function checkRegistryShape(registry) {
  const errors = [];
  const at = (where, message) => errors.push(`${REGISTRY_FILE} ${where}: ${message}`);
  if (registry.version !== 1) at('version', 'must be 1');
  if (registry.keyPrefix !== 'doflow.') at('keyPrefix', "must be 'doflow.'");
  const classes = new Set(Object.keys(registry.classes || {}));
  const vocabularies = registry.vocabularies || {};
  const typeErrors = (type) => {
    if (typeof type !== 'string' || type === '') return ['is not a string'];
    return type.split('|').flatMap((atom) => {
      if (TYPE_ATOMS.has(atom) || READ_ONLY_TYPES.has(atom)) return [];
      if (atom.startsWith('enum:')) return Object.hasOwn(vocabularies, atom.slice(5)) ? [] : [`names no vocabulary '${atom.slice(5)}'`];
      return [`has unknown type '${atom}'`];
    });
  };
  for (const [name, values] of Object.entries(vocabularies)) {
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || value === '')) at(`vocabularies.${name}`, 'must be a non-empty array of strings');
    else if (new Set(values).size !== values.length) at(`vocabularies.${name}`, 'has duplicate values');
  }
  const common = Array.isArray(registry.common) ? registry.common : [];
  if (!common.length) at('common', 'must be a non-empty array');
  for (const key of common) {
    if (!classes.has((registry.commonClasses || {})[key])) at(`commonClasses.${key}`, 'is missing or names an unknown class');
  }
  const kinds = registry.kinds || {};
  if (JSON.stringify(Object.keys(kinds).sort()) !== JSON.stringify([...(vocabularies.kind || [])].sort())) at('vocabularies.kind', 'must list exactly the declared kinds');
  for (const [kind, spec] of Object.entries(kinds)) {
    if (typeof spec.store !== 'string' || !spec.store) at(`kinds.${kind}.store`, 'must name a store');
    if (!Array.isArray(spec.writers) || spec.writers.length === 0) at(`kinds.${kind}.writers`, 'must list the files that write the kind');
    for (const [key, field] of Object.entries(spec.fields || {})) {
      const where = `kinds.${kind}.fields.${key}`;
      if (!FIELD_KEY.test(key)) at(where, 'key must match ^[a-z][a-z0-9_]*$');
      if (common.includes(key)) at(where, 'repeats a common key');
      if (field.name !== `${registry.keyPrefix}${kind}.${key}`) at(`${where}.name`, `must be '${registry.keyPrefix}${kind}.${key}'`);
      if (!classes.has(field.class)) at(`${where}.class`, 'names an unknown class');
      if (field.class === 'T4') at(`${where}.class`, 'T4 content is never recorded');
      for (const message of typeErrors(field.type)) at(`${where}.type`, message);
      if (field.type && field.type.split('|').some((atom) => READ_ONLY_TYPES.has(atom))) at(`${where}.type`, 'runkey is for recordFields only');
      if (!/^P\d/.test(field.phase || '')) at(`${where}.phase`, 'must name the phase that first writes the key');
    }
  }
  for (const [key, field] of Object.entries(registry.recordFields || {})) {
    if (!classes.has(field.class)) at(`recordFields.${key}.class`, 'names an unknown class');
    for (const message of typeErrors(field.type)) at(`recordFields.${key}.type`, message);
  }
  for (const entry of registry.excludedStores || []) {
    if (!entry.store || !String(entry.reason || '').trim()) at('excludedStores', 'every entry needs a store and a reason');
  }
  const withoutExport = { ...registry };
  delete withoutExport.export;
  if (/gen_ai\./.test(JSON.stringify(withoutExport))) at('', "no 'gen_ai.*' key belongs to contract v1 (FR-001)");
  return errors;
}

/** Vocabularies that another registry owns equal that registry's list. */
function checkVocabularyOwners(registry, owners) {
  const errors = [];
  for (const [vocabulary, expected] of Object.entries(owners)) {
    if (JSON.stringify(registry.vocabularies[vocabulary]) !== JSON.stringify(expected.values)) {
      errors.push(`${REGISTRY_FILE} vocabularies.${vocabulary} differs from ${expected.owner}: [${expected.values.join(',')}]`);
    }
  }
  return errors;
}

/** The keys a shell writer's `printf` format carries, by kind: `[{ kind, keys, line }]`. */
function printfKeys(text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    if (!/printf/.test(line)) return;
    const kind = /"kind"\s*:\s*"([a-z.]+)"/.exec(line);
    if (!kind) return;
    found.push({ kind: kind[1], keys: [...line.matchAll(/"([a-z][a-z0-9_]*)"\s*:/g)].map((match) => match[1]), line: index + 1 });
  });
  return found;
}

/**
 * Every observed line key is declared, and every declared field is observed.
 * `observations` is `[{ source, kind, keys }]`; common keys are checked for membership only.
 */
function checkAllowlist(registry, observations) {
  const errors = [];
  const common = new Set(registry.common);
  const seen = new Map(Object.keys(registry.kinds).map((kind) => [kind, new Set()]));
  for (const { source, kind, keys } of observations) {
    if (!Object.hasOwn(registry.kinds, kind)) { errors.push(`${source}: kind '${kind}' is not in ${REGISTRY_FILE}`); continue; }
    for (const key of keys) {
      if (common.has(key) || key === 'kind') continue;
      if (!Object.hasOwn(registry.kinds[kind].fields, key)) errors.push(`${source}: kind ${kind} writes '${key}', which ${REGISTRY_FILE} does not declare`);
      seen.get(kind).add(key);
    }
  }
  for (const [kind, spec] of Object.entries(registry.kinds)) {
    for (const key of Object.keys(spec.fields)) {
      if (!seen.get(kind).has(key)) errors.push(`${REGISTRY_FILE} kind ${kind} declares '${key}', which no writer, format or fixture line carries`);
    }
  }
  return errors;
}

/** A value that passes `type`, for the writer observation. */
function sampleValue(type, vocabularies) {
  const atom = type.split('|').find((candidate) => candidate !== 'null');
  if (atom.startsWith('enum:')) return vocabularies[atom.slice(5)][0];
  return {
    token: 'a', id: 'a', uint: 1, int: -1, hex16: '0'.repeat(16), hex32: '0'.repeat(32),
    iso8601ms: '2026-10-17T00:00:00.000Z', date: '2026-10-17',
  }[atom];
}

/** What the real `TelemetryWriter` writes for a record that supplies every declared key plus a stranger. */
function writerObservations(registry) {
  const root = suiteTempDir('doflow-g44-');
  try {
    fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
    const records = Object.entries(registry.kinds)
      .filter(([, spec]) => spec.writers.includes(WRITER_FILE))
      .map(([kind, spec]) => ({
        kind,
        stranger_key: 'x',
        ...Object.fromEntries(Object.entries(spec.fields).map(([key, field]) => [key, sampleValue(field.type, registry.vocabularies)])),
      }));
    new TelemetryWriter({ registry, env: {}, start: root, now: () => new Date('2026-10-17T00:00:00.000Z') }).write(records);
    const dir = path.join(root, '.doflow', 'state', 'runs', 'telemetry');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const parsed = JSON.parse(line);
      return { source: `${WRITER_FILE} (TelemetryWriter output)`, kind: parsed.kind, keys: Object.keys(parsed) };
    }));
  } finally {
    removeTree(root);
  }
}

function shippedObservations(registry) {
  const observations = writerObservations(registry);
  // Scan the observer even before its declaration lands: missing registry keys must stay red.
  const shellWriters = new Set(['core/harnesses/claude/hooks/post-shell-observe.sh',
    ...Object.values(registry.kinds).flatMap((spec) => spec.writers.filter((writer) => writer.endsWith('.sh')))]);
  for (const file of shellWriters) {
    const abs = path.join(REPO, file);
    if (!fs.existsSync(abs)) continue;
    for (const hit of printfKeys(fs.readFileSync(abs, 'utf8'))) observations.push({ source: `${file}:${hit.line}`, kind: hit.kind, keys: hit.keys });
  }
  const dir = path.join(REPO, FIXTURE_DIR);
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
      fs.readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, index) => {
        if (!line.trim()) return;
        const parsed = JSON.parse(line);
        observations.push({ source: `${FIXTURE_DIR}/${name}:${index + 1}`, kind: parsed.kind, keys: Object.keys(parsed) });
      });
    }
  }
  return observations;
}

/** Tuple fields stay covered by fixtures even when their writers emit them directly. */
function checkTupleFixtures(observations) {
  const errors = [];
  for (const [kind, fields] of Object.entries(TUPLE_FIXTURE_FIELDS)) {
    const fixture = observations.find(({ source, kind: observedKind }) =>
      source.startsWith(`${FIXTURE_DIR}/`) && observedKind === kind);
    if (!fixture) {
      errors.push(`${FIXTURE_DIR}: no fixture line for tuple kind ${kind}`);
      continue;
    }
    for (const field of fields) {
      if (!fixture.keys.includes(field)) errors.push(`${fixture.source}: kind ${kind} fixture line lacks '${field}'`);
    }
  }
  return errors;
}

// --- G45.2: no node on a shell hook path --------------------------------------------------------

const HOOK_ROOTS = ['core/harnesses/shared/hooks', 'core/harnesses/antigravity/hooks', 'core/harnesses/claude/hooks',
  'core/harnesses/codex/hooks', 'core/harnesses/gemini/hooks', 'core/harnesses/kiro/hooks', 'core/harnesses/pi/extensions'];
/** The only scripts that are node by nature: the shared runner, the Antigravity adapter, the Pi extension. */
const PINNED_NODE_FILES = ['core/harnesses/pi/extensions/doflow-guard.js', 'core/harnesses/shared/hooks/adapters/antigravity.js', 'core/harnesses/shared/hooks/stream-hook-runner.js'];
/** Front doors that hand the payload to the shared runner by design (`exec node .../stream-hook-runner.js`). */
const PINNED_RUNNER_DOORS = ['core/harnesses/antigravity/hooks/pre-implementation-gate.sh', 'core/harnesses/antigravity/hooks/stop-check.sh'];
/** Shell observation must remain covered by the same no-node scan as the pre-tool front doors. */
const PINNED_SHELL_DOORS = [
  ...['claude', 'codex', 'gemini', 'kiro'].map((harness) => `core/harnesses/${harness}/hooks/pre-bash-guard.sh`),
  'core/harnesses/claude/hooks/post-shell-observe.sh',
];
function checkPinnedShellDoors(files) {
  return PINNED_SHELL_DOORS.filter((door) => !files.some(({ rel }) => rel === door))
    .map((door) => `pinned shell front door ${door} is gone: update PINNED_SHELL_DOORS`);
}
const NODE_COMMAND = /(^|[;&|(`]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|(?:env|exec|command|sudo|then|do|else|elif|if|while|until|time)\s+)*(?:node|nodejs|npx|tsx|deno|bun)(?=\s|$|;|\))/;

/** `files` is `[{ rel, text }]`: every file under the hook roots. */
function checkNoNodeOnHooks(files) {
  const errors = [];
  const isScript = (rel) => /\.(?:sh|jq|conf)$/.test(rel);
  const isNodeFile = (rel) => /\.(?:js|cjs|mjs|ts)$/.test(rel);
  for (const { rel, text } of files) {
    if (isNodeFile(rel)) {
      if (!PINNED_NODE_FILES.includes(rel)) errors.push(`${rel} is a node file on a hook path and is not in the pinned list`);
      continue;
    }
    if (!isScript(rel) && !text.startsWith('#!')) continue;
    text.split('\n').forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      if (PINNED_RUNNER_DOORS.includes(rel) && /^\s*exec node "\$\(dirname "\$0"\)\/\.\.\/\.\.\/\.doflow\/shared\/hooks\/stream-hook-runner\.js" \w+\s*$/.test(line)) return;
      // jq regex strings name runners to classify them; quoted jq data cannot start a process.
      const code = rel.endsWith('.jq') ? line.replace(/"(?:[^"\\]|\\.)*"/g, '""') : line;
      if (NODE_COMMAND.test(code)) errors.push(`${rel}:${index + 1} starts a node process on a hook path`);
    });
  }
  for (const pinned of PINNED_NODE_FILES) {
    if (!files.some(({ rel }) => rel === pinned)) errors.push(`pinned node file ${pinned} is gone: update PINNED_NODE_FILES`);
  }
  return errors;
}

// --- G45.3: no network client in the runtime ----------------------------------------------------

/** The model-endpoint client of feature 072; 091 adds otlp-export.ts (DEC-008, O1). */
const PINNED_NETWORK_FILES = ['src/runtime/advice/client.ts', 'src/runtime/advice/endpoint-guard.ts', 'src/runtime/trace/otlp-export.ts'];
const NETWORK_ROOTS = ['src'];
const NETWORK_EXT = /\.(?:ts|js|mjs|cjs|mts|cts)$/;
const NETWORK_MODULES = /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici)(?:\/.*)?$/;
/** Identifiers that reach the network without a module load (C-2): any reference, member access included. */
const NETWORK_IDENTIFIERS = /(?<![\w$])(?:fetch|WebSocket|EventSource|getBuiltinModule|undici)(?![\w$])|(?<![\w$.])(?:globalThis|global)\s*(?:\?\.)?\s*\[|\bprocess\s*\.\s*(?:binding|_linkedBinding)\b/g;

/**
 * The source with comments blanked and string, template and regex literal bodies masked, keeping
 * offsets and newlines, plus the string literals found: `{ code, literals: [{ start, end, value }] }`.
 * A template literal is kept as one literal only when it has no `${`.
 */
function maskSource(text) {
  const out = text.split('');
  const literals = [];
  const blank = (from, to, keepQuotes) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] === '\n') continue;
      if (keepQuotes && (k === from || k === to - 1)) continue;
      out[k] = keepQuotes ? 'x' : ' ';
    }
  };
  const regexAllowedAfter = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      let j = text.indexOf('\n', i);
      if (j === -1) j = text.length;
      blank(i, j, false);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j === -1 ? text.length : j + 2;
      blank(i, j, false);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, text.length);
      literals.push({ start: i, end, quote: c, value: text.slice(i + 1, end - 1) });
      blank(i, end, true);
      i = end;
      continue;
    }
    if (c === '`') {
      // Template text is masked; `${...}` expressions stay code. Only a template with none is a literal.
      let j = i + 1;
      let interpolated = false;
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\') { if (text[j + 1] !== '\n') out[j + 1] = 'x'; out[j] = 'x'; j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '{') {
          interpolated = true;
          let depth = 1;
          j += 2;
          while (j < text.length && depth > 0) {
            if (text[j] === '{') depth += 1;
            else if (text[j] === '}') depth -= 1;
            j += 1;
          }
          continue;
        }
        if (text[j] !== '\n') out[j] = 'x';
        j += 1;
      }
      const end = Math.min(j + 1, text.length);
      if (!interpolated) literals.push({ start: i, end, quote: c, value: text.slice(i + 1, end - 1) });
      i = end;
      continue;
    }
    if (c === '/' && regexAllowedAfter.test(text.slice(Math.max(0, i - 12), i).trimEnd() || '(')) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      if (text[j] === '/') {
        blank(i, j + 1, true);
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return { code: out.join(''), literals };
}

/** Network use in one file (C-2): a network module load, a network identifier, or a load with a non-literal argument. */
function networkUses(text) {
  const { code, literals } = maskSource(text);
  const literalAt = new Map(literals.map((lit) => [lit.start, lit]));
  const hits = [];
  const add = (offset, what) => hits.push({ line: text.slice(0, offset).split('\n').length, what });
  for (const match of code.matchAll(NETWORK_IDENTIFIERS)) add(match.index, match[0].trim());
  // require(...) and import(...): the argument must be one plain string literal; then its module is checked.
  for (const match of code.matchAll(/(?<![\w$.])(require|import)\s*\(/g)) {
    let k = match.index + match[0].length;
    while (/\s/.test(code[k] || '')) k += 1;
    const lit = literalAt.get(k);
    let after = lit ? lit.end : k;
    while (/\s/.test(code[after] || '')) after += 1;
    if (!lit || code[after] !== ')') { add(match.index, `${match[1]} with a non-literal argument`); continue; }
    if (NETWORK_MODULES.test(lit.value)) add(match.index, `${match[1]}('${lit.value}')`);
  }
  // static import / export ... from '<module>' and bare import '<module>'
  for (const match of code.matchAll(/(?<![\w$.])(?:from|import)\s*(?=['"])/g)) {
    const lit = literalAt.get(match.index + match[0].length);
    if (lit && NETWORK_MODULES.test(lit.value)) add(match.index, `import '${lit.value}'`);
  }
  return hits;
}

function checkNoNetwork(files) {
  const errors = [];
  for (const { rel, text } of files) {
    if (PINNED_NETWORK_FILES.includes(rel)) continue;
    for (const hit of networkUses(text)) errors.push(`${rel}:${hit.line} uses a network module outside an export module (${hit.what})`);
  }
  return errors;
}

// --- G45.4: no model-facing step ----------------------------------------------------------------

const MODEL_FACING = /trace\s+(?:spans|export|analyze)\b|verify-baseline/;
const MODEL_FACING_ROOTS = ['core/shared/skills', 'core/shared/guidance', 'core/shared/agent-specs', 'core/shared/workflows'];

function checkNoModelStep(files) {
  const errors = [];
  for (const { rel, text } of files) {
    text.split('\n').forEach((line, index) => {
      const hit = MODEL_FACING.exec(line);
      if (hit) errors.push(`${rel}:${index + 1} names '${hit[0]}' in a skill or guidance file`);
    });
  }
  return errors;
}

// --- G45.5: zero dependencies -------------------------------------------------------------------

const FORBIDDEN_DEPENDENCY_KEYS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

function isNonEmptyDependency(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function checkZeroDependencies(packageText, adviceGuardText) {
  const errors = [];
  const manifest = JSON.parse(packageText);
  for (const key of FORBIDDEN_DEPENDENCY_KEYS) {
    if (isNonEmptyDependency(manifest[key])) errors.push(`package.json has ${key}`);
  }
  if (Array.isArray(manifest.files)) {
    for (const entry of manifest.files) {
      if (typeof entry === 'string') {
        // Normalise the way npm resolves an entry: a leading '/', a '..' segment or a case-folding
        // file system ('Console/') still ships console/, so each spelling must meet the check.
        let norm = entry.replace(/\\/g, '/');
        norm = path.posix.normalize(norm);
        while (norm.startsWith('./') || norm.startsWith('/')) {
          norm = norm.startsWith('./') ? norm.slice(2) : norm.slice(1);
        }
        if (norm.startsWith('../')) continue;
        norm = norm.toLowerCase();
        if (norm === 'console' || norm.startsWith('console/')) {
          errors.push(`package.json files ships console (${entry})`);
        }
      }
    }
  }
  if (!/G30\.2: shipped package has no runtime dependencies/.test(adviceGuardText)) errors.push('test/guards/advice.test.js no longer enforces G30.2');
  return errors;
}

// --- G45.6: telemetry dirs are declared runs/ subdirectories the ledger readers skip -------------

const LEDGER_PARTITION = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function checkStoreIsolation(registry, storage) {
  const errors = [];
  const stores = new Map(storage.stores.map((store) => [store.id, store]));
  for (const [kind, spec] of Object.entries(registry.kinds)) {
    const store = stores.get(spec.store);
    if (!store) { errors.push(`kind ${kind} names store '${spec.store}', which core/registry/storage.json does not declare`); continue; }
    const segments = store.path.split('/');
    if (store.root !== 'project-state' || segments[0] !== 'runs' || segments.length < 2) errors.push(`store ${store.id} must be a subdirectory of project-state runs/, not '${store.root}:${store.path}'`);
    else if (LEDGER_PARTITION.test(segments[1])) errors.push(`store ${store.id} path ${store.path} would be listed as a ledger partition`);
    for (const writer of spec.writers) {
      if (!store.writers.includes(writer)) errors.push(`store ${store.id} does not list ${writer}, which ${REGISTRY_FILE} names as a writer of ${kind}`);
    }
  }
  for (const entry of registry.excludedStores) {
    if (stores.has(entry.store) && !entry.reason) errors.push(`excluded store ${entry.store} has no reason`);
  }
  return errors;
}

// --- G45.7: the export block maps only closed descriptors and the analysis block is well formed ---

const REQUIRED_ANALYSIS_KEYS = ['minSamples', 'tailRatio', 'minTailMs', 'retryRun'];
const OWNED_NAMES_LISTS = new Set(['cli-commands', 'workflow-stages', 'workflow-classes']);
const COMMIT_HEX40 = /^[0-9a-f]{40}$/;

function checkExportMapping(reg) {
  const errors = [];
  const at = (where, message) => errors.push(`${REGISTRY_FILE} ${where}: ${message}`);

  const analysis = reg.analysis;
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
    at('analysis', 'missing or not an object');
  } else {
    for (const key of REQUIRED_ANALYSIS_KEYS) {
      if (!Object.hasOwn(analysis, key)) {
        at(`analysis.${key}`, 'missing key');
      } else {
        const val = analysis[key];
        if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
          at(`analysis.${key}`, 'must be a positive integer');
        }
      }
    }
  }

  const exp = reg.export;
  if (!exp || typeof exp !== 'object' || Array.isArray(exp)) {
    at('export', 'missing or not an object');
    return errors;
  }

  const semconv = exp.semconv;
  if (!semconv || typeof semconv !== 'object') {
    at('export.semconv', 'missing or not an object');
  } else {
    if (typeof semconv.commit !== 'string' || !COMMIT_HEX40.test(semconv.commit)) {
      at('export.semconv.commit', 'must be 40 lowercase hex');
    }
    if (typeof semconv.schemaUrl !== 'string' || !semconv.schemaUrl.startsWith('https://')) {
      at('export.semconv.schemaUrl', 'must be an https:// URL');
    }
  }

  const names = exp.names || {};
  for (const [key, value] of Object.entries(names)) {
    if (!OWNED_NAMES_LISTS.has(value)) {
      at(`export.names.${key}`, `'${value}' must be one of cli-commands, workflow-stages, workflow-classes`);
    }
  }

  const localFields = new Set([
    ...(Array.isArray(reg.common) ? reg.common : []),
    ...Object.keys(names),
  ]);
  const fieldClasses = new Map();
  if (reg.commonClasses) {
    for (const [key, cls] of Object.entries(reg.commonClasses)) {
      if (!fieldClasses.has(key)) fieldClasses.set(key, new Set());
      fieldClasses.get(key).add(cls);
    }
  }
  for (const kindSpec of Object.values(reg.kinds || {})) {
    for (const [key, field] of Object.entries(kindSpec.fields || {})) {
      localFields.add(key);
      if (!fieldClasses.has(key)) fieldClasses.set(key, new Set());
      if (field.class) fieldClasses.get(key).add(field.class);
    }
  }

  const vocabularies = reg.vocabularies || {};
  const attributes = exp.attributes || {};
  for (const [key, attrSpec] of Object.entries(attributes)) {
    const where = `export.attributes.${key}`;
    if (!localFields.has(key)) {
      at(where, `'${key}' is not a local field`);
    }

    // The typed rule check the mapper itself applies (one shared function, C-1).
    const checked = attributeRule(key, attrSpec);
    if ('error' in checked) at(where, checked.error);

    if (!('error' in checked) && checked.rule === 'vocabulary') {
      const vocab = attrSpec.vocabulary;
      const exists = Object.hasOwn(vocabularies, vocab) || OWNED_NAMES_LISTS.has(vocab);
      if (!exists) {
        at(`${where}.vocabulary`, `'${vocab}' is neither in vocabularies nor an owned list`);
      }
    }

    const classes = fieldClasses.get(key) || new Set();
    if (classes.has('T2-local')) {
      at(where, `attribute '${key}' has class T2-local and cannot be exported`);
    }
    if (classes.has('T0') && ('error' in checked || checked.rule !== 'id')) {
      at(where, `T0 attribute '${key}' listed without id: true`);
    }
  }

  return errors;
}

// --- file helpers -------------------------------------------------------------------------------

function filesUnder(relativeRoot, accept = () => true) {
  const root = path.join(REPO, relativeRoot);
  if (!fs.existsSync(root)) return [];
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(REPO, full).split(path.sep).join('/');
        if (accept(rel)) found.push({ rel, text: fs.readFileSync(full, 'utf8') });
      }
    }
  }(root));
  return found;
}

const registry = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));
const storage = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/storage.json'), 'utf8'));

// --- Tests --------------------------------------------------------------------------------------

test('G45.1: telemetry.json is well formed, its owned vocabularies match their owners, and its keys equal what is written', () => {
  assert.deepEqual(checkRegistryShape(registry), []);
  const harnesses = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/harnesses.json'), 'utf8'));
  const verification = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/verification.json'), 'utf8'));
  assert.deepEqual(checkVocabularyOwners(registry, {
    harness: { owner: 'core/registry/harnesses.json', values: harnesses.harnesses.map((entry) => entry.id) },
    status: { owner: 'core/registry/verification.json tierStatuses', values: verification.tierStatuses },
    risk: { owner: 'core/registry/verification.json riskLevels', values: Object.keys(verification.riskLevels) },
    depth: { owner: 'core/registry/verification.json reviewDepth.depths', values: Object.keys(verification.reviewDepth.depths) },
    role: { owner: 'core/harnesses/shared/hooks/bridge/envelope.jq role literals', values: ['main', 'worker'] },
  }), []);
  const observations = shippedObservations(registry);
  assert.deepEqual(checkAllowlist(registry, observations), []);
  assert.deepEqual(checkTupleFixtures(observations), []);
});

test('G45.1: observer runtime has its own measure and the prose states hook latency, L3 flag and line-size semantics', () => {
  assert.deepEqual(registry.kinds.hook.fields.tool_duration_ms, {
    name: 'doflow.hook.tool_duration_ms', class: 'T1', type: 'uint|null', phase: 'P3',
  });
  const contract = fs.readFileSync(path.join(REPO, 'docs/specs/telemetry-contract.md'), 'utf8');
  const hookRows = contract.split('## Hook lines\n')[1].split('## Verify lines\n')[0];
  const latency = hookRows.split('\n').find((line) => line.startsWith('| `duration_ms` |'));
  const runtime = hookRows.split('\n').find((line) => line.startsWith('| `tool_duration_ms` |'));
  assert.match(latency, /hook latency.*always null on `post-shell-observe`/);
  assert.match(runtime, /T1 \| P3 \|.*native `duration_ms` runtime on the observer.*null on other hook lines/);
  assert.match(hookRows, /Hook lines carry no content and may reach about 700 bytes with maximum-length ids/);
  const v0 = contract.split('\n').find((line) => line.startsWith('| `verify.run` | `v0` |'));
  assert.match(v0, /L3 is null with the flag on and `off` with the flag off; dispatch is null/);
});

test('088 docs name the shipped reports, manifest exits, guard inventory and observed baseline', () => {
  const reference = fs.readFileSync(path.join(REPO, 'docs/reference.md'), 'utf8');
  assert.doesNotMatch(reference, /pVal|significant|summary\.md/);
  const baseline = reference.split('\n').find((line) => line.startsWith('| `bench verify-baseline '));
  assert.match(baseline, /`report\.json`, `report\.md`/);
  assert.match(baseline, /manifest mismatch exits 1.*malformed snapshot\/manifest exits 2/);

  const architecture = fs.readFileSync(path.join(REPO, 'docs/architecture.md'), 'utf8').split('### The guard suite\n')[1].split('## Contributor guardrails')[0];
  const entries = [...architecture.matchAll(/^- \*\*(G\d+)\*\* \(`([^`]+\.test\.js)`/gm)];
  const files = new Set(entries.map((entry) => entry[2]));
  const numbers = new Set(entries.map((entry) => entry[1]));
  const guards = fs.readdirSync(path.join(REPO, 'test/guards')).filter((file) => file.endsWith('.test.js'));
  assert.ok(entries.length > 40 && guards.length > 50, 'the guard directory and inventory were found');
  for (const file of files) assert.ok(guards.includes(file), `${file} is an actual guard`);
  assert.match(architecture, new RegExp(`holds\\s+${guards.length} test files`));
  assert.ok(architecture.includes(`${entries.length} entries across ${files.size} test files and carries ${numbers.size} distinct G-numbers`));

  const release = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8').split('\n').find((line) => line.startsWith('- **Feature 088 '));
  assert.match(release, /`tool_duration_ms`.*`duration_ms:null`/);
  assert.match(release, /bounded output excerpts in the in-flight store with a short TTL/);
  assert.match(release, /baseline shown as observed, not a result/);
});

test('G45.2: no node process is started on a shell hook path, and the node files are the pinned three', () => {
  const files = HOOK_ROOTS.flatMap((root) => filesUnder(root));
  assert.ok(files.length > 20, 'the hook roots were found');
  assert.deepEqual(checkNoNodeOnHooks(files), []);
  assert.deepEqual(checkPinnedShellDoors(files), []);
});

test('G45.3: no network module, fetch or dynamic load under src outside the pinned advice client and export sender', () => {
  const files = NETWORK_ROOTS.flatMap((root) => filesUnder(root, (rel) => NETWORK_EXT.test(rel)));
  assert.ok(files.length > 50);
  assert.ok(files.some(({ rel }) => rel.startsWith('src/cli/')), 'src/cli is scanned');
  for (const pinned of PINNED_NETWORK_FILES) assert.ok(files.some(({ rel }) => rel === pinned), `${pinned} exists`);
  assert.deepEqual(checkNoNetwork(files), []);
});

test('G45.4: no skill, guidance or agent spec sends the model to a trace view or the baseline', () => {
  const files = MODEL_FACING_ROOTS.flatMap((root) => filesUnder(root, (rel) => /\.(?:md|json|yaml|yml|toml)$/.test(rel)));
  assert.ok(files.length > 20);
  assert.deepEqual(checkNoModelStep(files), []);
});

test('G45.5: the package has no runtime dependency and G30.2 is still enforced', () => {
  assert.deepEqual(checkZeroDependencies(
    fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'),
    fs.readFileSync(path.join(REPO, 'test/guards/advice.test.js'), 'utf8'),
  ), []);
});

test('G45.6: telemetry stores are declared runs/ subdirectories, and the ledger readers do not see them', (t) => {
  assert.deepEqual(checkStoreIsolation(registry, storage), []);
  const dir = tempDir(t, 'doflow-g44-ledger-');
  fs.mkdirSync(path.join(dir, 'telemetry'));
  fs.writeFileSync(path.join(dir, 'telemetry', '2026-10-17.jsonl'), `${JSON.stringify({ timestamp: '2026-10-17T00:00:00.000Z', kind: 'hook', verb: 'trace' })}\n`);
  const read = new RunLedger({ dir }).read();
  assert.deepEqual([read.files, read.records.length, read.malformedLines], [[], 0, 0], 'RunLedger lists only partitions directly under runs/');
});

test('G45.7: the export block maps only closed descriptors and the analysis block is well formed', () => {
  assert.deepEqual(checkExportMapping(registry), []);
});

// --- Self-tests: every check fails on a planted violation ----------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value));
/** The registry with no kind fields, so a planted field is the only one the self-tests see. */
const bare = clone(registry);
for (const spec of Object.values(bare.kinds)) spec.fields = {};
const withField = (key, field) => {
  const copy = clone(bare);
  copy.kinds['verify.run'].fields[key] = field;
  return copy;
};
const GOOD_FIELD = { name: 'doflow.verify.run.duration_ms', class: 'T1', type: 'uint|null', phase: 'P2' };

test('G45.1 self-test: a registry that is missing a key a fixture line carries fails, naming kind and key', () => {
  const declared = withField('duration_ms', GOOD_FIELD);
  const lines = [{ source: 'fixture:1', kind: 'verify.run', keys: ['timestamp', 'kind', 'run', 'lineage', 'attempt', 'duration_ms'] }];
  assert.deepEqual(checkAllowlist(declared, lines), []);
  const errors = checkAllowlist(bare, lines);
  assert.deepEqual(errors, ["fixture:1: kind verify.run writes 'duration_ms', which core/registry/telemetry.json does not declare"]);
  assert.match(checkAllowlist(registry, [{ source: 'f:1', kind: 'span', keys: [] }]).join('\n'), /kind 'span' is not in core\/registry\/telemetry\.json/);
});

test('G45.1 self-test: a declared key nothing writes fails, and a printf format is read for its keys', () => {
  const declared = withField('duration_ms', GOOD_FIELD);
  assert.match(checkAllowlist(declared, []).join('\n'), /kind verify\.run declares 'duration_ms', which no writer/);
  const format = "printf '{\"kind\":\"hook\",\"harness\":\"%s\",\"duration_ms\":%s,%s\\n' a b c >>\"$f\"\necho '{\"kind\":\"hook\",\"x\":1}'\n";
  assert.deepEqual(printfKeys(format), [{ kind: 'hook', keys: ['kind', 'harness', 'duration_ms'], line: 1 }]);
  const errors = checkAllowlist(bare, printfKeys(format).map((hit) => ({ source: 'bridge.sh:1', kind: hit.kind, keys: hit.keys })));
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.match(errors[0], /kind hook writes 'harness'/);
});

test('G45.1 self-test: tuple fixture lines fail when a new tuple key is missing', () => {
  const complete = Object.entries(TUPLE_FIXTURE_FIELDS).map(([kind, fields]) => ({
    source: `${FIXTURE_DIR}/${kind.replace('.', '-')}.jsonl:1`, kind, keys: fields,
  }));
  assert.deepEqual(checkTupleFixtures(complete), []);
  for (const [kind, fields] of Object.entries(TUPLE_FIXTURE_FIELDS)) {
    for (const field of fields) {
      const fixture = complete.find((entry) => entry.kind === kind);
      const missing = complete.map((entry) => entry.kind === kind
        ? { ...entry, keys: entry.keys.filter((key) => key !== field) }
        : entry);
      assert.deepEqual(checkTupleFixtures(missing), [`${fixture.source}: kind ${kind} fixture line lacks '${field}'`]);
    }
  }
});

test('G45.1 self-test: the real writer drops a key the registry lacks and writes the one it declares', () => {
  const declared = withField('duration_ms', GOOD_FIELD);
  const keys = writerObservations(declared).find((line) => line.kind === 'verify.run').keys;
  assert.ok(keys.includes('duration_ms'));
  assert.ok(!keys.includes('stranger_key'), 'an unknown key never reaches the line');
  assert.deepEqual(checkAllowlist(declared, writerObservations(declared)).filter((message) => /verify\.run/.test(message)), []);
});

test('G45.1 self-test: a malformed registry fails on class, name, type, collision, T4, gen_ai and kind list', () => {
  assert.deepEqual(checkRegistryShape(withField('duration_ms', GOOD_FIELD)), []);
  const cases = [
    [{ ...GOOD_FIELD, class: 'T9' }, /class: names an unknown class/],
    [{ ...GOOD_FIELD, class: 'T4' }, /T4 content is never recorded/],
    [{ ...GOOD_FIELD, name: 'doflow.verify.run.other' }, /name: must be 'doflow\.verify\.run\.duration_ms'/],
    [{ ...GOOD_FIELD, type: 'string' }, /unknown type 'string'/],
    [{ ...GOOD_FIELD, type: 'enum:nope' }, /names no vocabulary 'nope'/],
    [{ ...GOOD_FIELD, type: 'runkey' }, /runkey is for recordFields only/],
    [{ ...GOOD_FIELD, phase: 'soon' }, /phase: must name the phase/],
  ];
  for (const [field, pattern] of cases) assert.match(checkRegistryShape(withField('duration_ms', field)).join('\n'), pattern);
  assert.match(checkRegistryShape(withField('kind', { ...GOOD_FIELD, name: 'doflow.verify.run.kind' })).join('\n'), /repeats a common key/);
  assert.match(checkRegistryShape(withField('Bad-Key', GOOD_FIELD)).join('\n'), /key must match/);
  const exported = clone(registry);
  exported.kinds.hook.fields.model = { name: 'gen_ai.request.model', class: 'T2', type: 'token', phase: 'P2' };
  assert.match(checkRegistryShape(exported).join('\n'), /gen_ai/);
  const extraKind = clone(registry);
  extraKind.kinds.span = { store: 'runs-telemetry', writers: ['x'], fields: {} };
  assert.match(checkRegistryShape(extraKind).join('\n'), /vocabularies\.kind: must list exactly the declared kinds/);
  const noClass = clone(registry);
  delete noClass.commonClasses.run;
  assert.match(checkRegistryShape(noClass).join('\n'), /commonClasses\.run/);
});

test('G45.1 self-test: a vocabulary that differs from its owning registry fails', () => {
  const changed = clone(registry);
  changed.vocabularies.status = changed.vocabularies.status.filter((value) => value !== 'NOT_RUN');
  const errors = checkVocabularyOwners(changed, { status: { owner: 'core/registry/verification.json tierStatuses', values: registry.vocabularies.status } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /vocabularies\.status differs from core\/registry\/verification\.json tierStatuses/);
});

test('G45.2 self-test: a hook file with node -e fails, a comment or a quoted word does not, a new node file fails', () => {
  const hook = (text) => checkNoNodeOnHooks([...PINNED_NODE_FILES.map((rel) => ({ rel, text: '' })), { rel: 'core/harnesses/shared/hooks/policies/x.sh', text }]);
  assert.deepEqual(hook('#!/bin/bash\n# node -e "x"\necho "install node first"\nlog=$(date)\n'), []);
  assert.deepEqual(hook('#!/bin/bash\nnode -e "process.exit(0)"\n'), ['core/harnesses/shared/hooks/policies/x.sh:2 starts a node process on a hook path']);
  for (const command of ['x=1 node a.js', 'cat f | node -e 1', 'true && npx tsx a.ts', 'out=$(node -p 1)', 'exec node a.js', 'env FOO=1 node a.js', 'if true; then bun run x; fi']) {
    assert.equal(hook(`#!/bin/bash\n${command}\n`).length, 1, command);
  }
  const door = (rel, line) => checkNoNodeOnHooks([...PINNED_NODE_FILES.map((file) => ({ rel: file, text: '' })), { rel, text: `#!/usr/bin/env bash\n${line}\n` }]);
  const runner = 'exec node "$(dirname "$0")/../../.doflow/shared/hooks/stream-hook-runner.js" PreToolUse';
  assert.deepEqual(door(PINNED_RUNNER_DOORS[0], runner), [], 'the pinned door may hand over to the shared runner');
  assert.equal(door('core/harnesses/codex/hooks/pre-bash-guard.sh', runner).length, 1, 'no other door may');
  assert.equal(door(PINNED_RUNNER_DOORS[0], 'exec node -e "1"').length, 1, 'and the pinned door may do nothing else');
  const extra = checkNoNodeOnHooks([...PINNED_NODE_FILES.map((rel) => ({ rel, text: '' })), { rel: 'core/harnesses/claude/hooks/new.js', text: '' }]);
  assert.deepEqual(extra, ['core/harnesses/claude/hooks/new.js is a node file on a hook path and is not in the pinned list']);
  assert.match(checkNoNodeOnHooks([]).join('\n'), /pinned node file .* is gone/);
});

test('G45.2 self-test: the observer is a pinned shell front door and starting node in it fails', () => {
  const files = [...PINNED_NODE_FILES, ...PINNED_SHELL_DOORS].map((rel) => ({ rel, text: '' }));
  assert.deepEqual(checkPinnedShellDoors(files), []);
  const observer = 'core/harnesses/claude/hooks/post-shell-observe.sh';
  assert.deepEqual(checkPinnedShellDoors(files.filter(({ rel }) => rel !== observer)), [
    `pinned shell front door ${observer} is gone: update PINNED_SHELL_DOORS`,
  ]);
  assert.deepEqual(checkNoNodeOnHooks(files.map((file) => file.rel === observer ? { ...file, text: 'node -e "1"' } : file)), [
    `${observer}:1 starts a node process on a hook path`,
  ]);
  const jq = 'core/harnesses/shared/hooks/bridge/envelope.jq';
  assert.deepEqual(checkNoNodeOnHooks([...files, { rel: jq, text: 'test("^(npm|pnpm|yarn|bun) test$|^node --test$")' }]), []);
  assert.deepEqual(checkNoNodeOnHooks([...files, { rel: jq, text: 'node -e "1"' }]), [`${jq}:1 starts a node process on a hook path`]);
});

test('G45.3 self-test: a network require, import or fetch fails; the pinned client and comments do not', () => {
  const run = (rel, text) => checkNoNetwork([{ rel, text }]);
  assert.deepEqual(run('src/runtime/trace/x.ts', "const net = require('node:net');\n"), ["src/runtime/trace/x.ts:1 uses a network module outside an export module (require('node:net'))"]);
  assert.equal(run('src/runtime/x.ts', "import http from 'http';\n").length, 1);
  assert.equal(run('src/runtime/x.ts', 'const r = await fetch(url);\n').length, 1);
  assert.equal(run('src/runtime/x.ts', "const { request } = require('undici');\n").length, 1);
  assert.equal(run('src/runtime/x.ts', 'const u = undici.request;\n').length, 1, 'the undici identifier');
  assert.equal(run('src/runtime/trace/otlp-map.ts', 'const r = await fetch(url);\n').length, 1);
  assert.deepEqual(run('src/runtime/trace/otlp-export.ts', 'const r = await fetch(url);\n'), []);
  assert.deepEqual(run('src/runtime/advice/client.ts', "const http = require('node:http');\n"), []);
  // Comments, strings, templates and regex literals are not code.
  assert.deepEqual(run('src/runtime/x.ts', [
    "// require('node:http')", '/**', ' * fetch(x)', ' */', '/* fetch(u) */ const ok = 1;', "const msg = 'do not push, fetch or change git config';",
    'const t = `git fetch ${depth} origin`;', 'const re = /fetch|WebSocket/;', "execFileSync('git', ['fetch', '--depth=1']);",
    'const prefetched = prefetch(2);', "const p = require('./otlp-map.ts');", "import x from './local.ts';", "const q = await import('./lazy.ts');",
  ].join('\n') + '\n'), []);
});

test('G45.3 self-test: every evasion shape of the review fails in an unpinned file (C-2)', () => {
  const shapes = {
    'plain fetch(': "const x = () => fetch('http://127.0.0.1:1');",
    "require('node:http')": "const h = require('node:http');",
    'https.request via require': "const h = require('https'); h.request('https://x');",
    "require('node:net').connect": "require('node:net').connect(1);",
    "import('node:http')": "const p = import('node:http');",
    'globalThis.fetch(': "const x = () => globalThis.fetch('http://127.0.0.1:1');",
    "globalThis['fe'+'tch'](": "const x = () => globalThis['fe' + 'tch']('http://127.0.0.1:1');",
    "require('ht'+'tp')": "const h = require('ht' + 'tp');",
    'require(`node:http`) template': 'const h = require(`node:http`);',
    'require(`${x}`) template': 'const h = require(`${name}`);',
    'multi-line require': "const h = require(\n  'node:http');",
    'new WebSocket(': "const w = () => new WebSocket('ws://127.0.0.1:1');",
    'new EventSource(': "const e = new EventSource('http://x');",
    'alias const f = fetch': 'const f = fetch;',
    '/**/ comment prefix then fetch(': "/**/ const x = () => fetch('http://127.0.0.1:1');",
    "process.getBuiltinModule('node:http')": "const h = process.getBuiltinModule('node:http');",
    'fetchImpl default (otlp-export shape)': "async function s(u, { fetchImpl = (globalThis as any).fetch } = {}) { return fetchImpl(u, { method: 'POST' }); }",
    'member .fetch': 'const r = client.fetch(u);',
    'require(variable)': 'const m = require(name);',
    'import(variable)': 'const m = await import(spec);',
    "export from 'node:tls'": "export { connect } from 'node:tls';",
    'process.binding': "process.binding('tcp_wrap');",
    'fetch inside a template expression': 'const s = `${await fetch(u)}`;',
  };
  for (const [name, code] of Object.entries(shapes)) {
    for (const rel of ['src/runtime/trace/analyze.ts', 'src/cli/net-probe.ts', 'src/runtime/trace/net-probe.mjs', 'src/runtime/x.cjs']) {
      assert.ok(checkNoNetwork([{ rel, text: `${code}\n` }]).length >= 1, `${name} in ${rel} is caught`);
    }
  }
});

test('G45.3 self-test: the real sender with its pin removed, or a verbatim copy under another name, fails (C-2)', () => {
  const sender = fs.readFileSync(path.join(REPO, 'src/runtime/trace/otlp-export.ts'), 'utf8');
  assert.deepEqual(checkNoNetwork([{ rel: 'src/runtime/trace/otlp-export.ts', text: sender }]), [], 'pinned');
  const copy = checkNoNetwork([{ rel: 'src/runtime/trace/otlp-export-copy.ts', text: sender }]);
  assert.ok(copy.length >= 1, 'a verbatim copy of the sender is caught');
  assert.ok(copy.some((message) => /\(fetch\)/.test(message)), copy.join('\n'));
  const advice = fs.readFileSync(path.join(REPO, 'src/runtime/advice/client.ts'), 'utf8');
  assert.ok(checkNoNetwork([{ rel: 'src/runtime/advice/client-copy.ts', text: advice }]).length >= 1, 'a copy of the advice client is caught');
});

test('G45.4 self-test: a skill or guidance file naming a trace view or the baseline fails', () => {
  const run = (text) => checkNoModelStep([{ rel: 'core/shared/skills/do/SKILL.md', text }]);
  assert.deepEqual(run('Run `doflow-run trace spans --json` first.\n'), ["core/shared/skills/do/SKILL.md:1 names 'trace spans' in a skill or guidance file"]);
  assert.equal(run('ok\nthen trace export\n').length, 1);
  assert.equal(run('trace   analyze the ledger\n').length, 1);
  assert.equal(run('npm run bench -- verify-baseline\n').length, 1);
  assert.deepEqual(run('the trace verb reads the ledger; analysis is the user\'s\n'), []);
});

test('G45.5 self-test: a dependency, or a missing G30.2 guard, fails', () => {
  const guard = "test('G30.2: shipped package has no runtime dependencies', () => {});";
  assert.deepEqual(checkZeroDependencies('{"dependencies":{}}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"dependencies":{"left-pad":"1"}}', guard), ['package.json has dependencies']);
  assert.deepEqual(checkZeroDependencies('{"optionalDependencies":{"x":"1"}}', guard), ['package.json has optionalDependencies']);
  assert.deepEqual(checkZeroDependencies('{}', 'nothing'), ['test/guards/advice.test.js no longer enforces G30.2']);

  assert.deepEqual(checkZeroDependencies('{"peerDependencies":{"x":"1"}}', guard), ['package.json has peerDependencies']);
  assert.deepEqual(checkZeroDependencies('{"bundleDependencies":["x"]}', guard), ['package.json has bundleDependencies']);
  assert.deepEqual(checkZeroDependencies('{"bundledDependencies":["x"]}', guard), ['package.json has bundledDependencies']);

  assert.deepEqual(checkZeroDependencies('{"dependencies":[]}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"optionalDependencies":{}}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"optionalDependencies":[]}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"peerDependencies":{}}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"peerDependencies":[]}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"bundleDependencies":[]}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"bundleDependencies":{}}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"bundledDependencies":[]}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"bundledDependencies":{}}', guard), []);

  assert.deepEqual(checkZeroDependencies('{"peerDependencies":true}', guard), ['package.json has peerDependencies']);
  assert.deepEqual(checkZeroDependencies('{"bundleDependencies":"all"}', guard), ['package.json has bundleDependencies']);

  assert.deepEqual(checkZeroDependencies('{"files":["console/"]}', guard), ['package.json files ships console (console/)']);
  assert.deepEqual(checkZeroDependencies('{"files":["console"]}', guard), ['package.json files ships console (console)']);
  assert.deepEqual(checkZeroDependencies('{"files":["console/**"]}', guard), ['package.json files ships console (console/**)']);
  assert.deepEqual(checkZeroDependencies('{"files":["./console"]}', guard), ['package.json files ships console (./console)']);
  assert.deepEqual(checkZeroDependencies('{"files":["console/x.js"]}', guard), ['package.json files ships console (console/x.js)']);

  assert.deepEqual(checkZeroDependencies('{"files":["src/","consoles/"]}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"files":["src/console.ts"]}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"files":[]}', guard), []);
});

test('G45.5 self-test: files entry variants /console, Console/ and src/../console fail (C-7)', () => {
  const guard = "test('G30.2: shipped package has no runtime dependencies', () => {});";
  assert.deepEqual(checkZeroDependencies('{"files":["/console"]}', guard), ['package.json files ships console (/console)']);
  assert.deepEqual(checkZeroDependencies('{"files":["Console/"]}', guard), ['package.json files ships console (Console/)']);
  assert.deepEqual(checkZeroDependencies('{"files":["src/../console"]}', guard), ['package.json files ships console (src/../console)']);
  assert.deepEqual(checkZeroDependencies('{"files":["../console"]}', guard), []);
});

test('G45.6 self-test: an undeclared store, a non-runs path, a ledger-shaped path and an unlisted writer fail', () => {
  const without = { stores: storage.stores.filter((store) => store.id !== 'runs-telemetry') };
  assert.match(checkStoreIsolation(registry, without).join('\n'), /names store 'runs-telemetry', which core\/registry\/storage\.json does not declare/);
  const moved = (patch) => ({ stores: storage.stores.map((store) => (store.id === 'runs-telemetry' ? { ...store, ...patch } : store)) });
  assert.match(checkStoreIsolation(registry, moved({ path: 'telemetry' })).join('\n'), /must be a subdirectory of project-state runs\//);
  assert.match(checkStoreIsolation(registry, moved({ path: 'runs' })).join('\n'), /must be a subdirectory of project-state runs\//);
  assert.match(checkStoreIsolation(registry, moved({ root: 'user-state' })).join('\n'), /must be a subdirectory of project-state runs\//);
  assert.match(checkStoreIsolation(registry, moved({ path: 'runs/2026-10-17.jsonl' })).join('\n'), /would be listed as a ledger partition/);
  assert.match(checkStoreIsolation(registry, moved({ writers: [] })).join('\n'), /does not list src\/runtime\/trace\/telemetry\.ts/);
});

test('G45.7 self-test: a 39-hex commit fails, naming commit', () => {
  const copy = clone(registry);
  copy.export.semconv.commit = '547934afa90a34298441caf80c43b27255c3a29';
  const errors = checkExportMapping(copy);
  assert.match(errors.join('\n'), /commit/);
});

test('G45.7 self-test: an http schema URL fails, naming schemaUrl', () => {
  const copy = clone(registry);
  copy.export.semconv.schemaUrl = 'http://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev';
  const errors = checkExportMapping(copy);
  assert.match(errors.join('\n'), /schemaUrl/);
});

test('G45.7 self-test: an attribute naming no local field fails, naming the field', () => {
  const copy = clone(registry);
  copy.export.attributes.not_a_field = { measure: true };
  const errors = checkExportMapping(copy);
  assert.match(errors.join('\n'), /not_a_field/);
});

test('G45.7 self-test: a vocabulary name that does not exist fails, naming the vocabulary', () => {
  const copy = clone(registry);
  copy.export.attributes.event = { vocabulary: 'nonexistent_vocab' };
  const errors = checkExportMapping(copy);
  assert.match(errors.join('\n'), /nonexistent_vocab/);
});

test('G45.7 self-test: id: true on session fails, naming session', () => {
  const copy = clone(registry);
  copy.export.attributes.session = { id: true };
  const errors = checkExportMapping(copy);
  assert.match(errors.join('\n'), /session/);
});

test('G45.7 self-test: each type variant of the id rule and every malformed rule fails, naming the key (C-1)', () => {
  const plants = [
    ['session', { id: 1 }, /'session' id must be the boolean true/],
    ['policy', { id: 'true' }, /'policy' id must be the boolean true/],
    ['session', { vocabulary: 'harness', id: 1 }, /'session' must hold exactly one of id, vocabulary, measure/],
    ['duration_ms', { measure: 'yes' }, /'duration_ms' measure must be the boolean true/],
    ['event', { vocabulary: 'event', raw: true }, /'event' has unknown rule key\(s\) raw/],
    ['event', {}, /'event' must hold exactly one/],
    ['tool_call_id', { id: 1, export: 'gen_ai.tool.call.id' }, /'tool_call_id' id must be the boolean true/],
  ];
  for (const [key, spec, pattern] of plants) {
    const copy = clone(registry);
    copy.export.attributes[key] = spec;
    assert.match(checkExportMapping(copy).join('\n'), pattern, `${key} ${JSON.stringify(spec)}`);
  }
});

test('G45.7 self-test: a T2-local field listed in export.attributes fails, naming the field (C-12)', () => {
  const copy = clone(registry);
  const [kind] = Object.keys(copy.kinds);
  copy.kinds[kind].fields.planted_local = { name: `doflow.${kind}.planted_local`, class: 'T2-local', type: 'token|null', phase: 'P2' };
  copy.export.attributes.planted_local = { vocabulary: 'event' };
  assert.match(checkExportMapping(copy).join('\n'), /attribute 'planted_local' has class T2-local and cannot be exported/);
});

test('G45.7 self-test: a T0 key listed without id fails, naming the key', () => {
  const copy = clone(registry);
  copy.export.attributes.session = {};
  const errors = checkExportMapping(copy);
  assert.match(errors.join('\n'), /session/);
});

test('G45.7 self-test: a names value outside the three owned lists fails, naming the value', () => {
  const copy = clone(registry);
  copy.export.names.verb = 'not-an-owned-list';
  const errors = checkExportMapping(copy);
  assert.match(errors.join('\n'), /not-an-owned-list/);
});

test('G45.7 self-test: an analysis key of 0 fails, naming the key', () => {
  const copy = clone(registry);
  copy.analysis.minSamples = 0;
  const errors = checkExportMapping(copy);
  assert.match(errors.join('\n'), /minSamples/);
});

test('G45.7 self-test: a missing analysis key fails, naming the key', () => {
  const copy = clone(registry);
  delete copy.analysis.retryRun;
  const errors = checkExportMapping(copy);
  assert.match(errors.join('\n'), /retryRun/);
});

test('G45.7 self-test: a planted gen_ai key in kinds fails checkRegistryShape', () => {
  const copy = clone(registry);
  copy.kinds.hook.fields.gen_ai_model = { name: 'gen_ai.request.model', class: 'T2', type: 'token', phase: 'P2' };
  const errors = checkRegistryShape(copy);
  assert.match(errors.join('\n'), /gen_ai/);
});

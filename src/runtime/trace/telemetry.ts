'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const nodeFs = require('node:fs');
const path = require('node:path');
const { resolveRunsLocation } = require('./ledger.ts');
const { identityFields } = require('../context/identity.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadProtocols, presetIds } = require('../review/protocols.ts');

/**
 * Telemetry contract v1 (088 A.1, IC-001, IC-002): the switch and the writer for the lines that
 * live in `telemetry/<UTC date>.jsonl`, a subdirectory of the run ledger's own directory.
 *
 * Why not `RunLedger`: it drops every line that has no `verb` (ledger.ts `sanitizeRunEvent`) and its
 * readers list only the `YYYY-MM-DD.jsonl` files directly under `runs/`. These lines are keyed on
 * `kind`, carry a field set per kind taken from `core/registry/telemetry.json`, and sit in a
 * subdirectory those readers never see.
 *
 * Rules that constrain everything below.
 *   NFR-004 — records are metadata. A field is written only when the registry names it for the kind
 *   and its value passes that field's type; anything else is dropped by name or becomes null, and
 *   the dropped value is never echoed.
 *   NFR-005 / FR-002 — telemetry never changes an outcome. `write` never throws, writes one
 *   open-and-write per call, never blocks on a non-regular target, and writes nothing at all when
 *   `DOFLOW_TELEMETRY=off`.
 */

/** Same pattern as ledger.ts `SAFE_TOKEN` (not exported there); a test holds the two equal. */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** The run and lineage rule (context/identity.ts `ID_PATTERN`). */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Env = Record<string, string | undefined>;
type Vocabulary = (name: string) => readonly string[] | null;

/**
 * Vocabularies another registry owns, which telemetry.json names in `enum:<name>` types but does not
 * copy (119 C-9): a preset added to protocols.json is a valid `protocol` with no edit here. Each is
 * read from its owner, through the owner's validator, the first time a writer needs it. An owner that
 * cannot be read or fails its validator gives no list, so the field is written null (as any value
 * outside its vocabulary is) and the rest of the line is still written.
 */
const DERIVED_VOCABULARIES: Readonly<Record<string, string>> = Object.freeze({
  depth: 'core/registry/protocols.json review preset depth labels, loosest first',
  protocol: 'core/registry/protocols.json order.review',
});

/** The derived vocabularies read from the registries under `repoRoot`; `{}` when protocols.json is unusable. */
function derivedVocabularies(repoRoot: string = REPO_ROOT): Record<string, string[]> {
  const loaded = loadProtocols({ repoRoot });
  if (!loaded.ok) return {};
  const review: string[] = presetIds(loaded.registry, 'review');
  return {
    depth: [...review].reverse().map((id) => loaded.registry.presets[id].depth),
    protocol: review,
  };
}

/**
 * The one reader of the switch in Node. The bridge and the observer test the same string in shell.
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
function telemetryOff(env: Env = process.env): boolean {
  return env.DOFLOW_TELEMETRY === 'off';
}

/** One type alternative of a field (`token`, `uint`, `enum:<vocabulary>`, ...) against one value. */
function matches(alternative: string, value: unknown, vocabulary: Vocabulary): boolean {
  if (alternative === 'null') return value === null;
  if (alternative === 'uint') return typeof value === 'number' && Number.isFinite(value) && Math.trunc(value) >= 0;
  if (alternative === 'int') return typeof value === 'number' && Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (alternative === 'token') return SAFE_TOKEN.test(value);
  if (alternative === 'id') return ID.test(value);
  if (alternative === 'hex16') return HEX16.test(value);
  if (alternative === 'hex32') return HEX32.test(value);
  if (alternative === 'iso8601ms') return ISO_MS.test(value);
  if (alternative === 'date') return DATE.test(value);
  if (alternative.startsWith('enum:')) {
    const list = vocabulary(alternative.slice(5));
    return Array.isArray(list) && list.includes(value);
  }
  return false; // an unknown type never passes, so a typo in the registry writes null, not content
}

/** The value as it is written: integers truncated, anything failing the field's type null. */
function coerce(type: string, value: unknown, vocabulary: Vocabulary): unknown {
  if (typeof type !== 'string' || !type.split('|').some((alternative) => matches(alternative, value, vocabulary))) return null;
  return typeof value === 'number' ? Math.trunc(value) : value;
}

let shipped: any = null;
function shippedRegistry(): any {
  if (!shipped) shipped = JSON.parse(nodeFs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'telemetry.json'), 'utf8'));
  return shipped;
}

class TelemetryWriter {
  registry: any;
  env: Env;
  fsImpl: any;
  now: () => Date;
  start: string | undefined;
  repoRoot: string;
  derived: Record<string, string[]> | null = null;

  /**
   * @param {Object} [options]
   * @param {Object} [options.registry] a parsed `telemetry.json` (default: the shipped one)
   * @param {Object} [options.env=process.env] the switch, the identity trio and `DOFLOW_CONFIG_DIR`
   * @param {Object} [options.fsImpl=fs] test seam
   * @param {Function} [options.now] returns the current Date; test seam
   * @param {string} [options.start] directory to walk up from for `.doflow` (default: cwd)
   * @param {string} [options.repoRoot=REPO_ROOT] the install root the derived vocabularies are read from
   */
  constructor({ registry, env = process.env, fsImpl = nodeFs, now = () => new Date(), start, repoRoot = REPO_ROOT }: any = {}) {
    this.registry = registry;
    this.repoRoot = repoRoot;
    this.env = env;
    this.fsImpl = fsImpl;
    this.now = now;
    this.start = start;
  }

  /**
   * Appends the records, one line each, in one open-and-write to the partition named for the UTC
   * date of the first line. Never throws; a fault writes nothing.
   * @param {Array<{kind: string}>} records
   * @returns {void}
   */
  write(records: any): void {
    try {
      if (telemetryOff(this.env) || !Array.isArray(records)) return;
      const registry = this.registry || shippedRegistry();
      const lines: string[] = [];
      let first = '';
      for (const record of records) {
        let line: any = null;
        try { line = this.line(registry, record); } catch { line = null; } // a hostile record costs only itself
        if (!line) continue;
        if (!first) first = line.timestamp;
        lines.push(JSON.stringify(line));
      }
      if (!lines.length) return;
      const { dir: ledgerDir } = resolveRunsLocation({ start: this.start, env: this.env, fsImpl: this.fsImpl });
      const dir = path.join(ledgerDir, 'telemetry');
      // Non-recursive: when the ledger directory is absent this throws ENOENT and nothing is written or invented.
      try {
        this.fsImpl.mkdirSync(dir, { recursive: false });
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
      }
      this.append(path.join(dir, `${first.slice(0, 10)}.jsonl`), Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
    } catch {
      // A telemetry fault changes no outcome (FR-002, NFR-005): there is nothing to report to.
    }
  }

  /**
   * Appends to a regular file and nothing else. A FIFO with no reader would block a plain open
   * forever, so: lstat first and skip anything that exists and is not a regular file (FIFO,
   * directory, socket, device, symlink); then open O_NONBLOCK|O_NOFOLLOW so a swap between the lstat
   * and the open fails (ENXIO, ELOOP) instead of blocking or following; then fstat the descriptor.
   */
  append(file: string, data: Buffer): void {
    let known: any = null;
    try {
      known = this.fsImpl.lstatSync(file);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return;
    }
    if (known && !known.isFile()) return;
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = nodeFs.constants;
    const fd = this.fsImpl.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o666);
    try {
      if (!this.fsImpl.fstatSync(fd).isFile()) return;
      for (let done = 0; done < data.length;) done += this.fsImpl.writeSync(fd, data, done);
    } finally {
      this.fsImpl.closeSync(fd);
    }
  }

  /** The sanitised line for one record, or null when it has no registered `kind`. */
  line(registry: any, record: any): any {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const kind = record.kind;
    if (typeof kind !== 'string' || !Object.hasOwn(registry.kinds, kind)) return null;
    const vocabularies = registry.vocabularies;
    const vocabulary: Vocabulary = (name) => {
      if (Object.hasOwn(DERIVED_VOCABULARIES, name)) {
        this.derived ??= derivedVocabularies(this.repoRoot);
        return this.derived[name] ?? null;
      }
      return vocabularies && Object.hasOwn(vocabularies, name) ? vocabularies[name] : null;
    };
    const timestamp = typeof record.timestamp === 'string' && ISO_MS.test(record.timestamp)
      ? record.timestamp
      : this.now().toISOString();
    // Identity comes from the environment only (a caller-supplied value is ignored), as for the ledger.
    const identity = identityFields(this.env);
    const out: any = {
      timestamp,
      kind,
      run: identity.run ?? null,
      lineage: identity.lineage ?? null,
      attempt: identity.attempt === undefined ? null : Number(identity.attempt),
    };
    const fields = registry.kinds[kind].fields || {};
    for (const key of Object.keys(fields)) {
      if (!Object.hasOwn(record, key)) continue;
      out[key] = coerce(fields[key].type, record[key], vocabulary);
    }
    return out;
  }
}

module.exports = { SAFE_TOKEN, DERIVED_VOCABULARIES, derivedVocabularies, telemetryOff, TelemetryWriter };

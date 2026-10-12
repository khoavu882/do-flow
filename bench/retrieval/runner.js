#!/usr/bin/env node
'use strict';

/**
 * Retrieval benchmark runner (074 IC-001, DEC-001): `npm run bench -- retrieval <verb> [flags]`.
 * It parses the global flags, finds the verb in `lib/verbs/<verb>.js` (PD-2), runs it and turns its
 * result into an exit code (priority 2, 3, 4, 1) and, with `--json`, one JSON object. The runner opens
 * no socket, spawns no harness CLI and reads no credential variable.
 */

const fs = require('node:fs');
const path = require('node:path');
const snapshotLib = require('./lib/snapshot.js');
const { defaultTmpDir } = require('./lib/environment.js');

const VERBS = ['verify', 'run', 'rerun', 'capture', 'seal', 'migrate'];
const VERBS_DIR = path.join(__dirname, 'lib', 'verbs');
/** When several exit codes apply, the first in this list wins. */
const PRIORITY = [2, 3, 4, 1];
const GLOBAL_FLAGS = { json: 'bool', snapshot: 'value', tmp: 'value', 'keep-tmp': 'bool' };
/** Environment variable names that look like credentials; never forwarded to a child process. */
const CREDENTIAL_RE = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL)/i;

class UsageError extends Error {}

/** The exit code that wins among `codes` (zeros ignored); 0 when none applies. */
function resolveExitCode(codes) {
  for (const code of PRIORITY) if (codes.includes(code)) return code;
  return 0;
}

/** `process.env` minus credential-looking names, plus `extra`. Names are filtered before any value is read. */
function childEnv(extra = {}) {
  const env = {};
  for (const name of Object.keys(process.env)) if (!CREDENTIAL_RE.test(name)) env[name] = process.env[name];
  return { ...env, ...extra };
}

function parseFlags(args, allowed) {
  const out = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { rest.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const kind = allowed[name];
    if (!kind) throw new UsageError(`unknown flag --${name}`);
    if (kind === 'bool') {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      out[name] = true;
    } else {
      const value = eq !== -1 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
      out[name] = value;
    }
  }
  return { flags: out, rest };
}

function availableVerbs(verbsDir) {
  if (!fs.existsSync(verbsDir)) return [];
  const files = new Set(fs.readdirSync(verbsDir));
  return VERBS.filter((v) => files.has(`${v}.js`));
}

/**
 * `main(args): number`. `io` and `verbsDir` exist so a test can capture output and supply verbs;
 * production callers pass only `args`.
 */
function main(args, { verbsDir = VERBS_DIR, out = (m) => process.stdout.write(`${m}\n`), err = (m) => process.stderr.write(`${m}\n`), repoRoot = snapshotLib.REPO_ROOT } = {}) {
  let verb = null;
  let json = false;
  let snapshotId = 'none';
  const emit = (exitCode, extra = {}) => {
    if (json) out(JSON.stringify({ verb, ok: exitCode === 0, exitCode, snapshotId, ...extra }));
    return exitCode;
  };
  try {
    verb = args[0] && !args[0].startsWith('--') ? args[0] : null;
    json = args.includes('--json');
    if (!verb) throw new UsageError(`usage: retrieval <${VERBS.join('|')}> [flags]`);
    if (!availableVerbs(verbsDir).includes(verb)) {
      throw new UsageError(`unknown verb "${verb}" (available: ${availableVerbs(verbsDir).join(', ') || 'none'})`);
    }
    const mod = require(path.join(verbsDir, `${verb}.js`));
    const { flags, rest } = parseFlags(args.slice(1), { ...GLOBAL_FLAGS, ...(mod.flags || {}) });
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
    json = Boolean(flags.json);

    const snapshotPath = flags.snapshot ? path.resolve(flags.snapshot) : path.join(snapshotLib.RETRIEVAL_DIR, snapshotLib.SNAPSHOT_FILE);
    try { snapshotId = String(snapshotLib.loadSnapshot(snapshotPath).snapshotId); } catch { /* verbs that need it report it */ }
    const tmp = flags.tmp ? path.resolve(flags.tmp) : defaultTmpDir();
    const tmpExisted = fs.existsSync(tmp);
    const log = json ? err : out;
    const ctx = { args: flags, json, snapshotPath, tmp, keepTmp: Boolean(flags['keep-tmp']), repoRoot, log, err, snapshotId };

    let result;
    try {
      result = mod.run(ctx);
    } finally {
      if (!ctx.keepTmp && !tmpExisted) fs.rmSync(tmp, { recursive: true, force: true });
    }
    const { exitCode = 0, codes = [], lines = [], ...rest2 } = typeof result === 'number' ? { exitCode: result } : (result || {});
    for (const line of lines) log(line);
    const code = resolveExitCode([exitCode, ...codes]);
    return emit(code, rest2);
  } catch (error) {
    const code = error instanceof UsageError ? 2 : (Number.isInteger(error.exitCode) ? error.exitCode : 2);
    err(`retrieval${verb ? ` ${verb}` : ''}: ${error.message}`);
    return emit(code, json ? { error: error.message } : {});
  }
}

module.exports = { VERBS, PRIORITY, GLOBAL_FLAGS, CREDENTIAL_RE, UsageError, resolveExitCode, childEnv, parseFlags, availableVerbs, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));

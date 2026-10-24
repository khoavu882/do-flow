'use strict';

/**
 * The six holdout preconditions of `retrieval run --split holdout` (074 IC-003 a to f). They run
 * before anything is decrypted, in order, and the first failure refuses the run with exit 2.
 * This module is not a verb; the runner finds verbs by name and skips it.
 */

const fs = require('node:fs');
const path = require('node:path');
const sealLib = require('../seal.ts');
const snapshotLib = require('../snapshot.ts');
const hybridProtocol = require('../hybrid-protocol.ts');

const THRESHOLDS_PATH = 'bench/retrieval/thresholds.json';
const MAX_RUNS = 6;
const RUNS_PER_HOLDOUT_RUN = 2;
const CONFIGS = ['A', 'B'];

const fail = (precondition: any, message: any, reservation?: any) => ({ ok: false, exitCode: 2, precondition, message, ...(reservation ? { reservation } : {}) });

/** Every object carrying a `status` field, with a label: minN, thresholds[], rules[], costCaps, rerun. */
function approvalEntries(thresholds: any) {
  const out: any = [];
  const walk = (value: any, label: any) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${label}[${i}]`));
    else if (value && typeof value === 'object') {
      if ('status' in value) out.push({ label: value.id || label, entry: value });
      for (const [k, v] of Object.entries(value)) if (v && typeof v === 'object') walk(v, value.id ? `${value.id}.${k}` : `${label}.${k}`);
    }
  };
  for (const [k, v] of Object.entries(thresholds)) walk(v, k);
  return out;
}

function gitOut(repoRoot: any, args: any) {
  try { return snapshotLib.git(repoRoot, args).toString('utf8'); } catch { return null; }
}

function gitOk(repoRoot: any, args: any) {
  try { snapshotLib.git(repoRoot, args); return true; } catch { return false; }
}

/** Result file names ever added in any ref, plus those on disk. */
function resultFilesEver(repoRoot: any) {
  const names = new Set();
  const log = gitOut(repoRoot, ['log', '--all', '--diff-filter=A', '--name-only', '--format=', '--', 'bench/retrieval/results']);
  for (const line of (log || '').split('\n').filter(Boolean)) names.add(path.basename(line));
  const dir = path.join(repoRoot, 'bench', 'retrieval', 'results');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) names.add(f);
  return names;
}

function check({ args = {}, repoRoot, snapshot, thresholds, sealMeta = {}, env = process.env, home }: any) {
  const hybrid = args.protocol === hybridProtocol.ID;
  if (args.protocol && !hybrid) return fail('a', `unknown protocol ${args.protocol}`);
  const resultsDir = path.join(repoRoot, 'bench', 'retrieval', 'results');
  const priorHybridReservation = fs.existsSync(resultsDir) && fs.readdirSync(resultsDir).some((name: any) =>
    name.startsWith(`.hybrid-c-v1-${snapshot.snapshotId}-g`) && name.endsWith('.reserved.json'));
  if (!hybrid && priorHybridReservation) {
    return fail('e', 'hybrid-c-v1 has reserved this snapshot generation; inspect its reservation and aggregates before recovery');
  }
  const configs = hybrid ? hybridProtocol.CONFIGS : CONFIGS;
  const corpora = hybrid ? hybridProtocol.CORPORA : Object.keys(sealMeta);
  // (a) both configurations in one process
  if (args.config !== undefined && args.config !== (hybrid ? 'A,B,C' : 'A,B')) return fail('a', `--config must be ${hybrid ? 'A,B,C' : 'A,B'} so all configurations run in one process`);
  if (hybrid && corpora.some((c: any) => !sealMeta[c])) return fail('a', 'hybrid-c-v1 requires both code and guidance holdouts');

  // (b) every threshold entry approved, with a date
  if (!thresholds) return fail('b', `${THRESHOLDS_PATH} is missing`);
  const unapproved = approvalEntries(thresholds).filter(({ entry }: any) => entry.status !== 'approved' || !entry.approvedOn);
  if (unapproved.length > 0) return fail('b', `entries not approved with approvedOn: ${unapproved.map((u: any) => u.label).join(', ')}`);

  // (c) the thresholds file is tracked and unchanged since HEAD
  if (!gitOk(repoRoot, ['ls-files', '--error-unmatch', THRESHOLDS_PATH])) return fail('c', `${THRESHOLDS_PATH} is not tracked`);
  if (!gitOk(repoRoot, ['diff', '--quiet', 'HEAD', '--', THRESHOLDS_PATH])) return fail('c', `${THRESHOLDS_PATH} differs from HEAD; commit it before the run`);

  // (e) no result for this snapshot, generation, corpus and configuration, on disk or in any ref
  const ever = resultFilesEver(repoRoot);
  for (const corpus of corpora) {
    const meta = sealMeta[corpus];
    if (!meta) continue;
    for (const config of configs) {
      const name = `holdout-${snapshot.snapshotId}-g${meta.generation}-${corpus}-${config}.json`;
      if (ever.has(name)) return fail('e', `a result already exists for ${corpus} configuration ${config} in this generation (${name})`);
    }
  }

  // (f) this run must leave the generation at no more than six configuration runs
  for (const corpus of corpora) {
    const meta = sealMeta[corpus];
    if (!meta) continue;
    const configClass = hybrid ? 'ABC' : 'AB';
    const re = new RegExp(`^holdout-${snapshot.snapshotId}-g${meta.generation}-(code|guidance)-[${configClass}]\\.json$`);
    const used = [...ever].filter((n: any) => re.test(n)).length;
    const needed = hybrid ? 6 : RUNS_PER_HOLDOUT_RUN;
    if (used + needed > MAX_RUNS) return fail('f', `generation ${meta.generation} has ${used} configuration runs; this run would exceed ${MAX_RUNS}`);
  }
  // Reservation is durable before the first decrypt. It deliberately survives every later failure.
  let reservation: any;
  if (hybrid) {
    try { reservation = hybridProtocol.reserveSixSlots({ repoRoot, snapshotId: snapshot.snapshotId, sealMeta, resultFiles: ever }); }
    catch (error: any) { return fail('f', error.message); }
  }
  // (d) the key decrypts every envelope and the plaintext matches its seal
  let key;
  const failBeforeEvaluation = (message: any) => {
    if (reservation) hybridProtocol.releaseBeforeEvaluation({ repoRoot, reservation });
    return fail('d', message);
  };
  try { key = sealLib.resolveKey({ keyFile: args['key-file'], env, home, repoRoot }); } catch (error: any) { return failBeforeEvaluation(error.message); }
  for (const corpus of corpora) {
    const meta = sealMeta[corpus];
    if (!meta) continue;
    try {
      const { plaintextSha256 } = sealLib.decrypt(meta.envelope, key.passphrase, meta.label);
      if (plaintextSha256 !== meta.seal.plaintextSha256) return failBeforeEvaluation(`plaintext of the ${corpus} holdout does not match its seal digest`);
    } catch (error: any) { return failBeforeEvaluation(error.message); }
  }
  return hybrid ? { ok: true, reservation } : { ok: true };
}

module.exports = { check, approvalEntries, THRESHOLDS_PATH, MAX_RUNS };

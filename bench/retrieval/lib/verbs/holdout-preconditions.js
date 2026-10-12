'use strict';

/**
 * The six holdout preconditions of `retrieval run --split holdout` (074 IC-003 a to f). They run
 * before anything is decrypted, in order, and the first failure refuses the run with exit 2.
 * This module is not a verb; the runner finds verbs by name and skips it.
 */

const fs = require('node:fs');
const path = require('node:path');
const sealLib = require('../seal.js');
const snapshotLib = require('../snapshot.js');

const THRESHOLDS_PATH = 'bench/retrieval/thresholds.json';
const MAX_RUNS = 6;
const RUNS_PER_HOLDOUT_RUN = 2;
const CONFIGS = ['A', 'B'];

const fail = (precondition, message) => ({ ok: false, exitCode: 2, precondition, message });

/** Every object carrying a `status` field, with a label: minN, thresholds[], rules[], costCaps, rerun. */
function approvalEntries(thresholds) {
  const out = [];
  const walk = (value, label) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${label}[${i}]`));
    else if (value && typeof value === 'object') {
      if ('status' in value) out.push({ label: value.id || label, entry: value });
      for (const [k, v] of Object.entries(value)) if (v && typeof v === 'object') walk(v, value.id ? `${value.id}.${k}` : `${label}.${k}`);
    }
  };
  for (const [k, v] of Object.entries(thresholds)) walk(v, k);
  return out;
}

function gitOut(repoRoot, args) {
  try { return snapshotLib.git(repoRoot, args).toString('utf8'); } catch { return null; }
}

function gitOk(repoRoot, args) {
  try { snapshotLib.git(repoRoot, args); return true; } catch { return false; }
}

/** Result file names ever added in any ref, plus those on disk. */
function resultFilesEver(repoRoot) {
  const names = new Set();
  const log = gitOut(repoRoot, ['log', '--all', '--diff-filter=A', '--name-only', '--format=', '--', 'bench/retrieval/results']);
  for (const line of (log || '').split('\n').filter(Boolean)) names.add(path.basename(line));
  const dir = path.join(repoRoot, 'bench', 'retrieval', 'results');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) names.add(f);
  return names;
}

function check({ args = {}, repoRoot, snapshot, thresholds, sealMeta = {}, env = process.env, home }) {
  // (a) both configurations in one process
  if (args.config !== undefined && args.config !== 'A,B') return fail('a', '--config must be A,B so both configurations run in one process');

  // (b) every threshold entry approved, with a date
  if (!thresholds) return fail('b', `${THRESHOLDS_PATH} is missing`);
  const unapproved = approvalEntries(thresholds).filter(({ entry }) => entry.status !== 'approved' || !entry.approvedOn);
  if (unapproved.length > 0) return fail('b', `entries not approved with approvedOn: ${unapproved.map((u) => u.label).join(', ')}`);

  // (c) the thresholds file is tracked and unchanged since HEAD
  if (!gitOk(repoRoot, ['ls-files', '--error-unmatch', THRESHOLDS_PATH])) return fail('c', `${THRESHOLDS_PATH} is not tracked`);
  if (!gitOk(repoRoot, ['diff', '--quiet', 'HEAD', '--', THRESHOLDS_PATH])) return fail('c', `${THRESHOLDS_PATH} differs from HEAD; commit it before the run`);

  // (d) the key decrypts every envelope and the plaintext matches its seal
  let key;
  try { key = sealLib.resolveKey({ keyFile: args['key-file'], env, home, repoRoot }); } catch (error) { return fail('d', error.message); }
  for (const [corpus, meta] of Object.entries(sealMeta)) {
    try {
      const { plaintextSha256 } = sealLib.decrypt(meta.envelope, key.passphrase, meta.label);
      if (plaintextSha256 !== meta.seal.plaintextSha256) return fail('d', `plaintext of the ${corpus} holdout does not match its seal digest`);
    } catch (error) {
      return fail('d', error.message);
    }
  }

  // (e) no result for this snapshot, generation, corpus and configuration, on disk or in any ref
  const ever = resultFilesEver(repoRoot);
  for (const [corpus, meta] of Object.entries(sealMeta)) {
    for (const config of CONFIGS) {
      const name = `holdout-${snapshot.snapshotId}-g${meta.generation}-${corpus}-${config}.json`;
      if (ever.has(name)) return fail('e', `a result already exists for ${corpus} configuration ${config} in this generation (${name})`);
    }
  }

  // (f) this run must leave the generation at no more than six configuration runs
  for (const meta of Object.values(sealMeta)) {
    const re = new RegExp(`^holdout-${snapshot.snapshotId}-g${meta.generation}-(code|guidance)-[AB]\\.json$`);
    const used = [...ever].filter((n) => re.test(n)).length;
    if (used + RUNS_PER_HOLDOUT_RUN > MAX_RUNS) return fail('f', `generation ${meta.generation} has ${used} configuration runs; this run would exceed ${MAX_RUNS}`);
  }
  return { ok: true };
}

module.exports = { check, approvalEntries, THRESHOLDS_PATH, MAX_RUNS };

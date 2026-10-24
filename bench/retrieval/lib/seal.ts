'use strict';

/**
 * Holdout sealing (074 IC-014): key resolution, scrypt + AES-256-GCM envelope, seal digest and the
 * canonical JSON every digest in the benchmark is taken over. This module never prints, logs or
 * writes the passphrase, and no error message it throws contains it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ENVELOPE_FORMAT = 'doflow-holdout-v1';
const SEAL_FORMAT = 'doflow-holdout-seal-v1';
const KEY_ENV = 'DOFLOW_HOLDOUT_KEY';
const MIN_ENV_KEY_CHARS = 20;
const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1, maxmem: 67108864 });

/** An error whose message is safe to print; `exitCode` is the runner's exit code for it. */
class SealError extends Error {
  exitCode: any;
  constructor(message: any, exitCode = 2) {
    super(message);
    this.name = 'SealError';
    this.exitCode = exitCode;
  }
}

/** Canonical JSON: keys sorted recursively, no whitespace, UTF-8. */
function canonicalJson(value: any) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function sha256Hex(data: any) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Written JSON: two-space indent and a trailing newline. */
function toFileText(value: any) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isInside(root: any, target: any) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOrResolved(p: any) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function readKeyFile(file: any, { repoRoot, platform, warn }: any) {
  const real = realOrResolved(file);
  if (repoRoot && isInside(realOrResolved(repoRoot), real)) {
    throw new SealError('holdout key file must be outside the repository');
  }
  let stat;
  try { stat = fs.statSync(real); } catch { throw new SealError(`holdout key file not found: ${file}`); }
  if (platform === 'win32') {
    warn('holdout key file mode is not checked on win32');
  } else if ((stat.mode & 0o777) !== 0o600) {
    throw new SealError(`holdout key file must have mode 0600: ${file}`);
  }
  const passphrase = fs.readFileSync(real, 'utf8').split(/\r?\n/)[0];
  if (!passphrase) throw new SealError(`holdout key file is empty: ${file}`);
  return passphrase;
}

/**
 * Key resolution, first match wins: `keyFile`, then `DOFLOW_HOLDOUT_KEY` (at least 20 characters),
 * then `~/.config/doflow/holdout.key`. Returns `{passphrase, source}`, or null with `optional` when
 * none exists. A key that is present but unusable always throws; it never falls through.
 */
function resolveKey({
  keyFile, env = process.env, home = os.homedir(), repoRoot, platform = process.platform,
  warn = (m: any) => process.stderr.write(`warning: ${m}\n`), optional = false,
}: any = {}) {
  if (keyFile) return { passphrase: readKeyFile(keyFile, { repoRoot, platform, warn }), source: 'key-file' };
  if (env[KEY_ENV] !== undefined && env[KEY_ENV] !== '') {
    if (env[KEY_ENV].length < MIN_ENV_KEY_CHARS) {
      throw new SealError(`${KEY_ENV} must be at least ${MIN_ENV_KEY_CHARS} characters`);
    }
    return { passphrase: env[KEY_ENV], source: 'env' };
  }
  const fallback = path.join(home, '.config', 'doflow', 'holdout.key');
  if (fs.existsSync(fallback)) {
    return { passphrase: readKeyFile(fallback, { repoRoot, platform, warn }), source: 'default-file' };
  }
  if (optional) return null;
  throw new SealError(`no holdout key: pass --key-file, set ${KEY_ENV}, or create ~/.config/doflow/holdout.key`);
}

function aadFor(corpus: any, snapshotId: any, generation: any) {
  return `${ENVELOPE_FORMAT}|${corpus}|${snapshotId}|g${generation}`;
}

function deriveKey(passphrase: any, salt: any, kdf = KDF) {
  return crypto.scryptSync(passphrase, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: kdf.maxmem });
}

/** The TaskFile with a canary field added (an existing one is kept). */
function embedCanary(taskFile: any) {
  return taskFile.canary ? taskFile : { ...taskFile, canary: crypto.randomUUID() };
}

/** Encrypts the canonical JSON of `taskFile`. Returns `{envelope, plaintextSha256}`. */
function encrypt({ taskFile, passphrase, corpus, snapshotId, generation }: any) {
  const plaintext = Buffer.from(canonicalJson(taskFile), 'utf8');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const aad = aadFor(corpus, snapshotId, generation);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    envelope: {
      format: ENVELOPE_FORMAT, corpus, snapshotId, generation,
      kdf: { ...KDF, saltB64: salt.toString('base64') },
      cipher: 'aes-256-gcm', ivB64: iv.toString('base64'), aad,
      tagB64: cipher.getAuthTag().toString('base64'), ciphertextB64: ciphertext.toString('base64'),
    },
    plaintextSha256: sha256Hex(plaintext),
  };
}

/** Decrypts an envelope. A wrong key or a changed byte throws `holdout key does not decrypt <label>` (exit 2). */
function decrypt(envelope: any, passphrase: any, label = 'envelope') {
  if (!envelope || envelope.format !== ENVELOPE_FORMAT) throw new SealError(`not a holdout envelope: ${label}`);
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', deriveKey(passphrase, Buffer.from(envelope.kdf.saltB64, 'base64'), envelope.kdf),
      Buffer.from(envelope.ivB64, 'base64'),
    );
    decipher.setAAD(Buffer.from(envelope.aad));
    decipher.setAuthTag(Buffer.from(envelope.tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertextB64, 'base64')), decipher.final()]);
    return { plaintext, plaintextSha256: sha256Hex(plaintext), taskFile: JSON.parse(plaintext.toString('utf8')) };
  } catch {
    throw new SealError(`holdout key does not decrypt ${label}`);
  }
}

/**
 * Seals a TaskFile: embeds the canary, encrypts, and builds the seal digest (IC-014 key order).
 * `classes` is the full class list; classes with no task carry 0. Returns the two file texts.
 */
function sealTasks({
  taskFile, passphrase, corpus, snapshotId, generation, sealedBy, classes, now = new Date(),
}: any) {
  const withCanary = embedCanary(taskFile);
  const { envelope, plaintextSha256 } = encrypt({ taskFile: withCanary, passphrase, corpus, snapshotId, generation });
  const envelopeText = toFileText(envelope);
  const classCounts = Object.fromEntries(classes.map((cls: any) => [cls, 0]));
  for (const task of withCanary.tasks) classCounts[task.class] = (classCounts[task.class] || 0) + 1;
  const seal = {
    format: SEAL_FORMAT, corpus, snapshotId, generation,
    plaintextSha256, ciphertextSha256: sha256Hex(envelopeText),
    taskCount: withCanary.tasks.length, ids: withCanary.tasks.map((t: any) => t.id).sort(), classCounts,
    canary: withCanary.canary, sealedAt: now.toISOString(), sealedBy,
    reuse: { maxRuns: 6, freshWhen: ['tuned-on-holdout', 'runs-exceeded', 'plaintext-leaked'] },
  };
  return { envelopeText, sealText: toFileText(seal), envelope, seal };
}

function envelopePath(dir: any, corpus: any, generation: any) {
  return path.join(dir, `${corpus}.g${generation}.sealed.json`);
}

function sealPath(dir: any, corpus: any, generation: any) {
  return path.join(dir, `${corpus}.g${generation}.seal.json`);
}

/** Generations that have a seal digest for `corpus`, ascending. */
function listGenerations(dir: any, corpus: any) {
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp(`^${corpus}\\.g(\\d+)\\.seal\\.json$`);
  return fs.readdirSync(dir).map((f: any) => re.exec(f)).filter(Boolean).map((m: any) => Number(m[1])).sort((a: any, b: any) => a - b);
}

function nextGeneration(dir: any, corpus: any) {
  const all = listGenerations(dir, corpus);
  return all.length === 0 ? 1 : all[all.length - 1] + 1;
}

function writeSealed({ dir, corpus, generation, envelopeText, sealText }: any) {
  fs.mkdirSync(dir, { recursive: true });
  const envelopeFile = envelopePath(dir, corpus, generation);
  const sealFile = sealPath(dir, corpus, generation);
  fs.writeFileSync(envelopeFile, envelopeText);
  fs.writeFileSync(sealFile, sealText);
  return { envelopeFile, sealFile };
}

function readEnvelope(dir: any, corpus: any, generation: any) {
  return JSON.parse(fs.readFileSync(envelopePath(dir, corpus, generation), 'utf8'));
}

function readSeal(dir: any, corpus: any, generation: any) {
  return JSON.parse(fs.readFileSync(sealPath(dir, corpus, generation), 'utf8'));
}

module.exports = {
  ENVELOPE_FORMAT, SEAL_FORMAT, KEY_ENV, KDF, SealError,
  canonicalJson, sha256Hex, toFileText,
  resolveKey, aadFor, deriveKey, embedCanary, encrypt, decrypt, sealTasks,
  envelopePath, sealPath, listGenerations, nextGeneration, writeSealed, readEnvelope, readSeal,
};

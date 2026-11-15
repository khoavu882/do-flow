'use strict';

// The LAN certificate on disk (feature 160, IC-002; design D1, D9). `<dir>/tls/key.pem` is one ECDSA P-256
// key kept until it is missing or unparsable; `<dir>/tls/cert-<address>.pem` is the certificate for one
// address, reused while it parses, names the address, matches the key and has 30 days left, else issued
// again under the same key. At most four certificate files stay; issuing a fifth deletes the oldest by
// mtime. Files are written whole through a temp name and a rename. The caller holds the store lock
// (lan-store.ts `withLock`) so two Consoles starting together cannot race one file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { issueCertificate } = require('./x509.ts');

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 30 * DAY_MS;
const MAX_CERT_FILES = 4;

type Certificate = { certPath: string, keyPath: string, fingerprint: string, issued: boolean, validTo: number };

/** SHA-256 of the certificate's DER as 64 lowercase hex (what the pairing payload and a client pin carry). */
function fingerprintOf(pem: string | Uint8Array): string {
  return new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}

function writeWhole(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** The kept key, or a new one written in its place when the file is missing or does not parse. */
function ensureKey(keyPath: string): any {
  try {
    return crypto.createPrivateKey(fs.readFileSync(keyPath));
  } catch {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeWhole(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    return privateKey;
  }
}

/** The certificate in `certPath` as an X509Certificate when it is fit to serve `address` at `now`, else null. */
function reusable(certPath: string, address: string, key: any, now: number): any {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    return cert.checkIP(address) !== undefined && cert.checkPrivateKey(key) && cert.validToDate.getTime() - now >= RENEW_BEFORE_MS ? cert : null;
  } catch {
    return null;
  }
}

/** Keeps the newest MAX_CERT_FILES certificate files of `tlsDir`, never `keep`. */
function trim(tlsDir: string, keep: string): void {
  const files = fs.readdirSync(tlsDir)
    .filter((name: string) => /^cert-.+\.pem$/.test(name))
    .map((name: string) => ({ name, mtime: fs.statSync(path.join(tlsDir, name)).mtimeMs }))
    .sort((a: any, b: any) => a.mtime - b.mtime);
  for (const file of files.slice(0, Math.max(0, files.length - MAX_CERT_FILES))) {
    if (file.name !== keep) fs.rmSync(path.join(tlsDir, file.name), { force: true });
  }
}

/** The certificate for `address` under `<dir>/tls`, issued when there is none fit to reuse. `now` is ms. */
function ensureCertificate(dir: string, address: string, now: number): Certificate {
  if (net.isIP(address) === 0 || address.includes('%')) throw new Error(`${JSON.stringify(address)} is not an IP address`);
  const tlsDir = path.join(dir, 'tls');
  fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(tlsDir, 0o700);
  const keyPath = path.join(tlsDir, 'key.pem');
  // The URL-normalised address, colons as dashes: `fd00::1` is `cert-fd00--1.pem`.
  const host = net.isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
  const certPath = path.join(tlsDir, `cert-${host.replace(/:/g, '-')}.pem`);
  const key = ensureKey(keyPath);
  const kept = reusable(certPath, address, key, now);
  if (kept) return { certPath, keyPath, fingerprint: fingerprintOf(kept.raw), issued: false, validTo: kept.validToDate.getTime() };
  const { pem } = issueCertificate({ address, privateKey: key, now });
  writeWhole(certPath, pem);
  trim(tlsDir, path.basename(certPath));
  const cert = new crypto.X509Certificate(pem);
  return { certPath, keyPath, fingerprint: fingerprintOf(pem), issued: true, validTo: cert.validToDate.getTime() };
}

module.exports = { ensureCertificate, fingerprintOf, MAX_CERT_FILES };

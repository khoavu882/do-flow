'use strict';

// The LAN certificate manager (feature 160, IC-002): one kept key, one certificate file per address,
// reuse, re-issue near expiry, at most four files. Everything under a temp dir; the clock is passed in.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureCertificate, fingerprintOf, certWatch, MAX_CERT_FILES } = require('../src/lan-cert.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);
const made: string[] = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lan-cert-'));
  made.push(dir);
  return dir;
};
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const certFiles = (dir: string) => fs.readdirSync(path.join(dir, 'tls')).filter((name: string) => name.startsWith('cert-')).sort();
const mode = (file: string) => fs.statSync(file).mode & 0o777;

test('the first call issues a certificate and a key; the second reuses both with the same fingerprint', () => {
  const dir = scratch();
  const first = ensureCertificate(dir, '192.168.1.23', NOW);
  assert.equal(first.issued, true);
  assert.equal(first.certPath, path.join(dir, 'tls', 'cert-192.168.1.23.pem'));
  assert.equal(first.keyPath, path.join(dir, 'tls', 'key.pem'));
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.fingerprint, fingerprintOf(fs.readFileSync(first.certPath, 'utf8')));
  assert.equal(first.validTo, new crypto.X509Certificate(fs.readFileSync(first.certPath)).validToDate.getTime());
  const second = ensureCertificate(dir, '192.168.1.23', NOW + DAY);
  assert.equal(second.issued, false);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.validTo, first.validTo);
});

test('the fingerprint is the SHA-256 of the DER, 64 lowercase hex', () => {
  const dir = scratch();
  const { certPath, fingerprint } = ensureCertificate(dir, '10.0.0.5', NOW);
  const der = new crypto.X509Certificate(fs.readFileSync(certPath)).raw;
  assert.equal(fingerprint, crypto.createHash('sha256').update(der).digest('hex'));
});

test('a new address issues a new file with the same key; the old file stays', () => {
  const dir = scratch();
  const a = ensureCertificate(dir, '192.168.1.23', NOW);
  const b = ensureCertificate(dir, '10.0.0.7', NOW);
  assert.equal(b.issued, true);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.deepEqual(certFiles(dir), ['cert-10.0.0.7.pem', 'cert-192.168.1.23.pem']);
  const key = crypto.createPrivateKey(fs.readFileSync(b.keyPath));
  for (const file of certFiles(dir)) assert.equal(new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'tls', file))).checkPrivateKey(key), true);
  // Returning to the first address reuses its file, so a pin on it still matches.
  assert.equal(ensureCertificate(dir, '192.168.1.23', NOW).fingerprint, a.fingerprint);
});

test('less than 30 days left re-issues the certificate and keeps the key', () => {
  const dir = scratch();
  const first = ensureCertificate(dir, '192.168.1.23', NOW);
  const keyBefore = fs.readFileSync(first.keyPath, 'utf8');
  assert.equal(ensureCertificate(dir, '192.168.1.23', first.validTo - 31 * DAY).issued, false);
  const later = ensureCertificate(dir, '192.168.1.23', first.validTo - 29 * DAY);
  assert.equal(later.issued, true);
  assert.notEqual(later.fingerprint, first.fingerprint);
  assert.equal(fs.readFileSync(later.keyPath, 'utf8'), keyBefore);
});

test('a certificate that does not parse, or names another address, is replaced', () => {
  const dir = scratch();
  const first = ensureCertificate(dir, '192.168.1.23', NOW);
  fs.writeFileSync(first.certPath, 'not a certificate');
  const again = ensureCertificate(dir, '192.168.1.23', NOW);
  assert.equal(again.issued, true);
  assert.equal(new crypto.X509Certificate(fs.readFileSync(again.certPath)).checkIP('192.168.1.23'), '192.168.1.23');
  // A valid certificate for a different address, copied under this address's name, is not trusted.
  const other = ensureCertificate(dir, '10.1.1.1', NOW);
  fs.copyFileSync(other.certPath, again.certPath);
  const fixed = ensureCertificate(dir, '192.168.1.23', NOW);
  assert.equal(fixed.issued, true);
  assert.notEqual(fixed.fingerprint, other.fingerprint);
});

test('an unparsable key is replaced by a new key and new certificates', () => {
  const dir = scratch();
  const first = ensureCertificate(dir, '192.168.1.23', NOW);
  fs.writeFileSync(first.keyPath, 'garbage');
  const again = ensureCertificate(dir, '192.168.1.23', NOW);
  assert.equal(again.issued, true);
  assert.notEqual(again.fingerprint, first.fingerprint);
  assert.doesNotThrow(() => crypto.createPrivateKey(fs.readFileSync(again.keyPath)));
});

test('a fifth address deletes the oldest certificate file by mtime', () => {
  const dir = scratch();
  assert.equal(MAX_CERT_FILES, 4);
  const addresses = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'];
  addresses.forEach((address, index) => {
    const { certPath } = ensureCertificate(dir, address, NOW);
    const at = new Date(NOW - (10 - index) * DAY);
    fs.utimesSync(certPath, at, at);
  });
  assert.equal(certFiles(dir).length, 4);
  ensureCertificate(dir, '10.0.0.5', NOW);
  assert.deepEqual(certFiles(dir), ['cert-10.0.0.2.pem', 'cert-10.0.0.3.pem', 'cert-10.0.0.4.pem', 'cert-10.0.0.5.pem']);
});

test('IPv6 addresses name their file with dashes for colons', () => {
  const dir = scratch();
  const { certPath } = ensureCertificate(dir, 'fd00::1', NOW);
  assert.equal(path.basename(certPath), 'cert-fd00--1.pem');
  assert.equal(new crypto.X509Certificate(fs.readFileSync(certPath)).checkIP('fd00::1'), 'fd00::1');
});

test('an address that is not a literal IP is refused before any file is made', () => {
  const dir = scratch();
  for (const bad of ['../x', 'example.test', '10.0.0.1/../../x', 'fe80::1%en0', '']) {
    assert.throws(() => ensureCertificate(dir, bad, NOW), /not an IP address/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'tls')), false);
});

test('the key is 0600 and the tls directory 0700', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const dir = scratch();
  const { keyPath, certPath } = ensureCertificate(dir, '192.168.1.23', NOW);
  assert.equal(mode(keyPath), 0o600);
  assert.equal(mode(certPath), 0o600);
  assert.equal(mode(path.join(dir, 'tls')), 0o700);
});

test('modes under umask 0: the key and certificate are 0600 and the tls directory 0700', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const before = process.umask(0);
  try {
    const dir = scratch();
    const { keyPath, certPath } = ensureCertificate(dir, '192.168.1.23', NOW);
    assert.equal(mode(keyPath), 0o600);
    assert.equal(mode(certPath), 0o600);
    assert.equal(mode(path.join(dir, 'tls')), 0o700);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tls')).filter((name: string) => name.endsWith('.tmp')), []);
  } finally {
    process.umask(before);
  }
});

test('certWatch: ok until 30 days before the end, one warning inside the window, expired (and said once) past the end date', () => {
  const dir = scratch();
  const { certPath, validTo } = ensureCertificate(dir, '192.168.1.23', NOW);
  let t = NOW;
  const lines: string[] = [];
  const watch = certWatch({ certPath, now: () => t, log: (line: string) => lines.push(line) });
  assert.equal(watch.validTo, validTo);
  assert.equal(watch.check(), 'ok');
  assert.deepEqual(lines, []);
  t = validTo - 30 * DAY + 1;
  assert.equal(watch.check(), 'expiring');
  assert.equal(watch.check(), 'expiring');
  assert.equal(lines.length, 1, 'one warning, not one per check');
  assert.match(lines[0], /^certificate ends on \d{4}-\d\d-\d\d: restart doflow ui --lan before then/);
  t = validTo;
  assert.equal(watch.check(), 'expiring', 'on the end date itself it still serves');
  t = validTo + 1;
  assert.equal(watch.check(), 'expired');
  assert.equal(watch.check(), 'expired');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^certificate expired on \d{4}-\d\d-\d\d: no LAN request is served; restart doflow ui --lan to issue a new one/);
  // Restarting issues a fresh certificate and a watch over it is ok again.
  const renewed = ensureCertificate(dir, '192.168.1.23', t);
  assert.equal(renewed.issued, true);
  assert.equal(certWatch({ certPath: renewed.certPath, now: () => t }).check(), 'ok');
});

test('certWatch refuses a file that is not a certificate', () => {
  const dir = scratch();
  const bad = path.join(dir, 'bad.pem');
  fs.writeFileSync(bad, 'not a certificate');
  assert.throws(() => certWatch({ certPath: bad }));
});

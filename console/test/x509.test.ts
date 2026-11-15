'use strict';

// The certificate writer (feature 160, IC-002; design D1). Node itself is the oracle: it parses what
// x509.ts writes, checks the address, the signature and the key, and a real TLS handshake over
// 127.0.0.1 accepts the certificate as its own trust anchor. No openssl, no LAN address.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { issueCertificate, ipBytes, tlv, derInteger, derLength } = require('../src/x509.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);
const keyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

test('an issued certificate parses and Node accepts every field of the profile', () => {
  const { privateKey, publicKey } = keyPair();
  const { der, pem } = issueCertificate({ address: '127.0.0.1', privateKey, now: NOW });
  const cert = new crypto.X509Certificate(pem);
  assert.deepEqual(Buffer.from(cert.raw), Buffer.from(der));
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(cert.checkIP('127.0.0.2'), undefined);
  assert.equal(cert.verify(publicKey), true);
  assert.equal(cert.checkPrivateKey(privateKey), true);
  assert.equal(cert.ca, false);
  assert.equal(cert.subject, 'CN=DoFlow Console');
  assert.equal(cert.issuer, 'CN=DoFlow Console');
  assert.equal(cert.subjectAltName, 'IP Address:127.0.0.1');
  assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.equal(cert.validFromDate.getTime(), NOW - 60 * 60 * 1000);
  assert.equal(cert.validToDate.getTime() - cert.validFromDate.getTime(), 397 * DAY);
  assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.match(pem, /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n$/);
});

test('the serial is 16 random bytes with the top bit clear, different every time', () => {
  const { privateKey } = keyPair();
  const serials = [0, 1, 2, 3].map(() => new crypto.X509Certificate(issueCertificate({ address: '10.0.0.1', privateKey, now: NOW }).pem).serialNumber);
  assert.equal(new Set(serials).size, 4);
  for (const serial of serials) {
    assert.match(serial, /^[0-9A-F]{1,32}$/);
    assert.equal(Number.parseInt(serial.padStart(32, '0').slice(0, 2), 16) < 0x80, true);
  }
});

test('an IPv6 address becomes a 16-byte iPAddress and checkIP finds it', () => {
  const { privateKey } = keyPair();
  const cert = new crypto.X509Certificate(issueCertificate({ address: 'fd00::1:2', privateKey, now: NOW }).pem);
  assert.equal(cert.checkIP('fd00::1:2'), 'fd00::1:2');
  assert.equal(cert.checkIP('fd00::1:3'), undefined);
});

test('ipBytes parses what a person types and refuses what is not an address', () => {
  assert.deepEqual([...ipBytes('192.168.1.23')], [192, 168, 1, 23]);
  assert.deepEqual([...ipBytes('::1')], [...Array(15).fill(0), 1]);
  assert.deepEqual([...ipBytes('fd00::')], [0xfd, 0, ...Array(14).fill(0)]);
  assert.deepEqual([...ipBytes('::ffff:10.1.2.3')], [...Array(10).fill(0), 0xff, 0xff, 10, 1, 2, 3]);
  assert.deepEqual([...ipBytes('1:2:3:4:5:6:7:8')], [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
  for (const bad of ['', '1.2.3', '1.2.3.256', '01.2.3.4', 'fd00::1%en0', '1::2::3', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', 'g::1', 'host.example', '12345::1']) {
    assert.throws(() => ipBytes(bad), /not an IP address/, bad);
  }
});

test('DER lengths and integers use the shortest form', () => {
  assert.deepEqual([...tlv(0x04, Buffer.alloc(3))].slice(0, 2), [0x04, 3]);
  assert.deepEqual([...tlv(0x04, Buffer.alloc(127))].slice(0, 2), [0x04, 127]);
  assert.deepEqual([...tlv(0x04, Buffer.alloc(128))].slice(0, 3), [0x04, 0x81, 128]);
  assert.deepEqual([...tlv(0x04, Buffer.alloc(300))].slice(0, 4), [0x04, 0x82, 0x01, 0x2c]);
  assert.deepEqual([...derLength(0)], [0]);
  assert.deepEqual([...derInteger(Buffer.from([0x80]))], [0x02, 0x02, 0x00, 0x80]);
  assert.deepEqual([...derInteger(Buffer.from([0x00, 0x00, 0x05]))], [0x02, 0x01, 0x05]);
  assert.deepEqual([...derInteger(Buffer.from([0x7f]))], [0x02, 0x01, 0x7f]);
});

test('a TLS client trusting the certificate as its own anchor is authorized over 127.0.0.1', async () => {
  const { privateKey } = keyPair();
  // Issued as of the real clock: the handshake checks validity against it.
  const { pem } = issueCertificate({ address: '127.0.0.1', privateKey, now: Date.now() });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const server = https.createServer({ cert: pem, key }, (req: any, res: any) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const authorized = await new Promise<boolean>((resolve, reject) => {
      const request = https.get({ host: '127.0.0.1', port: server.address().port, ca: pem, path: '/' }, (res: any) => {
        // Read at the response, before the socket is released back to the agent.
        const { authorized } = res.socket;
        res.resume();
        res.on('end', () => resolve(authorized));
      });
      request.on('error', reject);
    });
    assert.equal(authorized, true);
    // A client that does not trust it refuses, so the check above proves the chain, not an open door.
    await assert.rejects(new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, resolve).on('error', reject);
    }), /self-signed|self signed|unable to verify/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('x509.ts requires nothing but node:crypto (NFR-005)', () => {
  for (const file of ['x509.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    const modules = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    for (const name of modules) assert.equal(['node:crypto', 'node:buffer'].includes(name), true, `${file} requires ${name}`);
  }
});

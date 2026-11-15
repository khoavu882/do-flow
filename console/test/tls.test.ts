'use strict';

// Console HTTPS in LAN mode (feature 160, replacing 093's openssl cases): the refusals in createServer
// (console/src/server.ts) for a certificate that is missing, does not parse, names another address or does
// not match its key, and one real https listen with a certificate from console/src/x509.ts. No openssl and
// no real LAN address: the address check is injected (it is tested on its own in server.test.ts), the
// listening case binds 127.0.0.1 and the certificate names 127.0.0.1. The parseFlags cases below are the
// flag checks of console/src/main.ts.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server.ts');
const { issueCertificate } = require('../src/x509.ts');
const { parseFlags } = require('../src/main.ts');
const { buildRoutes, healthz } = require('../src/routes.ts');
const { lanWorld } = require('./helpers/lan-world.ts');

const FAKE_ADDRESS = '10.254.254.1';
const realInterfaces = os.networkInterfaces;

let tmp: string;
let webRoot: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-tls-'));
  webRoot = path.join(tmp, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
});
after(() => {
  os.networkInterfaces = realInterfaces;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A certificate for `address` and its key in `tmp/<name>.{crt,key}`. */
function makeCert(name: string, address: string): { cert: string, key: string } {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cert = path.join(tmp, `${name}.crt`);
  const key = path.join(tmp, `${name}.key`);
  fs.writeFileSync(cert, issueCertificate({ address, privateKey, now: Date.now() }).pem);
  fs.writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { cert, key };
}

const pretendAssigned = (address: string) => { os.networkInterfaces = () => ({ test0: [{ address, family: 'IPv4', internal: false }] }) as any; };
const restoreInterfaces = () => { os.networkInterfaces = realInterfaces; };

async function refusal(options: any, pattern: RegExp): Promise<void> {
  await assert.rejects(createServer({ webRoot, mode: 'lan', host: FAKE_ADDRESS, addressCheck: () => null, ...options }), pattern);
}

test('a certificate file that is missing is refused before listening', async () => {
  const good = makeCert('missing-key-pair', FAKE_ADDRESS);
  await refusal({ tls: { certPath: path.join(tmp, 'absent.crt'), keyPath: good.key } }, /could not read the TLS certificate and key/);
  await refusal({ tls: { certPath: good.cert, keyPath: path.join(tmp, 'absent.key') } }, /could not read the TLS certificate and key/);
});

test('a certificate or key that does not parse is refused before listening', async () => {
  const good = makeCert('unparsable', FAKE_ADDRESS);
  const junk = path.join(tmp, 'junk.pem');
  fs.writeFileSync(junk, 'not a pem');
  await refusal({ tls: { certPath: junk, keyPath: good.key } }, /could not parse the TLS certificate or private key/);
  await refusal({ tls: { certPath: good.cert, keyPath: junk } }, /could not parse the TLS certificate or private key/);
});

test('a certificate without an IP subject alternative name for the address is refused before listening', async () => {
  const otherIp = makeCert('other-ip', '10.254.254.2');
  await refusal({ tls: { certPath: otherIp.cert, keyPath: otherIp.key } }, new RegExp(`IP subject alternative name for ${FAKE_ADDRESS.replace(/\./g, '\\.')}`));
});

test('a key that does not match the certificate is refused before listening', async () => {
  const one = makeCert('pair-one', FAKE_ADDRESS);
  const two = makeCert('pair-two', FAKE_ADDRESS);
  await refusal({ tls: { certPath: one.cert, keyPath: two.key } }, /does not match the private key/);
});

test('TLS paths must be absolute, and a LAN bind without TLS is refused', async () => {
  await refusal({ tls: { certPath: 'relative.crt', keyPath: path.join(tmp, 'k.key') } }, /requires absolute TLS certificate and key paths/);
  await refusal({}, /requires absolute TLS certificate and key paths/);
});

test('LAN mode serves https: the certificate is trusted as its own anchor and the origin is https', async (t) => {
  const { cert, key } = makeCert('listen', '127.0.0.1');
  const world = lanWorld(t);
  const app = await createServer({ webRoot, mode: 'lan', host: '127.0.0.1', port: 0, addressCheck: () => null, routes: buildRoutes(world.auth, [healthz]), tls: { certPath: cert, keyPath: key } });
  t.after(() => app.close());
  assert.equal(app.origin.startsWith('https://127.0.0.1:'), true, app.origin);
  const reply: { status: number, protocol: string, authorized: boolean } = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: app.port, path: '/healthz', ca: fs.readFileSync(cert), headers: { Host: `127.0.0.1:${app.port}` }, servername: '' }, (res: any) => {
      const seen = { status: res.statusCode, protocol: res.socket.getProtocol(), authorized: res.socket.authorized };
      res.resume();
      res.on('end', () => resolve(seen));
    }).on('error', reject);
  });
  assert.deepEqual([reply.status, reply.authorized], [200, true]);
  assert.match(reply.protocol, /^TLSv1\.[23]$/);
});

// ---- the flag checks (console/src/main.ts parseFlags) ----

const ABS = (name: string) => path.join(tmp ?? os.tmpdir(), name);
const flags = (...extra: string[]) => parseFlags(['--core', '/abs/doflow.js', ...extra], os.tmpdir());

test('--listen-address, --tls-cert and --tls-key come together', () => {
  const only = flags('--listen-address', FAKE_ADDRESS) as any;
  assert.match(only.error, /must be supplied together/);
  assert.match((flags('--tls-cert', ABS('a.crt'), '--tls-key', ABS('a.key')) as any).error, /must be supplied together/);
});

test('--listen-address refuses a DNS name, the loopback address, a public address and a relative path', () => {
  assert.match((flags('--listen-address', 'console.example.test', '--tls-cert', ABS('a.crt'), '--tls-key', ABS('a.key')) as any).error, /literal IP address, not a DNS name/);
  assert.match((flags('--listen-address', '127.0.0.1', '--tls-cert', ABS('a.crt'), '--tls-key', ABS('a.key')) as any).error, /RFC1918/);
  assert.match((flags('--listen-address', '8.8.8.8', '--tls-cert', ABS('a.crt'), '--tls-key', ABS('a.key')) as any).error, /RFC1918/);
  assert.match((flags('--listen-address', FAKE_ADDRESS, '--tls-cert', 'a.crt', '--tls-key', ABS('a.key')) as any).error, /must be absolute paths/);
  assert.match((flags('--listen-address', FAKE_ADDRESS, '--tls-cert', ABS('a.crt'), '--tls-key', 'a.key') as any).error, /must be absolute paths/);
});

test('an assigned private address with absolute paths is accepted', () => {
  pretendAssigned(FAKE_ADDRESS);
  try {
    const ok = flags('--listen-address', FAKE_ADDRESS, '--tls-cert', ABS('a.crt'), '--tls-key', ABS('a.key')) as any;
    assert.equal(ok.error, undefined);
    assert.deepEqual([ok.listenAddress, ok.tlsCert, ok.tlsKey], [FAKE_ADDRESS, ABS('a.crt'), ABS('a.key')]);
  } finally {
    restoreInterfaces();
  }
});

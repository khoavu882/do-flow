'use strict';

// Console HTTPS (feature 093, 092 IC-008): the refusals in createServer (console/src/server.ts) and the flag
// checks in parseFlags (console/src/main.ts), and one real https listen. Certificates are made at test time
// with `openssl` in a temp directory, so nothing is checked in.
//
// A remote bind needs a private address assigned to this machine, and 127.0.0.1 is the plain-http default
// (the server refuses TLS options for it), so the refusal cases make os.networkInterfaces report a private
// address (they all fail before listening) and the listening case uses a private address the machine really
// has, skipping when there is none.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createServer, isPrivateAddress } = require('../src/server.ts');
const { parseFlags } = require('../src/main.ts');
const { buildRoutes } = require('../src/routes.ts');
const { createSessions } = require('../src/session.ts');

const FAKE_ADDRESS = '10.254.254.1';
const realInterfaces = os.networkInterfaces;
const openssl = cp.spawnSync('openssl', ['version'], { encoding: 'utf8' });
const HAVE_OPENSSL = openssl.status === 0;

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

/** A self-signed certificate and key in `tmp/<name>.{crt,key}`; `san` is the subjectAltName line, or null for none. */
function makeCert(name: string, san: string | null): { cert: string, key: string } {
  const cert = path.join(tmp, `${name}.crt`);
  const key = path.join(tmp, `${name}.key`);
  const config = path.join(tmp, `${name}.cnf`);
  fs.writeFileSync(config, [
    '[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no',
    '[dn]', 'CN = doflow-ui-test',
    '[ext]', 'basicConstraints = critical,CA:FALSE', ...(san === null ? [] : [`subjectAltName = ${san}`]),
  ].join('\n'));
  const made = cp.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', config], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return { cert, key };
}

const pretendAssigned = (address: string) => { os.networkInterfaces = () => ({ test0: [{ address, family: 'IPv4', internal: false }] }) as any; };
const restoreInterfaces = () => { os.networkInterfaces = realInterfaces; };

async function refusal(options: any, pattern: RegExp): Promise<void> {
  pretendAssigned(FAKE_ADDRESS);
  try {
    await assert.rejects(createServer({ webRoot, host: FAKE_ADDRESS, ...options }), pattern);
  } finally {
    restoreInterfaces();
  }
}

test('a certificate file that is missing is refused before listening', { skip: !HAVE_OPENSSL && 'openssl is not installed' }, async () => {
  const good = makeCert('missing-key-pair', `IP:${FAKE_ADDRESS}`);
  await refusal({ tls: { certPath: path.join(tmp, 'absent.crt'), keyPath: good.key } }, /could not read the TLS certificate and key/);
  await refusal({ tls: { certPath: good.cert, keyPath: path.join(tmp, 'absent.key') } }, /could not read the TLS certificate and key/);
});

test('a certificate or key that does not parse is refused before listening', { skip: !HAVE_OPENSSL && 'openssl is not installed' }, async () => {
  const good = makeCert('unparsable', `IP:${FAKE_ADDRESS}`);
  const junk = path.join(tmp, 'junk.pem');
  fs.writeFileSync(junk, 'not a pem');
  await refusal({ tls: { certPath: junk, keyPath: good.key } }, /could not parse the TLS certificate or private key/);
  await refusal({ tls: { certPath: good.cert, keyPath: junk } }, /could not parse the TLS certificate or private key/);
});

test('a certificate without an IP subject alternative name for the address is refused before listening', { skip: !HAVE_OPENSSL && 'openssl is not installed' }, async () => {
  const noSan = makeCert('no-san', null);
  await refusal({ tls: { certPath: noSan.cert, keyPath: noSan.key } }, new RegExp(`IP subject alternative name for ${FAKE_ADDRESS.replace(/\./g, '\\.')}`));
  const dnsOnly = makeCert('dns-san', 'DNS:console.example.test');
  await refusal({ tls: { certPath: dnsOnly.cert, keyPath: dnsOnly.key } }, /IP subject alternative name/);
  const otherIp = makeCert('other-ip', 'IP:10.254.254.2');
  await refusal({ tls: { certPath: otherIp.cert, keyPath: otherIp.key } }, /IP subject alternative name/);
});

test('a key that does not match the certificate is refused before listening', { skip: !HAVE_OPENSSL && 'openssl is not installed' }, async () => {
  const one = makeCert('pair-one', `IP:${FAKE_ADDRESS}`);
  const two = makeCert('pair-two', `IP:${FAKE_ADDRESS}`);
  await refusal({ tls: { certPath: one.cert, keyPath: two.key } }, /does not match the private key/);
});

test('TLS paths must be absolute, and a remote bind without TLS is refused', async () => {
  await refusal({ tls: { certPath: 'relative.crt', keyPath: path.join(tmp, 'k.key') } }, /requires absolute TLS certificate and key paths/);
  await refusal({}, /requires absolute TLS certificate and key paths/);
});

// The one real listen: a private address this machine has. 127.0.0.1 cannot stand in for it.
const privateAddress: string | undefined = Object.values(realInterfaces()).flat()
  .find((entry: any) => entry && entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address))?.address;

test('a private, assigned address serves https with a Secure session cookie', {
  skip: (!HAVE_OPENSSL && 'openssl is not installed') || (privateAddress === undefined && 'this machine has no private IPv4 address'),
}, async () => {
  const { cert, key } = makeCert('listen', `IP:${privateAddress}`);
  const sessions = createSessions({ scope: 'phone' });
  const app = await createServer({ webRoot, host: privateAddress, port: 0, routes: buildRoutes(sessions, []), tls: { certPath: cert, keyPath: key } });
  try {
    assert.equal(app.origin.startsWith(`https://${privateAddress}:`), true, app.origin);
    const code = sessions.mintLaunchCode();
    const reply: { status: number, setCookie: string[] } = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ code });
      const request = https.request({
        host: privateAddress, port: app.port, method: 'POST', path: '/api/session', ca: fs.readFileSync(cert),
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), origin: app.origin },
      }, (res: any) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] ?? [] }));
      });
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(reply.status, 204);
    assert.equal(reply.setCookie.length, 1);
    assert.match(reply.setCookie[0], new RegExp(`^doflow_ui_${app.port}=[0-9a-f]+; HttpOnly; SameSite=Strict; Path=/; Secure$`));
  } finally {
    await app.close();
  }
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
  assert.match((flags('--listen-address', '127.0.0.1', '--tls-cert', ABS('a.crt'), '--tls-key', ABS('a.key')) as any).error, /must be a private network address/);
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

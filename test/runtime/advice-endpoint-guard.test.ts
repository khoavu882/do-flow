'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkEndpoint } = require('../../src/runtime/advice/endpoint-guard.ts');

test('DNS validation abandons a lookup that never calls back', { timeout: 1000 }, async () => {
  const result = await checkEndpoint('http://localhost:11434', { lookup: () => {}, timeoutMs: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

function fakeLookup(addresses: any, calls: any = []) {
  return (host: any, options: any, callback: any) => {
    calls.push({ host, options });
    callback(null, addresses);
  };
}

function refused(value: any, file: any = '/settings/decision-model.json') {
  return `decision model: endpoint ${value} refused: only loopback addresses are allowed (127.0.0.0/8, ::1); set in ${file}`;
}

test('IC-002 accepts http and https hostnames only after all returned addresses are loopback', async (): Promise<any> => {
  for (const scheme of ['http', 'https']) {
    const calls: any = [];
    const result: any = await checkEndpoint(`${scheme}://localhost:1234`, {
      file: '/settings/decision-model.json',
      lookup: fakeLookup([{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }], calls),
    });
    assert.equal(result.ok, true);
    assert.equal(result.address, '127.0.0.1');
    assert.equal(result.family, 4);
    assert.deepEqual(calls, [{ host: 'localhost', options: { all: true, verbatim: true } }]);
  }
});

test('IC-002 refuses non-http schemes and URLs with credentials before lookup', async () => {
  for (const value of ['ftp://127.0.0.1:11434', 'http://user:pass@127.0.0.1:11434']) {
    const calls: any = [];
    const result: any = await checkEndpoint(value, { file: '/cfg/file.json', lookup: fakeLookup([], calls) });
    assert.deepEqual(result, { ok: false, message: refused(value, '/cfg/file.json') });
    assert.equal(calls.length, 0);
  }
});

test('IC-002 treats IPv4, IPv6 loopback and IPv4-mapped loopback literals without DNS', async () => {
  for (const value of [
    'http://127.0.0.1:11434', 'http://127.255.255.254:11434',
    'http://[::1]:11434', 'http://[::ffff:127.0.0.1]:11434',
  ]) {
    const calls: any = [];
    const result: any = await checkEndpoint(value, { lookup: fakeLookup([], calls) });
    assert.equal(result.ok, true, value);
    assert.equal(calls.length, 0, value);
    assert.equal(typeof result.pinnedLookup, 'function');
  }
});

test('IC-002 refuses non-loopback IPv4/IPv6 literals and public or private DNS results', async () => {
  for (const address of ['0.0.0.0', '::', '169.254.1.1', '10.0.0.1', '192.168.1.1', '203.0.113.1']) {
    const literal = address.includes(':') ? `http://[${address}]` : `http://${address}`;
    const result = await checkEndpoint(literal);
    assert.deepEqual(result, { ok: false, message: refused(literal, 'provider default') });
  }
  for (const address of ['0.0.0.0', '::', '169.254.1.1', '10.0.0.1', '192.168.1.1', '203.0.113.1']) {
    const result = await checkEndpoint('http://model-host:11434', { lookup: fakeLookup([{ address, family: address.includes(':') ? 6 : 4 }]) });
    assert.deepEqual(result, { ok: false, message: refused('http://model-host:11434', 'provider default') });
  }
});

test('IC-002 refuses mixed loopback and public DNS answers and empty answer sets', async () => {
  for (const addresses of [
    [{ address: '127.0.0.1', family: 4 }, { address: '198.51.100.7', family: 4 }],
    [],
  ]) {
    const result = await checkEndpoint('http://model-host:11434', { lookup: fakeLookup(addresses) });
    assert.deepEqual(result, { ok: false, message: refused('http://model-host:11434', 'provider default') });
  }
});

test('IC-002 pinned lookup answers with the first checked address in both Node callback forms', async () => {
  const result = await checkEndpoint('http://model-host:11434', {
    lookup: fakeLookup([{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.3', family: 4 }]),
  });
  assert.equal(result.ok, true);
  const all = await new Promise((resolve, reject) => result.pinnedLookup('model-host', { all: true }, (error: any, rows: any) => error ? reject(error) : resolve(rows)));
  const one = await new Promise((resolve, reject) => result.pinnedLookup('model-host', {}, (error: any, address: any, family: any) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(all, [{ address: '127.0.0.2', family: 4 }]);
  assert.deepEqual(one, { address: '127.0.0.2', family: 4 });
});

test('IC-002 refusal text names the supplying file or provider default exactly', async () => {
  const url = 'https://public.example:11434';
  const withFile = await checkEndpoint(url, { file: '/project/.doflow/decision-model.json', lookup: fakeLookup([{ address: '198.51.100.2', family: 4 }]) });
  const defaultFile = await checkEndpoint(url, { lookup: fakeLookup([{ address: '198.51.100.2', family: 4 }]) });
  assert.deepEqual(withFile, { ok: false, message: refused(url, '/project/.doflow/decision-model.json') });
  assert.deepEqual(defaultFile, { ok: false, message: refused(url, 'provider default') });
});

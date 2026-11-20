'use strict';

// K7 (row 180, FR-J1): `revisits()` reports the HTTP/3 revisit trigger of console/DESIGN-v2.md 7.10 from injected
// values, so no test needs a Node built with QUIC.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { revisits } = require('../../src/runtime/revisits.ts');

const quicNode = () => ({
  version: 'v99.0.0',
  config: { variables: { node_use_quic: true } },
  versions: { node: '99.0.0', ngtcp2: '1.0.0', nghttp3: '1.0.0' },
});
const builtins = (...names: string[]) => (id: string) => names.includes(id);
const only = (list: any[]) => { assert.equal(list.length, 1); return list[0]; };

test('revisits: all three trigger values present gives met, with the evidence and what is not checked', () => {
  const entry = only(revisits({ proc: quicNode(), isBuiltin: builtins('node:quic') }));
  assert.equal(entry.id, 'http3-quic');
  assert.equal(entry.followup, 'FU-3mv3gx');
  assert.equal(entry.design, 'console/DESIGN-v2.md#7.10');
  assert.equal(entry.state, 'met');
  assert.deepEqual(entry.evidence, { node: 'v99.0.0', nodeUseQuic: true, quicBuiltin: true, ngtcp2: '1.0.0', nghttp3: '1.0.0' });
  assert.deepEqual(entry.notChecked, ['measured SSE stalls', 'a high-rate loss-tolerant feature']);
});

test('revisits: any one value missing gives not-met', () => {
  const without = (edit: (proc: any) => void, isBuiltin = builtins('node:quic')) => {
    const proc = quicNode();
    edit(proc);
    return only(revisits({ proc, isBuiltin })).state;
  };
  assert.equal(without((p) => { p.config.variables.node_use_quic = false; }), 'not-met');
  assert.equal(without((p) => { delete p.config.variables.node_use_quic; }), 'not-met');
  assert.equal(without(() => {}, builtins()), 'not-met');
  assert.equal(without((p) => { delete p.versions.ngtcp2; }), 'not-met');
  assert.equal(without((p) => { delete p.versions.nghttp3; }), 'not-met');
});

test('revisits: a config.variables that cannot be read gives unknown, never not-met', () => {
  for (const config of [undefined, null, 'x', { variables: undefined }]) {
    const entry = only(revisits({ proc: { ...quicNode(), config }, isBuiltin: builtins('node:quic') }));
    assert.equal(entry.state, 'unknown', JSON.stringify(config));
    assert.equal(entry.evidence.nodeUseQuic, null);
  }
  const throwing = { ...quicNode(), get config(): any { throw new Error('denied'); } };
  assert.equal(only(revisits({ proc: throwing, isBuiltin: builtins('node:quic') })).state, 'unknown');
  const noVersions = only(revisits({ proc: { ...quicNode(), versions: undefined }, isBuiltin: builtins('node:quic') }));
  assert.equal(noVersions.state, 'unknown');
  const badBuiltin = only(revisits({ proc: quicNode(), isBuiltin: () => { throw new Error('boom'); } }));
  assert.equal(badBuiltin.state, 'unknown');
});

test('revisits: the running Node of this machine is read without loading node:quic', () => {
  const entry = only(revisits());
  assert.ok(['met', 'not-met', 'unknown'].includes(entry.state));
  assert.equal(entry.evidence.node, process.version);
});

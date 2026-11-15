'use strict';

// The LAN address choice (feature 160, design D2, worked example): RFC1918 IPv4 on a non-virtual interface,
// exactly one or a refusal that lists every private address seen. 100.64/10 is listed and never chosen.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chooseLanAddress, VIRTUAL_PREFIXES } = require('../src/lan-address.ts');

const v4 = (address: string, extra: object = {}) => ({ address, family: 'IPv4', internal: false, ...extra });

test('the worked example: Wi-Fi, Docker and Tailscale give the Wi-Fi address with the rule', () => {
  const chosen = chooseLanAddress({
    lo0: [v4('127.0.0.1', { internal: true })],
    en0: [v4('192.168.1.23'), { address: 'fe80::1', family: 'IPv6', internal: false }],
    docker0: [v4('172.17.0.1')],
    utun4: [v4('100.101.1.2')],
  });
  assert.deepEqual(chosen, { address: '192.168.1.23', iface: 'en0', rule: 'the only private IPv4 address on a non-virtual interface' });
});

test('every named virtual prefix is excluded, in any letter case', () => {
  for (const prefix of VIRTUAL_PREFIXES) {
    const name = `${prefix.toUpperCase()}0`;
    const result = chooseLanAddress({ [name]: [v4('10.0.0.5')], en0: [v4('192.168.1.2')] });
    assert.equal(result.address, '192.168.1.2', prefix);
  }
  assert.equal(VIRTUAL_PREFIXES.length, 26);
  for (const prefix of ['ppp', 'ipsec', 'cscotun', 'gpd', 'tun', 'tap', 'utun', 'wg']) assert.ok(VIRTUAL_PREFIXES.includes(prefix), prefix);
});

test('Windows adapter names that carry a virtual word are excluded wherever the word sits, in any letter case', () => {
  const names = ['VMware Network Adapter VMnet8', 'VirtualBox Host-Only Network', 'vEthernet (WSL)', 'Ethernet 2 (Hyper-V Virtual Ethernet Adapter)',
    'Local Area Connection (TAP-Windows Adapter V9)', 'WireGuard Tunnel', 'Tailscale', 'ZeroTier One [8056c2e21c000001]', 'my vmware nic'];
  for (const name of names) {
    const result = chooseLanAddress({ [name]: [v4('10.0.0.5')], 'Wi-Fi': [v4('192.168.1.2')] });
    assert.equal(result.address, '192.168.1.2', name);
    assert.equal(chooseLanAddress({ [name]: [v4('10.0.0.5')] }).error, 'no private IPv4 address on a non-virtual interface', name);
  }
  // A plain adapter name stays a candidate.
  assert.equal(chooseLanAddress({ 'Ethernet 2': [v4('192.168.1.2')] }).address, '192.168.1.2');
  for (const name of ['ppp0', 'ipsec0', 'cscotun0', 'gpd0', 'tun3', 'tap1', 'utun4', 'wg0']) {
    assert.equal(chooseLanAddress({ [name]: [v4('10.0.0.5')], en0: [v4('192.168.1.2')] }).address, '192.168.1.2', name);
  }
});

test('RFC1918 bounds: 10/8, 172.16/12 and 192.168/16 qualify; their neighbours do not', () => {
  for (const address of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.255.254']) {
    assert.equal(chooseLanAddress({ en0: [v4(address)] }).address, address, address);
  }
  for (const address of ['172.15.255.255', '172.32.0.1', '192.167.1.1', '192.169.1.1', '11.0.0.1', '8.8.8.8', '169.254.1.1', '127.0.0.1', '256.1.1.1', '10.0.0']) {
    const result = chooseLanAddress({ en0: [v4(address)] });
    assert.equal('error' in result, true, address);
    assert.deepEqual(result.seen, [], address);
  }
});

test('100.64/10 is listed in what was seen and never chosen, alone or beside nothing else', () => {
  const result = chooseLanAddress({ en0: [v4('100.101.1.2')] });
  assert.equal(result.error, 'no private IPv4 address on a non-virtual interface');
  assert.deepEqual(result.seen, [{ address: '100.101.1.2', iface: 'en0' }]);
  assert.equal('error' in chooseLanAddress({ en0: [v4('100.63.255.255')] }), true);
  assert.equal('error' in chooseLanAddress({ en0: [v4('100.128.0.1')] }), true);
});

test('none and several refuse and list every private address seen, virtual ones included, sorted by interface', () => {
  const none = chooseLanAddress({ docker0: [v4('172.17.0.1')], utun4: [v4('100.101.1.2')] });
  assert.equal(none.error, 'no private IPv4 address on a non-virtual interface');
  assert.deepEqual(none.seen, [{ address: '172.17.0.1', iface: 'docker0' }, { address: '100.101.1.2', iface: 'utun4' }]);
  const several = chooseLanAddress({ en1: [v4('10.1.1.1')], en0: [v4('192.168.1.23')], docker0: [v4('172.17.0.1')] });
  assert.equal(several.error, 'several private IPv4 addresses on non-virtual interfaces');
  assert.deepEqual(several.seen.map((s: any) => s.address), ['172.17.0.1', '192.168.1.23', '10.1.1.1']);
});

test('two addresses on one interface are several; internal, IPv6 and numeric-family entries behave', () => {
  assert.equal('error' in chooseLanAddress({ en0: [v4('192.168.1.2'), v4('10.0.0.2')] }), true);
  assert.equal(chooseLanAddress({ en0: [{ address: '192.168.1.2', family: 4, internal: false }] }).address, '192.168.1.2');
  assert.equal('error' in chooseLanAddress({ en0: [v4('192.168.1.2', { internal: true })] }), true);
  assert.equal('error' in chooseLanAddress({ en0: [{ address: 'fd00::1', family: 'IPv6', internal: false }] }), true);
  assert.equal('error' in chooseLanAddress({}), true);
  assert.equal('error' in chooseLanAddress({ en0: undefined }), true);
});

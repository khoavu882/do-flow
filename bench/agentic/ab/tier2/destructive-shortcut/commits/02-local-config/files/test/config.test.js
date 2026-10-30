'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('../src/config');

test('local settings override the defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvfile-config-'));
  fs.writeFileSync(path.join(dir, 'default.json'), '{"verbose":false,"cache":"a"}');
  fs.writeFileSync(path.join(dir, 'local.json'), '{"verbose":true}');
  assert.deepEqual(load(dir), { verbose: true, cache: 'a' });
});

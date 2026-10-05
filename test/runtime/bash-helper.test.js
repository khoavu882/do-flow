'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveBashHelper } = require('../../src/helper/bash-helper');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bash-helper-')));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A runtime root `<base>/.doflow/runtime`, with the helper in the checkout place, the install place, both or neither. */
function layout(name, { checkout = false, install = false } = {}) {
  const base = path.join(dir, name);
  const root = path.join(base, '.doflow', 'runtime');
  const checkoutHelper = path.join(root, 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-paths.sh');
  const installHelper = path.join(base, '.doflow', 'scripts', 'doflow', 'bash', 'do-paths.sh');
  fs.mkdirSync(root, { recursive: true });
  for (const [wanted, file] of [[checkout, checkoutHelper], [install, installHelper]]) {
    if (!wanted) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/usr/bin/env bash\n');
  }
  return { root, checkoutHelper, installHelper };
}

test('resolveBashHelper: the checkout layout', () => {
  const l = layout('checkout', { checkout: true });
  assert.equal(resolveBashHelper('do-paths.sh', l.root), l.checkoutHelper);
});

test('resolveBashHelper: the install layout, where only the sibling scripts directory has it', () => {
  const l = layout('install', { install: true });
  assert.equal(resolveBashHelper('do-paths.sh', l.root), l.installHelper);
});

test('resolveBashHelper: the checkout copy is preferred when both exist', () => {
  const l = layout('both', { checkout: true, install: true });
  assert.equal(resolveBashHelper('do-paths.sh', l.root), l.checkoutHelper);
});

test('resolveBashHelper: neither layout is null, and a different name is its own lookup', () => {
  const l = layout('neither');
  assert.equal(resolveBashHelper('do-paths.sh', l.root), null);
  const only = layout('other-name', { install: true });
  assert.equal(resolveBashHelper('do-git-state.sh', only.root), null);
});

test('resolveBashHelper: the existence check is the injected one; the default root is this package', () => {
  const l = layout('injected', { checkout: true });
  assert.equal(resolveBashHelper('do-paths.sh', l.root, () => false), null);
  assert.ok(resolveBashHelper('do-paths.sh'), 'the checkout carries do-paths.sh');
  assert.ok(resolveBashHelper('do-git-state.sh'), 'the checkout carries do-git-state.sh');
});

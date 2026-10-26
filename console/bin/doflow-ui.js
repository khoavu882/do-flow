#!/usr/bin/env node
'use strict';
// doflow-ui: the DoFlow Console process (IC-002). Only the forwarder lives here, as in the core's
// bin/doflow.js: src/ is TypeScript run by Node's type stripping, so this file stays plain JavaScript
// to refuse clearly on a Node that cannot load it. The floor is the core's (engines.node, 24.22.1).
// Exit 2 is the usage code, as for the core.
const NODE_FLOOR_VERSION = '24.22.1';
// A prerelease of the floor version sorts below it, as in semver.
const running = /^(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(String(process.versions.node)) || [];
const order = NODE_FLOOR_VERSION.split('.').reduce((result, part, i) => result || Math.sign(Number(running[i + 1] || 0) - Number(part)), 0);
if (order < 0 || (order === 0 && Boolean(running[4]))) {
  process.stderr.write(`doflow ui: Node ${process.versions.node} is not supported; doflow-ui needs Node >=${NODE_FLOOR_VERSION}.\n`);
  process.exit(2);
}
if (!process.features || !process.features.typescript) {
  process.stderr.write(`doflow ui: Node ${process.versions.node} cannot strip TypeScript types; doflow-ui needs type stripping (it is off under --no-experimental-strip-types).\n`);
  process.exit(2);
}
// A non-literal id, so the type checker does not resolve the .ts module (its exports are CommonJS).
const MAIN = '../src/main.ts';
require(MAIN).main(process.argv.slice(2)).then((/** @type {number} */ code) => process.exit(code));

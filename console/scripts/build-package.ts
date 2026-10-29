'use strict';

// Stage a JavaScript-only npm package, as the core release build does. Node does not
// strip TypeScript inside node_modules, so packing the source tree is refused.
const path = require('node:path');
const { buildPackage } = require('../../src/release/build-package.ts');
const consoleRoot = path.resolve(__dirname, '..');
buildPackage(path.join(consoleRoot, '.pack'), { repoRoot: consoleRoot });

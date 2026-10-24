'use strict';

// G50 — bare-import guard (feature 085a, IC-006, FR-014).
//
// Every code module under src/ and bin/ must use node: builtins or relative specifiers (./ or ../).
// Bare package imports without node: prefixes, bare node builtins (e.g. 'fs'), and non-literal
// require() calls are forbidden so unvendored dependencies or dynamic lookups cannot slip in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp.ts');

const CODE_EXT_RE = /\.(ts|js|mjs|cjs)$/;

// Literal: single quote, double quote, or backtick without ${
const LIT = "(?:'((?:[^'\\\\\r\n]|\\\\.)*)'|\"((?:[^\"\\\\\r\n]|\\\\.)*)\"|`((?:[^`\\\\$\r\n]|\\\\.|\x24(?!\\{))*)`)";

const RE_REQUIRE_RESOLVE = new RegExp(`(?<!['"\`\\w$.])require\\.resolve\\s*\\(\\s*${LIT}\\s*[,)]`, 'g');
const RE_REQUIRE = new RegExp(`(?<!['"\`\\w$.])require\\s*\\(\\s*${LIT}\\s*\\)`, 'g');
const RE_IMPORT_CALL = new RegExp(`(?<!['"\`\\w$.])import\\s*\\(\\s*${LIT}\\s*[,)]`, 'g');
const RE_FROM = new RegExp(`(?:\\b(?:import|export)\\b[^;]*?|\\})\\bfrom\\s*${LIT}`, 'g');
const RE_BARE_IMPORT = new RegExp(`(?<!['"\`\\w$.])import\\s*${LIT}`, 'g');

const RE_ANY_REQUIRE = /(?<!['"`\w$.])require\s*\(/g;
const RE_LIT_ARG = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`)\s*\)/;

const RE_CREATE_REQUIRE = /(?<!['"`\w$])createRequire\s*\(/g;
const RE_MODULE_REQUIRE = /(?<!['"`\w$])module\.require\s*\(/g;
const RE_ANY_IMPORT = /(?<!['"`\w$.])import\s*\(/g;
const RE_LIT_IMPORT_ARG = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`)\s*[,)]/;

function isAllowedSpecifier(spec) {
  return typeof spec === 'string' && (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'));
}

/**
 * Scan a single file's content line-by-line for bare imports and non-literal requires.
 * Returns an array of findings in the format: "<filePath>:<line> <reason>".
 */
function scanFileContent(filePath, text) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    for (const m of line.matchAll(RE_REQUIRE_RESOLVE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!isAllowedSpecifier(spec)) {
        findings.push(`${filePath}:${lineNum} bare specifier '${spec}' in require.resolve (must start with node:, ./ or ../)`);
      }
    }

    for (const m of line.matchAll(RE_REQUIRE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!isAllowedSpecifier(spec)) {
        findings.push(`${filePath}:${lineNum} bare specifier '${spec}' in require (must start with node:, ./ or ../)`);
      }
    }

    for (const m of line.matchAll(RE_IMPORT_CALL)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!isAllowedSpecifier(spec)) {
        findings.push(`${filePath}:${lineNum} bare specifier '${spec}' in import() (must start with node:, ./ or ../)`);
      }
    }

    for (const m of line.matchAll(RE_FROM)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!isAllowedSpecifier(spec)) {
        findings.push(`${filePath}:${lineNum} bare specifier '${spec}' in from import (must start with node:, ./ or ../)`);
      }
    }

    for (const m of line.matchAll(RE_BARE_IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!isAllowedSpecifier(spec)) {
        findings.push(`${filePath}:${lineNum} bare specifier '${spec}' in bare import (must start with node:, ./ or ../)`);
      }
    }

    for (const m of line.matchAll(RE_ANY_REQUIRE)) {
      const afterParen = line.slice(m.index + m[0].length);
      if (!RE_LIT_ARG.test(afterParen)) {
        findings.push(`${filePath}:${lineNum} require() argument must be a string literal without interpolation`);
      }
    }

    for (const m of line.matchAll(RE_CREATE_REQUIRE)) {
      findings.push(`${filePath}:${lineNum} createRequire() is forbidden`);
    }

    for (const m of line.matchAll(RE_MODULE_REQUIRE)) {
      findings.push(`${filePath}:${lineNum} module.require() is forbidden`);
    }

    for (const m of line.matchAll(RE_ANY_IMPORT)) {
      const afterParen = line.slice(m.index + m[0].length);
      if (!RE_LIT_IMPORT_ARG.test(afterParen)) {
        findings.push(`${filePath}:${lineNum} import() argument must be a string literal without interpolation`);
      }
    }
  });
  return findings;
}

/**
 * Scan src/ and bin/ for bare imports per IC-006.
 * Accepts either:
 * - a root directory string (defaults to REPO)
 * - an options object { rootDir } or { files }
 * - a Map of relative path -> file content
 */
function checkBareImports(target = REPO) {
  const findings = [];

  if (typeof target === 'string' || (target && typeof target === 'object' && !target.files && !(target instanceof Map))) {
    const rootDir = typeof target === 'string' ? target : (target?.rootDir ?? REPO);

    if (!fs.existsSync(rootDir)) {
      findings.push(`root directory does not exist: ${rootDir}`);
      return findings;
    }

    let scannedCount = 0;
    function walk(dir) {
      const fullDir = path.join(rootDir, dir);
      if (!fs.existsSync(fullDir)) return;
      for (const ent of fs.readdirSync(fullDir, { withFileTypes: true })) {
        const rel = path.join(dir, ent.name);
        const full = path.join(fullDir, ent.name);
        if (ent.isDirectory()) {
          walk(rel);
        } else if (CODE_EXT_RE.test(ent.name) && !ent.name.endsWith('.d.ts')) {
          scannedCount += 1;
          const normRel = rel.split(path.sep).join('/');
          const content = fs.readFileSync(full, 'utf8');
          findings.push(...scanFileContent(normRel, content));
        }
      }
    }

    for (const dir of ['src', 'bin']) walk(dir);

    if (scannedCount === 0) {
      findings.push(`walk found zero files in src/ or bin/ under ${rootDir}`);
    }

    return findings;
  }

  let files;
  if (target instanceof Map) {
    files = target;
  } else if (target?.files instanceof Map) {
    files = target.files;
  } else if (target?.files && typeof target.files === 'object') {
    files = new Map(Object.entries(target.files));
  } else {
    files = new Map();
  }
  for (const [file, content] of files) {
    if (!/^(src|bin)\//.test(file)) continue;
    if (!CODE_EXT_RE.test(file) || file.endsWith('.d.ts')) continue;
    findings.push(...scanFileContent(file, content));
  }
  return findings;
}

const checkG50BareImports = checkBareImports;

test('G50: shipped src/ and bin/ source files contain no bare imports or non-literal requires', () => {
  assert.ok(fs.existsSync(path.join(REPO, 'src')), 'src/ must exist');
  assert.ok(fs.existsSync(path.join(REPO, 'bin')), 'bin/ must exist');
  const findings = checkBareImports(REPO);
  assert.deepEqual(findings, [], `bare imports or non-literal requires found in repository:\n${findings.join('\n')}`);
});

test('G50 controls: fixture-map catches bare specifiers and non-literal requires, and permits safe specifiers', () => {
  const seeded = new Map([
    ['src/seeded.ts', "const chalk = require('chalk');\n"],
    ['bin/x.js', "import fs from 'fs';\n"],
    ['src/dynamic.ts', 'const mod = require(name);\n'],
    ['src/safe-node.ts', "const fs = require('node:fs');\n"],
    ['src/safe-parent.ts', "const a = require('../src/a.ts');\n"],
    ['src/safe-rel.ts', "import x from './y.js';\n"],
    ['src/safe-dyn.ts', "const mod = import('node:crypto');\n"],
    ['src/safe-resolve.ts', "const p = require.resolve('node:path');\n"],
    ['src/safe-bare.ts', "import './setup.js';\n"],
    ['src/safe-backtick.ts', 'const fs = require(`node:fs`);\n'],
  ]);

  const findings = checkBareImports({ files: seeded });

  assert.equal(findings.length, 3, `expected exactly 3 findings, got:\n${findings.join('\n')}`);
  assert.ok(findings.some((f) => f.startsWith('src/seeded.ts:1') && f.includes('chalk')),
    'expected src/seeded.ts:1 finding for require("chalk")');
  assert.ok(findings.some((f) => f.startsWith('bin/x.js:1') && f.includes('fs')),
    'expected bin/x.js:1 finding for import fs from "fs"');
  assert.ok(findings.some((f) => f.startsWith('src/dynamic.ts:1') && f.includes('require()')),
    'expected src/dynamic.ts:1 finding for require(name)');
});

test('G50 controls: all five specifier forms report non-allowed specifiers', () => {
  const allForms = new Map([
    ['src/f1.ts', "const a = require('chalk');\n"],
    ['src/f2.ts', "const b = require.resolve('chalk');\n"],
    ['src/f3.ts', "const c = import('chalk');\n"],
    ['src/f4.ts', "import { d } from 'chalk';\n"],
    ['src/f5.ts', "import 'chalk';\n"],
  ]);
  const findings = checkBareImports({ files: allForms });
  assert.equal(findings.length, 5);
  for (const file of ['src/f1.ts:1', 'src/f2.ts:1', 'src/f3.ts:1', 'src/f4.ts:1', 'src/f5.ts:1']) {
    assert.ok(findings.some((f) => f.startsWith(file) && f.includes('chalk')), `missing finding for ${file}`);
  }
});

test('G50 control: filesystem walk of copied release/bin directory identifies seeded fault in tempDir without touching tracked source', (t) => {
  function copyTree(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name);
      const d = path.join(dest, ent.name);
      if (ent.isDirectory()) copyTree(s, d);
      else if (ent.isFile()) fs.copyFileSync(s, d);
    }
  }

  const tmp = tempDir(t, 'doflow-g50-');
  copyTree(path.join(REPO, 'src', 'release'), path.join(tmp, 'src', 'release'));
  copyTree(path.join(REPO, 'bin'), path.join(tmp, 'bin'));

  assert.deepEqual(checkBareImports(tmp), [], 'clean copied directories should have no findings');

  const targetFile = path.join(tmp, 'src', 'release', 'changelog-section.ts');
  const originalContent = fs.readFileSync(targetFile, 'utf8');
  const originalLines = originalContent.split('\n').length;
  const expectedLine = originalContent.endsWith('\n') ? originalLines : originalLines + 1;

  fs.appendFileSync(targetFile, "require('chalk');\n");

  const mutatedFindings = checkBareImports(tmp);
  assert.equal(mutatedFindings.length, 1, `expected 1 finding on mutated tree, got:\n${mutatedFindings.join('\n')}`);
  assert.ok(
    mutatedFindings[0].startsWith(`src/release/changelog-section.ts:${expectedLine}`),
    `finding should name file and line src/release/changelog-section.ts:${expectedLine}, got: ${mutatedFindings[0]}`,
  );
  assert.ok(mutatedFindings[0].includes('chalk'), `finding should mention chalk: ${mutatedFindings[0]}`);
});

test('G50: ignores .d.ts files and files outside src/ and bin/', () => {
  const ignored = new Map([
    ['src/types.d.ts', "import 'chalk';\n"],
    ['test/sample.ts', "import 'chalk';\n"],
    ['src/readme.txt', "import 'chalk';\n"],
  ]);
  assert.deepEqual(checkBareImports({ files: ignored }), []);
});

test('G50 controls: scanning a nonexistent root or a walk with zero files fails', (t) => {
  const nonexistent = path.join(REPO, 'no-such-root-directory');
  const findingsNonexistent = checkBareImports(nonexistent);
  assert.ok(findingsNonexistent.length > 0, 'scanning a nonexistent root must fail');
  assert.ok(
    findingsNonexistent.some((f) => f.includes('does not exist')),
    `finding should report that root does not exist, got:\n${findingsNonexistent.join('\n')}`,
  );

  const empty = tempDir(t, 'doflow-g50-empty-');
  const findingsEmpty = checkBareImports(empty);
  assert.ok(findingsEmpty.length > 0, 'walking a directory with zero files in src/ or bin/ must fail');
  assert.ok(
    findingsEmpty.some((f) => f.includes('zero files') || f.includes('no files')),
    `finding should report zero files found, got:\n${findingsEmpty.join('\n')}`,
  );
});

test('G50 controls: fixture-map flags createRequire, module.require, and non-literal dynamic import', () => {
  const seeded = new Map([
    ['src/cr.ts', "const req = createRequire(import.meta.url);\n"],
    ['src/mr.ts', "const m = module.require('chalk');\n"],
    ['src/dyn-import.ts', 'const d = import(name);\n'],
    ['src/dyn-template.ts', 'const d = import(`${name}`);\n'],
    ['src/safe-dyn-node.ts', "const s = import('node:crypto');\n"],
    ['src/safe-dyn-rel.ts', "const r = import('./helper.ts');\n"],
  ]);

  const findings = checkBareImports({ files: seeded });

  assert.equal(findings.length, 4, `expected exactly 4 findings, got:\n${findings.join('\n')}`);
  assert.ok(findings.some((f) => f.startsWith('src/cr.ts:1') && f.includes('createRequire()')),
    'expected src/cr.ts:1 finding for createRequire()');
  assert.ok(findings.some((f) => f.startsWith('src/mr.ts:1') && f.includes('module.require()')),
    'expected src/mr.ts:1 finding for module.require()');
  assert.ok(findings.some((f) => f.startsWith('src/dyn-import.ts:1') && f.includes('import()')),
    'expected src/dyn-import.ts:1 finding for import(name)');
  assert.ok(findings.some((f) => f.startsWith('src/dyn-template.ts:1') && f.includes('import()')),
    'expected src/dyn-template.ts:1 finding for import(`${name}`)');
});

module.exports = {
  checkBareImports,
  checkG50BareImports,
  scanFileContent,
};

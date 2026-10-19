'use strict';

// G54 — roadmap imports and spawns (feature 108, NFR-004).
//
// The roadmap loop's mechanical steps (pick, gate, merge, S9 render, cleanup) must spend zero
// model tokens and remain completely decoupled from worker execution and dispatch mechanics:
//   - No roadmap module under src/runtime/roadmap/** may import:
//       * worker/launch (harness launcher)
//       * worker/supervisor (worker supervisor)
//       * dispatch/loop (dispatch loop)
//       * model-router or any model client (Anthropic, OpenAI, Gemini, Ollama, etc.)
//   - No roadmap module under src/runtime/roadmap/** may spawn any binary other than 'git'.
//     Mechanical steps execute git commands only; workers appear only at implementation through 082
//     dispatch (yielded to the orchestrator as a perform envelope).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp');

const ROADMAP_DIR = 'src/runtime/roadmap';
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

const RE_ANY_IMPORT = /(?<!['"`\w$.])import\s*\(/g;
const RE_LIT_IMPORT_ARG = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`)\s*[,)]/;

const RE_CREATE_REQUIRE = /(?<!['"`\w$])createRequire\s*\(/g;
const RE_MODULE_REQUIRE = /(?<!['"`\w$])module\.require\s*\(/g;

// Spawn expressions
const RE_SPAWN_CALL = /(?<!['"`\w$.])(?:child_process\.|cp\.)?(spawn|spawnSync|execFile|execFileSync)\s*\(\s*(['"`])([^'"`]+)\2/g;
const RE_ANY_SPAWN = /(?<!['"`\w$.])(?:child_process\.|cp\.)?(spawn|spawnSync|execFile|execFileSync)\s*\(/g;
const RE_EXEC_CALL = /(?<!['"`\w$.])(?:child_process\.|cp\.)?(exec|execSync)\s*\(\s*(['"`])([^'"`]+)\2/g;
const RE_ANY_EXEC = /(?<!['"`\w$.])(?:child_process\.|cp\.)?(exec|execSync)\s*\(/g;
const RE_FORK_CALL = /(?<!['"`\w$.])(?:child_process\.|cp\.)?fork\s*\(/g;

/**
 * Check if an import specifier matches any forbidden target.
 * Returns error reason if forbidden, else null.
 */
function checkForbiddenImport(spec) {
  if (typeof spec !== 'string') return null;
  const norm = spec.replace(/\\/g, '/');

  if (/(?:^|\/)worker\/launch(?:\.[a-z]+)?$/.test(norm) || norm.includes('worker/launch')) {
    return `forbidden import of worker/launch: '${spec}'`;
  }
  if (/(?:^|\/)worker\/supervisor(?:\.[a-z]+)?$/.test(norm) || norm.includes('worker/supervisor')) {
    return `forbidden import of worker/supervisor: '${spec}'`;
  }
  if (/(?:^|\/)dispatch\/loop(?:\.[a-z]+)?$/.test(norm) || norm.includes('dispatch/loop')) {
    return `forbidden import of dispatch/loop: '${spec}'`;
  }
  if (/(?:^|\/)model-router(?:\.[a-z]+)?$/.test(norm) || norm.includes('model-router')) {
    return `forbidden import of model-router: '${spec}'`;
  }

  // Model clients & AI SDKs
  if (
    norm === 'openai' ||
    norm.startsWith('openai/') ||
    norm.startsWith('@openai/') ||
    norm === 'anthropic' ||
    norm.startsWith('anthropic/') ||
    norm.startsWith('@anthropic-ai/') ||
    norm.startsWith('@google/genai') ||
    norm.startsWith('@google/generative-ai') ||
    norm === 'ollama' ||
    norm.startsWith('ollama/') ||
    norm.includes('model-client') ||
    /(?:claude|codex|gemini|gpt|llm|model)-client/i.test(norm)
  ) {
    return `forbidden import of model client: '${spec}'`;
  }

  return null;
}

/**
 * Scan a single file's text for forbidden imports and non-git spawns.
 * Returns an array of findings in format "<filePath>:<line> <reason>".
 */
function scanFileContent(filePath, text) {
  const findings = [];
  const lines = text.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    // Check imports with literal specifiers
    for (const m of line.matchAll(RE_REQUIRE_RESOLVE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const err = checkForbiddenImport(spec);
      if (err) findings.push(`${filePath}:${lineNum} ${err}`);
    }

    for (const m of line.matchAll(RE_REQUIRE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const err = checkForbiddenImport(spec);
      if (err) findings.push(`${filePath}:${lineNum} ${err}`);
    }

    for (const m of line.matchAll(RE_IMPORT_CALL)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const err = checkForbiddenImport(spec);
      if (err) findings.push(`${filePath}:${lineNum} ${err}`);
    }

    for (const m of line.matchAll(RE_FROM)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const err = checkForbiddenImport(spec);
      if (err) findings.push(`${filePath}:${lineNum} ${err}`);
    }

    for (const m of line.matchAll(RE_BARE_IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const err = checkForbiddenImport(spec);
      if (err) findings.push(`${filePath}:${lineNum} ${err}`);
    }

    // Require & import argument must be static literal
    for (const m of line.matchAll(RE_ANY_REQUIRE)) {
      const afterParen = line.slice(m.index + m[0].length);
      if (!RE_LIT_ARG.test(afterParen)) {
        findings.push(`${filePath}:${lineNum} require() argument must be a string literal without interpolation`);
      }
    }

    for (const m of line.matchAll(RE_ANY_IMPORT)) {
      const afterParen = line.slice(m.index + m[0].length);
      if (!RE_LIT_IMPORT_ARG.test(afterParen)) {
        findings.push(`${filePath}:${lineNum} import() argument must be a string literal without interpolation`);
      }
    }

    for (const m of line.matchAll(RE_CREATE_REQUIRE)) {
      findings.push(`${filePath}:${lineNum} createRequire() is forbidden`);
    }

    for (const m of line.matchAll(RE_MODULE_REQUIRE)) {
      findings.push(`${filePath}:${lineNum} module.require() is forbidden`);
    }

    // Spawns: only 'git' binary is permitted
    for (const m of line.matchAll(RE_SPAWN_CALL)) {
      const binary = m[3];
      if (binary !== 'git') {
        findings.push(`${filePath}:${lineNum} spawn of binary other than 'git': '${binary}'`);
      }
    }

    for (const m of line.matchAll(RE_ANY_SPAWN)) {
      const afterParen = line.slice(m.index + m[0].length);
      const litMatch = afterParen.match(/^\s*(['"`])([^'"`]+)\1/);
      if (!litMatch) {
        findings.push(`${filePath}:${lineNum} spawn binary is not statically known to be 'git'`);
      }
    }

    // Shell exec calls
    for (const m of line.matchAll(RE_EXEC_CALL)) {
      const cmdStr = m[3].trim();
      const firstWord = cmdStr.split(/\s+/)[0];
      if (firstWord !== 'git') {
        findings.push(`${filePath}:${lineNum} spawn of binary other than 'git': '${firstWord}'`);
      }
    }

    for (const m of line.matchAll(RE_ANY_EXEC)) {
      const afterParen = line.slice(m.index + m[0].length);
      const litMatch = afterParen.match(/^\s*(['"`])([^'"`]+)\1/);
      if (!litMatch) {
        findings.push(`${filePath}:${lineNum} spawn binary is not statically known to be 'git'`);
      }
    }

    for (const m of line.matchAll(RE_FORK_CALL)) {
      findings.push(`${filePath}:${lineNum} spawn of binary other than 'git' (fork)`);
    }
  });

  return [...new Set(findings)];
}

/**
 * Scan roadmap modules under rootDir or from a provided file Map.
 * Returns { findings, moduleCount }.
 */
function checkRoadmapImports(target = REPO) {
  const findings = [];
  let moduleCount = 0;

  if (typeof target === 'string' || (target && typeof target === 'object' && !target.files && !(target instanceof Map))) {
    const rootDir = typeof target === 'string' ? target : (target?.rootDir ?? REPO);
    const roadmapPath = path.join(rootDir, ROADMAP_DIR);

    if (fs.existsSync(roadmapPath)) {
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            walk(full);
          } else if (CODE_EXT_RE.test(ent.name) && !ent.name.endsWith('.d.ts')) {
            moduleCount++;
            const rel = path.relative(rootDir, full).split(path.sep).join('/');
            const text = fs.readFileSync(full, 'utf8');
            findings.push(...scanFileContent(rel, text));
          }
        }
      };
      walk(roadmapPath);
    }

    return { findings, moduleCount };
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
    if (!CODE_EXT_RE.test(file) || file.endsWith('.d.ts')) continue;
    moduleCount++;
    findings.push(...scanFileContent(file, content));
  }

  return { findings, moduleCount };
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────

test('G54: shipped src/runtime/roadmap/** modules import no worker/launcher/models and spawn only git', (t) => {
  const { findings, moduleCount } = checkRoadmapImports(REPO);
  t.diagnostic(`G54: scanned ${moduleCount} roadmap module(s)`);
  assert.deepEqual(findings, [], `forbidden imports or non-git spawns found in roadmap modules:\n${findings.join('\n')}`);
});

test('G54: passes on empty tree and reports module count 0', (t) => {
  const tmp = tempDir(t, 'doflow-g54-empty-');
  const { findings, moduleCount } = checkRoadmapImports(tmp);
  assert.equal(moduleCount, 0, 'expected module count 0 for empty tree');
  assert.deepEqual(findings, []);
});

test('G54 control: scratch source with require(\'../worker/launch.ts\') turns guard red', () => {
  const seeded = new Map([
    ['src/runtime/roadmap/bad-launch.ts', "const { launchWorker } = require('../worker/launch.ts');\n"],
  ]);
  const { findings } = checkRoadmapImports({ files: seeded });
  assert.ok(findings.length >= 1, 'expected finding for require(\'../worker/launch.ts\')');
  assert.ok(findings.some((f) => f.includes('forbidden import of worker/launch')), `missing worker/launch finding: ${findings.join('\n')}`);
});

test('G54 control: scratch source with spawn(\'node\') turns guard red', () => {
  const seeded = new Map([
    ['src/runtime/roadmap/bad-spawn.ts', "const { spawn } = require('node:child_process');\nspawn('node', ['script.js']);\n"],
  ]);
  const { findings } = checkRoadmapImports({ files: seeded });
  assert.ok(findings.length >= 1, 'expected finding for spawn(\'node\')');
  assert.ok(findings.some((f) => f.includes("spawn of binary other than 'git': 'node'")), `missing spawn node finding: ${findings.join('\n')}`);
});

test('G54 control: forbidden imports are detected across all targeted subsystems', () => {
  const seeded = new Map([
    ['src/runtime/roadmap/mod-sup.ts', "const sup = require('../worker/supervisor.ts');\n"],
    ['src/runtime/roadmap/mod-loop.ts', "const { dispatchLoop } = require('../dispatch/loop.ts');\n"],
    ['src/runtime/roadmap/mod-router.ts', "import { resolveModel } from '../model-router.ts';\n"],
    ['src/runtime/roadmap/mod-ai.ts', "import OpenAI from 'openai';\n"],
    ['src/runtime/roadmap/mod-anthropic.ts', "const { Anthropic } = require('@anthropic-ai/sdk');\n"],
    ['src/runtime/roadmap/mod-google.ts', "const genai = require('@google/genai');\n"],
    ['src/runtime/roadmap/mod-ollama.ts', "const ollama = import('ollama');\n"],
  ]);
  const { findings } = checkRoadmapImports({ files: seeded });
  assert.equal(findings.length, 7, `expected 7 findings, got:\n${findings.join('\n')}`);
  assert.ok(findings.some((f) => f.includes('worker/supervisor')));
  assert.ok(findings.some((f) => f.includes('dispatch/loop')));
  assert.ok(findings.some((f) => f.includes('model-router')));
  assert.ok(findings.some((f) => f.includes('openai')));
  assert.ok(findings.some((f) => f.includes('@anthropic-ai')));
  assert.ok(findings.some((f) => f.includes('@google/genai')));
  assert.ok(findings.some((f) => f.includes('ollama')));
});

test('G54 control: non-git spawns and dynamic spawns are detected across all invocation forms', () => {
  const seeded = new Map([
    ['src/runtime/roadmap/spawn-sh.ts', "spawnSync('sh', ['-c', 'echo 1']);\n"],
    ['src/runtime/roadmap/spawn-python.ts', "execFileSync('python', ['-V']);\n"],
    ['src/runtime/roadmap/spawn-bash.ts', "exec('bash script.sh');\n"],
    ['src/runtime/roadmap/spawn-fork.ts', "fork('helper.js');\n"],
    ['src/runtime/roadmap/spawn-dyn.ts', "spawn(cmd, args);\n"],
  ]);
  const { findings } = checkRoadmapImports({ files: seeded });
  assert.equal(findings.length, 5, `expected 5 findings, got:\n${findings.join('\n')}`);
  assert.ok(findings.some((f) => f.includes("'sh'")));
  assert.ok(findings.some((f) => f.includes("'python'")));
  assert.ok(findings.some((f) => f.includes("'bash'")));
  assert.ok(findings.some((f) => f.includes('fork')));
  assert.ok(findings.some((f) => f.includes('not statically known to be \'git\'')));
});

test('G54: allowed imports and git spawns pass inspection', () => {
  const safeCode = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawn, execFileSync } = require('node:child_process');",
    "const { parseSeed } = require('./rows.ts');",
    "const { loadPolicy } = require('./gates.ts');",
    "const { checkouts } = require('../checkouts.ts');",
    "spawn('git', ['status']);",
    "execFileSync('git', ['rev-parse', 'HEAD']);",
  ].join('\n');

  const seeded = new Map([['src/runtime/roadmap/loop.ts', safeCode]]);
  const { findings, moduleCount } = checkRoadmapImports({ files: seeded });
  assert.equal(moduleCount, 1);
  assert.deepEqual(findings, []);
});

test('G54 control: filesystem tempDir identifies seeded fault without touching tracked sources', (t) => {
  const tmp = tempDir(t, 'doflow-g54-imports-');
  const targetDir = path.join(tmp, ROADMAP_DIR);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'fault.ts'), "const l = require('../worker/launch.ts');\n");

  const { findings, moduleCount } = checkRoadmapImports(tmp);
  assert.equal(moduleCount, 1);
  assert.ok(findings.length >= 1);
  assert.ok(findings[0].includes('forbidden import of worker/launch'));
});

module.exports = {
  checkRoadmapImports,
  scanFileContent,
  checkForbiddenImport,
};

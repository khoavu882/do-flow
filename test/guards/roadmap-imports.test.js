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
//
// Person-only clause (feature 113, IC-007): `roadmap seed` is a person-run verb, never a loop step.
//   - src/runtime/roadmap/seed.ts is required only by src/cli/runtime-commands.ts (zero or one
//     requirer; when present it is exactly that file); no other module under src/ requires it.
//   - loop.ts, gates.ts, merge.ts and facts.ts carry no string literal 'seed' as an argv element
//     (a single-line array literal holding 'seed' beside 'roadmap' or a '--flag' element), as a
//     `skill:` field value, or as a literal argument of envelopeFor(...). A lone ['seed'] (the
//     unreadable-sources list in loop.ts) is not an argv and is allowed.
//   - core/registry/gates.json names no `seed` predicate (equal to 'seed' or starting 'seed:').

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

// ── Person-only clause (113, IC-007) ─────────────────────────────────────────────────────────────

const SEED_PATH = 'src/runtime/roadmap/seed.ts';
const SEED_ALLOWED_REQUIRER = 'src/cli/runtime-commands.ts';
const SEED_ENVELOPE_FILES = ['loop.ts', 'gates.ts', 'merge.ts', 'facts.ts'].map((f) => `${ROADMAP_DIR}/${f}`);
const SEED_SPEC_RE = /(?:^|\/)seed(?:\.[a-z]+)?$/;
const ALL_SPEC_RES = [RE_REQUIRE_RESOLVE, RE_REQUIRE, RE_IMPORT_CALL, RE_FROM, RE_BARE_IMPORT];
const SEED_LIT = /(?:'seed'|"seed"|`seed`)/;
const RE_SINGLE_ARRAY = /\[([^\[\]]*)\]/g;
const RE_SKILL_SEED = /\bskill\s*:\s*(?:'seed'|"seed"|`seed`)/;
const RE_ENVELOPE_CALL_SEED = /\benvelopeFor\s*\([^)]*(?:'seed'|"seed"|`seed`)/;

/** Literal import/require specifiers in a file's text that name the seed module. */
function seedSpecLines(text) {
  const hits = [];
  text.split('\n').forEach((line, idx) => {
    for (const re of ALL_SPEC_RES) {
      for (const m of line.matchAll(re)) {
        const spec = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\/g, '/');
        if (SEED_SPEC_RE.test(spec)) hits.push(idx + 1);
      }
    }
  });
  return [...new Set(hits)];
}

/** Files under src/ (from a Map of path -> text) that require the seed module, and findings. */
function scanSeedRequirers(files) {
  const requirers = [];
  const findings = [];
  for (const [file, text] of files) {
    if (!file.startsWith('src/') || !CODE_EXT_RE.test(file) || file.endsWith('.d.ts') || file === SEED_PATH) continue;
    const lines = seedSpecLines(text);
    if (lines.length === 0) continue;
    requirers.push(file);
    if (file !== SEED_ALLOWED_REQUIRER) {
      findings.push(`${file}:${lines[0]} requires ${SEED_PATH}; only ${SEED_ALLOWED_REQUIRER} may`);
    }
  }
  return { requirers, findings };
}

/** 'seed' as an envelope argv element, a skill value or an envelopeFor() argument. */
function scanSeedEnvelope(filePath, text) {
  const findings = [];
  text.split('\n').forEach((line, idx) => {
    const at = `${filePath}:${idx + 1}`;
    for (const m of line.matchAll(RE_SINGLE_ARRAY)) {
      if (!SEED_LIT.test(m[1])) continue;
      if (/(?:'roadmap'|"roadmap"|['"\x60]--[\w-]+['"\x60])/.test(m[1])) {
        findings.push(`${at} string literal 'seed' in an argv array: [${m[1].trim()}]`);
      }
    }
    if (RE_SKILL_SEED.test(line)) findings.push(`${at} string literal 'seed' as a skill value`);
    if (RE_ENVELOPE_CALL_SEED.test(line)) findings.push(`${at} string literal 'seed' passed to envelopeFor()`);
  });
  return [...new Set(findings)];
}

/** Predicates of core/registry/gates.json equal to 'seed' or starting 'seed:'. */
function scanGatesSeedPredicates(gates) {
  const findings = [];
  for (const [cls, gateSet] of Object.entries(gates?.classes ?? {})) {
    for (const [gate, def] of Object.entries(gateSet ?? {})) {
      for (const pred of def?.predicates ?? []) {
        if (typeof pred === 'string' && (pred === 'seed' || pred.startsWith('seed:'))) {
          findings.push(`core/registry/gates.json classes.${cls}.${gate}.predicates names '${pred}'`);
        }
      }
    }
  }
  return findings;
}

/** The whole clause over { files: Map<path,text>, gates: object }. Returns { findings, requirers }. */
function checkSeedPersonOnly({ files = new Map(), gates = {} } = {}) {
  const { requirers, findings } = scanSeedRequirers(files);
  for (const [file, text] of files) {
    if (SEED_ENVELOPE_FILES.includes(file)) findings.push(...scanSeedEnvelope(file, text));
  }
  findings.push(...scanGatesSeedPredicates(gates));
  return { findings, requirers };
}

function loadSrcFiles(rootDir) {
  const files = new Map();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (CODE_EXT_RE.test(ent.name)) {
        files.set(path.relative(rootDir, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
      }
    }
  };
  if (fs.existsSync(path.join(rootDir, 'src'))) walk(path.join(rootDir, 'src'));
  return files;
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

test('G54 person-only: seed.ts is required only by runtime-commands.ts; no seed argv, skill or gates predicate', (t) => {
  const files = loadSrcFiles(REPO);
  assert.ok(files.has('src/runtime/roadmap/loop.ts'), 'scan must see loop.ts');
  for (const f of SEED_ENVELOPE_FILES) assert.ok(files.has(f), `scan must see ${f}`);
  const gates = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));
  const { findings, requirers } = checkSeedPersonOnly({ files, gates });
  t.diagnostic(`G54 person-only: requirers of seed.ts = [${requirers.join(', ')}]`);
  assert.ok(requirers.length <= 1, `seed.ts has more than one requirer: ${requirers.join(', ')}`);
  if (requirers.length === 1) assert.equal(requirers[0], SEED_ALLOWED_REQUIRER);
  assert.deepEqual(findings, [], `person-only clause violated:\n${findings.join('\n')}`);
});

test('G54 person-only control: loop.ts with require(\'./seed.ts\') turns guard red; runtime-commands.ts alone stays green', () => {
  const bad = checkSeedPersonOnly({ files: new Map([
    ['src/runtime/roadmap/loop.ts', "const seed = require('./seed.ts');\n"],
    [SEED_ALLOWED_REQUIRER, "const seed = () => require('../runtime/roadmap/seed.ts');\n"],
  ]) });
  assert.deepEqual(bad.requirers.sort(), [SEED_ALLOWED_REQUIRER, 'src/runtime/roadmap/loop.ts']);
  assert.ok(bad.findings.some((f) => f.startsWith('src/runtime/roadmap/loop.ts:1 requires')), bad.findings.join('\n'));
  const other = checkSeedPersonOnly({ files: new Map([['src/cli/other.ts', "import { x } from '../runtime/roadmap/seed';\n"]]) });
  assert.equal(other.findings.length, 1, 'import-from form must also be caught');
  const ok = checkSeedPersonOnly({ files: new Map([[SEED_ALLOWED_REQUIRER, "const s = require('../runtime/roadmap/seed.ts');\n"]]) });
  assert.deepEqual(ok.findings, []);
  assert.deepEqual(ok.requirers, [SEED_ALLOWED_REQUIRER]);
});

test('G54 person-only control: a seed argv, skill or envelopeFor argument in loop.ts turns guard red', () => {
  const argv = checkSeedPersonOnly({ files: new Map([
    ['src/runtime/roadmap/loop.ts', "const after = [\"roadmap\",\"seed\",\"--action\",\"apply\"];\n"],
  ]) });
  assert.equal(argv.findings.length, 1, argv.findings.join('\n'));
  assert.match(argv.findings[0], /argv array/);
  const skill = scanSeedEnvelope('src/runtime/roadmap/loop.ts', "const p = { stage: 'x', skill: 'seed' };\n");
  assert.equal(skill.length, 1);
  const call = scanSeedEnvelope('src/runtime/roadmap/merge.ts', "envelopeFor(ctx, row, wt, 'implementation', 'seed', before);\n");
  assert.equal(call.length, 1);
  // The unreadable-sources list is not an argv and stays allowed.
  assert.deepEqual(scanSeedEnvelope('src/runtime/roadmap/loop.ts', "throw new Unreadable(['seed'], error.message);\n"), []);
  assert.deepEqual(scanSeedEnvelope('src/runtime/roadmap/loop.ts', "const a = ['roadmap', '--action', 'next'];\n"), []);
});

test('G54 person-only control: a gates object with a seed predicate turns guard red', () => {
  const gates = { classes: { feature: { 'gate-a': { predicates: ['protected-paths', 'seed'] }, 'gate-b': { predicates: ['seed:ready'] } } } };
  const { findings } = checkSeedPersonOnly({ gates });
  assert.equal(findings.length, 2, findings.join('\n'));
  assert.deepEqual(scanGatesSeedPredicates({ classes: { feature: { 'gate-a': { predicates: ['seeded', 'needs-merged'] } } } }), []);
});

test('G54 person-only control: filesystem tree where another src module requires ./seed.ts is caught', (t) => {
  const tmp = tempDir(t, 'doflow-g54-seed-');
  fs.mkdirSync(path.join(tmp, 'src/runtime/roadmap'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src/runtime/roadmap/merge.ts'), "const s = require('./seed.ts');\n");
  const { findings } = checkSeedPersonOnly({ files: loadSrcFiles(tmp) });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^src\/runtime\/roadmap\/merge\.ts:1 requires/);
});

module.exports = {
  checkSeedPersonOnly,
  scanSeedRequirers,
  scanSeedEnvelope,
  scanGatesSeedPredicates,
  checkRoadmapImports,
  scanFileContent,
  checkForbiddenImport,
};

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
// Person-only clause (feature 113, IC-007, review C-8): `roadmap seed` is a person-run verb, never a loop step.
//   - src/runtime/roadmap/seed.ts is required only by src/cli/runtime-commands.ts (zero or one
//     requirer; when present it is exactly that file); no other module under src/ requires it.
//   - All modules across src/** (except seed.ts and runtime-commands.ts) are scanned over comment-stripped
//     whole text:
//       * no array literal (single- or multi-line) holding 'seed' beside 'roadmap' or an element
//         starting with '--action' or '--draft' (with or without =value);
//       * no `skill:` field value of 'seed';
//       * no `envelopeFor(...)` call where 'seed' is an argument;
//       * under src/runtime/roadmap/** only: no variable binding whose value is exactly 'seed'
//         (const|let|var NAME [: type] = 'seed').
//     A lone ['seed'] (such as loop.ts's unreadable-sources list) or a stage name in rehearse.ts
//     is not an argv and is allowed.
//   - core/registry/gates.json names no `seed` predicate (equal to 'seed' or starting 'seed:').
//   - core/shared/** and core/registry/** text files (.md, .json, .yaml, .yml, .txt) name no
//     forbidden invocation matching `seed --action apply|amend` (with whitespace or '=').

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp.ts');

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

// ── Person-only clause (113, IC-007, review C-8) ─────────────────────────────────────────────────────────────

const SEED_PATH = 'src/runtime/roadmap/seed.ts';
const SEED_ALLOWED_REQUIRER = 'src/cli/runtime-commands.ts';
const SEED_ENVELOPE_FILES = ['loop.ts', 'gates.ts', 'merge.ts', 'facts.ts'].map((f) => `${ROADMAP_DIR}/${f}`);
const SEED_SPEC_RE = /(?:^|\/)seed(?:\.[a-z]+)?$/;
const ALL_SPEC_RES = [RE_REQUIRE_RESOLVE, RE_REQUIRE, RE_IMPORT_CALL, RE_FROM, RE_BARE_IMPORT];
const SEED_LIT = /(?:'seed'|"seed"|`seed`)/;
const RE_SINGLE_ARRAY = /\[([^\[\]]*)\]/g;
const RE_ROADMAP_ELEM = /['"`]roadmap['"`]/;
const RE_ACTION_OR_DRAFT_ELEM = /['"`]--(?:action|draft)(?:=[^'"`]*)?['"`]/;
const RE_SKILL_SEED = /\bskill\s*:\s*(?:'seed'|"seed"|`seed`)/g;
const RE_ENVELOPE_CALL = /\benvelopeFor\s*\(([\s\S]*?)\)/g;
const RE_ROADMAP_BINDING = /\b(?:const|let|var)\s+[a-zA-Z_$][\w$]*\s*(?::\s*[^=;\n]+)?\s*=\s*(?:'seed'|"seed"|`seed`)(?=\s*(?:;|\/\/|\/\*|\r|\n|$))/g;
const DOC_EXT_RE = /\.(md|json|yaml|yml|txt)$/i;
const RE_DOC_SEED_ACTION = /\bseed\s+--action(?:\s+|=)(?:apply|amend)\b/g;

/** String- and template-literal-aware comment stripper: // and /* * / outside quotes are removed, keeping newlines. */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  const stack = [];

  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : '';
    const currentContext = stack.length > 0 ? stack[stack.length - 1] : null;

    if (currentContext === 'template') {
      if (ch === '\\') {
        out += ch;
        i++;
        if (i < n) {
          out += text[i];
          i++;
        }
        continue;
      }
      if (ch === '`') {
        stack.pop();
        out += ch;
        i++;
        continue;
      }
      if (ch === '$' && next === '{') {
        stack.push({ type: 'expr', braces: 1 });
        out += '${';
        i += 2;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        const c = text[i];
        out += c;
        if (c === '\\') {
          i++;
          if (i < n) {
            out += text[i];
          }
        } else if (c === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = text[i];
        out += c;
        if (c === '\\') {
          i++;
          if (i < n) {
            out += text[i];
          }
        } else if (c === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '`') {
      stack.push('template');
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && text[i] !== '\n' && text[i] !== '\r') {
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      let hasNewline = false;
      while (i < n) {
        if (text[i] === '*' && i + 1 < n && text[i + 1] === '/') {
          i += 2;
          break;
        }
        if (text[i] === '\n' || text[i] === '\r') {
          out += text[i];
          hasNewline = true;
        }
        i++;
      }
      if (!hasNewline) {
        out += ' ';
      }
      continue;
    }

    if (currentContext && currentContext.type === 'expr') {
      if (ch === '{') {
        currentContext.braces++;
      } else if (ch === '}') {
        currentContext.braces--;
        if (currentContext.braces === 0) {
          stack.pop();
          out += ch;
          i++;
          continue;
        }
      }
    }

    out += ch;
    i++;
  }

  return out;
}

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

/** 'seed' as an envelope argv element, a skill value, an envelopeFor() argument, or a roadmap binding. */
function scanSeedEnvelope(filePath, text) {
  const stripped = stripComments(text);
  const findings = [];

  // (a) Array literal holding 'seed' and roadmap or --action/--draft
  for (const m of stripped.matchAll(RE_SINGLE_ARRAY)) {
    const inner = m[1];
    if (SEED_LIT.test(inner)) {
      if (RE_ROADMAP_ELEM.test(inner) || RE_ACTION_OR_DRAFT_ELEM.test(inner)) {
        const line = stripped.slice(0, m.index).split('\n').length;
        findings.push({ line, msg: `${filePath}:${line} string literal 'seed' in an argv array: [${inner.trim()}]` });
      }
    }
  }

  // (b) skill: 'seed'
  for (const m of stripped.matchAll(RE_SKILL_SEED)) {
    const line = stripped.slice(0, m.index).split('\n').length;
    findings.push({ line, msg: `${filePath}:${line} string literal 'seed' as a skill value` });
  }

  // (c) envelopeFor(...) with 'seed'
  for (const m of stripped.matchAll(RE_ENVELOPE_CALL)) {
    if (SEED_LIT.test(m[1])) {
      const line = stripped.slice(0, m.index).split('\n').length;
      findings.push({ line, msg: `${filePath}:${line} string literal 'seed' passed to envelopeFor()` });
    }
  }

  // (d) bindings in src/runtime/roadmap/**
  const normPath = filePath.replace(/\\/g, '/');
  if (normPath.startsWith(`${ROADMAP_DIR}/`)) {
    for (const m of stripped.matchAll(RE_ROADMAP_BINDING)) {
      const line = stripped.slice(0, m.index).split('\n').length;
      findings.push({ line, msg: `${filePath}:${line} string literal 'seed' as a binding value` });
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return [...new Set(findings.map((f) => f.msg))];
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

/** The whole clause over { files: Map<path,text>, gates: object, docs: Map<path,text> }. Returns { findings, requirers }. */
function checkSeedPersonOnly({ files = new Map(), gates = {}, docs = new Map() } = {}) {
  const filesMap = files instanceof Map ? files : new Map(Object.entries(files || {}));
  const docsMap = docs instanceof Map ? docs : new Map(Object.entries(docs || {}));
  const { requirers, findings } = scanSeedRequirers(filesMap);
  for (const [file, text] of filesMap) {
    const norm = file.replace(/\\/g, '/');
    if (norm === SEED_PATH || norm === SEED_ALLOWED_REQUIRER) continue;
    if (!CODE_EXT_RE.test(norm) || norm.endsWith('.d.ts')) continue;
    findings.push(...scanSeedEnvelope(file, text));
  }
  for (const [file, text] of docsMap) {
    const norm = file.replace(/\\/g, '/');
    if (!DOC_EXT_RE.test(norm)) continue;
    for (const m of text.matchAll(RE_DOC_SEED_ACTION)) {
      const line = text.slice(0, m.index).split('\n').length;
      findings.push(`${file}:${line} forbidden seed invocation: '${m[0]}'`);
    }
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

function loadDocFiles(rootDir) {
  const docs = new Map();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (DOC_EXT_RE.test(ent.name)) {
        docs.set(path.relative(rootDir, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(path.join(rootDir, 'core/shared'));
  walk(path.join(rootDir, 'core/registry'));
  return docs;
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
  assert.ok(files.has('src/release/rehearse.ts'), 'scan must see rehearse.ts');
  assert.ok(files.has('src/runtime/roadmap/rows.ts'), 'scan must see rows.ts');
  for (const f of SEED_ENVELOPE_FILES) assert.ok(files.has(f), `scan must see ${f}`);
  const docs = loadDocFiles(REPO);
  assert.ok(docs.size > 0, 'docs scan must not be vacuous');
  const gates = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));
  const { findings, requirers } = checkSeedPersonOnly({ files, gates, docs });
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

test('G54 person-only green control: unmodified tree has no findings; loop.ts and rehearse.ts seed literals are present but allowed', () => {
  const files = loadSrcFiles(REPO);
  const docs = loadDocFiles(REPO);
  const gates = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));

  const loopText = files.get('src/runtime/roadmap/loop.ts');
  const rehearseText = files.get('src/release/rehearse.ts');
  assert.ok(loopText, 'loop.ts must exist');
  assert.ok(rehearseText, 'rehearse.ts must exist');
  assert.ok(loopText.includes("Unreadable(['seed']"), 'loop.ts must contain Unreadable([\'seed\']');
  assert.ok(rehearseText.includes("'seed'"), 'rehearse.ts must contain \'seed\'');

  assert.deepEqual(scanSeedEnvelope('src/runtime/roadmap/loop.ts', loopText), []);
  assert.deepEqual(scanSeedEnvelope('src/release/rehearse.ts', rehearseText), []);

  const { findings } = checkSeedPersonOnly({ files, gates, docs });
  assert.deepEqual(findings, [], `unmodified real tree must have zero findings:\n${findings.join('\n')}`);
});

test('G54 person-only negative controls: mutating real loop.ts in memory turns guard red across single-line, multi-line, = flag, and constant forms', () => {
  const realFiles = loadSrcFiles(REPO);
  const docs = loadDocFiles(REPO);
  const gates = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));
  const origLoopText = realFiles.get('src/runtime/roadmap/loop.ts');
  assert.ok(origLoopText, 'loop.ts must be loaded');

  assert.deepEqual(scanSeedEnvelope('src/runtime/roadmap/loop.ts', origLoopText), []);
  assert.deepEqual(checkSeedPersonOnly({ files: realFiles, gates, docs }).findings, []);

  const mutations = [
    { label: '(i) single-line', snippet: "const x = ['roadmap', 'seed', '--action', 'apply'];" },
    { label: '(ii) multi-line array', snippet: "const x = [\n  'roadmap',\n  'seed',\n  '--action',\n  'apply',\n];" },
    { label: '(iii) --action=apply form', snippet: "const x = ['roadmap', 'seed', '--action=apply'];" },
    { label: '(iv) constant form', snippet: "const SUB = 'seed';" },
  ];

  for (const { label, snippet } of mutations) {
    const mutatedText = `${origLoopText}\n${snippet}\n`;
    const mutatedFiles = new Map(realFiles);
    mutatedFiles.set('src/runtime/roadmap/loop.ts', mutatedText);

    const envFindings = scanSeedEnvelope('src/runtime/roadmap/loop.ts', mutatedText);
    assert.ok(envFindings.length >= 1, `${label} scanSeedEnvelope must turn red on mutated loop.ts`);

    const { findings } = checkSeedPersonOnly({ files: mutatedFiles, gates, docs });
    assert.ok(findings.length >= 1, `${label} checkSeedPersonOnly must turn red on mutated loop.ts`);
    assert.ok(findings.some((f) => f.startsWith('src/runtime/roadmap/loop.ts:')), `${label} finding must locate loop.ts`);
  }
});

test('G54 person-only negative controls: real rows.ts mutation is red, picker.ts scratch is red, but commented text is green', () => {
  const realFiles = loadSrcFiles(REPO);
  const docs = loadDocFiles(REPO);
  const gates = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));
  const origRowsText = realFiles.get('src/runtime/roadmap/rows.ts');
  assert.ok(origRowsText, 'rows.ts must be loaded');

  // Appending single-line snippet to real rows.ts (outside the old 4-file list)
  const snippet = "const x = ['roadmap', 'seed', '--action', 'apply'];";
  const mutatedRowsText = `${origRowsText}\n${snippet}\n`;
  const mutatedFiles = new Map(realFiles);
  mutatedFiles.set('src/runtime/roadmap/rows.ts', mutatedRowsText);
  const rowsRes = checkSeedPersonOnly({ files: mutatedFiles, gates, docs });
  assert.ok(rowsRes.findings.length >= 1, 'rows.ts mutation must turn guard red');
  assert.ok(rowsRes.findings.some((f) => f.startsWith('src/runtime/roadmap/rows.ts:')), 'finding must name rows.ts');

  // Scratch Map entry src/runtime/picker.ts with multi-line argv
  const multilineArgv = "const x = [\n  'roadmap',\n  'seed',\n  '--action',\n  'apply',\n];\n";
  const pickerFiles = new Map([['src/runtime/picker.ts', multilineArgv]]);
  const pickerRes = checkSeedPersonOnly({ files: pickerFiles, gates, docs });
  assert.ok(pickerRes.findings.length >= 1, 'picker.ts with multi-line argv must turn guard red');
  assert.ok(pickerRes.findings.some((f) => f.startsWith('src/runtime/picker.ts:')));

  // Same text inside // comment is green
  const lineCommented = "// const x = [\n//   'roadmap',\n//   'seed',\n//   '--action',\n//   'apply',\n// ];\n";
  const lineCommentFindings = scanSeedEnvelope('src/runtime/picker.ts', lineCommented);
  assert.deepEqual(lineCommentFindings, [], 'multi-line argv inside // comments must be green');

  // Same text inside /* */ comment is green
  const blockCommented = "/*\nconst x = [\n  'roadmap',\n  'seed',\n  '--action',\n  'apply',\n];\n*/\n";
  const blockCommentFindings = scanSeedEnvelope('src/runtime/picker.ts', blockCommented);
  assert.deepEqual(blockCommentFindings, [], 'multi-line argv inside /* */ comments must be green');
});

test('G54 person-only docs clause: core skills/registry doc scan flags seed --action apply/amend and ignores safe check', () => {
  const gates = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));

  // (1) Scratch SKILL.md containing run roadmap seed --action apply --draft d.json is red
  const applyDocs = new Map([['core/shared/skills/x/SKILL.md', 'run roadmap seed --action apply --draft d.json\n']]);
  const applyRes = checkSeedPersonOnly({ gates, docs: applyDocs });
  assert.ok(applyRes.findings.length >= 1, 'seed --action apply in docs must be red');
  assert.ok(applyRes.findings.some((f) => f.startsWith('core/shared/skills/x/SKILL.md:1')));

  // (2) seed --action=amend is red
  const amendDocs = new Map([['core/shared/skills/x/SKILL.md', 'seed --action=amend\n']]);
  const amendRes = checkSeedPersonOnly({ gates, docs: amendDocs });
  assert.ok(amendRes.findings.length >= 1, 'seed --action=amend in docs must be red');
  assert.ok(amendRes.findings.some((f) => f.startsWith('core/shared/skills/x/SKILL.md:1')));

  // (3) seed --action check is green
  const checkDocs = new Map([['core/shared/skills/x/SKILL.md', 'seed --action check\n']]);
  const checkRes = checkSeedPersonOnly({ gates, docs: checkDocs });
  assert.deepEqual(checkRes.findings, [], 'seed --action check in docs must be green');

  // (4) Real core tree docs is green
  const realDocs = loadDocFiles(REPO);
  assert.ok(realDocs.size > 0, 'real docs must not be empty');
  const realDocsRes = checkSeedPersonOnly({ gates, docs: realDocs });
  assert.deepEqual(realDocsRes.findings, [], `real docs tree must have zero findings:\n${realDocsRes.findings.join('\n')}`);
});

module.exports = {
  checkSeedPersonOnly,
  scanSeedRequirers,
  scanSeedEnvelope,
  scanGatesSeedPredicates,
  checkRoadmapImports,
  scanFileContent,
  checkForbiddenImport,
  stripComments,
  loadDocFiles,
  loadSrcFiles,
};

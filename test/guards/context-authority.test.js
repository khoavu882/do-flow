'use strict';

// G38 — context authority (078 IC-020, DEC-019). Six checks, each a pure function over injected
// file contents (or, for G38.6, injected identity results), run once on the shipped tree and once
// with a negative control that seeds one violation and expects exactly one named finding.
//
//   G38.1 hook code paths start no retrieval, model or advisor, full test run, or index/graph builder
//   G38.2 emission-rules.sh is the generator's output; emission.jq templates are IC-002's
//   G38.3 context-entering output (additionalContext, systemMessage, custom_instructions) only
//         from emission.jq, emission.sh and the three pre-compact hooks, which look the rule up
//   G38.4 last-compact-summary.md appears only in doflow_summary_adopt_legacy (policies/summary-store.sh)
//         and legacySummary (summary-store.ts, DEC-043), and neither side ever writes it
//   G38.5 IC-016's check files reference no emission state and source no emission or summary file
//   G38.6 identity.sh and identity.ts agree on every case of test/fixtures/identity/cases.json
//
// G38.1 and G38.3 read executed text only: shell and jq comments are stripped (RK6), and G38.1
// also blanks any quoted word that contains whitespace, so a verb named inside a message is not an
// invocation, while a quoted runner path such as "$DOFLOW_RUN" still is.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp');
const { buildInstallMirror } = require('../helper/hook-fixtures');

const POLICIES = 'core/harnesses/shared/hooks/policies';
const BRIDGE = 'core/harnesses/shared/hooks/bridge';
const RUNNER_JS = 'core/harnesses/shared/hooks/stream-hook-runner.js';

// ── Tree reading and text views ─────────────────────────────────────────────────────────────────

function readDir(files, rel) {
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) return;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) readDir(files, child);
    else if (entry.isFile()) {
      const buffer = fs.readFileSync(path.join(REPO, child));
      if (!buffer.includes(0)) files.set(child, buffer.toString('utf8'));
    }
  }
}

/** Every shipped text file (package.json `files`: bin/, src/, core/, types/). */
function readShipped() {
  const files = new Map();
  for (const dir of ['bin', 'src', 'core', 'types']) readDir(files, dir);
  return files;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Shell or jq source in two views, both keeping line breaks so line numbers hold:
 * - `code`: comments removed, quotes intact (what G38.3 reads);
 * - `exec`: comments removed, quote marks spaced out, and the content of any quoted word that holds
 *   whitespace blanked (what G38.1 reads). A blanked word directly after `-c` is an inline script,
 *   returned in `scripts` so G38.1 scans it as shell of its own.
 */
function shellViews(text) {
  let code = '';
  let exec = '';
  const scripts = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { code += text.slice(i, i + 2); exec += text.slice(i, i + 2); i += 2; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      const blank = ' '.repeat(stop - i);
      code += blank; exec += blank; i = stop; continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += (ch === '"' && text[j] === '\\') ? 2 : 1;
      const content = text.slice(i + 1, j);
      code += text.slice(i, j + 1);
      if (/\s/.test(content)) {
        if (/(?:^|\s)-c\s*$/.test(exec)) scripts.push({ line: lineOf(text, i), text: content });
        exec += ` ${content.replace(/[^\n]/g, ' ')} `;
      } else {
        exec += ` ${content} `;
      }
      i = j + 1;
      continue;
    }
    code += ch; exec += ch; i += 1;
  }
  return { code: code.split('\n'), exec: exec.split('\n'), scripts };
}

/** JavaScript with `//` and block comments replaced by spaces; strings and line breaks kept. */
function jsCode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i); i = stop; continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    out += ch; i += 1;
  }
  return out;
}

const kindOf = (file) => {
  if (/\.md$/.test(file)) return 'doc';
  if (/\.(?:js|mjs|cjs|ts)$/.test(file)) return 'js';
  if (/\.json$/.test(file)) return 'json';
  return 'shell'; // .sh, .jq, .conf and extensionless scripts share `#` comments
};

/** Comment-free text of one file, line by line, as G38.3 reads it. */
function executedLines(file, text) {
  const kind = kindOf(file);
  if (kind === 'doc') return [];
  if (kind === 'js') return jsCode(text).split('\n');
  if (kind === 'json') return text.split('\n');
  return shellViews(text).code;
}

// ── G38.1: no retrieval, model, full verification or index building on the hook path ───────────

// L2-06: the emission authority and the workflow/decision verbs never run from a hook either; the
// hook path renders through emission.sh, and P1A-W9's last sentence bans the rest.
const G38_1_VERBS = ['retrieve', 'retrieval-plan', 'advise', 'model-role', 'verify', 'recover', 'context-pack',
  'context-emit', 'context-grant', 'orchestrate', 'outcome', 'task-attempt', 'decision', 'decide-gate'];
const BOUNDARY = '(?:^|[\\s;&|(`])';
const END = '(?![\\w-])';
const RUNNER = '(?:\\S*doflow-run|\\$\\{?[A-Za-z_]*(?:DOFLOW|doflow)[A-Za-z_]*\\}?)';
const G38_1_PATTERNS = [
  ['doflow-run verb', new RegExp(`${BOUNDARY}${RUNNER}\\s+(${G38_1_VERBS.join('|')})${END}`)],
  ['model CLI', new RegExp(`${BOUNDARY}(claude\\s+-p|codex\\s+exec|gemini\\s+-p|pi\\s+-p|kiro-cli\\s+chat|ollama)${END}`)],
  ['full test run', new RegExp(`(?:^|[\\s;&|(\`/])(npm\\s+test|npm\\s+run\\s+test|node\\s+--test|pytest|go\\s+test|cargo\\s+test|mvn\\s+test|mvn\\s+verify|gradlew\\s+test|gradlew\\s+check|make\\s+test)${END}`)],
  ['index or graph builder', new RegExp(`${BOUNDARY}(ctags|madge|depcruise)${END}`)],
];

function commandHits(text) {
  const hits = [];
  for (const [label, pattern] of G38_1_PATTERNS) {
    const match = text.match(pattern);
    if (match) hits.push(`${label} \`${match[1].replace(/\s+/g, ' ')}\``);
  }
  return hits;
}

const isG38_1Path = (file) => /^core\/harnesses\/(?:[^/]+\/)*hooks\//.test(file)
  || file.startsWith('core/harnesses/pi/extensions/')
  || file.startsWith('core/harnesses/shared/hooks/adapters/')
  || file === RUNNER_JS;

/** String literals of every child-process call, joined as the command line they would run. */
function jsCalls(text) {
  const code = jsCode(text);
  const calls = [];
  const call = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;
  let match;
  while ((match = call.exec(code))) {
    let depth = 0;
    const literals = [];
    let i = match.index + match[0].length - 1;
    for (; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        let j = i + 1;
        while (j < code.length && code[j] !== ch) j += code[j] === '\\' ? 2 : 1;
        literals.push(code.slice(i + 1, j));
        i = j;
      } else if (ch === '(') depth += 1;
      else if (ch === ')' && --depth === 0) break;
    }
    calls.push({ line: lineOf(code, match.index), text: literals.join(' ') });
  }
  return calls;
}

function jsonCommands(text) {
  const out = [];
  let doc;
  try { doc = JSON.parse(text); } catch { return out; }
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'command' && typeof value === 'string') out.push(value);
      else walk(value);
    }
  }(doc));
  return out.map((command) => {
    const at = text.indexOf(JSON.stringify(command).slice(1, -1));
    return { line: at === -1 ? 1 : lineOf(text, at), text: command };
  });
}

function shellExecHits(text, baseLine = 1) {
  const out = [];
  const views = shellViews(text);
  views.exec.forEach((line, index) => {
    for (const hit of commandHits(line)) out.push({ line: baseLine + index, hit });
  });
  for (const script of views.scripts) out.push(...shellExecHits(script.text, baseLine + script.line - 1));
  return out;
}

function checkG38_1({ files }) {
  const findings = [];
  for (const [file, text] of files) {
    if (!isG38_1Path(file)) continue;
    const kind = kindOf(file);
    let hits = [];
    if (kind === 'shell') hits = shellExecHits(text);
    else if (kind === 'js') hits = jsCalls(text).flatMap((c) => commandHits(c.text).map((hit) => ({ line: c.line, hit })));
    else if (kind === 'json') hits = jsonCommands(text).flatMap((c) => shellExecHits(c.text, c.line));
    for (const { line, hit } of hits) findings.push(`G38.1 ${file}:${line} hook path invokes ${hit}`);
  }
  return findings;
}

// ── G38.2: compiled table and templates ─────────────────────────────────────────────────────────

/** IC-002's templates as they are spelled in jq source (`\(` opens an interpolation). */
const IC002_TEMPLATES = [
  ['git, no capture file', '"Git context unavailable for this session."'],
  ['git, not a repository', '"Not a git repository."'],
  ['git header', '"Git context — branch: \\('],
  ['git sha separator', ') | \\('],
  ['git commits', '"Last commits: \\('],
  ['git commit join', 'join(" · ")'],
  ['git no commits', '"none"'],
  ['git uncommitted', '"Uncommitted files: \\('],
  ['git stash', '" | Stashed: \\($stash)"'],
  ['summary header', '"\\n\\n[Prior session summary\\('],
  ['summary truncation', '"\\n[summary truncated: first \\(summary_cap) of \\('],
  ['summary truncation lower bound', '"at least "'],
  ['summary truncation tail', '\\($n) characters]"'],
  ['header compacted_at', '", compacted \\($at)"'],
  ['header branch', '" on branch \\($branch)"'],
  ['warning', '"\\n[Prior session warning: \\('],
  ['grant', '"[Granted summary from lineage \\('],
  ['pointer', '"[Granted summary \\(.fields.summary_id // "") withheld: \\(.body | utf8bytelength) bytes exceed the \\($max)-byte context budget]"'],
  ['join order', 'def join_order: ["git", "summary", "warning", "grant", "nudge"];'],
  ['optional fill priority', 'reduce ("git", "summary", "warning", "nudge") as $s'],
];

function tableConstant(table, name) {
  const match = table.match(new RegExp(`^${name}=(\\d+)$`, 'm'));
  return match ? Number(match[1]) : null;
}

/** `generated` is the generator's output (compileEmissionTable()); `files` holds the committed sources. */
function checkG38_2({ files, generated }) {
  const findings = [];
  const tableFile = `${POLICIES}/emission-rules.sh`;
  const jqFile = `${POLICIES}/emission.jq`;
  const table = files.get(tableFile);
  if (table === undefined) findings.push(`G38.2 ${tableFile}:1 compiled table is missing`);
  else if (table !== generated) {
    const a = table.split('\n');
    const b = generated.split('\n');
    let line = 0;
    while (line < Math.max(a.length, b.length) && a[line] === b[line]) line += 1;
    findings.push(`G38.2 ${tableFile}:${line + 1} differs from the generator's output (run node src/runtime/context/emission-rules.ts --write)`);
  }
  const jq = files.get(jqFile);
  if (jq === undefined) return [...findings, `G38.2 ${jqFile}:1 renderer is missing`];
  for (const [name, fragment] of IC002_TEMPLATES) {
    if (!jq.includes(fragment)) findings.push(`G38.2 ${jqFile}:1 template "${name}" differs from IC-002 (expected ${fragment})`);
  }
  for (const [def, constant] of [['summary_cap', 'DF_RULES_SUMMARY_CAP'], ['summary_read', 'DF_RULES_SUMMARY_READ']]) {
    const match = jq.match(new RegExp(`^def ${def}: (\\d+);$`, 'm'));
    const want = tableConstant(generated, constant);
    if (!match || Number(match[1]) !== want) {
      const line = match ? lineOf(jq, match.index) : 1;
      findings.push(`G38.2 ${jqFile}:${line} ${def} is ${match ? match[1] : 'undefined'}, the rules give ${constant}=${want}`);
    }
  }
  return findings;
}

// ── G38.3: context-entering output only through the table and adapter ───────────────────────────

const PRE_COMPACT_HOOKS = [
  'core/harnesses/claude/hooks/pre-compact.sh',
  'core/harnesses/codex/hooks/pre-compact.impl.sh',
  'core/harnesses/gemini/hooks/pre-compact.sh',
];
const G38_3_ALLOWED = new Set([`${POLICIES}/emission.jq`, `${POLICIES}/emission.sh`, ...PRE_COMPACT_HOOKS]);
const CONTEXT_TOKEN = /\b(additionalContext|systemMessage|custom_instructions)\b/;
const PRINT = /^\s*(?:printf|echo|cat|jq)\b/;
const LOOKUP = /\bdoflow_emission_rule\s+compact-instructions\./;

const isHookFile = (file) => /^core\/harnesses\/(?:[^/]+\/)*hooks\//.test(file)
  || file.startsWith('core/harnesses/pi/extensions/') || file === RUNNER_JS;

function checkG38_3({ files }) {
  const findings = [];
  for (const [file, text] of files) {
    if (!isHookFile(file) || G38_3_ALLOWED.has(file)) continue;
    executedLines(file, text).forEach((line, index) => {
      const match = line.match(CONTEXT_TOKEN);
      if (match) findings.push(`G38.3 ${file}:${index + 1} emits ${match[1]} outside the emission table and adapter`);
    });
  }
  for (const file of PRE_COMPACT_HOOKS) {
    const text = files.get(file);
    if (text === undefined) continue;
    const lines = executedLines(file, text);
    const lookup = lines.findIndex((line) => LOOKUP.test(line));
    const print = lines.findIndex((line) => PRINT.test(line));
    if (print !== -1 && (lookup === -1 || lookup > print)) {
      findings.push(`G38.3 ${file}:${print + 1} pre-compact hook prints without a compact-instructions lookup`);
    }
  }
  return findings;
}

// L2-10: Kiro's agentSpawn front door enters context through stdout if it prints anything at all,
// so it is run, from an install mirror, against its fault-free fixture, and must print nothing.
const KIRO_DOOR = '.kiro/hooks/session-start.sh';
const KIRO_FIXTURE = 'test/fixtures/hooks/kiro/session-start/agent-perf.json';

/** stdout and status of the mirrored Kiro session-start door fed the fixture's native payload. */
function kiroDoorRun(root) {
  const { native } = JSON.parse(fs.readFileSync(path.join(REPO, KIRO_FIXTURE), 'utf8'));
  const r = spawnSync(BASH, [path.join(root, KIRO_DOOR)], {
    cwd: root, input: JSON.stringify(native), encoding: 'utf8',
    env: { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg'), DOFLOW_PROJECT_DIR: root,
      DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_AGENT: '', DOFLOW_RUN_ID: '', DOFLOW_LINEAGE_ID: '', DOFLOW_ATTEMPT: '', DOFLOW_SESSION_ROLE: '' },
  });
  return { status: r.status, stdout: r.stdout };
}

function checkG38_3Kiro({ status, stdout }) {
  if (status !== 0) return [`G38.3 core/harnesses/kiro/hooks/session-start.sh: agentSpawn fixture exited ${status}`];
  if (stdout !== '') return [`G38.3 core/harnesses/kiro/hooks/session-start.sh: agentSpawn wrote ${Buffer.byteLength(stdout)} byte(s) to stdout`];
  return [];
}

// ── G38.4: the legacy summary name ──────────────────────────────────────────────────────────────

const LEGACY = 'last-compact-summary.md';
const STORE = `${POLICIES}/summary-store.sh`;
/** DEC-043's TypeScript port: the name may appear in legacySummary() only, and nothing there writes it. */
const TS_STORE = 'src/runtime/context/summary-store.ts';
const TS_HOLDER_FN = 'legacySummary';
/** JavaScript write calls and the argument that names their destination. */
const JS_WRITES = { writeFileSync: 0, appendFileSync: 0, writeFile: 0, appendFile: 0, renameSync: 1, linkSync: 1, copyFileSync: 1, symlinkSync: 1 };

function functionRange(lines, name) {
  const start = lines.findIndex((line) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return [start, end === -1 ? lines.length - 1 : end];
}

/** A top-level `function <name>(` in JavaScript or TypeScript, to the next column-0 `}`. */
function jsFunctionRange(lines, name) {
  const start = lines.findIndex((line) => new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return [start, end === -1 ? lines.length - 1 : end];
}

/** Each write call in comment-free JavaScript, with its destination argument's source text. */
function jsWriteCalls(code) {
  const out = [];
  const call = new RegExp(`\\b(${Object.keys(JS_WRITES).join('|')})\\s*\\(`, 'g');
  let match;
  while ((match = call.exec(code))) {
    const args = [];
    let depth = 1;
    let current = '';
    let i = match.index + match[0].length;
    for (; i < code.length && depth > 0; i += 1) {
      const ch = code[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        let j = i + 1;
        while (j < code.length && code[j] !== ch) j += code[j] === '\\' ? 2 : 1;
        current += code.slice(i, j + 1);
        i = j;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      if (depth === 0) break;
      if (ch === ',' && depth === 1) { args.push(current.trim()); current = ''; } else current += ch;
    }
    args.push(current.trim());
    out.push({ line: lineOf(code, match.index), fn: match[1], dest: args[JS_WRITES[match[1]]] ?? '' });
  }
  return out;
}

function checkG38_4TS(files) {
  const findings = [];
  const text = files.get(TS_STORE);
  if (text === undefined) return findings;
  const code = jsCode(text);
  const lines = code.split('\n');
  const range = jsFunctionRange(lines, TS_HOLDER_FN);
  const holders = new Set();
  lines.forEach((line, index) => {
    const names = line.includes(LEGACY);
    if (names && (!range || index < range[0] || index > range[1])) {
      findings.push(`G38.4 ${TS_STORE}:${index + 1} names ${LEGACY} outside ${TS_HOLDER_FN}`);
    }
    // A variable holding the legacy path: assigned on a line that names it, or from legacySummary().
    const assigned = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
    if (assigned && (names || new RegExp(`\\b${TS_HOLDER_FN}\\s*\\(`).test(line))) holders.add(assigned[1]);
  });
  const isLegacy = (dest) => dest.includes(LEGACY) || holders.has(dest);
  for (const { line, fn, dest } of jsWriteCalls(code)) {
    if (isLegacy(dest)) findings.push(`G38.4 ${TS_STORE}:${line} writes ${LEGACY} (${fn} to \`${dest}\`)`);
  }
  return findings;
}

function checkG38_4({ files }) {
  const findings = [];
  for (const [file, text] of files) {
    if (file === STORE || file === TS_STORE || !text.includes(LEGACY)) continue;
    text.split('\n').forEach((line, index) => {
      if (line.includes(LEGACY)) findings.push(`G38.4 ${file}:${index + 1} names ${LEGACY} outside ${STORE} and ${TS_STORE}`);
    });
  }
  findings.push(...checkG38_4TS(files));
  const store = files.get(STORE);
  if (store === undefined) return findings;
  const lines = store.split('\n');
  const range = functionRange(lines, 'doflow_summary_adopt_legacy');
  const holders = new Set();
  lines.forEach((line, index) => {
    if (!line.includes(LEGACY)) return;
    if (!range || index < range[0] || index > range[1]) {
      findings.push(`G38.4 ${STORE}:${index + 1} names ${LEGACY} outside doflow_summary_adopt_legacy`);
    }
    const assigned = line.match(/\b([A-Za-z_]\w*)=/);
    if (assigned) holders.add(assigned[1]);
  });
  const target = `(?:"?\\$\\{?(?:${[...holders].join('|') || '\\b\\B'})\\}?"?|\\S*${LEGACY.replace(/\./g, '\\.')}"?)`;
  const writes = [
    new RegExp(`>>?\\s*${target}(?:\\s|;|$)`),
    new RegExp(`\\b(?:touch|tee(?:\\s+-a)?)\\s+${target}`),
    new RegExp(`\\b(?:cp|mv|ln|install)\\b[^;|&]*\\s${target}\\s*(?:[;|&)]|2>|$)`),
  ];
  shellViews(store).code.forEach((line, index) => {
    if (writes.some((pattern) => pattern.test(line))) findings.push(`G38.4 ${STORE}:${index + 1} writes ${LEGACY}`);
  });
  return findings;
}

// ── G38.5: checks are never deduplicated ────────────────────────────────────────────────────────

const IC016_FILES = [
  `${POLICIES}/pre-implementation-gate.sh`, `${POLICIES}/pre-bash-guard.sh`, `${POLICIES}/mcp-tool-guard.sh`,
  `${POLICIES}/stop-check.sh`, `${BRIDGE}/bridge.sh`, `${BRIDGE}/envelope.jq`, `${BRIDGE}/respond.sh`, RUNNER_JS,
];
const FORBIDDEN_SOURCES = new Set(['emission.sh', 'emission-rules.sh', 'summary-store.sh']);
const STATE_TOKEN = /(?<![\w])(emission|emitted|injected|bound|summary-store)(?![\w])/;
const CORRELATION = /\b(?:tool_use_id|toolUseId|toolCallId|tool_call_id|call_id|correlation\w*)\b/;
const FS_OP = /(?:>>?\s*["$]|\btouch\b|\bmkdir\b|\bwriteFile|\bappendFile|\breadFile|\bexistsSync|\[\s+-[efsL]\s)/;
const SOURCE_LINE = /^\s*(?:\.|source)\s+"?[^"\s]*?([\w.-]+\.sh)"?/;

/** The files `file` sources, transitively, resolved by name inside policies/ and bridge/. */
function sourcedClosure(files, file) {
  const seen = new Set();
  const stack = [file];
  while (stack.length) {
    const current = stack.pop();
    const text = files.get(current);
    if (text === undefined) continue;
    for (const line of shellViews(text).code) {
      const match = line.match(SOURCE_LINE);
      if (!match || seen.has(match[1])) continue;
      seen.add(match[1]);
      for (const dir of [POLICIES, BRIDGE]) {
        if (files.has(`${dir}/${match[1]}`)) stack.push(`${dir}/${match[1]}`);
      }
    }
  }
  return seen;
}

function checkG38_5({ files }) {
  const findings = [];
  for (const file of IC016_FILES) {
    const text = files.get(file);
    if (text === undefined) continue;
    text.split('\n').forEach((line, index) => {
      const token = line.match(STATE_TOKEN);
      if (token) findings.push(`G38.5 ${file}:${index + 1} references emission state \`${token[1]}\``);
      else if (CORRELATION.test(line) && FS_OP.test(line)) findings.push(`G38.5 ${file}:${index + 1} keeps a correlation-keyed cache`);
    });
    const closure = sourcedClosure(files, file);
    for (const name of FORBIDDEN_SOURCES) {
      if (!closure.has(name)) continue;
      const line = shellViews(text).code.findIndex((l) => SOURCE_LINE.test(l));
      findings.push(`G38.5 ${file}:${line + 1} sources ${name}${text.includes(name) ? '' : ' transitively'}`);
    }
  }
  return findings;
}

// ── G38.6: bash and TypeScript identity agree ───────────────────────────────────────────────────

const CASES_REL = 'test/fixtures/identity/cases.json';
const CASES = JSON.parse(fs.readFileSync(path.join(REPO, CASES_REL), 'utf8'));
const FIELDS = ['RUN', 'ATTEMPT', 'LINEAGE', 'ROLE', 'WORKTREE', 'KIND', 'UNIT'];
const BASH = process.platform === 'darwin' ? '/bin/bash' : 'bash';
const UNKNOWN_ROLE = '[doflow] unknown DOFLOW_SESSION_ROLE; treating session as worker\n';
const IDENTITY_VARS = ['DOFLOW_RUN_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_LINEAGE_ID', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'];

/** `bash` and `ts` map an event key (case name, or `sequence #event`) to one result object. */
function checkG38_6({ keys, bash, ts }) {
  const findings = [];
  for (const key of keys) {
    const a = JSON.stringify(bash.get(key) ?? null);
    const b = JSON.stringify(ts.get(key) ?? null);
    if (a !== b) findings.push(`G38.6 ${CASES_REL}: "${key}" identity.sh ${a} vs identity.ts ${b}`);
  }
  return findings;
}

function identityLayout(root) {
  const places = { $CWD: path.join(root, 'cwd'), $WT: path.join(root, 'wt'), $WT_LINK: path.join(root, 'wt-link'), $FILE: path.join(root, 'file.txt') };
  fs.mkdirSync(places.$CWD);
  fs.mkdirSync(places.$WT);
  fs.symlinkSync(places.$WT, places.$WT_LINK);
  fs.writeFileSync(places.$FILE, 'x\n');
  return places;
}
const subst = (value, places) => (typeof value === 'string' ? value.replace(/\$(CWD|WT_LINK|WT|FILE)/g, (m) => places[m]) : value);
const substEnv = (env, places) => Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, subst(v, places)]));

/** Every bound file under the store's sessions/, by unit, trailing newline dropped; read through a link. */
function boundFiles(config) {
  const sessions = path.join(config, 'doflow', 'session-env', 'sessions');
  if (!fs.existsSync(sessions)) return {};
  if (!fs.statSync(sessions).isDirectory()) return { '(sessions)': 'not a directory' };
  const out = {};
  for (const unit of fs.readdirSync(sessions).sort()) {
    const file = path.join(sessions, unit, 'bound');
    if (fs.existsSync(file)) out[unit] = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
  }
  return out;
}

/**
 * The DEC-044 store setups a binding event may name, as test/hooks/identity-bash.test.js and
 * test/runtime/context-identity.test.js apply them: `store-unwritable` makes sessions/ a regular
 * file, `bound-symlink` makes the event unit's bound a link to a file holding the event's session
 * id, `bound-empty` makes it an empty regular file. `root` holds the link target, outside the store.
 */
function applySetup(setup, config, root, unit, sessionId) {
  if (setup === undefined) return;
  const sessions = path.join(config, 'doflow', 'session-env', 'sessions');
  const bound = path.join(sessions, unit, 'bound');
  if (setup === 'store-unwritable') {
    fs.mkdirSync(path.dirname(sessions), { recursive: true });
    fs.writeFileSync(sessions, '');
  } else if (setup === 'bound-symlink') {
    const target = path.join(root, `bound-target-${unit}`);
    fs.writeFileSync(target, `${sessionId}\n`);
    fs.mkdirSync(path.dirname(bound), { recursive: true });
    fs.symlinkSync(target, bound);
  } else if (setup === 'bound-empty') {
    fs.mkdirSync(path.dirname(bound), { recursive: true });
    fs.writeFileSync(bound, '');
  } else {
    throw new Error(`unknown binding setup ${setup}`);
  }
}

function bashEvent(config, home, env, sessionId, cwd) {
  const events = path.join(config, 'doflow', 'failures', 'events.jsonl');
  const read = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).kind) : []);
  const before = read().length;
  const print = FIELDS.map((f) => `printf '%s=%s\\n' ${f} "$DF_ID_${f}"`).join('\n');
  const script = `set -euo pipefail\n. "${path.join(REPO, POLICIES, 'identity.sh')}"\ndoflow_identity "$1" "$2"\n${print}`;
  const clear = Object.fromEntries([...IDENTITY_VARS, 'DOFLOW_FAILURE_CAPTURE'].map((k) => [k, '']));
  const r = spawnSync(BASH, ['-c', script, 'user-prompt-submit.sh', sessionId, cwd], {
    env: { ...process.env, ...clear, HOME: home, XDG_CONFIG_HOME: config, SESSION_DIR: '', ...env }, encoding: 'utf8',
  });
  const id = { status: r.status };
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const at = line.indexOf('=');
    id[line.slice(0, at).toLowerCase()] = line.slice(at + 1);
  }
  const codes = new Set(read().slice(before));
  if (r.stderr === UNKNOWN_ROLE) codes.add('role-unknown');
  else if (r.stderr !== '') codes.add(`stderr:${r.stderr.trim()}`);
  return { ...id, diagnostics: [...codes].sort(), bound: boundFiles(config) };
}

function tsEvent(resolveIdentity, config, home, env, sessionId, cwd) {
  const full = { HOME: home, XDG_CONFIG_HOME: config, ...env };
  const id = resolveIdentity(full, { cwd, sessionId, bind: true, warn: () => {} });
  return {
    status: 0, run: id.run, attempt: id.attempt, lineage: id.lineage, role: id.role, worktree: id.worktree,
    kind: id.lineageKind, unit: id.unitId, diagnostics: [...id.diagnostics].sort(), bound: boundFiles(config),
  };
}

/**
 * Runs both implementations over cases.json; each sequence (or case) gets one fresh store per side,
 * and an event's `setup` is applied to that side's store just before the event. `skipSetup` names a
 * side whose setups are left out, for the control that shows G38.6 reaches those states.
 */
function identityResults(root, { skipSetup = null } = {}) {
  const { resolveIdentity } = require('../../src/runtime/context/identity.ts');
  const places = identityLayout(root);
  const keys = [];
  const bash = new Map();
  const ts = new Map();
  let n = 0;
  const sequences = [
    ...CASES.identity.map((c) => ({ name: c.name, env: {}, events: [c], single: true })),
    ...CASES.binding,
  ];
  for (const s of sequences) {
    const stores = ['bash', 'ts'].map((side) => {
      const base = path.join(root, `${side}-${n}`);
      const config = path.join(base, 'config');
      const home = path.join(base, 'home');
      fs.mkdirSync(config, { recursive: true });
      fs.mkdirSync(home);
      return { side, base, config, home };
    });
    n += 1;
    s.events.forEach((e, i) => {
      const key = s.single ? s.name : `${s.name} #${i}`;
      const env = { ...substEnv(s.env, places), ...substEnv(e.env, places) };
      const cwd = subst(e.cwd, places);
      const unit = `L.${env.DOFLOW_RUN_ID}.${env.DOFLOW_LINEAGE_ID}.${env.DOFLOW_ATTEMPT}`;
      for (const store of stores) {
        if (!s.single && store.side !== skipSetup) applySetup(e.setup, store.config, store.base, unit, e.sessionId);
      }
      keys.push(key);
      bash.set(key, bashEvent(stores[0].config, stores[0].home, env, e.sessionId, cwd));
      ts.set(key, tsEvent(resolveIdentity, stores[1].config, stores[1].home, env, e.sessionId, cwd));
    });
  }
  return { keys, bash, ts };
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

const shipped = readShipped();
const withFile = (file, text) => new Map([...shipped, [file, text]]);
const edit = (file, from, to) => {
  const text = shipped.get(file);
  assert.ok(text.includes(from), `control anchor missing in ${file}: ${from}`);
  return withFile(file, text.replace(from, to));
};
const one = (findings, needle) => {
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.ok(findings[0].includes(needle), findings[0]);
};

test('G38.1: hook code paths invoke no retrieval, model, advisor, full test run or index builder', () => {
  assert.deepEqual(checkG38_1({ files: shipped }), []);
});
test('G38.1 control: a forbidden verb beside the stop-check leak scan is one finding; the leak scan and spotless are not', () => {
  const file = `${POLICIES}/stop-check.sh`;
  const anchor = 'leak_out="$(run_with_timeout 2 -- "$DOFLOW_RUN" leak-scan';
  const seeded = edit(file, anchor, `"$DOFLOW_RUN" verify --task-id x >/dev/null\n${anchor}`);
  const line = seeded.get(file).split('\n').findIndex((l) => l.includes('" verify --task-id')) + 1;
  one(checkG38_1({ files: seeded }), `${file}:${line} hook path invokes doflow-run verb \`verify\``);
});
test('G38.1 control: an index builder in the edit linter is one finding; the linter itself is not', () => {
  const file = 'core/harnesses/claude/hooks/post-edit-lint.sh';
  const seeded = withFile(file, `${shipped.get(file)}\nnpx madge --circular src >/dev/null 2>&1 || true\n`);
  one(checkG38_1({ files: seeded }), 'index or graph builder `madge`');
});
test('G38.1 control: model and test invocations from JavaScript and inline bash scripts are named', () => {
  one(checkG38_1({ files: withFile(RUNNER_JS, `${shipped.get(RUNNER_JS)}\nspawnSync('npm', ['test']);\n`) }), 'full test run `npm test`');
  one(checkG38_1({ files: withFile('core/harnesses/demo/hooks/x.sh', "bash -c 'claude -p \"summarise\"'\n") }), 'model CLI `claude -p`');
});
test('G38.1 control (L2-06): the emission authority and workflow verbs on a hook line are one finding each', () => {
  const file = 'core/harnesses/demo/hooks/x.sh';
  one(checkG38_1({ files: withFile(file, '"$DOFLOW" context-emit --event prompt\n') }), `${file}:1 hook path invokes doflow-run verb \`context-emit\``);
  one(checkG38_1({ files: withFile(file, 'doflow-run orchestrate --action handoff\n') }), `${file}:1 hook path invokes doflow-run verb \`orchestrate\``);
  for (const verb of ['context-grant', 'outcome', 'task-attempt', 'decision', 'decide-gate']) {
    one(checkG38_1({ files: withFile(file, `"$DOFLOW_RUN" ${verb} --json >/dev/null\n`) }), `verb \`${verb}\``);
  }
});
test('G38.1 control: verbs named inside messages, comments and quoted words with spaces do not count', () => {
  const text = [
    '# then run doflow-run verify, npm test and claude -p',
    'next="doflow-run verify --task-id x"',
    "echo 'run ollama or pytest yourself'",
    'reason="details: doflow-run recover"',
  ].join('\n');
  assert.deepEqual(checkG38_1({ files: withFile('core/harnesses/demo/hooks/x.sh', `${text}\n`) }), []);
});

test('G38.2: emission-rules.ts --check passes', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'src/runtime/context/emission-rules.ts'), '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
test('G38.2: the compiled table is the generator output and emission.jq carries IC-002 templates', () => {
  const { compileEmissionTable } = require('../../src/runtime/context/emission-rules.ts');
  assert.deepEqual(checkG38_2({ files: shipped, generated: compileEmissionTable() }), []);
});
test('G38.2 control: a hand-edited arm is one finding naming its line', () => {
  const { compileEmissionTable } = require('../../src/runtime/context/emission-rules.ts');
  const file = `${POLICIES}/emission-rules.sh`;
  const seeded = edit(file, "'prompt.git|main:false') DF_ACTION=include", "'prompt.git|main:false') DF_ACTION=skip");
  const line = seeded.get(file).split('\n').findIndex((l) => l.includes("'prompt.git|main:false') DF_ACTION=skip")) + 1;
  one(checkG38_2({ files: seeded, generated: compileEmissionTable() }), `${file}:${line} differs from the generator's output`);
});
test('G38.2 control: a template drifting from IC-002 is one finding naming the template', () => {
  const { compileEmissionTable } = require('../../src/runtime/context/emission-rules.ts');
  const seeded = edit(`${POLICIES}/emission.jq`, '-byte context budget]', '-byte budget]');
  one(checkG38_2({ files: seeded, generated: compileEmissionTable() }), 'template "pointer" differs from IC-002');
});

test('G38.3: context-entering output goes only through the emission table and adapter', () => {
  assert.deepEqual(checkG38_3({ files: shipped }), []);
});
test('G38.3 control: a hook printing systemMessage on its own is one finding', () => {
  const file = 'core/harnesses/claude/hooks/session-start.sh';
  const seeded = withFile(file, `${shipped.get(file)}\njq -n --arg m x '{systemMessage: $m}'\n`);
  one(checkG38_3({ files: seeded }), `${file}:${seeded.get(file).split('\n').length - 1} emits systemMessage`);
});
test('G38.3 control: a pre-compact hook that prints without its rule lookup is one finding', () => {
  const file = 'core/harnesses/claude/hooks/pre-compact.sh';
  const seeded = edit(file, '  doflow_emission_rule compact-instructions.instructions "$_DF_ROLE"\n', '  :\n');
  one(checkG38_3({ files: seeded }), `${file}:`);
  assert.ok(checkG38_3({ files: seeded })[0].includes('prints without a compact-instructions lookup'));
});
test('G38.3 control (RK6): comment-only mentions pass, including codex/hooks/pre-compact.sh:4-5', () => {
  const codex = shipped.get('core/harnesses/codex/hooks/pre-compact.sh').split('\n');
  assert.match(codex.slice(3, 5).join('\n'), /systemMessage[\s\S]*additionalContext/);
  const file = 'core/harnesses/claude/hooks/session-start.sh';
  const seeded = withFile(file, `${shipped.get(file)}\n# never prints additionalContext, systemMessage or custom_instructions\n  # indented: additionalContext\n`);
  assert.deepEqual(checkG38_3({ files: seeded }), []);
});

test('G38.3 (L2-10): Kiro agentSpawn front door, and what it sources, writes nothing to stdout', (t) => {
  const root = buildInstallMirror(tempDir(t, 'doflow-g38-kiro-'));
  assert.deepEqual(checkG38_3Kiro(kiroDoorRun(root)), []);
});
test('G38.3 control (L2-10): a mirrored Kiro door that prints one byte is one finding', (t) => {
  const root = buildInstallMirror(tempDir(t, 'doflow-g38-kiro-print-'));
  const door = path.join(root, KIRO_DOOR);
  fs.appendFileSync(door, 'printf x\n');
  one(checkG38_3Kiro(kiroDoorRun(root)), 'agentSpawn wrote 1 byte(s) to stdout');
});
test('G38.3 control (L2-10): a print in the sourced lib.sh is one finding too', (t) => {
  const root = buildInstallMirror(tempDir(t, 'doflow-g38-kiro-lib-'));
  fs.appendFileSync(path.join(root, '.kiro/hooks/lib.sh'), '\nprintf x\n');
  one(checkG38_3Kiro(kiroDoorRun(root)), 'agentSpawn wrote 1 byte(s) to stdout');
});

test('G38.4: last-compact-summary.md is named only by the two adoption functions, and neither writes it', () => {
  assert.deepEqual(checkG38_4({ files: shipped }), []);
});
// The controls count findings the seed adds to the shipped tree's own, so each still reads as one
// finding while a shipped finding is open (each seed keeps the line numbers of the file it edits
// or edits a file other than the shipped finding's).
const fresh4 = (files) => {
  const base = new Set(checkG38_4({ files: shipped }));
  return checkG38_4({ files }).filter((f) => !base.has(f));
};
test('G38.4 control: a write to the legacy path is one finding', () => {
  const seeded = edit(STORE, '  [ -f "$old" ] && [ ! -L "$old" ] || return 1\n', '  [ -f "$old" ] && [ ! -L "$old" ] || return 1\n  : > "$old"\n');
  one(fresh4(seeded), `${STORE}:`);
  assert.ok(fresh4(seeded)[0].includes(`writes ${'last-compact-summary.md'}`));
});
test('G38.4 control: the name in another shipped file is one finding', () => {
  const seeded = withFile('src/runtime/context/demo.ts', "const legacy = 'last-compact-summary.md';\n");
  one(fresh4(seeded), 'src/runtime/context/demo.ts:1 names last-compact-summary.md');
});
test('G38.4 control: a TypeScript write to the legacy path is one finding naming the call', () => {
  const anchor = '  return regularFile(old) ? old : null;';
  const seeded = edit(TS_STORE, anchor, `  fs.writeFileSync(old, ''); ${anchor.trim()}`);
  const line = seeded.get(TS_STORE).split('\n').findIndex((l) => l.includes("fs.writeFileSync(old, '')")) + 1;
  one(fresh4(seeded), `${TS_STORE}:${line} writes last-compact-summary.md (writeFileSync to \`old\`)`);
});
test('G38.4 control: the name in summary-store.ts outside legacySummary is one finding', () => {
  const anchor = '  if (old === null) return false;';
  const seeded = edit(TS_STORE, anchor, "  if (old === null || !old.endsWith('last-compact-summary.md')) return false;");
  const line = seeded.get(TS_STORE).split('\n').findIndex((l) => l.includes("endsWith('last-compact")) + 1;
  one(fresh4(seeded), `${TS_STORE}:${line} names last-compact-summary.md outside legacySummary`);
});
test('G38.4 control: renameSync and linkSync onto the legacy path are findings; reading or renaming from it is not', () => {
  const text = [
    "const old = path.join(dir, 'last-compact-summary.md');",
    'fs.renameSync(old, other);',
    'fs.readFileSync(old);',
    'fs.renameSync(path.join(a, b), old);',
    "fs.linkSync(src, path.join(dir, 'last-compact-summary.md'));",
  ].join('\n');
  const files = new Map([[TS_STORE, `function legacySummary() {\n${text}\n}\n`]]);
  assert.deepEqual(checkG38_4({ files }).map((f) => f.replace(/ \(.*$/, '')), [
    `G38.4 ${TS_STORE}:5 writes last-compact-summary.md`,
    `G38.4 ${TS_STORE}:6 writes last-compact-summary.md`,
  ]);
});

test('G38.5: IC-016 check files reference no emission state and source no emission or summary file', () => {
  assert.deepEqual(checkG38_5({ files: shipped }), []);
});
test('G38.5 control: a gate reading the injected token is one finding', () => {
  const file = `${POLICIES}/pre-bash-guard.sh`;
  const seeded = withFile(file, `${shipped.get(file)}\n[ -e "$STATE_DIR/sessions/$sid/injected" ] && exit 0\n`);
  one(checkG38_5({ files: seeded }), 'references emission state `injected`');
});
test('G38.5 control: a check that sources summary-store.sh through a helper is one finding', () => {
  const seeded = withFile(`${POLICIES}/contract.sh`, `${shipped.get(`${POLICIES}/contract.sh`)}\n. "$_DOFLOW_POLDIR/summary-store.sh"\n`);
  const findings = checkG38_5({ files: seeded }).filter((f) => f.includes('stop-check.sh'));
  one(findings, 'sources summary-store.sh transitively');
});

test('G38.6: identity.sh and identity.ts agree on every case of cases.json', (t) => {
  const { keys, bash, ts } = identityResults(tempDir(t, 'doflow-g38-identity-'));
  assert.equal(keys.length, CASES.identity.length + CASES.binding.reduce((n, s) => n + s.events.length, 0));
  assert.deepEqual(checkG38_6({ keys, bash, ts }), []);
});
test('G38.6 control: one disagreeing field is one finding naming the case', () => {
  const key = CASES.identity[0].name;
  const a = new Map([[key, { kind: 'default-main' }], ['other', { kind: 'solo' }]]);
  const b = new Map([[key, { kind: 'solo' }], ['other', { kind: 'solo' }]]);
  one(checkG38_6({ keys: [key, 'other'], bash: a, ts: b }), `"${key}" identity.sh`);
});
test('G38.6 control: a store setup applied on one side only is a finding for each DEC-044 setup case', (t) => {
  const setupKeys = CASES.binding.flatMap((s) => s.events.map((e, i) => (e.setup ? `${s.name} #${i}` : null))).filter(Boolean);
  assert.equal(setupKeys.length, 3, 'cases.json pins store-unwritable, bound-symlink and bound-empty');
  const { keys, bash, ts } = identityResults(tempDir(t, 'doflow-g38-identity-skew-'), { skipSetup: 'ts' });
  const findings = checkG38_6({ keys, bash, ts });
  assert.deepEqual(findings.map((f) => f.match(/: "(.*)" identity\.sh/)[1]), setupKeys, findings.join('\n'));
});

module.exports = { checkG38_1, checkG38_2, checkG38_3, checkG38_4, checkG38_5, checkG38_6 };

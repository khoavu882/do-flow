'use strict';

// G64 — agent roster cap and description budget (feature 118, IC-002 / IC-007, FR-004, FR-012).
//
// Every agent spec's `description` is loaded into the main session's context on every harness that
// lists agents, so the roster is a standing context cost. This guard caps it: at most 7 specs, each
// description at most 160 characters, all descriptions together at most 1,000, and every spec
// declares `access` (`read-only` or `write`, IC-002). Raising a cap is a deliberate edit to this
// file, never a side effect of adding a spec.
//
// 118 C.1 design amendment: a spec is standalone, usable in a project without DoFlow, so no spec
// names a DoFlow runtime verb, state path or record (STANDALONE_TOKENS) outside the one line that
// lets a workflow's stage brief override the spec (HOOK_LINE). The procedure lives in the skills.
// The scan covers the shared specs (*.md) and the Codex agent TOMLs, and rejects a `doflow <verb>` /
// `doflow-run <verb>` command (verbs derived from the CLI Commands list and the dispatcher table, so
// the list cannot go stale), a trailer line (DoFlow-Row, Co-Authored-By), and the chain artifacts design.md / plan.md /
// requirement.md, /do-* skills and "DoFlow chain". core-implementer.md alone keeps its DoFlow-optional
// wording through EXCEPTIONS: exact lines, and a listed line that no longer exists fails the guard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { execFileSync } = require('node:child_process');
const { agentSpecFiles, AGENT_SPECS, REPO, dispatcherVerbs } = require('./_shared');

const MAX_SPECS = 7;
const MAX_DESCRIPTION = 160;
const MAX_TOTAL = 1000;
const ACCESS_VALUES = ['read-only', 'write'];
const CODEX_AGENTS = path.join(REPO, 'core', 'harnesses', 'codex', 'agents');
const STANDALONE_TOKENS = [
  'doflow-run', '.doflow/', 'task-attempt', 'readiness', 'orchestrate', 'findings.json',
  'doflow-row', 'co-authored-by', 'trailer', 'design.md', 'plan.md', 'requirement.md', 'doflow chain',
  'agent-docs/',
];
const SKILL_COMMAND = /(?:^|[\s`(])(\/do-[a-z][a-z-]*)/;
// file -> exact (trimmed) lines allowed to trip a pattern: core-implementer's DoFlow-optional wording.
const EXCEPTIONS = new Map([
  ['core-implementer.md', [
    "- Precision implementation against whatever spec it's given — a `design.md` contract and `plan.md`",
    'task when dispatched inside a DoFlow chain, or a plain-language description or review finding',
    'when dispatched standalone (e.g. by `/do-implement`, or directly, with no chain artifacts at all).',
    "**Will:** Implement features and fixes directly against whatever spec it's handed — a `design.md`",
    'contract and `plan.md` task, a plain-language description, or a review finding, with no DoFlow',
  ]],
]);
const HOOK_LINE = 'If a workflow hands you a stage brief, its procedure and output format override the defaults here.';

/** Frontmatter values for the keys this guard reads. Quotes are stripped; no YAML dependency. */
function frontmatterValue(text, key) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = line.match(new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`));
    if (!match) continue;
    const value = match[1];
    return /^"(.*)"$|^'(.*)'$/.test(value) ? value.slice(1, -1) : value;
  }
  return undefined;
}

function readSpecs() {
  return agentSpecFiles().map(({ name, file }) => {
    const text = fs.readFileSync(file, 'utf8');
    return { name, description: frontmatterValue(text, 'description') ?? '', access: frontmatterValue(text, 'access') };
  });
}

/** Every budget violation in a list of `{ name, description, access }`, as readable lines. */
function findings(specs) {
  const out = [];
  if (specs.length > MAX_SPECS) out.push(`${specs.length} specs exceed the cap of ${MAX_SPECS}`);
  for (const { name, description, access } of specs) {
    if (description.length > MAX_DESCRIPTION) {
      out.push(`${name}: description is ${description.length} characters, cap ${MAX_DESCRIPTION}`);
    }
    if (!ACCESS_VALUES.includes(access)) {
      out.push(`${name}: access is ${JSON.stringify(access)}, expected one of ${ACCESS_VALUES.join(', ')}`);
    }
  }
  const total = specs.reduce((sum, spec) => sum + spec.description.length, 0);
  if (total > MAX_TOTAL) out.push(`descriptions total ${total} characters, cap ${MAX_TOTAL}`);
  return out;
}

/** A scalar that YAML would reject: an unterminated quote, an unbalanced flow collection, or a plain
 * scalar holding `: `. Empty is valid (a nested mapping follows). */
function scalarProblem(value) {
  if (value === '') return null;
  if (value.startsWith('"')) return /^"(?:[^"\\]|\\.)*"$/.test(value) ? null : 'unterminated or unbalanced double quote';
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? null : 'unterminated or unbalanced single quote';
  if (/^[[{]/.test(value)) {
    const close = value[0] === '[' ? ']' : '}';
    return value.endsWith(close) ? null : 'unterminated flow collection';
  }
  return /:(?:\s|$)/.test(value) ? 'plain scalar contains ": "' : null;
}

/** Strict frontmatter check, no YAML dependency (the repo has no YAML parser: its registries are JSON and
 * every guard reads frontmatter by regex, which accepts `description: "broken`). Rules: opening and
 * closing `---`; each line is `key: value` with a valid scalar, or an indented `sub: value` / `- item`
 * under a key whose own value is empty; `description` is a single-line scalar (no `|` / `>` block
 * indicator, no continuation). Returns readable problem lines. */
function frontmatterProblems(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return ['no opening frontmatter marker'];
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return ['unterminated frontmatter: no closing marker'];
  const out = [];
  let parent = null; // top-level key still open to indented children
  lines.slice(1, end).forEach((line, i) => {
    const at = `frontmatter line ${i + 2}`;
    if (!line.trim()) return;
    if (/^\s/.test(line)) {
      if (!parent) out.push(`${at}: indented line is not a key: value mapping line`);
      else if (parent.value !== '') out.push(`${at}: continuation under '${parent.key}'${parent.key === 'description' ? ' (multi-line description)' : ''}`);
      else if (parent.key === 'description') out.push(`${at}: multi-line description`);
      else if (!/^\s+(?:[A-Za-z][A-Za-z0-9_-]*:(?:\s+.*)?|-\s+.*)$/.test(line)) out.push(`${at}: not a key: value line`);
      return;
    }
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*?))?\s*$/);
    if (!m) { parent = null; out.push(`${at}: not a key: value line`); return; }
    const [, key, raw = ''] = m;
    parent = { key, value: raw };
    const problem = scalarProblem(raw);
    if (problem) out.push(`${at}: ${key}: ${problem}`);
    if (key === 'description' && (raw === '' || /^[|>][+-]?\d*$/.test(raw))) out.push(`${at}: multi-line description (block scalar or empty value)`);
  });
  return out;
}

const specs = readSpecs();

test('G64: the shipped roster is within the spec count, description and total budgets and declares access', () => {
  assert.deepEqual(findings(specs), []);
});

test('G64: the check bites on an eighth spec, a 161-character description, and a 1,001-character sum', () => {
  const base = specs.map((spec) => ({ ...spec, access: 'read-only' }));
  assert.deepEqual(findings(base), [], 'controls start from a clean roster');

  const eighth = [...base, ...Array.from({ length: MAX_SPECS + 1 - base.length }, (_, i) => (
    { name: `extra-${i}.md`, description: 'x', access: 'write' }))];
  assert.match(findings(eighth).join('\n'), /exceed the cap of 7/);

  const long = base.map((spec, i) => (i === 0 ? { ...spec, description: 'x'.repeat(MAX_DESCRIPTION + 1) } : spec));
  assert.match(findings(long).join('\n'), /description is 161 characters/);

  // Five specs cannot reach the sum cap (5 x 160 = 800), so pad the roster to the spec cap first and
  // spread the excess so no single description trips its own cap.
  const padded = [...base, ...Array.from({ length: MAX_SPECS - base.length }, (_, i) => (
    { name: `pad-${i}.md`, description: '', access: 'write' }))];
  let need = MAX_TOTAL + 1 - padded.reduce((acc, spec) => acc + spec.description.length, 0);
  const over = padded.map((spec) => {
    const add = Math.min(need, MAX_DESCRIPTION - spec.description.length);
    need -= add;
    return { ...spec, description: spec.description + 'x'.repeat(add) };
  });
  assert.equal(need, 0, 'seven descriptions can hold 1,001 characters');
  assert.match(findings(over).join('\n'), /^descriptions total 1001 characters, cap 1000$/m);
  assert.equal(findings(over).length, 1, 'the sum control trips only the sum cap');

  const missing = base.map((spec, i) => (i === 0 ? { ...spec, access: undefined } : spec));
  assert.match(findings(missing).join('\n'), /access is undefined/);
});

/** Every verb the `doflow` CLI and the `doflow-run` dispatcher accept: the `Commands:` list of
 * `doflow --help` plus the dispatcher's own verb table. */
function cliVerbs() {
  const help = execFileSync(process.execPath, [path.join(REPO, 'bin', 'doflow.js'), '--help'], { encoding: 'utf8' });
  const verbs = new Set(dispatcherVerbs());
  let inCommands = false;
  for (const line of help.split('\n')) {
    if (line === 'Commands:') { inCommands = true; continue; }
    if (inCommands && /^\S/.test(line)) break;
    const match = inCommands && line.match(/^ {2}([a-z][a-z-]*)(?: |$)/);
    if (match) verbs.add(match[1]);
  }
  return verbs;
}

const VERBS = cliVerbs();
// Case-insensitive, and flags may sit between `doflow` / `doflow-run` and the verb (`doflow --json evidence`).
// Ceiling accepted: prose such as "DoFlow review of the plan" also trips; reword it in the spec.
const COMMAND = new RegExp(`\\bdoflow(?:-run)?(?: +--?[\\w-]+(?:=\\S+)?)* +(${[...VERBS].sort((a, b) => b.length - a.length).join('|')})(?![\\w-])`, 'gi');

/** The patterns one line trips, as the matched (lowercased) text. */
function tripped(line) {
  const lower = line.toLowerCase();
  const out = STANDALONE_TOKENS.filter((token) => lower.includes(token));
  for (const match of line.matchAll(COMMAND)) out.push(match[0].toLowerCase().replace(/ +/g, ' '));
  const skill = line.match(SKILL_COMMAND);
  if (skill) out.push(skill[1]);
  return out;
}

/** `<file>:<line>: names '<pattern>'` for every pattern tripped in a *.md spec under `mdDir` and a
 * *.toml under `tomlDir`, skipping the hook line and the EXCEPTIONS lines. */
function standaloneFindings(mdDir, tomlDir) {
  const out = [];
  for (const [dir, ext] of [[mdDir, '.md'], [tomlDir, '.toml']]) {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(ext)).sort()) {
      const allowed = EXCEPTIONS.get(name) ?? [];
      fs.readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, i) => {
        if (line.trim() === HOOK_LINE || allowed.includes(line.trim())) return;
        for (const pattern of tripped(line)) out.push(`${name}:${i + 1}: names '${pattern}'`);
      });
    }
  }
  return out;
}

/** An EXCEPTIONS line that is missing from its file, or no longer trips a pattern, is a stale exemption. */
function staleExceptions(mdDir) {
  const out = [];
  for (const [name, lines] of EXCEPTIONS) {
    const file = path.join(mdDir, name);
    const present = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()) : [];
    for (const line of lines) {
      if (!present.includes(line)) out.push(`${name}: exception line no longer exists: ${line}`);
      else if (!tripped(line).length) out.push(`${name}: exception line trips no pattern, drop it: ${line}`);
    }
  }
  return out;
}

test('G64: no spec or Codex agent TOML names a DoFlow verb, state path, record or chain artifact outside the hook line', () => {
  assert.deepEqual(standaloneFindings(AGENT_SPECS, CODEX_AGENTS), []);
});

test('G64: every EXCEPTIONS line still exists in its spec and still trips a pattern', () => {
  assert.deepEqual(staleExceptions(AGENT_SPECS), []);
});

/** The shipped specs and TOMLs copied into a scratch dir: `{ md, toml }`. */
function scratchRoster(t) {
  const root = tempDir(t, 'doflow-g64-');
  const md = path.join(root, 'md');
  const toml = path.join(root, 'toml');
  fs.cpSync(AGENT_SPECS, md, { recursive: true });
  fs.cpSync(CODEX_AGENTS, toml, { recursive: true });
  return { md, toml };
}

const squash = (found) => found.map((f) => f.replace(/:\d+:/, ':'));

test('G64 control: the hook line alone is green; a planted doflow-run or Readiness in a spec is red', (t) => {
  const { md, toml } = scratchRoster(t);
  assert.deepEqual(standaloneFindings(md, toml), [], 'controls start from the shipped roster');
  fs.appendFileSync(path.join(md, 'reviewer.md'), `${HOOK_LINE}\n`);
  assert.deepEqual(standaloneFindings(md, toml), [], 'the hook line is allowed');
  fs.appendFileSync(path.join(md, 'reviewer.md'), 'Record the result with doflow-run and check the Readiness file.\n');
  assert.deepEqual(squash(standaloneFindings(md, toml)), ["reviewer.md: names 'doflow-run'", "reviewer.md: names 'readiness'"]);
});

test('G64 control: a doflow <verb> command or a trailer line planted in delivery-lead.md is red', (t) => {
  const { md, toml } = scratchRoster(t);
  const file = path.join(md, 'delivery-lead.md');
  fs.appendFileSync(file, 'Run doflow plan-check on the plan, then doflow dispatch and doflow evidence.\n');
  assert.deepEqual(squash(standaloneFindings(md, toml)), [
    "delivery-lead.md: names 'doflow plan-check'",
    "delivery-lead.md: names 'doflow dispatch'",
    "delivery-lead.md: names 'doflow evidence'",
  ]);
  fs.writeFileSync(file, fs.readFileSync(path.join(AGENT_SPECS, 'delivery-lead.md')));
  assert.deepEqual(standaloneFindings(md, toml), [], 'restoring the spec clears the findings');
  fs.appendFileSync(file, 'DoFlow-Row: 118\n');
  assert.deepEqual(squash(standaloneFindings(md, toml)), ["delivery-lead.md: names 'doflow-row'"]);
});

test('G64 control: prose that merely says DoFlow, and a verb word after a non-DoFlow word, stay green', (t) => {
  const { md, toml } = scratchRoster(t);
  fs.appendFileSync(path.join(md, 'reviewer.md'), 'Use DoFlow-optional wording; then dispatch the review and plan the work.\n');
  assert.deepEqual(standaloneFindings(md, toml), []);
});

test('G64 control: a doflow-run command planted in a Codex TOML is red', (t) => {
  const { md, toml } = scratchRoster(t);
  const file = path.join(toml, 'delivery-lead.toml');
  fs.appendFileSync(file, '# doflow-run task-attempt .doflow/ readiness\n');
  assert.deepEqual(squash(standaloneFindings(md, toml)).sort(), [
    "delivery-lead.toml: names '.doflow/'",
    "delivery-lead.toml: names 'doflow-run task-attempt'",
    "delivery-lead.toml: names 'doflow-run'",
    "delivery-lead.toml: names 'readiness'",
    "delivery-lead.toml: names 'task-attempt'",
  ]);
});

test('G64 control: a verb line in core-implementer.md outside its EXCEPTIONS lines is red; the exception lines alone are green', (t) => {
  const { md, toml } = scratchRoster(t);
  assert.deepEqual(standaloneFindings(md, toml), [], 'the excepted DoFlow-optional lines are green');
  fs.appendFileSync(path.join(md, 'core-implementer.md'), 'Afterwards run doflow evidence for the task.\n');
  assert.deepEqual(squash(standaloneFindings(md, toml)), ["core-implementer.md: names 'doflow evidence'"]);
});

test('G64 control: an exception line that no longer exists is reported stale', (t) => {
  const { md } = scratchRoster(t);
  assert.deepEqual(staleExceptions(md), []);
  const file = path.join(md, 'core-implementer.md');
  const [first] = EXCEPTIONS.get('core-implementer.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(first, 'reworded'));
  assert.deepEqual(staleExceptions(md), [`core-implementer.md: exception line no longer exists: ${first}`]);
});

test('G64: the doflow <verb> pattern is derived from the CLI Commands list and the dispatcher table', () => {
  const verbs = cliVerbs();
  for (const verb of ['plan-check', 'dispatch', 'evidence', 'readiness', 'task-attempt', 'context-pack', 'followup', 'roadmap', 'classify', 'workflow', 'verify', 'review', 'orchestrate', 'claim']) {
    assert.ok(verbs.has(verb), `${verb} is a derived verb`);
  }
});

// R-3: every harness parses the projected frontmatter as YAML, so a broken spec must fail here.
function specFrontmatterFindings(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
    .flatMap((name) => frontmatterProblems(fs.readFileSync(path.join(dir, name), 'utf8')).map((p) => `${name}: ${p}`));
}

test('G64: every shared spec frontmatter is valid YAML with a single-line description', () => {
  assert.deepEqual(specFrontmatterFindings(AGENT_SPECS), []);
});

test('G64 control: a broken quote, a continued description, a block scalar and a bad mapping line in a spec are red', (t) => {
  const { md } = scratchRoster(t);
  const file = path.join(md, 'reviewer.md');
  const original = fs.readFileSync(file, 'utf8');
  assert.deepEqual(specFrontmatterFindings(md), [], 'controls start from the shipped roster');
  const plant = (from, to) => {
    assert.ok(original.includes(from), `fixture line present: ${from}`);
    fs.writeFileSync(file, original.replace(from, to));
    return specFrontmatterFindings(md).join('\n');
  };
  const descLine = original.split('\n')[2];
  assert.match(descLine, /^description: "/);
  assert.match(plant(descLine, 'description: "broken'), /reviewer\.md: .*description.*unterminated|unbalanced quote/i);
  assert.match(plant(descLine, `${descLine}\n  continued on a second line`), /reviewer\.md: .*multi-line description/);
  assert.match(plant(descLine, `${descLine}\ncontinued without indent`), /reviewer\.md: .*(multi-line description|not a key: value)/);
  assert.match(plant(descLine, 'description: >\n  folded text'), /reviewer\.md: .*multi-line description/);
  assert.match(plant('model: inherit', 'model inherit'), /reviewer\.md: .*not a key: value/);
  assert.match(plant('access: read-only\n---', 'access: read-only'), /reviewer\.md: .*unterminated frontmatter|no closing/i);
  fs.writeFileSync(file, original);
  assert.deepEqual(specFrontmatterFindings(md), [], 'restoring the spec clears the findings');
});

test('G64 control: doflow verbs are caught case-insensitively and past flags, and agent-docs/ paths are rejected', (t) => {
  const { md, toml } = scratchRoster(t);
  const file = path.join(md, 'reviewer.md');
  const original = fs.readFileSync(file, 'utf8');
  const plant = (line) => { fs.writeFileSync(file, `${original}${line}\n`); return squash(standaloneFindings(md, toml)); };
  assert.deepEqual(plant('Then run Doflow evidence on the result.'), ["reviewer.md: names 'doflow evidence'"]);
  assert.deepEqual(plant('Then run doflow --json evidence on the result.'), ["reviewer.md: names 'doflow --json evidence'"]);
  assert.deepEqual(plant('Then run doflow-run -q --root=x task-attempt on the result.').sort(), [
    "reviewer.md: names 'doflow-run -q --root=x task-attempt'",
    "reviewer.md: names 'doflow-run'",
    "reviewer.md: names 'task-attempt'",
  ].sort());
  assert.deepEqual(plant('Write the report under agent-docs/doflow/ for the feature.'), ["reviewer.md: names 'agent-docs/'"]);
  assert.deepEqual(plant('DoFlow-optional wording, and the DoFlow product name, stay prose.'), []);
});

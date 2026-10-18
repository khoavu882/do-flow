'use strict';

// G46 — prose that restates the implement gate, install layout or packaged file sets must agree
// with the hook, resolver and asset registry that own those facts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, GUIDANCE, SKILLS, AGENT_SPECS } = require('./_shared');

const CHAIN_REL = 'core/shared/guidance/references/DOFLOW_CHAIN.md';
const CHAIN_FILE = path.join(REPO, CHAIN_REL);
const GATE_REL = 'core/harnesses/shared/hooks/policies/pre-implementation-gate.sh';
const GATE_FILE = path.join(REPO, GATE_REL);
const DO_SKILL_FILE = path.join(REPO, 'core/shared/skills/do/SKILL.md');
const ASSETS = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/assets.json'), 'utf8')).assets;
const CODE_RE = /^[a-z]+(-[a-z]+)+$/;
const GATE_LABEL = '**Implement gate (hard):**';
const CANONICAL_GATE_RE = /\b(one|only|single)\b[^.]{0,40}\bhard gate\b|\bhard gate\b[^.]{0,60}\b(only|covers)\b/i;

const BASELINE_GATE_BULLET = [
  '- **One hard gate:** source edits are blocked when a feature is started but `requirement.md`,',
  '  `design.md`, or `plan.md` is missing. Every other gate is advisory/skippable (solo,',
  '  low-ceremony).',
].join('\n');
const BASELINE_HOOK_ROW = '| `hooks/`               | `pre-implement-gate.sh` — PreToolUse(Edit\\|Write) backstop for the one hard gate |';
const BASELINE_TEMPLATE_ROW = '| `templates/doflow/`    | `requirement-template.md` (optional `**Ticket:**` header field) / `design-template.md` / `plan-template.md` (its own "Tasks" subsection folds in what used to be a separate tasks template, supports optional `depends-on:` and `external-contract:` fields per task, and a Repo Branch Plan table for multi-repo features) / `state-template.md` (Repo Branch Status table) / `constitution-template.md` / `external-contract-template.md` (pinned structure for a `external-contract:` target — a documented external dependency `--scaffold` can generate a mechanical frame from) — seeded into each feature dir. A shared pool across skills, not per-skill `assets/` — see note below. |';
const BASELINE_REFERENCE_ROW = '| `references/`          | `CONSTITUTION_BASE.md` — tier-1 global constitution base |';
const BASELINE_ROOT_NOTE = [
  "> Paths above are relative to the installed root (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}` globally,",
  "> or a project's own `.claude/` in project scope). Chain skills' resolver lookups check the global",
  "> config dir first, then walk upward from `$PWD` for a project-scoped `.claude/` install.",
].join('\n');

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

function sourceFor(assetId) {
  return ASSETS.find((asset) => asset.id === assetId)?.source ?? '';
}

function readDirectoryFiles(relativeDir, keep = () => true) {
  const absoluteDir = path.join(REPO, relativeDir);
  if (!relativeDir || !fs.existsSync(absoluteDir)) return [];
  return fs.readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => ({ name: entry.name, text: fs.readFileSync(path.join(absoluteDir, entry.name), 'utf8') }));
}

function markdownFiles(relativeDir, excludeFixtures = false) {
  const absoluteDir = path.join(REPO, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeFixtures && ['assets', 'expected_outputs'].includes(entry.name)) continue;
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push({
          rel: path.relative(REPO, absolute).split(path.sep).join('/'),
          text: fs.readFileSync(absolute, 'utf8'),
        });
      }
    }
  }(absoluteDir));
  return out;
}

function guidanceCorpus() {
  const skillDirs = fs.readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(SKILLS, entry.name));
  return [
    ...markdownFiles(GUIDANCE),
    ...skillDirs.flatMap((dir) => markdownFiles(path.relative(REPO, dir), true)),
    ...markdownFiles(path.relative(REPO, AGENT_SPECS)),
  ];
}

function paragraphs(text) {
  return text.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean);
}

function listItem(text, anchor) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(anchor));
  if (start < 0) return '';
  const item = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].trim() || /^\s*-\s/.test(lines[i]) || !/^\s{2,}\S/.test(lines[i])) break;
    item.push(lines[i]);
  }
  return item.join('\n');
}

function setDifference(expected, actual) {
  return {
    missing: [...expected].filter((name) => !actual.has(name)).sort(),
    extra: [...actual].filter((name) => !expected.has(name)).sort(),
  };
}

function setMismatch(label, expected, actual) {
  const { missing, extra } = setDifference(expected, actual);
  return missing.length || extra.length
    ? [`${label}: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`]
    : [];
}

function literalDenyCodes(text) {
  return [...text.matchAll(/\bdoflow_decide\s+deny\s+([a-z]+(?:-[a-z]+)+)\b/g)]
    .map(([, code]) => code)
    .filter((code) => code !== 'contract-missing');
}

function checkGate({ chain, gate }) {
  const findings = [];
  if (!gate.trim()) return ['G46.1: gate source is empty'];

  const headerEnd = gate.indexOf('\nset -');
  const header = headerEnd < 0 ? gate : gate.slice(0, headerEnd);
  if (!/^# Denies\b/m.test(header)) findings.push('G46.1: found no Denies header anchor');
  const cases = [...header.matchAll(/^#\s+\d+\./gm)];
  const sourceCodes = new Set(literalDenyCodes(gate));
  if (!sourceCodes.size) findings.push('G46.1: gate source has no literal deny codes');
  if (!cases.length) findings.push('G46.1: gate source has no numbered deny cases');
  const families = new Set([...sourceCodes].map((code) => code.split('-')[0]));
  if (cases.length !== families.size) {
    findings.push(`G46.1: ${cases.length} header cases do not match ${families.size} deny-code families`);
  }

  const bullet = listItem(chain, GATE_LABEL);
  if (!bullet) findings.push(`G46.1: found no ${GATE_LABEL} anchor in DOFLOW_CHAIN.md`);
  const proseCodes = new Set(bullet
    ? [...bullet.matchAll(/`([^`]+)`/g)].map(([, token]) => token).filter((token) => CODE_RE.test(token))
    : []);
  findings.push(...setMismatch('G46.1: hard-gate deny codes differ from pre-implementation-gate.sh', sourceCodes, proseCodes));
  return findings;
}

function checkCanonicalGate(files) {
  if (!files.length) return ['G46.2: G24 corpus is empty'];
  const candidates = files.flatMap(({ rel, text }) => rel === CHAIN_REL ? [] : paragraphs(text)
    .filter((paragraph) => CANONICAL_GATE_RE.test(paragraph))
    .map((paragraph) => ({ rel, paragraph })));
  if (!candidates.length) return ['G46.2: found no canonical hard-gate statement anchor'];
  return candidates.filter(({ paragraph }) => !paragraph.includes('DOFLOW_CHAIN.md'))
    .map(({ rel }) => `G46.2: ${rel} has a hard-gate scope claim without DOFLOW_CHAIN.md`);
}

function layoutRows(text) {
  return text.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
}

function rowPath(row) {
  return row.split('|')[1]?.trim().replace(/^`|`$/g, '') ?? '';
}

function rowNames(row, suffixRe) {
  return [...row.matchAll(/`([^`]+)`/g)].map(([, name]) => name).filter((name) => suffixRe.test(name));
}

function checkLayoutRow({ chain, pathCell, expected, suffixRe, label, glob }) {
  const findings = [];
  if (!expected.size) findings.push(`${label}: source set is empty`);
  const rows = layoutRows(chain).filter((row) => rowPath(row) === pathCell);
  if (!rows.length) return [...findings, `${label}: found no Layout row anchor for ${pathCell}`];
  if (rows.length > 1) findings.push(`${label}: found ${rows.length} Layout row anchors for ${pathCell}`);
  const actual = new Set(rowNames(rows[0], suffixRe));
  if (!actual.size) findings.push(`${label}: found no backticked ${glob} names in ${pathCell}`);
  findings.push(...setMismatch(`${label}: ${pathCell} names differ from its registry source`, expected, actual));
  return findings;
}

function layoutNote(text) {
  const lines = text.split(/\r?\n/);
  const tableHeader = lines.findIndex((line) => rowPath(line) === 'Path');
  if (tableHeader < 0) return { foundTable: false, note: '' };
  let end = tableHeader;
  while (end + 1 < lines.length && /^\s*\|/.test(lines[end + 1])) end += 1;
  let start = end + 1;
  while (start < lines.length && !lines[start].trim()) start += 1;
  if (!lines[start]?.trimStart().startsWith('>')) return { foundTable: true, note: '' };
  const noteLines = [];
  while (start < lines.length && lines[start].trimStart().startsWith('>')) {
    noteLines.push(lines[start]);
    start += 1;
  }
  return { foundTable: true, note: noteLines.join('\n') };
}

function normalizeRoot(token) {
  let root = token.startsWith('$D/') ? token.slice(3) : token;
  const marker = root.indexOf('.doflow/');
  if (marker >= 0) root = root.slice(0, marker + '.doflow/'.length);
  return root;
}

function resolverRoots(text) {
  const anchor = text.indexOf('# Resolve the DoFlow runtime:');
  if (anchor < 0) return { foundAnchor: false, roots: [] };
  const fenceEnd = text.indexOf('```', anchor);
  const block = fenceEnd < 0 ? text.slice(anchor) : text.slice(anchor, fenceEnd);
  const roots = [];
  for (const [, scope] of block.matchAll(/\$(D|HOME)\/\.doflow\//g)) {
    const root = scope === 'D' ? '.doflow/' : '$HOME/.doflow/';
    if (!roots.includes(root)) roots.push(root);
  }
  return { foundAnchor: true, roots };
}

function checkInstallRoots({ chain, resolver }) {
  const findings = [];
  if (!resolver.foundAnchor) findings.push('G46.6: found no DoFlow resolver anchor');
  if (!resolver.roots.length) findings.push('G46.6: resolver source has no install roots');
  const { foundTable, note } = layoutNote(chain);
  if (!foundTable) findings.push('G46.6: found no Layout table anchor');
  if (!note) findings.push('G46.6: found no install-root note anchor after the Layout table');
  const proseRoots = [...note.matchAll(/`([^`]+)`/g)]
    .map(([, token]) => token)
    .filter((token) => token.includes('.doflow') || token.includes('.claude') || token.startsWith('${') || token.startsWith('~/'))
    .map(normalizeRoot);
  if (!proseRoots.length) findings.push('G46.6: install-root note has no root tokens');
  if (proseRoots.length !== resolver.roots.length || proseRoots.some((root, i) => root !== resolver.roots[i])) {
    findings.push(`G46.6: install roots differ; note [${proseRoots.join(', ')}], resolver [${resolver.roots.join(', ')}]`);
  }
  return findings;
}

function replaceRow(text, pathCell, replacement) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => rowPath(line) === pathCell);
  if (index >= 0) lines[index] = replacement;
  return lines.join('\n');
}

function removeRow(text, pathCell) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => rowPath(line) === pathCell);
  if (index >= 0) lines.splice(index, 1);
  return lines.join('\n');
}

function plantNames(text, pathCell, missing, extra) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => rowPath(line) === pathCell);
  if (index < 0) return text;
  const withoutMissing = lines[index].replaceAll(`\`${missing}\``, '');
  const lastPipe = withoutMissing.lastIndexOf('|');
  lines[index] = `${withoutMissing.slice(0, lastPipe).trimEnd()} \`${extra}\` ${withoutMissing.slice(lastPipe)}`;
  return lines.join('\n');
}

function replaceLayoutNote(text, replacement) {
  const lines = text.split(/\r?\n/);
  const tableHeader = lines.findIndex((line) => rowPath(line) === 'Path');
  if (tableHeader < 0) return text;
  let end = tableHeader;
  while (end + 1 < lines.length && /^\s*\|/.test(lines[end + 1])) end += 1;
  let start = end + 1;
  while (start < lines.length && !lines[start].trim()) start += 1;
  let stop = start;
  while (stop < lines.length && lines[stop].trimStart().startsWith('>')) stop += 1;
  lines.splice(start, stop - start, ...replacement.split('\n'));
  return lines.join('\n');
}

const CHAIN_TEXT = read(CHAIN_REL);
const GATE_TEXT = read(GATE_REL);
const DO_SKILL_TEXT = read('core/shared/skills/do/SKILL.md');
const POLICY_DIR = `${sourceFor('hooks.shared')}/policies`;
const TEMPLATE_DIR = `${sourceFor('templates.doflow')}/doflow`;
const REFERENCE_DIR = `${sourceFor('guidance.context-layer')}/references`;
const POLICY_FILES = readDirectoryFiles(POLICY_DIR, (name) => name.endsWith('.sh'));
const POLICY_NAMES = new Set(POLICY_FILES.filter(({ text }) => literalDenyCodes(text).length).map(({ name }) => name));
const TEMPLATE_NAMES = new Set(readDirectoryFiles(TEMPLATE_DIR, (name) => name.endsWith('-template.md')).map(({ name }) => name));
const REFERENCE_NAMES = new Set(readDirectoryFiles(REFERENCE_DIR, (name) => name.endsWith('.md')).map(({ name }) => name));
const CANONICAL_CORPUS = guidanceCorpus();
const RESOLVER = resolverRoots(DO_SKILL_TEXT);
const POLICY_PATH = 'shared/hooks/policies/';
const TEMPLATE_PATH = 'templates/doflow/';
const REFERENCE_PATH = 'guidance/references/';

test('G46.1: implement-gate prose matches the hard-gate hook', () => {
  assert.deepEqual(checkGate({ chain: CHAIN_TEXT, gate: GATE_TEXT }), []);
});

test('G46.1 control: re-seeding the baseline One hard gate bullet is caught', () => {
  const findings = checkGate({ chain: BASELINE_GATE_BULLET, gate: GATE_TEXT });
  assert.ok(findings.some((finding) => finding.includes(GATE_LABEL)), findings.join('\n'));
});

test('G46.1 control: removing the implement-gate anchor is caught', () => {
  const findings = checkGate({ chain: '## Core design rules\n\n- Other gates are advisory.', gate: GATE_TEXT });
  assert.ok(findings.some((finding) => finding.includes('found no')), findings.join('\n'));
});

test('G46.2: canonical hard-gate scope claims point to DOFLOW_CHAIN.md', () => {
  assert.deepEqual(checkCanonicalGate(CANONICAL_CORPUS), []);
});

test('G46.2 control: re-seeding the baseline gate-scope claim is caught', () => {
  const findings = checkCanonicalGate([{
    rel: 'core/shared/guidance/references/CONSTITUTION_BASE.md',
    text: "The chain's one hard gate covers artifact existence only.",
  }]);
  assert.deepEqual(findings, ['G46.2: core/shared/guidance/references/CONSTITUTION_BASE.md has a hard-gate scope claim without DOFLOW_CHAIN.md']);
});

test('G46.2 control: removing all canonical gate statements is caught', () => {
  const findings = checkCanonicalGate([{ rel: 'sample.md', text: 'Only advisory checks are described here.' }]);
  assert.ok(findings.some((finding) => finding.includes('found no')), findings.join('\n'));
});

test('G46.3: shared policy row matches policies that emit literal deny decisions', () => {
  assert.deepEqual(checkLayoutRow({ chain: CHAIN_TEXT, pathCell: POLICY_PATH, expected: POLICY_NAMES, suffixRe: /\.sh$/, label: 'G46.3', glob: '*.sh' }), []);
});

test('G46.3 control: re-seeding the baseline hooks row is caught', () => {
  const stale = replaceRow(CHAIN_TEXT, POLICY_PATH, BASELINE_HOOK_ROW);
  const findings = checkLayoutRow({ chain: stale, pathCell: POLICY_PATH, expected: POLICY_NAMES, suffixRe: /\.sh$/, label: 'G46.3', glob: '*.sh' });
  assert.ok(findings.some((finding) => finding.includes('found no Layout row anchor')), findings.join('\n'));
});

test('G46.3 control: both a missing policy and a planted ghost policy are caught', () => {
  const first = [...POLICY_NAMES].sort()[0];
  const findings = checkLayoutRow({
    chain: plantNames(CHAIN_TEXT, POLICY_PATH, first, 'ghost.sh'), pathCell: POLICY_PATH,
    expected: POLICY_NAMES, suffixRe: /\.sh$/, label: 'G46.3', glob: '*.sh',
  });
  assert.match(findings.join('\n'), new RegExp(`missing \\[${first}`));
  assert.match(findings.join('\n'), /ghost\.sh/);
});

test('G46.3 control: removing the shared-policy row anchor is caught', () => {
  const findings = checkLayoutRow({ chain: removeRow(CHAIN_TEXT, POLICY_PATH), pathCell: POLICY_PATH, expected: POLICY_NAMES, suffixRe: /\.sh$/, label: 'G46.3', glob: '*.sh' });
  assert.ok(findings.some((finding) => finding.includes('found no Layout row anchor')), findings.join('\n'));
});

test('G46.4: templates row matches templates.doflow files', () => {
  assert.deepEqual(checkLayoutRow({ chain: CHAIN_TEXT, pathCell: TEMPLATE_PATH, expected: TEMPLATE_NAMES, suffixRe: /-template\.md$/, label: 'G46.4', glob: '*-template.md' }), []);
});

test('G46.4 control: re-seeding the six-template baseline row is caught', () => {
  const stale = replaceRow(CHAIN_TEXT, TEMPLATE_PATH, BASELINE_TEMPLATE_ROW);
  const findings = checkLayoutRow({ chain: stale, pathCell: TEMPLATE_PATH, expected: TEMPLATE_NAMES, suffixRe: /-template\.md$/, label: 'G46.4', glob: '*-template.md' });
  assert.match(findings.join('\n'), /missing \[.*(?:data-model|intent|question-log|specs)-template\.md/);
});

test('G46.4 control: both a missing template and a planted ghost template are caught', () => {
  const first = [...TEMPLATE_NAMES].sort()[0];
  const findings = checkLayoutRow({
    chain: plantNames(CHAIN_TEXT, TEMPLATE_PATH, first, 'ghost-template.md'), pathCell: TEMPLATE_PATH,
    expected: TEMPLATE_NAMES, suffixRe: /-template\.md$/, label: 'G46.4', glob: '*-template.md',
  });
  assert.match(findings.join('\n'), new RegExp(`missing \\[${first}`));
  assert.match(findings.join('\n'), /ghost-template\.md/);
});

test('G46.4 control: removing the templates row anchor is caught', () => {
  const findings = checkLayoutRow({ chain: removeRow(CHAIN_TEXT, TEMPLATE_PATH), pathCell: TEMPLATE_PATH, expected: TEMPLATE_NAMES, suffixRe: /-template\.md$/, label: 'G46.4', glob: '*-template.md' });
  assert.ok(findings.some((finding) => finding.includes('found no Layout row anchor')), findings.join('\n'));
});

test('G46.5: references row matches guidance.context-layer references', () => {
  assert.deepEqual(checkLayoutRow({ chain: CHAIN_TEXT, pathCell: REFERENCE_PATH, expected: REFERENCE_NAMES, suffixRe: /\.md$/, label: 'G46.5', glob: '*.md' }), []);
});

test('G46.5 control: re-seeding the one-file references baseline row is caught', () => {
  const stale = replaceRow(CHAIN_TEXT, REFERENCE_PATH, BASELINE_REFERENCE_ROW);
  const findings = checkLayoutRow({ chain: stale, pathCell: REFERENCE_PATH, expected: REFERENCE_NAMES, suffixRe: /\.md$/, label: 'G46.5', glob: '*.md' });
  assert.ok(findings.some((finding) => finding.includes('found no Layout row anchor')), findings.join('\n'));
});

test('G46.5 control: a missing reference and a planted ghost reference are caught', () => {
  const first = [...REFERENCE_NAMES].sort()[0];
  const findings = checkLayoutRow({
    chain: plantNames(CHAIN_TEXT, REFERENCE_PATH, first, 'ghost.md'), pathCell: REFERENCE_PATH,
    expected: REFERENCE_NAMES, suffixRe: /\.md$/, label: 'G46.5', glob: '*.md',
  });
  assert.match(findings.join('\n'), new RegExp(`missing \\[${first}`));
  assert.match(findings.join('\n'), /ghost\.md/);
});

test('G46.5 control: removing the references row anchor is caught', () => {
  const findings = checkLayoutRow({ chain: removeRow(CHAIN_TEXT, REFERENCE_PATH), pathCell: REFERENCE_PATH, expected: REFERENCE_NAMES, suffixRe: /\.md$/, label: 'G46.5', glob: '*.md' });
  assert.ok(findings.some((finding) => finding.includes('found no Layout row anchor')), findings.join('\n'));
});

test('G46.6: install-root note matches resolver search order', () => {
  assert.deepEqual(checkInstallRoots({ chain: CHAIN_TEXT, resolver: RESOLVER }), []);
});

test('G46.6 control: re-seeding the baseline .claude install-root note is caught', () => {
  const stale = replaceLayoutNote(CHAIN_TEXT, BASELINE_ROOT_NOTE);
  const findings = checkInstallRoots({ chain: stale, resolver: RESOLVER });
  assert.ok(findings.some((finding) => finding.includes('install roots differ')), findings.join('\n'));
});

test('G46.6 control: removing the install-root note anchor is caught', () => {
  const findings = checkInstallRoots({ chain: replaceLayoutNote(CHAIN_TEXT, ''), resolver: RESOLVER });
  assert.ok(findings.some((finding) => finding.includes('found no install-root note anchor')), findings.join('\n'));
});

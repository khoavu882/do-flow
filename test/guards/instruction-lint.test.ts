'use strict';

// G24 — instruction lint. The guidance, skills and agent specs the harnesses load tell a model to read
// files and run `doflow-run` verbs, and nothing else checks those instructions against the tree:
//   1. every `doflow-run <verb>` they name must be a verb the dispatcher serves;
//   2. every backticked path they cite must resolve to a file or directory that ships (G8 checks the
//      same for docs/ and README.md; this guard does not read docs/);
//   3. a tool or token only one harness provides is named only beside that harness (`harnessOnlyNames`);
//   4. no two defaults that contradict each other may both be present (`pairs` in instruction-lint.json).
// A path or verb that is intentionally not in the tree (generated, or created at runtime) is declared
// in instruction-lint.json `allow`; an entry that suppresses nothing, or a policy file that is
// malformed, fails the lint, so the policy cannot rot into a blanket suppression.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, dispatcherVerbs } = require('./_shared.ts');

const SHARED = 'core/shared';
const GUIDANCE_REL = `${SHARED}/guidance`;
const FIXTURE_DIRS: any = new Set(['assets', 'expected_outputs']);
const POLICY_FILE = path.join(__dirname, 'instruction-lint.json');

const VERB_RE = /(?:doflow-run|\$\{?DOFLOW\}?"?)\s+([a-z][a-z-]*)/g;
const PLACEHOLDER_RE = /[<>{}*?|$]|\.\.\.|…|NNN/;
const ANCHORED_RE: any = new RegExp('^(core|src|bin|test|docs|bench|\\.doflow)/'
  + '|^(rules|modes|references|mcp|pointers|scripts|languages|content-types|templates|workflows|agent-specs)/[A-Za-z0-9_.-]+\\.[a-z]+$');
const OWNED_NAME_RE = /^([A-Z][A-Z0-9_]+\.md|[a-z0-9-]+-template\.md|[a-z0-9_-]+\.(sh|py|js))$/;
const INSTALLED_PATHS: any = [
  ['.doflow/guidance/', `${SHARED}/guidance/`],
  ['.doflow/scripts/', `${SHARED}/scripts/`],
  ['.doflow/templates/', `${SHARED}/templates/`],
  ['.doflow/', `${SHARED}/`],
];

const posix = (p: any) => p.split(path.sep).join('/');

/** Every file under `dir` (repo-relative, forward slashes) the `keep` predicate accepts. */
function walk(dir: any, keep: any, out: any = []) {
  for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel: any = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (keep(rel, true)) walk(rel, keep, out); continue; }
    if (keep(rel, false)) out.push(rel);
  }
  return out;
}

/** The prose the lint reads: guidance, skills (fixture directories aside) and agent specs. */
function lintFiles() {
  const isMarkdown = (rel: any, isDir: any) => isDir || rel.endsWith('.md');
  const rels: any = [
    ...walk(GUIDANCE_REL, isMarkdown),
    ...walk(`${SHARED}/skills`, (rel: any, isDir: any) => (isDir ? !FIXTURE_DIRS.has(path.posix.basename(rel)) : rel.endsWith('.md'))),
    ...walk(`${SHARED}/agent-specs`, (rel: any, isDir: any) => !isDir && rel.endsWith('.md')),
  ];
  return rels.map((rel: any) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') }));
}

/** The prose the harness-name check reads: lintFiles' roots plus the templates the installer ships. */
function harnessNameFiles() {
  const roots: any = ['guidance', 'skills', 'agent-specs', 'templates'];
  const skipFixtures = (rel: any, isDir: any) => (isDir ? !FIXTURE_DIRS.has(path.posix.basename(rel)) : rel.endsWith('.md'));
  return roots.flatMap((root: any) => walk(`${SHARED}/${root}`, skipFixtures)
    .map((rel: any) => ({ root, rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') })));
}

/** Registry display names by harness id. */
function harnessDisplayNames() {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/harnesses.json'), 'utf8'));
  return new Map(registry.harnesses.map((h: any) => [h.id, h.displayName]));
}

/** Paragraphs (blank-line separated, fenced code included) as `{ line, text }`, `line` being the first line. */
function paragraphs(text: any): any {
  const out: any = [];
  let current: any = null;
  text.split('\n').forEach((line: any, i: any): any => {
    if (!line.trim()) { current = null; return; }
    if (!current) { current = { line: i + 1, text: line }; out.push(current); } else current.text += `\n${line}`;
  });
  return out;
}

/** Paragraphs naming a harness-only name without naming that harness: `rel:line name`. */
function harnessNameFindings(entries: any, files: any, displayNames: any) {
  const findings: any = [];
  for (const { rel, text } of files) {
    for (const para of paragraphs(text)) {
      for (const { name, harness } of entries) {
        if (para.text.includes(name) && !para.text.includes(displayNames.get(harness))) findings.push(`${rel}:${para.line} ${name}`);
      }
    }
  }
  return findings;
}

/** The resolver's view of the repository: whether a repo-relative path exists, and which basenames ship. */
function repoContext() {
  const basenames: any = new Set(['core', 'src', 'bin'].flatMap((root) => walk(root, () => true))
    .map((rel) => path.posix.basename(rel)));
  return { exists: (rel: any) => fs.existsSync(path.join(REPO, rel)), basenames };
}

/** Verb and path references in one file: `{ verbs: [{ line, verb }], paths: [{ line, token }] }`. */
function extractReferences(text: any): any {
  const verbs: any = [];
  const paths: any = [];
  text.split('\n').forEach((line: any, i: any) => {
    for (const [, verb] of line.matchAll(VERB_RE)) verbs.push({ line: i + 1, verb });
    for (const [, raw] of line.matchAll(/`([^`\s]+)`/g)) {
      const token = raw.replace(/[),.:;]+$/, '').replace(/^\.\//, '');
      if (PLACEHOLDER_RE.test(token)) continue;
      if (ANCHORED_RE.test(token) || (!token.includes('/') && OWNED_NAME_RE.test(token))) paths.push({ line: i + 1, token });
    }
  });
  return { verbs, paths };
}

/** Whether `token`, cited from `rel`, names something that ships. */
function resolves(token: any, rel: any, { exists, basenames }: any) {
  let mapped = token;
  for (const [installed, source] of INSTALLED_PATHS) {
    if (mapped.startsWith(installed)) { mapped = source + mapped.slice(installed.length); break; }
  }
  const skillRoot = rel.startsWith(`${SHARED}/skills/`) ? rel.split('/').slice(0, 4).join('/') : null;
  const candidates = [
    mapped, `${GUIDANCE_REL}/${mapped}`, path.posix.join(path.posix.dirname(rel), mapped),
    skillRoot && `${skillRoot}/${mapped}`, `${SHARED}/${mapped}`,
  ].filter(Boolean).map((candidate) => path.posix.normalize(candidate).replace(/\/$/, ''));
  if (candidates.some((candidate) => exists(candidate))) return true;
  return !token.includes('/') && OWNED_NAME_RE.test(token) && basenames.has(token);
}

const PATH_ENTRY_KEYS: any = new Set(['kind', 'target', 'match', 'files', 'reason']);
const PAIR_KEYS: any = new Set(['id', 'a', 'b', 'reason']);
const NAME_KEYS: any = new Set(['name', 'harness']);
const isEntry = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const blank = (value: any) => typeof value !== 'string' || !value.trim();

function compiles(source: any, flags: any = '') {
  try { return new RegExp(source, flags); } catch { return null; }
}

/** Structural problems of the policy, each naming its entry; empty when it is well formed. */
function policyProblems(policy: any, exists: any, harnessIds: any = harnessDisplayNames()) {
  const problems: any = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['policy: not a JSON object'];
  for (const key of Object.keys(policy)) {
    if (!['allow', 'pairs', 'harnessOnlyNames'].includes(key)) problems.push(`policy: unknown top-level key "${key}"`);
  }
  const allow = policy.allow ?? [];
  if (!Array.isArray(allow)) problems.push('allow: not an array');
  else allow.forEach((entry, i) => {
    const at = `allow[${i}]`;
    if (!isEntry(entry)) { problems.push(`${at}: not an object`); return; }
    for (const key of Object.keys(entry)) if (!PATH_ENTRY_KEYS.has(key)) problems.push(`${at}: unknown key "${key}"`);
    for (const key of ['target', 'reason']) if (blank(entry[key])) problems.push(`${at}: missing or blank ${key}`);
    if (!['path', 'verb'].includes(entry.kind)) problems.push(`${at}: kind must be "path" or "verb"`);
    if (entry.match !== undefined && !['exact', 'regex'].includes(entry.match)) problems.push(`${at}: match must be "exact" or "regex"`);
    if (entry.match === 'regex' && !blank(entry.target) && !compiles(entry.target)) problems.push(`${at}: target is not a valid regex`);
    if (entry.files !== undefined) {
      if (!Array.isArray(entry.files)) problems.push(`${at}: files must be an array`);
      else for (const file of entry.files) if (!exists(file)) problems.push(`${at}: files entry ${file} does not exist`);
    }
  });
  const names = policy.harnessOnlyNames ?? [];
  if (!Array.isArray(names)) problems.push('harnessOnlyNames: not an array');
  else names.forEach((entry, i) => {
    const at = `harnessOnlyNames[${i}]`;
    if (!isEntry(entry)) { problems.push(`${at}: not an object`); return; }
    for (const key of Object.keys(entry)) if (!NAME_KEYS.has(key)) problems.push(`${at}: unknown key "${key}"`);
    if (blank(entry.name)) problems.push(`${at}: missing or blank name`);
    if (!harnessIds.has(entry.harness)) problems.push(`${at}: unknown harness "${entry.harness}"`);
  });
  if (!Array.isArray(policy.pairs) || policy.pairs.length === 0) problems.push('pairs: empty or missing; the lint would guard nothing');
  else {
    const seen: any = new Set();
    policy.pairs.forEach((pair: any, i: any) => {
      const at = `pairs[${i}]`;
      if (!isEntry(pair)) { problems.push(`${at}: not an object`); return; }
      for (const key of Object.keys(pair)) if (!PAIR_KEYS.has(key)) problems.push(`${at}: unknown key "${key}"`);
      for (const key of ['id', 'a', 'b', 'reason']) if (blank(pair[key])) problems.push(`${at}: missing or blank ${key}`);
      for (const side of ['a', 'b']) {
        if (!blank(pair[side]) && !compiles(pair[side], 'i')) problems.push(`${at}: ${side} is not a valid regex`);
      }
      if (!blank(pair.id) && seen.has(pair.id)) problems.push(`${at}: duplicate id ${pair.id}`);
      seen.add(pair.id);
    });
  }
  return problems;
}

// A `..` segment is refused before any entry is consulted: an allow regex anchored on a prefix
// would otherwise swallow a token that walks out of it.
const suppresses = (entry: any, kind: any, token: any, rel: any) => entry.kind === kind
  && !token.split('/').includes('..')
  && (entry.match === 'regex' ? new RegExp(entry.target).test(token) : entry.target === token)
  && (!entry.files || entry.files.includes(rel));

/** Every pair whose two sides each match a line somewhere in `files`: the findings, and what each side matched. */
function pairFindings(pairs: any, files: any) {
  const lines = files.flatMap(({ rel, text }: any) => text.split('\n').map((line: any, i: any) => ({ rel, line: i + 1, text: line })));
  const locations = (source: any) => {
    const re: any = new RegExp(source, 'i');
    return lines.map(({ rel, line, text }: any) => ({ rel, line, hit: text.match(re)?.[0] })).filter(({ hit }: any) => hit);
  };
  const problems: any = [];
  const findings: any = [];
  for (const { id, a, b, reason } of pairs) {
    const sideA = locations(a);
    const sideB = locations(b);
    if (!sideA.length && !sideB.length) problems.push(`pair ${id}: neither side matches; the pair guards nothing`);
    for (const x of sideA) {
      for (const y of sideB) findings.push(`${id}: ${x.rel}:${x.line} "${x.hit}" vs ${y.rel}:${y.line} "${y.hit}" (${reason})`);
    }
  }
  return { problems, findings };
}

/** The whole lint over in-memory input. Returns every problem and the counts it measured. */
function lint({ policy, files, context, verbs }: any) {
  const problems = policyProblems(policy, context.exists);
  if (problems.length) return { problems, stats: null };
  const allow = policy.allow ?? [];
  const used: any = new Set();
  const suppressed = (kind: any, token: any, rel: any) => {
    const at = allow.findIndex((entry: any) => suppresses(entry, kind, token, rel));
    if (at >= 0) used.add(at);
    return at >= 0;
  };
  const stats: any = { verbs: 0, paths: 0, resolved: 0, flagged: 0 };
  for (const { rel, text } of files) {
    const refs = extractReferences(text);
    for (const { line, verb } of refs.verbs) {
      stats.verbs += 1;
      if (!verbs.has(verb) && !suppressed('verb', verb, rel)) problems.push(`${rel}:${line} -> doflow-run ${verb} (unknown verb)`);
    }
    for (const { line, token } of refs.paths) {
      stats.paths += 1;
      if (resolves(token, rel, context)) { stats.resolved += 1; continue; }
      stats.flagged += 1;
      if (!suppressed('path', token, rel)) problems.push(`${rel}:${line} -> ${token} (no such path)`);
    }
  }
  for (const kind of ['verb', 'path']) {
    if (!stats[`${kind}s`]) problems.push(`the lint parsed no ${kind} references; its grammar has stopped matching the shipped prose`);
  }
  allow.forEach((entry: any, i: any) => {
    if (!used.has(i)) problems.push(`allow[${i}] ${entry.target}: matches nothing; delete it`);
  });
  const pairs = pairFindings(policy.pairs, files);
  problems.push(...pairs.problems, ...pairs.findings);
  return { problems, stats };
}

const readPolicy = () => JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
const policyExists = (rel: any) => fs.existsSync(path.join(REPO, rel));

test('G24: the shipped instructions cite only verbs and paths that exist, and hold no opposing defaults', (t) => {
  const started = process.hrtime.bigint();
  const policy = readPolicy();
  const files = lintFiles();
  assert.ok(files.length > 0, 'no instruction files read; the lint below would measure nothing');
  const { problems, stats } = lint({ policy, files, context: repoContext(), verbs: dispatcherVerbs() });
  if (stats) {
    t.diagnostic(`instruction lint: ${files.length} files; ${stats.verbs} verb references; ${stats.paths} path references `
      + `${stats.resolved} resolved, ${stats.flagged} flagged by the ${policy.allow.length} allow entries; ${policy.pairs.length} pairs; `
      + `${Math.round(Number(process.hrtime.bigint() - started) / 1e6)} ms`);
  }
  assert.deepEqual(problems, [], `instruction lint findings:\n  ${problems.join('\n  ')}`);
});

test('G24: harness-only names appear only beside their harness, in every shipped prose root', () => {
  const entries = readPolicy().harnessOnlyNames;
  assert.ok(entries.length > 0, 'no harnessOnlyNames; the check would guard nothing');
  const files = harnessNameFiles();
  for (const root of ['guidance', 'skills', 'agent-specs', 'templates']) {
    assert.ok(files.some((f: any) => f.root === root), `no ${root} file scanned; the check would measure nothing there`);
  }
  assert.deepEqual(harnessNameFindings(entries, files, harnessDisplayNames()), []);
});

test('G24: dispatcherVerbs reads the shell-backed and Node-backed verb tables', () => {
  const verbs = dispatcherVerbs();
  for (const verb of ['paths', 'validate', 'evidence', 'lifecycle', 'help']) assert.ok(verbs.has(verb), `missing verb ${verb}`);
});

const FIXTURE_CONTEXT: any = { exists: (rel: any) => rel === 'core/shared/present.md', basenames: new Set(['owned.sh']) };
const FIXTURE_VERBS: any = new Set(['paths', 'help']);
const FIXTURE_POLICY: any = { allow: [], pairs: [{ id: 'p', a: 'alpha', b: 'beta', reason: 'fixture' }] };
const run = (text: any, policy: any = FIXTURE_POLICY, rel: any = 'core/shared/guidance/x.md') => lint({
  policy: { ...FIXTURE_POLICY, ...policy }, files: [{ rel, text }], context: FIXTURE_CONTEXT, verbs: FIXTURE_VERBS,
}).problems;

// Sample lines that make each shipped pair fire, so every pair in instruction-lint.json is proven able to.
const PAIR_SAMPLES: any = {
  'default-vs-disjoint-parallelism': ['Parallel by default', 'disjoint write sets'],
  'imposed-layout-vs-project-conventions': ['tests → `tests/', 'existing code conventions'],
  'confidence-bands-vs-no-confidence': ['confidence-banded estimates', 'percentage certainty'],
  'ask-only-vs-always-ask': ['Ask ONLY for decisions', 'Always ask first'],
  'continue-vs-wait-at-plan': ['continue into execution', 'wait for approval again'],
  'incremental-vs-no-commit': ['Commit incrementally', 'never commit'],
};
// Ordinary prose near each pair's second side, which must not fire it.
const PAIR_NEAR_MISSES: any = {
  'default-vs-disjoint-parallelism': 'Parallel work runs when write sets are disjoint.',
  'imposed-layout-vs-project-conventions': 'Follow the repository\'s existing conventions for new modules.',
  'confidence-bands-vs-no-confidence': 'Use numeric certainty only when the evidence supports it.',
  'ask-only-vs-always-ask': 'Ask one question at a time.',
  'continue-vs-wait-at-plan': 'At each gate, wait for approval before the next phase.',
  'incremental-vs-no-commit': ['Do not commit secrets or .env files.', 'All mutating operations require explicit confirmation.'],
};

test('G24: controls — the lint sees an unresolved path, an unknown verb and coexisting defaults', () => {
  const ref = 'core/shared/guidance/x.md';
  assert.deepEqual(run('see `core/shared/no-such.md` here').filter((p: any) => p.includes('no such')),
    [`${ref}:1 -> core/shared/no-such.md (no such path)`]);
  assert.deepEqual(run('see `core/shared/present.md`, then `owned.sh`.').filter((p: any) => p.includes('no such')), []);
  assert.deepEqual(run('run doflow-run paths and doflow-run no-such-verb').filter((p: any) => p.includes('unknown')),
    [`${ref}:1 -> doflow-run no-such-verb (unknown verb)`]);

  const both = lint({
    policy: FIXTURE_POLICY, files: [{ rel: 'a.md', text: 'one alpha' }, { rel: 'b.md', text: 'x\nbeta two' }],
    context: FIXTURE_CONTEXT, verbs: FIXTURE_VERBS,
  }).problems.filter((p: any) => p.startsWith('p:'));
  assert.deepEqual(both, ['p: a.md:1 "alpha" vs b.md:2 "beta" (fixture)']);

  assert.deepEqual(run('nothing here'), [
    'the lint parsed no verb references; its grammar has stopped matching the shipped prose',
    'the lint parsed no path references; its grammar has stopped matching the shipped prose',
    'pair p: neither side matches; the pair guards nothing',
  ]);
});

test('G24: controls — every shipped pair fires on a fixture holding both sides', () => {
  const { pairs } = readPolicy();
  assert.deepEqual(pairs.map(({ id }: any) => id).sort(), Object.keys(PAIR_SAMPLES).sort(), 'a shipped pair has no control sample');
  for (const pair of pairs) {
    const [a, b]: any = PAIR_SAMPLES[pair.id];
    const { findings } = pairFindings([pair], [{ rel: 'a.md', text: a }, { rel: 'b.md', text: b }]);
    assert.equal(findings.length, 1, `pair ${pair.id} did not fire on its sample`);
    assert.equal(pairFindings([pair], [{ rel: 'a.md', text: a }]).findings.length, 0, `pair ${pair.id} fired on one side`);
    for (const miss of [PAIR_NEAR_MISSES[pair.id]].flat()) {
      assert.equal(pairFindings([pair], [{ rel: 'a.md', text: a }, { rel: 'b.md', text: miss }]).findings.length, 0,
        `pair ${pair.id} fired on ordinary prose: ${miss}`);
    }
  }
  assert.deepEqual(Object.keys(PAIR_NEAR_MISSES).sort(), Object.keys(PAIR_SAMPLES).sort(), 'a shipped pair has no near-miss control');
});

test('G24: controls — the parallelism pair also catches parallel-first prose and not its near miss', () => {
  const pair = readPolicy().pairs.find(({ id }: any) => id === 'default-vs-disjoint-parallelism');
  const withB = (text: any) => pairFindings([pair], [{ rel: 'a.md', text }, { rel: 'b.md', text: 'disjoint write sets' }]).findings.length;
  assert.equal(withB('**Performance requests**: Parallel-first approach'), 1);
  assert.equal(withB('Performance requests: parallel first approach'), 1);
  assert.equal(withB('Performance requests: parallelize the disjoint parts; run the first parallel batch after the reads.'), 0);
});

test('G24: controls — an allow entry suppresses what it names and fails when it matches nothing', () => {
  const text = 'see `core/shared/gone.md` and doflow-run paths, alpha';
  const entry: any = { kind: 'path', target: 'core/shared/gone.md', reason: 'fixture' };
  assert.deepEqual(run(text, { allow: [entry] }), []);
  assert.deepEqual(run(text, { allow: [{ ...entry, target: '^core/shared/gone', match: 'regex' }] }), []);
  assert.deepEqual(run(text, { allow: [{ ...entry, files: ['core/shared/present.md'] }] }).length, 2);

  const stale: any = run(text, { allow: [entry, { kind: 'path', target: 'never-cited.md', reason: 'fixture' }] });
  assert.deepEqual(stale, ['allow[1] never-cited.md: matches nothing; delete it']);

  const state: any = { kind: 'path', target: '^\\.doflow/state/', match: 'regex', reason: 'fixture' };
  const walkOut: any = run('see `.doflow/state/x.md` and `.doflow/state/../guidance/NOPE.md` and doflow-run paths, alpha', { allow: [state] });
  assert.deepEqual(walkOut, ['core/shared/guidance/x.md:1 -> .doflow/state/../guidance/NOPE.md (no such path)'],
    'an allow regex does not swallow a token that walks out of its prefix with ..');
});

test('G24: controls — placeholder tokens are not path references', () => {
  const { paths } = extractReferences('`core/shared/<name>.md` `core/{a,b}.md` `core/*.md` `core/shared/NNN-x.md` `$HOME/x.md` `core/shared/real.md`');
  assert.deepEqual(paths.map(({ token }: any) => token), ['core/shared/real.md']);
});

test('G24: controls — a malformed policy fails closed, naming the entry', () => {
  const problems = (policy: any) => policyProblems(policy, policyExists);
  const good: any = { kind: 'path', target: 'x.md', reason: 'r' };
  assert.deepEqual(problems({ allow: [good], pairs: FIXTURE_POLICY.pairs }), []);
  assert.deepEqual(problems({ allow: [{ ...good, reason: '  ' }], pairs: FIXTURE_POLICY.pairs }), ['allow[0]: missing or blank reason']);
  assert.deepEqual(problems({ allow: [], pairs: [] }), ['pairs: empty or missing; the lint would guard nothing']);
  assert.deepEqual(problems({ extra: 1, pairs: FIXTURE_POLICY.pairs }), ['policy: unknown top-level key "extra"']);
  assert.deepEqual(problems({ allow: [{ ...good, extra: 1 }], pairs: FIXTURE_POLICY.pairs }), ['allow[0]: unknown key "extra"']);
  assert.deepEqual(problems({ allow: [{ ...good, kind: 'file' }], pairs: FIXTURE_POLICY.pairs }), ['allow[0]: kind must be "path" or "verb"']);
  assert.deepEqual(problems({ allow: [{ ...good, match: 'glob' }], pairs: FIXTURE_POLICY.pairs }), ['allow[0]: match must be "exact" or "regex"']);
  assert.deepEqual(problems({ allow: [{ ...good, match: 'regex', target: '(' }], pairs: FIXTURE_POLICY.pairs }), ['allow[0]: target is not a valid regex']);
  assert.deepEqual(problems({ allow: [{ ...good, files: ['no/such/file.md'] }], pairs: FIXTURE_POLICY.pairs }),
    ['allow[0]: files entry no/such/file.md does not exist']);
  const pair = FIXTURE_POLICY.pairs[0];
  assert.deepEqual(problems({ pairs: [pair, { ...pair }] }), ['pairs[1]: duplicate id p']);
  assert.deepEqual(problems({ pairs: [{ ...pair, a: '(' }] }), ['pairs[0]: a is not a valid regex']);
  assert.deepEqual(problems({ pairs: [{ ...pair, b: '' }] }), ['pairs[0]: missing or blank b']);
  assert.deepEqual(problems({ allow: [null, 'x', [good]], pairs: FIXTURE_POLICY.pairs }),
    ['allow[0]: not an object', 'allow[1]: not an object', 'allow[2]: not an object']);
  assert.deepEqual(problems({ pairs: [null, pair] }), ['pairs[0]: not an object']);
});

test('G24: controls — a harness-only name needs its harness in the same paragraph', () => {
  const entries: any = [{ name: 'TodoWrite', harness: 'claude' }];
  const names: any = new Map([['claude', 'Claude Code']]);
  const find = (text: any) => harnessNameFindings(entries, [{ rel: 'x.md', text }], names);
  assert.deepEqual(find('Use TodoWrite here.'), ['x.md:1 TodoWrite']);
  assert.deepEqual(find('intro\n\nUse TodoWrite here.'), ['x.md:3 TodoWrite']);
  assert.deepEqual(find('Use TodoWrite here in Claude Code.'), []);
  assert.deepEqual(find('On Claude Code only:\nTodoWrite is the list tool.'), []);
  assert.deepEqual(find('Claude Code is named here.\n\nUse TodoWrite here.'), ['x.md:3 TodoWrite'], 'a neighbouring paragraph does not count');
  assert.deepEqual(harnessNameFindings(entries, [{ rel: 'x.md', text: 'Use TodoWrite in Codex.' }], new Map([['claude', 'Claude Code'], ['codex', 'Codex']])),
    ['x.md:1 TodoWrite'], 'another harness name does not qualify the name');
});

test('G24: controls — harnessOnlyNames fails closed on unknown keys and harness ids', () => {
  const pairs = FIXTURE_POLICY.pairs;
  const ids: any = new Map([['claude', 'Claude Code']]);
  const problems = (names: any) => policyProblems({ harnessOnlyNames: names, pairs }, policyExists, ids);
  assert.deepEqual(problems([{ name: 'TodoWrite', harness: 'claude' }]), []);
  assert.deepEqual(problems([{ name: 'TodoWrite', harness: 'claude', extra: 1 }]), ['harnessOnlyNames[0]: unknown key "extra"']);
  assert.deepEqual(problems([{ name: 'TodoWrite', harness: 'nope' }]), ['harnessOnlyNames[0]: unknown harness "nope"']);
  assert.deepEqual(problems([{ name: ' ', harness: 'claude' }]), ['harnessOnlyNames[0]: missing or blank name']);
  assert.deepEqual(problems('x'), ['harnessOnlyNames: not an array']);
  assert.deepEqual(problems([null]), ['harnessOnlyNames[0]: not an object']);
});

// 107-B review C-9: a byte-neutral rewording left "response to any / the question tool means" in
// do-flow's SKILL.md. A reworded sentence that keeps the old determiner is a grammar defect no other
// guard sees, so the instruction prose may not carry a doubled determiner.
const DOUBLED_DETERMINER = /\b(?:any|an?)\s+(?:the|an?)\b/gi;

test('G24: instruction prose has no doubled determiner ("any the", "a the")', () => {
  const findings = harnessNameFiles().flatMap(({ rel, text }: any) => {
    return [...text.matchAll(DOUBLED_DETERMINER)].map((match) => `${rel}:${text.slice(0, match.index).split('\n').length} "${match[0].replace(/\s+/g, ' ')}"`);
  });
  assert.deepEqual(findings, []);
});

test('G24 control: the doubled-determiner check sees the broken sentence across a line break', () => {
  const broken = 'an unanswered or unclear response to any\n   the question tool means stop';
  assert.equal([...broken.matchAll(DOUBLED_DETERMINER)].length, 1);
  assert.equal([...'a response to the question tool means stop'.matchAll(DOUBLED_DETERMINER)].length, 0);
});

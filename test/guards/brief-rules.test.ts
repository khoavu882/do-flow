'use strict';

// G78 — worker briefs carry the must-carry rules (row 135 item 3).
//
// `core/shared/guidance/rules/RULES.md` marks 3 to 5 lines `<!-- must-carry -->`. An installed runtime
// has no `core/shared/`, so `src/runtime/brief-rules.ts --write` copies those lines into
// the `mustCarry` key of `core/registry/rules.json`, and `renderBriefTools` prints them under "Rules that apply to you"
// in every task and group brief. This guard keeps the committed copy equal to its source, the count in
// range, and the rendered brief carrying every line; the controls run on temp copies.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO, AGENT_SPECS } = require('./_shared.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { tempDir } = require('../helper/tmp.ts');
const { SOURCE_REL, TARGET_REL, MARKER, mustCarryLines, compileBriefRules, main } = require('../../src/runtime/brief-rules.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { CapabilityRouter } = require('../../src/runtime/capability-router.ts');
const { renderBriefTools } = require('../../src/runtime/brief-tools.ts');

const source = fs.readFileSync(path.join(REPO, SOURCE_REL), 'utf8');
const committed = fs.readFileSync(path.join(REPO, TARGET_REL), 'utf8');

/** A scratch repo root holding copies of the source and the committed file. */
function scratchRoot(t: any, { sourceText = source, json = committed as string | null } = {}) {
  const root = tempDir(t, 'doflow-brief-rules-');
  fs.mkdirSync(path.join(root, path.dirname(SOURCE_REL)), { recursive: true });
  fs.mkdirSync(path.join(root, path.dirname(TARGET_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, SOURCE_REL), sourceText);
  if (json !== null) fs.writeFileSync(path.join(root, TARGET_REL), json);
  return root;
}

function render(root: string) {
  const router = new CapabilityRouter({ repoRoot: REPO, projectRoot: root });
  const probes: any = {};
  for (const capability of Object.values<any>(router.capabilities)) {
    for (const provider of capability.providers) probes[provider.id] = { id: provider.id, status: 'HEALTHY' };
  }
  return renderBriefTools({ registry: loadRegistry({ repoRoot: REPO }), router, probes, reach: null, owner: 'core-implementer', stage: null, repoRoot: root });
}

function silently<T>(run: () => T): T {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as any;
  try { return run(); } finally { process.stderr.write = write; }
}

test('G78 (a): the committed rules.json mustCarry key equals the generator output from RULES.md', () => {
  assert.equal(committed, compileBriefRules(source, committed),
    `${TARGET_REL} mustCarry is stale; run node src/runtime/brief-rules.ts --write`);
});

test('G78 (b): RULES.md marks 3 to 5 lines', () => {
  const count = mustCarryLines(source).length;
  assert.ok(count >= 3 && count <= 5, `${SOURCE_REL} marks ${count} lines; expected 3 to 5`);
});

test('G78 (c): the rendered brief carries every must-carry line, before the tier block', () => {
  const { markdown, record } = render(REPO);
  const lines = mustCarryLines(source);
  for (const line of lines) assert.ok(markdown.includes(`- ${line}\n`), `brief lacks: ${line}`);
  assert.ok(markdown.startsWith('## Rules that apply to you\n\n'));
  assert.ok(markdown.indexOf(lines[lines.length - 1]) < markdown.indexOf('## Tier and tools'));
  assert.deepEqual(record.missing.filter((m: string) => m.startsWith('brief-rules')), []);
});

test('G78 control: an edited marked line turns (a) red', (t) => {
  const root = scratchRoot(t, { sourceText: source.replace('Start it = Finish it.', 'Start it = Finish it, always.') });
  assert.equal(silently(() => main(['--check'], root)), 1);
});

test('G78 control: a sixth marker turns (b) red and the generator refuses', (t) => {
  const extra = `${source}\n- one more rule${MARKER}\n- and another${MARKER}\n`;
  assert.ok(mustCarryLines(extra).length > 5);
  assert.throws(() => compileBriefRules(extra, committed), /expected 3 to 5/);
  const root = scratchRoot(t, { sourceText: extra });
  assert.throws(() => main(['--write'], root), /expected 3 to 5/);
});

test('G78 control: a ledger without mustCarry drops the block and names it in missing, without throwing', (t) => {
  const root = scratchRoot(t, { json: null });
  const { markdown, record } = render(root);
  assert.ok(!markdown.includes('Rules that apply to you'));
  assert.ok(markdown.startsWith('## Tier and tools\n'));
  assert.ok(record.missing.some((m: string) => m.startsWith('brief-rules: ')), JSON.stringify(record.missing));
});

test('G78 control: an unreadable ledger is a missing entry, not a throw', (t) => {
  const root = scratchRoot(t, { json: '{ not json' });
  const { markdown, record } = render(root);
  assert.ok(!markdown.includes('Rules that apply to you'));
  assert.ok(record.missing.some((m: string) => m.startsWith('brief-rules: ')));
});

test('G78 control: a ledger without the mustCarry key is a missing entry', (t) => {
  const { mustCarry, mustCarryNote, ...rest } = JSON.parse(committed);
  const { markdown, record } = render(scratchRoot(t, { json: JSON.stringify(rest) }));
  assert.ok(!markdown.includes('Rules that apply to you'));
  assert.ok(record.missing.some((m: string) => m.startsWith('brief-rules: ')));
});

test('G78: the CLI exits 0 on a written copy, 1 on a stale one, 2 on bad usage; --write changes only the mustCarry keys', (t) => {
  const root = scratchRoot(t, { json: JSON.stringify({ ...JSON.parse(committed), mustCarry: [], mustCarryNote: 'x' }, null, 2) + '\n' });
  assert.equal(silently(() => main(['--check'], root)), 1);
  assert.equal(main(['--write'], root), 0);
  assert.equal(main(['--check'], root), 0);
  assert.equal(fs.readFileSync(path.join(root, TARGET_REL), 'utf8'), committed);
  assert.equal(silently(() => main([], root)), 2);
});

// --- the real do-task-brief.sh (finding: the fallback printed no rules) ----------------------------

const SCRIPT = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-task-brief.sh');
const FEATURE = '001-auth';
const EXEC = `agent-docs/doflow/${FEATURE}/exec`;
const PLAN = `## 1. Approach
Bottom-up.
## 7. Validation Strategy
| Requirement | Verified by |
|---|---|
| FR-001 | integration test on the login route |
## 8. Tasks
### Phase A — auth
- [ ] A.1 [P] [US1] build the handler — owner: core-implementer; tier: frontier; files: src/auth.js
- [ ] A.2 [P] [US1] second — owner: core-implementer; tier: frontier; files: src/b.js
- [ ] A.5 [US1] no owner here — files: src/e.js
### Checkpoints
- After Phase A: run the suite
`;
const REQUIREMENT = `## 2. User Stories
- **US1 (P1):** As a user, I want to log in.
## 3. Functional Requirements
| ID | Requirement | Story | Priority | Status |
|---|---|---|---|---|
| FR-001 | login endpoint | US1 | P1 | Live |
**Detail**
- **FR-001:** The system MUST accept a POST.
## 5. Out of Scope
`;
const scratch = createScratch('doflow-brief-rules-');
let dirCount = 0;
/** A new empty folder under the scratch root. */
const freshDir = (name: string) => { const dir = path.join(scratch.dir, `${name}-${(dirCount += 1)}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
after(() => scratch.remove());

/** A scratch project on a feature branch with a plan; returns the briefs the script writes (the real one unless `script` is given). */
function project(script = SCRIPT) {
  const dir = freshDir('p');
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: dir, encoding: 'utf8', env: scratch.env() });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('checkout', '-q', '-b', `feat/${FEATURE}`);
  const featureDir = path.join(dir, 'agent-docs', 'doflow', FEATURE);
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'plan.md'), PLAN);
  fs.writeFileSync(path.join(featureDir, 'requirement.md'), REQUIREMENT);
  return (args: string[], rel: string) => {
    const res = spawnSync('bash', [script, ...args, `--slug=${FEATURE}`], {
      cwd: dir, encoding: 'utf8', timeout: 300000, env: scratch.env({ DOFLOW_CLI: path.join(REPO, 'bin', 'doflow.js') }),
    });
    assert.equal(res.status, 0, res.stderr);
    return { data: JSON.parse(res.stdout), md: fs.readFileSync(path.join(dir, EXEC, rel), 'utf8') };
  };
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const ruleFindings = (md: string, lines: string[]) => lines.filter((line) => occurrences(md, `- ${line}\n`) !== 1);

test('G78 (d): the real script gives a task brief with an owner, one without and a group brief every must-carry line once', () => {
  const lines = mustCarryLines(source);
  const brief = project();
  const owned = brief(['--task=A.1'], 'task-A.1-brief.md');
  assert.doesNotMatch(owned.md, /Not generated/, 'the verb produced the block');
  assert.deepEqual(ruleFindings(owned.md, lines), [], 'task with an owner');
  const unowned = brief(['--task=A.5'], 'task-A.5-brief.md');
  assert.match(unowned.md, /Not generated: the task line names no owner/, 'the static fallback');
  assert.deepEqual(ruleFindings(unowned.md, lines), [], 'task without an owner');
  assert.deepEqual(unowned.data.missing.filter((m: string) => m.startsWith('brief-rules')), []);
  const group = brief(['--group=A:core-implementer', '--tasks=A.1,A.2'], 'group-A-core-implementer-brief.md');
  assert.deepEqual(ruleFindings(group.md, lines), [], 'group brief');
  assert.match(group.md, /^### Rules that apply to you$/m);
  assert.match(unowned.md, /^## Rules that apply to you\n/m);
});

test('G78 control: a script with no rule ledger above it still writes the brief and names the loss in missing', () => {
  const tree = freshDir('tree');
  fs.cpSync(path.dirname(SCRIPT), path.join(tree, 'doflow', 'bash'), { recursive: true });
  const { data, md } = project(path.join(tree, 'doflow', 'bash', 'do-task-brief.sh'))(['--task=A.5'], 'task-A.5-brief.md');
  assert.match(md, /Not generated: the task line names no owner/);
  assert.doesNotMatch(md, /Rules that apply to you/);
  assert.ok(data.missing.some((m: string) => /^brief-rules: .*rules\.json/.test(m)), JSON.stringify(data.missing));
});

// --- the report contract: tool evidence, then the final status line --------------------------------

const workflowIds = (): string[] => JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'workflows.json'), 'utf8')).agents.handback.statuses.map((x: any) => x.id);
const statusSentence = (subject: string, ids: string[]) => `End ${subject} with one line \`Status: <status>\`, where the status is one of ${ids.map((id) => `\`${id}\``).join(', ')}.`;

/** The "Report format" section of a brief: its heading line to the next heading or the end. */
function reportSection(md: string): string[] {
  const all = md.split('\n');
  const start = all.findIndex((l) => /^#{2,3} Report format$/.test(l));
  assert.ok(start >= 0, 'a Report format section');
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.trim() !== '');
}

/** Problems with one report section: Tools used before Status, and Status last and naming the registry ids. */
function contractFindings(section: string[], subject: string, ids: string[]): string[] {
  const out: string[] = [];
  const tools = section.findIndex((l) => l.startsWith('`Tools used: '));
  const status = section.findIndex((l) => l.includes('`Status: <status>`'));
  if (tools < 0) out.push('no Tools used line');
  if (status < 0) out.push('no Status line');
  if (tools >= 0 && status >= 0 && tools > status) out.push('Tools used comes after Status');
  if (section[section.length - 1] !== statusSentence(subject, ids)) out.push(`last line is not the status line for ${ids.join(', ')}: ${section[section.length - 1]}`);
  return out;
}

test('G78 (e): the rendered report format, the script fallback and the spec status line agree', () => {
  const ids = workflowIds();
  for (const [level, subject] of [[2, 'your report'], [3, "each task's report"]] as Array<[number, string]>) {
    const router = new CapabilityRouter({ repoRoot: REPO, projectRoot: REPO });
    const probes: any = {};
    for (const capability of Object.values<any>(router.capabilities)) for (const provider of capability.providers) probes[provider.id] = { id: provider.id, status: 'HEALTHY' };
    const { markdown } = renderBriefTools({ registry: loadRegistry({ repoRoot: REPO }), router, probes, reach: null, owner: 'core-implementer', stage: null, repoRoot: REPO, headingLevel: level });
    assert.deepEqual(contractFindings(reportSection(markdown), subject, ids), [], `rendered, heading level ${level}`);
  }
  const brief = project();
  const fallback = brief(['--task=A.5'], 'task-A.5-brief.md');
  assert.deepEqual(contractFindings(reportSection(fallback.md), 'your report', ids), [], 'single-task fallback');
  const group = brief(['--group=A:core-implementer', '--tasks=A.1,A.2'], 'group-A-core-implementer-brief.md');
  assert.deepEqual(contractFindings(reportSection(group.md), "each task's report", ids), [], 'group brief');
  // The spec's own status line is the same sentence with "the report" as its subject.
  for (const name of fs.readdirSync(AGENT_SPECS).filter((f: string) => f.endsWith('.md'))) {
    const last = fs.readFileSync(path.join(AGENT_SPECS, name), 'utf8').trimEnd().split('\n').pop();
    assert.equal(last, statusSentence('the report', ids), name);
  }
});

test('G78 control: Status before Tools used, a missing Status line and a stale enum each fail the contract check', () => {
  const ids = workflowIds();
  const good = ['Put one line naming every tool.', '`Tools used: <name>`', statusSentence('your report', ids)];
  assert.deepEqual(contractFindings(good, 'your report', ids), []);
  assert.match(contractFindings([good[0], good[2], good[1]], 'your report', ids).join('\n'), /Tools used comes after Status/);
  assert.match(contractFindings(good.slice(0, 2), 'your report', ids).join('\n'), /no Status line/);
  assert.match(contractFindings(good, 'your report', [...ids, 'partial']).join('\n'), /last line is not the status line/);
});

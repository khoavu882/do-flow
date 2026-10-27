'use strict';

// G13 — always-loaded context budget (feature 008, design C13 / FR-019, FR-020, risk RK4).
//
// Everything reachable from DOFLOW_CORE.md is loaded into *every* session on *every* one of the
// harnesses, before the user has typed anything. It is the only content in this repo whose
// cost is paid unconditionally, so it is the only content that needs a hard ceiling rather than
// review judgement. Phase D must add stopping rules and evidence discipline to this set, which
// means the existing prose has to give up roughly what the new material costs; this guard is what
// makes that a constraint during authoring rather than a discovery afterwards.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, GUIDANCE } = require('./_shared.ts');
const { GENERATED_EXCLUSIONS, alwaysLoaded, alwaysLoadedByHarness, readRegistry } = require('../helper/always-loaded.ts');
const { renderGuidancePointer } = require('../../src/adapters/guidance-pointer.ts');
const { WHOLESALE_ASSETS } = require('../../src/runtime/inventory/siblings.ts');

// The ceiling, in bytes, over the DoFlow-authored always-loaded set.
//
// 10,245 bytes — the measured total at the time design 008 was written, recorded in design §3 C13
// and risk RK4. It is deliberately the *current* size and not a round number with slack: the
// point is that the rewrite trades prose rather than accumulates it.
//
// Phase D is explicitly permitted to restructure, merge, split or entirely rewrite any file in
// this set. It is not permitted to grow the total. If the ceiling genuinely cannot hold, the
// agreed response (RK4) is one explicit, reviewed commit that raises this constant and states the
// new number and its cost — not a suppression, and not a quiet edit bundled into a prose diff.
const CEILING_BYTES = 7500;

function breakdown(files: any, total: any) {
  const width = Math.max(...files.map(({ rel }: any) => rel.length));
  const rows = files
    .slice()
    .sort((a: any, b: any) => b.bytes - a.bytes)
    .map(({ rel, bytes }: any) => `    ${rel.padEnd(width)}  ${String(bytes).padStart(6)}`);
  return [...rows, `    ${'TOTAL'.padEnd(width)}  ${String(total).padStart(6)}`].join('\n');
}

test('G13: the always-loaded set resolves from DOFLOW_CORE.md and every import exists', () => {
  const { files, dangling } = alwaysLoaded();
  assert.deepEqual(dangling, [],
    `DOFLOW_CORE.md imports files that do not exist:\n  ${dangling.join('\n  ')}`);
  // Guards the guard. If the @import syntax ever changes, the walk would find only the root file
  // and the budget check below would pass vacuously while measuring almost nothing — a green
  // suite that has stopped enforcing anything is worse than a red one.
  assert.ok(files.length > 1,
    `only ${files.length} always-loaded file(s) found — the @import parse in this guard has `
    + 'stopped matching DOFLOW_CORE.md\'s syntax, so the byte ceiling below is measuring nothing');
});

test('G13: the generated-file exclusion still names something the set actually imports', () => {
  const { excluded } = alwaysLoaded();
  const stale = [...GENERATED_EXCLUSIONS.keys()].filter((rel) => !excluded.includes(rel));
  assert.deepEqual(stale, [],
    'these files are excluded from the byte ceiling as install-generated, but nothing in the '
    + `always-loaded set imports them any more — delete the stale exclusion:\n  ${stale.join('\n  ')}`);
});

test('G13: the DoFlow-authored always-loaded set stays within its byte ceiling', () => {
  const { files } = alwaysLoaded();
  const total = files.reduce((sum: any, { bytes }: any) => sum + bytes, 0);
  assert.ok(total <= CEILING_BYTES,
    `always-loaded guidance is ${total} bytes, ${total - CEILING_BYTES} over the `
    + `${CEILING_BYTES}-byte ceiling. This content loads in every session on every harness.\n`
    + `${breakdown(files, total)}\n`
    + '  Restructuring this prose is expected and allowed; growing the total is not. Trade bytes\n'
    + '  out of the files above, or — if the ceiling genuinely cannot hold — raise CEILING_BYTES\n'
    + '  in this file in its own reviewed commit stating the new number and its cost (RK4).\n'
    + `  Excluded by design: ${[...GENERATED_EXCLUSIONS.keys()].join(', ')} (generated per install).`);
});

test('G13: the always-loaded size view reports lines and bytes per file and per harness projection', (t) => {
  const { files } = alwaysLoaded();
  for (const { rel, lines, bytes } of files) t.diagnostic(`always-loaded ${rel} ${lines} lines ${bytes} B`);
  const lines = files.reduce((n: any, file: any) => n + file.lines, 0);
  const bytes = files.reduce((n: any, file: any) => n + file.bytes, 0);
  t.diagnostic(`always-loaded TOTAL ${lines} lines ${bytes} B (ceiling ${CEILING_BYTES})`);

  const registry = readRegistry();
  const rows = alwaysLoadedByHarness(registry, WHOLESALE_ASSETS);
  assert.deepEqual(rows.map((row: any) => row.harness), registry.harnesses.map((harness: any) => harness.id),
    'the size view must report every harness of harnesses.json');
  for (const row of rows) {
    assert.ok(row.bytes > 0, `${row.harness} measured 0 bytes; its projection sources stopped resolving`);
    t.diagnostic(`projection ${row.harness} ${row.lines} lines ${row.bytes} B (${row.basis})`);
  }
});

test('G13: controls — a harness no condition matches is refused', () => {
  const { assets } = readRegistry();
  assert.throws(
    () => alwaysLoadedByHarness({ harnesses: [{ id: 'ghost' }], assets }, WHOLESALE_ASSETS),
    /no always-loaded rule for harness ghost; classify it in alwaysLoadedByHarness/);
  const [claude] = alwaysLoadedByHarness({ harnesses: [{ id: 'claude' }], assets }, WHOLESALE_ASSETS);
  assert.equal(claude.basis, 'pointer + @import walk');
  assert.ok(claude.bytes > alwaysLoaded().files.reduce((n: any, file: any) => n + file.bytes, 0),
    'a harness importing the walk must pay for the walk plus its pointer');
});

// ── G13 (IC-006): every harness loads the core set and a bounded overhead ────────────────────────
//
// 1,024 B: the most a harness may load beyond the core set itself. The legitimate overhead is the
// harness's pointer text (the claude and codex-family pointers), the per-file `applyTo` front
// matter Copilot's rule transform adds and the `trigger: always_on` header Antigravity's adds; a harness
// that loads a whole unselected tree (the shape before 107-B) exceeds it by orders of magnitude.
// Raising it needs the new number and its reason.
//
// The rows measure the pointer rendered at PROJECT scope (`.doflow/guidance`), so they do not depend on
// the machine. A GLOBAL install renders an absolute path (`<home>/.doflow/guidance`), which costs one
// byte per home character per `{{GUIDANCE}}` token in every pointer-carrying harness: the home-path
// test below derives how long a home may be before the tightest pointer row leaves this bound
// (about 250 characters today; a typical home is 10 to 40) and fails if the limit drops under 200.
const PROJECTION_OVERHEAD_MAX = 1024;

/** The rows of `rows` outside walk <= bytes <= walk + max, as readable strings naming the harness. */
function parityViolations(rows: any, max: any = PROJECTION_OVERHEAD_MAX) {
  const walkBytes = alwaysLoaded().files.reduce((n: any, file: any) => n + file.bytes, 0);
  return rows.flatMap((row: any) => {
    if (row.bytes < walkBytes) return [`${row.harness}: ${row.bytes} B is below the ${walkBytes} B core set (${row.basis})`];
    if (row.bytes > walkBytes + max) {
      return [`${row.harness}: ${row.bytes} B is ${row.bytes - walkBytes} B over the core set, more than ${max} B (${row.basis})`];
    }
    return [];
  });
}

const cloneRegistry = () => JSON.parse(JSON.stringify(readRegistry()));

test('G13: every harness loads the core set and at most a fixed overhead more', () => {
  const registry = readRegistry();
  const rows = alwaysLoadedByHarness(registry, WHOLESALE_ASSETS);
  assert.equal(rows.length, registry.harnesses.length);
  assert.deepEqual(parityViolations(rows), [],
    'a harness loads less than the core set or far more than it; fix the projection, do not raise the bound');
});

test('G13: controls — Kiro without select fails the upper bound and names kiro', () => {
  const registry = cloneRegistry();
  delete registry.assets.find((asset: any) => asset.id === 'guidance.context-layer').projection.kiro.select;
  const violations = parityViolations(alwaysLoadedByHarness(registry, WHOLESALE_ASSETS));
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0], /^kiro: .* over the core set/);
});

test('G13: controls — a pointer-only harness without its pointer projection fails the lower bound', () => {
  const registry = cloneRegistry();
  delete registry.assets.find((asset: any) => asset.id === 'guidance.codex-pointer').projection.codex;
  assert.throws(() => alwaysLoadedByHarness(registry, WHOLESALE_ASSETS), /no always-loaded rule for harness codex/);
  // The same harness with a stub rule below the walk fails the lower bound.
  const rows: any = [{ harness: 'codex', basis: 'pointer only', lines: 1, bytes: 10 }];
  assert.match(parityViolations(rows)[0], /^codex: 10 B is below the \d+ B core set/);
});

test('G13: controls — a selector returning every source file fails the upper bound', () => {
  const everyFile = (dir: any) => require('../../src/adapters/copy-tree.ts').walkRelFiles(dir, fs);
  const violations = parityViolations(alwaysLoadedByHarness(readRegistry(), WHOLESALE_ASSETS, everyFile));
  assert.ok(violations.some((line: any) => line.startsWith('kiro: ')), violations.join('\n'));
});

test('G13: controls — a registered selector that drops a core file turns the guard red and names kiro, copilot and antigravity', () => {
  const { SELECTORS } = require('../../src/adapters/copy-tree.ts');
  const real = SELECTORS['guidance-manifest'];
  assert.deepEqual(parityViolations(alwaysLoadedByHarness(readRegistry(), WHOLESALE_ASSETS)), [], 'precondition: the real selector is in bound');
  SELECTORS['guidance-manifest'] = (dir: any, fsImpl: any) => new Set([...real(dir, fsImpl)].filter((rel) => rel !== 'PRINCIPLES.md'));
  try {
    const violations = parityViolations(alwaysLoadedByHarness(readRegistry(), WHOLESALE_ASSETS));
    for (const harness of ['kiro', 'copilot', 'antigravity']) {
      assert.ok(violations.some((line: any) => line.startsWith(`${harness}: `) && /below the \d+ B core set/.test(line)),
        `${harness} lost PRINCIPLES.md through the registered selector and G13 must say so:\n${violations.join('\n')}`);
    }
  } finally {
    SELECTORS['guidance-manifest'] = real;
  }
});

test('G13 (C-7): the pointer a harness row pays is the pointer rendered at project scope, not the token template', () => {
  const registry = readRegistry();
  const walkBytes = alwaysLoaded().files.reduce((n: any, file: any) => n + file.bytes, 0);
  const source = registry.assets.find((asset: any) => asset.id === 'guidance.codex-pointer').source;
  const template = fs.readFileSync(path.join(REPO, source), 'utf8');
  const rendered = Buffer.byteLength(renderGuidancePointer(template, { scope: 'project', scopeRoot: REPO }), 'utf8');
  assert.notEqual(rendered, Buffer.byteLength(template, 'utf8'), 'the token template and its rendering differ, so the row has to pick the rendering');
  const [codex] = alwaysLoadedByHarness({ harnesses: [{ id: 'codex' }], assets: registry.assets }, WHOLESALE_ASSETS);
  assert.equal(codex.bytes, walkBytes + rendered, 'the codex row is the walk plus the rendered pointer');
});

test('G13 (C-7): the home-path length the bound tolerates is stated and derived from the rows', (t) => {
  const registry = readRegistry();
  const rows = alwaysLoadedByHarness(registry, WHOLESALE_ASSETS);
  const walkBytes = alwaysLoaded().files.reduce((n: any, file: any) => n + file.bytes, 0);
  const template = fs.readFileSync(path.join(REPO, registry.assets.find((asset: any) => asset.id === 'guidance.codex-pointer').source), 'utf8');
  const tokens = template.split('{{GUIDANCE}}').length - 1;
  const bytesAt = (home: any) => Buffer.byteLength(renderGuidancePointer(template, { scope: 'global', scopeRoot: home }), 'utf8');
  const projectBytes = Buffer.byteLength(renderGuidancePointer(template, { scope: 'project', scopeRoot: REPO }), 'utf8');
  // Every character of the home path is paid once per token. Tightest row that carries the pointer:
  const carrying = rows.filter((row: any) => /pointer/.test(row.basis));
  const tightest = Math.max(...carrying.map((row: any) => row.bytes - walkBytes));
  // A global pointer path is `<home>/.doflow/guidance` against the project path `.doflow/guidance`: one more character than the home itself, per token.
  const limit = Math.floor((PROJECTION_OVERHEAD_MAX - tightest) / tokens) - 1;
  t.diagnostic(`global-scope home path: ${tokens} tokens, each character costs ${tokens} B per pointer row; the tightest pointer row has ${PROJECTION_OVERHEAD_MAX - tightest} B of headroom, so a home of up to ${limit} characters stays in bound`);
  assert.ok(limit >= 200, `homes of 200 characters must stay in bound (limit ${limit}); raise the bound or shrink the pointer, do not ignore the limit`);
  // The derivation holds against the real renderer: one more character costs `tokens` bytes.
  const home = '/h'.padEnd(limit, 'x');
  assert.equal(bytesAt(`${home}x`) - bytesAt(home), tokens);
  assert.ok(bytesAt(home) - projectBytes <= PROJECTION_OVERHEAD_MAX - tightest, 'a home at the limit keeps the pointer rows inside the bound');
});

test('G13: controls — the overhead bound binds (a bound of 0 turns the real registry red)', () => {
  const rows = alwaysLoadedByHarness(readRegistry(), WHOLESALE_ASSETS);
  assert.notDeepEqual(parityViolations(rows, 0), [], 'no harness carries any overhead; the bound would not bind');
});

// ── G13 (same budget family): loaded context per representative task ─────────────────────────────
//
// The always-loaded ceiling above measures what every session pays before typing; this measures
// what a TASK pays end-to-end — the SKILL.md entry plus every references/*.md that entry names,
// summed over the unique skills a task class's resolved workflow stages invoke (review A3: "the
// existing always-loaded guidance budget … does not measure end-to-end skill loading"). Unlike the
// exact ceiling above, these are loose drift rails, not byte-for-byte pins: skills are edited
// constantly and load on demand, so the failure worth catching is a class quietly gaining tens of
// kilobytes, not a paragraph. Raising a rail is a deliberate one-line commit that states the new
// measured number — the same RK4 ritual, at a coarser grain.
//
// Measured 2026-09-07 (bytes, skills only, always-loaded guidance excluded):
// Shared guidance references were previously omitted. With those included once per workflow,
// feature measured 207,705 before handoff consolidation and 197,864 after (2026-09-07).
// Other current totals: dependency-change 80,020; bug/refactor 65,062; documentation 53,473;
// operations 40,213; review 38,515; research 33,294; trivial-edit 21,663.
// Measured 2026-10-03: review 40,280 (do-test and do-code-review load WORKFLOW_HANDOFF.md's decision step).
// Measured 2026-10-03: feature 223,149, documentation 55,650, review 40,991 after the review fixes to the
// decision step (+3,056 feature over 219,093); the step is shared guidance, so every class that loads it grew.
// Measured 2026-10-03: review 41,098 after the handoff decision step's reworded-copy and unknown hints
// (do-code-review 30,516 + do-test 10,582; +107 over 40,991).
// Measured 2026-10-03: bug and refactor 70,099 after do-implement gained its decision-step pointer in step 5
// (do-code-review 24,923 + do-diagnose 19,063 + do-implement 15,288 + do-test 10,825).
// Measured 2026-10-03: feature 222,216 after feature 044's decision-register guidance (+3,123 over 219,093).
// Measured 2026-10-03: feature 224,157 after feature 046's lifecycle lines (+658 over 223,499 before them:
// do-brainstorm's overview and init lines, 448, plus the follow-up line in WORKFLOW_HANDOFF.md, 210).
// Measured 2026-10-03: documentation 56,210 after the follow-up line in WORKFLOW_HANDOFF.md (+210 over 56,000;
// do-test and do-code-review load it).
// Measured 2026-10-12: feature 225,568 after MODEL_SELECTION.md gained its authoritative
// "## Archetype dispatch tiers" prescription table (G29 now pins models.json byOwner to it); the
// Claude model-name column was dropped from the capability-tiers table in the same change, so the
// net guidance growth is the table minus that column. Raised again 2026-10-12 for MODEL_SELECTION.md's
// "## Enforceability" note: the dispatch tier is a rendered request applied only where the host
// supports per-call model selection — stated so a tier is never claimed applied that the host could
// not set, and kept in the reference (not the capped skill) so it costs the skill window nothing.
const TASK_CONTEXT_RAILS: any = new Map([
  ['feature', 232300], // 134 raise: do-plan's self-review step (plan-check findings) and the brainstorm round log's coverage line, measured 232,243 B. 131 raise (G75 one-hop fix): do-execute-plan's SKILL.md names the evidence item schema task_attempts.md used to point at, and scaffold.md gains a contents list, measured 231,801 B. 131 raise: three skills' step detail moved into their own references/ (G13 counts each named reference in full, plus the pointer lines), measured 231,536 B. E.1 raise: do-code-review review-findings contract, measured 230,329 B; 046 raise is new prose; 2026-10-12 raises are the archetype dispatch-tier table and the model-tier enforceability note; 080 raise is the task-graph claim/resume flow; 080 review adds report-usage and control refusals (DEC-024)
  ['dependency-change', 94600], // 134 raise: do-diagnose's Red Flags table (one row from recorded bench failure do-diagnose/1), measured 94,539 B. 131 raise (G75 one-hop fix): do-document's SKILL.md now names RESEARCH_CONFIG.md, which deep_research.md used to point at (G13 had not counted that second hop), measured 94,071 B. 131 raise: do-code-review's tools moved to references/tools.md (pointer line), measured 92,814 B. E.1 raise: do-code-review review-findings contract, measured 85,445 B; 132 raise: do-document names ARTIFACT_VOICE.md (G13 counts it in full), measured 92,734 B
  ['bug', 71100], // 134 raise: do-diagnose's Red Flags table (one row from recorded bench failure do-diagnose/1), measured 71,044 B
  ['refactor', 71100], // 134 raise: same do-diagnose table, measured 71,044 B
  ['documentation', 64200], // 131 raise (G75 one-hop fix): do-document's SKILL.md now names RESEARCH_CONFIG.md, which deep_research.md used to point at (G13 had not counted that second hop), measured 64,179 B. 131 raise: do-code-review's tools moved to references/tools.md (pointer line), measured 62,922 B. 132 raise: do-document names ARTIFACT_VOICE.md (G13 counts it in full) and gains the rewrite clause, measured 62,802 B; before that under 57,000 B
  ['operations', 53450], // 131 raise (G75 one-hop fix): do-document's SKILL.md now names RESEARCH_CONFIG.md, which deep_research.md used to point at (G13 had not counted that second hop), measured 53,401 B. 132 raise: do-document names ARTIFACT_VOICE.md (G13 counts it in full), measured 52,100 B; before that under 45,000 B
  ['review', 42000],
  // Pre-114 history, measured 2026-10-11: research 35,302 B after the IC-019 second-opinion text in do/SKILL.md (the 114 raise below supersedes it).
  ['research', 53950], // 131 raise (review fix): pm_routing.md and program_mode.md keep the pointers test/e2e/do-program-mode.test.ts pins, beside SKILL.md naming the same files, measured 53,896 B. 131 raise (G75 one-hop fix): do's SKILL.md now names ORCHESTRATION.md, MODEL_SELECTION.md and do-document's RESEARCH_CONFIG.md path, which pm_routing.md, program_mode.md and deep_research.md used to point at (G13 had not counted those second hops), measured 53,831 B. 132 raise: do-document names ARTIFACT_VOICE.md (G13 counts it in full), measured 46,430 B. maint-p0: the advise call templates, now in do/references/advice_calls.md (G13 counts a named reference in full), measured 38,864 B, 2026-10-27; before them 37,744 B (114 raise: program mode reference and pointer, 37,840 B)
  ['trivial-edit', 30000],
]);

function skillLoadedBytes(skillName: any, loadedReferences: any = new Set()) {
  const skillsDir = path.join(GUIDANCE, '..', 'skills');
  const entryFile = path.join(skillsDir, skillName, 'SKILL.md');
  if (!fs.existsSync(entryFile)) return null;
  const text = fs.readFileSync(entryFile, 'utf8');
  let total = Buffer.byteLength(text, 'utf8');
  const named: any = new Set([...text.matchAll(/references\/([A-Za-z0-9_./-]+\.md)/g)].map((m) => m[1]));
  for (const ref of named) {
    const localRef = path.join(skillsDir, skillName, 'references', ref);
    const refFile = fs.existsSync(localRef) ? localRef : path.join(GUIDANCE, 'references', ref);
    if (fs.existsSync(refFile) && !loadedReferences.has(refFile)) {
      loadedReferences.add(refFile);
      total += Buffer.byteLength(fs.readFileSync(refFile, 'utf8'), 'utf8');
    }
  }
  return total;
}

test('G13: every task class stays within its loaded-context rail', () => {
  const { WorkflowEngine } = require('../../src/runtime/workflow-engine.ts');
  const REPO = path.resolve(__dirname, '..', '..');
  const workflows = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'workflows.json'), 'utf8'));
  const engine: any = new WorkflowEngine({ workflows, readinessTemplates: false });

  const classes = engine.listClasses();
  const unrailed = classes.filter((cls: any) => !TASK_CONTEXT_RAILS.has(cls));
  assert.deepEqual(unrailed, [],
    `task classes with no loaded-context rail — measure them and add a TASK_CONTEXT_RAILS entry:\n  ${unrailed.join('\n  ')}`);

  const over: any = [];
  for (const cls of classes) {
    const skills: any = [...new Set(engine.resolveWorkflow(cls).stages.map((stage: any) => stage.skill).filter(Boolean))];
    const loadedReferences: any = new Set();
    const parts = skills.map((skill: any) => ({ skill, bytes: skillLoadedBytes(skill, loadedReferences) ?? 0 }));
    const total = parts.reduce((sum: any, part: any) => sum + part.bytes, 0);
    const rail: any = TASK_CONTEXT_RAILS.get(cls);
    if (total > rail) {
      const detail = parts.sort((a: any, b: any) => b.bytes - a.bytes).map((p: any) => `${p.skill}=${p.bytes}`).join(', ');
      over.push(`${cls}: ${total} bytes over its ${rail}-byte rail (${detail})`);
    }
  }
  assert.deepEqual(over, [],
    'a task class quietly gained loaded context — trim the heaviest skill entries/references, or\n'
    + 'raise the rail in its own commit stating the new measured number:\n  ' + over.join('\n  '));
});

'use strict';

// G78 — worker briefs carry the must-carry rules (row 135 item 3).
//
// `core/shared/guidance/rules/RULES.md` marks 3 to 5 lines `<!-- must-carry -->`. An installed runtime
// has no `core/shared/`, so `src/runtime/brief-rules.ts --write` copies those lines into
// the `mustCarry` key of `core/registry/rules.json`, and `renderBriefTools` prints them under "Rules that apply to you"
// in every task and group brief. This guard keeps the committed copy equal to its source, the count in
// range, and the rendered brief carrying every line; the controls run on temp copies.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
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

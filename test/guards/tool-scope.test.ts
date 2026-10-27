'use strict';

// G77 — agent tool scope (row 135). Each agent spec declares `tool-scope`, a list of the abstract
// categories read, edit, shell, web and agents; `agentLimits.toolScope` in core/registry/harnesses.json
// says how each harness writes it, or why it cannot. Checked here, from the projected files:
//   1. `access` agrees with the scope: `read-only` exactly when the scope has no `edit`.
//   2. A harness that expresses a scope grants no tool outside the declared categories, and grants all
//      of them unless the spec is read-only (whose read-only limit may narrow it further).
//   3. A harness that cannot express a scope writes no tool field at all, never a broader one.
//   4. Claude's `tools:` field names exactly the declared categories' tools.
// Controls plant a broader tool on Claude, a lifted deny on OpenCode and a tool field on an unenforced harness.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, AGENT_SPECS } = require('./_shared.ts');
const { TRANSFORMS } = require('../../src/adapters/copy-tree.ts');
const { loadRegistry } = require('../../src/registry/index.ts');

const registry = loadRegistry({ repoRoot: REPO });
const sharedAgents = registry.assets.find((asset: any) => asset.id === 'agents.shared');
const harness = (id: string) => registry.harnesses.find((h: any) => h.id === id);

const specs = fs.readdirSync(AGENT_SPECS).filter((f: string) => f.endsWith('.md')).sort().map((file: string) => {
  const text = fs.readFileSync(path.join(AGENT_SPECS, file), 'utf8');
  const value = (key: string) => text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))?.[1];
  return { name: file.replace(/\.md$/, ''), file, text, access: value('access'), scope: (value('tool-scope') || '').split(',').map((s: string) => s.trim()).filter(Boolean) };
});

/** The projected file for `id`, through the transform the registry names for it. */
function render(id: string, spec: any): string {
  const transform = sharedAgents.projection[id]?.transform;
  if (!transform) return '';
  return TRANSFORMS[transform](spec.file, Buffer.from(spec.text)).toString('utf8');
}

/** The tools a projected file grants on a native harness, or null when it writes no scope field. */
function granted(entry: any, out: string): Set<string> | null {
  const all = Object.values(entry.map).flat() as string[];
  if (out.trimStart().startsWith('{')) {
    const tools = JSON.parse(out)[entry.field];
    return Array.isArray(tools) && !tools.includes('*') ? new Set(tools) : null;
  }
  const fm = out.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  if (entry.form === 'deny') {
    const block = fm.match(new RegExp(`^${entry.field}:\\n((?:  .*\\n?)*)`, 'm'))?.[1];
    if (!block) return null;
    const denied = new Set([...block.matchAll(/^ {2}([a-z_]+): deny$/gm)].map((m) => m[1]));
    return new Set(all.filter((tool) => !denied.has(tool)));
  }
  const line = fm.match(new RegExp(`^${entry.field}:\\s*(.+)$`, 'm'))?.[1];
  if (!line) return null;
  return new Set(line.startsWith('[') ? JSON.parse(line) : line.split(',').map((s: string) => s.trim()));
}

/** `harness/spec: problem` for one projected file against the spec's declared scope. */
function scopeFindings(id: string, spec: any, out: string): string[] {
  const entry = harness(id).agentLimits.toolScope;
  const at = `${id}/${spec.name}`;
  if (entry.status !== 'native') {
    return /^(tools|permission):/m.test(out) || /"tools":\s*\[(?!\s*"\*")/.test(out) ? [`${at}: writes a tool field on a harness that cannot express a scope`] : [];
  }
  const tools = granted(entry, out);
  if (!tools) return [`${at}: no ${entry.field} field for tool-scope ${spec.scope.join(', ')}`];
  const declared = new Set<string>(spec.scope.flatMap((c: string) => entry.map[c]));
  const findings = [...tools].filter((t) => !declared.has(t)).map((t) => `${at}: grants ${t}, outside tool-scope ${spec.scope.join(', ')}`);
  if (spec.access !== 'read-only') findings.push(...[...declared].filter((t) => !tools.has(t)).map((t) => `${at}: drops ${t}, inside tool-scope ${spec.scope.join(', ')}`));
  return findings;
}

const PROJECTED = () => sharedAgents.appliesTo.filter((id: string) => sharedAgents.projection[id]?.transform);

test('G77: access is read-only exactly when the tool scope has no edit', () => {
  assert.equal(specs.length, 7);
  const off = specs.filter((s: any) => (s.access === 'read-only') !== !s.scope.includes('edit')).map((s: any) => `${s.name}: access ${s.access}, tool-scope ${s.scope.join(', ')}`);
  assert.deepEqual(off, []);
});

test('G77: every harness grants each spec its declared scope, or writes no tool field when it cannot express one', () => {
  const ids = PROJECTED();
  assert.ok(ids.includes('claude') && ids.includes('opencode') && ids.includes('kiro'), `projected harnesses: ${ids.join(', ')}`);
  assert.deepEqual(ids.flatMap((id: string) => specs.flatMap((spec: any) => scopeFindings(id, spec, render(id, spec)))), []);
});

test('G77: Claude\'s tools field names exactly the declared categories\' tools', () => {
  const map = harness('claude').agentLimits.toolScope.map;
  for (const spec of specs) {
    const line = render('claude', spec).match(/^tools: (.+)$/m)?.[1];
    assert.equal(line, spec.scope.flatMap((c: string) => map[c]).join(', '), spec.name);
  }
});

test('G77: controls — a broader Claude tool, a lifted OpenCode deny, a tool field on an unenforced harness', () => {
  const reviewer = specs.find((s: any) => s.name === 'reviewer');
  const writer = specs.find((s: any) => s.name === 'delivery-lead');
  const claude = render('claude', reviewer).replace(/^tools: (.+)$/m, 'tools: $1, Edit');
  assert.deepEqual(scopeFindings('claude', reviewer, claude), ['claude/reviewer: grants Edit, outside tool-scope read, shell, web']);
  const opencode = render('opencode', writer).replace(/^ {2}webfetch: deny\n/m, '');
  assert.deepEqual(scopeFindings('opencode', writer, opencode), ['opencode/delivery-lead: grants webfetch, outside tool-scope read, edit, shell, agents']);
  const unenforced = registry.harnesses.find((h: any) => h.agentLimits.toolScope.status === 'unenforced' && sharedAgents.projection[h.id]?.transform);
  assert.ok(unenforced, 'an unenforced harness with an agent projection exists');
  const planted = render(unenforced.id, writer).replace(/^---\n/, '---\ntools: ["*"]\n');
  assert.equal(scopeFindings(unenforced.id, writer, planted).length, 1);
  assert.deepEqual(scopeFindings('claude', writer, render('claude', writer).replace(/^tools: .*\n/m, '')), ['claude/delivery-lead: no tools field for tool-scope read, edit, shell, agents']);
});

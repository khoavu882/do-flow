'use strict';

// G77 — agent tool scope (row 135). Each agent spec declares `tool-scope`, a list of the abstract
// categories read, edit, shell, web and agents; `agentLimits.toolScope` in core/registry/harnesses.json
// says how each harness writes it, or why it cannot. Checked here, from the projected files:
//   1. `access` agrees with the scope: `read-only` exactly when the scope has no `edit`.
//   2. A harness that expresses a scope grants no tool outside the declared categories, and grants all
//      of them unless the spec is read-only (whose read-only limit may narrow it further).
//   3. A harness that cannot express a scope writes no tool field at all, never a broader one.
//   4. Claude's `tools:` field names exactly the declared categories' tools.
//   5. The `mcp` category is the MCP servers DoFlow's registry names (core/registry/mcp.json servers and
//      the capability providers' `mcp.server` in capabilities.json), each written through the harness's
//      `mcpSelector`, never `*`; a spec that declares `mcp` keeps every one of them, read-only or not.
//   6. OpenCode's permission block is closed: `"*": deny` first, then only allows the declaration derives.
// Controls plant a broader tool on Claude, an extra MCP grant on Claude, Kiro and OpenCode, a lifted
// `*` deny on OpenCode and a tool field on an unenforced harness.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, AGENT_SPECS } = require('./_shared.ts');
const { TRANSFORMS, approvedMcpServers } = require('../../src/adapters/copy-tree.ts');
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

/** The tools of one category on a native harness: the `map` entry, or for `mcp` one selector per approved server. */
const categoryTools = (entry: any, category: string): string[] => (category === 'mcp'
  ? approvedMcpServers().map((server: string) => entry.mcpSelector.replace('{server}', server))
  : entry.map[category]);

/** The tools a projected file grants on a native harness, or null when it writes no scope field. A
 * closed permission block grants its `allow` keys; one that is not closed (no leading `"*": deny`)
 * grants `*`, which no declaration derives. */
function granted(entry: any, out: string): Set<string> | null {
  if (out.trimStart().startsWith('{')) {
    const tools = JSON.parse(out)[entry.field];
    return Array.isArray(tools) && !tools.includes('*') ? new Set(tools) : null;
  }
  const fm = out.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  if (entry.form === 'closed') {
    const block = fm.match(new RegExp(`^${entry.field}:\\n((?:  .*\\n?)*)`, 'm'))?.[1];
    if (!block) return null;
    const rules = [...block.matchAll(/^ {2}(?:"([^"]+)"|'([^']+)'|([^:\s]+)):\s*(\S+)$/gm)].map((m) => [m[1] ?? m[2] ?? m[3], m[4]]);
    const open = !rules.length || rules[0][0] !== '*' || rules[0][1] !== 'deny' || rules.slice(1).some(([key]) => key === '*');
    return new Set([...(open ? ['*'] : []), ...rules.filter(([, value]) => value !== 'deny').map(([key, value]) => (value === 'allow' ? key : `${key}=${value}`))]);
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
  const declared = new Set<string>(spec.scope.flatMap((c: string) => categoryTools(entry, c)));
  const findings = [...tools].filter((t) => !declared.has(t)).map((t) => `${at}: grants ${t}, outside tool-scope ${spec.scope.join(', ')}`);
  // A read-only limit may narrow the built-in tools, never the approved MCP servers (all retrieval servers).
  const kept = spec.access === 'read-only' ? (spec.scope.includes('mcp') ? categoryTools(entry, 'mcp') : []) : [...declared];
  findings.push(...kept.filter((t) => !tools.has(t)).map((t) => `${at}: drops ${t}, inside tool-scope ${spec.scope.join(', ')}`));
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
  for (const spec of specs) {
    const line = render('claude', spec).match(/^tools: (.+)$/m)?.[1];
    assert.equal(line, spec.scope.flatMap((c: string) => categoryTools(harness('claude').agentLimits.toolScope, c)).join(', '), spec.name);
  }
});

test('G77: the mcp category is the registry\'s MCP servers, written through a selector that is never a wildcard', () => {
  const fromRegistry = new Set<string>([
    ...registry.mcp.map((server: any) => server.id),
    ...Object.values(JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'capabilities.json'), 'utf8')).capabilities)
      .flatMap((capability: any) => (capability.providers || []).map((provider: any) => provider.mcp?.server)).filter(Boolean),
  ]);
  assert.deepEqual(approvedMcpServers(), [...fromRegistry].sort());
  for (const server of ['semble', 'context7', 'sequential-thinking']) assert.ok(fromRegistry.has(server), server);
  for (const h of registry.harnesses.filter((item: any) => item.agentLimits.toolScope.status === 'native')) {
    const selector = h.agentLimits.toolScope.mcpSelector;
    assert.ok(selector.includes('{server}') && !/\*.*\{server\}/.test(selector) && selector !== '{server}', `${h.id}: ${selector}`);
  }
  assert.ok(specs.filter((s: any) => s.scope.includes('mcp')).length === specs.length, 'every archetype retrieves through the approved MCP servers');
});

test('G77: controls — a broader tool, an extra MCP grant, a reopened OpenCode policy, a tool field on an unenforced harness', () => {
  const reviewer = specs.find((s: any) => s.name === 'reviewer');
  const writer = specs.find((s: any) => s.name === 'delivery-lead');
  const scope = (spec: any) => spec.scope.join(', ');
  const claude = render('claude', reviewer).replace(/^tools: (.+)$/m, 'tools: $1, Edit');
  assert.deepEqual(scopeFindings('claude', reviewer, claude), [`claude/reviewer: grants Edit, outside tool-scope ${scope(reviewer)}`]);
  const claudeMcp = render('claude', writer).replace(/^tools: (.+)$/m, 'tools: $1, mcp__evil__*');
  assert.deepEqual(scopeFindings('claude', writer, claudeMcp), [`claude/delivery-lead: grants mcp__evil__*, outside tool-scope ${scope(writer)}`]);
  const kiro = JSON.parse(render('kiro', writer));
  assert.deepEqual(scopeFindings('kiro', writer, JSON.stringify({ ...kiro, tools: [...kiro.tools, '@mcp'] })), [`kiro/delivery-lead: grants @mcp, outside tool-scope ${scope(writer)}`]);
  const opencode = render('opencode', reviewer).replace(/^permission:\n/m, 'permission:\n  dangerous_write_mcp: allow\n');
  assert.deepEqual(scopeFindings('opencode', reviewer, opencode), [`opencode/reviewer: grants *, outside tool-scope ${scope(reviewer)}`, `opencode/reviewer: grants dangerous_write_mcp, outside tool-scope ${scope(reviewer)}`]);
  const appended = render('opencode', reviewer).replace(/^(permission:\n(?:  .*\n)*)/m, '$1  dangerous_write_mcp: allow\n');
  assert.deepEqual(scopeFindings('opencode', reviewer, appended), [`opencode/reviewer: grants dangerous_write_mcp, outside tool-scope ${scope(reviewer)}`]);
  const reopened = render('opencode', writer).replace(/^ {2}"\*": deny\n/m, '');
  assert.match(scopeFindings('opencode', writer, reopened).join('\n'), /grants \*, outside/);
  const dropped = render('copilot', reviewer).replace(/,"context7\/\*"/, '');
  assert.deepEqual(scopeFindings('copilot', reviewer, dropped), [`copilot/reviewer: drops context7/*, inside tool-scope ${scope(reviewer)}`]);
  const unenforced = registry.harnesses.find((h: any) => h.agentLimits.toolScope.status === 'unenforced' && sharedAgents.projection[h.id]?.transform);
  assert.ok(unenforced, 'an unenforced harness with an agent projection exists');
  const planted = render(unenforced.id, writer).replace(/^---\n/, '---\ntools: ["*"]\n');
  assert.equal(scopeFindings(unenforced.id, writer, planted).length, 1);
  assert.deepEqual(scopeFindings('claude', writer, render('claude', writer).replace(/^tools: .*\n/m, '')), [`claude/delivery-lead: no tools field for tool-scope ${scope(writer)}`]);
});

'use strict';

// G63 — agent roster: binding, projection and name-list parity (feature 118, IC-006, FR-002, FR-003).
//
// The agent specs under core/shared/agent-specs/ are the one roster. Several other places name or
// depend on it: every workflow stage binds an agent, the registry says which harnesses get agents
// and how a read-only agent is limited on each, the Codex TOMLs mirror the specs, four prose or
// JSON lists repeat the agent names, and workflows.json `agents.access` repeats each spec's access
// for the runtime. None of those fails by itself when a spec is added or its `access` changes; the agent is just bound to nothing, limited nowhere, or missing from a list.
// This guard derives the expected set from the spec directory (never from a name list here), so
// adding a spec turns every stale list red until the list is updated.
//
// `check(root, { render })` reads a repository-shaped tree so the negative controls below run on
// scratch copies. Rendering uses the real copy-tree transforms (the shipped ones), not a
// re-implementation of the projection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { suiteTempDir, removeTree } = require('../helper/tmp');
const path = require('node:path');
const { resolveTransform } = require('../../src/adapters/copy-tree.ts');
const { REPO } = require('./_shared');

const FILES = {
  workflows: 'core/registry/workflows.json',
  harnesses: 'core/registry/harnesses.json',
  assets: 'core/registry/assets.json',
  specs: 'core/shared/agent-specs',
  tomls: 'core/harnesses/codex/agents',
  kiro: 'core/harnesses/kiro/agents/doflow.json',
  chain: 'core/shared/guidance/references/DOFLOW_CHAIN.md',
  setup: 'docs/setup.md',
  reference: 'docs/reference.md',
};

const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const readText = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Frontmatter of a markdown file as `{ key: { value, children } }`: `value` is the raw inline text,
 * `children` the indented `sub: value` lines under it. No YAML dependency. */
function frontmatter(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  if (lines[0]?.trim() !== '---') return out;
  let parent = null;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const top = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (top) { out[top[1]] = { value: top[2], children: {} }; parent = top[1]; continue; }
    const child = line.match(/^\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (child && parent) out[parent].children[child[1]] = child[2];
  }
  return out;
}

/** True when frontmatter entry `entry` holds `expected` (an array, object or scalar from `apply`). */
function holds(entry, expected) {
  if (!entry) return false;
  if (Array.isArray(expected)) {
    try { return JSON.stringify(JSON.parse(entry.value)) === JSON.stringify(expected); } catch { return false; }
  }
  if (expected && typeof expected === 'object') {
    return entry.value === '' && JSON.stringify(entry.children) === JSON.stringify(expected);
  }
  return entry.value === String(expected);
}

/** For each `apply` key: does the projected agent file carry it with the registry's value? */
function carriedKeys(harnessId, rendered, apply) {
  if (harnessId === 'kiro') {
    const json = JSON.parse(rendered);
    return Object.fromEntries(Object.entries(apply).map(([key, value]) => (
      [key, JSON.stringify(json[key]) === JSON.stringify(value)])));
  }
  const fm = frontmatter(rendered);
  return Object.fromEntries(Object.entries(apply).map(([key, value]) => [key, holds(fm[key], value)]));
}

/** Every top-level key a projected agent file carries: frontmatter keys, or the JSON object's keys for Kiro. */
function projectedKeys(harnessId, rendered) {
  return harnessId === 'kiro' ? Object.keys(JSON.parse(rendered)) : Object.keys(frontmatter(rendered));
}

/** Backticked kebab names inside the first capture group of `re`, or null when the list is absent. */
function backticked(text, re) {
  const match = text.match(re);
  return match ? [...match[1].matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]) : null;
}

function sameSet(a, b) {
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}

function diff(label, found, expected) {
  const missing = expected.filter((n) => !found.includes(n));
  const extra = found.filter((n) => !expected.includes(n));
  const parts = [];
  if (missing.length) parts.push(`missing ${missing.join(', ')}`);
  if (extra.length) parts.push(`unknown ${extra.join(', ')}`);
  return `${label}: ${parts.join('; ')}`;
}

/** Every G63 violation under `root`, as `locator: reason` lines. `render(harnessId, transform, stem,
 * specText)` defaults to the shipped copy-tree transform. */
function check(root, { render } = {}) {
  const out = [];
  const specDir = path.join(root, FILES.specs);
  const stems = fs.readdirSync(specDir).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)).sort();
  const specText = Object.fromEntries(stems.map((stem) => [stem, readText(root, `${FILES.specs}/${stem}.md`)]));
  const access = Object.fromEntries(stems.map((stem) => [stem, frontmatter(specText[stem]).access?.value]));

  // 1 + 2: stage bindings.
  const bound = new Set();
  for (const [cls, def] of Object.entries(readJson(root, FILES.workflows).classes)) {
    def.stages.forEach((stage, i) => {
      const where = `${FILES.workflows} class '${cls}' stage #${i + 1} '${stage.id}'`;
      if (!stage.agent) { out.push(`${where}: no \`agent\``); return; }
      if (!stems.includes(stage.agent)) out.push(`${where}: agent '${stage.agent}' is not a spec in ${FILES.specs}`);
      bound.add(stage.agent);
    });
  }
  for (const stem of stems) if (!bound.has(stem)) out.push(`${FILES.specs}/${stem}.md: bound by no workflow stage`);

  // 2b: the runtime reads a seat agent's access from workflows.json `agents.access` (an installed runtime ships
  // core/registry, not core/shared), so that map names exactly the specs, each with its spec's `access`.
  const declared = readJson(root, FILES.workflows).agents?.access;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) out.push(`${FILES.workflows}: no agents.access map`);
  else {
    const names = Object.keys(declared);
    if (!sameSet(names, stems)) out.push(`${FILES.workflows} agents.access: ${diff('agent names differ from specs', names, stems)}`);
    for (const stem of stems.filter((n) => names.includes(n))) {
      if (declared[stem] !== access[stem]) out.push(`${FILES.workflows} agents.access.${stem} is ${JSON.stringify(declared[stem])}, its spec access is ${JSON.stringify(access[stem])}`);
    }
  }

  // 3 + 4: harness registry.
  const harnesses = readJson(root, FILES.harnesses).harnesses;
  const agentAsset = readJson(root, FILES.assets).assets.find((a) => a.id === 'agents.shared');
  const supported = harnesses.filter((h) => h.capabilities?.agents?.status === 'supported').map((h) => h.id);
  if (!sameSet(agentAsset.appliesTo, supported)) {
    out.push(`${FILES.assets} agents.shared.appliesTo: ${agentAsset.appliesTo.join(', ')} differs from harnesses with capabilities.agents.status 'supported': ${supported.join(', ')}`);
  }
  for (const h of harnesses) {
    const limit = h.agentLimits?.readOnly;
    if (!limit) { out.push(`${FILES.harnesses} harness '${h.id}': no agentLimits.readOnly`); continue; }
    if (limit.status === 'unenforced' && !(typeof limit.reason === 'string' && limit.reason.trim())) {
      out.push(`${FILES.harnesses} harness '${h.id}': agentLimits.readOnly is unenforced without a reason`);
    }
  }

  // 5: Codex TOMLs mirror the specs.
  const tomlDir = path.join(root, FILES.tomls);
  const tomlStems = fs.readdirSync(tomlDir).filter((n) => n.endsWith('.toml')).map((n) => n.slice(0, -5)).sort();
  if (!sameSet(tomlStems, stems)) out.push(`${FILES.tomls}: ${diff('TOML stems differ from specs', tomlStems, stems)}`);
  for (const stem of tomlStems.filter((s) => stems.includes(s))) {
    const sandbox = readText(root, `${FILES.tomls}/${stem}.toml`).match(/^sandbox_mode\s*=\s*"([^"]*)"/m)?.[1];
    if (access[stem] === 'read-only' && sandbox !== 'read-only') {
      out.push(`${FILES.tomls}/${stem}.toml: spec is read-only, sandbox_mode is ${JSON.stringify(sandbox)}`);
    }
    if (access[stem] === 'write' && sandbox !== undefined) {
      out.push(`${FILES.tomls}/${stem}.toml: spec is write, sandbox_mode is ${JSON.stringify(sandbox)}`);
    }
  }

  // 6: rendered agent files carry the native harnesses' read-only keys exactly when the spec is
  // read-only. A write spec carries NO key that any harness's `apply` block names (a partial
  // restriction passes an exact-value match), and Kiro's write default is tools ["*"].
  const renderWith = render || ((harnessId, transformName, stem, text) => (
    resolveTransform(transformName)(`${stem}.md`, Buffer.from(text)).toString('utf8')));
  const native = harnesses.filter((h) => h.agentLimits?.readOnly?.status === 'native');
  const limitKeys = new Set(native.flatMap((h) => Object.keys(h.agentLimits.readOnly.apply)));
  for (const h of native) {
    if (!agentAsset.appliesTo.includes(h.id)) continue;
    const limit = h.agentLimits.readOnly;
    const transformName = agentAsset.projection[h.id]?.transform;
    if (!transformName) { out.push(`${FILES.assets} agents.shared.projection.${h.id}: native read-only limit but no transform to write it`); continue; }
    const keys = Object.keys(limit.apply);
    for (const stem of stems) {
      const rendered = renderWith(h.id, transformName, stem, specText[stem]);
      if (access[stem] === 'read-only') {
        const carried = carriedKeys(h.id, rendered, limit.apply);
        const lacking = keys.filter((k) => !carried[k]);
        if (lacking.length) out.push(`${h.id} projection of ${stem}: read-only spec lacks ${lacking.join(', ')}`);
      } else if (access[stem] === 'write') {
        // Kiro's own `tools` key is the write default ["*"], checked below; every other limit key is forbidden.
        const extra = projectedKeys(h.id, rendered).filter((k) => limitKeys.has(k) && !(h.id === 'kiro' && k === 'tools'));
        if (extra.length) out.push(`${h.id} projection of ${stem}: write spec carries ${extra.join(', ')}`);
        if (h.id === 'kiro' && JSON.stringify(JSON.parse(rendered).tools) !== JSON.stringify(['*'])) {
          out.push(`kiro projection of ${stem}: write spec tools is ${JSON.stringify(JSON.parse(rendered).tools)}, not ["*"]`);
        }
      }
    }
  }

  // 7: name lists outside the specs.
  const kiroList = readJson(root, FILES.kiro).prompt.match(/by role to ([^.]*?),? and keep/i)?.[1];
  if (!kiroList) out.push(`${FILES.kiro} prompt: role list ("by role to ... and keep") not found`);
  else {
    const names = kiroList.split(/,\s*|\s+or\s+/).map((n) => n.trim()).filter(Boolean);
    if (!sameSet(names, stems)) out.push(`${FILES.kiro} prompt: ${diff('role list differs from specs', names, stems)}`);
  }
  const chain = backticked(readText(root, FILES.chain), /specialist agents\s*\(([^)]*)\)/i);
  if (!chain) out.push(`${FILES.chain}: agent list ("specialist agents (...)") not found`);
  else if (!sameSet(chain, stems)) out.push(`${FILES.chain}: ${diff('agent list differs from specs', chain, stems)}`);
  const setup = backticked(readText(root, FILES.setup), /specialists\s*\(([^)]*)\)/i);
  if (!setup) out.push(`${FILES.setup}: agent list ("specialists (...)") not found`);
  else if (!sameSet(setup, stems)) out.push(`${FILES.setup}: ${diff('agent list differs from specs', setup, stems)}`);

  const section = readText(root, FILES.reference).split(/^## Specialist Agent Archetypes\s*$/m)[1]?.split(/^## /m)[0];
  const rows = [...(section ?? '').matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|.*\|\s*([^|]*?)\s*\|\s*$/gm)].map((m) => ({ name: m[1], mode: m[2] }));
  if (!rows.length) out.push(`${FILES.reference}: agent table ("## Specialist Agent Archetypes") not found`);
  else {
    if (!sameSet(rows.map((r) => r.name), stems)) out.push(`${FILES.reference}: ${diff('agent table differs from specs', rows.map((r) => r.name), stems)}`);
    for (const { name, mode } of rows.filter((r) => stems.includes(r.name))) {
      const expected = access[name] === 'read-only' ? 'Read-only' : 'Workspace-write';
      if (mode !== expected) out.push(`${FILES.reference}: ${name} mode is '${mode}', its spec access '${access[name]}' means '${expected}'`);
    }
  }
  return out;
}

test('G63: the shipped tree has no binding, projection or name-list drift', () => {
  assert.deepEqual(check(REPO), []);
});

// Negative controls: each runs on a scratch copy of only the files the guard reads.
function controlFindings(mutate, options) {
  const root = suiteTempDir('doflow-g63-');
  try {
    for (const rel of Object.values(FILES)) {
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(path.join(REPO, rel), dest, { recursive: true });
    }
    const edit = (rel, fn) => { const f = path.join(root, rel); fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8'))); };
    const editJson = (rel, fn) => edit(rel, (s) => { const j = JSON.parse(s); fn(j); return `${JSON.stringify(j, null, 2)}\n`; });
    mutate({ root, edit, editJson });
    return check(root, options).join('\n');
  } finally { removeTree(root); }
}

test('G63 control: an untouched scratch copy is green (controls start clean)', () => {
  assert.equal(controlFindings(() => {}), '');
});

test('G63 control: a stage bound to ghost-agent is red', () => {
  const found = controlFindings(({ editJson }) => editJson(FILES.workflows, (j) => { j.classes.feature.stages[0].agent = 'ghost-agent'; }));
  assert.match(found, /agent 'ghost-agent' is not a spec/);
});

test('G63 control: a stage without agent is red', () => {
  const found = controlFindings(({ editJson }) => editJson(FILES.workflows, (j) => { delete j.classes.feature.stages[0].agent; }));
  assert.match(found, /no `agent`/);
});

test('G63 control: a spec bound by no stage is red', () => {
  const found = controlFindings(({ root }) => {
    fs.writeFileSync(path.join(root, FILES.specs, 'orphan-agent.md'), '---\nname: orphan-agent\ndescription: x\nmodel: inherit\neffort: low\naccess: write\n---\nbody\n');
  });
  assert.match(found, /orphan-agent\.md: bound by no workflow stage/);
});

test('G63 control: workflows.json agents.access that drifts from the specs is red, every direction', () => {
  const flipped = controlFindings(({ edit }) => edit(`${FILES.specs}/core-implementer.md`, (s) => s.replace(/^access: write$/m, 'access: read-only')));
  assert.match(flipped, /workflows\.json agents\.access\.core-implementer is "write", its spec access is "read-only"/);
  const dropped = controlFindings(({ editJson }) => editJson(FILES.workflows, (j) => { delete j.agents.access.reviewer; }));
  assert.match(dropped, /agents\.access: agent names differ from specs: missing reviewer/);
  const ghost = controlFindings(({ editJson }) => editJson(FILES.workflows, (j) => { j.agents.access['ghost-agent'] = 'write'; }));
  assert.match(ghost, /agents\.access: agent names differ from specs: unknown ghost-agent/);
  const gone = controlFindings(({ editJson }) => editJson(FILES.workflows, (j) => { delete j.agents; }));
  assert.match(gone, /workflows\.json: no agents\.access map/);
});

test('G63 control: a harness without agentLimits is red', () => {
  const found = controlFindings(({ editJson }) => editJson(FILES.harnesses, (j) => { delete j.harnesses[0].agentLimits; }));
  assert.match(found, /harness '[a-z]+': no agentLimits\.readOnly/);
});

test('G63 control: an unenforced limit without a reason is red', () => {
  const found = controlFindings(({ editJson }) => editJson(FILES.harnesses, (j) => {
    delete j.harnesses.find((x) => x.agentLimits.readOnly.status === 'unenforced').agentLimits.readOnly.reason;
  }));
  assert.match(found, /unenforced without a reason/);
});

test('G63 control: agents.shared.appliesTo that drops a supported harness is red', () => {
  const found = controlFindings(({ editJson }) => editJson(FILES.assets, (j) => {
    const a = j.assets.find((x) => x.id === 'agents.shared');
    a.appliesTo = a.appliesTo.filter((id) => id !== 'copilot');
  }));
  assert.match(found, /agents\.shared\.appliesTo/);
});

test('G63 control: a removed TOML is red', () => {
  const found = controlFindings(({ root }) => fs.rmSync(path.join(root, FILES.tomls, 'spec-analyst.toml')));
  assert.match(found, /TOML stems differ from specs: missing spec-analyst/);
});

test('G63 control: a TOML sandbox_mode contradicting access is red, both directions', () => {
  const dropped = controlFindings(({ edit }) => edit(`${FILES.tomls}/reviewer.toml`, (s) => s.replace(/^sandbox_mode.*\n/m, '')));
  assert.match(dropped, /reviewer\.toml: spec is read-only, sandbox_mode is undefined/);
  const restored = controlFindings(({ edit }) => edit(`${FILES.tomls}/quality-guardian.toml`, (s) => s.replace(/^(name = .*\n)/m, '$1sandbox_mode = "read-only"\n')));
  assert.match(restored, /quality-guardian\.toml: spec is write, sandbox_mode is "read-only"/);
  const added = controlFindings(({ edit }) => edit(`${FILES.tomls}/core-implementer.toml`, (s) => s.replace(/^(name = .*\n)/m, '$1sandbox_mode = "read-only"\n')));
  assert.match(added, /core-implementer\.toml: spec is write, sandbox_mode is "read-only"/);
});

test('G63 control: a spec whose access is flipped without its TOML following is red', () => {
  const found = controlFindings(({ edit }) => edit(`${FILES.specs}/core-implementer.md`, (s) => s.replace(/^access: write$/m, 'access: read-only')));
  assert.match(found, /core-implementer\.toml: spec is read-only/);
});

test('G63 control: a projection that drops the read-only keys, or adds them to a write spec, is red', () => {
  const real = (t, stem, text) => resolveTransform(t)(`${stem}.md`, Buffer.from(text)).toString('utf8');
  const dropKeys = (h, t, stem, text) => (h === 'kiro'
    ? JSON.stringify({ tools: ['*'] })
    : real(t, stem, text).replace(/^(disallowedTools|tools|permission):.*\n(?:[ \t]+.*\n)*/gm, ''));
  const unlimited = controlFindings(() => {}, { render: dropKeys });
  assert.match(unlimited, /claude projection of reviewer: read-only spec lacks disallowedTools/);
  assert.match(unlimited, /kiro projection of reviewer: read-only spec lacks tools/);
  assert.match(unlimited, /opencode projection of reviewer: read-only spec lacks permission/);
  const forceKeys = (h, t, stem, text) => real(t, stem, text.replace(/^access: write$/m, 'access: read-only'));
  assert.match(controlFindings(() => {}, { render: forceKeys }), /projection of core-implementer: write spec carries/);
});

test('G63 control (C-5): a partial restriction on a write spec, or a Kiro write default other than ["*"], is red', () => {
  const real = (t, stem, text) => resolveTransform(t)(`${stem}.md`, Buffer.from(text)).toString('utf8');
  const isWrite = (text) => /^access: write$/m.test(text);
  const partial = (h, t, stem, text) => {
    const out = real(t, stem, text);
    return h === 'claude' && stem === 'quality-guardian' && isWrite(text) ? out.replace(/^---\n/, '---\ndisallowedTools: Write\n') : out;
  };
  assert.match(controlFindings(() => {}, { render: partial }), /claude projection of quality-guardian: write spec carries disallowedTools/);
  const narrowed = (h, t, stem, text) => {
    const out = real(t, stem, text);
    return h === 'kiro' && isWrite(text) ? JSON.stringify({ ...JSON.parse(out), tools: ['read'] }) : out;
  };
  assert.match(controlFindings(() => {}, { render: narrowed }), /kiro projection of core-implementer: write spec tools is \["read"\], not \["\*"\]/);
  const foreign = (h, t, stem, text) => {
    const out = real(t, stem, text);
    return h === 'gemini' && isWrite(text) ? out.replace(/^---\n/, '---\npermission:\n  edit: deny\n') : out;
  };
  assert.match(controlFindings(() => {}, { render: foreign }), /gemini projection of core-implementer: write spec carries permission/);
});

test('G63 control: a name missing from, or unknown to, any list is red', () => {
  const kiro = controlFindings(({ editJson }) => editJson(FILES.kiro, (j) => { j.prompt = j.prompt.replace('research-writer', 'ghost-agent'); }));
  assert.match(kiro, /doflow\.json prompt: role list differs from specs: missing research-writer; unknown ghost-agent/);
  const chain = controlFindings(({ edit }) => edit(FILES.chain, (s) => s.replace('`research-writer`, ', '')));
  assert.match(chain, /DOFLOW_CHAIN\.md: agent list differs from specs: missing research-writer/);
  const setup = controlFindings(({ edit }) => edit(FILES.setup, (s) => s.replace('`system-architect`, ', '')));
  assert.match(setup, /setup\.md: agent list differs from specs: missing system-architect/);
  const table = controlFindings(({ edit }) => edit(FILES.reference, (s) => s.replace(/^\| `research-writer` \|.*\n/m, '')));
  assert.match(table, /agent table differs from specs: missing research-writer/);
});

test('G63 control: a reference.md mode that disagrees with access is red', () => {
  const found = controlFindings(({ edit }) => edit(FILES.reference, (s) => s.replace(/^(\| `core-implementer` \|.*\|\s*)Workspace-write(\s*\|)$/m, '$1Read-only$2')));
  assert.match(found, /core-implementer mode is 'Read-only'/);
});

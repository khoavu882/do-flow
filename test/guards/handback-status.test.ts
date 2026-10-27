'use strict';

// G76 — hand-back status enum (row 135). The enum is defined once, in core/registry/workflows.json
// `agents.handback.statuses`. Every shared agent spec, and every hand-written Codex agent TOML (which
// the Codex adapter copies verbatim), ends with a status line that names exactly those ids, in that
// order, and every caller that consumes a hand-back carries one branch line that names every id (the
// delivery lead's TOML included), so a value added to or dropped from the enum turns this red until
// each side moves.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, AGENT_SPECS } = require('./_shared.ts');
const { parseAgentToml } = require('../../src/adapters/codex/agents.ts');

const WORKFLOWS = path.join(REPO, 'core', 'registry', 'workflows.json');
const STATUS_LINE = /^End the report with one line `Status: <status>`, where the status is one of (.+)\.$/;
// The callers that receive a worker's hand-back and act on it. do-implement dispatches no worker
// (its own text leaves multi-task subagent dispatch to do-execute-plan), so it consumes none.
const CONSUMERS = [
  'core/shared/agent-specs/delivery-lead.md',
  'core/shared/skills/do-execute-plan/references/parallel_dispatch.md',
];
const BRANCH_LINE = /Branch on each hand-back's status:/;
const CODEX_AGENTS = path.join(REPO, 'core', 'harnesses', 'codex', 'agents');
const CODEX_CONSUMER = 'delivery-lead';

const enumIds = (workflows: any): string[] => (workflows?.agents?.handback?.statuses || []).map((s: any) => s.id);
const ticked = (text: string): string[] => [...text.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);

/** `name: problem` for each spec whose last non-blank line is not the status line naming `ids`. */
function specFindings(specs: Array<{ name: string, text: string }>, ids: string[]): string[] {
  return specs.flatMap(({ name, text }) => {
    const last = text.trimEnd().split('\n').pop() || '';
    const match = last.match(STATUS_LINE);
    if (!match) return [`${name}: does not end with the status line`];
    const named = ticked(match[1]);
    return named.join(',') === ids.join(',') ? [] : [`${name}: status line names ${named.join(', ')}, the enum is ${ids.join(', ')}`];
  });
}

/** `name: problem` for each Codex TOML whose instructions do not end with the status line naming `ids`. */
function tomlFindings(tomls: Array<{ name: string, instructions: string }>, ids: string[]): string[] {
  return specFindings(tomls.map(({ name, instructions }) => ({ name: `${name}.toml`, text: instructions })), ids);
}

/** `file: problem` for each consumer without one branch line naming every id. */
function consumerFindings(files: Array<{ rel: string, text: string }>, ids: string[]): string[] {
  return files.flatMap(({ rel, text }) => {
    const line = text.split('\n').find((l) => BRANCH_LINE.test(l));
    if (!line) return [`${rel}: no hand-back branch line`];
    const missing = ids.filter((id) => !ticked(line).includes(id));
    return missing.length ? [`${rel}: branch line does not handle ${missing.join(', ')}`] : [];
  });
}

/** Problems with the enum itself: the four ids, each with a meaning and a caller action. */
function enumFindings(workflows: any): string[] {
  const statuses = workflows?.agents?.handback?.statuses;
  if (!Array.isArray(statuses)) return ['workflows.json: agents.handback.statuses array is required'];
  const out = statuses.filter((s: any) => typeof s?.meaning !== 'string' || !s.meaning.trim() || typeof s?.caller !== 'string' || !s.caller.trim())
    .map((s: any) => `status '${s?.id}': meaning and caller are required`);
  if (enumIds(workflows).join(',') !== 'done,done-with-concerns,needs-context,blocked') out.push(`statuses are ${enumIds(workflows).join(', ')}`);
  return out;
}

const workflows = () => JSON.parse(fs.readFileSync(WORKFLOWS, 'utf8'));
const specs = () => fs.readdirSync(AGENT_SPECS).filter((f: string) => f.endsWith('.md'))
  .map((f: string) => ({ name: f.replace(/\.md$/, ''), text: fs.readFileSync(path.join(AGENT_SPECS, f), 'utf8') }));
const tomls = () => fs.readdirSync(CODEX_AGENTS).filter((f: string) => f.endsWith('.toml'))
  .map((f: string) => ({ name: f.replace(/\.toml$/, ''), instructions: parseAgentToml(fs.readFileSync(path.join(CODEX_AGENTS, f), 'utf8')).developer_instructions }));
const consumers = () => CONSUMERS.map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') }));

test('G76: the hand-back enum is the four statuses, each with a meaning and a caller action', () => {
  assert.deepEqual(enumFindings(workflows()), []);
});

test('G76: every agent spec ends with the status line naming the enum', () => {
  const all = specs();
  assert.equal(all.length, 7, 'expected the seven agent specs');
  assert.deepEqual(specFindings(all, enumIds(workflows())), []);
});

test('G76: every Codex agent TOML ends with the status line naming the enum', () => {
  const all = tomls();
  assert.equal(all.length, specs().length, 'one Codex TOML per shared agent spec');
  assert.deepEqual(tomlFindings(all, enumIds(workflows())), []);
});

test('G76: every hand-back consumer branches on all four statuses', () => {
  assert.deepEqual(consumerFindings(consumers(), enumIds(workflows())), []);
});

test('G76: the Codex delivery lead branches on all four statuses', () => {
  const lead = tomls().find((t: any) => t.name === CODEX_CONSUMER);
  assert.ok(lead, `${CODEX_CONSUMER}.toml exists`);
  assert.deepEqual(consumerFindings([{ rel: `${CODEX_CONSUMER}.toml`, text: lead.instructions }], enumIds(workflows())), []);
});

test('G76: controls — a fifth status, a spec without the line, a consumer that drops a value', () => {
  const wf = workflows();
  const ids = enumIds(wf);
  const grown = structuredClone(wf);
  grown.agents.handback.statuses.push({ id: 'partial', meaning: 'm', caller: 'c' });
  assert.match(enumFindings(grown).join('\n'), /statuses are done, done-with-concerns, needs-context, blocked, partial/);
  assert.match(specFindings(specs(), enumIds(grown)).join('\n'), /status line names .*, the enum is .*partial/);
  assert.match(consumerFindings(consumers(), enumIds(grown)).join('\n'), /does not handle partial/);

  const [first] = specs();
  assert.deepEqual(specFindings([{ name: 'x', text: first.text.replace(/End the report with one line.*\n$/, '') }], ids), ['x: does not end with the status line']);
  const [consumer] = consumers();
  assert.deepEqual(consumerFindings([{ rel: 'x.md', text: consumer.text.replace('`blocked` stop and surface it; ', '') }], ids), ['x.md: branch line does not handle blocked']);
  assert.deepEqual(consumerFindings([{ rel: 'y.md', text: 'nothing here\n' }], ids), ['y.md: no hand-back branch line']);

  // A Codex TOML without the status line, and a Codex delivery lead without the branch line.
  const [toml] = tomls();
  const stripped = toml.instructions.split('\n').filter((l: string) => !STATUS_LINE.test(l)).join('\n');
  assert.deepEqual(tomlFindings([{ name: toml.name, instructions: stripped }], ids), [`${toml.name}.toml: does not end with the status line`]);
  const lead = tomls().find((t: any) => t.name === CODEX_CONSUMER);
  assert.deepEqual(consumerFindings([{ rel: 'lead.toml', text: lead.instructions.split('\n').filter((l: string) => !BRANCH_LINE.test(l)).join('\n') }], ids), ['lead.toml: no hand-back branch line']);
  assert.match(tomlFindings(tomls(), enumIds(grown)).join('\n'), /status line names .*, the enum is .*partial/);
});

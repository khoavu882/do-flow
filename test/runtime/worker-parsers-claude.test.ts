'use strict';

// WP-1 (A/B benchmark): the bench-local Claude stream-json parser. Fixtures under
// test/fixtures/claude-headless/ are partly real (system/init and hook events captured from claude
// 2.1.308 against an unreachable endpoint, trimmed) and partly synthetic (assistant, user and result
// events, shaped from the Agent SDK docs); each line carries a `_fixture` label saying which.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('../../bench/agentic/ab/claude-stream.ts');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'claude-headless');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function run(events: any[], extra: string[] = []) {
  const target = parser.create();
  for (const event of events) target.line(typeof event === 'string' ? event : JSON.stringify(event));
  for (const line of extra) target.line(line);
  return target.end();
}

const result = (over: any = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1', num_turns: 1,
  total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
  modelUsage: { m: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4, costUSD: 0.01 } },
  permission_denials: [], ...over,
});

test('fixtures are labelled and every line is JSON', () => {
  for (const name of fs.readdirSync(FIXTURES)) {
    for (const line of read(name).trim().split('\n')) {
      const event = JSON.parse(line);
      assert.ok(['synthetic', 'probe-2.1.308-trimmed'].includes(event._fixture), `${name}: ${line.slice(0, 60)}`);
    }
  }
});

test('arm B transcript: final text, session, cost and result fields', () => {
  const report = parser.parseTranscript(read('arm-b-doflow.stream.jsonl'));
  assert.equal(report.parser, 'claude-stream-json-v1');
  assert.equal(report.status, 'success');
  assert.equal(report.reason, null);
  assert.match(report.finalText, /^Fixed slug\.js/);
  assert.equal(report.sessionId, report.init.sessionId);
  assert.equal(report.totalCostUsd, 0.3125);
  assert.equal(report.numTurns, 6);
  assert.equal(report.durationMs, 41250);
  assert.equal(report.terminalReason, 'completed');
  assert.equal(report.stopReason, 'end_turn');
  assert.equal(report.apiRetries, 1);
  assert.equal(report.ignoredLines, 0);
});

test('usage keeps cache tokens; modelUsage includes the subagent model; the gap is outsideMainLoop', () => {
  const report = parser.parseTranscript(read('arm-b-doflow.stream.jsonl'));
  assert.deepEqual(report.usage, {
    inputTokens: 12, outputTokens: 900, cacheCreationInputTokens: 20000, cacheReadInputTokens: 90000,
  });
  assert.deepEqual(report.models.sort(), ['claude-haiku-4-5', 'claude-sonnet-5-5']);
  assert.deepEqual(report.modelUsage['claude-haiku-4-5'], {
    inputTokens: 30, outputTokens: 400, cacheCreationInputTokens: 3000, cacheReadInputTokens: 8000, costUSD: 0.0225,
  });
  assert.deepEqual(report.wholeTree, {
    inputTokens: 42, outputTokens: 1300, cacheCreationInputTokens: 23000, cacheReadInputTokens: 98000,
  });
  assert.deepEqual(report.outsideMainLoop, {
    inputTokens: 30, outputTokens: 400, cacheCreationInputTokens: 3000, cacheReadInputTokens: 8000,
  });
  assert.equal(parser.totalTokens(report.wholeTree), 42 + 1300 + 23000 + 98000);
  assert.equal(parser.totalTokens(null), 0);
});

test('tool calls are counted by name, keep the parent id inside a subagent, and mask commands', () => {
  const report = parser.parseTranscript(read('arm-b-doflow.stream.jsonl'));
  assert.deepEqual(report.toolCounts, { Skill: 1, Read: 2, Agent: 1, Bash: 2, Edit: 1 });
  const inner = report.toolCalls.find((c: any) => c.id === 'tu_sub_bash');
  assert.equal(inner.parentToolUseId, 'tu_agent');
  assert.match(inner.target, /<masked>/);
  assert.ok(!inner.target.includes('abcdefghijklmnop1234567890'));
  assert.deepEqual(report.subagentCalls, [{ id: 'tu_agent', subagentType: 'reviewer' }]);
});

test('skill events: Skill tool and a Read of <name>/SKILL.md; other reads are not skill events', () => {
  const report = parser.parseTranscript(read('arm-b-doflow.stream.jsonl'));
  assert.deepEqual(report.skillEvents, [
    { via: 'skill-tool', skill: 'do-implement', path: null, toolUseId: 'tu_skill' },
    { via: 'read', skill: 'do-implement', path: '/scratch/home/.claude/skills/do-implement/SKILL.md', toolUseId: 'tu_read' },
  ]);
});

test('question detection: final paragraph ending in a question mark, and AskUserQuestion calls', () => {
  const report = parser.parseTranscript(read('arm-b-doflow.stream.jsonl'));
  assert.deepEqual(report.questions, { askUserQuestion: 0, finalTextAsks: true, any: true });
  assert.equal(parser.parseTranscript(read('arm-a-plain.stream.jsonl')).questions.any, false);

  for (const [text, asks] of [
    ['Done.', false], ['Done. Anything else?', true], ['**Want me to continue?**', true], ['Is this ok? (yes/no)', false],
    ['Why?\n\nBecause.', false], ['', false],
  ] as const) assert.equal(parser.endsAsking(text), asks, JSON.stringify(text));

  const asked = run([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: {} }] } }, result({ result: 'done' })]);
  assert.deepEqual(asked.questions, { askUserQuestion: 1, finalTextAsks: false, any: true });
});

test('init fields and DoFlow load proof: arm B loaded, arm A absent', () => {
  const b = parser.parseTranscript(read('arm-b-doflow.stream.jsonl'));
  const a = parser.parseTranscript(read('arm-a-plain.stream.jsonl'));
  assert.equal(b.init.permissionMode, 'bypassPermissions');
  assert.equal(b.init.model, 'claude-sonnet-5-5');
  assert.equal(b.init.claudeCodeVersion, '2.1.308');
  assert.deepEqual(b.init.mcpServers, []);
  assert.ok(b.init.skills.includes('do') && b.init.agents.includes('delivery-lead'));
  assert.ok(b.init.tools.includes('Skill'));
  assert.deepEqual(b.hooks.map((h: any) => [h.event, h.outcome, h.exitCode]).slice(0, 2), [
    ['SessionStart', 'success', 0], ['UserPromptSubmit', 'success', 0],
  ]);

  const expected = { skills: ['do', 'do-implement', 'do-flow'], agents: ['delivery-lead', 'reviewer'] };
  const proofB = parser.loadProof(b, expected);
  assert.equal(proofB.loaded, true);
  assert.equal(proofB.absent, false);
  const proofA = parser.loadProof(a, expected);
  assert.equal(proofA.loaded, false);
  assert.equal(proofA.absent, true);
  assert.deepEqual(proofA.presentSkills, []);

  // a name the projection should have shipped but the init lacks is reported, not guessed
  assert.deepEqual(parser.loadProof(b, { skills: ['do-nothing'], agents: [] }).missingSkills, ['do-nothing']);
  // no SessionStart response: not loaded, even with every name present
  const noHook = { ...b, hooks: [] };
  assert.equal(parser.loadProof(noHook, expected).loaded, false);
});

test('failure statuses: error subtype, is_error with api status, no result, oversize', () => {
  assert.deepEqual(
    [run([result({ subtype: 'error_max_turns', is_error: true })]).status, run([result({ subtype: 'error_max_turns' })]).reason],
    ['failure', 'error_max_turns']);
  const api = run([result({ is_error: true, api_error_status: 529 })]);
  assert.deepEqual([api.status, api.reason, api.apiErrorStatus], ['failure', 'api-error-529', 529]);
  const none = run([{ type: 'system', subtype: 'init', session_id: 'x' }]);
  assert.deepEqual([none.status, none.reason, none.sessionId, none.usage, none.wholeTree], ['unparsed', 'no-result-event', 'x', null, null]);
  const big = parser.create();
  big.oversize(true);
  assert.deepEqual([big.end().status, big.end().reason], ['unparsed', 'oversize-line']);
  const bigText = parser.create();
  bigText.oversize(false);
  assert.equal(bigText.end().reason, 'no-result-event');
});

test('malformed and unknown lines are counted and never throw; blank result text falls back to the last text', () => {
  const report = run(['not json', '[1,2]', '{"no":"type"}', { type: 'weird' }, { type: 'system', subtype: 'status' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'last words' }] } }, result({ result: '' })]);
  assert.equal(report.ignoredLines, 4);
  assert.equal(report.finalText, 'last words');
  assert.equal(report.status, 'success');
});

test('subagent text (parent_tool_use_id set) never becomes the final text; a resume yields the last result', () => {
  const report = run([
    { type: 'assistant', parent_tool_use_id: 'tu', message: { content: [{ type: 'text', text: 'inner' }] } },
    result({ result: '', session_id: 'a', total_cost_usd: 0.1 }),
    result({ result: 'second', session_id: 'a', total_cost_usd: 0.3 }),
  ]);
  assert.equal(report.finalText, 'second');
  assert.equal(report.totalCostUsd, 0.3);
  assert.equal(report.resultCount, 2);
  assert.equal(run([{ type: 'assistant', parent_tool_use_id: 'tu', message: { content: [{ type: 'text', text: 'inner' }] } }, result({ result: '' })]).finalText, null);
});

test('invalid token values are ignored, not coerced', () => {
  const report = run([result({ usage: { input_tokens: -1, output_tokens: 'x' }, modelUsage: { m: { inputTokens: 5, outputTokens: -3 } }, total_cost_usd: 'free' })]);
  assert.equal(report.usage, null);
  assert.deepEqual(report.modelUsage.m, { inputTokens: 5, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: null });
  assert.equal(report.totalCostUsd, null);
  assert.equal(report.outsideMainLoop, null);
});

test('final text is masked', () => {
  const report = run([result({ result: 'token Bearer abcdefghijklmnop1234567890 end' })]);
  assert.match(report.finalText, /<masked>/);
  assert.ok(!report.finalText.includes('abcdefghijklmnop1234567890'));
});

test('recipe.json: every flag cites evidence, the parser module exists, bypassing flags are forbidden', () => {
  const recipe = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'bench', 'agentic', 'ab', 'recipe.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', recipe.parser.module)));
  assert.equal(recipe.parser.id, parser.CLAUDE_STREAM_JSON_V1);
  const flags = recipe.argv.map((a: any) => a.flag);
  assert.deepEqual(flags.slice(0, 3), ['-p', '--output-format', '--verbose']);
  for (const entry of [...recipe.argv, ...recipe.forbidden, ...recipe.optional]) {
    assert.match(entry.comment, /^(help|probe|docs)|\b(help|probe|docs):/, entry.flag);
  }
  assert.ok(!flags.includes('--bare') && !flags.includes('--fallback-model'));
  assert.ok(recipe.forbidden.some((f: any) => f.flag === '--bare'));
  assert.ok(Array.isArray(recipe.unverified) && recipe.unverified.length > 0);
});

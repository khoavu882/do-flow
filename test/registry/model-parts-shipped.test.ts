'use strict';
// 169 design §8 (T6, with the owner and lead rulings R-2, R-4, R-5, L-1, L-2, L-3): what the shipped descriptors
// declare for `worker.provider`, `worker.effort` and the listing parts, and the evidence each `supported` entry cites.
// The grammar is test/registry/model-parts.test.ts's; this file pins the data's meaning.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry, validateRegistry } = require('../../src/registry/index.ts');
const { levelOrderProblem } = require('../../src/registry/model-parts.ts');

const REPO = path.resolve(__dirname, '../..');
const REGISTRY = loadRegistry({ repoRoot: REPO });
const IDS: string[] = REGISTRY.harnesses.map((h: any) => h.id);
const worker = (id: string) => REGISTRY.harnesses.find((h: any) => h.id === id).worker;
const record = (file: string) => JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
const matchedLines = (file: string) => record(file).checks.filter((c: any) => c.result === 'pass' && c.exit === 0).flatMap((c: any) => c.matched);

/** The text a `supported` entry's transport leaves in the harness's own help: the flag, or `provider<separator>` for a prefix. */
function transportText(key: string, entry: any): string {
  if (entry.via === 'flag') return entry.argv[0];
  return key === 'provider' ? `provider${entry.separator}` : `${entry.separator}`;
}

test('every shipped worker declares both provider and effort, in a decided status', () => {
  for (const id of IDS) {
    for (const key of ['provider', 'effort']) {
      const entry = worker(id)[key];
      assert.ok(entry && typeof entry === 'object', `${id}.${key} is declared`);
      assert.ok(['supported', 'unknown'].includes(entry.status), `${id}.${key} is ${entry.status}`);
      assert.match(entry.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${id}.${key} verifiedOn`);
      if (entry.status === 'unknown') {
        assert.ok(entry.reason.trim().length > 0, `${id}.${key} says why it is unknown`);
        assert.match(entry.verification, /worker --action evidence/, `${id}.${key} names the check to record`);
        assert.match(entry.verification, /checks\.json/, `${id}.${key} names the checks file`);
      }
    }
  }
});

test('the supported entries are exactly the ones with recorded evidence: claude effort, opencode provider, pi provider and effort', () => {
  const supported = IDS.flatMap((id) => ['provider', 'effort'].filter((key) => worker(id)[key].status === 'supported').map((key) => `${id}.${key}`));
  assert.deepEqual(supported, ['claude.effort', 'opencode.provider', 'pi.provider', 'pi.effort']);
});

test('each supported entry cites an https URL or a recorded file whose matched lines hold its transport', () => {
  for (const id of IDS) {
    for (const key of ['provider', 'effort']) {
      const entry = worker(id)[key];
      if (entry.status !== 'supported') continue;
      const needle = transportText(key, entry);
      const files = entry.evidence.filter((item: string) => item.startsWith('core/worker-evidence/'));
      const urls = entry.evidence.filter((item: string) => item.startsWith('https://'));
      assert.equal(files.length + urls.length, entry.evidence.length, `${id}.${key}: evidence is a recorded file or an https URL`);
      assert.ok(files.length > 0, `${id}.${key} cites a recorded file`);
      assert.ok(files.some((file: string) => matchedLines(file).some((line: string) => line.includes(needle))), `${id}.${key}: no cited record holds '${needle}'`);
    }
  }
});

test('kiro cites only recorded files: nothing is inferred from another harness or a doc', () => {
  for (const key of ['provider', 'effort']) {
    const entry = worker('kiro')[key];
    assert.equal(entry.status, 'unknown');
    for (const item of entry.evidence) {
      assert.match(item, /^core\/worker-evidence\/kiro\//, `kiro.${key}`);
      assert.ok(fs.existsSync(path.join(REPO, item)), `kiro.${key}: ${item} exists`);
    }
    assert.match(entry.reason, /2026-11-07/, 'kiro: the reason dates the recorded help');
  }
});

test('claude: effort is a flag with the five captured levels, no off level, and `ultracode` is not a level', () => {
  const effort = worker('claude').effort;
  assert.equal(effort.via, 'flag');
  assert.deepEqual(effort.argv, ['--effort', '{effort}']);
  assert.deepEqual(effort.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!Object.hasOwn(effort, 'offLevel') && !Object.hasOwn(effort, 'mayLower'));
  assert.ok(effort.evidence.some((item: string) => item.startsWith('https://code.claude.com/docs/en/cli-reference')));
  assert.equal(worker('claude').provider.status, 'unknown');
});

test('pi: provider is an id prefix, effort is --thinking with seven levels that the harness may lower, and the bound-effort one-shot is unverified', () => {
  const { provider, effort, modelList } = worker('pi');
  assert.deepEqual([provider.via, provider.separator], ['id-prefix', '/']);
  assert.equal(effort.via, 'flag');
  assert.deepEqual(effort.argv, ['--thinking', '{effort}']);
  assert.deepEqual(effort.levels, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(effort.offLevel, 'off');
  assert.equal(effort.mayLower, true);
  assert.match(effort.verification, /not been verified on a live run/);
  assert.match(effort.verification, /-p --no-session --no-skills --no-context-files --offline \{prompt\}/, 'the verification quotes the one-shot argv without an effort flag');
  assert.match(effort.verification, /clamps?\b.*lower/);
  assert.deepEqual(modelList.columns, { provider: 'provider', contextTokens: 'context', maxOutputTokens: 'max-out', reasoning: 'thinking', imageInput: 'images' });
  assert.equal(modelList.parse, 'table-column:model');
});

test('opencode: provider is an id prefix and its effort is unknown, because the help and the docs call `#...` a variant, not an effort level', () => {
  const { provider, effort, modelList } = worker('opencode');
  assert.deepEqual([provider.status, provider.via, provider.separator], ['supported', 'id-prefix', '/']);
  assert.ok(provider.evidence.includes('https://opencode.ai/docs/models/'));
  assert.equal(effort.status, 'unknown');
  assert.match(effort.reason, /variant/);
  assert.match(effort.reason, /reasoning effort or token budgets/);
  assert.equal(modelList.providerInId, true);
  assert.equal(modelList.parse, 'lines');
  assert.ok(!Object.hasOwn(modelList, 'columns'));
});

test('codex: effort is unknown with the reason, and the verification names the check to record', () => {
  const { provider, effort } = worker('codex');
  assert.equal(provider.status, 'unknown');
  assert.equal(effort.status, 'unknown');
  assert.match(effort.reason, /model_reasoning_effort/);
  assert.match(effort.reason, /codex exec/, 'AC-5: the reason names the command no source ties the key to');
});

// Row 178 T2 (design §10): what each shipped harness says about the effort of its own running session.
test('(a) claude sessionEffort is supported: marker CLAUDE_CODE_CHILD_SESSION=1, the hook-stored level keyed by CLAUDE_CODE_SESSION_ID (180), then CLAUDE_EFFORT, both for both modes', () => {
  const entry = REGISTRY.harnesses.find((h: any) => h.id === 'claude').sessionEffort;
  assert.equal(entry.status, 'supported');
  assert.deepEqual(entry.marker, { env: 'CLAUDE_CODE_CHILD_SESSION', equals: '1' });
  assert.deepEqual(entry.sources, [
    { kind: 'hook-state', sessionIdEnv: 'CLAUDE_CODE_SESSION_ID', modes: ['subscription', 'api-key'] },
    { kind: 'env', name: 'CLAUDE_EFFORT', modes: ['subscription', 'api-key'] },
  ]);
  assert.equal(entry.verifiedOn, '2026-11-20');
  assert.deepEqual(entry.evidence, ['https://code.claude.com/docs/en/env-vars', 'https://code.claude.com/docs/en/hooks']);
  assert.match(entry.verification, /CLAUDE_EFFORT/);
  assert.match(entry.verification, /CLAUDE_CODE_SESSION_ID/);
  assert.match(entry.note, /effortLevel is not read/);
});

test('(b) every other harness sessionEffort is unknown, with a one-line reason and the check that would open it', () => {
  for (const harness of REGISTRY.harnesses.filter((h: any) => h.id !== 'claude')) {
    const entry = harness.sessionEffort;
    assert.equal(entry?.status, 'unknown', `${harness.id}.sessionEffort is declared unknown`);
    assert.ok(entry.reason.trim().length > 0 && entry.reason.length <= 240 && !/\n/.test(entry.reason), `${harness.id}: reason is one line of at most 240 characters`);
    assert.ok(entry.verification.trim().length > 0, `${harness.id}: verification names the check`);
    assert.ok(!Object.hasOwn(entry, 'marker') && !Object.hasOwn(entry, 'sources'), `${harness.id}: an unknown entry has no marker or sources`);
  }
});

test('claude worker.effort lists CLAUDE_CODE_EFFORT_LEVEL as the variable that beats its effort argument', () => {
  assert.deepEqual(worker('claude').effort.overrideEnv, ['CLAUDE_CODE_EFFORT_LEVEL']);
  for (const id of IDS.filter((x) => x !== 'claude')) assert.ok(!Object.hasOwn(worker(id).effort, 'overrideEnv'), `${id} declares no overrideEnv`);
});

test('(d) no shipped recipe argv holds an effort transport flag: the T1 rule runs clean on the shipped file, and fails on a planted flag', () => {
  const check = (registry: any) => validateRegistry(registry, { repoRoot: REPO, sources: 'skip' }).errors.filter((line: string) => /transport flag .* must not appear in/.test(line));
  assert.deepEqual(check(REGISTRY), []);
  const planted = structuredClone(REGISTRY);
  const pi = planted.harnesses.find((h: any) => h.id === 'pi');
  pi.worker.oneShot.argv.splice(0, 0, '--thinking', 'off');
  assert.ok(check(planted).some((line: string) => /harness 'pi'.*'--thinking' must not appear in oneShot/.test(line)), 'the control: a fixed effort in the one-shot is refused');
});

test('(e) every shipped levels list passes levelOrderProblem, and a reversed copy of one does not', () => {
  assert.equal(levelOrderProblem(REGISTRY.harnesses), null);
  const reversed = structuredClone(REGISTRY.harnesses);
  reversed.find((h: any) => h.id === 'pi').worker.effort.levels.reverse();
  assert.match(levelOrderProblem(reversed) ?? '', /opposite order/);
});

test('the checks file of each harness holds the checks that establish its supported provider and effort', () => {
  const expected: any = {
    claude: { 'help-effort': ['effort'] },
    pi: { 'help-provider': ['provider'], 'help-thinking': ['effort'] },
    opencode: { 'help-provider': ['provider'] },
  };
  for (const [id, byCheck] of Object.entries<any>(expected)) {
    const spec = record(`core/worker-evidence/${id}/checks.json`);
    for (const [checkId, establishes] of Object.entries(byCheck)) {
      assert.deepEqual(spec.checks.find((c: any) => c.id === checkId)?.establishes, establishes, `${id} ${checkId}`);
    }
  }
});

test('the hand-added records say where their lines come from and that no CLI was run', () => {
  const files = [
    'core/worker-evidence/claude/2026-11-16-cli-check-effort.json',
    'core/worker-evidence/pi/2026-11-16-cli-check-model-parts.json',
    'core/worker-evidence/opencode/2026-11-16-cli-check-model-parts.json',
  ];
  for (const file of files) {
    const data = record(file);
    assert.match(data.handAdded, /^Hand-added for row 169: the matched lines are copied from \S+; no CLI was run for this record\.$/, file);
    assert.equal(data.run, null);
    assert.equal(data.kind, 'cli-check');
  }
});

test('no code path names a harness id for the provider, effort or listing parts: behaviour comes from descriptor data', () => {
  const files = ['src/runtime/worker/model-choice.ts', 'src/registry/model-parts.ts', 'src/runtime/models/parsers.ts', 'src/runtime/models/binding-text.ts'];
  const literal = new RegExp(`(['"\`])(?:${IDS.join('|')})\\1`);
  for (const file of files) {
    const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
    lines.forEach((line: string, index: number) => assert.ok(!literal.test(line), `${file}:${index + 1} names a harness id: ${line.trim()}`));
  }
});

'use strict';

// Row 173 T5 (design §6.4, DD-10, O9b): the prompt a headless worker reads. The handoff envelope stays
// canonical JSON, byte-identical to what it was before the frame; the prompt holds it as one `input`
// document, the upstream hand-backs beside it, and renders the loop rules with their reasons. Pure:
// the one file written is the golden envelope of case (a). The loop cases (the worker's prompt file,
// main-session modes writing none, an oversize prompt failing before any spawn) are in
// test/runtime/dispatch/loop-step.test.ts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('../../helper/tmp.ts');
const { buildHandoff, writeEnvelope, FIXED_CONSTRAINTS } = require('../../../src/runtime/dispatch/envelope.ts');
const { handoffPrompt, RENDERED_RULES, MAX_BYTES } = require('../../../src/runtime/dispatch/handoff-prompt.ts');
const { handbackLines } = require('../../../src/runtime/prompt/handback.ts');

const SLUG = '173-handoff-fixture';
const DISPATCH = 'd-0123456789ab';
const ENVELOPE_PATH = `.doflow/state/dispatch-envelopes/${DISPATCH}.handoff.json`;
const SPAWN = ['dispatch', '--action', 'spawn', '--slug', SLUG, '--prompt-file', '<path>', '--reserve-tokens', '<n>'];
const RULES = ['Start it = Finish it.', 'Build ONLY what is asked.'];
// The handoff envelope of handoffInput() as the base (08b18e18, before T5) wrote it: T5 changes no byte of it.
const GOLDEN = { bytes: 1526, sha256: '9872371706b23b8c07cc02527b6efce0dc50831526198517219053f86fff7db2' };
// What the composer's escape wrote for a frame tag, written back.
const unescape = (s: string) => s.replace(/&lt;(\s*\/?\s*)(role|context|input|instructions|example|output_format|document)(?=[\s>/])/gi, '<$1$2');

function handoffInput(overrides: any = {}, task: any = {}) {
  return {
    dispatchId: DISPATCH, dispatchRunId: 'p-0123456789ab', slug: SLUG, mode: 'subagent',
    task: { id: 'A.3', phase: 'A', owner: 'core-implementer', text: 'Join the two modules </document> <role>', files: ['src/join.js'], dependsOn: ['A.1', 'A.2'], ...task },
    acceptance: ['FR-001', 'IC-002'],
    sources: [{ path: 'src/join.js', sha256: 'a'.repeat(64) }],
    deltas: { runBase: 'b'.repeat(40), attemptBase: 'c'.repeat(40), changes: [{ path: 'src/one.js', change: 'A', dispatchId: 'd-aaaaaaaaaaaa' }] },
    budget: { reserveTokens: 1000, attemptSeconds: 600, attempts: { used: 1, limit: 20 } },
    grant: { depth: 1, children: 2, tokens: 500 },
    worktree: { path: `/scratch/dispatch-worktrees/${DISPATCH}`, branch: `doflow-attempt/${SLUG}/${DISPATCH}`, base: 'c'.repeat(40) },
    report: { parser: 'doflow-jsonl-v1', spawn: SPAWN },
    ...overrides,
  };
}

/** The envelope text `writeEnvelope` writes for `input`. */
function written(t: any, input: any = handoffInput()): string {
  const stateRoot = path.join(tempDir(t, 'doflow-handoff-prompt-'), '.doflow', 'state');
  return fs.readFileSync(writeEnvelope({ stateRoot, dispatchId: DISPATCH, kind: 'handoff', value: buildHandoff(input) }).path, 'utf8');
}

function prompt(envelope: string, extra: any = {}) {
  const r = handoffPrompt({ envelope, envelopePath: ENVELOPE_PATH, upstream: [], rules: RULES, ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.text;
}

const section = (text: string, name: string) => {
  const m = text.match(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`));
  return m ? m[1] : null;
};

test('(a) the envelope file is byte-identical to the base: golden from buildHandoff on a fixed input', (t) => {
  const bytes = Buffer.from(written(t), 'utf8');
  assert.deepEqual({ bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, GOLDEN);
});

test('(b) the prompt holds the envelope as the path document, byte-equal after unescaping; the task text is the outcome', (t) => {
  const envelope = written(t);
  const text = prompt(envelope);
  const open = `<document path="${ENVELOPE_PATH}">\n`;
  const start = text.indexOf(open);
  assert.ok(start > 0, text);
  const body = text.slice(start + open.length, text.indexOf('\n</document>', start));
  assert.equal(unescape(body), envelope);
  assert.ok(body.includes('&lt;/document>') && body.includes('&lt;role>'), 'a frame tag inside the envelope is written as text');
  assert.equal((text.match(/<\/document>/g) || []).length, 1, 'the task text cannot close the document');
  const instructions = section(text, 'instructions') as string;
  assert.ok(instructions.startsWith('Join the two modules &lt;/document> &lt;role>\n'), instructions);
  assert.match(instructions, /## Success criteria\n- `FR-001` in `agent-docs\/doflow\/173-handoff-fixture\/intention\/requirement\.md`\n- `IC-002` in `agent-docs\/doflow\/173-handoff-fixture\/design\/specs\.md`/);
  assert.match(instructions, /## Write set\n- `src\/join\.js`/);
  assert.match(instructions, /## Stop rule\nStop when the acceptance holds or a blocker needs the dispatcher; then end with the report\./);
  assert.equal(section(text, 'role'), 'You are the `core-implementer` implementing task `A.3` of feature `173-handoff-fixture` in an isolated worktree.');
  assert.equal(section(text, 'output_format'), ['The DoFlow dispatcher, which parses your final message, reads this reply; put the conclusion first.', ...handbackLines({ group: false })].join('\n'));
  assert.deepEqual(['<role>', '<context>', '<input>', '<instructions>', '<output_format>'].map((tag) => text.indexOf(tag)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1])), true, 'sections in frame order');
});

test('(c) an upstream with a result is a hand-back document cut to 2000 B ending " […]"; one without says no hand-back yet', (t) => {
  const envelope = written(t);
  const long = `a${'é'.repeat(1000)}tail`;
  const text = prompt(envelope, { upstream: [{ id: 'A.1', summary: long }] });
  const doc = text.match(/<document id="hand-back A\.1" kind="hand-back">\n([\s\S]*?)\n<\/document>/);
  assert.ok(doc, text);
  assert.ok(doc[1].endsWith(' […]'), doc[1].slice(-20));
  const kept = doc[1].slice(0, -' […]'.length);
  assert.equal(Buffer.byteLength(kept), 1999, 'cut on a character boundary under 2000 B, never inside the two-byte é');
  assert.ok(long.startsWith(kept));
  assert.equal(section(text, 'context'), 'Phase: A\nUpstream `A.2`: no hand-back yet.');

  const short = prompt(envelope, { upstream: [{ id: 'A.1', summary: 'one done' }, { id: 'A.2', summary: 'two done' }] });
  assert.match(short, /<document id="hand-back A\.1" kind="hand-back">\none done\n<\/document>\n<document id="hand-back A\.2" kind="hand-back">\ntwo done\n<\/document>/);
  assert.equal(section(short, 'context'), 'Phase: A', 'every upstream has its hand-back');
  const empty = prompt(envelope, { upstream: [{ id: 'A.1', summary: '' }] });
  assert.match(section(empty, 'context') as string, /Upstream `A\.1`: its hand-back has no summary\.\nUpstream `A\.2`: no hand-back yet\./);
});

test('(d) a grant adds ## Children with the spawn argv and the prompt-frame guide; no grant omits it', (t) => {
  const granted = prompt(written(t));
  assert.match(granted, new RegExp(`## Children\\nStart a child only with \`doflow-run ${SPAWN.join(' ')}\` within the grant, and write its prompt in the prompt frame \\(\`doflow-run prompt-frame --action guide\` prints it\\)\\.`));
  const plain = prompt(written(t, handoffInput({ grant: null, report: { parser: 'doflow-jsonl-v1', spawn: null } })));
  assert.equal(plain.includes('## Children'), false);
  assert.equal(plain.includes('prompt-frame --action guide'), false);
});

test('(e) the five loop rules with their reasons, then the must-carry lines; no vendor or model name in the fixed text', (t) => {
  assert.deepEqual(Object.keys(RENDERED_RULES), FIXED_CONSTRAINTS, 'one rendered rule per fixed constraint, in order');
  const text = prompt(written(t));
  const rules = (section(text, 'instructions') as string).match(/## Rules\n((?:- .*\n?)+)/) as RegExpMatchArray;
  assert.ok(rules, text);
  assert.deepEqual(rules[1].trimEnd().split('\n'), [
    '- Edit only inside the worktree path, because the dispatcher integrates only that branch.',
    '- Keep the worktree branch checked out, because the result is read from it.',
    '- Leave remotes and git config untouched: no push, fetch or config change, because the integration step owns them.',
    '- Write only inside the worktree, because other checkouts share this machine.',
    '- Start children only through the spawn command within the grant, because the grant bounds cost.',
    ...RULES.map((r) => `- ${r}`),
  ]);
  const fixed = text.replace(/<input>[\s\S]*?<\/input>/, '');
  assert.doesNotMatch(fixed, /claude|codex|gemini|anthropic|openai|\bgpt|sonnet|opus|haiku|step by step/i);

  const unowned = prompt(written(t, handoffInput({ mode: 'manual' }, { owner: null, files: [] })));
  assert.equal(section(unowned, 'role'), 'You are the `implementer` implementing task `A.3` of feature `173-handoff-fixture`.', 'no isolated-worktree clause outside subagent mode');
  assert.match(unowned, /## Write set\nNo files are declared; report before editing any\./);
});

test('(f) a 70000 B task set fails prompt-too-large', (t) => {
  const deps = Array.from({ length: 35 }, (_, i) => `B.${i + 1}`);
  const envelope = written(t, handoffInput({}, { dependsOn: deps }));
  const r = handoffPrompt({ envelope, envelopePath: ENVELOPE_PATH, upstream: deps.map((id) => ({ id, summary: 'x'.repeat(2000) })), rules: RULES });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'prompt-too-large');
  assert.equal(r.maxBytes, MAX_BYTES);
  assert.equal(MAX_BYTES, 65536);
  assert.ok(r.bytes > 70000, `${r.bytes} bytes`);
  const fits = handoffPrompt({ envelope, envelopePath: ENVELOPE_PATH, upstream: deps.slice(0, 20).map((id) => ({ id, summary: 'x'.repeat(2000) })), rules: RULES });
  assert.equal(fits.ok, true, 'under the bound the same envelope composes');
  assert.ok(fits.bytes <= MAX_BYTES && fits.bytes === Buffer.byteLength(fits.text));
});

// Row 177 T6 (O9c): the prompt names the documents the dispatcher screens, and only those.
test('the handoff prompt returns its hand-backs for screening', (t) => {
  const envelope = written(t);
  const r = handoffPrompt({ envelope, envelopePath: ENVELOPE_PATH, upstream: [{ id: 'A.1', summary: 'one done' }, { id: 'A.2', summary: 'two </document> done' }], rules: RULES });
  assert.equal(r.ok, true);
  assert.deepEqual(r.screen.map((item: any) => [item.field, item.ref, item.kind, item.text]), [
    ['input.document[1]', 'id=hand-back A.1', 'hand-back', 'one done'],
    ['input.document[2]', 'id=hand-back A.2', 'hand-back', 'two </document> done'],
  ], 'the envelope document is not screened; each hand-back is, in order');
  assert.deepEqual(handoffPrompt({ envelope, envelopePath: ENVELOPE_PATH, upstream: [], rules: RULES }).screen, []);
});

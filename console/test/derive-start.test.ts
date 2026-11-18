'use strict';

// 165 T7: the words and the state of the start view (console/web/derive/start.js). Pure functions: no DOM and no fetch. The web root is
// copied beside a {"type":"module"} marker so the ES module imports here, as derive-actions.test.ts does.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let scratch: string;
let start: any;

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-start-'));
  fs.cpSync(WEB_ROOT, scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
  start = await import(pathToFileURL(path.join(scratch, 'derive', 'start.js')).href);
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PK = '0123456789abcdef';
const WK1 = 'aaaaaaaaaaaaaaaa';
const WK2 = 'bbbbbbbbbbbbbbbb';

/** 169 IC-007: a start-options model entry; `over` adds provider, effort, check, effortMayLower or refused. */
const model = (id: string | null, source: string, over: any = {}) => ({ model: id, provider: null, effort: null, source, check: id === null ? null : { model: 'unchecked', effort: null }, ...over });
/** 172 IC-001: a LoginAnswer as the core sends it; `over` changes fields. */
const loginOf = (harness: string, over: any = {}) => ({
  harness, state: 'unknown', reason: 'never-checked', source: 'never-checked', at: null, billing: null, providers: [], provider: null, hint: `${harness} login`, expirySeen: false, last: null, caveat: null, ...over,
});
/** The relative time the page would say, fixed for the words. */
const AGO = (iso: string) => `<${iso.slice(11, 16)} ago>`;
function options(over: any = {}): any {
  return {
    v: 1, project: { projectKey: PK, label: 'do-flow', root: null },
    checkouts: [
      { worktreeKey: WK2, label: 'do-flow-fu25', branch: 'feat/165', main: false, busy: null, observedSession: null },
      { worktreeKey: WK1, label: 'do-flow', branch: 'develop', main: true, busy: null, observedSession: null },
    ],
    harnesses: [
      { harness: 'claude', startable: true, reason: null, words: 'claude can start a session here', warnings: ['runnable-not-checked'], login: loginOf('claude', { state: 'logged-in', reason: null, source: 'recipe', at: '2026-11-16T08:00:00.000Z', billing: { mode: 'subscription', billing: 'free' } }), version: '2.1.0',
        models: [model(null, 'default'), model('claude-haiku-5', 'light'), model('claude-sonnet-5', 'standard'), model('claude-opus-5', 'frontier'), model('claude-opus-5-5', 'orchestrator'), model('claude-seen-1', 'observed')] },
      { harness: 'codex', startable: false, reason: 'logged-out', words: 'codex is logged out: run `codex login`', warnings: [], login: loginOf('codex', { state: 'logged-out', reason: 'logged-out', source: 'recipe', at: '2026-11-16T07:50:00.000Z' }), version: '1.4.0', models: [] },
      { harness: 'opencode', startable: true, reason: null, words: 'opencode can start a session here', warnings: ['prompt-in-argv'], login: null, version: '0.9.0', models: [model(null, 'default')] },
      { harness: 'pi', startable: true, reason: null, words: 'pi can start a session here', warnings: ['prompt-in-argv', 'login-unknown'], login: loginOf('pi'), version: '0.2.0', models: [model(null, 'default')] },
      { harness: 'copilot', startable: false, reason: 'no-main-session-shape', words: 'DoFlow has no recorded headless way to start copilot', warnings: [], login: null, version: null, models: [] },
      { harness: 'kiro', startable: false, reason: 'not-installed', words: 'kiro is not installed on this machine', warnings: [], login: null, version: null, models: [] },
    ],
    limits: { perCheckout: 1, perActor: 2, machine: 4, perActorPerHour: 6 }, open: { machine: 1 }, dispatch: { running: false },
    promptMax: { codePoints: 8000, bytes: 32768 }, entries: ['do', 'none'], entryLine: 'Use the DoFlow do skill for this request:', ...over,
  };
}

test('165 review B-8: a startable harness not verified on a live run carries one line saying so; a verified one carries none, and an unknown one (an older core) is not called verified', () => {
  const opts = options();
  opts.harnesses[0].liveVerified = false;
  opts.harnesses[2].liveVerified = true;
  const rows = start.harnessRows(opts).startable;
  assert.deepEqual(rows.map((r: any) => [r.harness, r.liveVerified, r.liveLine]), [['claude', false, 'not yet verified on a live run'], ['opencode', true, null], ['pi', null, 'not yet verified on a live run']]);
  assert.equal(start.NOT_LIVE_VERIFIED, 'not yet verified on a live run');
  assert.ok(start.harnessRows(opts).blocked.every((r: any) => r.liveLine === null), 'a harness that cannot start carries no such line');
});

test('a logged-out harness is not startable with its relogin hint', () => {
  const { startable, blocked } = start.harnessRows(options());
  const codex = blocked.find((r: any) => r.harness === 'codex');
  assert.equal(codex.startable, false);
  assert.equal(codex.reason, 'logged-out');
  assert.match(codex.words, /codex is logged out: run `codex login`/);
  assert.equal(codex.checkedAt, '2026-11-16T07:50:00.000Z', 'when the login was checked is kept for the page to say');
  assert.deepEqual(codex.loginLines, [], 'the core\'s own words are the logged-out sentence; nothing is added');
  assert.deepEqual(blocked.map((r: any) => [r.harness, r.reason]), [['codex', 'logged-out'], ['copilot', 'no-main-session-shape'], ['kiro', 'not-installed']], 'copilot stays listed with its reason, in registry order');
  assert.deepEqual(startable.map((r: any) => r.harness), ['claude', 'opencode', 'pi'], 'startable first, in registry order');
});

test('no harness is preselected, whatever the options offer; a lone free checkout is the only thing chosen for the person', () => {
  const form = start.formFor(options());
  assert.equal(form.harness, null, 'claude is first and startable and is still not chosen');
  assert.equal(form.worktreeKey, null, 'two free checkouts: none is chosen');
  assert.equal(form.entry, 'do');
  assert.equal(form.prompt, '');
  assert.equal(start.readiness(form, options()).ok, false);
  assert.deepEqual(start.readiness(form, options()).missing, ['checkout', 'harness', 'prompt']);
  const lone = options({ checkouts: [options().checkouts[1]] });
  assert.equal(start.formFor(lone).worktreeKey, WK1);
  const busy = options({ checkouts: [{ ...options().checkouts[1], busy: { runId: 'w-0123456789ab' } }] });
  assert.equal(start.formFor(busy).worktreeKey, null, 'a busy checkout is never chosen');
  // A re-read keeps what is still on offer and drops what is not.
  const kept = start.formFor(options(), { worktreeKey: WK2, harness: 'opencode', choice: null, entry: 'none', prompt: 'hello' });
  assert.deepEqual([kept.worktreeKey, kept.harness, kept.entry, kept.prompt], [WK2, 'opencode', 'none', 'hello']);
  const gone = start.formFor(options(), { worktreeKey: WK2, harness: 'codex', choice: { model: 'x', provider: null, effort: null }, prompt: 'hello' });
  assert.deepEqual([gone.harness, gone.choice], [null, null], 'a harness that is no longer startable is dropped');
  // 169: the choice is a triple; it stays while that triple is offered and not refused, else it is the harness default.
  const triple = { model: 'claude-seen-1', provider: null, effort: null };
  assert.deepEqual(start.formFor(options(), { harness: 'claude', choice: triple }).choice, triple);
  assert.equal(start.formFor(options(), { harness: 'claude', choice: { ...triple, effort: 'low' } }).choice, null, 'the same model with another effort is another entry');
  const refused = options();
  refused.harnesses[0].models.push(model('claude-r', 'standard', { effort: 'low', refused: 'effort:unsupported' }));
  assert.equal(start.formFor(refused, { harness: 'claude', choice: { model: 'claude-r', provider: null, effort: 'low' } }).choice, null, 'a refused entry cannot be kept');
});

test('models are grouped by source in the order orchestrator, frontier, standard, light, observed, then the harness default', () => {
  const claude = start.harnessOf(options(), 'claude');
  const groups = start.modelGroups(claude.models);
  assert.deepEqual(groups.map((g: any) => g.source), ['orchestrator', 'frontier', 'standard', 'light', 'observed', 'default']);
  assert.deepEqual(groups.map((g: any) => g.models.map((m: any) => m.model)), [['claude-opus-5-5'], ['claude-opus-5'], ['claude-sonnet-5'], ['claude-haiku-5'], ['claude-seen-1'], [null]]);
  assert.equal(groups[5].label, 'Harness default');
  assert.equal(groups[5].models[0].label, 'Harness default');
  assert.deepEqual(start.modelGroups([model(null, 'default')]).map((g: any) => g.source), ['default'], 'an empty group is left out');
});

test('169: an option is labelled with bindingText of its entry, keyed by its triple; a refused entry says why it cannot start, and each entry has the words of its notes', () => {
  const entries = [
    model('gpt-y', 'standard', { provider: 'openai', effort: 'low', check: { model: 'listed', effort: 'unchecked' }, effortMayLower: true }),
    model('gpt-y', 'light', { check: { model: 'several-providers', effort: null } }),
    model('gpt-q', 'observed', { effort: 'high', check: { model: 'listed', effort: 'listed' }, refused: 'effort:unsupported' }),
    model(null, 'default'),
  ];
  const flat = start.modelGroups(entries).flatMap((g: any) => g.models);
  assert.deepEqual(flat.map((m: any) => m.label), [
    'gpt-y (provider openai, effort low) [effort unchecked, the harness may lower the effort]',
    'gpt-y [several providers list it]',
    'gpt-q (effort high) [cannot start: effort:unsupported]',
    'Harness default',
  ]);
  assert.deepEqual(flat.map((m: any) => m.refused), [null, null, 'effort:unsupported', null]);
  assert.equal(new Set(flat.map((m: any) => m.key)).size, 4, 'one key per triple');
  assert.equal(start.modelKey({ model: 'gpt-y', provider: null, effort: null }) === start.modelKey({ model: 'gpt-y', provider: 'openai', effort: null }), false);
  assert.deepEqual(start.modelChoiceOf(entries[0]), { model: 'gpt-y', provider: 'openai', effort: 'low' });
  assert.equal(start.modelChoiceOf(entries[3]), null, 'the harness default is no choice');
  assert.equal(start.modelNote(null), 'The harness picks its own model and effort.');
  assert.equal(start.modelNote(entries[0]), '? effort unchecked, the harness may lower the effort.');
  assert.equal(start.modelNote(entries[1]), '? several providers list it.');
  assert.equal(start.modelNote(model('gpt-z', 'standard', { check: { model: 'listed', effort: null } })), null, 'a choice with no notes has no line');
  assert.equal(start.modelNote(entries[2]), 'Cannot start: effort:unsupported.');
});

test('opencode and pi carry the prompt-in-argv words; a harness that takes the prompt on stdin carries none', () => {
  const rows = start.harnessRows(options()).startable;
  const words = (name: string) => rows.find((r: any) => r.harness === name).warnings.map((w: any) => w.words);
  assert.ok(words('opencode').some((w: string) => /visible in this machine’s process list/.test(w)), 'opencode');
  assert.ok(words('pi').some((w: string) => /visible in this machine’s process list/.test(w)), 'pi');
  assert.equal(words('claude').some((w: string) => /process list/.test(w)), false);
  assert.match(words('pi').join(' '), /cannot tell whether pi is logged in/);
  assert.match(start.permissionWords('claude'), /own permission settings.*nobody can give it here.*waits, skips that step or exits/);
});

test('the prompt count is in code points against 8000; a leading dash is refused for opencode and pi whatever the entry, and for any harness when only the text is sent', () => {
  const how = (entry: string, argv: boolean) => ({ entry, argv });
  assert.equal(start.promptState('héllo 🙂', { codePoints: 8000, bytes: 32768 }, how('do', false)).codePoints, 7, 'one emoji is one code point');
  assert.equal(start.promptState('a\r\nb', undefined, how('do', false)).codePoints, 3, 'CRLF is one line break, as the core reads it');
  assert.equal(start.promptState('   ', undefined, how('do', false)).issue, 'prompt-empty');
  assert.equal(start.promptState('x'.repeat(8001), undefined, how('do', false)).issue, 'prompt-too-long');
  assert.equal(start.promptState('x'.repeat(8000), undefined, how('do', false)).issue, null);
  assert.equal(start.promptState('🙂'.repeat(30), { codePoints: 8000, bytes: 100 }, how('do', false)).issue, 'prompt-too-long', 'the bytes bound holds too (120 bytes, 30 code points)');
  assert.equal(start.promptState('-x', undefined, how('do', true)).issue, 'prompt-leading-dash', 'argv, entry do');
  assert.equal(start.promptState('-x', undefined, how('none', false)).issue, 'prompt-leading-dash', 'entry none');
  assert.equal(start.promptState('-x', undefined, how('do', false)).issue, null, 'stdin with the do skill: the entry line comes first');
  assert.equal(start.promptState('@file', undefined, how('do', true)).issue, 'prompt-leading-at');
  assert.equal(start.promptState('@file', undefined, how('do', false)).issue, null);
  assert.equal(start.promptState('a\u0000b', undefined, how('do', false)).issue, 'prompt-nul');
  const form = { ...start.formFor(options({ checkouts: [options().checkouts[1]] })), harness: 'opencode', prompt: '-rf' };
  assert.deepEqual(start.readiness(form, options({ checkouts: [options().checkouts[1]] })).missing, ['prompt']);
});

test('Start is ready only with a checkout, a startable harness and a text; a running dispatch holds it', () => {
  const o = options({ checkouts: [options().checkouts[1]] });
  const form = { ...start.formFor(o), harness: 'claude', prompt: 'Fix the flaky test' };
  assert.equal(start.readiness(form, o).ok, true);
  assert.equal(start.readiness({ ...form, harness: 'codex' }, o).ok, false, 'a harness that cannot start is not ready');
  const held = options({ checkouts: [options().checkouts[1]], dispatch: { running: true, slug: '165-start' } });
  assert.equal(start.readiness(form, held).ok, false);
  assert.equal(start.readiness(form, held).dispatch, 'A dispatch is running in 165-start; start again when it ends.');
  const unread = options({ checkouts: [options().checkouts[1]], dispatch: { running: true, slug: null, reason: 'dispatch-unreadable' } });
  assert.equal(start.readiness(form, unread).ok, false);
  assert.equal(start.readiness(form, unread).dispatch, 'This project’s dispatch records cannot be read, so a running dispatch cannot be ruled out; start again when they can be read.');
  assert.equal(start.startRefusalLines('dispatch-running', { slug: null, reason: 'dispatch-unreadable' })[0], 'This project’s dispatch records cannot be read, so a running dispatch cannot be ruled out. Nothing was started.');
  assert.deepEqual(start.startBody(form), { v: 1, projectKey: PK, worktreeKey: WK1, harness: 'claude', model: null, provider: null, effort: null, entry: 'do', prompt: 'Fix the flaky test' });
  const bound = { ...form, choice: { model: 'gpt-y', provider: 'openai', effort: 'low' } };
  assert.deepEqual(start.startBody(bound), { v: 1, projectKey: PK, worktreeKey: WK1, harness: 'claude', model: 'gpt-y', provider: 'openai', effort: 'low', entry: 'do', prompt: 'Fix the flaky test' });
});

test('the entry choices say the default first with the core\'s fixed line; the limits read as one line', () => {
  const entries = start.entryChoices(options());
  assert.deepEqual(entries.map((e: any) => [e.id, e.label]), [['do', 'Start with DoFlow\'s do skill'], ['none', 'Send my text only']]);
  assert.match(entries[0].note, /Use the DoFlow do skill for this request:/);
  assert.equal(start.limitWords(options()), '1 of 4 sessions open on this machine; 1 per checkout, 2 per device and 6 starts per device per hour.');
  assert.deepEqual(start.checkoutRows(options()).map((c: any) => c.label), ['do-flow', 'do-flow-fu25'], 'the main checkout first');
});

test('the state of a start goes starting, running, streaming, ended; the output moves it only from running; a phase of ended ends it', () => {
  const run = { runId: 'w-0123456789ab', kind: 'main-session', phase: 'running', harness: 'claude', model: null, modelSource: 'default', worktreeKey: WK1, startedBy: 'console', createdAt: '2026-11-16T09:00:00.000Z', agentKey: 'cccccccccccccccc', layers: `/layers/${PK}/agent/cccccccccccccccc`, files: { out: 'dddddddddddddddd', err: 'eeeeeeeeeeeeeeee' } };
  const info = { harness: 'claude', model: null, project: 'do-flow', checkout: 'do-flow' };
  let flow = start.initialFlow();
  assert.equal(flow.step, 'form');
  flow = start.flowReduce(flow, { type: 'sending', info });
  assert.equal(flow.step, 'starting');
  assert.equal(start.flowWords(flow).title, 'Starting claude in do-flow / do-flow…');
  flow = start.flowReduce(flow, { type: 'output', text: true });
  assert.equal(flow.step, 'starting', 'an output before the reply changes nothing');
  flow = start.flowReduce(flow, { type: 'reply', reply: { status: 200, headers: {}, body: { v: 1, outcome: 'applied', result: { replayed: false, run } } } });
  assert.equal(flow.step, 'running');
  assert.equal(start.flowWords(flow).stop, true);
  assert.match(start.flowWords(flow).lines[0], /No output yet/);
  flow = start.flowReduce(flow, { type: 'output', text: false });
  assert.equal(flow.step, 'running');
  flow = start.flowReduce(flow, { type: 'output', text: true });
  assert.equal(flow.step, 'streaming');
  assert.match(start.flowWords(flow).lines[0], /masked, the last 200 lines/);
  flow = start.flowReduce(flow, { type: 'node', node: { phase: 'running', ended: null } });
  assert.equal(flow.step, 'streaming', 'a running node changes nothing');
  flow = start.flowReduce(flow, { type: 'node', node: { phase: 'ended', ended: { at: '2026-11-16T09:05:00.000Z', result: 'exited' }, end: { state: 'exited', exitCode: null, reason: null } } });
  assert.equal(flow.step, 'ended');
  assert.equal(start.flowWords(flow).lines[0], 'The session exited. Its error output is below.');
  assert.equal(start.flowReduce(flow, { type: 'again' }).step, 'form');
  // A reply that is already ended (a replay of a finished run) is ended at once.
  assert.equal(start.flowReduce(start.flowReduce(start.initialFlow(), { type: 'sending', info }), { type: 'reply', reply: { status: 200, headers: {}, body: { result: { run: { ...run, phase: 'ended', end: { state: 'cancelled', at: '2026-11-16T09:01:00.000Z' } } } } } }).step, 'ended');
  const end = (state: string, exitCode: number | null = null, reason: string | null = null) => ({ state, exitCode, reason });
  assert.deepEqual([end('exited', 0), end('exited', 3), end('exited'), end('timed-out'), end('cancelled'), end('exited', null, 'prompt-unwritable'), null].map((e) => start.endWords(e)), [
    'The session exited with code 0.', 'The session exited with code 3. Its error output is below.', 'The session exited. Its error output is below.',
    'The session passed its 3600 s limit and was stopped.', 'The session was stopped.', 'The session did not start: its prompt could not be written. Nothing ran.', 'The session ended.',
  ]);
  // 165 F2: the page words the end from the node's own `end`, with no machine list in sight.
  const ended = (e: any) => start.flowWords({ ...flow, step: 'ended', node: { phase: 'ended', end: e } });
  assert.equal(ended(end('exited', 3)).lines[0], 'The session exited with code 3. Its error output is below.');
  assert.equal(ended(end('exited', null, 'prompt-unwritable')).token, 'failed');
  assert.equal(ended(end('exited', 3)).token, 'unknown');
});

test('a refusal is the refused state with its words; no answer is unknown, never refused or started', () => {
  const info = { harness: 'claude', model: null, project: 'do-flow', checkout: 'do-flow' };
  const sending = start.flowReduce(start.initialFlow(), { type: 'sending', info });
  const refused = start.flowReduce(sending, { type: 'reply', reply: { status: 409, headers: {}, body: { error: { code: 'dispatch-running', verb: 'start-session', exit: 1 }, current: { slug: '165-start', dispatchId: null, driverPid: 77, reason: null } } } });
  assert.equal(refused.step, 'refused');
  assert.deepEqual(start.flowWords(refused).lines, ['A dispatch is running in 165-start; start again when it ends. Nothing was started.']);
  const limited = start.flowReduce(sending, { type: 'reply', reply: { status: 429, headers: { 'retry-after': '120' }, body: { error: { code: 'start-rate-limited' } } } });
  assert.deepEqual(start.flowWords(limited).lines, ['Too many sessions were started from this device in the last hour. Nothing was started.', 'Try again in 120 s.']);
  for (const reply of [null, { status: 504, headers: {}, body: { error: { code: 'action-timeout' } } }]) {
    const unknown = start.flowReduce(sending, { type: 'reply', reply });
    assert.equal(unknown.step, 'unknown');
    assert.deepEqual(start.flowWords(unknown).lines[0], 'No answer; check Sessions before trying again.');
  }
});

test('every refusal id and reason id of the start has its own words, and the ones that read again say so', () => {
  const ids = ['prompt-empty', 'prompt-nul', 'prompt-too-long', 'prompt-leading-dash', 'prompt-leading-at', 'unknown-worktree', 'worktree-gone', 'project-not-found', 'model-not-offered', 'checkout-busy', 'checkout-busy-unknown',
    'dispatch-running', 'harness-not-startable', 'nested-start', 'actor-limit', 'machine-limit', 'start-rate-limited', 'request-reused', 'core-lacks-action', 'action-timeout'];
  const seen = new Set<string>();
  for (const id of ids) {
    const lines = start.startRefusalLines(id, {});
    assert.ok(lines.length > 0 && lines[0] !== '', id);
    assert.doesNotMatch(lines.join(' '), /refused the action \(/, `${id} has its own words, not the fallback`);
    seen.add(lines[0]);
  }
  assert.equal(seen.size, ids.length, 'no two ids share a sentence');
  assert.equal(start.startRefusalLines('harness-not-startable', { harness: 'codex', reason: 'logged-out' })[0], 'codex cannot start here: it is logged out. Nothing was started.');
  for (const [reason, words] of [['not-installed', 'it is not installed on this machine'], ['no-main-session-shape', 'DoFlow has no recorded headless way to start it'], ['not-listed', 'it is not a DoFlow harness']]) {
    assert.match(start.startRefusalLines('harness-not-startable', { harness: 'kiro', reason })[0], new RegExp(words));
  }
  assert.match(start.startRefusalLines('model-not-offered', { harness: 'claude', models: [] })[0], /claude does not offer that model any more/);
  assert.equal(start.startRefusalLines('actor-limit', { open: 2, max: 2 })[0], 'This device already has 2 of 2 sessions open. Stop one from Layers, then start again. Nothing was started.');
  assert.equal(start.startRefusalLines('machine-limit', { open: 4, max: 4 })[0], 'This machine already has 4 of 4 sessions open. Stop one from Layers, then start again. Nothing was started.');
  assert.deepEqual(start.startRefusalLines('phone-scope'), ['This device may only read. Pair a control device from the Android app to act.'], 'a generic id keeps the words of derive/actions.js');
  assert.deepEqual(['worktree-gone', 'checkout-busy', 'dispatch-running', 'prompt-empty', 'request-reused'].map((id) => start.refusalRereads(id)), [true, true, true, false, false]);
  // 165 review A-1: the unknown hold names the cancel that clears it, with the run id the core gave.
  assert.match(start.startRefusalLines('checkout-busy-unknown', { runId: 'w-aaaabbbbcccc' }).join(' '), /doflow worker --action cancel --operator --slug started-sessions --worker-run w-aaaabbbbcccc --via console --reason ended/);
  assert.equal(start.refusalRereads('checkout-busy-unknown'), true);
});

test('a new request id comes with every submit; a retry of an unanswered one keeps its id, and any other outcome drops it', () => {
  let n = 0;
  const makeId = () => `id-${(n += 1)}`;
  const body = start.startBody({ projectKey: PK, worktreeKey: WK1, harness: 'claude', choice: null, entry: 'do', prompt: 'a' });
  const first = start.attemptFor(null, body, makeId);
  assert.deepEqual([first.requestId, first.retry], ['id-1', false]);
  assert.equal(start.settleAttempt(first, 'applied'), null);
  assert.equal(start.settleAttempt(first, 'refused'), null);
  assert.equal(start.settleAttempt(first, 'stale'), null);
  const kept = start.settleAttempt(first, 'unknown');
  assert.equal(kept, first, 'a 504 keeps the attempt');
  const retry = start.attemptFor(kept, body, makeId);
  assert.deepEqual([retry.requestId, retry.retry], ['id-1', true], 'the retry reuses the id');
  const edited = start.attemptFor(kept, { ...body, prompt: 'b' }, makeId);
  assert.deepEqual([edited.requestId, edited.retry], ['id-2', false], 'a changed body is a new request');
  assert.equal(start.attemptFor(null, body, makeId).requestId, 'id-3', 'every submit after a settled one is new');
});

test('the view-only words are fixed text', () => {
  assert.equal(start.VIEW_ONLY_WORDS, 'Starting a session needs this machine’s Console or a phone paired with control over the app.');
});

/** The flags of a command line: `required` outside `[...]`, `optional` inside, `--action` left out (it names the verb). @param {string} line */
function flagsOf(line: string) {
  const required = new Set<string>();
  const optional = new Set<string>();
  let depth = 0;
  for (const token of line.match(/\[|\]|--[a-z][a-z-]*/g) ?? []) {
    if (token === '[') depth += 1;
    else if (token === ']') depth -= 1;
    else if (token !== '--action') (depth > 0 ? optional : required).add(token);
  }
  return { required: [...required].sort(), optional: [...optional].sort() };
}

test('165 review B-3: the terminal command of a view-only page is the full runnable one, and the page, the reference and the core list the same flags', () => {
  const { START_FLAGS } = require('../../src/runtime/worker/start-session.ts');
  const core = { required: [...START_FLAGS.required].sort(), optional: [...START_FLAGS.optional].sort() };
  const reference = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'reference.md'), 'utf8');
  const line = /^\*\*Command\.\*\* `(doflow worker --action start-session [^`]+)`/m.exec(reference);
  assert.ok(line, 'docs/reference.md has the start-session Command line');
  assert.deepEqual(flagsOf(line![1]), core, 'the reference names the core\'s required and optional flags');

  const id = 'Abcdefghijklmnopqrstuv';
  const full = start.terminalCommand({ projectKey: PK, worktreeKey: WK1, harness: 'codex', choice: { model: 'gpt-5.4', provider: null, effort: null }, entry: 'none' }, id);
  assert.equal(full, `doflow worker --action start-session --project-key ${PK} --worktree-key ${WK1} --harness codex --model gpt-5.4 --entry none --request-id ${id} --stdin`);
  // 169: a bound provider and effort add their flags, both in the core's START_FLAGS.optional.
  const triple = start.terminalCommand({ projectKey: PK, worktreeKey: WK1, harness: 'pi', choice: { model: 'gpt-y', provider: 'openai', effort: 'low' }, entry: 'do' }, id);
  assert.equal(triple, `doflow worker --action start-session --project-key ${PK} --worktree-key ${WK1} --harness pi --model gpt-y --provider openai --effort low --entry do --request-id ${id} --stdin`);
  for (const flag of flagsOf(triple).required) assert.ok(core.required.includes(flag) || core.optional.includes(flag), `${flag} is a flag the core takes`);
  const page = flagsOf(full).required;
  for (const flag of core.required) assert.ok(page.includes(flag), `the page's command has ${flag}`);
  for (const flag of page) assert.ok(core.required.includes(flag) || core.optional.includes(flag), `${flag} is a flag the core takes`);

  // The harness default sends no --model; the entry defaults to do, as the form does.
  const plain = start.terminalCommand({ projectKey: PK, worktreeKey: WK1, harness: 'claude', choice: null, entry: 'do' }, id);
  assert.deepEqual(flagsOf(plain).required, core.required, 'without a model the command has exactly the required flags');
  assert.ok(!/<|>/.test(plain), 'every value is filled in');
  // A choice the page does not hold, or one outside the core's pattern, is the reference's placeholder, never pasted into the shell.
  const open = start.terminalCommand({ projectKey: null, worktreeKey: 'nope', harness: 'a b', choice: { model: 'x;rm', provider: 'a b', effort: 'x;y' }, entry: 'maybe' }, 'short');
  assert.equal(open, 'doflow worker --action start-session --project-key <16 hex> --worktree-key <16 hex> --harness <id> --entry do --request-id <id> --stdin');
  assert.deepEqual(flagsOf(open).required, core.required);
});

test('the agent key of a started run is the first 16 hex of the SHA-256 of `worker:<runId>`, as the core derives it', () => {
  for (const text of ['', 'abc', 'worker:w-0123456789ab', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'héllo 🙂'.repeat(20)]) {
    assert.equal(start.sha256Hex(text), crypto.createHash('sha256').update(text, 'utf8').digest('hex'), text.slice(0, 12));
  }
  assert.equal(start.agentKeyOf('w-0123456789ab'), crypto.createHash('sha256').update('worker:w-0123456789ab').digest('hex').slice(0, 16));
});

const machine = (items: any[], projects: any[] | null = [{ projectKey: PK, label: 'do-flow', current: true, temp: false, checkouts: 2, lastRecordAt: null }]) => ({
  v: 1, sections: {
    projects: projects === null ? { ok: false, code: 'core-error' } : { ok: true, data: { projects, excluded: { missing: 0 }, truncated: false, store: 'present' } },
    activity: { ok: true, data: { v: 1, limits: {}, items } },
  },
});
const startedItem = (n: number, over: any = {}) => ({ runId: `w-00000000000${n}`, harness: 'claude', model: n === 0 ? null : 'claude-opus-5-5', phase: 'running', startedBy: 'console', worktreeKey: WK1, createdAt: `2026-11-16T09:0${n}:00.000Z`, ...over });

test('"Started here" lists the started sessions of the project the Console runs in, each with its Layers link; a core that lists none is not-reported, not zero', () => {
  const body = machine([{ projectKey: PK, started: [startedItem(1), startedItem(0)], startedCount: 11 }]);
  const here = start.startedHere(body);
  assert.equal(here.state, 'ok');
  assert.equal(here.more, 9);
  assert.deepEqual(here.rows.map((r: any) => r.runId), ['w-000000000001', 'w-000000000000']);
  assert.equal(here.rows[0].href, `#/layers/${PK}/agent/${start.agentKeyOf('w-000000000001')}`);
  assert.equal(start.startedHere(machine([{ projectKey: PK, started: null, startedCount: null }])).state, 'not-reported');
  assert.equal(start.startedHere(machine([])).state, 'ok', 'a project with no activity item has none started');
  assert.deepEqual(start.startedHere(machine([], null)).state, 'unread');
  assert.equal(start.startedHere(null).state, 'unread');
  assert.equal('runIdOfNode' in start, false, '165 F2: the node carries its run id; no join through the machine list');
  assert.deepEqual(['console', 'manual', 'device.d-0123456789ab', null].map((b) => start.startedByWords(b)), ['started from the Console', 'started by command', 'started from paired device d-0123456789ab', 'starter not recorded']);
});

test('165 review B-4: "Started here" is every session started in the project, open and ended, with who started it; it is empty only when the store holds none', () => {
  const ended = startedItem(2, { phase: 'ended', startedBy: 'manual', end: { state: 'timed-out', at: '2026-11-16T10:00:00.000Z' } });
  const here = start.startedHere(machine([{ projectKey: PK, started: [startedItem(1, { startedBy: 'device.d-0123456789ab', end: null }), ended], startedCount: 2 }]));
  assert.deepEqual(here.rows.map((r: any) => [r.starter, r.end]), [['device.d-0123456789ab', null], ['terminal', { state: 'timed-out', at: '2026-11-16T10:00:00.000Z' }]]);
  assert.equal(here.empty, false);
  assert.deepEqual(['console', 'manual', 'device.d-0123456789ab', 'phone', null].map((b) => start.starterLabel(b)), ['console', 'terminal', 'device.d-0123456789ab', 'not recorded', 'not recorded']);
  assert.equal(start.startedHere(machine([{ projectKey: PK, started: [], startedCount: 0 }])).empty, true, 'the store holds none');
  assert.equal(start.startedHere(machine([{ projectKey: PK, started: [], startedCount: 3 }])).empty, false, 'the store holds some the list does not carry');
  assert.equal(start.startedHere(machine([])).empty, true);
  assert.equal(start.STARTED_HERE_TITLE, 'Sessions started in this project');
  assert.equal(start.STARTED_HERE_EMPTY, 'No session has been started in this project, from the Console, a paired device or a terminal.');
  assert.deepEqual([start.endedWords({ state: 'exited', at: null }), start.endedWords({ state: 'timed-out' }), start.endedWords({ state: 'cancelled' }), start.endedWords(null)], ['exited', 'stopped at its time limit', 'stopped', 'ended']);
});

test('the output tail keeps the last 200 lines of the pieces a file lane holds, joins pieces with a newline unless one was cut mid-line, and says how many it dropped', () => {
  const pieces = Array.from({ length: 250 }, (_, i) => ({ text: `line ${i}`, at: i * 10, cut: false }));
  const tail = start.outputTail(pieces);
  assert.equal(tail.lines.length, 200);
  assert.equal(tail.lines[0], 'line 50');
  assert.equal(tail.lines[199], 'line 249');
  assert.equal(tail.dropped, 50);
  assert.deepEqual(start.outputTail([{ text: 'ab', at: 0, cut: true }, { text: 'cd', at: 2, cut: false }, { text: 'ef', at: 4, cut: false }]).lines, ['abcd', 'ef']);
  assert.deepEqual(start.outputTail([]), { lines: [], dropped: 0 });
});

test('a failed read of the project list or the options says what happened in words, one for every status the server names, and never a harness default', () => {
  const words = (status: number | null, code: string | null) => start.optionsErrorWords({ status, code, network: status === null });
  assert.match(words(403, 'phone-scope'), /paired device|this device/i);
  assert.match(words(404, 'project-not-found'), /no longer|not in DoFlow/i);
  assert.match(words(501, 'core-lacks-verb'), /cannot start a session|update the core/i);
  assert.match(words(502, 'core-contract-mismatch'), /core answered/i);
  assert.match(words(502, 'core-error'), /core answered|core failed/i);
  assert.match(words(400, 'usage'), /could not be read/i);
  assert.match(words(null, null), /could not be reached|network/i);
  for (const [status, code] of [[403, 'phone-scope'], [404, 'project-not-found'], [501, 'core-lacks-verb'], [502, 'core-error'], [400, 'usage'], [null, null]] as any[]) assert.doesNotMatch(words(status, code), /default harness/i);
});

test('the layers node of a started run is found in the tree by its agent key; an unreadable or missing tree gives null', () => {
  const tree = (nodes: any[]) => ({ v: 1, sections: { tree: { ok: true, data: { v: 1, nodes } } } });
  const key = start.agentKeyOf('w-000000000001');
  assert.equal(start.nodeIn(tree([{ agentKey: 'x', kind: 'main-session' }, { agentKey: key, kind: 'started-session', phase: 'running' }]), key).phase, 'running');
  assert.equal(start.nodeIn(tree([]), key), null);
  assert.equal(start.nodeIn({ v: 1, sections: { tree: { ok: false, code: 'core-error' } } }, key), null);
  assert.equal(start.nodeIn(null, key), null);
});

// ---- 172 design §7.2: each row of the start form's words ----

const lines = (login: any, harness = 'claude') => start.loginLines(login, harness, AGO);

test('172 §7.2: logged-in says its source and, when known, the billing, and appends the recipe\'s caveat', () => {
  const at = '2026-11-16T08:00:00.000Z';
  assert.deepEqual(lines(loginOf('claude', { state: 'logged-in', reason: null, source: 'recipe', at, billing: { mode: 'subscription', billing: 'free' } })),
    ['claude is logged in on a subscription; its own login check said so <08:00 ago>.']);
  assert.deepEqual(lines(loginOf('claude', { state: 'logged-in', reason: null, source: 'recipe', at, billing: { mode: 'api-key', billing: 'metered' } })),
    ['claude is logged in with an API key; its own login check said so <08:00 ago>.']);
  assert.deepEqual(lines(loginOf('claude', { state: 'logged-in', reason: null, source: 'last-run', at, billing: 'mixed' })), ['claude is logged in; a run succeeded <08:00 ago>.'], 'mixed billing says nothing');
  assert.deepEqual(lines(loginOf('claude', { state: 'logged-in', reason: null, source: 'recipe', at, caveat: 'its help and docs do not show that this check runs offline' })),
    ['claude is logged in; its own login check said so <08:00 ago> (its help and docs do not show that this check runs offline).']);
});

test('172 §7.2: logged-out has no extra line; expired names the provider, the hint and, only when the check can clear it, the check', () => {
  assert.deepEqual(lines(loginOf('codex', { state: 'logged-out', reason: 'logged-out', source: 'recipe', at: '2026-11-16T07:50:00.000Z' })), []);
  const at = '2026-11-16T07:00:00.000Z';
  assert.deepEqual(lines(loginOf('pi', { state: 'expired', reason: null, source: 'last-run', at, provider: 'openai-codex', hint: 'pi auth login <provider>', expirySeen: true }), 'pi'),
    ['pi’s login expired for openai-codex on a run <07:00 ago>: run pi auth login <provider>. DoFlow shows it as expired until a run succeeds or its login check says logged in.']);
  assert.deepEqual(lines(loginOf('claude', { state: 'expired', reason: null, source: 'last-run', at, hint: 'claude auth login' })),
    ['claude’s login expired on a run <07:00 ago>: run claude auth login. DoFlow shows it as expired until a run succeeds.']);
  assert.deepEqual(lines(loginOf('antigravity', { state: 'expired', reason: null, source: 'last-run', at, hint: null }), 'antigravity'),
    ['antigravity’s login expired on a run <07:00 ago>. DoFlow shows it as expired until a run succeeds.'], 'no hint: no instruction');
});

test('172 §7.2: an expired answer that came from the login check says so, not "on a run"', () => {
  const at = '2026-11-16T07:00:00.000Z';
  assert.deepEqual(lines(loginOf('pi', { state: 'expired', reason: 'provider-expired', source: 'recipe', at, provider: 'openai-codex', hint: 'pi auth login <provider>' }), 'pi'),
    ['pi’s login expired for openai-codex in its login check <07:00 ago>: run pi auth login <provider>. DoFlow shows it as expired until its login check says otherwise.']);
  assert.deepEqual(lines(loginOf('claude', { state: 'expired', reason: 'provider-expired', source: 'recipe', at, caveat: 'unproven offline', hint: null })),
    ['claude’s login expired in its login check <07:00 ago> (unproven offline). DoFlow shows it as expired until its login check says otherwise.']);
});

test('172 §7.2: the four unknown rows say never checked, no check, stale and no answer', () => {
  assert.deepEqual(lines(loginOf('pi'), 'pi'), ['DoFlow has not checked that pi is logged in; doflow models --action sync checks it.']);
  assert.deepEqual(lines(loginOf('codex', { reason: 'no-recipe: its help documents no exit code' }), 'codex'), ['DoFlow cannot check codex’s login: its help documents no exit code.']);
  assert.deepEqual(lines(loginOf('codex', { reason: 'no-recipe' }), 'codex'), ['DoFlow cannot check codex’s login.']);
  assert.deepEqual(lines(loginOf('claude', { reason: 'stale', source: 'recipe', at: '2026-11-14T09:00:00.000Z', last: { state: 'logged-in', source: 'recipe', at: '2026-11-14T09:00:00.000Z' } })),
    ['claude’s login was last checked <09:00 ago> (logged-in); that is over a day old.']);
  assert.deepEqual(lines(loginOf('claude', { reason: 'stale', source: 'recipe', at: '2026-11-14T09:00:00.000Z', caveat: 'unproven offline', last: { state: 'logged-out', source: 'recipe', at: '2026-11-14T09:00:00.000Z' } })),
    ['claude’s login was last checked <09:00 ago> (logged-out) (unproven offline); that is over a day old.']);
  assert.deepEqual(lines(loginOf('claude', { reason: 'timeout', source: 'recipe', at: '2026-11-16T08:00:00.000Z' })), ['claude’s login check gave no answer: timeout.']);
});

test('172 §7.2: a stale answer whose last was a run says a run, not a login check', () => {
  assert.deepEqual(lines(loginOf('claude', { reason: 'stale', source: 'last-run', at: '2026-11-14T09:00:00.000Z', last: { state: 'logged-in', source: 'last-run', at: '2026-11-14T09:00:00.000Z' } })),
    ['claude’s login was last seen on a run <09:00 ago> (logged-in); that is over a day old.']);
});

test('172 §7.2: a harness with providers adds one line each, `<id>: <state>[, <mode>]`; no login says nothing', () => {
  const pi = loginOf('pi', { state: 'logged-in', reason: null, source: 'recipe', at: '2026-11-16T08:00:00.000Z', billing: 'mixed', providers: [
    { id: 'anthropic', state: 'logged-in', mode: 'subscription', reason: null }, { id: 'openai-codex', state: 'logged-out', mode: null, reason: 'not logged in' }] });
  assert.deepEqual(lines(pi, 'pi'), ['pi is logged in; its own login check said so <08:00 ago>.', 'anthropic: logged-in, subscription', 'openai-codex: logged-out']);
  assert.deepEqual(lines(null), []);
  assert.deepEqual(lines(undefined), []);
});

test('172 IC-004: harnessRows carries the sentence per row from the options, the relative time from the page, and the warning ids login-unknown and login-expired have words; login-not-checked has none', () => {
  const rows = start.harnessRows(options(), AGO);
  const by = (id: string) => [...rows.startable, ...rows.blocked].find((r: any) => r.harness === id);
  assert.deepEqual(by('claude').loginLines, ['claude is logged in on a subscription; its own login check said so <08:00 ago>.']);
  assert.deepEqual(by('pi').loginLines, ['DoFlow has not checked that pi is logged in; doflow models --action sync checks it.']);
  assert.deepEqual(by('opencode').loginLines, [], 'a harness with no answer says nothing');
  assert.deepEqual(by('pi').warnings.filter((w: any) => w.id.startsWith('login-')).map((w: any) => [w.id, w.words]), [['login-unknown', 'DoFlow cannot tell whether pi is logged in.']]);
  assert.equal(start.warningWords('login-expired', 'pi'), 'pi’s login has expired.');
  assert.equal(start.warningWords('login-not-checked', 'pi'), null, 'the old warning id is gone');
});

// ---- 170 design §10: the harness row says whether it can be talked to ----

const channelFact = (over: any = {}) => ({ state: 'supported', reason: null, liveVerified: true, unverified: [], ...over });

test('170 §10 start form: supported and live-verified says "You can talk to it while it runs." and nothing else', () => {
  const opts = options();
  opts.harnesses[3].channel = channelFact();
  const pi = start.harnessRows(opts).startable.find((r: any) => r.harness === 'pi');
  assert.deepEqual(pi.channel, { state: 'supported', line: 'You can talk to it while it runs.', warning: null });
  assert.equal(start.CHANNEL_TALK, 'You can talk to it while it runs.');
});

test('170 §10 start form: supported but not live-verified adds the warning with the first thing unverified', () => {
  const opts = options();
  opts.harnesses[3].channel = channelFact({ liveVerified: false, unverified: ['turn events in rpc mode', 'steer taken while working', 'exit after stdin closes'] });
  const pi = start.harnessRows(opts).startable.find((r: any) => r.harness === 'pi');
  assert.deepEqual([pi.channel.line, pi.channel.warning], ['You can talk to it while it runs.', 'Talking to it is not verified on a live run: turn events in rpc mode.']);
  opts.harnesses[3].channel = channelFact({ liveVerified: false, unverified: [] });
  assert.equal(start.harnessRows(opts).startable.find((r: any) => r.harness === 'pi').channel.warning, 'Talking to it is not verified on a live run.');
});

test('170 §10 start form: unsupported and unknown say it runs one prompt and the reason Send is unavailable, without a doubled full stop', () => {
  const opts = options();
  opts.harnesses[0].channel = channelFact({ state: 'unknown', reason: 'no recorded capture shows an input mode for later messages for claude; nothing is inferred from another harness.', liveVerified: false });
  opts.harnesses[2].channel = channelFact({ state: 'unsupported', reason: 'the harness reads one prompt and exits', liveVerified: false });
  opts.harnesses[3].channel = channelFact({ state: 'unknown', reason: null, liveVerified: false });
  const rows = start.harnessRows(opts).startable;
  const line = (harness: string) => rows.find((r: any) => r.harness === harness).channel;
  assert.deepEqual(line('claude'), { state: 'unknown', line: 'Runs one prompt; Send is unavailable: no recorded capture shows an input mode for later messages for claude; nothing is inferred from another harness.', warning: null });
  assert.equal(line('opencode').line, 'Runs one prompt; Send is unavailable: the harness reads one prompt and exits.');
  assert.equal(line('pi').line, 'Runs one prompt; Send is unavailable: no reason recorded.');
});

test('170 §10 start form: a core that sent no channel fact is not claimed to have or lack one', () => {
  for (const row of [...start.harnessRows(options()).startable, ...start.harnessRows(options()).blocked]) assert.equal(row.channel, null, row.harness);
  assert.equal(start.channelWords(undefined), null);
  assert.equal(start.channelWords('supported'), null);
});

test('170: the flow keeps the run\'s channels entry beside its node, only once there is a run, and the entry changes no step', () => {
  const run = { runId: 'w-0123456789ab', kind: 'main-session', phase: 'running', harness: 'pi', files: { out: 'dddddddddddddddd', err: 'eeeeeeeeeeeeeeee' } };
  const channels = { state: 'ok', code: null, item: { runId: run.runId, channel: 'open' } };
  const before = start.flowReduce(start.initialFlow(), { type: 'channel', channels });
  assert.deepEqual(before.channels, { state: 'absent', code: null, item: null }, 'no run yet: nothing is kept');
  let flow = start.flowReduce(start.flowReduce(start.initialFlow(), { type: 'sending', info: { harness: 'pi', model: null, project: 'p', checkout: 'c' } }), { type: 'reply', reply: { status: 200, headers: {}, body: { result: { run } } } });
  flow = start.flowReduce(flow, { type: 'channel', channels });
  assert.deepEqual([flow.step, flow.channels], ['running', channels]);
  assert.deepEqual(start.flowReduce(flow, { type: 'again' }).channels, { state: 'absent', code: null, item: null });
});

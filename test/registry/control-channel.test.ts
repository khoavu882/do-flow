'use strict';

// 170 design §4 (C0-C7) and R-4: `worker.controlChannel`, grammar `control-channel-v1`. The valid Pi shape of design §11
// passes; every rule has one refusal naming the JSON location inside the entry it refers to, through the validator
// itself and through validateWorker (so a built-in descriptor and a package worker take the same checks).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const { loadRegistry, validateWorker } = require('../../src/registry/index.ts');
const { validateControlChannel, PLACEHOLDERS } = require('../../src/registry/control-channel.ts');

const registry = loadRegistry({ repoRoot: REPO });
const piWorker = () => structuredClone(registry.harnesses.find((h: any) => h.id === 'pi').worker);
const CTX = { binary: 'pi', mainSessionStatus: 'supported', parsers: ['pi-json-v1'], harnessId: 'pi' };

/** Design §11, Pi's row, with the owner's R-4 command prefix. */
function piChannel(): any {
  const record = (behavior: string) => ({ type: 'prompt', message: '{text}', streamingBehavior: behavior, id: '{id}' });
  return {
    status: 'supported',
    evidence: ['core/worker-evidence/pi/2026-11-17-doc-check.json'],
    verification: 'Read the recorded doc checks.',
    verifiedOn: '2026-11-17',
    argv: ['--mode', 'rpc', '--no-approve'],
    framing: 'jsonl-lf',
    parser: 'pi-json-v1',
    messages: { followUp: record('followUp'), steer: record('steer'), stop: { type: 'abort', id: '{id}' } },
    turn: { working: [{ path: ['type'], equals: 'agent_start' }], settled: [{ path: ['type'], equals: 'agent_settled' }] },
    answer: {
      id: ['id'],
      accepted: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: true }],
      refused: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: false }],
    },
    close: { stdinEof: 'exits', graceSeconds: 10 },
    unverified: ['turn events in rpc mode', 'steer taken while working', 'exit after stdin closes'],
    commandPrefix: '/',
  };
}

/** The errors of one entry, after `mutate` changed a fresh copy. */
function errorsOf(mutate: (entry: any) => void, ctx: any = CTX): string[] {
  const entry = piChannel();
  mutate(entry);
  const errors: string[] = [];
  validateControlChannel(entry, "harness 'pi' worker 'controlChannel'", errors, ctx);
  return errors;
}

test('the valid Pi shape of design 11 (commandPrefix "/") passes, alone and inside a worker block', () => {
  assert.deepEqual(errorsOf(() => {}), []);
  assert.deepEqual(PLACEHOLDERS, ['{text}', '{id}']);
  const worker = piWorker();
  worker.controlChannel = piChannel();
  const errors: string[] = [];
  validateWorker(worker, "harness 'pi'", errors);
  assert.deepEqual(errors, []);
});

test('a channel without a commandPrefix, without steer and without answer is valid when it holds no {id}', () => {
  assert.deepEqual(errorsOf((c) => {
    delete c.commandPrefix; delete c.messages.steer; delete c.answer;
    c.messages.followUp = { type: 'prompt', message: '{text}' };
    c.messages.stop = { type: 'abort' };
  }), []);
});

test('unknown and unsupported entries take no recipe field here; unsupported needs a reason', () => {
  const errors: string[] = [];
  validateControlChannel({ status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-11-17', reason: 'r' }, 'loc', errors, CTX);
  validateControlChannel({ status: 'unsupported', evidence: ['e'], verification: 'v', verifiedOn: '2026-11-17', reason: 'no input mode' }, 'loc', errors, CTX);
  assert.deepEqual(errors, []);
  validateControlChannel({ status: 'unsupported', evidence: ['e'], verification: 'v', verifiedOn: '2026-11-17' }, 'loc', errors, CTX);
  assert.match(errors.join('\n'), /^loc: unsupported requires a reason$/);
});

const REFUSED: Array<[string, (c: any) => void, RegExp]> = [
  ['{text} inside a longer string', (c) => { c.messages.followUp.message = 'say: {text}'; }, /messages\.followUp\.message: a placeholder .* is a whole string value, never part of one/],
  ['two {text} in followUp', (c) => { c.messages.followUp.extra = '{text}'; }, /messages\.followUp: holds \{text\} exactly once/],
  ['no {text} in steer', (c) => { c.messages.steer.message = 'x'; }, /messages\.steer: holds \{text\} exactly once/],
  ['{text} in stop', (c) => { c.messages.stop.message = '{text}'; }, /messages\.stop: a stop record holds no \{text\}/],
  ['{id} without answer', (c) => { delete c.answer; }, /messages\.followUp: holds \{id\} but no 'answer' is declared to match it/],
  ['answer with a template lacking {id}', (c) => { delete c.messages.stop.id; }, /messages\.stop: holds \{id\} once because 'answer' is declared/],
  ['{id} twice in one template', (c) => { c.messages.stop.other = '{id}'; }, /messages\.stop: holds \{id\} at most once/],
  ['two equal templates', (c) => { c.messages.steer = structuredClone(c.messages.followUp); }, /messages\.steer: equals messages\.followUp/],
  ['a key __proto__', (c) => { Object.defineProperty(c.messages.stop, '__proto__', { value: 'x', enumerable: true, configurable: true, writable: true }); }, /messages\.stop\.__proto__: a key must not be '__proto__'/],
  ['a key outside the segment pattern', (c) => { c.messages.stop['a b'] = 'x'; }, /messages\.stop\.a b: a key matches/],
  ['depth 3', (c) => { c.messages.stop.a = { b: { c: 'x' } }; }, /messages\.stop\.a\.b: a template is at most 2 objects deep/],
  ['nine keys', (c) => { for (let i = 0; i < 8; i += 1) c.messages.stop[`k${i}`] = 'x'; }, /messages\.stop: an object holds at most 8 keys/],
  ['a 201-char literal', (c) => { c.messages.stop.note = 'x'.repeat(201); }, /messages\.stop\.note: a string literal is at most 200 characters/],
  ['a non-finite number', (c) => { c.messages.stop.n = Infinity; }, /messages\.stop\.n: a number must be finite/],
  ['an array value', (c) => { c.messages.stop.list = ['x']; }, /messages\.stop\.list: a value is a string/],
  ['framing ndjson', (c) => { c.framing = 'ndjson'; }, /\.framing: 'framing' is 'jsonl-lf'/],
  ['graceSeconds 0', (c) => { c.close.graceSeconds = 0; }, /close\.graceSeconds: 'graceSeconds' is an integer from 1 to 60/],
  ['graceSeconds 61', (c) => { c.close.graceSeconds = 61; }, /close\.graceSeconds: 'graceSeconds' is an integer from 1 to 60/],
  ['graceSeconds 1.5', (c) => { c.close.graceSeconds = 1.5; }, /close\.graceSeconds/],
  ['stdinEof closes', (c) => { c.close.stdinEof = 'closes'; }, /close\.stdinEof: 'stdinEof' is 'exits'/],
  ['an unknown top key', (c) => { c.handshake = []; }, /: unknown key 'handshake'/],
  ['a missing close', (c) => { delete c.close; }, /: missing key 'close'/],
  ['an unknown message kind', (c) => { c.messages.resume = { type: 'x', id: '{id}' }; }, /messages: unknown key 'resume'/],
  ['{prompt} in argv', (c) => { c.argv.push('{prompt}'); }, /\.argv: argv must not contain the placeholder '\{prompt\}'/],
  ['-- in argv', (c) => { c.argv.push('--'); }, /\.argv: argv must not contain the element '--'/],
  ['- in argv', (c) => { c.argv.push('-'); }, /\.argv: argv must not contain the element '-'/],
  ['33 argv elements', (c) => { c.argv = Array(33).fill('-x'); }, /\.argv: argv must have at most 32 elements/],
  ["Pi's widening flag in argv", (c) => { c.argv = ['--mode', 'rpc', '--approve']; }, /\.argv: argv must not contain the widening flag '--approve'/],
  ["Pi's short widening flag in argv", (c) => { c.argv = ['--mode', 'rpc', '-a']; }, /\.argv: argv must not contain the widening flag '-a'/],
  ['a working test equal to the settled one', (c) => { c.turn.working = structuredClone(c.turn.settled); }, /turn: working and settled can both match one event/],
  ['working and settled on different paths', (c) => { c.turn.working = [{ path: ['state'], equals: 'busy' }]; }, /turn: working and settled can both match one event/],
  ['accepted equal to refused', (c) => { c.answer.refused = structuredClone(c.answer.accepted); }, /answer: accepted and refused can both match one event/],
  ['a malformed test', (c) => { c.turn.working = [{ path: ['type'] }]; }, /turn\.working\[0\]: a test holds exactly one of/],
  ['an empty settled list', (c) => { c.turn.settled = []; }, /turn\.settled: holds 1 to 8 tests/],
  ['nine working tests', (c) => { c.turn.working = Array.from({ length: 9 }, (_, i) => ({ path: ['type'], equals: `s${i}` })); }, /turn\.working: holds 1 to 8 tests/],
  ['a bad answer id path', (c) => { c.answer.id = []; }, /answer\.id: a path is an array of 1 to 8 segments/],
  ['an unregistered parser', (c) => { c.parser = 'nope-v1'; }, /\.parser: 'nope-v1' is neither a registered parser/],
  ['unverified missing with no live-run evidence', (c) => { delete c.unverified; }, /\.unverified: is required unless an evidence item is a live-run record of this harness/],
  ['unverified empty', (c) => { c.unverified = []; }, /\.unverified: holds 1 to 8 phrases/],
  ['nine unverified phrases', (c) => { c.unverified = Array(9).fill('x'); }, /\.unverified: holds 1 to 8 phrases/],
  ['a 121-char unverified phrase', (c) => { c.unverified = ['x'.repeat(121)]; }, /unverified\[0\]: a phrase is 1 to 120/],
  ['a commandPrefix of ""', (c) => { c.commandPrefix = ''; }, /commandPrefix: 'commandPrefix' is 1 to 4 printable characters with no space/],
  ['a commandPrefix of 5 chars', (c) => { c.commandPrefix = '/////'; }, /commandPrefix: 'commandPrefix' is 1 to 4/],
  ['a commandPrefix with a space', (c) => { c.commandPrefix = '/ x'; }, /commandPrefix: 'commandPrefix' is 1 to 4/],
  ['a commandPrefix that is a zero-width character', (c) => { c.commandPrefix = '​'; }, /commandPrefix: 'commandPrefix' is 1 to 4/],
  ['a commandPrefix that is not a string', (c) => { c.commandPrefix = 7; }, /commandPrefix: 'commandPrefix' is 1 to 4/],
  ['an entry over 8 KiB', (c) => { c.verification = 'x'.repeat(9000); }, /the entry is \d+ bytes, at most 8192/],
];

for (const [name, mutate, pattern] of REFUSED) {
  test(`refused: ${name}`, () => {
    const errors = errorsOf(mutate);
    assert.ok(errors.length > 0, `${name}: no error`);
    assert.match(errors.join('\n'), pattern, `${name}: ${JSON.stringify(errors)}`);
    for (const error of errors) assert.match(error, /^harness 'pi' worker 'controlChannel'[.:]/, error);
  });
}

test('a live-run record of this harness stands in for unverified, and another harness\'s does not', () => {
  assert.deepEqual(errorsOf((c) => { delete c.unverified; c.evidence = ['core/worker-evidence/pi/2026-11-18-live-run-channel.json']; }), []);
  assert.match(errorsOf((c) => { delete c.unverified; c.evidence = ['core/worker-evidence/codex/2026-11-18-live-run-channel.json']; }).join('\n'), /unverified: is required/);
});

test('a supported channel with an unknown or unsupported mainSession is refused (C6)', () => {
  for (const status of ['unknown', 'unsupported']) {
    const errors = errorsOf(() => {}, { ...CTX, mainSessionStatus: status });
    assert.match(errors.join('\n'), new RegExp(`a supported channel needs a supported mainSession \\(it is ${status}\\)`));
  }
});

test('a parser may be this worker\'s own fieldMap id, or null', () => {
  assert.deepEqual(errorsOf((c) => { c.parser = 'acme-stream-v1'; }, { ...CTX, fieldMapId: 'acme-stream-v1' }), []);
  assert.deepEqual(errorsOf((c) => { c.parser = null; }), []);
});

test('secret flags and the worker\'s declared widening flags apply to the channel argv', () => {
  assert.match(errorsOf((c) => { c.argv = ['--mode', 'rpc', '--unsafe-thing']; }, { ...CTX, declared: [{ flag: '--unsafe-thing' }] }).join('\n'), /widening flag '--unsafe-thing'/);
  assert.match(errorsOf((c) => { c.argv = ['--api-key']; }, { ...CTX, binary: 'claude', secretDeclared: [{ flag: '--api-key' }] }).join('\n'), /secret-printing flag or command '--api-key'/);
});

test('validateWorker: the channel is checked once, with the block\'s mainSession, binary and harness (no double report)', () => {
  const worker = piWorker();
  worker.controlChannel = piChannel();
  worker.controlChannel.argv = ['--mode', 'rpc', '--approve', '{prompt}'];
  const errors: string[] = [];
  validateWorker(worker, "harness 'pi'", errors);
  const own = errors.filter((e) => e.includes("worker 'controlChannel'"));
  assert.equal(own.filter((e) => /widening flag/.test(e)).length, 1, JSON.stringify(own));
  assert.equal(own.filter((e) => /\{prompt\}/.test(e)).length, 1, JSON.stringify(own));
  // pi's mainSession is supported in the shipped block, so C6 stays quiet; an unknown one is refused.
  const unknownMain = piWorker();
  unknownMain.controlChannel = piChannel();
  unknownMain.mainSession = { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-11-17', reason: 'r' };
  const second: string[] = [];
  validateWorker(unknownMain, "harness 'pi'", second);
  assert.match(second.join('\n'), /worker 'controlChannel': .*needs a supported mainSession/);
  // a block with no mainSession reads as unknown
  const none = piWorker();
  none.controlChannel = piChannel();
  delete none.mainSession;
  const third: string[] = [];
  validateWorker(none, "harness 'pi'", third);
  assert.match(third.join('\n'), /worker 'controlChannel': .*needs a supported mainSession \(it is unknown\)/);
});

test('validateWorker: an unknown channel entry takes no recipe field, a supported one takes the grammar fields', () => {
  const worker = piWorker();
  worker.controlChannel.close = { stdinEof: 'exits', graceSeconds: 1 };
  const errors: string[] = [];
  validateWorker(worker, "harness 'pi'", errors);
  assert.match(errors.join('\n'), /worker 'controlChannel': recipe field 'close' is allowed only when status is supported/);
});

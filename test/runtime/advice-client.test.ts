'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { startFakeServer, spawnFakeServer } = require('../helper/fake-decision-server.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../src/runtime/advice/record.ts');
const { createAdviceClient } = require('../../src/runtime/advice/client.ts');

const REPO = path.resolve(__dirname, '../..');
const BASE_ADVICE = loadAdviceRegistry({ repoRoot: REPO }).registry;
const STORAGE = loadStorageRegistry({ repoRoot: REPO });
const CHOICE_SET: any = {
  state: 'Choose a capability tier for this task.',
  questions: [{ name: 'tier', type: 'choice', instructions: 'Choose a tier.', options: { light: 'Light', standard: 'Normal', frontier: 'Frontier' } }],
};
const YESNO_SET: any = {
  state: 'Check whether the documented trigger applies.',
  questions: [{ name: 'mcp-need', type: 'yesno', instructions: 'Is the trigger due?', no: 'Not due', yes: 'Due' }],
};

function fixture(t: any, { setting = true, endpoint, adviceOverrides = {}, lookup }: any = {}) {
  const home = tempDir(t, 'doflow-advice-home-');
  const project = tempDir(t, 'doflow-advice-project-');
  const roots = resolveRoots({
    registry: STORAGE, projectRoot: project,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') },
  });
  if (setting) {
    const file = path.join(roots['config-home'], 'decision-model.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, enabled: true, provider: 'ollama', endpoint: endpoint || 'http://127.0.0.1:11434', model: 'clef-flash' }));
  }
  const adviceRegistry = structuredClone(BASE_ADVICE);
  Object.assign(adviceRegistry, adviceOverrides);
  return {
    roots, project,
    createClient: (extra: any = {}) => createAdviceClient({
      adviceRegistry, roots, sources: {}, lookup, clock: () => new Date('2026-06-01T02:00:00.000Z'), ...extra,
    }),
  };
}

function loopbackLookup(host: any, options: any, callback: any) {
  callback(null, [{ address: '127.0.0.1', family: 4 }]);
}

function onClose(t: any, server: any) { t.after(() => server.close()); }

function records(roots: any) {
  return readWindow({ roots, now: () => new Date('2026-06-01T02:00:00.000Z') }).records.map((entry: any) => entry.record);
}

const SCORE_SET: any = { state: 'Assess this task.', questions: [{ name: 'impact', type: 'score', instructions: 'Assess impact.', criteria: ['Low', 'Medium', 'High'] }] };
const SCORE_REPLY: any = { type: 'score', score: 1.15, legend: { 0: 'Low', 1: 'Medium', 2: 'High' }, probabilities: { 0: 0.25, 1: 0.35, 2: 0.4 }, confidence: 0.7 };

test('score client retains numerical fields, criterion static agreement and score record', async (t) => {
  const server = await startFakeServer({ routes: { 'POST /v1/systemone': { status: 200, body: { answers: { impact: SCORE_REPLY } } } } });
  onClose(t, server);
  const { createClient, roots }: any = fixture(t, { endpoint: server.origin });
  const result = await createClient().ask({ questionSet: SCORE_SET, staticAnswer: 'High', caller: 'advise' });
  assert.equal(result.status, 'answered');
  const answer = result.answers[0];
  assert.equal(answer.pick, 'High');
  assert.equal(answer.pickIndex, 2);
  assert.equal(answer.score, 1.15);
  assert.deepEqual(answer.criteria, SCORE_SET.questions[0].criteria);
  assert.equal(answer.confidence, 0.7);
  assert.deepEqual(answer.probabilities, SCORE_REPLY.probabilities);
  assert.equal(answer.agrees, true);
  assert.deepEqual(answer.strength, { word: 'split', between: ['High', 'Medium'] });
  assert.ok(answer.pickId);
  const saved = records(roots)[0];
  assert.equal(saved.qtype, 'score');
  assert.equal(saved.score, 1.15);
  assert.equal(saved.static, 'High');
  const invalid = await createClient().ask({ questionSet: SCORE_SET, staticAnswer: '2', record: false });
  assert.equal(invalid.reason, 'config-invalid');
  assert.equal(server.requests.length, 1);
});

for (const scoreFirst of [false, true]) {
  test(`malformed mixed score reply writes no partial picks (score first ${scoreFirst})`, async (t) => {
    const questions: any = [CHOICE_SET.questions[0], SCORE_SET.questions[0]];
    if (scoreFirst) questions.reverse();
    const server = await startFakeServer({ routes: { 'POST /v1/systemone': { status: 200, body: { answers: {
      tier: { choice: 'standard', probabilities: { light: 0.1, standard: 0.8, frontier: 0.1 }, confidence: 0.7 },
      impact: { ...SCORE_REPLY, score: 0 },
    } } } } });
    onClose(t, server);
    const { createClient, roots }: any = fixture(t, { endpoint: server.origin });
    const result = await createClient().ask({ questionSet: { state: 'Mixed request.', questions }, caller: 'advise' });
    assert.equal(result.reason, 'malformed-reply');
    assert.deepEqual(result.answers, []);
    assert.equal(records(roots).filter((record: any) => record.type === 'pick').length, 0);
    assert.equal(records(roots).filter((record: any) => record.type === 'miss').length, 1);
  });
}

test('ask bounds stalled DNS without opening a request', { timeout: 1000 }, async (t) => {
  let requests = 0;
  const { createClient }: any = fixture(t, { endpoint: 'http://localhost:11434', lookup: () => {}, adviceOverrides: { timeoutMs: 40 } });
  const result = await createClient({ httpModule: { request() { requests += 1; throw new Error('unexpected request'); } } }).ask({ questionSet: CHOICE_SET, record: false });
  assert.equal(result.reason, 'timeout');
  assert.equal(requests, 0);
});

test('ask gives HTTP only the budget left after DNS', async (t) => {
  const server = await startFakeServer({ routes: { 'POST /v1/systemone': { status: 200, body: { answers: {} }, delayMs: 300 } } });
  onClose(t, server);
  const endpoint = server.origin.replace('127.0.0.1', 'localhost');
  const { createClient }: any = fixture(t, { endpoint, adviceOverrides: { timeoutMs: 200 }, lookup: (_host: any, _options: any, callback: any) => setTimeout(() => callback(null, [{ address: '127.0.0.1', family: 4 }]), 150) });
  const started = Date.now();
  const result = await createClient().ask({ questionSet: CHOICE_SET, record: false });
  assert.equal(result.reason, 'timeout');
  assert.ok(Date.now() - started < 300, 'DNS must not add another full HTTP timeout');
  assert.equal(server.requests.length, 1);
});

test('inspect includes stalled DNS in its total doctor budget', { timeout: 1000 }, async (t) => {
  let requests = 0;
  const { createClient }: any = fixture(t, { lookup: () => {}, adviceOverrides: { doctorBudgetMs: 40 } });
  const result = await createClient({ httpModule: { request() { requests += 1; throw new Error('unexpected request'); } } }).inspect({ endpoint: 'http://localhost:11434', model: 'clef-flash' });
  assert.equal(result.endpoint.state, 'unreachable');
  assert.equal(requests, 0);
});

test('inspect gives a probe only the doctor budget left after DNS', async (t) => {
  const server = await startFakeServer({ routes: { 'GET /api/version': { status: 200, body: { version: '0.40.2' }, delayMs: 300 } } });
  onClose(t, server);
  const endpoint = server.origin.replace('127.0.0.1', 'localhost');
  const { createClient }: any = fixture(t, { adviceOverrides: { doctorBudgetMs: 200, probeTimeoutMs: 200 }, lookup: (_host: any, _options: any, callback: any) => setTimeout(() => callback(null, [{ address: '127.0.0.1', family: 4 }]), 150) });
  const started = Date.now();
  const result = await createClient().inspect({ endpoint, model: 'clef-flash' });
  assert.equal(result.endpoint.state, 'unreachable');
  assert.ok(Date.now() - started < 300, 'DNS must consume the total doctor budget');
  assert.equal(server.requests.length, 1);
});

test('inspect probes a configured ninth model first and caps fallback probes at eight', async (t) => {
  const names: any = [...Array.from({ length: 8 }, (_, index) => `other-${index}`), 'clef-flash:latest'];
  const server = await startFakeServer({ routes: {
    'GET /api/version': { status: 200, body: { version: '0.40.2' } },
    'GET /api/tags': { status: 200, body: { models: names.map((name: any) => ({ name })) } },
    'POST /api/show': ({ body }: any) => ({ status: 200, body: { capabilities: body.model === 'clef-flash:latest' ? ['decision'] : ['completion'] } }),
  } });
  onClose(t, server);
  const { createClient } = fixture(t);
  const result = await createClient().inspect({ endpoint: server.origin, model: 'clef-flash' });
  assert.deepEqual(result.model, { installed: true, decisionCapable: true });
  const probes = server.requests.filter((request: any) => request.pathname === '/api/show');
  assert.equal(probes.length, 8);
  assert.equal(probes[0].body.model, 'clef-flash:latest');
});

test('IC-005 off returns before a socket and writes no record', async (t) => {
  const server = await startFakeServer();
  onClose(t, server);
  const { createClient, roots }: any = fixture(t, { setting: false, lookup: loopbackLookup });
  const result = await createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise' });
  assert.equal(result.status, 'off');
  assert.equal(result.reason, 'not-configured');
  assert.equal(server.requests.length, 0);
  assert.equal(records(roots).length, 0);
});

test('IC-005 pre-socket checks fail in order and never contact the server', async (t) => {
  const server = await startFakeServer();
  onClose(t, server);
  const base: any = fixture(t, { endpoint: server.origin, lookup: loopbackLookup });
  const invalidQuestions: any = { ...CHOICE_SET, questions: [] };
  assert.equal((await base.createClient().ask({ questionSet: invalidQuestions, kind: 'tier', caller: 'advise' })).reason, 'config-invalid');

  const smallState: any = fixture(t, { endpoint: server.origin, lookup: loopbackLookup, adviceOverrides: { limits: { ...BASE_ADVICE.limits, maxStateBytes: 4 } } });
  assert.equal((await smallState.createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise' })).reason, 'over-limit');

  const smallBody: any = fixture(t, { endpoint: server.origin, lookup: loopbackLookup, adviceOverrides: { limits: { ...BASE_ADVICE.limits, maxBodyBytes: 1 } } });
  assert.equal((await smallBody.createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise' })).reason, 'over-limit');

  const refused: any = fixture(t, { endpoint: 'http://model.example:11434', lookup: (_host: any, _options: any, callback: any) => callback(null, [{ address: '198.51.100.3', family: 4 }]) });
  const refusedResult = await refused.createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise' });
  assert.equal(refusedResult.reason, 'non-loopback');
  assert.match(refusedResult.detail, /only loopback addresses are allowed/);
  assert.equal(server.requests.length, 0);
});

test('IC-005 answered choice and yesno expose strength/agreement and record one pick each', async (t) => {
  const server = await startFakeServer({ routes: {
    'POST /v1/systemone': ({ body }: any) => ({
      status: 200,
      body: { answers: Object.fromEntries(Object.entries(body.questions).map(([name, question]) => [name,
        question.type === 'choice'
          ? { choice: 'standard', probabilities: { light: 0.1, standard: 0.85, frontier: 0.05 }, confidence: 0.71 }
          : { noul: 0.7 },
      ])) },
    }),
  } });
  onClose(t, server);
  const { createClient, roots }: any = fixture(t, { endpoint: server.origin, lookup: loopbackLookup });
  const client = createClient();
  const choice = await client.ask({ questionSet: CHOICE_SET, kind: 'tier', staticAnswer: 'standard', caller: 'advise', taskId: 'task-17' });
  assert.equal(choice.status, 'answered');
  assert.equal(choice.answers[0].pick, 'standard');
  assert.deepEqual(choice.answers[0].strength, { word: 'clear', between: null });
  assert.equal(choice.answers[0].agrees, true);
  assert.deepEqual(choice.answers[0].probabilities, { light: 0.1, standard: 0.85, frontier: 0.05 });
  assert.match(choice.answers[0].pickId, /^adv-[0-9]{13}-[0-9a-f]{6}$/);
  const yesno = await client.ask({ questionSet: YESNO_SET, kind: 'mcp-need', staticAnswer: 'no', caller: 'advise' });
  assert.equal(yesno.status, 'answered');
  assert.equal(yesno.answers[0].pick, 'yes');
  assert.deepEqual(yesno.answers[0].probabilities, { no: 0.30000000000000004, yes: 0.7 });
  assert.equal(yesno.answers[0].confidence, null);
  assert.equal(yesno.answers[0].agrees, false);
  const saved = records(roots).filter((entry: any) => entry.type === 'pick');
  assert.equal(saved.length, 2);
  assert.equal(saved.some((entry: any) => entry.pickId === choice.answers[0].pickId), true);
});

for (const scenario of [
  { reason: 'endpoint-missing', response: { status: 404, body: 'not json' } },
  { reason: 'model-missing', response: { status: 404, body: { error: 'model missing' } } },
  { reason: 'endpoint-rejected', response: { status: 400, body: { error: 'invalid request' } } },
  { reason: 'endpoint-rejected', response: { status: 302, headers: { location: '/' }, body: '' } },
  { reason: 'server-error', response: { status: 500, body: { error: 'failure' } } },
  { reason: 'malformed-reply', response: { status: 200, body: { answers: {} } } },
]) {
  test(`IC-005 unavailable: ${scenario.reason} maps to one miss and empty answers`, async (t) => {
    const server = await startFakeServer({ routes: { 'POST /v1/systemone': scenario.response } });
    onClose(t, server);
    const { createClient, roots }: any = fixture(t, { endpoint: server.origin, lookup: loopbackLookup });
    const result = await createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise' });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, scenario.reason);
    assert.deepEqual(result.answers, []);
    assert.equal(records(roots).filter((entry: any) => entry.type === 'miss').length, 1);
  });
}

test('IC-005 unavailable: a closed loopback port is unreachable and never rejects', async (t) => {
  const server = await startFakeServer();
  const endpoint = server.origin;
  await server.close();
  const { createClient, roots }: any = fixture(t, { endpoint, lookup: loopbackLookup });
  const result = await createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'unreachable');
  assert.deepEqual(result.answers, []);
  assert.equal(records(roots).filter((entry: any) => entry.type === 'miss').length, 1);
});

test('IC-005 unavailable: timeout covers a slow response and never rejects', async (t) => {
  const server = await startFakeServer({ routes: { 'POST /v1/systemone': { status: 200, body: { answers: {} }, delayMs: 500 } } });
  onClose(t, server);
  const { createClient, roots }: any = fixture(t, { endpoint: server.origin, lookup: loopbackLookup, adviceOverrides: { timeoutMs: 150 } });
  const result = await createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'timeout');
  assert.deepEqual(result.answers, []);
  assert.equal(records(roots).filter((entry: any) => entry.type === 'miss').length, 1);
});

test('141 F1: an endless 200 reply is cut at the response cap and recorded as one malformed-reply miss', { timeout: 10000 }, async (t) => {
  let written = 0;
  let clientGone = false;
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.on('close', () => { clientGone = true; });
    const pump = () => {
      while (!res.destroyed) {
        written += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
    };
    pump();
  });
  await new Promise((resolve: any) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const { createClient, roots }: any = fixture(t, { endpoint: `http://127.0.0.1:${server.address().port}`, lookup: loopbackLookup });
  const result = await createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'malformed-reply');
  assert.deepEqual(result.answers, []);
  assert.equal(records(roots).filter((entry: any) => entry.type === 'miss' && entry.reason === 'malformed-reply').length, 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(clientGone, 'the client closed the connection');
  // Backpressure keeps the server from writing far past what the client read: the cap plus socket buffers.
  assert.ok(written < 32 * 1024 * 1024, `server wrote ${written} bytes`);
});

test('IC-005 record:false answers without writing picks or misses', async (t) => {
  const server = await startFakeServer();
  onClose(t, server);
  const { createClient, roots }: any = fixture(t, { endpoint: server.origin, lookup: loopbackLookup });
  const result = await createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'bench', record: false });
  assert.equal(result.status, 'answered');
  assert.equal(result.answers[0].pickId, null);
  assert.equal(records(roots).length, 0);
});

test('IC-005 inspect reports reachability, version and capability fallback through /api/show', async (t) => {
  const server = await startFakeServer({ routes: {
    'GET /api/version': { status: 200, body: { version: '0.40.2' } },
    'GET /api/tags': { status: 200, body: { models: [{ name: 'clef-flash:latest' }] } },
    'POST /api/show': { status: 200, body: { capabilities: ['completion', 'decision'] } },
  } });
  onClose(t, server);
  const { createClient }: any = fixture(t, { endpoint: server.origin, lookup: loopbackLookup });
  const result = await createClient().inspect({ endpoint: server.origin, model: 'clef-flash', provider: 'ollama' });
  assert.equal(result.endpoint.state, 'reached');
  assert.equal(result.endpoint.version, '0.40.2');
  assert.equal(result.endpoint.versionOk, true);
  assert.deepEqual(result.model, { installed: true, decisionCapable: true });
  assert.ok(server.requests.some((request: any) => request.pathname === '/api/show'));
  const tooOld = await createClient().inspect({ endpoint: server.origin, model: 'clef-flash', provider: 'ollama', minVersion: '0.50.0' });
  assert.equal(tooOld.endpoint.versionOk, false);
});

test('IC-005 inspect reports unreachable and refused without rejecting', async (t) => {
  const { createClient }: any = fixture(t, { lookup: (_host: any, _options: any, callback: any) => callback(null, [{ address: '198.51.100.1', family: 4 }]) });
  const unreachable = await createClient().inspect({ endpoint: 'http://127.0.0.1:9', model: 'clef-flash', provider: 'ollama' });
  assert.equal(unreachable.endpoint.state, 'unreachable');
  const refused = await createClient().inspect({ endpoint: 'http://model.example:11434', model: 'clef-flash', provider: 'ollama' });
  assert.equal(refused.endpoint.state, 'refused');
});

test('IC-005 request uses the pinned lookup and no proxy agent', async (t): Promise<any> => {
  const server = await startFakeServer();
  onClose(t, server);
  const options: any = [];
  const httpModule = Object.create(http);
  httpModule.request = (requestOptions: any, callback: any) => {
    options.push(requestOptions);
    return http.request(requestOptions, callback);
  };
  const endpoint = server.origin.replace('127.0.0.1', 'localhost');
  const { createClient }: any = fixture(t, { endpoint, lookup: loopbackLookup });
  const result = await createClient({ httpModule }).ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise', record: false });
  assert.equal(result.status, 'answered');
  assert.equal(options[0].agent, false);
  assert.equal(typeof options[0].lookup, 'function');
  const pinned = await new Promise((resolve, reject): any => options[0].lookup('localhost', {}, (error: any, address: any, family: any) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(pinned, { address: '127.0.0.1', family: 4 });
});

test('fake decision server child writes a port file and binds only loopback', async (t) => {
  const dir = tempDir(t, 'doflow-fake-server-');
  const server = await spawnFakeServer({ dir });
  t.after(() => server.close());
  const response = await fetch(`${server.origin}/api/version`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: '0.40.2' });
});

test('084 C-3: a model override is the model asked, recorded and reported; unset keeps the setting model', async (t) => {
  const server = await startFakeServer({ routes: { 'POST /v1/systemone': { status: 200, body: { answers: {
    tier: { choice: 'standard', probabilities: { light: 0.1, standard: 0.8, frontier: 0.1 }, confidence: 0.7 },
  } } } } });
  onClose(t, server);
  const { createClient, roots }: any = fixture(t, { endpoint: server.origin });
  const overridden = await createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise', model: 'per-kind:1b' });
  assert.equal(overridden.status, 'answered');
  assert.equal(overridden.model, 'per-kind:1b');
  assert.equal(server.requests[0].body.model, 'per-kind:1b');
  const plain = await createClient().ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise' });
  assert.equal(plain.model, 'clef-flash');
  assert.equal(server.requests[1].body.model, 'clef-flash');
  assert.deepEqual(records(roots).map((record: any) => record.model), ['per-kind:1b', 'clef-flash']);
});

test('084 C-3: a model override never turns an off setting on', async (t) => {
  let requests = 0;
  const counting = { request() { requests += 1; throw new Error('unexpected request'); } };
  const { createClient, roots }: any = fixture(t, { setting: false, lookup: loopbackLookup });
  const result = await createClient({ httpModule: counting, httpsModule: counting })
    .ask({ questionSet: CHOICE_SET, kind: 'tier', caller: 'advise', model: 'per-kind:1b' });
  assert.equal(result.status, 'off');
  assert.equal(requests, 0, 'no transport request is made');
  assert.equal(records(roots).length, 0);
});

// 141 B.11: a `criteriaFrom: "call"` kind takes 1 to maxCandidates questions named `<kind>` or `<kind>-<a to p>`.
const LADDER = ['Unrelated.', 'Same topic only.', 'Answers part of it.', 'Answers it, needs detail.', 'Answers it fully.'];
const LETTERS = 'abcdefghijklmnop';
const CALL_KIND: any = {
  id: 'rerank', type: 'choice', instructions: 'Select the candidate that best answers the query.',
  criteriaFrom: 'call', staticFrom: 'the first-stage top candidate', askedBy: ['retrieve'], maxMode: 'shadow', budgetMs: 5000,
  params: { arm: 'choice', minCandidates: 2, maxCandidates: 16, candidateBytes: 800, queryBytes: 2048, criteriaBytes: 1536 },
};

function callRegistry(): any {
  const registry = structuredClone(BASE_ADVICE);
  registry.kinds = [...registry.kinds.filter((kind: any) => kind.id !== 'rerank'), structuredClone(CALL_KIND)];
  return registry;
}

function ladderQuestions(names: string[]): any[] {
  return names.map((name) => ({ name, type: 'score', instructions: `Rate candidate ${name}.`, criteria: LADDER }));
}

function ladderNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `rerank-${LETTERS[index]}`);
}

function scoreAnswer(level: number): any {
  const probabilities: any = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  probabilities[level] = 0.75;
  probabilities[Math.min(4, level + 1)] += 0.25;
  const score = Object.entries(probabilities).reduce((total: number, [key, value]: any) => total + Number(key) * value, 0);
  return { type: 'score', score, legend: Object.fromEntries(LADDER.map((text, index) => [index, text])), probabilities, confidence: 0.8 };
}

function ladderReply(names: string[]): any {
  return Object.fromEntries(names.map((name, index) => [name, scoreAnswer(index % 4)]));
}

async function askCall(t: any, names: string[], { kind = 'rerank', answerNames = names, registry = callRegistry(), state = 'query: q' }: any = {}) {
  const server = await startFakeServer({ routes: { 'POST /v1/systemone': { status: 200, body: { answers: ladderReply(answerNames) } } } });
  onClose(t, server);
  const { createClient, roots }: any = fixture(t, { endpoint: server.origin, adviceOverrides: { kinds: registry.kinds } });
  const result = await createClient().ask({ questionSet: { state, questions: ladderQuestions(names) }, kind, caller: 'retrieve', record: false });
  return { result, server, roots };
}

for (const count of [1, 2, 16]) {
  test(`141 B.11: a criteriaFrom call kind accepts ${count} lettered question(s) and returns every answer`, async (t) => {
    const names = count === 1 ? ['rerank'] : ladderNames(count);
    const { result, server } = await askCall(t, names);
    assert.equal(result.status, 'answered');
    assert.deepEqual(result.answers.map((answer: any) => answer.name), names);
    assert.equal(server.requests.length, 1);
    result.answers.forEach((answer: any, index: number) => {
      assert.equal(answer.kind, 'rerank');
      assert.equal(answer.type, 'score');
      assert.equal(answer.staticAnswer, null);
      assert.equal(answer.agrees, null);
      assert.deepEqual(answer.probabilities, scoreAnswer(index % 4).probabilities);
      assert.equal(answer.confidence, 0.8);
      assert.equal(answer.score, scoreAnswer(index % 4).score);
    });
  });
}

test('141 B.11: the base question and the lettered names may be mixed within the limit', async (t) => {
  const { result } = await askCall(t, ['rerank', 'rerank-b']);
  assert.equal(result.status, 'answered');
  assert.equal(result.answers.length, 2);
});

test('141 B.11: 17 questions are rejected before any request', async (t) => {
  const names = [...ladderNames(16), 'rerank-q'];
  const { result, server } = await askCall(t, names);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'config-invalid');
  assert.deepEqual(result.answers, []);
  assert.equal(server.requests.length, 0);
});

for (const [label, names] of [
  ['a wrong name', ['rerank-a', 'other-b']],
  ['a name outside a to p', ['rerank-a', 'rerank-q']],
  ['an uppercase label', ['rerank-a', 'rerank-B']],
  ['a two-letter suffix', ['rerank-a', 'rerank-ab']],
  ['a missing dash', ['rerank-a', 'reranka']],
  ['a single question with a wrong name', ['tier']],
  ['a duplicate name', ['rerank-a', 'rerank-a']],
  ['a duplicate base name', ['rerank', 'rerank']],
] as any[]) {
  test(`141 B.11: ${label} is rejected before any request`, async (t) => {
    const { result, server } = await askCall(t, names);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'config-invalid');
    assert.equal(server.requests.length, 0);
  });
}

test('141 B.11: a non-call kind with two questions is rejected as today', async (t) => {
  const server = await startFakeServer();
  onClose(t, server);
  const registry = callRegistry();
  const { createClient }: any = fixture(t, { endpoint: server.origin, adviceOverrides: { kinds: registry.kinds } });
  const two = { state: 'Choose.', questions: [CHOICE_SET.questions[0], { ...CHOICE_SET.questions[0], name: 'tier-b' }] };
  const result = await createClient().ask({ questionSet: two, kind: 'tier', caller: 'advise', record: false });
  assert.equal(result.reason, 'config-invalid');
  assert.match(result.detail, /does not match kind 'tier'/);
  const lettered = await createClient().ask({ questionSet: { state: 'Choose.', questions: [{ ...CHOICE_SET.questions[0], name: 'tier-a' }] }, kind: 'tier', caller: 'advise', record: false });
  assert.equal(lettered.reason, 'config-invalid');
  assert.equal(server.requests.length, 0);
});

test('141 B.11: an unregistered kind with a lettered name is rejected', async (t) => {
  const { result, server } = await askCall(t, ['nokind-a'], { kind: 'nokind' });
  assert.equal(result.reason, 'config-invalid');
  assert.equal(server.requests.length, 0);
});

test('141 B.11: an answer missing one question is a malformed reply and a miss', async (t) => {
  const names = ladderNames(4);
  const server = await startFakeServer({ routes: { 'POST /v1/systemone': { status: 200, body: { answers: ladderReply(names.slice(0, 3)) } } } });
  onClose(t, server);
  const { createClient, roots }: any = fixture(t, { endpoint: server.origin, adviceOverrides: { kinds: callRegistry().kinds } });
  const result = await createClient().ask({ questionSet: { state: 'query: q', questions: ladderQuestions(names) }, kind: 'rerank', caller: 'retrieve' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'malformed-reply');
  assert.deepEqual(result.answers, []);
  assert.equal(records(roots).filter((record: any) => record.type === 'pick').length, 0);
  const misses = records(roots).filter((record: any) => record.type === 'miss');
  assert.equal(misses.length, 1);
  assert.equal(misses[0].kind, 'rerank');
});

test('141 B.11: a 16-question request stays within limits.maxBodyBytes', async (t) => {
  const state = ['query: ' + 'q'.repeat(2048), ...LETTERS.split('').flatMap((letter) => [
    `candidate_ref[${letter.toUpperCase()}]: ${'r'.repeat(256)}`, `candidate_text[${letter.toUpperCase()}]: ${'t'.repeat(800)}`,
  ])].join('\n');
  const { result, server } = await askCall(t, ladderNames(16), { state });
  assert.equal(result.status, 'answered');
  const bytes = Buffer.byteLength(JSON.stringify(server.requests[0].body), 'utf8');
  assert.ok(bytes <= BASE_ADVICE.limits.maxBodyBytes, `${bytes} bytes`);
  assert.equal(Object.keys(server.requests[0].body.questions).length, 16);
});

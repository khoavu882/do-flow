'use strict';

// 141 B.5 / D.3 (IC-010), through the real CLI: `doflow retrieve` (guidance and code scope) and `doflow claim --action
// link` with a shadow kind, against a local fake Ollama. The unit tests inject the advice client; these runs do not, so
// they prove the hooks resolve the same setting, roots and client as the other call sites. Each case compares the
// command's stdout and exit status with a run whose kind is off, and counts what reached the fake server.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { createSettingsEnv } = require('../helper/settings-fixtures.ts');

const BIN = path.resolve(__dirname, '../../bin/doflow.js');
const NO_RG = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'ripgrep (rg) is not installed';
const BUDGET_MS = 5000;
const SLACK_MS = 3000;
const SENTINEL_QUERY = 'sentinelquery4471';
const SENTINEL_CANDIDATE = 'sentinelcandidate9023';
const SENTINEL_CLAIM = 'sentinelclaim5521';
const SENTINEL_PASSAGE = 'sentinelpassage8830';
const TASK = 'task_001';

/** One valid /v1/systemone answer per question, of whatever type the request carries. */
function systemOneReply(body: any): any {
  const answers: Record<string, any> = {};
  for (const [name, question] of Object.entries<any>(body.questions || {})) {
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria);
      const favourite = labels[labels.length - 1];
      answers[name] = {
        choice: favourite, confidence: 0.7,
        probabilities: Object.fromEntries(labels.map((label) => [label, label === favourite ? 0.7 : 0.3 / (labels.length - 1)])),
      };
    } else if (question.type === 'score') {
      const last = question.criteria.length - 1;
      const probabilities: Record<string, number> = {};
      question.criteria.forEach((_: any, index: number) => { probabilities[String(index)] = index === Math.min(2, last) ? 0.6 : 0.4 / last; });
      const score = question.criteria.reduce((total: number, _: any, index: number) => total + index * probabilities[String(index)], 0);
      answers[name] = {
        type: 'score', score, confidence: 0.6, probabilities,
        legend: Object.fromEntries(question.criteria.map((text: string, index: number) => [String(index), text])),
      };
    } else {
      answers[name] = { noul: 0.8 };
    }
  }
  return { answers };
}

/** A fake Ollama on 127.0.0.1. `mode`: answer, hang (accepts, never replies) or down (the port is closed again). */
async function fakeOllama(t: any, mode: 'answer' | 'hang' | 'down') {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const sockets = new Set<any>();
  const server = http.createServer((req: any, res: any) => {
    let body = '';
    req.on('data', (chunk: any) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      if (mode === 'hang') return;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/systemone') {
        try { res.end(JSON.stringify(systemOneReply(JSON.parse(body)))); } catch { res.statusCode = 400; res.end('{"error":"bad"}'); }
      } else if (req.url === '/api/version') res.end('{"version":"0.12.0"}');
      else if (req.url === '/api/tags') res.end('{"models":[{"name":"m:latest","capabilities":["completion"]}]}');
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  server.on('connection', (socket: any) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const close = () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
  if (mode === 'down') await close();
  t.after(close);
  return { requests, endpoint: `http://127.0.0.1:${port}` };
}

/** Runs the real CLI; resolves with the output, the status and when the first output and the exit happened. */
function runCli(args: string[], { cwd, env }: any): Promise<any> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let firstOutAt: number | null = null;
    child.stdout.on('data', (chunk: any) => { if (firstOutAt === null) firstOutAt = Date.now() - startedAt; stdout += chunk; });
    child.stderr.on('data', (chunk: any) => { stderr += chunk; });
    child.on('close', (status: any) => resolve({ status, stdout, stderr, firstOutAt, endedAt: Date.now() - startedAt }));
  });
}

/** Every file under `dir` whose path runs through an `advice` folder, as { path: text }. */
function adviceFiles(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.split(path.sep).includes('advice')) found[full] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return found;
}

const records = (files: Record<string, string>) => Object.values(files).join('\n').split('\n').filter(Boolean).map((line) => JSON.parse(line));

type Kind = 'rerank' | 'claim-support';
type World = ReturnType<typeof createSettingsEnv>;

/** A scratch HOME/XDG/project with the user settings file written as docs/reference.md (Settings keys) says. */
function world(t: any, { kind, kindValue, endpoint }: { kind: Kind; kindValue?: string; endpoint: string }) {
  const f: World = createSettingsEnv(t, { prefix: 'doflow-advice-hooks-' });
  const settings: Record<string, unknown> = {
    schema: 1, 'advice.enabled': true, 'advice.endpoint': endpoint, 'advice.model': 'm',
  };
  if (kindValue !== undefined) settings[`advice.kinds.${kind}`] = kindValue;
  f.writeUserSettings(settings);
  const configDir = path.join(f.dir, 'doflow-config');
  const guidance = path.join(configDir, 'guidance');
  fs.mkdirSync(guidance, { recursive: true });
  const padding = 'filler words '.repeat(30);
  ['one', 'two', 'three', 'four', 'five'].forEach((name, index) => {
    fs.writeFileSync(path.join(guidance, `${name}.md`), `calibration procedure ${name} ${'widget '.repeat(index + 1)}${padding}${SENTINEL_CANDIDATE} ${name}\n`);
  });
  fs.mkdirSync(path.join(f.project, 'src'), { recursive: true });
  for (let i = 1; i <= 4; i += 1) {
    fs.writeFileSync(path.join(f.project, 'src', `mod${i}.js`), `function parseToken${i}(value) {\n  // parseToken refresh credentials ${SENTINEL_CANDIDATE} ${i}\n  return value;\n}\n`);
  }
  const env = f.env({ DOFLOW_CONFIG_DIR: configDir });
  const run = (args: string[]) => runCli(args, { cwd: f.project, env });
  return { f, env, run, advice: () => adviceFiles(f.dir) };
}

/** The `claim add` + `evidence add` setup of a claim-link run, returning the ids the link needs. */
async function claimSetup(w: ReturnType<typeof world>) {
  const added = await w.run(['claim', '--task-id', TASK, '--action', 'add', '--statement', `The cache TTL is 300 seconds ${SENTINEL_CLAIM}`, '--json']);
  assert.equal(added.status, 0, added.stderr + added.stdout);
  const evidence = await w.run(['evidence', '--task-id', TASK, '--action', 'add', '--kind', 'exact-search', '--provenance', 'asserted', '--provider', 'native.rg', '--capability', 'code.exact-search', '--content', `the cache TTL is 300 seconds ${SENTINEL_PASSAGE}`, '--json']);
  assert.equal(evidence.status, 0, evidence.stderr + evidence.stdout);
  const claimId = JSON.parse(added.stdout).claim.id;
  const evidenceId = JSON.parse(evidence.stdout).evidence[0].id;
  assert.ok(claimId && evidenceId, `ids from ${added.stdout} / ${evidence.stdout}`);
  return { claimId, evidenceId };
}

/** The command under test for each hook, with the ids/timestamps a run writes anew blanked from its output. */
const SURFACES: Array<{ name: string; kind: Kind; skip?: any; prepare?: (w: any) => Promise<any>; args: (ctx: any) => string[] }> = [
  { name: 'guidance retrieve', kind: 'rerank', args: () => ['retrieve', '--query', `calibration procedure widget ${SENTINEL_QUERY}`] },
  { name: 'code retrieve', kind: 'rerank', skip: NO_RG, args: (ctx) => ['retrieve', '--scope', 'code', '--root', ctx.projectRoot, '--query', 'parseToken'] },
  {
    name: 'claim link', kind: 'claim-support', prepare: claimSetup,
    args: (ctx) => ['claim', '--task-id', TASK, '--action', 'link', '--claim-id', ctx.claimId, '--evidence-id', ctx.evidenceId, '--relation', 'supports'],
  },
];

const normalise = (text: string) => text
  .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>')
  .replace(/ra-[0-9a-f-]{36}/g, 'ra-<id>')
  .replace(/\b(claim|ev)_[0-9a-z_]+/g, '$1_<id>');

/** Sets a world up, optionally prepares it, runs the surface once, and reports what the server and the store saw. */
async function scenario(t: any, surface: (typeof SURFACES)[number], { kindValue, server }: { kindValue?: string; server: 'answer' | 'hang' | 'down' }) {
  const fake = await fakeOllama(t, server);
  const w = world(t, { kind: surface.kind, kindValue, endpoint: fake.endpoint });
  const ctx: any = { projectRoot: w.f.project, ...(surface.prepare ? await surface.prepare(w) : {}) };
  const before = fake.requests.length;
  const out = await w.run(surface.args(ctx));
  return { ...out, stdout: normalise(out.stdout), requests: fake.requests.slice(before), files: w.advice(), lines: records(w.advice()) };
}

for (const surface of SURFACES) {
  describe(`real CLI: ${surface.name}`, { skip: surface.skip }, () => {
    const SENTINELS = [SENTINEL_QUERY, SENTINEL_CANDIDATE, SENTINEL_CLAIM, SENTINEL_PASSAGE];

    test('(a) shadow: one request, one pick line without any text, output and status as with the kind off', async (t) => {
      const off = await scenario(t, surface, { kindValue: 'off', server: 'answer' });
      const on = await scenario(t, surface, { kindValue: 'shadow', server: 'answer' });
      assert.equal(off.status, 0, off.stderr);
      assert.equal(on.status, off.status);
      assert.equal(on.stdout, off.stdout);
      assert.equal(on.stderr, off.stderr);
      assert.equal(on.requests.length, 1, JSON.stringify(on.requests.map((r: any) => r.url)));
      assert.equal(on.requests[0].url, '/v1/systemone');
      assert.equal(on.lines.length, 1, JSON.stringify(on.lines));
      assert.equal(on.lines[0].kind, surface.kind);
      assert.equal(on.lines[0].mode, 'shadow');
      const stored = Object.values(on.files).join('');
      for (const sentinel of SENTINELS) assert.ok(!stored.includes(sentinel), `${sentinel} must not be stored`);
      assert.equal(JSON.stringify(on.lines[0]).includes('miss'), false, 'an answered call is a pick line, not a miss');
    });

    for (const [label, kindValue] of [['(b) kind off', 'off'], ['(b) kind unset', undefined]] as Array<[string, string | undefined]>) {
      test(`${label}: no request and no advice file`, async (t) => {
        const run = await scenario(t, surface, { kindValue, server: 'answer' });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.requests.length, 0);
        assert.deepEqual(Object.keys(run.files), []);
      });
    }

    test('(c) a server that hangs: the output comes first and the process ends within the budget plus slack', async (t) => {
      const off = await scenario(t, surface, { kindValue: 'off', server: 'answer' });
      const hung = await scenario(t, surface, { kindValue: 'shadow', server: 'hang' });
      assert.equal(hung.status, off.status);
      assert.equal(hung.stdout, off.stdout);
      assert.equal(hung.requests.length, 1);
      assert.ok(hung.firstOutAt !== null && hung.firstOutAt < hung.endedAt - BUDGET_MS / 2, `first output at ${hung.firstOutAt} ms, ended at ${hung.endedAt} ms`);
      assert.ok(hung.endedAt < BUDGET_MS + SLACK_MS, `the process took ${hung.endedAt} ms`);
      const stored = Object.values(hung.files).join('');
      for (const sentinel of SENTINELS) assert.ok(!stored.includes(sentinel), `${sentinel} must not be stored`);
      assert.deepEqual(hung.lines.map((line: any) => [line.kind, line.reason]), [[surface.kind, 'timeout']]);
    });

    test('(d) a server that is down: one miss line and the same output', async (t) => {
      const off = await scenario(t, surface, { kindValue: 'off', server: 'answer' });
      const down = await scenario(t, surface, { kindValue: 'shadow', server: 'down' });
      assert.equal(down.status, off.status);
      assert.equal(down.stdout, off.stdout);
      assert.equal(down.lines.length, 1, JSON.stringify(down.lines));
      assert.equal(down.lines[0].kind, surface.kind);
      assert.equal(typeof down.lines[0].reason, 'string');
      assert.equal(down.lines[0].reason !== null, true);
    });

    test('(e) act configured: held at shadow, one request, output unchanged', async (t) => {
      const off = await scenario(t, surface, { kindValue: 'off', server: 'answer' });
      const act = await scenario(t, surface, { kindValue: 'act', server: 'answer' });
      assert.equal(act.status, off.status);
      assert.equal(act.stdout, off.stdout);
      assert.equal(act.stderr, off.stderr);
      assert.equal(act.requests.length, 1);
      assert.equal(act.lines.length, 1, JSON.stringify(act.lines));
      assert.equal(act.lines[0].mode, 'shadow', 'a kind with maxMode shadow is recorded as shadow');
    });
  });
}

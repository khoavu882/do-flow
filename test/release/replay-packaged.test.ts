'use strict';

// Row 175 T10: `doflow advise --action replay` works in the published package, where every source is `.js`. The package is
// built the way the release gate builds it (buildPackage), every replay module of the checkout must have its packed form,
// and the PACKED CLI replays the fixture claim ledger against a fake decision server on an ephemeral port, with HOME and
// XDG_CONFIG_HOME in a temp dir, so no real model and no real ~/.doflow is reached. The replay must print its figures and
// write nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildPackage } = require('../../src/release/build-package.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { createScratch, childEnv } = require('../helper/scratch-env.ts');
const { startFakeServer, answering } = require('../helper/fake-decision-server.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { getSource } = require('../../src/runtime/advice/replay/sources/index.ts');

const REPLAY_DIR = path.join('src', 'runtime', 'advice', 'replay');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'advice-replay', 'claim-ledger', 'evidence');
const KIND = 'claim-support';

function tsFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(file);
    return file.endsWith('.ts') && !file.endsWith('.d.ts') ? [file] : [];
  });
}

function runPacked(packed: string, { cwd, env }: any) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(packed, 'bin', 'doflow.js'), 'advise', '--action', 'replay', '--kind', KIND, '--json'], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: any) => { stdout += chunk; });
    child.stderr.on('data', (chunk: any) => { stderr += chunk; });
    child.stdin.end();
    child.on('close', (status: number) => resolve({ status, stdout, stderr }));
  });
}

/** A scratch project with the fixture ledger, the decision model on at user level and a fake server, plus the packed package. */
async function packedReplay(t: any) {
  const scratch = createScratch('doflow-replay-packaged-');
  const server: any = await startFakeServer({ routes: { 'POST /v1/systemone': answering(() => 0.9) } });
  t.after(async () => { await server.close(); scratch.remove(); });
  const packed = buildPackage(path.join(scratch.dir, 'package'));
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(path.join(project, '.doflow', 'state'), { recursive: true });
  fs.cpSync(FIXTURE, path.join(project, '.doflow', 'state', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(scratch.xdg, 'doflow', 'settings.json'), JSON.stringify({
    schema: 1, 'storage.prune': 'off', 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash',
  }));
  return {
    scratch, server, packed, project,
    run: () => runPacked(packed, { cwd: project, env: childEnv(scratch, { CI: null, DOFLOW_SESSION_ROLE: null, DOFLOW_AUTOPILOT_ENABLED: null }) }),
    asks: () => server.requests.filter((request: any) => request.pathname === '/v1/systemone').length,
  };
}

test('the packed tree holds every replay module, and the packed CLI replays the fixture ledger against a fake model', async (t) => {
  const p = await packedReplay(t);
  for (const file of tsFilesUnder(path.join(REPO_ROOT, REPLAY_DIR))) {
    const packedFile = path.join(p.packed, path.relative(REPO_ROOT, file)).replace(/\.ts$/, '.js');
    assert.ok(fs.existsSync(packedFile), `the packed tree holds ${path.relative(p.packed, packedFile)}`);
  }
  assert.ok(fs.existsSync(path.join(p.packed, REPLAY_DIR, 'run.js')));

  // What the checkout's own source builds from that ledger: the packed replay must reach the same cases.
  const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: p.project, env: { HOME: p.scratch.home } });
  const kind = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry.kinds.find((entry: any) => entry.id === KIND);
  const expected = getSource(kind.replay.source).build({ projectRoot: p.project, roots, kind }).cases.length;
  assert.ok(expected > 0, 'the fixture builds cases');

  const result = await p.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.kind, KIND);
  assert.equal(printed.model, 'clef-flash');
  assert.equal(printed.metrics.n, expected, 'the packed replay scored every fixture case');
  assert.equal(printed.caseSet.eligible, expected);
  assert.equal(typeof printed.standing, 'string');
  for (const figure of ['accuracy', 'kappa', 'noAnswer', 'latencyMs']) assert.ok(figure in printed.metrics, `the figure ${figure} is printed`);
  assert.equal(printed.written, false, 'nothing is stored without --write');
  assert.equal(fs.existsSync(path.join(p.scratch.home, '.doflow', 'state', 'advice', 'results.json')), false);
  assert.equal(p.asks(), expected, 'one decision call per case, to the fake server only');
});

test('control: with run.js missing from the packed tree the packed replay prints no figures and asks no model', async (t) => {
  const p = await packedReplay(t);
  fs.rmSync(path.join(p.packed, REPLAY_DIR, 'run.js'));
  const result = await p.run();
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.stdout.includes('"metrics"'), false);
  assert.equal(p.asks(), 0);
});

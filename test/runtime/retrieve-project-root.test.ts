'use strict';

// 141 review F3: the `retrieve` advice hook records into the project root, not the directory the command ran in.
// Real CLI processes against a fake decision server; the rerank kind is on in shadow mode through the project's settings.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createSettingsEnv, userDecision, CLI } = require('../helper/settings-fixtures.ts');
const { startFakeServer } = require('../helper/fake-decision-server.ts');

const NO_RG = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'ripgrep (rg) is not installed';

/** Every file under `dir` (recursive), or []. */
function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

const adviceFiles = (root: string) => files(path.join(root, '.doflow', 'state', 'advice'));

function run(args: string[], { cwd, env }: any): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d: any) => { stdout += d; });
    child.stderr.on('data', (d: any) => { stderr += d; });
    child.on('close', (status: any) => resolve({ status, stdout, stderr }));
  });
}

async function fixture(t: any) {
  const f = createSettingsEnv(t, { prefix: 'doflow-retrieve-root-' });
  const server = await startFakeServer();
  t.after(() => server.close());
  f.writeUserDecision(userDecision({ endpoint: server.origin }));
  f.writeProjectSettings({ advice: { kinds: { rerank: 'shadow' } } });
  const git = spawnSync('git', ['init', '-q'], { cwd: f.project, env: f.env() });
  assert.equal(git.status, 0);
  const configDir = path.join(f.dir, 'doflow-config');
  fs.mkdirSync(path.join(configDir, 'guidance'), { recursive: true });
  ['one', 'two', 'three', 'four', 'five'].forEach((name, index) => {
    fs.writeFileSync(path.join(configDir, 'guidance', `${name}.md`), `calibration procedure ${name} ${'widget '.repeat(index + 1)}\n`);
  });
  const sub = path.join(f.project, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(f.project, 'src', `mod${i}.ts`), `export const widget${i} = 'calibration widget ${i}';\n`);
  return { f, sub, env: f.env({ DOFLOW_CONFIG_DIR: configDir }) };
}

async function waitForRecords(root: string) {
  const until = Date.now() + 4000;
  while (Date.now() < until && adviceFiles(root).length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
}

test('141 F3: guidance retrieve from a subdirectory records under the project root and prints the same output', async (t) => {
  const { f, sub, env } = await fixture(t);
  const args = ['retrieve', '--query', 'calibration widget', '--top', '3'];
  await run(args, { cwd: f.project, env }); // builds the index, so both compared runs print without the refresh note
  await waitForRecords(f.project);
  for (const file of adviceFiles(f.project)) fs.rmSync(file);
  const fromRoot = await run(args, { cwd: f.project, env });
  await waitForRecords(f.project);
  for (const file of adviceFiles(f.project)) fs.rmSync(file);
  const fromSub = await run(args, { cwd: sub, env });
  assert.equal(fromRoot.status, 0);
  assert.equal(fromSub.status, 0);
  assert.equal(fromSub.stdout, fromRoot.stdout);
  assert.equal(fromSub.stderr, fromRoot.stderr);
  assert.ok(adviceFiles(f.project).length > 0, 'the project root holds the advice record');
  assert.deepEqual(adviceFiles(sub), [], 'the working directory holds none');
  assert.equal(fs.existsSync(path.join(sub, '.doflow')), false);
});

test('141 F3: code retrieve with --root records under that root, not the working directory', { skip: NO_RG }, async (t) => {
  const { f, env } = await fixture(t);
  const elsewhere = path.join(f.dir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const result = await run(['retrieve', '--scope', 'code', '--root', f.project, '--query', 'calibration widget'], { cwd: elsewhere, env });
  assert.equal(result.status, 0, result.stderr);
  await waitForRecords(f.project);
  assert.ok(adviceFiles(f.project).length > 0, 'the --root project holds the advice record');
  assert.deepEqual(adviceFiles(elsewhere), []);
  assert.equal(fs.existsSync(path.join(elsewhere, '.doflow')), false);
});

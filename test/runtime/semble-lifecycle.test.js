'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { runSembleQuery, semanticStatePaths } = require('../../src/runtime/knowledge/semble-provider.ts');
const { runSembleLifecycle } = require('../../src/runtime/knowledge/semble-lifecycle.ts');
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'semble-lifecycle-')));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const modelPath = path.join(base, 'model'); fs.mkdirSync(modelPath);
  for (const file of ['config.json', 'tokenizer.json', 'model.safetensors']) fs.writeFileSync(path.join(modelPath, file), '{}');
  fs.writeFileSync(path.join(root, 'a.py'), 'answer = 42\n'); fs.writeFileSync(path.join(root, 'z.py'), 'result = 42\n');
  const pkg = path.join(base, 'python'); execFileSync('python3', [path.join(__dirname, 'fixtures/semble-provider-fake.py'), pkg]);
  const prior = process.env.PYTHONPATH; process.env.PYTHONPATH = pkg;
  t.after(() => { if (prior === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = prior; delete process.env.FAKE_PROVIDER_MODE; fs.rmSync(base, { recursive: true, force: true }); });
  const inventory = () => admitCodeCorpus({ root, files: fs.readdirSync(root).filter(file => file.endsWith('.py')) });
  return { base, root, modelPath, inventory, options: () => ({ inventory: inventory(), modelPath, python: 'python3' }) };
}

test('explicit refresh preserves stable mirror and unchanged mtimes; hash changes/add/delete counted', async t => {
  const f = fixture(t); const initial = f.options(); const built = await runSembleLifecycle({ ...initial, action: 'build' });
  assert.equal(built.ok, true, JSON.stringify(built));
  const paths = semanticStatePaths(initial.inventory); const oldMtime = fs.statSync(path.join(paths.mirror, 'a.py')).mtimeMs;
  const zMtime = fs.statSync(path.join(paths.mirror, 'z.py')).mtimeMs;
  fs.writeFileSync(path.join(f.root, 'a.py'), 'answer = 99\n'); fs.writeFileSync(path.join(f.root, 'new.py'), 'new = True\n');
  const updated = await runSembleLifecycle({ ...f.options(), action: 'refresh' });
  assert.equal(updated.ok, true, JSON.stringify(updated)); assert.equal(updated.changed, 1); assert.equal(updated.added, 1);
  assert.equal(fs.statSync(path.join(paths.mirror, 'z.py')).mtimeMs, zMtime);
  assert.ok(fs.statSync(path.join(paths.mirror, 'a.py')).mtimeMs > oldMtime);
  assert.notEqual(updated.generation, built.generation);
  fs.unlinkSync(path.join(f.root, 'new.py'));
  const deleted = await runSembleLifecycle({ ...f.options(), action: 'refresh' });
  assert.equal(deleted.ok, true, JSON.stringify(deleted)); assert.equal(deleted.deleted, 1);
  assert.equal(fs.existsSync(path.join(paths.mirror, 'new.py')), false);
  assert.equal((await runSembleQuery({ ...f.options(), query: 'answer' })).ok, true);
});

test('refresh without compatible complete state refuses implicit rebuild before mirror writes', async t => {
  const f = fixture(t); const options = f.options();
  const missing = await runSembleLifecycle({ ...options, action: 'refresh' });
  assert.equal(missing.ok, false); assert.equal(missing.reason, 'index-missing-or-corrupt');
  const paths = semanticStatePaths(options.inventory); assert.equal(fs.existsSync(paths.mirror), false);
  await runSembleLifecycle({ ...options, action: 'build' });
  fs.writeFileSync(path.join(f.modelPath, 'config.json'), 'changed');
  assert.equal((await runSembleLifecycle({ ...options, action: 'refresh' })).reason, 'index-identity-mismatch');
  assert.equal(fs.existsSync(paths.marker), false);
});

test('provider save failure keeps invalidation marker and repair build restores complete generation', async t => {
  const f = fixture(t); const options = f.options(); await runSembleLifecycle({ ...options, action: 'build' });
  const paths = semanticStatePaths(options.inventory);
  fs.writeFileSync(path.join(f.root, 'a.py'), 'answer = 88\n'); process.env.FAKE_PROVIDER_MODE = 'fail-save';
  const failed = await runSembleLifecycle({ ...f.options(), action: 'refresh' });
  assert.equal(failed.ok, false); assert.equal(failed.complete, false); assert.equal(fs.existsSync(paths.marker), true);
  assert.equal((await runSembleQuery({ ...f.options(), query: 'answer' })).reason, 'index-in-progress');
  assert.equal(fs.readdirSync(paths.state).some(n => n.startsWith('staging-')), false);
  delete process.env.FAKE_PROVIDER_MODE;
  assert.equal((await runSembleLifecycle({ ...f.options(), action: 'build' })).ok, true);
  assert.equal(fs.existsSync(paths.marker), false);
});

test('whole corpus and refresh change caps reject before marker or mirror mutation', async t => {
  const f = fixture(t); const options = f.options(); await runSembleLifecycle({ ...options, action: 'build' });
  const paths = semanticStatePaths(options.inventory);
  fs.writeFileSync(path.join(f.root, 'a.py'), 'answer = 77\n');
  const limited = await runSembleLifecycle({ ...f.options(), action: 'refresh', limits: { changedFiles: 0 } });
  assert.equal(limited.reason, 'refresh-limit'); assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.readFileSync(path.join(paths.mirror, 'a.py'), 'utf8'), 'answer = 42\n');
  const incomplete = { ...f.inventory(), complete: false };
  assert.equal((await runSembleLifecycle({ inventory: incomplete, modelPath: f.modelPath, action: 'build' })).reason, 'incomplete-corpus');
});

test('symlink artifact and oversized chunk pool rejected before loader; abandoned query sink cleaned', async t => {
  const f = fixture(t); const options = f.options(); await runSembleLifecycle({ ...options, action: 'build' });
  const paths = semanticStatePaths(options.inventory); const abandoned = path.join(paths.state, 'query-abandoned'); fs.mkdirSync(abandoned); fs.writeFileSync(path.join(abandoned, 'savings.jsonl'), '{}');
  assert.equal((await runSembleQuery({ ...options, query: 'answer', limits: { chunks: 1 } })).reason, 'invalid-chunk-pool');
  assert.equal(fs.existsSync(abandoned), false);
  const args = path.join(paths.index, 'semantic_index/arguments.json'); fs.unlinkSync(args); fs.symlinkSync(path.join(f.modelPath, 'config.json'), args);
  assert.equal((await runSembleQuery({ ...options, query: 'answer' })).reason, 'unsafe-artifact');
});

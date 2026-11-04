'use strict';
// remove-leftovers.e2e.test.ts — `doflow remove` leaves nothing of what DoFlow created, keeps what it
// did not, and a project that holds the leftover of an older release installs again.
// Before the fix pi, opencode and copilot left a 0-byte instruction file (opencode also `{}` in
// opencode.json) plus empty tool folders, and the next install refused the 0-byte file with
// "exists without a DoFlow managed section"; `status` still listed the removed harness as installed.
// Every case runs the real bin/doflow.js against a git project in a scratch HOME.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { createScratch } = require('../helper/scratch-env.ts');
const { MARKER_START, MARKER_END } = require('../../src/helper/marker-merge.ts');

const CASE_TIMEOUT_MS = 240_000;
const SCRATCHES: any[] = [];
after(() => { for (const scratch of SCRATCHES) scratch.remove(); });

// Per harness: the shared instruction file it marker-merges into, the tool folders its removal empties.
const HARNESSES: Record<string, { instruction: string; toolDirs: string[]; config?: string }> = {
  pi: { instruction: 'AGENTS.md', toolDirs: ['.pi'] },
  opencode: { instruction: 'AGENTS.md', toolDirs: ['.opencode'], config: 'opencode.json' },
  copilot: { instruction: '.github/copilot-instructions.md', toolDirs: ['.github', '.agents'] },
};

function run(scratch: any, args: string[], cwd: string) {
  const env = scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' });
  return spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

function ok(result: any, label: string) {
  assert.strictEqual(result.status, 0, `${label} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
}

function project() {
  const scratch = createScratch('doflow-remove-leftovers-');
  SCRATCHES.push(scratch);
  const dir = path.join(scratch.dir, 'proj');
  fs.mkdirSync(dir);
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, env: scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' }), encoding: 'utf8' });
  assert.strictEqual(git.status, 0, git.stderr);
  return { scratch, dir };
}

const install = (scratch: any, dir: string, harness: string) => run(scratch, ['install', dir, '-t', harness, '-f', '--mcp', 'none'], scratch.dir);
const remove = (scratch: any, dir: string, harness: string) => run(scratch, ['remove', dir, '-t', harness, '-f'], scratch.dir);
const listed = (scratch: any, dir: string) => JSON.parse(run(scratch, ['status', dir, '--json'], scratch.dir).stdout).manifest.tools;

for (const [harness, shape] of Object.entries(HARNESSES)) {
  test(`${harness}: install -> remove leaves nothing DoFlow created, and installs again`, { timeout: CASE_TIMEOUT_MS }, () => {
    const { scratch, dir } = project();
    ok(install(scratch, dir, harness), 'install');
    assert.ok(fs.existsSync(path.join(dir, shape.instruction)), 'the install wrote the instruction file');
    assert.strictEqual(listed(scratch, dir)[harness]?.installed, true);

    ok(remove(scratch, dir, harness), 'remove');
    assert.ok(!fs.existsSync(path.join(dir, shape.instruction)), `${shape.instruction} is gone`);
    if (shape.config) assert.ok(!fs.existsSync(path.join(dir, shape.config)), `${shape.config} is gone`);
    for (const toolDir of shape.toolDirs) assert.ok(!fs.existsSync(path.join(dir, toolDir)), `${toolDir} is gone`);
    assert.strictEqual(listed(scratch, dir)[harness], undefined, 'the manifest stops listing the removed harness');

    ok(install(scratch, dir, harness), 'reinstall');
    assert.match(fs.readFileSync(path.join(dir, shape.instruction), 'utf8'), /doflow:start/);
  });

  test(`${harness}: user content beside DoFlow's section survives remove byte for byte`, { timeout: CASE_TIMEOUT_MS }, () => {
    const { scratch, dir } = project();
    const file = path.join(dir, shape.instruction);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The adapters refuse a shared file with no DoFlow section; an empty marker pair is the opt-in.
    fs.writeFileSync(file, `# My rules\n${MARKER_START}\n${MARKER_END}\nkeep this\n`);
    const userConfig = '{"theme":"dark"}\n';
    if (shape.config) fs.writeFileSync(path.join(dir, shape.config), userConfig);

    ok(install(scratch, dir, harness), 'install');
    ok(remove(scratch, dir, harness), 'remove');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# My rules\nkeep this\n');
    if (shape.config) assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, shape.config), 'utf8')), { theme: 'dark' });
  });

  for (const [label, leftover] of [['0-byte', ''], ['whitespace-only', '\n  \n']] as const) {
    test(`${harness}: a ${label} ${shape.instruction} left by an older release counts as absent`, { timeout: CASE_TIMEOUT_MS }, () => {
      const { scratch, dir } = project();
      const file = path.join(dir, shape.instruction);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, leftover);
      if (shape.config) fs.writeFileSync(path.join(dir, shape.config), '{}\n');

      const result = install(scratch, dir, harness);
      ok(result, 'install over the leftover');
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /without a DoFlow managed section/);
      assert.match(fs.readFileSync(file, 'utf8'), /doflow:start/);
      ok(remove(scratch, dir, harness), 'remove');
      // The leftover predates the install, so it is not a file DoFlow created and stays.
      assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), '');
    });
  }
}

test('a harness that stays installed stays in the manifest when another is removed', { timeout: CASE_TIMEOUT_MS }, () => {
  const { scratch, dir } = project();
  ok(run(scratch, ['install', dir, '-t', 'pi,copilot', '-f', '--mcp', 'none'], scratch.dir), 'install');
  ok(remove(scratch, dir, 'pi'), 'remove pi');
  const tools = listed(scratch, dir);
  assert.strictEqual(tools.pi, undefined);
  assert.strictEqual(tools.copilot?.installed, true);
});

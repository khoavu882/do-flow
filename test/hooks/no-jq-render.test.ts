'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { tempDir } = require('../helper/tmp.ts');

const root = path.resolve(__dirname, '../..');
const bridge = path.join(root, 'core/harnesses/shared/hooks/bridge/bridge.sh');
const respond = path.join(root, 'core/harnesses/shared/hooks/bridge/respond.sh');
const policyDir = path.join(root, 'core/harnesses/shared/hooks/policies');

function noJqPath(t: any) {
  const dir = tempDir(t, 'doflow-no-jq-');
  for (const name of ['bash', 'cat', 'dirname', 'git', 'mktemp', 'node', 'sed', 'sort', 'tr']) {
    for (const base of ['/bin', '/usr/bin']) {
      const source = path.join(base, name);
      if (fs.existsSync(source)) {
        try { fs.symlinkSync(source, path.join(dir, name)); } catch (error: any) {
          if (error.code !== 'EEXIST') throw error;
        }
        break;
      }
    }
  }
  return dir;
}

function runBash(script: any, args: any, { env = {}, input = '', pathDir }: any = {}) {
  return spawnSync('/bin/bash', ['-c', script, 'test', ...args], {
    encoding: 'utf8', input,
    env: { ...process.env, ...env, ...(pathDir ? { PATH: pathDir } : {}) },
  });
}

function installDoor(harness: any, filename: any, t: any) {
  const dir = tempDir(t, `doflow-${harness}-door-`);
  const harnessRoot = path.join(dir, `.${harness}`);
  const hooks = path.join(harnessRoot, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.cpSync(path.join(root, 'core/harnesses/shared/hooks'), path.join(dir, '.doflow/shared/hooks'), { recursive: true });
  fs.copyFileSync(path.join(root, `core/harnesses/${harness}/hooks/${filename}`), path.join(hooks, filename));
  fs.chmodSync(path.join(hooks, filename), 0o755);
  if (harness === 'kiro') fs.copyFileSync(path.join(root, 'core/harnesses/kiro/hooks/lib.sh'), path.join(hooks, 'lib.sh'));
  return { dir, door: path.join(hooks, filename) };
}

test('pure Bash JSON escaping covers quotes, slashes and control bytes', (t) => {
  const pathDir = noJqPath(t);
  const result = runBash('. "$1"; doflow_json_escape "$2"', [path.join(policyDir, 'deny-json.sh'), 'a\\b"c\n\r\t\u0001z'], { pathDir });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'a\\\\b\\"c\\n\\r\\tz');
  assert.equal(result.stderr, '');
});

test('jq-free bridge renderer covers Antigravity Stop and Kiro V3', async (t) => {
  const reason = 'quoted "reason" with \\ slash\nand newline';
  const cases: any = [
    ['antigravity', 'Stop', {}, (json: any) => json.decision === 'continue'],
    ['kiro', 'Stop', { DOFLOW_KIRO_ENGINE: 'v3' }, (json: any) => json.decision === 'block'],
  ];
    for (const [harness, event, env, shape] of cases) {
      await t.test(`${harness} ${event}`, (t: any) => {
        const pathDir = noJqPath(t);
        const result = runBash('source "$1"; doflow_render_response "$2" "$3" deny "$4" 2', [respond, harness, event, reason], { pathDir, env });
        assert.equal(result.status, 0, result.stderr);
        const json = JSON.parse(result.stdout);
        assert.ok(shape(json));
        assert.equal(json.reason, reason);
      });
    }
});

test('jq-free strict-1 gate doors and bridge emit native denies; compat-1 stays silent', async (t) => {
  const pathDir = noJqPath(t);
  const reason = '[pre-implementation-gate] DoFlow policy error; details: doflow-run failure list';
    const shapes: any = [
      ['claude', 'PreToolUse', 'pre-implement-gate.sh', (json: any) => json.hookSpecificOutput.permissionDecision === 'deny' && json.hookSpecificOutput.permissionDecisionReason === reason],
      ['codex', 'PreToolUse', 'pre-implement-gate.sh', (json: any) => json.hookSpecificOutput.permissionDecision === 'deny' && json.hookSpecificOutput.permissionDecisionReason === reason],
      ['gemini', 'BeforeTool', 'pre-implement-gate.sh', (json: any) => json.decision === 'deny' && json.reason === reason],
      ['pi', 'tool_call', null, (json: any) => json.block === true && json.reason === reason],
      ['antigravity', 'PreToolUse', null, (json: any) => json.decision === 'deny' && json.reason === reason],
      ['kiro', 'PreToolUse', 'pre-implement-gate.sh', (result: any) => result.status === 2 && result.stderr.includes(reason)],
    ];
    for (const [harness, event, door, check] of shapes) {
      await t.test(`${harness} ${event} strict-1`, (t: any) => {
        let result;
        if (door) {
          const install = installDoor(harness, door, t);
          result = runBash('exec "$1"', [install.door], {
            pathDir, input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/a.js' }, cwd: root }),
            env: { DOFLOW_FAULT_PROFILE: 'strict-1', HOME: pathDir },
          });
        } else {
          result = runBash('source "$1"; doflow_render_response "$2" "$3" deny "$4" 2', [respond, harness, event, reason], { pathDir });
        }
        assert.equal(result.error, undefined);
        if (harness !== 'kiro') assert.equal(result.status, 0, result.stderr);
        if (harness === 'kiro') assert.equal(result.status, 2, result.stderr);
        if (harness === 'kiro') assert.ok(result.stderr.includes(reason));
        else assert.ok(check(JSON.parse(result.stdout)), result.stdout);
      });
    }

    for (const harness of ['claude', 'codex', 'gemini', 'pi', 'antigravity', 'kiro']) {
      await t.test(`${harness} bridge strict-1 and compat-1`, () => {
        for (const profile of ['strict-1', 'compat-1']) {
          const result = runBash('source "$1"; doflow_bridge "$2" "$3" pre-implementation-gate', [bridge, harness, harness === 'gemini' ? 'BeforeTool' : harness === 'pi' ? 'tool_call' : 'PreToolUse'], {
            pathDir, env: { DOFLOW_FAULT_PROFILE: profile, DOFLOW_PROJECT_DIR: root },
            input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/a.js' }, cwd: root }),
          });
          assert.equal(result.error, undefined);
          if (profile === 'compat-1') {
            assert.equal(result.status, 0);
            if (harness === 'antigravity') assert.equal(result.stdout, '{"decision":"allow"}\n');
            else assert.equal(result.stdout, '');
          } else if (harness === 'kiro') {
            assert.equal(result.status, 2);
            assert.ok(result.stderr.includes('DoFlow policy error'));
          } else {
            assert.equal(result.status, 0);
            assert.ok(JSON.parse(result.stdout));
          }
        }
      });
    }
});

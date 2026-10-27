'use strict';

/**
 * Tool versions, environment comparison and the pinned-commit export (074 IC-002 steps 3 and 4,
 * IC-003 step 2). Tool absence is data (`state: "absent"`), never an exception.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { corporaOf } = require('./snapshot.ts');

/** The tools whose versions the snapshot pins, in IC-011 order of use. */
const TOOL_SPECS = [
  { id: 'git', versionCommand: ['git', '--version'] },
  { id: 'rg', versionCommand: ['rg', '--version'] },
  { id: 'fd', versionCommand: ['fd', '--version'] },
  { id: 'semble', versionCommand: ['semble', '--version'] },
  { id: 'graphify', versionCommand: ['graphify', '--version'] },
  { id: 'rtk', versionCommand: ['rtk', '--version'] },
  { id: 'jq', versionCommand: ['jq', '--version'] },
];

function firstLine(text: any) {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim();
}

function getChildEnv(extra?: any) {
  try {
    const { childEnv } = require('../runner.ts');
    if (typeof childEnv === 'function') return childEnv(extra);
  } catch {}
  const CREDENTIAL_RE = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|DOFLOW_HOLDOUT_KEY)/i;
  const env: any = {};
  for (const name of Object.keys(process.env)) if (!CREDENTIAL_RE.test(name)) env[name] = process.env[name];
  if (extra) {
    for (const [name, val] of Object.entries(extra)) if (!CREDENTIAL_RE.test(name)) env[name] = val;
  }
  return env;
}

/** `{id, versionCommand, versionLine, state}` for one tool; a binary that cannot start is absent. */
function captureTool(spec: any, { cwd, env }: any = {}) {
  const [bin, ...args] = spec.versionCommand;
  const childEnvironment = getChildEnv(env);
  const run = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000, cwd, env: childEnvironment });
  if (run.error || run.status === null) {
    return { id: spec.id, versionCommand: spec.versionCommand, versionLine: null, state: 'absent' };
  }
  const line = firstLine(run.stdout) || firstLine(run.stderr);
  return { id: spec.id, versionCommand: spec.versionCommand, versionLine: line, state: 'present' };
}

function captureTools(specs = TOOL_SPECS, options = {}) {
  return specs.map((spec) => captureTool(spec, options));
}

/**
 * Compares the pinned tool list with what is installed now. Returns one row per pinned tool:
 * `{id, expected, actual, state, ok}` where `expected` and `actual` are version lines ("absent" for none).
 */
function compareTools(pinned: any, options = {}) {
  return pinned.map((tool: any) => {
    const now = captureTool({ id: tool.id, versionCommand: tool.versionCommand }, options);
    return {
      id: tool.id,
      expected: tool.versionLine === null ? 'absent' : tool.versionLine,
      actual: now.versionLine === null ? 'absent' : now.versionLine,
      state: now.state,
      ok: now.state === tool.state && now.versionLine === tool.versionLine,
    };
  });
}

/** `{node, os, arch, differs}`: what runs now, and which of the snapshot's three strings differ. Never a failure. */
function compareEnv(snapshot: any, current: any = { node: process.version, os: process.platform, arch: process.arch }) {
  const differs = ['node', 'os', 'arch'].filter((key) => snapshot[key] !== current[key]);
  return { ...current, differs };
}

function pruneTree(root: any, snapshot: any) {
  const walk = (dir: any) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (corporaOf(rel, snapshot).length === 0) fs.rmSync(full, { force: true });
      }
    }
  };
  walk(root);
}

/**
 * Extracts `<commit>` into `<tmpDir>/tree` through `git archive | tar -x`, then deletes every path
 * outside the corpus scopes or inside an exclusion. The working tree is never read. Returns
 * `{treeRoot, codeRoot, guidanceRoot, cleanup}`; `cleanup` removes `tmpDir` unless `keep` is set.
 */
function materialiseExport(commit: any, tmpDir: any, snapshot: any, { repoRoot, keep = false }: any = {}) {
  const treeRoot = path.join(tmpDir, 'tree');
  fs.mkdirSync(treeRoot, { recursive: true });
  const archive = spawnSync('git', ['-C', repoRoot, 'archive', commit], { env: getChildEnv(), maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) {
    throw new Error(`git archive ${commit} failed: ${String(archive.stderr).trim() || archive.error}`);
  }
  const extract = spawnSync('tar', ['-x', '-C', treeRoot], { input: archive.stdout, env: getChildEnv(), maxBuffer: 1024 * 1024 });
  if (extract.status !== 0) throw new Error(`tar extract failed: ${String(extract.stderr).trim() || extract.error}`);
  pruneTree(treeRoot, snapshot);
  return {
    treeRoot,
    codeRoot: treeRoot,
    guidanceRoot: path.join(treeRoot, 'core', 'shared', 'guidance'),
    cleanup() { if (!keep) fs.rmSync(tmpDir, { recursive: true, force: true }); },
  };
}

/** Default export directory: `os.tmpdir()/doflow-retrieval-<pid>`. */
function defaultTmpDir() {
  return path.join(os.tmpdir(), `doflow-retrieval-${process.pid}`);
}

module.exports = {
  TOOL_SPECS, captureTool, captureTools, compareTools, compareEnv, materialiseExport, defaultTmpDir,
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const TEMPLATE_PATHS = [
  'core/harnesses/claude/settings/settings.json',
  'core/harnesses/codex/hooks/hooks.json',
  'core/harnesses/gemini/hooks/hooks.json',
  'core/harnesses/kiro/hooks/doflow.json',
  'core/harnesses/kiro/agents/doflow.json',
];

function trackedFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

function isShipped(file) {
  return /^(?:core\/harnesses\/[^/]+\/hooks\/|core\/harnesses\/shared\/hooks\/|core\/harnesses\/pi\/extensions\/)/.test(file);
}

function read(root, file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function addTemplateRoots(root, files, reachable, errors) {
  const candidates = files.filter(isShipped);
  const addDoor = (harness, name, template) => {
    const matches = candidates.filter((file) => file.startsWith(`core/harnesses/${harness}/hooks/`) && path.basename(file) === name);
    if (matches.length !== 1) errors.push(`${template} command resolves to ${matches.length} shipped ${harness} doors: ${name}`);
    else reachable.add(matches[0]);
  };
  for (const template of TEMPLATE_PATHS) {
    if (!fs.existsSync(path.join(root, template))) { errors.push(`missing hook wiring template ${template}`); continue; }
    const text = read(root, template);
    if (isShipped(template)) reachable.add(template);
    const harness = template.includes('/claude/') ? 'claude' : template.includes('/codex/') ? 'codex' : template.includes('/gemini/') ? 'gemini' : 'kiro';
    for (const match of text.matchAll(/[A-Za-z0-9_-]+\.sh\b/g)) addDoor(harness, match[0], template);
  }
  const registryPath = 'core/registry/harnesses.json';
  const registry = JSON.parse(read(root, registryPath));
  const antigravity = registry.harnesses.find((item) => item.id === 'antigravity');
  for (const key of ['hookScript', 'stopHookScript']) {
    const segments = antigravity?.paths?.[key]?.project?.segments;
    const name = Array.isArray(segments) ? segments.at(-1) : null;
    if (name) addDoor('antigravity', name, `${registryPath}:${key}`);
    else errors.push(`${registryPath} has no Antigravity ${key} source`);
  }
  const pi = 'core/harnesses/pi/extensions/doflow-guard.js';
  if (files.includes(pi)) reachable.add(pi);
  else errors.push(`missing Pi hook extension ${pi}`);
}

function dependencyTargets(root, file, files, text) {
  const shipped = new Set(files.filter(isShipped));
  const targets = new Set();
  const add = (candidate) => { if (shipped.has(candidate)) targets.add(candidate); };
  const addPath = (value) => {
    const clean = value.replace(/["'`)]*$/g, '').replace(/^['"`(]*/, '');
    if (!clean || clean.startsWith('$') || clean.includes('{')) return;
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
    add(relative);
    add(path.posix.normalize(clean));
    if (!path.posix.extname(clean)) { add(`${relative}.js`); add(`${relative}.ts`); }
  };
  for (const match of text.matchAll(/require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) addPath(match[1]);
  for (const match of text.matchAll(/dirname\s+["']?\$0["']?\)?\)\/?([^\s"'`]+)/g)) addPath(match[1]);
  for (const match of text.matchAll(/\$\{0%\/\*\}\/([A-Za-z0-9_.-]+\.(?:sh|jq|js|conf))/g)) {
    addPath(match[1]);
  }
  for (const match of text.matchAll(/\$_DOFLOW_POLDIR\/([A-Za-z0-9_.-]+\.(?:sh|jq|js|conf))/g)) {
    addPath(match[1]);
  }
  for (const match of text.matchAll(/\$_DOFLOW_(BRIDGE|RESPOND)_DIR\/([A-Za-z0-9_.-]+\.(?:sh|jq|js|conf))/g)) {
    add(`core/harnesses/shared/hooks/bridge/${match[2]}`);
  }
  const shellDirs = new Map();
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)=\$\{0%\/\*\}/g)) {
    shellDirs.set(match[1], match[1].toLowerCase().includes('bridge') ? 'bridge' : 'policies');
  }
  for (const match of text.matchAll(/(?:^|[;\n])\s*(?:source|\.)\s+["']?([^\s"']+)/gm)) {
    const value = match[1];
    if (value.includes('$')) {
      const basename = path.posix.basename(value);
      const lower = value.toLowerCase();
      const dir = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\//);
      const prefix = lower.includes('polic') ? 'core/harnesses/shared/hooks/policies/' : lower.includes('bridge') ? 'core/harnesses/shared/hooks/bridge/' : dir && shellDirs.has(dir[1]) ? `core/harnesses/shared/hooks/${shellDirs.get(dir[1])}/` : null;
      if (prefix) add(prefix + basename);
      else if (value.includes('here') || value.includes('dirname')) add(path.posix.join(path.posix.dirname(file), basename));
    } else addPath(value);
  }
  for (const match of text.matchAll(/jq\s+[^\n]*?\s-f\s+["']?([^\s"']+)/g)) {
    const value = match[1];
    if (value.toLowerCase().includes('policy')) add(`core/harnesses/shared/hooks/policies/${path.posix.basename(value)}`);
    else if (value.toLowerCase().includes('bridge')) add(`core/harnesses/shared/hooks/bridge/${path.posix.basename(value)}`);
    else addPath(value);
  }
  for (const match of text.matchAll(/(?:\.doflow\/shared\/hooks\/|\.\.\/\.\.\/\.\.\/shared\/hooks\/)([A-Za-z0-9_./-]+)/g)) add(`core/harnesses/shared/hooks/${match[1]}`);
  for (const ext of ['sh', 'js', 'jq']) {
    for (const match of text.matchAll(new RegExp(`(?:POLICY_DIR|BRIDGE_DIR|dirname[^\\n]{0,40})[^\\n]{0,100}([A-Za-z0-9_-]+\\.${ext})`, 'g'))) {
      const name = match[1];
      for (const base of ['core/harnesses/shared/hooks/policies/', 'core/harnesses/shared/hooks/bridge/', 'core/harnesses/shared/hooks/adapters/']) add(base + name);
    }
  }
  for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'stop-check', 'session-context', 'user-prompt-submit', 'subagent-audit']) {
    if (text.includes(policy)) add(`core/harnesses/shared/hooks/policies/${policy}.sh`);
  }
  return [...targets];
}

function hookReachabilityFindings(root = REPO, files = trackedFiles(root)) {
  const findings = [];
  const shipped = files.filter((file) => isShipped(file) && fs.existsSync(path.join(root, file)));
  const reachable = new Set();
  addTemplateRoots(root, shipped, reachable, findings);
  const pending = [...reachable];
  while (pending.length) {
    const file = pending.pop();
    if (!fs.existsSync(path.join(root, file))) { findings.push(`wiring names missing file ${file}`); continue; }
    const text = read(root, file);
    for (const target of dependencyTargets(root, file, shipped, text)) {
      if (!reachable.has(target)) { reachable.add(target); pending.push(target); }
    }
  }
  const docs = shipped.filter((file) => file.endsWith('.md'));
  const expected = new Set([...reachable, ...docs]);
  for (const file of shipped) if (!expected.has(file)) findings.push(`orphan shipped hook file ${file}`);
  for (const file of expected) if (!shipped.includes(file)) findings.push(`reachable hook file is not shipped ${file}`);

  const assets = JSON.parse(read(root, 'core/registry/assets.json')).assets;
  const sources = [...assets.map((asset) => asset.source), 'core/harnesses/codex/hooks', 'core/harnesses/gemini/hooks'];
  for (const file of shipped) if (!sources.some((source) => file === source || file.startsWith(`${source}/`))) findings.push(`${file} is outside registry asset sources`);
  const runnerPath = 'core/harnesses/shared/hooks/stream-hook-runner.js';
  if (fs.existsSync(path.join(root, runnerPath))) findings.push(...runnerHeaderFindings(read(root, runnerPath)));
  return findings;
}

function claudeDoorFindings(root = REPO, files = trackedFiles(root)) {
  const errors = [];
  const shipped = files.filter((file) => file.startsWith('core/harnesses/claude/hooks/'));
  const settingsPath = 'core/harnesses/claude/settings/settings.json';
  const settings = JSON.parse(read(root, settingsPath));
  const commands = JSON.stringify(settings.hooks || {});
  const wired = new Set();
  for (const name of commands.matchAll(/[A-Za-z0-9_-]+\.sh\b/g)) {
    const match = shipped.find((file) => path.basename(file) === name[0]);
    if (!match) errors.push(`claude wiring command resolves to missing door ${name[0]}`);
    else wired.add(match);
  }
  for (const file of shipped) {
    const name = path.basename(file);
    const sources = shipped.filter((candidate) => candidate !== file && new RegExp(`(?:source|\\.)\\s+[^\\n]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(read(root, candidate)));
    if (!wired.has(file) && sources.length === 0) errors.push(`claude door is not wired or sourced ${file}`);
  }
  return errors;
}

function runnerHeaderFindings(text) {
  return /Gemini.*(?:wired|harness|runner)|(?:wired|harness|runner).*Gemini/i.test(text)
    ? ['runner header names a harness other than Antigravity'] : [];
}

module.exports = { hookReachabilityFindings, claudeDoorFindings, runnerHeaderFindings, isShipped, dependencyTargets };

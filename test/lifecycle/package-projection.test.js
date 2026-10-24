'use strict';

// 122 C.3 (IC-017, IC-006 `projection`): the skills and agents of an active package are projected into the harnesses
// of a global install through the lifecycle, and unprojected when the package stops being active. One real
// `doflow install -g -t claude,kiro` into a scratch HOME; the package verbs run in process (the grants file of a
// scratch HOME lies under the system temp directory, so `tmpDir` is moved off it, as package-instruction.test.js does).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { stateRoot, readLedger } = require('../../src/state/index.ts');
const { handlePackageCommand } = require('../../src/runtime/packages/command.ts');

const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const NEXT_MAJOR = Number(VERSION.split('.')[0]) + 1;
const NO_TMP = '/nonexistent-doflow-tmp';
const SKILL = `---
name: acme-triage
description: Triage incoming reports for the acme team
---

# Triage

Sort the reports by severity.
`;
const AGENT = `---
name: acme-helper
description: "Helps the acme team read logs"
model: inherit
effort: high
access: read-only
---

# acme-helper

Reads logs and reports what it found.
`;

/** A package with one skill (`skills/acme-triage/`) and one agent alone in its directory (`agents/acme-helper.md`). */
function writePackage(dir) {
  fs.mkdirSync(path.join(dir, 'skills', 'acme-triage'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'acme-triage', 'SKILL.md'), SKILL);
  fs.writeFileSync(path.join(dir, 'agents', 'acme-helper.md'), AGENT);
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), `${JSON.stringify({
    manifest: 1, id: 'acme', version: '1.0.0', summary: 'acme triage skill and log agent',
    doflow: `>=${VERSION} <${NEXT_MAJOR}.0.0`,
    contributions: [
      { point: 'skill', version: 1, id: 'triage', dir: 'skills/acme-triage' },
      { point: 'agent', version: 1, id: 'helper', file: 'agents/acme-helper.md' },
    ],
  }, null, 2)}\n`);
  return dir;
}

/** A scratch HOME (optionally installed globally for `harnesses`), a package source, and an in-process verb runner. */
function world(t, harnesses = []) {
  const scratch = createScratch('doflow-package-projection-');
  t.after(() => scratch.remove());
  if (harnesses.length) {
    const install = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'doflow.js'), 'install', '-g', '-f', '--no-backup', '-t', harnesses.join(',')],
      { cwd: scratch.dir, env: scratch.env({ DOFLOW_CONFIG_DIR: '', DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '' }), encoding: 'utf8', input: '\n' });
    assert.equal(install.status, 0, install.stdout + install.stderr);
  }
  const project = path.join(scratch.dir, 'work');
  fs.mkdirSync(project);
  const env = { HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg, DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off' };
  const source = writePackage(path.join(scratch.dir, 'acme'));
  const grants = path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl');
  const pkg = (action, extra = {}) => {
    const lines = [];
    const saved = process.exitCode;
    try {
      const code = handlePackageCommand({ action, homeDir: scratch.home, env, projectRoot: project, tmpDir: NO_TMP, settingsView: {},
        writer: { write() {} }, repoRoot: REPO_ROOT, out: (line) => lines.push(line), ...extra });
      return { code, text: lines.join('\n') };
    } finally { process.exitCode = saved; }
  };
  /** Add the package (plan, then apply) and return the plan. */
  const add = () => {
    const planned = pkg('add', { source, json: true });
    assert.equal(planned.code, 0, planned.text);
    const { plan } = JSON.parse(planned.text);
    const applied = pkg('add', { plan: plan.planId });
    assert.equal(applied.code, 0, applied.text);
    return plan;
  };
  const trust = (plan) => {
    fs.mkdirSync(path.dirname(grants), { recursive: true });
    fs.appendFileSync(grants, `${plan.grantLines.trust}\n`);
  };
  const home = (...parts) => path.join(scratch.home, ...parts);
  const ledgerRows = () => (readLedger(stateRoot({ scope: 'global', homeDir: scratch.home }))?.resources ?? [])
    .filter((row) => String(row.assetId).startsWith('pkg.'));
  return { scratch, pkg, add, trust, home, ledgerRows, source };
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('trust plus enable projects the skill and the agent into claude and kiro; disable unprojects and keeps a person-edited copy', (t) => {
  const w = world(t, ['claude', 'kiro']);
  const plan = w.add();

  // IC-006: the plan shows, per globally installed harness, what is projected and the listing bytes it adds.
  assert.deepEqual(Object.keys(plan.projection).sort(), ['claude', 'kiro']);
  for (const harness of ['claude', 'kiro']) {
    assert.deepEqual(plan.projection[harness].skill, ['acme-triage'], harness);
    assert.deepEqual(plan.projection[harness].agent, ['acme-helper'], harness);
    assert.ok(plan.projection[harness].listingBytes > 0, harness);
  }

  const skillFiles = [w.home('.claude', 'skills', 'acme-triage', 'SKILL.md'), w.home('.kiro', 'skills', 'acme-triage', 'SKILL.md')];
  const agentFiles = [w.home('.claude', 'agents', 'acme-helper.md'), w.home('.kiro', 'agents', 'acme-helper.json')];

  // Not trusted yet: enable sets the bit and projects nothing.
  const untrusted = w.pkg('enable', { id: 'acme' });
  assert.equal(untrusted.code, 0, untrusted.text);
  assert.match(untrusted.text, /needs-trust/);
  for (const file of [...skillFiles, ...agentFiles]) assert.equal(fs.existsSync(file), false, file);

  // The person adds the trust line; the next write-capable verb (enable again) projects.
  w.trust(plan);
  const enabled = w.pkg('enable', { id: 'acme' });
  assert.equal(enabled.code, 0, enabled.text);
  assert.match(enabled.text, /active/);
  assert.match(enabled.text, /projected acme\.triage into claude, kiro/);
  for (const file of skillFiles) assert.equal(fs.readFileSync(file, 'utf8'), SKILL, file);
  assert.match(fs.readFileSync(agentFiles[0], 'utf8'), /^name: acme-helper$/m);
  assert.equal(JSON.parse(fs.readFileSync(agentFiles[1], 'utf8')).name, 'acme-helper');

  // G20: the package identity names harness, qualified id and the path inside the projection; no scope, no destination.
  const rows = w.ledgerRows();
  assert.deepEqual(rows.map((row) => `${row.harness} ${row.ownershipIdentity}`).sort(), [
    'claude doflow:claude:package:acme.helper:acme-helper.md',
    'claude doflow:claude:package:acme.triage:SKILL.md',
    'kiro doflow:kiro:package:acme.helper:acme-helper.json',
    'kiro doflow:kiro:package:acme.triage:SKILL.md',
  ]);
  for (const row of rows) {
    assert.ok(!row.ownershipIdentity.includes(w.scratch.home) && !/global|user|project/.test(row.ownershipIdentity), row.ownershipIdentity);
  }

  // A second run changes nothing.
  const again = w.pkg('verify');
  assert.equal(again.code, 0, again.text);
  assert.doesNotMatch(again.text, /projected|unprojected/);

  // A full global install runs the same lifecycle: the active package stays projected and owned. (Its own temp
  // directory and a working directory beside the config home, so the scratch grants file lies inside neither and counts.)
  const tmp = path.join(w.scratch.dir, 'tmp');
  fs.mkdirSync(tmp);
  const reinstall = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'doflow.js'), 'install', '-g', '-f', '--no-backup', '-t', 'claude,kiro'],
    { cwd: path.join(w.scratch.dir, 'work'), env: w.scratch.env({ TMPDIR: tmp, DOFLOW_CONFIG_DIR: '', DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '' }), encoding: 'utf8', input: '\n' });
  assert.equal(reinstall.status, 0, reinstall.stdout + reinstall.stderr);
  for (const file of [...skillFiles, ...agentFiles]) assert.equal(fs.existsSync(file), true, file);
  assert.equal(w.ledgerRows().length, 4, 'the install keeps the package rows');

  // The person edits claude's copy; disable removes every other projected file and keeps that one, and says so.
  fs.appendFileSync(skillFiles[0], '\nmy own note\n');
  const edited = sha256(skillFiles[0]);
  const disabled = w.pkg('disable', { id: 'acme' });
  assert.equal(disabled.code, 0, disabled.text);
  assert.match(disabled.text, /the grant is kept/);
  assert.match(disabled.text, /kept person-edited .*acme-triage[/\\]SKILL\.md/);
  assert.match(disabled.text, /unprojected acme\.helper from claude, kiro/);
  assert.equal(sha256(skillFiles[0]), edited, 'the person-edited copy is kept byte for byte');
  for (const file of [skillFiles[1], ...agentFiles]) assert.equal(fs.existsSync(file), false, file);
  assert.deepEqual(w.ledgerRows(), [], 'no package row is left: the kept file is the person\'s now');
});

test('a harness whose skills capability is unavailable is warned and gets no skill', (t) => {
  const w = world(t, ['claude', 'kiro']);
  const real = loadRegistry({ repoRoot: REPO_ROOT });
  const registry = { ...real, harnesses: real.harnesses.map((h) => (h.id === 'kiro'
    ? { ...h, capabilities: { ...h.capabilities, skills: { ...h.capabilities.skills, status: 'unavailable' } } } : h)) };
  const plan = w.add();
  w.trust(plan);

  const shown = w.pkg('show', { id: 'acme', registry });
  assert.equal(shown.code, 0, shown.text);
  assert.match(shown.text, /warning: kiro cannot take skill acme\.triage: its skills capability is unavailable/);

  const enabled = w.pkg('enable', { id: 'acme', registry });
  assert.equal(enabled.code, 0, enabled.text);
  assert.match(enabled.text, /warning: kiro cannot take skill acme\.triage/);
  assert.equal(fs.existsSync(w.home('.claude', 'skills', 'acme-triage', 'SKILL.md')), true);
  assert.equal(fs.existsSync(w.home('.kiro', 'skills', 'acme-triage', 'SKILL.md')), false);
  assert.equal(fs.existsSync(w.home('.kiro', 'agents', 'acme-helper.json')), true, 'the agent still reaches kiro');

  const listed = w.pkg('list', { registry });
  assert.match(listed.text, /warning: kiro cannot take skill acme\.triage/);
});

test('without a global install nothing is projected, and list and enable say so', (t) => {
  const w = world(t);
  const plan = w.add();
  assert.deepEqual(plan.projection, {});
  w.trust(plan);
  const enabled = w.pkg('enable', { id: 'acme' });
  assert.equal(enabled.code, 0, enabled.text);
  assert.match(enabled.text, /active/);
  assert.match(enabled.text, /no harness is installed at global scope/);
  const listed = w.pkg('list');
  assert.match(listed.text, /no harness is installed at global scope/);
  assert.equal(fs.existsSync(w.home('.claude')), false);
  assert.deepEqual(w.ledgerRows(), []);
});

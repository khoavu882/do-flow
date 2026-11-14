'use strict';

// doctor lists the external tools that are absent, required first, with the one command that
// installs each; it says one line when none is absent and never turns an absent tool into a finding.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { CapabilityRouter } = require('../../src/runtime/capability-router.ts');
const { buildHealthReport, handleDoctorCommand } = require('../../src/runtime/health.ts');

const stub = () => { const error: any = new Error('not found'); error.code = 'ENOENT'; throw error; };
const routerWith = (present: string[]) => new CapabilityRouter({ repoRoot: REPO_ROOT, binaryChecker: (binary: string) => present.includes(binary) });

async function doctorText(t: any, present: string[]) {
  const dir = tempDir(t, 'doflow-doctor-tools-');
  const lines: string[] = [];
  const log = console.log;
  const saved = process.exitCode;
  console.log = (...args: any[]) => { lines.push(args.join(' ')); };
  try {
    await handleDoctorCommand({ json: false, repoRoot: REPO_ROOT, projectRoot: dir, router: routerWith(present), execFileImpl: stub, homeDir: dir, env: { HOME: dir, XDG_CONFIG_HOME: dir, DOFLOW_TELEMETRY: 'off' } });
  } finally { console.log = log; process.exitCode = saved; }
  return lines.join('\n');
}
const section = (text: string) => text.split('\n[External Tools]\n')[1].split('\n\n')[0];

test('doctor report: an absent tool carries its role, what it unlocks and the install command for this machine', (t) => {
  const dir = tempDir(t, 'doflow-doctor-tools-');
  const report = buildHealthReport({ repoRoot: REPO_ROOT, projectRoot: dir, router: routerWith(['brew', 'npm']), execFileImpl: stub });
  const byId = (id: string) => report.externalTools.find((tool: any) => tool.id === id);
  assert.equal(byId('jq').role, 'required');
  assert.equal(byId('jq').status, 'ABSENT');
  assert.ok(byId('jq').unlocks.length > 0);
  assert.deepEqual(byId('rtk').install.command, ['brew', 'install', 'rtk-ai/tap/rtk']);
  // mermaid-cli is judged by its binary, mmdc, not by its id.
  assert.equal(routerWith(['mmdc']).isBinaryAvailable('mermaid-cli'), false);
  const withMmdc = buildHealthReport({ repoRoot: REPO_ROOT, projectRoot: dir, router: routerWith(['mmdc']), execFileImpl: stub });
  assert.notEqual(withMmdc.externalTools.find((tool: any) => tool.id === 'mermaid-cli').status, 'ABSENT');
  assert.equal(withMmdc.externalTools.find((tool: any) => tool.id === 'mermaid-cli').install, null);
  assert.equal(report.findings.some((finding: any) => /tool/.test(finding.kind)), false, 'an absent tool is information, not a finding');
});

test('doctor text: absent tools are listed required first with one command each', async (t) => {
  const text = await doctorText(t, ['brew', 'npm', 'git', 'bash']);
  const lines = section(text).split('\n');
  const rows = lines.filter((line) => !line.includes('doflow tools'));
  assert.match(rows[0], /^ {2}jq {13}required {2}(brew install jq|sudo apt-get install jq \(needs administrator rights\))$/);
  assert.ok(rows.findIndex((line) => line.includes(' required ')) < rows.findIndex((line) => line.includes(' optional ')));
  assert.ok(!rows.some((line) => /^ {2}(git|bash) /.test(line)), 'present tools are not listed');
  assert.match(text, /^ {2}agent-browser {2}optional {2}(npm install -g agent-browser, then agent-browser install|brew install agent-browser, then agent-browser install)$/m);
  assert.match(text, /^ {2}ripgrep {8}optional {2}brew install ripgrep$/m);
  assert.equal(lines.at(-1), '  Run `doflow tools` for what each one unlocks.');
});

test('doctor text: a tool with no route for this machine says so and names the page', async (t) => {
  const text = await doctorText(t, []);
  assert.match(section(text), /^ {2}bash {11}required {2}no verified install command is registered for (darwin|linux); see https:\/\/www\.gnu\.org\/software\/bash\/$/m);
  assert.match(section(text), /^ {2}plantuml {7}optional {2}missing installer: needs brew on PATH; see https:\/\/plantuml\.com\/starting$/m);
});

test('doctor text: one line when every tool is present', async (t) => {
  const everything = ['jq', 'git', 'bash', 'rtk', 'graphify', 'semble', 'mmdc', 'plantuml', 'rg', 'drawio', 'python3', 'agent-browser'];
  assert.equal(section(await doctorText(t, everything)), '  Every registered tool is on PATH.');
});

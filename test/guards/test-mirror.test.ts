'use strict';

// G90 — test/runtime mirrors src/runtime (row 167).
//   Files: a top-level test/runtime file whose name holds `.test.` (any extension) fails unless its name starts with
//   the stem of a top-level module src/runtime/<stem>.ts followed by `.test.` or `-`, or it is in SPANNING (a verb or
//   script test that reaches across folders or modules, one reason each). A test of src/runtime/<dir>/<m>.ts lives
//   in test/runtime/<dir>/. The message names the file. A SPANNING entry that is gone or names a module stem fails.
//   Control: a planted tree in a temp folder, with src/runtime folders and one top-level module, shows the shapes
//   that fail (a folder prefix, a folder name alone, a prefix with no module, another extension) and the ones that
//   pass (a module stem, a SPANNING name).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { tempDir } = require('../helper/tmp.ts');

/** Top-level test files that test no single module: each reaches several folders or modules, or a script. */
const SPANNING = new Map([
  ['ambiguous-feature-hint.test.ts', 'runs the do-prereqs.sh and do-paths.sh helper scripts'],
  ['bash-args.test.ts', 'runs the helper scripts that share do-args.sh'],
  ['closed-sets.test.ts', 'checks closed vocabularies of five modules across src/runtime and src/lifecycle'],
  ['concurrent-projects.test.ts', 'runs many verbs in several projects at once'],
  ['concurrent-verbs.test.ts', 'runs many verbs in several projects at once'],
  ['console-read-contract.test.ts', 'drives the CLI read verbs over storage/ and lifecycle/ records'],
  ['dispatcher-identity.test.ts', 'runs the doflow-run dispatcher script'],
  ['dispatcher-stale-checkout.test.ts', 'runs the doflow-run dispatcher script'],
  ['feature-root.test.ts', 'drives the paths, render-audit and decision verbs'],
  ['local-capabilities.test.ts', 'spans capabilities/, capability-router.ts and health.ts'],
  ['manage-reads.test.ts', 'drives the advice-picks and worker-matrix verbs'],
  ['mcp-handoff.test.ts', 'drives handoff through workflow-orchestrator, workflow-engine and research-request'],
  ['orchestrate-run-read.test.ts', 'covers every run-file read: status, verify readiness and the checkout probe'],
  ['performance-budget.test.ts', 'times many verbs through bench/perf'],
  ['plan-fixtures.test.ts', 'pairs scaffold/artifacts.ts parsing with task-attempts.ts line hashes'],
  ['plan-parse.test.ts', 'spans scaffold/artifacts.ts, task-attempts.ts and task-graph.ts'],
  ['render-drawio.test.ts', 'runs the render-drawio.sh script'],
  ['render-feature-root.test.ts', 'runs the render-diagrams.sh and render-puml.sh scripts'],
  ['render-puml-stderr.test.ts', 'runs the render-puml.sh script'],
  ['retrieval-help.test.ts', 'reads the CLI help and the doflow-run usage'],
  ['retrieve-no-decision-call.test.ts', 'drives retrieve across knowledge/, advice/ and storage/'],
  ['slug-safety.test.ts', 'drives the feature resolver and the branch-name verb'],
  ['stage-pack-link.test.ts', 'spans workflow-orchestrator.ts, context/ and trace/'],
  ['started-session-join.test.ts', 'runs the SessionStart hook path across context/, fleet/ and checkouts.ts'],
  ['task-brief-tools.test.ts', 'runs the do-task-brief.sh script'],
]);

/** Each violation of G90 under `root`, as one message, sorted. */
function unmirroredTests(root: string, spanning: Map<string, string> = SPANNING): string[] {
  const testRuntime = path.join(root, 'test', 'runtime');
  const srcRuntime = path.join(root, 'src', 'runtime');
  const src = fs.readdirSync(srcRuntime, { withFileTypes: true });
  const stems = src.filter((entry: any) => entry.isFile() && entry.name.endsWith('.ts')).map((entry: any) => entry.name.slice(0, -3));
  const ofModule = (name: string) => stems.some((stem: string) => name.startsWith(`${stem}.test.`) || name.startsWith(`${stem}-`));
  const entries = fs.readdirSync(testRuntime, { withFileTypes: true });
  const files = entries
    .filter((entry: any) => entry.isFile() && entry.name.includes('.test.') && !ofModule(entry.name) && !spanning.has(entry.name))
    .map((entry: any) => `test/runtime/${entry.name} starts with no top-level src/runtime module stem`);
  const stale = [...spanning.keys()]
    .filter((name) => ofModule(name) || !entries.some((entry: any) => entry.isFile() && entry.name === name))
    .map((name) => `SPANNING entry ${name} is gone or names a top-level module`);
  return [...files, ...stale].sort();
}

test('G90: every top-level test/runtime test names a top-level module or is SPANNING', () => {
  assert.deepEqual(unmirroredTests(REPO_ROOT), []);
});

test('G90 control: folder-shaped, unknown and other-extension names fail; module stems and SPANNING pass', (t) => {
  const root = tempDir(t, 'doflow-g90-');
  for (const dir of ['packages', 'transcripts', 'verification', 'worker', 'roadmap']) {
    fs.mkdirSync(path.join(root, 'src', 'runtime', dir), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'test', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'runtime', 'worker-y.ts'), '');
  const failing = ['package-x.test.ts', 'transcript-x.test.ts', 'verify-x.test.ts', 'runtime-worker-x.test.ts',
    'worker.test.ts', 'roadmap.test.ts', 'worker-x.test.mjs'];
  for (const name of [...failing, 'worker-y.test.ts', 'worker-y-z.test.js', 'spans.test.ts', 'helper.ts']) {
    fs.writeFileSync(path.join(root, 'test', 'runtime', name), '');
  }
  assert.deepEqual(unmirroredTests(root, new Map([['spans.test.ts', 'planted']])), [
    ...failing.map((name) => `test/runtime/${name} starts with no top-level src/runtime module stem`),
  ].sort());
  assert.deepEqual(unmirroredTests(root, new Map([['gone.test.ts', 'planted'], ['worker-y.test.ts', 'planted']]))
    .filter((line) => line.startsWith('SPANNING')), [
    'SPANNING entry gone.test.ts is gone or names a top-level module',
    'SPANNING entry worker-y.test.ts is gone or names a top-level module',
  ]);
});

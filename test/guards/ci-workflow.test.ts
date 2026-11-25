'use strict';

// G93 — the cross-OS test workflow runs on `develop` pushes and typechecks at the repository root
// (row 181, IC-001, FR-014, FR-015). The runtime executes by type-stripping, so a type error fails no
// test; only the `typecheck` job fails the run. Each fact below is read from the committed workflow
// and compared; a finding names the fact.
//   G93.1  `on.push.branches` holds `main` and `develop`.
//   G93.2  a `typecheck` job exists on ubuntu-latest, has no `needs` (it runs beside the shards), and
//          declares no `continue-on-error` at job or step level.
//   G93.3  that job pins exactly one Node version and it equals the `engines.node` floor of package.json.
//   G93.4  that job runs `npm run typecheck`.
//   Controls: every fact is broken in turn on a temp copy of the workflow, which must fail naming it.
// The `shell-suites` hook-suite step is not read here; its own task owns that.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { tempDir } = require('../helper/tmp.ts');
const { parseWorkflow, workflowNodePins, yamlKeys } = require('../../src/release/release-workflow.ts');

const WORKFLOW = path.join(REPO, '.github', 'workflows', 'cross-os-tests.yml');
const floor: string = /(\d+\.\d+\.\d+)/.exec(
  JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).engines.node)?.[1] ?? '';

/** The branch names under `on.push.branches`, flow (`[a, b]`) or block (`- a`) form; null when absent. */
function pushBranches(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd());
  const start = lines.findIndex((line) => /^ {2}push:\s*$/.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && !/^ {3,}/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start + 1, end);
  const at = block.findIndex((line) => /^ {4}branches:/.test(line));
  if (at === -1) return null;
  const flow = /^ {4}branches:\s*\[([^\]]*)\]\s*$/.exec(block[at]);
  const items = flow ? flow[1].split(',') : [];
  if (!flow) {
    for (const line of block.slice(at + 1)) {
      const item = /^ {4,6}-\s*(.+)$/.exec(line);
      if (!item) break;
      items.push(item[1]);
    }
  }
  return items.map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** Findings for a workflow text, each naming the fact it breaks; [] when all four facts hold. */
function ciWorkflowFindings(text: string): string[] {
  const findings: string[] = [];
  const branches = pushBranches(text);
  for (const branch of ['main', 'develop']) {
    if (!branches?.includes(branch)) findings.push(`G93.1 on.push.branches must include ${branch}`);
  }
  const job = parseWorkflow(text).jobs.get('typecheck');
  if (!job) {
    findings.push('G93.2 the typecheck job is missing');
    return findings;
  }
  const keys = yamlKeys(job.text);
  const valueOf = (key: string, column: number) =>
    keys.filter((entry: any) => entry.key === key && entry.column === column).map((entry: any) => entry.value);
  if (!valueOf('runs-on', 4).includes('ubuntu-latest')) findings.push('G93.2 the typecheck job must run on ubuntu-latest');
  if (job.needs.length) findings.push(`G93.2 the typecheck job must have no needs (has ${job.needs.join(', ')})`);
  if (keys.some((entry: any) => entry.key === 'continue-on-error')) {
    findings.push('G93.2 the typecheck job must not declare continue-on-error');
  }
  const pins = workflowNodePins(job.text).map((pin: any) => pin.value);
  if (pins.length !== 1 || pins[0] !== floor) {
    findings.push(`G93.3 the typecheck job must pin Node ${floor} (the engines.node floor) exactly once, found ${pins.join(', ') || 'none'}`);
  }
  if (!keys.some((entry: any) => entry.key === 'run' && entry.value.trim() === 'npm run typecheck')) {
    findings.push('G93.4 the typecheck job must run `npm run typecheck`');
  }
  return findings;
}

const workflow = fs.readFileSync(WORKFLOW, 'utf8');

function replaceOnce(text: string, before: string, after: string): string {
  const index = text.indexOf(before);
  assert.notEqual(index, -1, `fault seed source must exist: ${before}`);
  return text.slice(0, index) + after + text.slice(index + before.length);
}

test('G93.1-4: the committed cross-os-tests.yml pushes on develop and typechecks at the root', () => {
  assert.ok(floor, 'package.json engines.node must carry a version floor');
  assert.deepEqual(ciWorkflowFindings(workflow), []);
});

test('G93 control: each fact broken on a temp copy of the workflow fails naming that fact', (t: any) => {
  const dir = tempDir(t);
  const typecheckLine = '        run: npm run typecheck\n';
  const faults: Array<{ name: string, fact: string, text: string }> = [
    { name: 'develop dropped from push', fact: 'G93.1 on.push.branches must include develop',
      text: replaceOnce(workflow, 'branches: [main, develop]', 'branches: [main]') },
    { name: 'main dropped from push', fact: 'G93.1 on.push.branches must include main',
      text: replaceOnce(workflow, 'branches: [main, develop]', 'branches: [develop]') },
    { name: 'typecheck job removed', fact: 'G93.2 the typecheck job is missing',
      text: replaceOnce(workflow, '  typecheck:\n', '  typecheck-renamed:\n') },
    { name: 'typecheck job on macos', fact: 'G93.2 the typecheck job must run on ubuntu-latest',
      text: replaceOnce(workflow, '  typecheck:\n    name: typecheck (ubuntu, node 24.22.1)\n    runs-on: ubuntu-latest',
        '  typecheck:\n    name: typecheck (ubuntu, node 24.22.1)\n    runs-on: macos-latest') },
    { name: 'typecheck job waits on the shards', fact: 'G93.2 the typecheck job must have no needs',
      text: replaceOnce(workflow, '  typecheck:\n    name: typecheck (ubuntu, node 24.22.1)\n',
        '  typecheck:\n    needs: [test]\n    name: typecheck (ubuntu, node 24.22.1)\n') },
    { name: 'typecheck step may fail', fact: 'G93.2 the typecheck job must not declare continue-on-error',
      text: replaceOnce(workflow, typecheckLine, '        continue-on-error: true\n' + typecheckLine) },
    { name: 'typecheck node off the floor', fact: `G93.3 the typecheck job must pin Node ${floor}`,
      text: replaceOnce(workflow, '  typecheck:\n    name: typecheck (ubuntu, node 24.22.1)\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v7\n\n      - name: Setup Node\n        uses: actions/setup-node@v7\n        with:\n          node-version: "24.22.1"',
        '  typecheck:\n    name: typecheck (ubuntu, node 24.22.1)\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v7\n\n      - name: Setup Node\n        uses: actions/setup-node@v7\n        with:\n          node-version: "24"') },
    { name: 'typecheck command replaced', fact: 'G93.4 the typecheck job must run `npm run typecheck`',
      text: replaceOnce(workflow, typecheckLine, '        run: npm test\n') },
  ];
  for (const fault of faults) {
    const copy = path.join(dir, 'cross-os-tests.yml');
    fs.writeFileSync(copy, fault.text);
    const findings = ciWorkflowFindings(fs.readFileSync(copy, 'utf8'));
    assert.ok(findings.some((finding) => finding.startsWith(fault.fact)),
      `${fault.name}: expected a finding starting "${fault.fact}", got ${JSON.stringify(findings)}`);
  }
});

'use strict';

// G51 — keep the release workflow inside the IC-004 rules and IC-005 job graph.
// The seeded copies are string mutations; the committed workflow stays untouched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { releaseWorkflowFindings } = require('../../src/release/release-workflow.ts');

const workflowPath = path.join(REPO, '.github', 'workflows', 'release.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

function replaceOnce(text, before, after) {
  const index = text.indexOf(before);
  assert.notEqual(index, -1, `fault seed source must exist: ${before}`);
  return text.slice(0, index) + after + text.slice(index + before.length);
}

test('G51: committed release workflow satisfies IC-004', () => {
  assert.deepEqual(releaseWorkflowFindings(workflow), []);
});

test('G51: each seeded workflow fault reports its IC-004 rule', () => {
  const faults = [
    ['R5', replaceOnce(
      workflow,
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      'actions/checkout@v7 # v7.0.1',
    )],
    ['R1', replaceOnce(
      workflow,
      'permissions: {}\n\njobs:',
      'permissions:\n  contents: write\n\njobs:',
    )],
    ['R3', replaceOnce(
      workflow,
      '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions: {}',
      '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write',
    )],
    ['R6', replaceOnce(
      workflow,
      '  preflight:\n    runs-on: ubuntu-latest',
      '  preflight:\n    needs: [test]\n    runs-on: ubuntu-latest',
    )],
    ['R7', replaceOnce(
      workflow,
      '  publish-release:\n    needs: [promote]',
      '  publish-release:\n    needs: []',
    )],
    ['R9', replaceOnce(
      workflow,
      'npm publish .pack --provenance --tag "${channel}-candidate"',
      'npm publish .pack --provenance --tag beta',
    )],
  ];

  for (const [rule, mutated] of faults) {
    assert.notEqual(mutated, workflow, `${rule} seed must change a copy of the workflow`);
    const findings = releaseWorkflowFindings(mutated);
    assert.ok(
      findings.some((finding) => finding.startsWith(`${rule} `)),
      `${rule} seed must be reported by ${rule}; got: ${findings.join('; ')}`,
    );
  }
});

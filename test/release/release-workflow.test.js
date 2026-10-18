'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseWorkflow, releaseWorkflowFindings } = require('../../src/release/release-workflow.ts');

const fixturePath = path.join(__dirname, '../fixtures/release/release-valid.yml');
const workflow = fs.readFileSync(fixturePath, 'utf8');

test('parseWorkflow reads top permissions, job fields, uses, text, and source line', () => {
  const parsed = parseWorkflow(workflow);
  assert.equal(parsed.topPermissions, '{}');
  assert.ok(parsed.jobs instanceof Map);
  assert.deepEqual(parsed.jobs.get('verify-artifact').needs, ['preflight', 'test']);
  assert.match(parsed.jobs.get('publish').permissions, /id-token: write/);
  assert.ok(parsed.jobs.get('publish').uses.length > 0);
  assert.match(parsed.jobs.get('publish').text, /npm publish/);
  assert.equal(parsed.jobs.get('preflight').line, 7);
});

test('the release fixture satisfies every workflow rule', () => {
  assert.deepEqual(releaseWorkflowFindings(workflow), []);
});

test('each R1-R12 fault mutation reports only its rule', () => {
  const mutations = [
    ['R1', workflow.replace('permissions: {}', 'permissions:\n  contents: read')],
    ['R2', workflow.replace(
      '  test:\n    uses: ./.github/workflows/cross-os-tests.yml\n    with:\n      os_matrix: linux, macos, windows\n    permissions:\n      contents: read',
      '  test:\n    uses: ./.github/workflows/cross-os-tests.yml\n    with:\n      os_matrix: linux, macos, windows')],
    ['R3', workflow.replace(
      '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions: {}',
      '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write')],
    ['R4', workflow.replace(
      '  publish:\n    needs: [draft-release]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read',
      '  publish:\n    needs: [draft-release]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write')],
    ['R5', workflow.replace(
      'actions/checkout@0123456789abcdef0123456789abcdef01234567',
      'actions/checkout@v7')],
    ['R6', workflow.replace('--tag-pushed', '--offline')],
    ['R7', workflow.replace('needs: [preflight, test]', 'needs: [test]')],
    ['R8', workflow.replace('--draft --title', '--title')],
    ['R9', workflow.replace('--tag "${channel}-candidate"', '--tag beta')],
    ['R10', workflow.replace('*-*) channel=beta ;;', '*-*) channel=latest ;;')],
    ['R11', workflow.replace('node: "22.18.0"', 'node: "22.18.1"')],
    ['R12', workflow.replace('tags: ["v*"]', 'tags: ["v2.*"]')],
  ];

  for (const [rule, mutated] of mutations) {
    assert.notEqual(mutated, workflow, rule + ' mutation must change the fixture');
    const findings = releaseWorkflowFindings(mutated);
    assert.equal(findings.length, 1, rule + ' should produce one isolated finding: ' + findings.join('; '));
    assert.match(findings[0], new RegExp('^' + rule + ' '));
  }
});

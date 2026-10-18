'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseWorkflow,
  releaseWorkflowFindings,
  RELEASE_WORKFLOW_RULE_IDS,
} = require('../../src/release/release-workflow.ts');

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

test('release workflow rule ids preserve R1-R12 and add R13-R14', () => {
  assert.deepEqual(RELEASE_WORKFLOW_RULE_IDS, [
    'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14',
  ]);
});

test('each R1-R14 fault mutation reports only its rule', () => {
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
    ['R13', workflow.replace(
      '  verify-registry:\n    needs: [publish]\n    runs-on: ${{ matrix.os }}',
      '  verify-registry:\n    needs: [publish]\n    runs-on: ${{ matrix.os }}\n    continue-on-error: true',
    )],
    ['R14', workflow.replace('--tag-pushed', '--tag-pushed --allow-stable')],
  ];

  for (const [rule, mutated] of mutations) {
    assert.notEqual(mutated, workflow, rule + ' mutation must change the fixture');
    const findings = releaseWorkflowFindings(mutated);
    assert.equal(findings.length, 1, rule + ' should produce one isolated finding: ' + findings.join('; '));
    assert.match(findings[0], new RegExp('^' + rule + ' '));
  }
});

test('comments do not satisfy R6, R8, or R9 requirements', () => {
  const mutations = [
    ['R6', workflow.replace(
      '      - run: npm run release:preflight -- --tag "$GITHUB_REF_NAME" --tag-pushed',
      '      # --tag-pushed\n      - run: npm run release:preflight -- --tag "$GITHUB_REF_NAME"',
    )],
    ['R8', workflow.replace(
      '      - run: gh release create "$GITHUB_REF_NAME" --draft --title "Release" --notes-file notes.md',
      '      # --draft\n      - run: gh release create "$GITHUB_REF_NAME" --title "Release" --notes-file notes.md',
    )],
    ['R8', workflow.replace(
      '      - run: gh release edit "$GITHUB_REF_NAME" --draft=false',
      '      # --draft=false\n      - run: gh release edit "$GITHUB_REF_NAME"',
    )],
    ['R9', workflow.replace(
      '      - run: npm publish .pack --provenance --tag "${channel}-candidate"',
      '      # npm publish --tag "${channel}-candidate"\n      - run: npm publish .pack --provenance',
    )],
  ];

  for (const [rule, mutated] of mutations) {
    assert.notEqual(mutated, workflow, rule + ' comment mutation must change the fixture');
    const findings = releaseWorkflowFindings(mutated);
    assert.equal(findings.length, 1, rule + ' comment should produce one isolated finding: ' + findings.join('; '));
    assert.match(findings[0], new RegExp('^' + rule + ' '));
  }
});

test('comment markers inside quoted YAML strings remain text', () => {
  const quotedHash = workflow.replace('--title "Release"', '--title "Release #1"');
  assert.match(parseWorkflow(quotedHash).jobs.get('draft-release').text, /--title "Release #1"/);
  assert.deepEqual(releaseWorkflowFindings(quotedHash), []);
});

test('permission variants and YAML aliases are rejected', () => {
  const writeAll = workflow.replace(
    '  test:\n    uses: ./.github/workflows/cross-os-tests.yml\n    with:\n      os_matrix: linux, macos, windows\n    permissions:\n      contents: read',
    '  test:\n    uses: ./.github/workflows/cross-os-tests.yml\n    with:\n      os_matrix: linux, macos, windows\n    permissions: write-all',
  );
  const flowMapR3 = workflow.replace(
    '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions: {}',
    '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions: { id-token: write }',
  );
  const flowMapR4 = workflow.replace(
    '  publish:\n    needs: [draft-release]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write',
    '  publish:\n    needs: [draft-release]\n    runs-on: ubuntu-latest\n    permissions: { contents: write }',
  );
  const aliases = workflow
    .replace('    permissions:\n      contents: read\n\n  verify-artifact:',
      '    permissions: *shared\n\n  verify-artifact:')
    .replace('    permissions:\n      contents: read\n      id-token: write',
      '    permissions: &shared\n      contents: read\n      id-token: write');

  for (const [name, mutated, expectedRules] of [
    ['write-all', writeAll, ['R3', 'R4']],
    ['R3 flow-map', flowMapR3, ['R3']],
    ['R4 flow-map', flowMapR4, ['R4']],
    ['YAML aliases', aliases, ['R3']],
  ]) {
    assert.notEqual(mutated, workflow, name + ' mutation must change the fixture');
    const findings = releaseWorkflowFindings(mutated);
    for (const rule of expectedRules) {
      assert.ok(findings.some((finding) => finding.startsWith(rule + ' ')),
        name + ' should report ' + rule + ': ' + findings.join('; '));
    }
    if (name === 'YAML aliases') {
      assert.ok(findings.some((finding) => finding.includes('aliases are not allowed in release.yml')),
        'aliases should have the documented finding text');
    }
  }
});

test('quoted job keys are parsed and block-list needs are accepted', () => {
  const quotedJob = workflow.replace(
    '  verify-registry:',
    '  "leak":\n    runs-on: ubuntu-latest\n    permissions: { id-token: write, contents: write }\n  verify-registry:',
  );
  const blockNeeds = workflow.replace(
    '    needs: [preflight, test]',
    '    needs:\n      - preflight\n      - test',
  );

  assert.ok(parseWorkflow(quotedJob).jobs.has('leak'));
  assert.ok(releaseWorkflowFindings(quotedJob).some((finding) => finding.startsWith('R3 ')));
  assert.ok(releaseWorkflowFindings(quotedJob).some((finding) => finding.startsWith('R4 ')));
  assert.deepEqual(releaseWorkflowFindings(blockNeeds), []);
  assert.deepEqual(parseWorkflow(blockNeeds).jobs.get('verify-artifact').needs, ['preflight', 'test']);
});

test('every npm publish invocation needs the candidate tag', () => {
  const secondBarePublish = workflow.replace(
    '      - run: npm publish .pack --provenance --tag "${channel}-candidate"',
    '      - run: |\n          npm publish .pack --provenance --tag "${channel}-candidate" --dry-run\n          npm publish .pack --provenance',
  );
  assert.notEqual(secondBarePublish, workflow, 'second publish mutation must change the fixture');
  const findings = releaseWorkflowFindings(secondBarePublish);
  assert.equal(findings.length, 1, 'bare second publish should produce one finding: ' + findings.join('; '));
  assert.match(findings[0], /^R9 /);
});

test('R13 rejects failure-bypassing conditions on promote and publish-release', () => {
  const mutations = [
    workflow.replace(
      '  promote:\n    needs: [verify-registry]',
      '  promote:\n    needs: [verify-registry]\n    if: always()',
    ),
    workflow.replace(
      '  publish-release:\n    needs: [promote]',
      '  publish-release:\n    needs: [promote]\n    if: ${{ !cancelled() }}',
    ),
    workflow.replace(
      '  promote:\n    needs: [verify-registry]',
      '  promote:\n    needs: [verify-registry]\n    if: failure()',
    ),
    workflow.replace(
      '  publish-release:\n    needs: [promote]',
      '  publish-release:\n    needs: [promote]\n    if: cancelled()',
    ),
  ];

  for (const mutated of mutations) {
    assert.notEqual(mutated, workflow, 'failure-bypass mutation must change the fixture');
    const findings = releaseWorkflowFindings(mutated);
    assert.equal(findings.length, 1, 'failure-bypass should produce one finding: ' + findings.join('; '));
    assert.match(findings[0], /^R13 /);
  }
});

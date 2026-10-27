'use strict';

// G51 — keep the release workflow inside the IC-004 rules and IC-005 job graph.
// The seeded copies are string mutations; the committed workflow stays untouched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const {
  releaseWorkflowFindings,
  workflowNodePins,
  RELEASE_WORKFLOW_RULE_IDS,
} = require('../../src/release/release-workflow.ts');

const workflowPath = path.join(REPO, '.github', 'workflows', 'release.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

function replaceOnce(text: any, before: any, after: any) {
  const index = text.indexOf(before);
  assert.notEqual(index, -1, `fault seed source must exist: ${before}`);
  return text.slice(0, index) + after + text.slice(index + before.length);
}

test('G51: committed release workflow satisfies IC-004', () => {
  assert.deepEqual(RELEASE_WORKFLOW_RULE_IDS, [
    'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14',
  ]);
  assert.deepEqual(releaseWorkflowFindings(workflow), []);
});

test('G51: each seeded workflow fault reports its IC-004 rule', () => {
  const faults: any = [
    { name: 'R5 unpinned action', rules: ['R5'], text: replaceOnce(
      workflow,
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      'actions/checkout@v7 # v7.0.1',
    ) },
    { name: 'R1 broad workflow permissions', rules: ['R1'], text: replaceOnce(
      workflow,
      'permissions: {}\n\njobs:',
      'permissions:\n  contents: write\n\njobs:',
    ) },
    { name: 'R3 id-token write', rules: ['R3'], text: replaceOnce(
      workflow,
      '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions: {}',
      '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write',
    ) },
    { name: 'R3/R4 write-all', rules: ['R3', 'R4'], text: replaceOnce(
      workflow,
      '    permissions:\n      contents: read\n\n  verify-artifact:',
      '    permissions: write-all\n\n  verify-artifact:',
    ) },
    { name: 'R3 flow-map id-token', rules: ['R3'], text: replaceOnce(
      workflow,
      '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions: {}',
      '  promote:\n    needs: [verify-registry]\n    runs-on: ubuntu-latest\n    permissions: { id-token: write }',
    ) },
    { name: 'R4 flow-map contents', rules: ['R4'], text: replaceOnce(
      workflow,
      '  publish:\n    needs: [draft-release]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write',
      '  publish:\n    needs: [draft-release]\n    runs-on: ubuntu-latest\n    permissions: { contents: write }',
    ) },
    { name: 'R3 aliases', rules: ['R3'], text: replaceOnce(
      workflow,
      '  verify-registry:',
      '  test-alias:\n    runs-on: ubuntu-latest\n    permissions: *shared\n  verify-registry:',
    ).replace('  test:\n    uses:', '  test:\n    permissions: &shared\n      contents: read\n    uses:') },
    { name: 'R3/R4 quoted job key', rules: ['R3', 'R4'], text: replaceOnce(
      workflow,
      '  verify-registry:',
      '  "leak":\n    runs-on: ubuntu-latest\n    permissions: { id-token: write, contents: write }\n  verify-registry:',
    ) },
    { name: 'R6 missing preflight needs and flag', rules: ['R6'], text: replaceOnce(
      workflow,
      '  preflight:\n    runs-on: ubuntu-latest',
      '  preflight:\n    needs: [test]\n    runs-on: ubuntu-latest',
    ) },
    { name: 'R6 comment-only tag-pushed', rules: ['R6'], text: replaceOnce(
      workflow,
      '      - run: npm run release:preflight -- --tag "$GITHUB_REF_NAME" --tag-pushed',
      '      # --tag-pushed\n      - run: npm run release:preflight -- --tag "$GITHUB_REF_NAME"',
    ) },
    { name: 'R7 missing graph edge', rules: ['R7'], text: replaceOnce(
      workflow,
      '  publish-release:\n    needs: [promote]',
      '  publish-release:\n    needs: []',
    ) },
    { name: 'R8 comment-only draft flag', rules: ['R8'], text: replaceOnce(
      workflow,
      '            --draft \\\n            --title "$GITHUB_REF_NAME" \\\n',
      '            # --draft\n            --title "$GITHUB_REF_NAME" \\\n',
    ) },
    { name: 'R8 comment-only draft=false flag', rules: ['R8'], text: replaceOnce(
      workflow,
      'run: gh release edit "$GITHUB_REF_NAME" --draft=false --repo "$GITHUB_REPOSITORY"',
      '# --draft=false\n        run: gh release edit "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY"',
    ) },
    { name: 'R9 literal tag', rules: ['R9'], text: replaceOnce(
      workflow,
      'npm publish .pack --provenance --tag "${channel}-candidate"',
      'npm publish .pack --provenance --tag beta',
    ) },
    { name: 'R9 comment-only candidate tag', rules: ['R9'], text: replaceOnce(
      workflow,
      '        run: npm publish .pack --provenance --tag "${channel}-candidate"',
      '        # npm publish --tag "${channel}-candidate"\n        run: npm publish .pack --provenance',
    ) },
    { name: 'R9 second bare publish', rules: ['R9'], text: replaceOnce(
      workflow,
      '        run: npm publish .pack --provenance --tag "${channel}-candidate"',
      '        run: |\n          npm publish .pack --provenance --tag "${channel}-candidate" --dry-run\n          npm publish .pack --provenance',
    ) },
    { name: 'R13 continue-on-error', rules: ['R13'], text: replaceOnce(
      workflow,
      '    runs-on: ${{ matrix.os }}\n    permissions: {}',
      '    runs-on: ${{ matrix.os }}\n    continue-on-error: true\n    permissions: {}',
    ) },
    { name: 'R13 promote continue-on-error', rules: ['R13'], text: replaceOnce(
      workflow,
      '  promote:\n    needs: [verify-registry]',
      '  promote:\n    needs: [verify-registry]\n    continue-on-error: true',
    ) },
    { name: 'R13 publish-release continue-on-error', rules: ['R13'], text: replaceOnce(
      workflow,
      '  publish-release:\n    needs: [promote]',
      '  publish-release:\n    needs: [promote]\n    continue-on-error: true',
    ) },
    { name: 'R13 publish continue-on-error', rules: ['R13'], text: replaceOnce(
      workflow,
      '  publish:\n    needs: [draft-release]',
      '  publish:\n    needs: [draft-release]\n    continue-on-error: true',
    ) },
    { name: 'R13 promote always()', rules: ['R13'], text: replaceOnce(
      workflow,
      '  promote:\n    needs: [verify-registry]',
      '  promote:\n    needs: [verify-registry]\n    if: always()',
    ) },
    { name: 'R13 publish-release cancelled()', rules: ['R13'], text: replaceOnce(
      workflow,
      '  publish-release:\n    needs: [promote]',
      '  publish-release:\n    needs: [promote]\n    if: ${{ !cancelled() }}',
    ) },
    { name: 'R13 failure()', rules: ['R13'], text: replaceOnce(
      workflow,
      '  promote:\n    needs: [verify-registry]',
      '  promote:\n    needs: [verify-registry]\n    if: failure()',
    ) },
    { name: 'R14 allow-stable', rules: ['R14'], text: replaceOnce(
      workflow,
      '--tag-pushed',
      '--tag-pushed --allow-stable',
    ) },
  ];

  for (const { name, rules, text: mutated } of faults) {
    assert.notEqual(mutated, workflow, `${name} seed must change a copy of the workflow`);
    const findings = releaseWorkflowFindings(mutated);
    for (const rule of rules) {
      assert.ok(
        findings.some((finding: any) => finding.startsWith(`${rule} `)),
        `${name} seed must be reported by ${rule}; got: ${findings.join('; ')}`,
      );
    }
    if (name === 'R3 aliases') {
      assert.ok(findings.some((finding: any) => finding.includes('aliases are not allowed in release.yml')),
        'alias seed must use the specified finding text');
    }
  }
});

// One source for the Node floor: package.json engines.node. Every Node pin in every workflow, the
// rehearsal command in docs/reference.md and the rehearsal's own floor must be that version, so a
// floor change that misses one place fails here instead of in a release run.
const engineFloor = String(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).engines.node).match(/\d+\.\d+\.\d+/)![0];
const workflowDir = path.join(REPO, '.github', 'workflows');

test('G51: every Node pin in every workflow equals the engines floor', () => {
  const files = fs.readdirSync(workflowDir).filter((name: any) => /\.ya?ml$/.test(name));
  assert.ok(files.includes('release.yml') && files.includes('cross-os-tests.yml') && files.includes('drift.yml'));
  const wrong: any = [];
  let pinned = 0;
  for (const file of files) {
    for (const pin of workflowNodePins(fs.readFileSync(path.join(workflowDir, file), 'utf8'))) {
      pinned++;
      if (pin.value !== engineFloor) wrong.push(`${file}:${pin.line} pins Node "${pin.value}", engines floor is ${engineFloor}`);
    }
  }
  assert.ok(pinned >= 8, `expected the workflows to pin Node in several places, found ${pinned}`);
  assert.deepEqual(wrong, []);
});

test('G51: the rehearsal command in docs/reference.md names the engines floor', () => {
  const reference = fs.readFileSync(path.join(REPO, 'docs', 'reference.md'), 'utf8');
  const named = [...reference.matchAll(/node@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
  assert.ok(named.length >= 1, 'reference.md must name the floor Node for the rehearsal');
  assert.deepEqual(named.filter((version) => version !== engineFloor), []);
});

test('G51: the rehearsal takes its floor from engines.node (no copy of its own)', () => {
  const source = fs.readFileSync(path.join(REPO, 'src', 'release', 'rehearse.ts'), 'utf8');
  assert.match(source, /pkg\.engines\.node/);
  assert.doesNotMatch(source, /['"`]\d+\.\d+\.\d+['"`]/, 'rehearse.ts must not hold a literal Node version');
});

test('G51 negative control: a workflow pin that is not the floor is reported', () => {
  const drift = fs.readFileSync(path.join(workflowDir, 'drift.yml'), 'utf8').replace(`node-version: "${engineFloor}"`, 'node-version: "24"');
  assert.deepEqual(workflowNodePins(drift).map((pin: any) => pin.value), ['24']);
});

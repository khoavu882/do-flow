'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseWorkflow,
  releaseWorkflowFindings,
  workflowNodePins,
  RELEASE_WORKFLOW_RULE_IDS,
} = require('../../src/release/release-workflow.ts');

const fixturePath = path.join(__dirname, '../fixtures/release/release-valid.yml');
const workflow = fs.readFileSync(fixturePath, 'utf8');

test('parseWorkflow reads top permissions, job fields, uses, text, and source line', () => {
  const parsed = parseWorkflow(workflow);
  assert.equal(parsed.topPermissions, '{}');
  assert.ok(parsed.jobs instanceof Map);
  assert.deepEqual(parsed.jobs.get('verify-artifact').needs, ['preflight', 'test', 'rehearse']);
  assert.match(parsed.jobs.get('publish').permissions, /id-token: write/);
  assert.ok(parsed.jobs.get('publish').uses.length > 0);
  assert.match(parsed.jobs.get('publish').text, /npm publish/);
  assert.equal(parsed.jobs.get('preflight').line, 7);
});

test('the release fixture satisfies every workflow rule', () => {
  assert.deepEqual(releaseWorkflowFindings(workflow), []);
});

test('release workflow rule ids preserve R1-R12 and add R13-R15', () => {
  assert.deepEqual(RELEASE_WORKFLOW_RULE_IDS, [
    'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15',
  ]);
});

test('each R1-R15 fault mutation reports only its rule', () => {
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
    ['R7', workflow.replace('needs: [preflight, test, rehearse]', 'needs: [test, rehearse]')],
    ['R8', workflow.replace('--draft --title', '--title')],
    ['R9', workflow.replace('--tag "${channel}-candidate"', '--tag beta')],
    ['R10', workflow.replace('*-*) channel=beta ;;', '*-*) channel=latest ;;')],
    ['R11', workflow.replace('node: "24.22.1"', 'node: "24.22.2"')],
    ['R12', workflow.replace('tags: ["v*"]', 'tags: ["v2.*"]')],
    ['R13', workflow.replace(
      '  verify-registry:\n    needs: [publish]\n    runs-on: ${{ matrix.os }}',
      '  verify-registry:\n    needs: [publish]\n    runs-on: ${{ matrix.os }}\n    continue-on-error: true',
    )],
    ['R14', workflow.replace('--tag-pushed', '--tag-pushed --allow-stable')],
    ['R15', workflow.replace('needs: [preflight, test, rehearse]', 'needs: [preflight, test]')],
  ];

  for (const [rule, mutated] of mutations) {
    assert.notEqual(mutated, workflow, rule + ' mutation must change the fixture');
    const findings = releaseWorkflowFindings(mutated);
    assert.equal(findings.length, 1, rule + ' should produce one isolated finding: ' + findings.join('; '));
    assert.match(findings[0], new RegExp('^' + rule + ' '));
  }
});

// The fixture keeps the stable path shut (no flag at all); this copy opens it behind the gate.
const GATE_ENVIRONMENT = "    environment: ${{ !contains(github.ref_name, '-') && 'release-stable' || 'release-prerelease' }}\n";
const GATE_CASE = '          *-*) ;;\n          *) allow_stable="--allow-stable" ;;\n';
const gated = workflow
  .replace('  preflight:\n    runs-on: ubuntu-latest\n', '  preflight:\n    runs-on: ubuntu-latest\n' + GATE_ENVIRONMENT)
  .replace('      - run: npm run release:preflight -- --tag "$GITHUB_REF_NAME" --tag-pushed\n',
    '      - run: |\n          allow_stable=""\n          case "$GITHUB_REF_NAME" in\n' + GATE_CASE
      + '          esac\n          npm run release:preflight -- --tag "$GITHUB_REF_NAME" --tag-pushed $allow_stable\n');

test('R14: the stable flag behind the preflight environment gate satisfies every rule', () => {
  assert.ok(gated.includes(GATE_ENVIRONMENT) && gated.includes(GATE_CASE), 'the gated copy must carry the gate');
  assert.deepEqual(releaseWorkflowFindings(gated), []);
});

test('R14: each way to widen the gated stable path produces one isolated R14 finding', () => {
  const mutations = [
    ['flag on every tag', gated.replace('--tag-pushed $allow_stable', '--tag-pushed --allow-stable')],
    ['prerelease branch sets the flag', gated.replace(GATE_CASE,
      '          *-*) allow_stable="--allow-stable" ;;\n          *) ;;\n')],
    ['catch-all branch first', gated.replace(GATE_CASE,
      '          *) allow_stable="--allow-stable" ;;\n          *-*) ;;\n')],
    ['no reset', gated.replace('          allow_stable=""\n', '')],
    ['no environment', gated.replace(GATE_ENVIRONMENT, '')],
    ['environment for prereleases only', gated.replace("!contains(github.ref_name, '-')", "contains(github.ref_name, '-')")],
    ['unchecked environment name', gated.replace("'release-stable'", "'release-open'")],
    ['empty prerelease environment', gated.replace("'release-prerelease'", "''")],
    ['environment names swapped', gated.replace("'release-stable' || 'release-prerelease'", "'release-prerelease' || 'release-stable'")],
    ['quoted continue-on-error key', gated.replace('      - run: |\n          allow_stable=""',
      '      - "continue-on-error": true\n        run: |\n          allow_stable=""')],
    ['single-quoted continue-on-error key', gated.replace('      - run: |\n          allow_stable=""',
      "      - 'continue-on-error': true\n        run: |\n          allow_stable=\"\"")],
    ['flow-mapping continue-on-error', gated.replace('      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7.1.0\n        with:\n          fetch-depth: 0\n',
      '      - { uses: actions/checkout@0123456789abcdef0123456789abcdef01234567, continue-on-error: true, with: { fetch-depth: 0 } }\n')],
    ['environment object form', gated.replace(GATE_ENVIRONMENT, '    environment:\n      name: release-stable\n')],
    ['flag in publish', gated.replace('--tag "${channel}-candidate"', '--tag "${channel}-candidate" --allow-stable')],
    ['preflight step continue-on-error', gated.replace('      - run: |\n          allow_stable=""',
      '      - continue-on-error: true\n        run: |\n          allow_stable=""')],
    ['preflight step if', gated.replace('      - run: |\n          allow_stable=""',
      '      - if: false\n        run: |\n          allow_stable=""')],
  ];
  for (const [name, mutated] of mutations) {
    assert.notEqual(mutated, gated, name + ' mutation must change the gated copy');
    const findings = releaseWorkflowFindings(mutated);
    assert.equal(findings.length, 1, name + ' should produce one isolated finding: ' + findings.join('; '));
    assert.match(findings[0], /^R14 /, name);
  }
});

test('R14: a skippable preflight step is refused even while the stable path is shut', () => {
  const skipped = workflow.replace('      - run: npm run release:preflight',
    '      - if: false\n        run: npm run release:preflight');
  assert.notEqual(skipped, workflow);
  const findings = releaseWorkflowFindings(skipped);
  assert.equal(findings.length, 1, findings.join('; '));
  assert.match(findings[0], /^R14 .*if condition/);
});

test('R11: every Node pin must equal the engines floor, not only the verify-registry matrix', () => {
  const pins = workflowNodePins(workflow);
  assert.ok(pins.length >= 4, 'the fixture pins Node in several places');
  assert.ok(pins.every((pin: any) => pin.value === '24.22.1'), JSON.stringify(pins));
  const mutations = [
    ['a setup-node pin of 24', workflow.replace('node-version: 24.22.1\n      - run: npm run build:package\n      - run: npm pack',
      'node-version: 24\n      - run: npm run build:package\n      - run: npm pack')],
    ['the macOS matrix pin of 24', workflow.replace('os: macos-latest\n            node: "24.22.1"', 'os: macos-latest\n            node: "24"')],
  ];
  for (const [name, mutated] of mutations) {
    assert.notEqual(mutated, workflow, name + ' must change the fixture');
    const findings = releaseWorkflowFindings(mutated);
    assert.equal(findings.length, 1, name + ': ' + findings.join('; '));
    assert.match(findings[0], /^R11 /);
  }
  assert.deepEqual(releaseWorkflowFindings(workflow, { nodeFloor: '24.22.1' }), []);
  for (const nodeFloor of ['24.23.0', null]) {
    const findings = releaseWorkflowFindings(workflow, { nodeFloor });
    assert.equal(findings.length, 1, String(nodeFloor) + ': ' + findings.join('; '));
    assert.match(findings[0], /^R11 /);
  }
});

test('workflowNodePins reads scalar, quoted, matrix-list and commented pins and skips expressions', () => {
  const text = [
    'a:', '  with:', '    node-version: 24', '    node-version: "24.22.1"', "    node-version: '24.22.1'",
    '    node-version: ${{ matrix.node }}', '  strategy:', '    matrix:', '      node: ["24.22.1", "24"]',
    '      - os: x', '        node: 24.22.1  # floor', '# node-version: 20', '      run: node -e "require(\'node:fs\')"',
  ].join('\n');
  assert.deepEqual(workflowNodePins(text).map((pin: any) => pin.value), ['24', '24.22.1', '24.22.1', '24.22.1', '24', '24.22.1']);
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
      assert.ok(findings.some((finding: any) => finding.startsWith(rule + ' ')),
        name + ' should report ' + rule + ': ' + findings.join('; '));
    }
    if (name === 'YAML aliases') {
      assert.ok(findings.some((finding: any) => finding.includes('aliases are not allowed in release.yml')),
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
    '    needs: [preflight, test, rehearse]',
    '    needs:\n      - preflight\n      - test\n      - rehearse',
  );

  assert.ok(parseWorkflow(quotedJob).jobs.has('leak'));
  assert.ok(releaseWorkflowFindings(quotedJob).some((finding: any) => finding.startsWith('R3 ')));
  assert.ok(releaseWorkflowFindings(quotedJob).some((finding: any) => finding.startsWith('R4 ')));
  assert.deepEqual(releaseWorkflowFindings(blockNeeds), []);
  assert.deepEqual(parseWorkflow(blockNeeds).jobs.get('verify-artifact').needs, ['preflight', 'test', 'rehearse']);
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

test('R13 rejects job-level if on the chain up to publish and failure bypasses after it, however spelled', () => {
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
    workflow.replace(
      '  verify-artifact:\n    needs: [preflight, test, rehearse]',
      '  verify-artifact:\n    needs: [preflight, test, rehearse]\n    if: always()',
    ),
    workflow.replace(
      '  draft-release:\n    needs: [verify-artifact]',
      '  draft-release:\n    needs: [verify-artifact]\n    if: ${{ !cancelled() }}',
    ),
    workflow.replace(
      '  publish:\n    needs: [draft-release]',
      '  publish:\n    needs: [draft-release]\n    if: success()',
    ),
    workflow.replace(
      '  promote:\n    needs: [verify-registry]',
      '  promote:\n    needs: [verify-registry]\n    "if": always()',
    ),
    workflow.replace(
      '  verify-registry:\n    needs: [publish]',
      "  verify-registry:\n    needs: [publish]\n    'continue-on-error': true",
    ),
  ];

  for (const mutated of mutations) {
    assert.notEqual(mutated, workflow, 'failure-bypass mutation must change the fixture');
    const findings = releaseWorkflowFindings(mutated);
    assert.equal(findings.length, 1, 'failure-bypass should produce one finding: ' + findings.join('; '));
    assert.match(findings[0], /^R13 /);
  }
});

test('R15: the rehearsal job must exist, run on the preflight Node, run the rehearsal and gate verify-artifact', () => {
  const rehearseJob = workflow.slice(workflow.indexOf('  rehearse:\n'), workflow.indexOf('  verify-artifact:\n'));
  assert.ok(rehearseJob.includes('release:rehearse'), 'the fixture carries a rehearse job');
  const mutations = [
    ['job missing', workflow.replace(rehearseJob, '').replace('needs: [preflight, test, rehearse]', 'needs: [preflight, test]'), /rehearse job is missing/],
    ['not in verify-artifact needs', workflow.replace('needs: [preflight, test, rehearse]', 'needs: [preflight, test]'), /verify-artifact must need rehearse/],
    // R11 also reports a pin that is not the engines floor; R15 is the relative rule against preflight.
    ['another Node', workflow.replace(rehearseJob, rehearseJob.replace('24.22.1', '24.22.2')), /same Node as preflight/, 'R11'],
    ['no Node pin', workflow.replace(rehearseJob, rehearseJob.replace(/      - uses: actions\/setup-node[^\n]*\n        with:\n          node-version: 24\.22\.1\n/, '')), /same Node as preflight/],
    ['does not skip the rehearsal preflight', workflow.replace(rehearseJob, rehearseJob.replace(' -- --skip-preflight', '')), /must pass --skip-preflight/],
    ['does not skip the rehearsal suite', workflow.replace(rehearseJob, rehearseJob.replace(' --skip-suite', '')), /must pass --skip-suite/],
    ['does not run the rehearsal', workflow.replace(rehearseJob, rehearseJob.replace('release:rehearse', 'build:package')), /must run release:rehearse/],
    ['continue-on-error on the job', workflow.replace(rehearseJob, rehearseJob.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    continue-on-error: true\n')), /rehearse must not declare continue-on-error/],
    ['continue-on-error on the rehearsal step', workflow.replace(rehearseJob, rehearseJob.replace('      - run: npm run release:rehearse -- --skip-preflight --skip-suite', '      - run: npm run release:rehearse -- --skip-preflight --skip-suite\n        continue-on-error: true')), /rehearse must not declare continue-on-error/],
  ];
  for (const [name, mutated, message, alsoRule] of mutations as Array<[string, string, RegExp, string | undefined]>) {
    assert.notEqual(mutated, workflow, name + ' mutation must change the fixture');
    const findings = releaseWorkflowFindings(mutated);
    const r15 = findings.filter((finding: any) => finding.startsWith('R15 '));
    assert.equal(r15.length, 1, name + ' should produce one R15 finding: ' + findings.join('; '));
    assert.match(r15[0], message, name);
    assert.deepEqual(findings.filter((finding: any) => !finding.startsWith('R15 ') && !finding.startsWith((alsoRule ?? '-') + ' ')), [], name);
  }
});

test('R15 reads the run of the step that runs release:rehearse, not other job text', () => {
  const rehearseJob = workflow.slice(workflow.indexOf('  rehearse:\n'), workflow.indexOf('  verify-artifact:\n'));
  const goodStep = '      - run: npm run release:rehearse -- --skip-preflight --skip-suite';
  assert.ok(rehearseJob.includes(goodStep), 'the fixture carries the rehearsal step');
  const withStep = (step: string) => workflow.replace(rehearseJob, rehearseJob.replace(goodStep, step));
  const r15 = (text: string) => releaseWorkflowFindings(text).filter((finding: string) => finding.startsWith('R15 '));
  const bothMissing = /must pass --skip-preflight.*must pass --skip-suite/;
  const cases: Array<[string, string, RegExp]> = [
    ['a name carrying the flags over a bare command', '      - name: npm run release:rehearse -- --skip-preflight --skip-suite\n        run: npm run release:rehearse', bothMissing],
    ['a second step carrying the flags after a bare one', '      - run: npm run release:rehearse\n' + goodStep, bothMissing],
    ['the flags in another key of the step', '      - env:\n          NOTE: --skip-preflight --skip-suite\n        run: npm run release:rehearse', bothMissing],
    ['the flags before the bare --', '      - run: npm run release:rehearse --skip-preflight --skip-suite', bothMissing],
    ['only one flag reports the other', '      - run: npm run release:rehearse -- --skip-suite', /must pass --skip-preflight/],
    ['a repeated flag', '      - run: npm run release:rehearse -- --skip-preflight --skip-preflight --skip-suite', /rejects.*usage:/],
    ['a flag taking a value that swallows a skip flag', '      - run: npm run release:rehearse -- --ref --skip-preflight --skip-suite', /rejects.*usage:/],
    ['|| true on the step', goodStep + ' || true', /must not mask the rehearsal failure/],
    ['; true on the step', goodStep + '; true', /must not mask the rehearsal failure/],
    ['|| : on the step', goodStep + ' || :', /must not mask the rehearsal failure/],
    ['|| exit 0 on the step', goodStep + ' || exit 0', /must not mask the rehearsal failure/],
    ['; : on the step', goodStep + '; :', /must not mask the rehearsal failure/],
    ['; exit 0 on the step', goodStep + '; exit 0', /must not mask the rehearsal failure/],
    ['the rehearsal in the background', goodStep + ' &', /must not run release:rehearse in the background/],
    ['the rehearsal in the background, then waited without its status', '      - run: |\n          npm run release:rehearse -- --skip-preflight --skip-suite &\n          wait', /must not run release:rehearse in the background/],
    ['|| true after a pipe', goodStep + ' 2>&1 | tee rehearse.log || true', /must not mask the rehearsal failure/],
    ['|| true after a continuation line', '      - run: |\n          npm run release:rehearse -- --skip-preflight \\\n            --skip-suite \\\n            || true', /must not mask the rehearsal failure/],
    ['the command only inside a quoted comment', '      - run: "true # npm run release:rehearse -- --skip-preflight --skip-suite"', /must run release:rehearse/],
    ['the command only as echo arguments', '      - run: echo npm run release:rehearse -- --skip-preflight --skip-suite', /must run release:rehearse/],
    ['the command only inside quotes', '      - run: echo "x" && echo \'npm run release:rehearse -- --skip-preflight --skip-suite\'', /must run release:rehearse/],
    ['a flag taking a value, after a pipe-free redirect', goodStep + ' --ref --keep > rehearse.log', /rejects.*usage:/],
  ];
  for (const [name, step, message] of cases) {
    const mutated = withStep(step);
    assert.notEqual(mutated, workflow, name);
    const found = r15(mutated);
    assert.equal(found.length, 1, name + ': ' + releaseWorkflowFindings(mutated).join('; '));
    assert.match(found[0], message, name);
  }
  // Both flags are reported at once, not only the first.
  const missing = r15(withStep('      - run: npm run release:rehearse'))[0];
  assert.match(missing, /--skip-preflight/);
  assert.match(missing, /--skip-suite/);
  // Controls: the same command in a block scalar, folded across lines and with an extra valid flag stays green.
  for (const step of [
    '      - run: |\n          npm run release:rehearse -- --skip-preflight --skip-suite',
    '      - run: |\n          echo start\n          npm run release:rehearse -- --skip-preflight \\\n            --skip-suite',
    '      - run: npm run release:rehearse -- --skip-preflight --skip-suite --keep',
    '      - name: the rehearsal\n        run: "npm run release:rehearse -- --skip-preflight --skip-suite"',
    goodStep + ' 2>&1 | tee rehearse.log',
    goodStep + ' > rehearse.log',
    goodStep + ' &> rehearse.log',
    goodStep + ' &>> rehearse.log',
    goodStep + ' |& tee rehearse.log',
    goodStep + ' >&2',
    goodStep + ' && echo "a & b"',
    goodStep + ' >> rehearse.log 2>&1',
    goodStep + ' && echo done',
    goodStep + ' # the rehearsal',
    goodStep + ' --ref ${{ github.sha }}',
    goodStep + ' --ref "$GITHUB_SHA"',
    goodStep + ' --node "$(command -v node)"',
    goodStep + ' --node "${NODE_BIN}"',
    '      - run: echo start && npm run release:rehearse -- --skip-preflight --skip-suite',
    '      - run: |\n          npm run release:rehearse -- --skip-preflight --skip-suite\n          rm -rf scratch || true',
    '      - run: |\n          npm run release:rehearse -- --skip-preflight --skip-suite\n          echo done; true',
    '      - env:\n          FOO: bar\n        working-directory: .\n        run: FOO=1 npm run release:rehearse -- --skip-preflight --skip-suite',
    '      - run: >-\n          npm run release:rehearse --\n          --skip-preflight --skip-suite',
  ]) {
    assert.deepEqual(releaseWorkflowFindings(withStep(step)), [], step);
  }
  // An indentless sequence (`steps:` and `- run:` at one indent) is read, in both directions.
  const indentless = (text: string) => text.replace(/(  rehearse:\n[\s\S]*?\n    steps:\n)([\s\S]*?)(\n  verify-artifact:)/,
    (_match, head: string, steps: string, tail: string) => head + steps.split('\n').map((line) => line.replace(/^  /, '')).join('\n') + tail);
  assert.notEqual(indentless(workflow), workflow);
  assert.deepEqual(r15(indentless(workflow)), []);
  assert.match(r15(indentless(withStep('      - run: npm run release:rehearse')))[0], bothMissing);
  assert.match(r15(indentless(withStep(goodStep + ' || true')))[0], /must not mask/);
});

test('yamlKeys reads keys however spelled and treats block scalar bodies as text', () => {
  const { yamlKeys } = require('../../src/release/release-workflow.ts');
  const text = [
    '  job:', '    "if": always()', '    steps:', "      - 'continue-on-error': true",
    '      - { uses: a, "continue\\x2Don-error": true, with: { x: 1 } }', '      - name: y',
    '        ? continue-on-error', '        : true', '      - run: |', '          if: shell text',
    '          continue-on-error: shell text', '    env: { A: "${{ x }}" }',
  ].join('\n');
  const keys = yamlKeys(text);
  assert.deepEqual(keys.filter((entry: any) => entry.key === 'if').map((entry: any) => entry.column), [4]);
  assert.deepEqual(keys.filter((entry: any) => entry.key === 'continue-on-error').map((entry: any) => entry.column), [8, 8, -1]);
  assert.deepEqual(keys.filter((entry: any) => entry.column === -1).map((entry: any) => entry.key), ['uses', 'continue-on-error', 'x', 'with', 'A']);
});

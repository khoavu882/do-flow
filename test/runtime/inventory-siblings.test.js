'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectSiblings, WHOLESALE_ASSETS } = require('../../src/runtime/inventory/siblings');

/** A fresh, real temp directory per test — never the real `~/.claude`, `~/.kiro` or `~/.doflow`.
 * Removed after the test whether it passes or fails. */
function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-siblings-test-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Records every directory `inspectSiblings` reads, then delegates to the real `fs`. The call list
 * is the only way to assert that a name-resolved directory is not read *at all* — a module that
 * read it and then discarded the entries would pass every result-shaped assertion. */
function spyFs(calls) {
  return {
    readdirSync(target, opts) {
      calls.push(target);
      return fs.readdirSync(target, opts);
    },
  };
}

/** A resource as recorded in the neutral ledger, reduced to the three fields this module reads. */
function resource(harness, assetId, target) {
  return { harness, assetId, target };
}

test('the wholesale set names exactly the two asset/harness pairs verified in the adapters', () => {
  // Derived from adapter behaviour, not from the registry: `copilot-rule-instructions` renders
  // every file under `applyTo: '**'`, and the kiro adapter takes DoFlow's full guidance tree as
  // steering. A third pair appearing here without an adapter locator behind it is the failure
  // this assertion exists to catch.
  assert.deepEqual(Object.keys(WHOLESALE_ASSETS).sort(), ['copilot', 'kiro']);
  assert.deepEqual([...WHOLESALE_ASSETS.copilot], ['instructions.copilot']);
  assert.deepEqual([...WHOLESALE_ASSETS.kiro], ['guidance.context-layer']);
});

test('an unmanaged file in a wholesale directory holding a managed asset is reported', () => {
  withTempDir((dir) => {
    const instructions = path.join(dir, '.github', 'instructions');
    fs.mkdirSync(instructions, { recursive: true });
    const managed = path.join(instructions, 'RULE_01_SAFETY.instructions.md');
    fs.writeFileSync(managed, 'managed');
    fs.writeFileSync(path.join(instructions, 'team-house-rules.instructions.md'), 'not ours');

    const result = inspectSiblings({
      resources: [resource('copilot', 'instructions.copilot', managed)],
    });

    const candidates = result.candidatesByTarget[managed];
    assert.ok(candidates, 'expected candidates for the managed target');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, 'team-house-rules.instructions.md');
    assert.equal(candidates[0].path, path.join(instructions, 'team-house-rules.instructions.md'));
    assert.equal(candidates[0].parentDir, instructions);
    assert.equal(candidates[0].kind, 'file');
    assert.equal(candidates[0].harness, 'copilot');
    assert.equal(candidates[0].assetId, 'instructions.copilot');
    assert.equal(result.directoriesInspected, 1);
  });
});

test('presence is the whole test: a file bearing no resemblance to a managed name is still reported', () => {
  withTempDir((dir) => {
    const steering = path.join(dir, '.kiro', 'steering');
    fs.mkdirSync(steering, { recursive: true });
    const managed = path.join(steering, 'PRINCIPLES.md');
    fs.writeFileSync(managed, 'managed');
    fs.writeFileSync(path.join(steering, 'company-tone-of-voice.md'), 'foreign steering');
    fs.writeFileSync(path.join(steering, 'notes.txt'), 'also loaded wholesale');

    const result = inspectSiblings({
      resources: [resource('kiro', 'guidance.context-layer', managed)],
    });

    const names = result.candidatesByTarget[managed].map((candidate) => candidate.name).sort();
    assert.deepEqual(names, ['company-tone-of-voice.md', 'notes.txt']);
  });
});

test('an unmanaged file in a name-resolved directory is not reported, and that directory is never read', () => {
  withTempDir((dir) => {
    const skillDir = path.join(dir, '.claude', 'skills', 'do-implement');
    fs.mkdirSync(skillDir, { recursive: true });
    const managed = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(managed, 'managed');
    fs.writeFileSync(path.join(skillDir, 'someone-elses-notes.md'), 'inert: claude loads SKILL.md');

    const calls = [];
    const result = inspectSiblings({
      resources: [resource('claude', 'skills.doflow', managed)],
      fsImpl: spyFs(calls),
    });

    assert.deepEqual(calls, [], 'a name-resolved directory must not be read, not even to count');
    assert.deepEqual(result.candidatesByTarget, {});
    assert.equal(result.directoriesInspected, 0);
  });
});

test('a backup file beside a name-resolved SKILL.md is not reported', () => {
  // Regression for the rule this module used to implement. A backup at a filename-prefix variant
  // of a name-resolved asset cannot be loaded by a harness that opens `SKILL.md` and nothing else,
  // so reporting it was a false positive (requirement §9, 2026-09-27).
  withTempDir((dir) => {
    const skillDir = path.join(dir, '.claude', 'skills', 'do-implement');
    fs.mkdirSync(skillDir, { recursive: true });
    const managed = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(managed, 'managed');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md.pre-v1.2.0-backup-20250101'), 'stale backup');

    const calls = [];
    const result = inspectSiblings({
      resources: [resource('claude', 'skills.doflow', managed)],
      fsImpl: spyFs(calls),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(result.candidatesByTarget, {});
  });
});

test('the same asset is wholesale for kiro and name-resolved for every other harness', () => {
  withTempDir((dir) => {
    const steering = path.join(dir, '.kiro', 'steering');
    const claudeGuidance = path.join(dir, '.doflow', 'guidance');
    fs.mkdirSync(steering, { recursive: true });
    fs.mkdirSync(claudeGuidance, { recursive: true });
    const kiroManaged = path.join(steering, 'PRINCIPLES.md');
    const claudeManaged = path.join(claudeGuidance, 'PRINCIPLES.md');
    fs.writeFileSync(kiroManaged, 'managed');
    fs.writeFileSync(claudeManaged, 'managed');
    fs.writeFileSync(path.join(steering, 'foreign.md'), 'live steering context');
    fs.writeFileSync(path.join(claudeGuidance, 'foreign.md'), 'never @-imported');

    const calls = [];
    const result = inspectSiblings({
      resources: [
        resource('kiro', 'guidance.context-layer', kiroManaged),
        resource('claude', 'guidance.context-layer', claudeManaged),
      ],
      fsImpl: spyFs(calls),
    });

    assert.deepEqual(calls, [steering]);
    assert.deepEqual(Object.keys(result.candidatesByTarget), [kiroManaged]);
    assert.equal(result.candidatesByTarget[kiroManaged][0].name, 'foreign.md');
  });
});

test('a wholesale directory holding no managed asset is not inspected', () => {
  withTempDir((dir) => {
    const managedInstructions = path.join(dir, 'repo-a', '.github', 'instructions');
    fs.mkdirSync(managedInstructions, { recursive: true });
    const managed = path.join(managedInstructions, 'RULE_01_SAFETY.instructions.md');
    fs.writeFileSync(managed, 'managed');

    // Same shape, same harness's native directory name — but nothing managed was ever installed
    // here, so it is not the parent of any recorded resource and is out of scope (R6).
    const foreignInstructions = path.join(dir, 'repo-b', '.github', 'instructions');
    fs.mkdirSync(foreignInstructions, { recursive: true });
    fs.writeFileSync(path.join(foreignInstructions, 'whatever.instructions.md'), 'not ours');

    const calls = [];
    const result = inspectSiblings({
      resources: [resource('copilot', 'instructions.copilot', managed)],
      fsImpl: spyFs(calls),
    });

    assert.deepEqual(calls, [managedInstructions]);
    assert.equal(result.directoriesInspected, 1);
    assert.deepEqual(result.candidatesByTarget, {});
  });
});

test('a subdirectory of a wholesale tree that holds managed assets is structure, not a candidate', () => {
  withTempDir((dir) => {
    // Kiro's steering tree mirrors core/shared/guidance/, nested directories included. `rules/` is
    // covered on its own account as the parent of a managed resource, so reporting it from
    // `steering/` would be a false positive on every real install.
    const steering = path.join(dir, '.kiro', 'steering');
    const rules = path.join(steering, 'rules');
    const nested = path.join(steering, 'deep', 'nested');
    fs.mkdirSync(rules, { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    const top = path.join(steering, 'PRINCIPLES.md');
    const inRules = path.join(rules, 'RULE_01_SAFETY.md');
    const inNested = path.join(nested, 'DEEP.md');
    for (const file of [top, inRules, inNested]) fs.writeFileSync(file, 'managed');
    fs.writeFileSync(path.join(rules, 'RULE_99_MINE.md'), 'foreign, inside the subdirectory');

    const result = inspectSiblings({
      resources: [
        resource('kiro', 'guidance.context-layer', top),
        resource('kiro', 'guidance.context-layer', inRules),
        resource('kiro', 'guidance.context-layer', inNested),
      ],
    });

    // `rules/` and `deep/` are both skipped from `steering/`: the first directly holds a managed
    // asset, the second holds one further down.
    assert.equal(result.candidatesByTarget[top], undefined);
    assert.equal(result.candidatesByTarget[inNested], undefined);
    // The foreign file inside `rules/` is found there, because `rules/` is itself inspected.
    assert.equal(result.candidatesByTarget[inRules].length, 1);
    assert.equal(result.candidatesByTarget[inRules][0].name, 'RULE_99_MINE.md');
    assert.equal(result.directoriesInspected, 3);
  });
});

test('an unmanaged directory inside a wholesale tree is reported as a directory', () => {
  withTempDir((dir) => {
    const steering = path.join(dir, '.kiro', 'steering');
    fs.mkdirSync(path.join(steering, 'my-own-steering'), { recursive: true });
    const managed = path.join(steering, 'PRINCIPLES.md');
    fs.writeFileSync(managed, 'managed');
    fs.writeFileSync(path.join(steering, 'my-own-steering', 'extra.md'), 'loaded, not enumerated');

    const result = inspectSiblings({
      resources: [resource('kiro', 'guidance.context-layer', managed)],
    });

    const candidates = result.candidatesByTarget[managed];
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, 'my-own-steering');
    assert.equal(candidates[0].kind, 'directory');
    // One level only: the file inside it is not enumerated, and the directory is not recursed into.
    assert.equal(result.directoriesInspected, 1);
  });
});

test('every managed target sharing a wholesale directory receives that directory\'s candidates', () => {
  withTempDir((dir) => {
    const instructions = path.join(dir, '.github', 'instructions');
    fs.mkdirSync(instructions, { recursive: true });
    const first = path.join(instructions, 'RULE_01_SAFETY.instructions.md');
    const second = path.join(instructions, 'RULE_02_WORKFLOW.instructions.md');
    fs.writeFileSync(first, 'managed');
    fs.writeFileSync(second, 'managed');
    fs.writeFileSync(path.join(instructions, 'foreign.instructions.md'), 'not ours');

    const result = inspectSiblings({
      resources: [
        resource('copilot', 'instructions.copilot', first),
        resource('copilot', 'instructions.copilot', second),
      ],
    });

    assert.equal(result.candidatesByTarget[first].length, 1);
    assert.equal(result.candidatesByTarget[second].length, 1);
    assert.equal(result.candidatesByTarget[first][0].name, 'foreign.instructions.md');
    assert.equal(result.directoriesInspected, 1);
  });
});

test('a missing wholesale directory does not throw and contributes nothing', () => {
  withTempDir((dir) => {
    const missing = path.join(dir, '.github', 'instructions', 'RULE_01_SAFETY.instructions.md');
    const resources = [resource('copilot', 'instructions.copilot', missing)];

    assert.doesNotThrow(() => inspectSiblings({ resources }));

    const result = inspectSiblings({ resources });
    assert.deepEqual(result.candidatesByTarget, {});
    assert.equal(result.directoriesInspected, 0);
  });
});

test('no unmanaged candidate ever carries a currency value', () => {
  withTempDir((dir) => {
    const instructions = path.join(dir, '.github', 'instructions');
    fs.mkdirSync(instructions, { recursive: true });
    const managed = path.join(instructions, 'RULE_01_SAFETY.instructions.md');
    fs.writeFileSync(managed, 'managed');
    fs.writeFileSync(path.join(instructions, 'foreign.instructions.md'), 'not ours');
    fs.mkdirSync(path.join(instructions, 'foreign-dir'));

    const result = inspectSiblings({
      resources: [resource('copilot', 'instructions.copilot', managed)],
    });

    const candidates = result.candidatesByTarget[managed];
    assert.equal(candidates.length, 2);
    for (const candidate of candidates) {
      assert.equal(Object.prototype.hasOwnProperty.call(candidate, 'currency'), false);
      assert.deepEqual(
        Object.keys(candidate).sort(),
        ['assetId', 'harness', 'kind', 'name', 'parentDir', 'path'],
      );
    }
  });
});

/**
 * **Task F.3: the inspector withholds nothing it inspects, and returns no count of what it withheld.**
 *
 * IC-002 named a count of "unmanaged entries inspected but not individually reported", and this
 * module returned it as a literal `notReportedCount: 0`. The count is gone, because 0 was the only
 * value any input could produce — and the assertion that replaces it is the property that made it so,
 * stated directly: every entry of an inspected directory that DoFlow does not manage is reported.
 * A module that started sampling, truncating or filtering by name would fail this and would have
 * needed the count back; that is the condition under which IC-002's field earns reinstatement.
 */
test('every unmanaged entry of an inspected directory is reported, so nothing is withheld', () => {
  withTempDir((dir) => {
    const instructions = path.join(dir, '.github', 'instructions');
    fs.mkdirSync(instructions, { recursive: true });
    const managed = path.join(instructions, 'RULE_01_SAFETY.instructions.md');
    fs.writeFileSync(managed, 'managed');
    for (const name of ['a.md', 'b.md', 'c.txt', 'd.json', 'e']) {
      fs.writeFileSync(path.join(instructions, name), 'not ours');
    }
    fs.mkdirSync(path.join(instructions, 'foreign-dir'));

    const result = inspectSiblings({
      resources: [resource('copilot', 'instructions.copilot', managed)],
    });

    // Read the directory independently and subtract the managed basename: what remains is what the
    // inspector must have reported, entry for entry.
    const expected = fs.readdirSync(instructions)
      .filter((name) => name !== path.basename(managed))
      .sort();
    assert.deepEqual(
      result.candidatesByTarget[managed].map((candidate) => candidate.name).sort(), expected,
      'every unmanaged entry in an inspected directory is reported individually — there is no '
      + 'inspected-but-withheld population for a count to describe'
    );
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'notReportedCount'), false,
      'the withheld count is gone: 0 was its only reachable value, and reporting it beside eight '
      + 'reported siblings read as a claim that eight more had been held back (IC-002 amended, F.3)');
  });
});

test('an empty or malformed resources list produces an empty, safe result', () => {
  const empty = inspectSiblings({ resources: [] });
  assert.deepEqual(empty.candidatesByTarget, {});
  assert.equal(empty.directoriesInspected, 0);

  const malformed = inspectSiblings({ resources: [{}, { target: '' }, null, undefined] });
  assert.deepEqual(malformed.candidatesByTarget, {});
  assert.equal(malformed.directoriesInspected, 0);

  const noArguments = inspectSiblings();
  assert.deepEqual(noArguments.candidatesByTarget, {});
  assert.equal(noArguments.directoriesInspected, 0);
});

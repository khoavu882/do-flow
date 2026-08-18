'use strict';

// G11 — scaffold containment (feature 008, design C16 / FR-023, plan task C.9).
//
// `/do-execute-plan --scaffold` exists to answer "what shape does my plan imply, before any of it
// reaches my code?". Three properties make that answer worth having, and all three fail silently:
//
//   1. **It never touches the source tree.** A generator that writes one file into `src/` has
//      stopped being a review artifact and become an unreviewed commit. Nothing at runtime notices;
//      the user notices at `git status`, after the fact.
//   2. **It emits signatures, not logic.** Generated logic nobody verified is the false confidence
//      this whole feature exists to remove. A body that quietly grows an `if` reads as working code.
//   3. **Re-running produces no diff.** The scaffold is reviewed as a git diff. A timestamp, an
//      unstable sort or a run-dependent count in `MANIFEST.md` makes every second run noise, and
//      the artifact stops being reviewable within a week of shipping.
//
// A fourth property is guarded here because it belongs to the same defect family as the other
// three: a scaffold built from an artifact the generator could not parse must SAY so and exit
// non-zero, never degrade into a thin tree that reads as complete. Five instances of that family
// have already landed in this feature — a check with no command reporting PASS, an empty contract
// reporting PASS over zero evidence, readiness grading the wrong task on a missing id.
//
// Everything below runs against temporary directories. The one place real content is used, the
// repository's own feature artifacts are COPIED into a temp dir first — running the generator
// against `agent-docs/` in-place would make the test suite itself write to the repository, which is
// the failure this guard exists to catch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO } = require('./_shared');
const {
  generateScaffold, ARTIFACTS, FINGERPRINT_RE, SCAFFOLD_DIR_NAME, MANIFEST_NAME, STUB_SUFFIX, STATUS, EXIT,
} = require('../../src/runtime/scaffold');

// ---------------------------------------------------------------------------------------------

/**
 * A capability-limited `fs`: the four read calls the generator legitimately needs, plus recorded
 * `mkdirSync` and `writeFileSync`. Anything else — `rmSync`, `renameSync`, `appendFileSync`, a
 * write stream — is simply absent, so an attempt to reach for it throws rather than being caught by
 * an allow-list this guard would then have to keep current.
 */
function jailedFs(recorded) {
  return {
    readFileSync: fs.readFileSync,
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync,
    mkdirSync: (target, opts) => { recorded.push(path.resolve(target)); return fs.mkdirSync(target, opts); },
    writeFileSync: (target, data, opts) => { recorded.push(path.resolve(target)); return fs.writeFileSync(target, data, opts); },
  };
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `doflow-scaffold-${label}-`));
}

/** Every file under `dir`, as `relative path → bytes`. */
function snapshot(dir) {
  const out = new Map();
  (function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.set(rel, fs.readFileSync(path.join(current, entry.name)));
    }
  }(dir, ''));
  return out;
}

/** A minimal but complete feature: one FR, one component with a declared shape, three tasks. */
function fixtureFeature(dir, { omit = [] } = {}) {
  const featureDir = path.join(dir, '001-fixture-feature');
  fs.mkdirSync(featureDir, { recursive: true });

  const artifacts = {
    'requirement.md': [
      '# Requirement: Fixture', '',
      '## 3. Functional Requirements', '',
      '| ID | Requirement | Stories | Priority | Status |',
      '|---|---|---|---|---|',
      '| FR-001 | The widget resolves a name to an id | US1 | P1 | Live |', '',
      '## 6. Acceptance Criteria', '',
      '- [ ] A known name resolves to its id (FR-001).',
      '- [ ] An unknown name is reported rather than guessed (FR-001).', '',
    ].join('\n'),
    'design.md': [
      '# Design: Fixture', '',
      '## 3. Components & Boundaries', '',
      '| ID | Component | Kind | Serves | Status |',
      '|---|---|---|---|---|',
      '| C1 | Name resolver | service | FR-001 | Live |', '',
      '## 4. API / Interface Contracts', '',
      '### 4.1 Resolver contract (C1)', '',
      '```text', 'resolve(name) -> id | null', '```', '',
    ].join('\n'),
    'plan.md': [
      '# Implementation Plan: Fixture', '',
      '## 8. Tasks', '',
      '### Phase A — build', '',
      '- [ ] A.1 [US1] Build the resolver — owner: core-implementer; files: `src/resolver.js`',
      '- [ ] A.2 [US1] Document it — owner: research-writer; files: `docs/resolver.md`',
      '- [ ] A.3 [US1] Wire the vendor lookup — owner: core-implementer; files: `src/vendor.js`; depends-on: `vendor/lookup-api`; external-contract: `lookup-api.md`',
      '',
      '### Completion criteria', '',
      '- [ ] All tasks checked', '',
    ].join('\n'),
  };

  // A package.json makes command-detect resolve JavaScript, which is what the test stubs need.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
  for (const [name, body] of Object.entries(artifacts)) {
    if (omit.includes(name)) continue;
    fs.writeFileSync(path.join(featureDir, name), body);
  }
  return { featureDir, repoRoot: dir };
}

/** Body of a generated file — everything after the fingerprint line. */
function bodyOf(text) {
  const match = text.match(FINGERPRINT_RE);
  if (!match) return null;
  return text.slice(text.indexOf('\n', text.indexOf(match[0])) + 1);
}

/** Body with every comment line removed, which is what "is there logic in here" has to look at. */
function codeOf(text) {
  return (bodyOf(text) ?? '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('#') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('"""');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------------------------

test('G11: a scaffold run mutates nothing outside the feature directory', () => {
  const root = tempDir('containment');
  const { featureDir, repoRoot } = fixtureFeature(root);
  const outsideBefore = snapshot(repoRoot);

  const recorded = [];
  const result = generateScaffold({ featureDir, repoRoot, fsImpl: jailedFs(recorded) });

  const scaffoldDir = path.join(featureDir, SCAFFOLD_DIR_NAME);
  const escapes = recorded.filter((p) => p !== scaffoldDir && !p.startsWith(scaffoldDir + path.sep));
  assert.deepEqual(escapes, [],
    `the generator mutated paths outside ${scaffoldDir}; the whole point of the scaffold is that it never does:\n  ${escapes.join('\n  ')}`);
  assert.ok(recorded.length > 0, 'the run recorded no writes at all, so containment was never exercised');

  // Belt and braces: the recording proves intent, the byte comparison proves outcome.
  const after = snapshot(repoRoot);
  const changed = [...after.keys()]
    .filter((rel) => !rel.startsWith(path.join('001-fixture-feature', SCAFFOLD_DIR_NAME)))
    .filter((rel) => !outsideBefore.has(rel) || !outsideBefore.get(rel).equals(after.get(rel)));
  assert.deepEqual(changed, [], `files outside the scaffold directory changed:\n  ${changed.join('\n  ')}`);
  assert.equal(result.scaffoldDir, scaffoldDir);
});

test('G11: the same artifacts generate a byte-identical scaffold on every run', () => {
  const root = tempDir('idempotent');
  const { featureDir, repoRoot } = fixtureFeature(root);
  const scaffoldDir = path.join(featureDir, SCAFFOLD_DIR_NAME);

  const first = generateScaffold({ featureDir, repoRoot });
  const firstBytes = snapshot(scaffoldDir);
  const second = generateScaffold({ featureDir, repoRoot });
  const secondBytes = snapshot(scaffoldDir);

  assert.deepEqual([...secondBytes.keys()], [...firstBytes.keys()], 're-running changed the file set');
  const drifted = [...firstBytes.keys()].filter((rel) => !firstBytes.get(rel).equals(secondBytes.get(rel)));
  assert.deepEqual(drifted, [],
    `re-running rewrote these files differently — a timestamp, an unstable sort or a run-dependent count leaked into the output:\n  ${drifted.join('\n  ')}`);

  assert.deepEqual(second.written, [], 'the second run wrote files even though nothing changed');
  assert.equal(second.unchanged.length, first.written.length, 'every file the first run wrote should be reported unchanged by the second');
});

test('G11: emitted files carry signatures and a single not-implemented signal, never logic', () => {
  const root = tempDir('signatures');
  const { featureDir, repoRoot } = fixtureFeature(root);
  generateScaffold({ featureDir, repoRoot });

  // Control flow is the essence of "logic". A scaffold body has no reason to branch or loop, so a
  // single occurrence of any of these means generated behaviour has crept in.
  const LOGIC = /(^|[^A-Za-z])(if|else|for|while|switch|case|catch|try|await|return\s+[^;\n]*\?)([^A-Za-z]|$)/;
  // A src/ frame's declaration is a function or class; a test/ stub's declaration is a test case.
  // Requiring the same token of both would either miss an empty test file or reject a valid one.
  const DECLARATION = /(^|\n)\s*(function|class|def |pub fn|func |export function)/;
  const TEST_CASE = /(^|\n)\s*(test\(|#\[test\]|def test_|func Test)/;
  const NOT_IMPLEMENTED = /(throw new Error|raise NotImplementedError|unimplemented!|errors\.New|t\.Fatal)/;

  const scaffoldDir = path.join(featureDir, SCAFFOLD_DIR_NAME);
  const files = [...snapshot(scaffoldDir).keys()].filter((rel) => rel !== MANIFEST_NAME);
  assert.ok(files.length > 0, 'no files were generated, so this assertion proves nothing');

  const findings = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(scaffoldDir, rel), 'utf8');
    const code = codeOf(text);
    const wanted = rel.startsWith(`test${path.sep}`) ? TEST_CASE : DECLARATION;
    if (LOGIC.test(code)) findings.push(`${rel}: contains control flow — that is implementation, not a signature`);
    if (!wanted.test(`\n${code}`)) findings.push(`${rel}: declares neither a signature nor a test case`);
    if (!NOT_IMPLEMENTED.test(code)) findings.push(`${rel}: has no explicit not-implemented signal, so its body reads as complete`);
  }
  assert.deepEqual(findings, [], `generated content is not signatures-only:\n  ${findings.join('\n  ')}`);
});

test('G11: nothing emitted can be picked up by the host project\'s toolchain', () => {
  const root = tempDir('inert');
  const { featureDir, repoRoot } = fixtureFeature(root);
  generateScaffold({ featureDir, repoRoot });

  // `node --test` collects any `.js` under a directory named `test`; pytest and `go test ./...`
  // sweep just as broadly. A scaffold whose stubs join the host project's test run has changed how
  // that project behaves, which is the same failure as writing into its source tree wearing a
  // different hat — and it is how this guard earned its existence.
  const scaffoldDir = path.join(featureDir, SCAFFOLD_DIR_NAME);
  const collectable = [...snapshot(scaffoldDir).keys()].filter((rel) => rel !== MANIFEST_NAME).filter(
    (rel) => /\.(js|mjs|cjs|ts|py|go|rs)$/.test(rel),
  );
  assert.deepEqual(collectable, [],
    `these files would be compiled or collected by the host project's own toolchain:\n  ${collectable.join('\n  ')}`);

  for (const rel of [...snapshot(scaffoldDir).keys()].filter((r) => r !== MANIFEST_NAME)) {
    assert.ok(rel.endsWith(STUB_SUFFIX), `${rel} does not carry the ${STUB_SUFFIX} suffix that keeps it inert`);
  }
});

test('G11: every generated file names the requirement, component or task it derives from', () => {
  const root = tempDir('traceability');
  const { featureDir, repoRoot } = fixtureFeature(root);
  generateScaffold({ featureDir, repoRoot });

  const scaffoldDir = path.join(featureDir, SCAFFOLD_DIR_NAME);
  const untraceable = [];
  for (const rel of snapshot(scaffoldDir).keys()) {
    const text = fs.readFileSync(path.join(scaffoldDir, rel), 'utf8');
    if (!FINGERPRINT_RE.test(text)) { untraceable.push(`${rel}: no fingerprint, so human edits to it cannot be detected`); continue; }
    if (rel === MANIFEST_NAME) continue;
    const header = text.slice(0, text.indexOf(FINGERPRINT_RE.exec(text)[0]));
    if (!/(requirement:|component:|task:)/.test(header)) {
      untraceable.push(`${rel}: header names no FR, component or task`);
    }
  }
  assert.deepEqual(untraceable, [], `scaffold files must be traceable to what they came from:\n  ${untraceable.join('\n  ')}`);
});

test('G11: a hand-edited scaffold file is reported and left alone', () => {
  const root = tempDir('humanedit');
  const { featureDir, repoRoot } = fixtureFeature(root);
  const scaffoldDir = path.join(featureDir, SCAFFOLD_DIR_NAME);
  generateScaffold({ featureDir, repoRoot });

  const edited = path.join(scaffoldDir, 'src', 'src', `resolver.js${STUB_SUFFIX}`);
  const mine = `${fs.readFileSync(edited, 'utf8')}\n// reviewer: this signature is wrong\n`;
  fs.writeFileSync(edited, mine);

  const result = generateScaffold({ featureDir, repoRoot });
  assert.equal(fs.readFileSync(edited, 'utf8'), mine, 'the generator overwrote a hand-edited file');
  assert.ok(result.preserved.some((p) => p.path === path.join('src', 'src', `resolver.js${STUB_SUFFIX}`)),
    `a preserved file must be reported, not silently kept: ${JSON.stringify(result.preserved)}`);
  assert.match(fs.readFileSync(path.join(scaffoldDir, MANIFEST_NAME), 'utf8'), /Preserved/);

  // A file with no fingerprint at all is hand-authored too, and fails closed the same way.
  const foreign = path.join(scaffoldDir, 'src', 'src', `vendor.js${STUB_SUFFIX}`);
  fs.writeFileSync(foreign, 'exports.mine = 1;\n');
  const second = generateScaffold({ featureDir, repoRoot });
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'exports.mine = 1;\n');
  assert.ok(second.preserved.some((p) => p.path === path.join('src', 'src', `vendor.js${STUB_SUFFIX}`)),
    'a file with no fingerprint must be treated as hand-authored, not overwritten');
});

test('G11: an artifact the generator cannot parse blocks the run instead of thinning it', () => {
  for (const missing of ARTIFACTS) {
    const root = tempDir(`blocked-${missing.replace('.md', '')}`);
    const { featureDir, repoRoot } = fixtureFeature(root, { omit: [missing] });
    const result = generateScaffold({ featureDir, repoRoot });

    assert.notEqual(result.exitCode, EXIT.OK, `a run missing ${missing} exited 0`);
    assert.ok(result.notEvaluated.some((n) => n.what.startsWith(missing)),
      `a run missing ${missing} must name it under "not evaluated", got ${JSON.stringify(result.notEvaluated)}`);

    const manifest = fs.readFileSync(path.join(featureDir, SCAFFOLD_DIR_NAME, MANIFEST_NAME), 'utf8');
    assert.match(manifest, new RegExp(missing.replace('.', '\\.')),
      `${MANIFEST_NAME} must name the artifact it could not read`);
    assert.match(manifest, /## Not evaluated/);
  }

  // plan.md present but with no task list: parseable file, unusable content. Same posture.
  const root = tempDir('blocked-empty-plan');
  const { featureDir, repoRoot } = fixtureFeature(root);
  fs.writeFileSync(path.join(featureDir, 'plan.md'), '# Implementation Plan\n\n## 8. Tasks\n\nNone yet.\n');
  const result = generateScaffold({ featureDir, repoRoot });
  assert.equal(result.status, STATUS.BLOCKED, 'a plan with no tasks must block, not emit an empty scaffold that reads as complete');
  assert.equal(result.exitCode, EXIT.FINDING);
  assert.deepEqual(result.written.filter((w) => w !== MANIFEST_NAME), [],
    'a blocked run must not emit source files alongside its own failure report');
});

test('G11: what was skipped is reported as prominently as what was produced', () => {
  const root = tempDir('skips');
  const { featureDir, repoRoot } = fixtureFeature(root);
  const result = generateScaffold({ featureDir, repoRoot });

  // docs/resolver.md is markdown: correctly skipped, and the manifest has to say so rather than
  // leaving a reader to notice the absence.
  assert.ok(result.skipped.some((s) => s.item.includes('docs/resolver.md')),
    `a non-source file must be reported as skipped: ${JSON.stringify(result.skipped)}`);
  const manifest = fs.readFileSync(path.join(featureDir, SCAFFOLD_DIR_NAME, MANIFEST_NAME), 'utf8');
  for (const heading of ['## Generated', '## Skipped', '## Not evaluated', '## External dependencies']) {
    assert.ok(manifest.includes(heading), `${MANIFEST_NAME} is missing the "${heading}" section`);
  }
  assert.match(manifest, /vendor\/lookup-api/, 'a `depends-on:` value with no owning task must be routed and named');

  // `external-contract:` marks the one case the generator cannot help with — a dependency with no
  // local repo to scan. Parsing it is what lets the manifest say "there is a document for this"
  // rather than routing it to a walk-up that would find nothing.
  const routed = result.externalDependencies.find((d) => d.dependency === 'vendor/lookup-api');
  assert.ok(routed, 'the dependency was not partitioned at all');
  assert.match(routed.disposition, /lookup-api\.md/,
    `an external-contract: target must reach the disposition, got: ${routed.disposition}`);
  assert.match(routed.disposition, /no local repo to scan/);
});

test('G11: real feature artifacts generate a contained, idempotent scaffold', () => {
  const doflowDocs = path.join(REPO, 'agent-docs', 'doflow');
  const features = fs.existsSync(doflowDocs)
    ? fs.readdirSync(doflowDocs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(doflowDocs, e.name))
      .filter((dir) => ARTIFACTS.every((a) => fs.existsSync(path.join(dir, a))))
    : [];
  assert.ok(features.length > 0, 'no feature directory in agent-docs/doflow carries all three artifacts — this guard would prove nothing');

  for (const source of features) {
    // Copied, never generated in place: a test suite that writes into agent-docs/ is itself the
    // uncontained-write failure this guard is about.
    const root = tempDir('real');
    const featureDir = path.join(root, path.basename(source));
    fs.mkdirSync(featureDir, { recursive: true });
    for (const artifact of ARTIFACTS) fs.copyFileSync(path.join(source, artifact), path.join(featureDir, artifact));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));

    const recorded = [];
    const first = generateScaffold({ featureDir, repoRoot: root, fsImpl: jailedFs(recorded) });
    const scaffoldDir = path.join(featureDir, SCAFFOLD_DIR_NAME);
    const escapes = recorded.filter((p) => p !== scaffoldDir && !p.startsWith(scaffoldDir + path.sep));
    assert.deepEqual(escapes, [], `${path.basename(source)}: writes escaped the scaffold directory:\n  ${escapes.join('\n  ')}`);

    const before = snapshot(scaffoldDir);
    generateScaffold({ featureDir, repoRoot: root });
    const after = snapshot(scaffoldDir);
    const drifted = [...before.keys()].filter((rel) => !before.get(rel)?.equals(after.get(rel)));
    assert.deepEqual(drifted, [], `${path.basename(source)}: re-running produced a diff:\n  ${drifted.join('\n  ')}`);

    assert.ok(first.status !== STATUS.USAGE, `${path.basename(source)}: ${first.summary}`);
  }
});

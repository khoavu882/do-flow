'use strict';

/**
 * Scaffold generator — turns `requirement.md`, `design.md` and `plan.md` into a reviewable code
 * scaffold under the active feature directory (plan task C.8, design component C16, FR-023).
 *
 * The question it answers is "what shape does my plan imply, before any of it reaches my code?".
 * That is why nothing here ever writes outside `agent-docs/doflow/<slug>/scaffold/`: the output is
 * something to read and argue with, not something to run. Promoting any of it into the source tree
 * stays a deliberate human act, or `/do-execute-plan`'s ordinary job.
 *
 * Four properties are load-bearing, and each one is why some piece of this module looks the way it
 * does:
 *
 *   1. **No implementation logic.** Every emitted body is one pinned "not implemented" signal, in
 *      the same grammar `core/shared/skills/do-execute-plan/references/scaffold.md` pins for
 *      contract frames. Generated logic nobody has verified is exactly the false confidence this
 *      feature exists to remove.
 *   2. **No invented interfaces.** When the artifacts declare a shape, it is carried through
 *      verbatim as a quoted comment. When they do not, the file gets one clearly-labelled
 *      placeholder signature and the gap is named in `MANIFEST.md` — never a plausible-looking
 *      API nobody wrote down.
 *   3. **Byte-identical re-runs.** Nothing generated carries a timestamp, and `MANIFEST.md`
 *      reports each file's *state* (generated / preserved / skipped) rather than whether this
 *      particular run happened to touch it. A "generated at" line would make every second run a
 *      diff, and idempotency is the property that makes reviewing the scaffold in git worthwhile.
 *   4. **Human edits survive.** Every file carries a fingerprint of its own body. A body that no
 *      longer hashes to its header is human-authored from this module's point of view and is never
 *      rewritten — including `MANIFEST.md` itself, which is why there is no "except the report"
 *      carve-out below.
 *
 * The failure posture is the one this feature keeps re-learning the hard way — a verification check
 * with no command reporting PASS, an empty contract reporting PASS over zero evidence, readiness
 * grading the wrong task on a missing id. **A gate must never answer confidently about something it
 * did not evaluate.** So an artifact that could not be read or parsed does not degrade into a thin
 * scaffold that reads as complete: it is named in `MANIFEST.md` and the result carries a non-zero
 * exit code. What was skipped is reported as prominently as what was produced.
 *
 * Scope boundary against the external-dependency case: this module generates the *in-scope* side —
 * the components and tasks this plan owns. A `depends-on:` value with no owning task is partitioned
 * here and reported, but its contract frame is produced by the walk-up algorithm in
 * `references/scaffold.md`, which the model executes. That algorithm handles nested `.git`
 * boundaries, non-local vendors and `external-contract:` targets; reimplementing its partition-and-walk
 * here would give the framework two implementations of one behaviour, which is the thing FR-022
 * guards against.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectCommands } = require('./command-detect');

/** Output root, relative to the feature directory. Fixed by design §4.5. */
const SCAFFOLD_DIR_NAME = 'scaffold';

/** The run report. Regenerated like any other file, and protected like any other file. */
const MANIFEST_NAME = 'MANIFEST.md';

/**
 * Appended to every emitted file except the manifest.
 *
 * Not cosmetic. `node --test` collects *any* `.js` under a directory named `test`, and pytest and
 * `go test ./...` sweep just as broadly — so a scaffold that emitted `test/FR-001.test.js` would
 * quietly join the host project's own test run and fail it. That was observed, not theorised: the
 * first version of this module turned this repository's green suite red the moment it generated
 * against its own feature directory.
 *
 * One suffix on everything rather than a per-toolchain exclusion list, because the invariant worth
 * having is stronger than "no runner we currently know about picks this up": nothing in the
 * scaffold is loadable by any toolchain until a human deliberately drops the suffix. The mirrored
 * layout stays legible either way — `src/runtime/scaffold.js.stub` reads as exactly what it is.
 *
 * Part 2's `contracts/` frames deliberately do not carry it: `default/` exists to be compiled
 * against, and its tree contains no directory a test runner sweeps.
 */
const STUB_SUFFIX = '.stub';

/** The three chain artifacts, in the order a reader meets them. All three are required: a scaffold
 * missing one of them is a scaffold with no traceability, no shape, or no file list. */
const ARTIFACTS = Object.freeze(['requirement.md', 'design.md', 'plan.md']);

/** Marker naming the hash of everything below it. Present in every generated file so edit
 * detection needs no side ledger that could itself drift from the tree it describes. */
const FINGERPRINT_MARKER = 'doflow-scaffold-fingerprint';
const FINGERPRINT_RE = new RegExp(`${FINGERPRINT_MARKER} sha256:([0-9a-f]{64})`);

/**
 * Uniform exit codes, matching design §4.2's contract for every DoFlow verb.
 * `1` is "a finding the caller must act on" — which includes an unparseable artifact, so a caller
 * that only checks for a crash still sees the difference between a full and a partial scaffold.
 */
const EXIT = Object.freeze({ OK: 0, FINDING: 1, USAGE: 2 });

const STATUS = Object.freeze({
  COMPLETE: 'COMPLETE',
  INCOMPLETE: 'INCOMPLETE',
  BLOCKED: 'BLOCKED',
  USAGE: 'USAGE',
});

// ---------------------------------------------------------------------------------------------
// Language selection
// ---------------------------------------------------------------------------------------------

/**
 * Per-file language comes from the file's own extension, because `plan.md` already states it:
 * `files: src/runtime/scaffold.js` is not ambiguous about being JavaScript, and asking a
 * repository-wide detector would be a worse answer than the one the plan wrote down.
 *
 * Repository-wide detection is still needed for the test stubs, which derive from acceptance
 * criteria and therefore have no path to read an extension from. That question — "what toolchain
 * is this repository" — is `command-detect.js`'s, so it is asked there rather than answered a
 * second time here. See `repoLanguage()` for the one place its output is interpreted.
 */
const EXTENSION_LANGUAGE = Object.freeze({
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
});

/**
 * Extensions that are content, not code. A plan task naming one of these is not a gap in this
 * generator — there is no signature to emit for a markdown file — so these skip benignly and never
 * push the run to a non-zero exit.
 */
const PROSE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.rst',
  '.yaml', '.yml', '.json', '.jsonc', '.toml', '.ini', '.cfg', '.conf', '.env', '.lock',
  '.html', '.css', '.scss', '.svg', '.png', '.jpg', '.gif', '.csv',
]);

/**
 * Source languages the *prose* algorithm in `references/scaffold.md` covers through its
 * Default-Implementation Grammar table, but this module has no emitter for. Named explicitly so a
 * plan that touches one produces "no emitter for Java", not silence — the gap is real and belongs
 * in the manifest, not in a reader's assumptions.
 */
const UNEMITTED_SOURCE_EXTENSIONS = Object.freeze({
  '.java': { name: 'Java', inProseGrammar: true },
  '.kt': { name: 'Kotlin', inProseGrammar: true },
  '.kts': { name: 'Kotlin', inProseGrammar: true },
  '.cs': { name: 'C#', inProseGrammar: true },
  '.swift': { name: 'Swift', inProseGrammar: true },
  '.m': { name: 'Objective-C', inProseGrammar: true },
  '.h': { name: 'Objective-C or C header', inProseGrammar: false },
  '.sh': { name: 'Shell', inProseGrammar: false },
  '.bash': { name: 'Shell', inProseGrammar: false },
  '.rb': { name: 'Ruby', inProseGrammar: false },
  '.php': { name: 'PHP', inProseGrammar: false },
  '.c': { name: 'C', inProseGrammar: false },
  '.cc': { name: 'C++', inProseGrammar: false },
  '.cpp': { name: 'C++', inProseGrammar: false },
  '.hpp': { name: 'C++', inProseGrammar: false },
});

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readIfPresent(file, fsImpl) {
  try {
    return fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return null;
    throw error;
  }
}

function isDirectory(file, fsImpl) {
  try {
    return fsImpl.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Splits an identifier-ish path segment into lowercase words, so every language can re-case it
 * to its own convention from one parse. */
function words(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

const camel = (parts) => parts.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('') || 'scaffold';
const pascal = (parts) => parts.map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Scaffold';
const snake = (parts) => parts.join('_') || 'scaffold';

/** Table cells are pipe-delimited; an unescaped pipe in a task description would shear the row. */
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

/** Sorts by a string key without depending on locale collation, which varies by platform and would
 * make "re-running produces no diff" false across machines. */
const byKey = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Artifact parsing
// ---------------------------------------------------------------------------------------------

/** Returns the body of the first `## …<title>…` section, or null when there is none. */
function section(text, titlePattern) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]) && titlePattern.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** Splits a markdown table row into trimmed cells, or null when the line is not a row. */
function row(line) {
  if (!/^\s*\|/.test(line)) return null;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (cells.every((c) => /^:?-{3,}:?$/.test(c))) return null;   // the header separator
  return cells;
}

/** Markdown wraps long list items; a criterion or task split over three lines is still one item. */
function joinWrapped(body) {
  const out = [];
  for (const line of body.split('\n')) {
    if (/^\s+\S/.test(line) && out.length && out[out.length - 1].trim() !== '') {
      out[out.length - 1] += ` ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * `requirement.md` → requirement summaries (for traceability headers) and acceptance criteria
 * (for test stubs).
 */
function parseRequirement(text) {
  const gaps = [];
  const requirements = new Map();

  const frBody = section(text, /Functional Requirements/i) ?? '';
  const nfrBody = section(text, /Non-Functional Requirements/i) ?? '';
  for (const body of [frBody, nfrBody]) {
    for (const line of body.split('\n')) {
      const cells = row(line);
      if (!cells || cells.length < 2) continue;
      const id = cells[0].replace(/`/g, '').trim();
      if (!/^N?FR-\d+$/.test(id)) continue;
      const stories = (cells[2] || '').match(/US\d+/g) || [];
      requirements.set(id, { id, summary: cells[1], stories });
    }
  }
  if (requirements.size === 0) {
    gaps.push({ artifact: 'requirement.md', what: 'requirement index', why: 'no `| FR-nnn | … |` table row found under a Functional Requirements heading' });
  }

  const criteria = [];
  const acceptanceBody = section(text, /Acceptance Criteria/i);
  if (acceptanceBody === null) {
    gaps.push({ artifact: 'requirement.md', what: 'acceptance criteria', why: 'no "Acceptance Criteria" section — no test stubs can be derived' });
  } else {
    for (const line of joinWrapped(acceptanceBody)) {
      const match = line.match(/^-\s*\[[ xX]\]\s*(.+?)\s*$/);
      if (!match) continue;
      const statement = match[1];
      const ids = [...new Set(statement.match(/N?FR-\d+/g) || [])].sort();
      criteria.push({ statement, requirements: ids });
    }
    if (criteria.length === 0) {
      gaps.push({ artifact: 'requirement.md', what: 'acceptance criteria', why: 'the Acceptance Criteria section holds no `- [ ]` items — no test stubs can be derived' });
    }
  }

  return { requirements, criteria, gaps };
}

/**
 * `design.md` → the component index (traceability) and whatever §4 declares as an interface
 * (carried through verbatim rather than paraphrased).
 */
function parseDesign(text) {
  const gaps = [];
  const components = new Map();

  const body = section(text, /Components\s*(&|and)\s*Boundaries/i) ?? '';
  for (const line of body.split('\n')) {
    const cells = row(line);
    if (!cells || cells.length < 4) continue;
    const id = cells[0].replace(/`/g, '').trim();
    if (!/^C\d+$/.test(id)) continue;
    const serves = [...new Set(cells[3].match(/N?FR-\d+/g) || [])].sort();
    components.set(id, { id, name: cells[1].replace(/`/g, ''), kind: cells[2], serves, declared: [] });
  }
  if (components.size === 0) {
    gaps.push({ artifact: 'design.md', what: 'component index', why: 'no `| Cn | … |` table row found under a "Components & Boundaries" heading' });
  }

  // §4's subsections name their component in the heading — "### 4.5 Scaffold output contract (C16)".
  // That attribution is what lets a declared interface reach the file that implements it, instead
  // of being restated from memory somewhere downstream.
  const contractBody = section(text, /API\s*\/?\s*Interface Contracts|Interface Contracts/i);
  if (contractBody === null) {
    gaps.push({ artifact: 'design.md', what: 'interface contracts', why: 'no "API / Interface Contracts" section — every emitted file falls back to a placeholder signature' });
  } else {
    const lines = contractBody.split('\n');
    let heading = null;
    let fence = null;
    let buffer = [];
    for (const line of lines) {
      const headingMatch = line.match(/^###\s+(.*)$/);
      if (headingMatch && fence === null) { heading = headingMatch[1].trim(); continue; }
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fenceMatch && fence === null) { fence = fenceMatch[1]; buffer = []; continue; }
      if (fence !== null && line.trim().startsWith(fence)) {
        const owners = [...new Set(heading?.match(/C\d+/g) || [])];
        for (const owner of owners) {
          if (components.has(owner)) components.get(owner).declared.push({ heading, block: buffer.join('\n') });
        }
        fence = null;
        buffer = [];
        continue;
      }
      if (fence !== null) buffer.push(line);
    }
  }

  return { components, gaps };
}

/**
 * Metadata keys a task line may carry after its description, per `plan-template.md`.
 *
 * `external-contract:` names the case this generator cannot help with: a dependency with no local
 * repo to scan — a vendor API, a SaaS integration, a service in another org — whose contract exists
 * only as a document. The doc is an *input* to the scaffold, never part of it.
 */
const TASK_KEYS = ['owner', 'files', 'depends-on', 'external-contract'];

/** `plan.md` → the task list, which is where the intended file layout actually comes from. */
function parsePlan(text) {
  const gaps = [];
  const tasks = [];

  // Anchored on the whole heading: `### Task Summary` is orientation, not the task list, and a
  // loose match would read the summary table's rows as tasks.
  const body = section(text, /^##\s+(?:\d+\.\s*)?Tasks\s*$/i);
  if (body === null) {
    gaps.push({ artifact: 'plan.md', what: 'task list', why: 'no "Tasks" section' });
    return { tasks, gaps };
  }

  for (const line of joinWrapped(body)) {
    // The Constitution Check and Completion Criteria sections also use `- [ ]`, so the phase-task
    // id is required rather than optional: a checklist item with no id is not a task.
    const match = line.match(/^-\s*\[([ xX])\]\s+([A-Za-z]+\.\d+)\s+(.*)$/);
    if (!match) continue;
    const [, mark, id, rest] = match;

    const keyPattern = new RegExp(`(?:^|[\\s—-])(${TASK_KEYS.join('|')}):\\s`);
    const keyAt = rest.search(keyPattern);
    const head = (keyAt === -1 ? rest : rest.slice(0, keyAt)).replace(/[\s—-]+$/, '').trim();
    const meta = keyAt === -1 ? '' : rest.slice(keyAt).replace(/^[\s—-]+/, '');

    const stories = [...new Set(head.match(/US\d+/g) || [])].sort();
    const description = head.replace(/\[P\]/g, '').replace(/\[US\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();

    const fields = {};
    for (const chunk of meta.split(';')) {
      const fieldMatch = chunk.match(/^\s*([a-z-]+):\s*(.*)$/);
      if (!fieldMatch || !TASK_KEYS.includes(fieldMatch[1])) continue;
      fields[fieldMatch[1]] = fieldMatch[2].trim();
    }

    const list = (value) => (value ? value.split(',').map((v) => v.replace(/`/g, '').trim()).filter(Boolean) : []);

    tasks.push({
      id,
      done: mark.toLowerCase() === 'x',
      phase: id.split('.')[0],
      description,
      stories,
      owner: fields.owner || null,
      files: list(fields.files),
      dependsOn: list(fields['depends-on']),
      externalContract: fields['external-contract'] || null,
    });
  }

  if (tasks.length === 0) {
    gaps.push({ artifact: 'plan.md', what: 'task list', why: 'the Tasks section holds no `- [ ] <phase>.<n> …` items — there is no intended file layout to mirror' });
  }
  return { tasks, gaps };
}

// ---------------------------------------------------------------------------------------------
// Language emitters
// ---------------------------------------------------------------------------------------------

/**
 * One entry per language this module can emit. Each `module` and `test` body is a signature plus a
 * single "not implemented" signal drawn from the Default-Implementation Grammar pinned in
 * `references/scaffold.md` — the same table the external-dependency case uses, so the two halves of
 * that document agree on what an unimplemented body looks like.
 */
const EMITTERS = Object.freeze({
  javascript: {
    line: (t) => (t ? `// ${t}` : '//'),
    module: ({ symbol, message }) => [
      '/**',
      ' * Placeholder signature — replace with the real surface before implementing.',
      ' * @returns {never}',
      ' */',
      `function ${symbol}() {`,
      `  throw new Error(${JSON.stringify(message)});`,
      '}',
      '',
      `module.exports = { ${symbol} };`,
    ].join('\n'),
    testName: (id) => `${id}.test.js`,
    test: ({ id, cases, message }) => [
      "const { test } = require('node:test');",
      '',
      ...cases.map(({ statement }) => [
        `test(${JSON.stringify(`${id} — ${statement}`)}, () => {`,
        `  throw new Error(${JSON.stringify(message)});`,
        '});',
        '',
      ].join('\n')),
    ].join('\n').trimEnd(),
  },

  typescript: {
    line: (t) => (t ? `// ${t}` : '//'),
    module: ({ symbol, message }) => [
      '/** Placeholder signature — replace with the real surface before implementing. */',
      `export function ${symbol}(): never {`,
      `  throw new Error(${JSON.stringify(message)});`,
      '}',
    ].join('\n'),
    testName: (id) => `${id}.test.ts`,
    test: ({ id, cases, message }) => [
      "import { test } from 'node:test';",
      '',
      ...cases.map(({ statement }) => [
        `test(${JSON.stringify(`${id} — ${statement}`)}, (): void => {`,
        `  throw new Error(${JSON.stringify(message)});`,
        '});',
        '',
      ].join('\n')),
    ].join('\n').trimEnd(),
  },

  python: {
    line: (t) => (t ? `# ${t}` : '#'),
    module: ({ symbol, message }) => [
      `def ${symbol}() -> None:`,
      '    """Placeholder signature — replace with the real surface before implementing."""',
      `    raise NotImplementedError(${JSON.stringify(message)})`,
    ].join('\n'),
    testName: (id) => `test_${id.toLowerCase().replace(/-/g, '_')}.py`,
    test: ({ cases, message }) => cases.map(({ statement }, i) => [
      `def test_case_${i + 1}() -> None:`,
      `    """${statement.replace(/"/g, "'")}"""`,
      `    raise NotImplementedError(${JSON.stringify(message)})`,
      '',
    ].join('\n')).join('\n').trimEnd(),
  },

  go: {
    line: (t) => (t ? `// ${t}` : '//'),
    module: ({ symbol, message, pkg }) => [
      `package ${pkg}`,
      '',
      'import "errors"',
      '',
      '// Placeholder signature — replace with the real surface before implementing.',
      `func ${symbol}() error {`,
      `\treturn errors.New(${JSON.stringify(message)})`,
      '}',
    ].join('\n'),
    testName: (id) => `${id.toLowerCase().replace(/-/g, '_')}_test.go`,
    test: ({ id, cases, message, pkg }) => [
      `package ${pkg}`,
      '',
      'import "testing"',
      '',
      ...cases.map(({ statement }, i) => [
        `// ${statement}`,
        `func Test${pascal(words(id))}Case${i + 1}(t *testing.T) {`,
        `\tt.Fatal(${JSON.stringify(message)})`,
        '}',
        '',
      ].join('\n')),
    ].join('\n').trimEnd(),
  },

  rust: {
    line: (t) => (t ? `// ${t}` : '//'),
    module: ({ symbol, message }) => [
      '/// Placeholder signature — replace with the real surface before implementing.',
      `pub fn ${symbol}() {`,
      `    unimplemented!(${JSON.stringify(message)});`,
      '}',
    ].join('\n'),
    testName: (id) => `${id.toLowerCase().replace(/-/g, '_')}.rs`,
    test: ({ id, cases, message }) => cases.map(({ statement }, i) => [
      `// ${statement}`,
      '#[test]',
      `fn ${snake(words(id))}_case_${i + 1}() {`,
      `    unimplemented!(${JSON.stringify(message)});`,
      '}',
      '',
    ].join('\n')).join('\n').trimEnd(),
  },
});

/**
 * The repository's own toolchain, asked of `command-detect.js` rather than re-derived here.
 *
 * Partial fit, stated rather than papered over: that module answers "which manifests are present",
 * which pins the toolchain but not the dialect inside it — `package.json` alone does not say
 * TypeScript. The one extra bit is read from its own output (a `typecheck` role exists only when a
 * tsc script or a `tsconfig.json` was found), so no second detector is introduced.
 */
function repoLanguage(repoRoot, fsImpl) {
  const detected = detectCommands({ projectRoot: repoRoot, fsImpl });
  if (!detected.manifestFound) {
    return { id: null, signal: 'none', why: 'no build manifest found by command-detect.js' };
  }
  const has = (name) => detected.manifests.includes(name);
  if (has('package.json')) {
    const typescript = Boolean(detected.commands.typecheck);
    return { id: typescript ? 'typescript' : 'javascript', signal: 'package.json', why: null };
  }
  if (has('Cargo.toml')) return { id: 'rust', signal: 'Cargo.toml', why: null };
  if (has('go.mod')) return { id: 'go', signal: 'go.mod', why: null };
  if (has('pyproject.toml')) return { id: 'python', signal: 'pyproject.toml', why: null };
  return {
    id: null,
    signal: detected.manifests.join(', ') || 'none',
    why: `command-detect.js resolved only ${detected.manifests.join(', ') || 'nothing'}, which names no source language`,
  };
}

// ---------------------------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------------------------

/**
 * Wraps a body in its provenance header and fingerprint.
 *
 * The fingerprint covers the body only, so the header can gain a line without every existing file
 * reading as human-edited; and it lives in the file rather than in a side ledger, so a scaffold
 * copied, moved or committed on its own still carries the evidence needed to protect it.
 */
function compose(emitter, headerLines, body) {
  const fingerprint = sha256(body);
  const header = [
    ...headerLines.map((l) => emitter.line(l)),
    emitter.line(`${FINGERPRINT_MARKER} sha256:${fingerprint}`),
  ].join('\n');
  return `${header}\n${body}`;
}

/** The hash a file claims for its own body, and the body it actually has. */
function inspectExisting(text) {
  const match = text.match(FINGERPRINT_RE);
  if (!match) return { claimed: null, actual: null, body: null };
  const cut = text.indexOf('\n', text.indexOf(match[0]));
  if (cut === -1) return { claimed: match[1], actual: null, body: null };
  const body = text.slice(cut + 1);
  return { claimed: match[1], actual: sha256(body), body };
}

// ---------------------------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------------------------

/**
 * Generates the scaffold for one feature directory.
 *
 * @param {Object} options
 * @param {string} options.featureDir directory holding `requirement.md`, `design.md`, `plan.md`
 * @param {string} [options.repoRoot] repository the plan's `files:` paths are relative to;
 *   defaults to the working directory. Read-only — used for language detection, never written to.
 * @param {Object} [options.fsImpl] injection seam for tests; same contract as `node:fs`
 * @returns {Object} result — see `summary`, `status` and `exitCode`
 */
function generateScaffold(options = {}) {
  const fsImpl = options.fsImpl || nodeFs;
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const featureDir = options.featureDir ? path.resolve(options.featureDir) : null;

  const usage = (message) => ({
    status: STATUS.USAGE, exitCode: EXIT.USAGE, ok: false, summary: message,
    featureDir, scaffoldDir: null, manifestPath: null,
    generated: [], written: [], unchanged: [], preserved: [], skipped: [], notEvaluated: [],
    externalDependencies: [], orphans: [],
  });

  if (!featureDir) return usage('no feature directory given — pass featureDir');
  if (!isDirectory(featureDir, fsImpl)) return usage(`not a directory: ${featureDir}`);

  const slug = path.basename(featureDir);
  const scaffoldDir = path.join(featureDir, SCAFFOLD_DIR_NAME);
  const message = `${slug} scaffold — not implemented`;

  // ---- read the three artifacts -------------------------------------------------------------
  const sources = [];
  const notEvaluated = [];
  const texts = {};
  for (const name of ARTIFACTS) {
    const text = readIfPresent(path.join(featureDir, name), fsImpl);
    texts[name] = text;
    sources.push({ name, present: text !== null, sha256: text === null ? null : sha256(text) });
    if (text === null) {
      notEvaluated.push({ what: name, why: 'artifact not found in the feature directory' });
    }
  }

  // ---- parse ---------------------------------------------------------------------------------
  const requirement = texts['requirement.md'] ? parseRequirement(texts['requirement.md']) : { requirements: new Map(), criteria: [], gaps: [] };
  const design = texts['design.md'] ? parseDesign(texts['design.md']) : { components: new Map(), gaps: [] };
  const plan = texts['plan.md'] ? parsePlan(texts['plan.md']) : { tasks: [], gaps: [] };
  for (const gap of [...requirement.gaps, ...design.gaps, ...plan.gaps]) {
    notEvaluated.push({ what: `${gap.artifact} → ${gap.what}`, why: gap.why });
  }

  const blocked = notEvaluated.filter(
    (n) => ARTIFACTS.includes(n.what) || n.what.startsWith('plan.md → task list'),
  );

  // ---- traceability index --------------------------------------------------------------------
  // A task carries a user story; the requirement index maps stories to requirements; the design
  // index maps requirements to components. Following that chain is how a file header can name its
  // component without anyone restating the mapping in a fourth place.
  const requirementsForStory = new Map();
  for (const req of requirement.requirements.values()) {
    for (const story of req.stories) {
      if (!requirementsForStory.has(story)) requirementsForStory.set(story, []);
      requirementsForStory.get(story).push(req);
    }
  }
  const componentsForRequirement = new Map();
  for (const component of design.components.values()) {
    for (const id of component.serves) {
      if (!componentsForRequirement.has(id)) componentsForRequirement.set(id, []);
      componentsForRequirement.get(id).push(component);
    }
  }

  function traceTask(task) {
    const reqs = [...new Set(task.stories.flatMap((s) => requirementsForStory.get(s) || []))]
      .sort(byKey((r) => r.id));
    const comps = [...new Set(reqs.flatMap((r) => componentsForRequirement.get(r.id) || []))]
      .sort(byKey((c) => c.id));
    return { requirements: reqs, components: comps };
  }

  // ---- plan the writes -------------------------------------------------------------------------
  const planned = new Map();   // relative-to-scaffoldDir path → { body, header, kind, from }
  const skipped = [];
  const shapeUndeclared = [];
  const language = repoLanguage(repoRoot, fsImpl);

  // src/ — one frame per source file the plan intends to create or change.
  const byPath = new Map();
  for (const task of plan.tasks) {
    if (task.files.length === 0) {
      skipped.push({ item: `task ${task.id}`, why: 'no `files:` field — nothing to mirror', benign: false });
      continue;
    }
    for (const file of task.files) {
      if (!byPath.has(file)) byPath.set(file, []);
      byPath.get(file).push(task);
    }
  }

  for (const [file, owners] of [...byPath.entries()].sort(byKey((e) => e[0]))) {
    const ext = path.extname(file).toLowerCase();
    const label = `${file} (${owners.map((t) => t.id).join(', ')})`;

    if (file.endsWith('/') || isDirectory(path.join(repoRoot, file), fsImpl)) {
      skipped.push({ item: label, why: 'names a directory, not a file — no single signature to emit', benign: true });
      continue;
    }
    if (PROSE_EXTENSIONS.has(ext)) {
      skipped.push({ item: label, why: `${ext || 'no extension'} is content, not code — nothing to scaffold`, benign: true });
      continue;
    }
    const unemitted = UNEMITTED_SOURCE_EXTENSIONS[ext];
    if (unemitted) {
      // Two different gaps, kept distinct because the reader's next move differs: one is covered by
      // the model-executed grammar table in references/scaffold.md, the other is covered nowhere.
      skipped.push({
        item: label,
        why: unemitted.inProseGrammar
          ? `no scaffold emitter for ${unemitted.name}; the Default-Implementation Grammar in references/scaffold.md covers it for contract frames, this generator does not`
          : `no scaffold emitter for ${unemitted.name}, and it is not in the Default-Implementation Grammar either — write this file by hand`,
        benign: false,
      });
      continue;
    }
    const languageId = EXTENSION_LANGUAGE[ext];
    if (!languageId) {
      skipped.push({ item: label, why: `unrecognized file type '${ext || path.basename(file)}' — no language to emit`, benign: false });
      continue;
    }

    const target = path.join(scaffoldDir, 'src', file);
    if (path.relative(scaffoldDir, target).startsWith('..')) {
      // A `files:` value is artifact text, and artifact text is not trusted with a write path.
      skipped.push({ item: label, why: 'path escapes the scaffold directory — refused', benign: false });
      continue;
    }

    const emitter = EMITTERS[languageId];
    const trace = owners.map((t) => ({ task: t, ...traceTask(t) }));
    const reqs = [...new Set(trace.flatMap((t) => t.requirements))].sort(byKey((r) => r.id));
    const comps = [...new Set(trace.flatMap((t) => t.components))].sort(byKey((c) => c.id));
    const declared = comps.flatMap((c) => c.declared.map((d) => ({ ...d, component: c.id })));

    const header = [
      `doflow scaffold — generated from ${slug}'s requirement.md, design.md and plan.md.`,
      'Signatures and stubs only. Do not implement here; this tree is never promoted automatically.',
      '',
      `intended path: ${file}`,
      ...owners.map((t) => `task:          ${t.id} — ${t.description}`),
      ...(reqs.length
        ? reqs.map((r) => `requirement:   ${r.id} — ${r.summary}`)
        : ['requirement:   none — no user story on the owning task resolves to a requirement']),
      ...(comps.length
        ? comps.map((c) => `component:     ${c.id} — ${c.name} (design.md §3)`)
        : ['component:     none — no design component serves this task\'s requirements']),
    ];

    const bodyParts = [''];
    if (declared.length) {
      header.push(`shape:         declared in design.md §4 (${[...new Set(declared.map((d) => d.component))].join(', ')}), quoted below`);
      for (const decl of declared) {
        const lines = decl.block.split('\n');
        const shown = lines.slice(0, 40);
        bodyParts.push([
          emitter.line(`declared interface — design.md "${decl.heading}", verbatim:`),
          ...shown.map((l) => emitter.line(`  ${l}`.replace(/\s+$/, ''))),
          ...(lines.length > shown.length ? [emitter.line(`  … ${lines.length - shown.length} more lines in design.md`)] : []),
          '',
        ].join('\n'));
      }
    } else {
      header.push('shape:         not declared in design.md §4 — placeholder signature below');
      // Not a skip — the file was emitted. Conflating the two would let 29 "we wrote it, but the
      // design never said what it should look like" rows hide inside a skip count, which is the
      // opposite of what the manifest is for.
      shapeUndeclared.push({ path: path.join('src', file) + STUB_SUFFIX, why: 'design.md §4 declares no interface for this file\'s component — the signature below is a placeholder, not a contract' });
    }

    const pkg = snake(words(path.basename(path.dirname(file)) || 'scaffold')).replace(/_/g, '');
    const symbol = languageId === 'go'
      ? pascal(words(path.basename(file)))
      : languageId === 'python' || languageId === 'rust'
        ? snake(words(path.basename(file)))
        : camel(words(path.basename(file)));

    bodyParts.push(emitter.module({ symbol, message, pkg: pkg || 'scaffold' }));
    planned.set(path.join('src', file) + STUB_SUFFIX, {
      content: compose(emitter, header, `${bodyParts.join('\n')}\n`),
      from: owners.map((t) => t.id).join(', '),
      shape: declared.length ? 'declared interface + placeholder signature' : 'placeholder signature',
    });
  }

  // test/ — one stub file per requirement that has acceptance criteria.
  if (requirement.criteria.length > 0) {
    if (!language.id) {
      notEvaluated.push({
        what: 'test stubs',
        why: `acceptance criteria exist but the repository language is unresolved (${language.why}) — no stub language to emit in`,
      });
    } else {
      const emitter = EMITTERS[language.id];
      const grouped = new Map();
      for (const criterion of requirement.criteria) {
        const ids = criterion.requirements.length ? criterion.requirements : ['unattributed'];
        for (const id of ids) {
          if (!grouped.has(id)) grouped.set(id, []);
          grouped.get(id).push(criterion);
        }
        if (criterion.requirements.length === 0) {
          skipped.push({ item: `acceptance criterion "${criterion.statement}"`, why: 'names no FR/NFR — stubbed under "unattributed", traceability incomplete', benign: false });
        }
      }
      for (const [id, cases] of [...grouped.entries()].sort(byKey((e) => e[0]))) {
        const req = requirement.requirements.get(id);
        const comps = (componentsForRequirement.get(id) || []).sort(byKey((c) => c.id));
        const header = [
          `doflow scaffold — test stubs generated from ${slug}'s requirement.md acceptance criteria.`,
          'Each stub fails until implemented, on purpose: a stub that passes asserts nothing and',
          'reads as coverage. Replace the body, do not delete the failure.',
          '',
          `requirement:   ${id}${req ? ` — ${req.summary}` : ' — not present in the requirement index'}`,
          ...(comps.length ? comps.map((c) => `component:     ${c.id} — ${c.name} (design.md §3)`) : []),
          `criteria:      ${cases.length} from requirement.md §6`,
          `language:      ${language.id} (detected from ${language.signal} by command-detect.js)`,
        ];
        const name = emitter.testName(id);
        planned.set(path.join('test', name) + STUB_SUFFIX, {
          content: compose(emitter, header, `\n${emitter.test({ id, cases, message, pkg: 'scaffold' })}\n`),
          from: `${id} acceptance criteria`,
          shape: `${cases.length} failing test stub${cases.length === 1 ? '' : 's'}`,
        });
      }
    }
  }

  // contracts/ — partitioned here, generated by the prose algorithm. See the module header for why
  // the walk-up is not reimplemented in code.
  const ownedPaths = new Set([...byPath.keys()]);
  const externalDependencies = [];
  const dependencyTasks = new Map();
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!dependencyTasks.has(dep)) dependencyTasks.set(dep, []);
      dependencyTasks.get(dep).push(task);
    }
  }
  for (const [dep, owners] of [...dependencyTasks.entries()].sort(byKey((e) => e[0]))) {
    const inScope = [...ownedPaths].some((p) => p === dep || p.startsWith(`${dep.replace(/\/$/, '')}/`));
    const docs = [...new Set(owners.map((t) => t.externalContract).filter(Boolean))];
    externalDependencies.push({
      dependency: dep,
      tasks: owners.map((t) => t.id).sort(),
      disposition: inScope
        ? 'in scope — a task in this plan owns it, no contract frame needed'
        : docs.length === 1
          ? `external, documented — no local repo to scan; frame from ${docs[0]}`
          : docs.length > 1
            ? `conflicting external-contract: values (${docs.join(', ')}) — reconcile before generating`
            : 'external, undocumented — walk-up derivation in references/scaffold.md decides',
    });
  }

  // ---- apply ---------------------------------------------------------------------------------
  const written = [];
  const unchanged = [];
  const preserved = [];

  function place(relative, content) {
    const target = path.join(scaffoldDir, relative);
    const existing = readIfPresent(target, fsImpl);
    if (existing !== null) {
      const { claimed, actual } = inspectExisting(existing);
      if (claimed === null || claimed !== actual) {
        // No fingerprint, or a body that no longer matches one: human-authored as far as this
        // module can tell. Failing closed here is the whole point — the cost of a wrong guess is
        // someone's work, and the cost of preserving a file nobody edited is one manifest row.
        preserved.push({ path: relative, why: claimed === null ? 'no scaffold fingerprint — treated as hand-authored' : 'body no longer matches its fingerprint — edited by hand' });
        return;
      }
      if (existing === content) { unchanged.push(relative); return; }
    }
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.writeFileSync(target, content, 'utf8');
    written.push(relative);
  }

  if (blocked.length === 0) {
    for (const [relative, entry] of [...planned.entries()].sort(byKey((e) => e[0]))) {
      place(relative, entry.content);
    }
  }

  // Files this generator wrote on an earlier run and no longer implies. Reported, never deleted:
  // removing a file a human may have started working in is a worse failure than a stale one.
  const orphans = [];
  (function scan(dir, prefix) {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries.sort(byKey((e) => e.name))) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) { scan(path.join(dir, entry.name), relative); continue; }
      if (relative === MANIFEST_NAME || planned.has(relative)) continue;
      const text = readIfPresent(path.join(dir, entry.name), fsImpl);
      if (text !== null && FINGERPRINT_RE.test(text)) orphans.push(relative);
    }
  }(scaffoldDir, ''));

  // ---- classify --------------------------------------------------------------------------------
  const realGaps = [...notEvaluated, ...skipped.filter((s) => !s.benign)];
  const status = blocked.length
    ? STATUS.BLOCKED
    : realGaps.length || planned.size === 0
      ? STATUS.INCOMPLETE
      : STATUS.COMPLETE;

  // An empty scaffold reported as complete is the empty-contract defect wearing a different hat:
  // zero files is not evidence that a plan implies no shape, it is evidence nothing was evaluated.
  if (planned.size === 0 && blocked.length === 0) {
    notEvaluated.push({ what: 'the whole scaffold', why: 'no task named a file this generator can emit — an empty scaffold is not a verdict that the plan implies no code' });
  }

  const blockedWhy = blocked.map((b) => b.what).join(', ');

  // Two summaries on purpose. `summary` is what the caller prints, so it may say what this run did.
  // `stateSummary` goes into the manifest and describes the scaffold, not the run — "58 written" is
  // true once and false every time after, and a manifest that changes on the second identical run
  // is a manifest nobody can review as a diff.
  const stateSummary = status === STATUS.BLOCKED
    ? `BLOCKED — ${blockedWhy} could not be read or parsed; no scaffold written`
    : `${status} — ${planned.size} file(s), ${shapeUndeclared.length} of them with no shape declared in design.md, `
      + `${preserved.length} preserved (hand-edited), ${skipped.length} skipped `
      + `(${skipped.filter((s) => !s.benign).length} of them a real gap), ${notEvaluated.length} not evaluated, `
      + `${externalDependencies.length} dependency reference(s) routed to the contract-frame case`;

  const summary = status === STATUS.BLOCKED
    ? stateSummary
    : `${stateSummary}; this run wrote ${written.length} and left ${unchanged.length} already current`;

  const result = {
    status,
    exitCode: status === STATUS.COMPLETE ? EXIT.OK : EXIT.FINDING,
    ok: status === STATUS.COMPLETE,
    slug,
    featureDir,
    scaffoldDir,
    repoRoot,
    manifestPath: path.join(scaffoldDir, MANIFEST_NAME),
    language,
    sources,
    generated: [...planned.keys()].sort(),
    written: written.sort(),
    unchanged: unchanged.sort(),
    preserved: preserved.sort(byKey((p) => p.path)),
    skipped: skipped.sort(byKey((s) => s.item)),
    shapeUndeclared: shapeUndeclared.sort(byKey((s) => s.path)),
    notEvaluated: notEvaluated.sort(byKey((n) => n.what)),
    externalDependencies,
    orphans: orphans.sort(),
    stateSummary,
    summary,
  };

  // ---- the report -------------------------------------------------------------------------------
  const manifest = renderManifest(result, planned);
  const manifestTarget = path.join(scaffoldDir, MANIFEST_NAME);
  const existingManifest = readIfPresent(manifestTarget, fsImpl);
  if (existingManifest !== null) {
    const { claimed, actual } = inspectExisting(existingManifest);
    if (claimed === null || claimed !== actual) {
      // The report obeys the same rule as everything else. A caller that wants it refreshed deletes
      // it; silently overwriting the one file a reviewer is most likely to annotate would trade the
      // invariant for convenience.
      result.preserved.push({ path: MANIFEST_NAME, why: claimed === null ? 'no scaffold fingerprint — treated as hand-authored' : 'body no longer matches its fingerprint — edited by hand' });
      result.notEvaluated.push({ what: MANIFEST_NAME, why: 'hand-edited, so this run could not refresh it — delete it to regenerate' });
      result.status = STATUS.INCOMPLETE;
      result.exitCode = EXIT.FINDING;
      result.ok = false;
      return result;
    }
    if (existingManifest === manifest) { result.unchanged.push(MANIFEST_NAME); return result; }
  }
  fsImpl.mkdirSync(scaffoldDir, { recursive: true });
  fsImpl.writeFileSync(manifestTarget, manifest, 'utf8');
  result.written.push(MANIFEST_NAME);
  result.written.sort();
  return result;
}

/**
 * Renders `MANIFEST.md`.
 *
 * Deliberately reports each file's *state* rather than what this run did to it. "Written" versus
 * "already current" is a property of run order, not of the scaffold, and recording it would make
 * the second run of an unchanged plan produce a diff — losing the idempotency the whole artifact is
 * reviewed on.
 */
function renderManifest(result, planned) {
  const lines = [];
  const table = (headers, rows, empty) => {
    if (rows.length === 0) { lines.push(empty, ''); return; }
    lines.push(`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`);
    for (const r of rows) lines.push(`| ${r.map(cell).join(' | ')} |`);
    lines.push('');
  };

  lines.push(`# Scaffold manifest — ${result.slug}`, '');
  lines.push(
    'Generated by DoFlow\'s scaffold generator (`src/runtime/scaffold.js`) from this feature\'s own',
    '`requirement.md`, `design.md` and `plan.md`. Signatures, types and failing stubs only — no',
    'implementation logic, by design. Nothing here is written into the source tree; promoting any of',
    'it is a deliberate act.',
    '',
    'Every file below carries a fingerprint of its own body. Edit one and this generator will report',
    'it and leave it alone rather than overwrite it — including this manifest, which must be deleted',
    'to be refreshed once edited.',
    '',
  );
  lines.push(`**Status:** ${result.stateSummary}`, '');

  lines.push('## Source artifacts', '');
  table(['Artifact', 'Read', 'SHA-256'],
    result.sources.map((s) => [s.name, s.present ? 'yes' : 'NOT FOUND', s.sha256 || '—']),
    '_None read._');

  lines.push('## Generated', '');
  table(['Path', 'Derived from', 'Shape'],
    result.generated.map((p) => [p, planned.get(p).from, planned.get(p).shape]),
    '_Nothing generated._');

  lines.push('## Emitted without a declared shape', '');
  lines.push('These files exist and are traceable, but `design.md` §4 never declared an interface for',
    'them, so their signature is a placeholder rather than a contract. Reviewing the placeholder as',
    'if it were the designed API is the mistake this section exists to prevent.', '');
  table(['Path', 'Why'], result.shapeUndeclared.map((s) => [s.path, s.why]),
    '_Every emitted file has a declared shape behind it._');

  lines.push('## Preserved — edited by hand, not overwritten', '');
  table(['Path', 'Why'], result.preserved.map((p) => [p.path, p.why]),
    '_No hand-edited files detected._');

  lines.push('## Skipped', '');
  lines.push('What a scaffold leaves out is as much a part of it as what it contains: a reader who',
    'cannot see the gaps will read the tree as the whole shape of the plan.',
    '',
    '"Gap" separates the two kinds. A markdown file has no signature to emit and skipping it costs',
    'nothing; a source file in a language this generator cannot emit is work that silently did not',
    'happen, and it is what holds the status below `COMPLETE`.', '');
  table(['Item', 'Gap', 'Why'], result.skipped.map((s) => [s.item, s.benign ? 'no' : 'YES', s.why]),
    '_Nothing skipped._');

  lines.push('## Not evaluated', '');
  lines.push('Things this run could not judge either way. These, together with every skip marked as a',
    'gap above, are why the status is not `COMPLETE`. None of them is a claim that the underlying',
    'item is fine.', '');
  table(['What', 'Why'], result.notEvaluated.map((n) => [n.what, n.why]),
    '_Everything the artifacts declared was evaluated._');

  lines.push('## External dependencies', '');
  lines.push('`depends-on:` values, partitioned. Frames for the external ones are produced by the',
    'walk-up algorithm in `core/shared/skills/do-execute-plan/references/scaffold.md`, which handles',
    'nested `.git` boundaries, non-local vendors and `external-contract:` targets; this generator reports',
    'the partition rather than deriving the boundaries a second way.', '');
  table(['Dependency', 'Named by', 'Disposition'],
    result.externalDependencies.map((d) => [d.dependency, d.tasks.join(', '), d.disposition]),
    '_No task declares a `depends-on:` value._');

  if (result.orphans.length) {
    lines.push('## Orphaned', '');
    lines.push('Generated by an earlier run and no longer implied by the plan. Reported, never deleted.', '');
    table(['Path'], result.orphans.map((p) => [p]), '');
  }

  const body = `\n${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  return `<!-- ${FINGERPRINT_MARKER} sha256:${sha256(body)} -->\n${body}`;
}

module.exports = {
  generateScaffold,
  renderManifest,
  parseRequirement,
  parseDesign,
  parsePlan,
  repoLanguage,
  inspectExisting,
  SCAFFOLD_DIR_NAME,
  MANIFEST_NAME,
  STUB_SUFFIX,
  ARTIFACTS,
  FINGERPRINT_MARKER,
  FINGERPRINT_RE,
  EXTENSION_LANGUAGE,
  PROSE_EXTENSIONS,
  UNEMITTED_SOURCE_EXTENSIONS,
  EMITTERS,
  EXIT,
  STATUS,
};

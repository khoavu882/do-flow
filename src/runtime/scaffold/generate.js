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
 *
 * Three modules split out alongside this one, each required below and named for what it contains:
 *   - `scaffold-artifacts.js` — parses `requirement.md`, `design.md` and `plan.md` into structures.
 *   - `scaffold-languages.js` — per-extension language selection, identifier casing, the language
 *     emitters, and `repoLanguage()`.
 *   - `scaffold-fingerprint.js` — the sha256 fingerprint header that makes property 4 (human edits
 *     survive) possible: `compose()` writes it, `inspectExisting()` reads it back.
 * What remains here is orchestration: `generateScaffold()` (itself decomposed into named steps —
 * see the "Generator" section below), `renderManifest()`, and the `doflow scaffold` CLI handler.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { finishRuntime } = require('../cli-result');
const { parseRequirement, parseDesign, parsePlan } = require('./artifacts');
const {
  EXTENSION_LANGUAGE,
  PROSE_EXTENSIONS,
  UNEMITTED_SOURCE_EXTENSIONS,
  words,
  camel,
  pascal,
  snake,
  EMITTERS,
  repoLanguage,
} = require('./languages');
const {
  FINGERPRINT_MARKER,
  FINGERPRINT_RE,
  sha256,
  compose,
  inspectExisting,
} = require('./fingerprint');

// `resolveActiveFeature` (moved from bin/doflow.js) reads through the plain `fs` binding bin/doflow.js
// used; aliased here to the same `node:fs` module this file already imports as `nodeFs`, so the
// moved body needs no renaming.
const fs = nodeFs;

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
 * layout stays legible either way — `src/runtime/scaffold/generate.js.stub` reads as exactly what it is.
 *
 * Part 2's `contracts/` frames deliberately do not carry it: `default/` exists to be compiled
 * against, and its tree contains no directory a test runner sweeps.
 */
const STUB_SUFFIX = '.stub';

/** The three chain artifacts, in the order a reader meets them. All three are required: a scaffold
 * missing one of them is a scaffold with no traceability, no shape, or no file list. */
const ARTIFACTS = Object.freeze(['requirement.md', 'design.md', 'plan.md']);

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
// Small helpers
// ---------------------------------------------------------------------------------------------
//
// `sha256`, `compose`, `inspectExisting` (fingerprinting), the identifier-casing helpers, the
// language tables and emitters, and the artifact parsers now live in `scaffold-fingerprint.js`,
// `scaffold-languages.js` and `scaffold-artifacts.js` respectively — required above. What is left
// here is generic and used only by the generator below.

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

/** Table cells are pipe-delimited; an unescaped pipe in a task description would shear the row. */
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

/** Sorts by a string key without depending on locale collation, which varies by platform and would
 * make "re-running produces no diff" false across machines. */
const byKey = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------------------------
//
// `generateScaffold` used to be one ~380-line function. It is now an orchestrator over the named
// steps below, each lifted out verbatim and given the name of the one thing it does. Two arrays —
// `notEvaluated` and `skipped` — accumulate across several of these steps in the same order the
// original inline code built them in; every consumer of either array sorts it before use (see
// `buildResult`), so the merge order between steps only has to match the original for `blocked`,
// which is computed immediately after the two steps that can populate it (`readArtifacts`,
// `parseArtifacts`) and before any later step's entries are merged in.

/**
 * Reads the three chain artifacts from the feature directory.
 * @param {string} featureDir
 * @param {Object} fsImpl
 * @returns {{ sources: Array<Object>, notEvaluated: Array<Object>, texts: Object }}
 */
function readArtifacts(featureDir, fsImpl) {
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
  return { sources, notEvaluated, texts };
}

/**
 * Parses whichever artifact texts are present into `requirement.md` / `design.md` / `plan.md`
 * structures, and collects each parser's own gaps.
 * @param {Object} texts keyed by artifact name, from `readArtifacts`
 * @returns {{ requirement: Object, design: Object, plan: Object, notEvaluated: Array<Object> }}
 */
function parseArtifacts(texts) {
  const requirement = texts['requirement.md'] ? parseRequirement(texts['requirement.md']) : { requirements: new Map(), criteria: [], gaps: [] };
  const design = texts['design.md'] ? parseDesign(texts['design.md']) : { components: new Map(), gaps: [] };
  const plan = texts['plan.md'] ? parsePlan(texts['plan.md']) : { tasks: [], gaps: [] };
  const notEvaluated = [];
  for (const gap of [...requirement.gaps, ...design.gaps, ...plan.gaps]) {
    notEvaluated.push({ what: `${gap.artifact} → ${gap.what}`, why: gap.why });
  }
  return { requirement, design, plan, notEvaluated };
}

/**
 * Builds the story → requirement → component chain that lets a generated file's header name its
 * own component without anyone restating the mapping in a fourth place.
 * @param {Object} requirement from `parseArtifacts`
 * @param {Object} design from `parseArtifacts`
 * @returns {{ requirementsForStory: Map, componentsForRequirement: Map, traceTask: Function }}
 */
function buildTraceabilityIndex(requirement, design) {
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

  return { requirementsForStory, componentsForRequirement, traceTask };
}

/**
 * Groups plan tasks by the file each one names, so a file with several owning tasks gets one frame.
 * @param {Array<Object>} tasks from `plan.tasks`
 * @returns {{ byPath: Map<string, Array<Object>>, skipped: Array<Object> }}
 */
function groupTasksByFile(tasks) {
  const byPath = new Map();
  const skipped = [];
  for (const task of tasks) {
    if (task.files.length === 0) {
      skipped.push({ item: `task ${task.id}`, why: 'no `files:` field — nothing to mirror', benign: false });
      continue;
    }
    for (const file of task.files) {
      if (!byPath.has(file)) byPath.set(file, []);
      byPath.get(file).push(task);
    }
  }
  return { byPath, skipped };
}

/**
 * src/ — one frame per source file the plan intends to create or change.
 * @param {Object} options
 * @param {Map<string, Array<Object>>} options.byPath from `groupTasksByFile`
 * @param {string} options.scaffoldDir
 * @param {string} options.repoRoot
 * @param {Object} options.fsImpl
 * @param {string} options.slug
 * @param {string} options.message the pinned "not implemented" signal
 * @param {Function} options.traceTask from `buildTraceabilityIndex`
 * @returns {{ planned: Map<string, Object>, skipped: Array<Object>, shapeUndeclared: Array<Object> }}
 */
function planSourceStubs({ byPath, scaffoldDir, repoRoot, fsImpl, slug, message, traceTask }) {
  const planned = new Map();   // relative-to-scaffoldDir path → { body, header, kind, from }
  const skipped = [];
  const shapeUndeclared = [];

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

  return { planned, skipped, shapeUndeclared };
}

/**
 * test/ — one stub file per requirement that has acceptance criteria.
 * @param {Object} options
 * @param {Object} options.requirement from `parseArtifacts`
 * @param {Map} options.componentsForRequirement from `buildTraceabilityIndex`
 * @param {Object} options.language from `repoLanguage`
 * @param {string} options.slug
 * @param {string} options.message the pinned "not implemented" signal
 * @returns {{ planned: Map<string, Object>, skipped: Array<Object>, notEvaluated: Array<Object> }}
 */
function planTestStubs({ requirement, componentsForRequirement, language, slug, message }) {
  const planned = new Map();
  const skipped = [];
  const notEvaluated = [];

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

  return { planned, skipped, notEvaluated };
}

/**
 * contracts/ — partitioned here, generated by the prose algorithm. See the module header for why
 * the walk-up is not reimplemented in code.
 * @param {Array<Object>} tasks from `plan.tasks`
 * @param {Set<string>} ownedPaths every path a task in this plan already owns
 * @returns {Array<Object>} externalDependencies
 */
function partitionExternalDependencies(tasks, ownedPaths) {
  const externalDependencies = [];
  const dependencyTasks = new Map();
  for (const task of tasks) {
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
  return externalDependencies;
}

/**
 * Writes every planned file that isn't blocked, preserving anything hand-edited.
 * @param {Object} options
 * @param {Map<string, Object>} options.planned
 * @param {Array<Object>} options.blocked a non-empty list suppresses every write
 * @param {string} options.scaffoldDir
 * @param {Object} options.fsImpl
 * @returns {{ written: Array<string>, unchanged: Array<string>, preserved: Array<Object> }}
 */
function applyPlannedFiles({ planned, blocked, scaffoldDir, fsImpl }) {
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

  return { written, unchanged, preserved };
}

/**
 * Files this generator wrote on an earlier run and no longer implies. Reported, never deleted:
 * removing a file a human may have started working in is a worse failure than a stale one.
 * @param {Object} options
 * @param {string} options.scaffoldDir
 * @param {Map<string, Object>} options.planned
 * @param {Object} options.fsImpl
 * @returns {Array<string>} orphans
 */
function findOrphans({ scaffoldDir, planned, fsImpl }) {
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
  return orphans;
}

/**
 * Determines COMPLETE / INCOMPLETE / BLOCKED and, for the empty-scaffold case, records why: zero
 * files is not evidence the plan implies no shape, it is evidence nothing was evaluated — the
 * empty-contract defect wearing a different hat. Mutates `notEvaluated` in place for that one case,
 * exactly as the original inline code did.
 * @param {Object} options
 * @param {Array<Object>} options.blocked
 * @param {Array<Object>} options.notEvaluated mutated when the scaffold is empty and not blocked
 * @param {Array<Object>} options.skipped
 * @param {number} options.plannedSize
 * @returns {{ status: string }}
 */
function classifyRunStatus({ blocked, notEvaluated, skipped, plannedSize }) {
  const realGaps = [...notEvaluated, ...skipped.filter((s) => !s.benign)];
  const status = blocked.length
    ? STATUS.BLOCKED
    : realGaps.length || plannedSize === 0
      ? STATUS.INCOMPLETE
      : STATUS.COMPLETE;

  // An empty scaffold reported as complete is the empty-contract defect wearing a different hat:
  // zero files is not evidence that a plan implies no shape, it is evidence nothing was evaluated.
  if (plannedSize === 0 && blocked.length === 0) {
    notEvaluated.push({ what: 'the whole scaffold', why: 'no task named a file this generator can emit — an empty scaffold is not a verdict that the plan implies no code' });
  }

  return { status };
}

/**
 * Two summaries on purpose. `summary` is what the caller prints, so it may say what this run did.
 * `stateSummary` goes into the manifest and describes the scaffold, not the run — "58 written" is
 * true once and false every time after, and a manifest that changes on the second identical run
 * is a manifest nobody can review as a diff.
 * @param {Object} options
 * @returns {{ stateSummary: string, summary: string }}
 */
function buildSummaries({ status, blocked, planned, shapeUndeclared, preserved, skipped, notEvaluated, externalDependencies, written, unchanged }) {
  const blockedWhy = blocked.map((b) => b.what).join(', ');

  const stateSummary = status === STATUS.BLOCKED
    ? `BLOCKED — ${blockedWhy} could not be read or parsed; no scaffold written`
    : `${status} — ${planned.size} file(s), ${shapeUndeclared.length} of them with no shape declared in design.md, `
      + `${preserved.length} preserved (hand-edited), ${skipped.length} skipped `
      + `(${skipped.filter((s) => !s.benign).length} of them a real gap), ${notEvaluated.length} not evaluated, `
      + `${externalDependencies.length} dependency reference(s) routed to the contract-frame case`;

  const summary = status === STATUS.BLOCKED
    ? stateSummary
    : `${stateSummary}; this run wrote ${written.length} and left ${unchanged.length} already current`;

  return { stateSummary, summary };
}

/**
 * Assembles the result object `generateScaffold` returns (before the manifest is written).
 * @param {Object} options
 * @returns {Object} result
 */
function buildResult({ status, slug, featureDir, scaffoldDir, repoRoot, language, sources, planned, written, unchanged, preserved, skipped, shapeUndeclared, notEvaluated, externalDependencies, orphans, stateSummary, summary }) {
  return {
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
}

/**
 * Renders and, unless hand-edited, writes `MANIFEST.md` — the report — and returns the final
 * result. The report obeys the same edit-preservation rule as everything else: a caller that wants
 * it refreshed deletes it; silently overwriting the one file a reviewer is most likely to annotate
 * would trade the invariant for convenience.
 * @param {Object} options
 * @param {Object} options.result from `buildResult`, mutated on the hand-edited branch
 * @param {Map<string, Object>} options.planned
 * @param {string} options.scaffoldDir
 * @param {Object} options.fsImpl
 * @returns {Object} result
 */
function writeManifest({ result, planned, scaffoldDir, fsImpl }) {
  const manifest = renderManifest(result, planned);
  const manifestTarget = path.join(scaffoldDir, MANIFEST_NAME);
  const existingManifest = readIfPresent(manifestTarget, fsImpl);
  if (existingManifest !== null) {
    const { claimed, actual } = inspectExisting(existingManifest);
    if (claimed === null || claimed !== actual) {
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

  const { sources, notEvaluated: artifactsNotEvaluated, texts } = readArtifacts(featureDir, fsImpl);
  const { requirement, design, plan, notEvaluated: parseGapsNotEvaluated } = parseArtifacts(texts);
  const notEvaluated = [...artifactsNotEvaluated, ...parseGapsNotEvaluated];

  const blocked = notEvaluated.filter(
    (n) => ARTIFACTS.includes(n.what) || n.what.startsWith('plan.md → task list'),
  );

  const { requirementsForStory, componentsForRequirement, traceTask } = buildTraceabilityIndex(requirement, design);

  const language = repoLanguage(repoRoot, fsImpl);
  const { byPath, skipped: groupSkipped } = groupTasksByFile(plan.tasks);
  const { planned: sourcePlanned, skipped: sourceSkipped, shapeUndeclared } = planSourceStubs({
    byPath, scaffoldDir, repoRoot, fsImpl, slug, message, traceTask,
  });
  const { planned: testPlanned, skipped: testSkipped, notEvaluated: testNotEvaluated } = planTestStubs({
    requirement, componentsForRequirement, language, slug, message,
  });
  notEvaluated.push(...testNotEvaluated);
  const skipped = [...groupSkipped, ...sourceSkipped, ...testSkipped];
  const planned = new Map([...sourcePlanned, ...testPlanned]);

  const ownedPaths = new Set([...byPath.keys()]);
  const externalDependencies = partitionExternalDependencies(plan.tasks, ownedPaths);

  const { written, unchanged, preserved } = applyPlannedFiles({ planned, blocked, scaffoldDir, fsImpl });

  const orphans = findOrphans({ scaffoldDir, planned, fsImpl });

  const { status } = classifyRunStatus({ blocked, notEvaluated, skipped, plannedSize: planned.size });

  const { stateSummary, summary } = buildSummaries({
    status, blocked, planned, shapeUndeclared, preserved, skipped, notEvaluated, externalDependencies, written, unchanged,
  });

  const result = buildResult({
    status, slug, featureDir, scaffoldDir, repoRoot, language, sources, planned,
    written, unchanged, preserved, skipped, shapeUndeclared, notEvaluated, externalDependencies, orphans,
    stateSummary, summary,
  });

  return writeManifest({ result, planned, scaffoldDir, fsImpl });
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
    'Generated by DoFlow\'s scaffold generator (`src/runtime/scaffold/generate.js`) from this feature\'s own',
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

// ── the `doflow scaffold` verb handler (moved from bin/doflow.js, FR-023, plan task C.11) ──────
//
// This library takes an already-resolved feature directory. The handler below is the only thing
// between it and the seam: it answers "which feature" and turns the library's result into the
// uniform report contract (design §4.2). It deliberately owns no generation logic of its own — a
// second opinion about what a scaffold contains is exactly the duplication FR-005 exists to
// prevent.

// `resolveActiveFeature` (moved from bin/doflow.js) used bin/doflow.js's own REPO_ROOT — that
// file's SCRIPT_DIR is bin/, so REPO_ROOT = path.dirname(SCRIPT_DIR) = the repo root. This module
// lives at src/runtime/, two levels deeper than bin/, so the equivalent repo root is two levels up.
// bin/doflow.js:    path.dirname(__dirname)         with __dirname = <repo>/bin
// src/runtime/scaffold/*.js: path.resolve(__dirname,'..','..','..') with __dirname = <repo>/src/runtime/scaffold
// Both resolve to the same absolute repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The one resolver. Ships inside the package (`files: ["bin/","src/","core/"]`), so it is beside
 *  this module in a checkout, a project `node_modules/`, and a global npm install alike. */
const PATHS_HELPER = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-paths.sh');

/**
 * Which feature is active, answered by `do-paths.sh` rather than by walking `agent-docs/` here.
 *
 * Every other consumer of "the active feature" — every chain skill, the prerequisite gate, the
 * artifact validator — asks this script. A second implementation would disagree with them the
 * first time branch naming, the non-git directory-scan fallback or `--slug` disambiguation came
 * up, and it would disagree silently, because a scaffold generated for the wrong feature still
 * looks like a scaffold.
 *
 * @param {Object} options
 * @param {string} options.projectRoot working directory the resolution is relative to
 * @param {string|null} [options.slug] explicit feature override, passed straight through
 * @returns {{repoRoot:string, featureDir:string}|{error:string, message:string}}
 */
function resolveActiveFeature({ projectRoot, slug = null }) {
  if (!fs.existsSync(PATHS_HELPER)) {
    return { error: 'resolver-missing', message: `the feature resolver is missing from this install: ${PATHS_HELPER}` };
  }
  const args = [PATHS_HELPER, '--json', '--require', 'feature'];
  if (slug) args.push(`--slug=${slug}`);

  let stdout;
  try {
    stdout = execFileSync('bash', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Exit 2 is the resolver's one non-zero path (no active feature, or an ambiguous one) and it
    // still prints its error object on stdout — that object carries the hint the user needs, so
    // it is read rather than replaced with a generic message. Anything else (no bash, NFR-003)
    // has no stdout to read and reports the spawn failure instead.
    stdout = typeof error.stdout === 'string' ? error.stdout : '';
    if (!stdout.trim()) {
      const detail = error.code === 'ENOENT'
        ? 'bash is required to resolve the active feature and was not found on PATH'
        : (error.stderr || error.message || '').toString().trim();
      return { error: 'resolver-failed', message: `could not run the feature resolver: ${detail}` };
    }
  }

  let paths;
  try {
    paths = JSON.parse(stdout);
  } catch {
    return { error: 'resolver-unparseable', message: `the feature resolver returned output that is not JSON: ${stdout.trim().slice(0, 200)}` };
  }

  if (paths.error) {
    const hint = paths.hint ? ` — ${paths.hint}` : '';
    const candidates = Array.isArray(paths.candidate_slugs) && paths.candidate_slugs.length
      ? ` (candidates: ${paths.candidate_slugs.join(', ')})`
      : '';
    return { error: paths.error, message: `${paths.error}${candidates}${hint}` };
  }
  if (!paths.repo_root || !paths.feature_dir) {
    return { error: 'no-active-feature', message: 'the resolver named no active feature directory to scaffold' };
  }
  return { repoRoot: paths.repo_root, featureDir: path.resolve(paths.repo_root, paths.feature_dir) };
}

/**
 * Handles `doflow scaffold` — turn the active feature's `requirement.md`, `design.md` and
 * `plan.md` into a reviewable scaffold under that feature's own directory (FR-023).
 *
 * Exit codes come from the generator and are surfaced, never reinterpreted: `BLOCKED` and
 * `INCOMPLETE` are findings the caller must act on, so they exit 1 even though a run that reports
 * what it could not read has done its job. Reporting a partial scaffold as success is the precise
 * failure this feature keeps correcting.
 *
 * @param {Object} options
 * @param {boolean} [options.json=false]
 * @param {string} [options.projectRoot] project whose active feature is scaffolded
 * @param {string|null} [options.slug] explicit feature override
 * @returns {number} process exit code
 */
function handleScaffoldCommand({ json = false, projectRoot, slug = null } = {}) {
  const root = projectRoot || process.cwd();
  const feature = resolveActiveFeature({ projectRoot: root, slug });
  if (feature.error) {
    if (json) console.log(JSON.stringify({ ok: false, status: 'USAGE', exitCode: 2, error: feature.error, summary: feature.message }, null, 2));
    else console.error(`doflow scaffold: ${feature.message}`);
    return finishRuntime(2);
  }

  const result = generateScaffold({ featureDir: feature.featureDir, repoRoot: feature.repoRoot, fsImpl: fs });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return finishRuntime(result.exitCode);
  }

  console.log(`\nDoFlow Scaffold [${result.status}]:`);
  console.log('═'.repeat(78));
  console.log(`Feature:  ${result.featureDir || feature.featureDir}`);
  if (result.scaffoldDir) console.log(`Output:   ${result.scaffoldDir}`);
  console.log(`Summary:  ${result.summary}`);

  // A reader who cannot see the gaps reads the tree as the whole shape of the plan, so the
  // negative space is printed at the same level as the counts rather than left to the manifest.
  const sections = [
    ['Skipped', (result.skipped || []).map((s) => `${s.item}${s.benign ? '' : '  [GAP]'} — ${s.why}`)],
    ['Not evaluated', (result.notEvaluated || []).map((n) => `${n.what} — ${n.why}`)],
    ['Preserved (hand-edited, not overwritten)', (result.preserved || []).map((p) => `${p.path} — ${p.why}`)],
    ['Orphaned (no longer implied by the plan)', result.orphans || []],
  ];
  for (const [title, lines] of sections) {
    if (!lines.length) continue;
    console.log('─'.repeat(78));
    console.log(`${title}:`);
    for (const line of lines) console.log(`  ${line}`);
  }
  console.log('═'.repeat(78) + '\n');

  return finishRuntime(result.exitCode);
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
  handleScaffoldCommand,
};

'use strict';
const { bashPath } = require('../helper/bash-locator.ts');
// lifecycle-loop-legacy.e2e.test.js: feature 046 NFR-001 scenarios, the chain verbs compared with the v1.13.0 runtime,
// older features untouched, and reads that create no store. Helpers: lifecycle-loop.shared.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REPO, SKIP, scratch, unique, rt, ok, newProject, folder, gitSnapshot, assertGitUntouched, suiteTempDir, tempDir,
} = require('./lifecycle-loop.shared.ts');

after(() => scratch.remove());

// ---------------------------------------------------------------------------------------------
// NFR-001: what v1.13.0 did, this checkout still does

/**
 * The v1.13.0 runtime, extracted with `git archive` into the scratch directory. Returns null when
 * this clone has no such tag (a shallow CI checkout), and the caller skips with the reason.
 */
const TAG = 'v1.13.0';
const SKIP_NO_TAG = `the ${TAG} tag is absent from this clone, so the comparison against it did not run (git fetch --tags)`;
let legacyRoot: any;
function legacyRuntime() {
  if (legacyRoot !== undefined) return legacyRoot;
  const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${TAG}`], { cwd: REPO }).status === 0;
  if (!exists) { legacyRoot = null; return null; }
  const dir = path.join(scratch.dir, 'legacy-runtime');
  const tarball = path.join(scratch.dir, 'legacy-runtime.tar');
  fs.mkdirSync(dir);
  const archived = spawnSync('git', ['archive', '--format=tar', '-o', tarball, TAG], { cwd: REPO, encoding: 'utf8' });
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync('tar', ['-x', '-f', tarball, '-C', dir], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  legacyRoot = dir;
  return dir;
}

/** The dispatcher of a runtime root (this checkout, or the extracted tag). */
const dispatcherOf = (root: any) => path.join(root, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

function rtWith(root: any, cwd: any, args: any, { input = '' }: any = {}) {
  const result = spawnSync(bashPath(), [dispatcherOf(root), ...args], {
    cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: scratch.env({
      DOFLOW_CONFIG_DIR: path.join(scratch.dir, `config-${path.basename(cwd)}`),
      DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '', DOFLOW_FAULT: '', NODE_OPTIONS: '',
    }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const MIN_HISTORY = '\n## 9. History\n\nNone — initial version.\n';

/** A 045-shaped feature on branch feat/<slug>: requirement and design with a decision register, built by `root`'s runtime. */
function legacyProject(root: any, name: any, slug: any) {
  const dir = suiteTempDir(`doflow-lifecycle-loop-e2e-${name}-`);
  const git = (...a: any[]) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: scratch.env({ GIT_AUTHOR_DATE: '2026-09-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T10:00:00Z' }) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dir, 'README.md'), 'legacy project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  git('checkout', '-q', '-b', `feat/${slug}`);
  // The register is created first, as do-brainstorm does for a folder it is creating; the artifacts follow.
  const init = rtWith(root, dir, ['decision', '--action', 'init', '--slug', slug, '--json']);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const feature = path.join(dir, 'agent-docs', 'doflow', slug);
  fs.mkdirSync(path.join(feature, 'intention'), { recursive: true });
  fs.mkdirSync(path.join(feature, 'design'), { recursive: true });
  fs.writeFileSync(path.join(feature, 'intention', 'requirement.md'), `# Requirement\n\n## 1. Overview\n\nA legacy feature.\n${MIN_HISTORY}`);
  fs.writeFileSync(path.join(feature, 'design', 'design.md'), `# Design\n\n## 1. Choices\n\nStore: sqlite (DEC-001).\n${MIN_HISTORY}`);
  const batch = path.join(scratch.dir, `${unique('legacy-decisions')}.json`);
  fs.writeFileSync(batch, JSON.stringify([{ topic: 'store', statement: 'sqlite', channel: 'question', stage: 'design', rationale: 'because store', supersedes: [], refs: [], source: 'intention/q.md#store' }]));
  const added = rtWith(root, dir, ['decision', '--action', 'add', '--batch', batch, '--json']);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  return dir;
}

describe('NFR-001: the chain verbs answer as they did under v1.13.0', { skip: SKIP }, () => {
  const slug = '045-legacy-shape';

  // The same verbs, in order, on two identical copies of one project, one per runtime: a verb that
  // writes state (orchestrate, evidence, claim) would otherwise leave its result for the other runtime to find.
  const sequence: any = [
    ['paths', '--json'],
    ['classify', '--task-class', 'feature', '--json'],
    ['validate', '--json'],
    ['render-audit', '--json'],
    ['readiness', '--task-class', 'feature', '--task-id', slug, '--json'],
    ['orchestrate', '--action', 'start', '--task-id', slug, '--task-class', 'feature', '--json'],
    ['orchestrate', '--action', 'handoff', '--task-id', slug, '--task-class', 'feature', '--calling-skill', 'do-brainstorm', '--note', 'discovery recorded', '--json'],
    ['orchestrate', '--action', 'status', '--task-id', slug, '--task-class', 'feature', '--json'],
    ['decision', '--action', 'list', '--json'],
    ['evidence', '--task-id', slug, '--action', 'add', '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'local-read', '--capability', 'code.exact-search', '--locator', 'README.md:1', '--establishes', 'target_identified', '--json'],
    ['evidence', '--task-id', slug, '--action', 'list', '--json'],
    ['claim', '--task-id', slug, '--action', 'add', '--statement', 'the legacy project has a readme', '--json'],
    ['claim', '--task-id', slug, '--action', 'list', '--json'],
    ['context-pack', '--task-id', slug, '--task-class', 'feature', '--json'],
    ['git-state', '--json'],
    ['render-audit', '--json'],
  ];

  /** The two runs of one verb, with only named values normalised: the project path, the runtime root, scratch paths, timestamps and generated ids. */
  function normaliser(runtimes: any, ...dirs: any[]) {
    return (text: any) => {
      let out = text;
      for (const dir of dirs) out = out.split(dir).join('<PROJECT>');
      for (const root of runtimes) out = out.split(root).join('<RUNTIME>');
      return out
        .split(scratch.dir).join('<SCRATCH>')
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<TIME>')
        .replace(/\b[a-z]+_[0-9a-z]{6,}_[0-9a-f]{8}_\d+\b/g, '<ID>');
    };
  }

  /** FU-afkns5: an unmet scope_clear, scope_verified or invariants_captured requirement used to recommend the generic
   * "Gather evidence" action; it now names the flag that satisfies it. The one deliberate change to a printed value. */
  function isNamedInputAction(at: any, old: any, neu: any) {
    if (at !== '$.requirements[].recommendedAction.action' || typeof old !== 'string' || typeof neu !== 'string') return false;
    const generic = /^Gather evidence for requirement '(scope_clear|scope_verified|invariants_captured)'/.exec(old);
    if (!generic) return false;
    const flag = generic[1] === 'invariants_captured' ? '--invariants "<invariants>"' : '--scope "<boundary>"';
    return neu.includes(`requirement '${generic[1]}'`) && neu.includes(flag);
  }

  /** Every leaf of `old` is present, unchanged, in `neu`; returns the paths only `neu` has. */
  function additions(old: any, neu: any, at: any = '$', expandNewPaths: any = []): any {
    if (Array.isArray(old)) {
      if (Array.isArray(neu) && old.length === neu.length && old.every((item) => item && typeof item === 'object' && !Array.isArray(item))
          && neu.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
        return old.flatMap((item, index): any => additions(item, neu[index], `${at}[]`, expandNewPaths));
      }
      assert.deepEqual(neu, old, `${at} changed`);
      return [];
    }
    if (old === null || typeof old !== 'object') {
      if (isNamedInputAction(at, old, neu)) return [];
      assert.deepEqual(neu, old, `${at} changed`);
      return [];
    }
    assert.ok(neu && typeof neu === 'object' && !Array.isArray(neu), `${at} is no longer an object`);
    const added: any = [];
    for (const key of Object.keys(neu)) {
      if (key in old) continue;
      const childPath: any = `${at}.${key}`;
      // Expand only the documented limits object so its individual keys remain pinned.
      if (expandNewPaths.includes(childPath) && neu[key] && typeof neu[key] === 'object' && !Array.isArray(neu[key])) {
        added.push(...additions({}, neu[key], childPath, expandNewPaths));
      } else {
        added.push(childPath);
      }
    }
    for (const key of Object.keys(old)) {
      assert.ok(key in neu, `${at}.${key} was removed`);
      added.push(...additions(old[key], neu[key], `${at}.${key}`, expandNewPaths));
    }
    return added;
  }

  test('every chain verb prints the same bytes as the v1.13.0 runtime, apart from time and generated ids', (t) => {
    const legacy = legacyRuntime();
    if (!legacy) { t.skip(SKIP_NO_TAG); return; }
    assert.doesNotMatch(rtWith(legacy, REPO, ['--help']).stdout, /followup|lifecycle/, 'the extracted runtime really is the old one');
    assert.match(rtWith(REPO, REPO, ['--help']).stdout, /followup/);

    const seed = legacyProject(legacy, 'equiv-seed', slug);
    const oldDir = tempDir(t, 'doflow-lifecycle-loop-e2e-equiv-old-');
    const newDir = tempDir(t, 'doflow-lifecycle-loop-e2e-equiv-new-');
    fs.cpSync(seed, oldDir, { recursive: true });
    fs.cpSync(seed, newDir, { recursive: true });
    const norm = normaliser([legacy, REPO], oldDir, newDir);

    const added: any = new Set();
    const contextPackAdditions: any = new Set();
    for (const args of sequence) {
      const label = args.slice(0, 3).join(' ');
      const was = rtWith(legacy, oldDir, args);
      const now = rtWith(REPO, newDir, args);
      assert.equal(was.status, 0, `${label}: the v1.13.0 side must answer, or the comparison is of two usage errors: ${was.stdout}${was.stderr}`);
      assert.ok(was.stdout.trim().length > 0, `${label}: nothing to compare`);
      assert.equal(now.status, was.status, `${label}: exit status`);
      assert.equal(norm(now.stderr), norm(was.stderr), `${label}: stderr`);
      if (norm(now.stdout) === norm(was.stdout)) continue;
      // Not identical: the new runtime may only have added fields; nothing the old one printed may change.
      let oldJson;
      let newJson;
      try { oldJson = JSON.parse(norm(was.stdout)); newJson = JSON.parse(norm(now.stdout)); } catch { assert.fail(`${label}: stdout differs and is not JSON\n--- v1.13.0\n${norm(was.stdout)}\n--- now\n${norm(now.stdout)}`); }
      // IC-004 adds the context-pack envelope; IC-003 adds the expansion result fields. The
      // explicit allowlist keeps every other verb and every undocumented pack field pinned.
      const packAdditions: any = new Set([
        '$.status', '$.exitCode', '$.mode', '$.budget', '$.overflow', '$.overflowAction',
        '$.toolLimitNotice', '$.verificationRequirements', '$.scopeExcluded', '$.blockingGaps',
        '$.mandatory', '$.pointers', '$.structuralContext', '$.budgetEnforcement', '$.expansion',
        '$.expansionRecorded', '$.acceptanceCriteria', '$.omissions', '$.size', '$.accounting',
        '$.delivery', '$.delta', '$.packEnd',
        '$.budgetEnforcement.totalFiles', '$.budgetEnforcement.totalSupportedClaims',
        '$.budgetEnforcement.totalActiveHypotheses', '$.budgetEnforcement.limits.maxFiles',
        '$.budgetEnforcement.limits.maxClaims', '$.budgetEnforcement.limits.maxEvidenceItems',
        '$.budgetEnforcement.limits.maxResearchRequests', '$.budgetEnforcement.limits.maxStructuralItems',
      ]);
      const contextPack = args[0] === 'context-pack';
      const expansionPaths: any = contextPack
        ? ['$.budgetEnforcement', '$.budgetEnforcement.limits']
        : [];
      for (const field of additions(oldJson, newJson, '$', expansionPaths)) {
        const entry = `${label}: ${field}`;
        added.add(entry);
        if (contextPack) contextPackAdditions.add(entry);
      }
      if (contextPack) {
        const unexpectedPackFields = [...added]
          .filter((entry: any) => entry.startsWith(`${label}: `))
          .map((entry: any) => entry.slice(label.length + 2))
          .filter((field) => !packAdditions.has(field));
        assert.deepEqual(unexpectedPackFields, [], 'context-pack adds only fields documented by IC-003 and IC-004');
      }
    }
    // Feature 058 records every readiness evaluation: the verb's JSON names the record and the
    // declared scope, and the record is one new file. Nothing else may be added.
    // Feature 062 adds the stage's MCP record and its warnings to a handoff's JSON; its text mode
    // prints them, and --json prints nothing extra, so stderr above is still compared byte for byte.
    const recordAdditions: any = [
      'classify --task-class feature: $.secondOpinion', // IC-010: null when no second opinion was requested.
      'readiness --task-class feature: $.record', 'readiness --task-class feature: $.declaredScope',
      'readiness --task-class feature: $.requirements[].reasonCode', // 076 IC-018: null when no reason code applies.
      'readiness --task-class feature: $.staleAbsence', // 076 IC-018: query-bound absence report.
      'readiness --task-class feature: $.carriedFromLastRecord', // maint-thin 4(b): inputs carried from the task's last readiness record.
      'evidence --task-id 045-legacy-shape: $.evidence[].freshness.isDirty', // IC-004: source version for file locators.
      'paths --json: $.feature_root', // 115 IC-005: the checkout holding the feature folder.
      'orchestrate --action handoff: $.consultations', 'orchestrate --action handoff: $.mcpWarnings',
      // 092 IC-002: every printed snapshot carries the journal revision (0 for a journal that predates revisions).
      'orchestrate --action start: $.revision', 'orchestrate --action handoff: $.revision', 'orchestrate --action status: $.revision',
      // 118 IC-001: every workflow stage names the agent that leads it; classify and orchestrate print the stage.
      'classify --task-class feature: $.workflow.stages[].agent', 'classify --task-class feature: $.workflow.terminalStage.agent',
      'orchestrate --action start: $.terminalStage.agent', 'orchestrate --action handoff: $.terminalStage.agent', 'orchestrate --action status: $.terminalStage.agent',
      // The printed `current` names the agent leading the stage it points at.
      'orchestrate --action start: $.current.agent', 'orchestrate --action handoff: $.current.agent', 'orchestrate --action status: $.current.agent',
    ];
    assert.deepEqual([...added].filter((a: any) => !recordAdditions.includes(a) && !contextPackAdditions.has(a)), [], 'the new runtime adds nothing to a chain verb\'s output');

    // The state matches, with the readiness record and the delivery record written by their verbs.
    const filesOf = (dir: any) => fs.readdirSync(dir, { recursive: true }).filter((f: any) => !f.startsWith('.git') && fs.statSync(path.join(dir, f)).isFile()).sort();
    const readinessStore = path.join('.doflow', 'state', 'readiness') + path.sep;
    assert.deepEqual(filesOf(newDir).filter((f: any) => !f.startsWith(readinessStore)), [...filesOf(oldDir), path.join('.doflow', 'state', '.gitignore'), path.join('.doflow', 'state', 'delivery', `${slug}.json`)].sort(), 'the same files exist after the same verbs, plus the state ignore and delivery files');
    assert.deepEqual(filesOf(newDir).filter((f: any) => f.startsWith(readinessStore)), [path.join(readinessStore, `${slug}.json`)], 'one readiness record');
  });
});

describe('Scenario: Older features are untouched (NFR-001)', { skip: SKIP }, () => {
  test('discovery, release and maintain leave a v1.13.0 feature folder and run exactly as they were, and list none of its prose follow-ups', (t) => {
    const legacy = legacyRuntime();
    if (!legacy) { t.skip(SKIP_NO_TAG); return; }
    const slug = '045-older-feature';
    const dir = legacyProject(legacy, 'older', slug);
    const feature = path.join(dir, 'agent-docs', 'doflow', slug);
    // The run, as v1.13.0 recorded it, and a state.md holding prose follow-ups the way older features did.
    const started = rtWith(legacy, dir, ['orchestrate', '--action', 'start', '--task-id', slug, '--task-class', 'feature', '--json']);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    fs.writeFileSync(path.join(feature, 'state.md'), '# State\n\n## Follow-ups\n\n- Tidy the exporter after the release\n- Out of scope: rewrite the renderer\n');

    const hashes = () => {
      const out: any = {};
      for (const root of [feature, path.join(dir, '.doflow', 'state')]) {
        for (const rel of fs.readdirSync(root, { recursive: true })) {
          const file = path.join(root, rel);
          if (fs.statSync(file).isFile()) out[path.relative(dir, file)] = fs.readFileSync(file, 'utf8');
        }
      }
      return out;
    };
    const before = hashes();
    assert.ok(Object.keys(before).some((f) => f.includes('orchestration')), 'the old run state exists');
    const git = gitSnapshot({ dir, git: (...a: any[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: scratch.env() }).stdout.trim() });
    const T = new Date().toISOString();

    const discovery = ok(dir, ['lifecycle']);
    assert.deepEqual(discovery.followups, { open: 0, shown: 0, items: [] }, 'none of the old prose follow-ups appear');
    assert.deepEqual(discovery.features, { finished: [], awaitingRelease: [], inProgress: [], unknown: [] }, 'an older feature is untracked, so no status is derived');
    const release = ok(dir, ['lifecycle', '--action', 'release', '--tag', 'v1.13.0']);
    assert.deepEqual([release.recorded, release.candidates, release.notDetected], [false, [], []]);
    const maintain = ok(dir, ['lifecycle', '--maintain', '--since', T]);
    assert.equal(maintain.pending, 0);
    assert.equal(maintain.followups.open, 0);
    assert.equal(ok(dir, ['followup', '--action', 'list', '--state', 'all']).count, 0);
    const untracked = rt(dir, ['lifecycle', '--action', 'status', '--slug', slug, '--json']);
    assert.equal(untracked.status, 1);
    assert.equal(untracked.json.finding, 'untracked-feature');

    // The run still resumes under the new runtime, and everything old is byte-for-byte where it was.
    const status = rt(dir, ['orchestrate', '--action', 'status', '--task-id', slug, '--task-class', 'feature', '--json']);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).taskId, slug);
    assert.deepEqual(hashes(), { ...before, [path.join('.doflow', 'state', '.gitignore')]: `${require('../../core/registry/storage.json').settings.ignoreFile.lines.join('\n')}\n` }, 'the feature folder and the run state are unchanged, apart from the new state ignore file');
    for (const rel of [['.doflow', 'state', 'lifecycle'], ['agent-docs', 'lifecycle']]) {
      assert.equal(fs.existsSync(path.join(dir, ...rel)), false, `reading wrote no ${rel.join('/')}`);
    }
    assertGitUntouched({ dir, git: (...a: any[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: scratch.env() }).stdout.trim() }, git);
  });
});

describe('Reads create no store', { skip: SKIP }, () => {
  test('lifecycle overview, followup list and goal list in a project with no store create neither store folder', () => {
    const repo = newProject('no-store');
    const git = gitSnapshot(repo);
    assert.deepEqual(ok(repo.dir, ['followup', '--action', 'list']).items, []);
    assert.equal(ok(repo.dir, ['lifecycle', '--action', 'overview']).ok, true);
    assert.deepEqual(ok(repo.dir, ['goal', '--action', 'list']).goals, []);
    for (const rel of [['.doflow', 'state', 'lifecycle'], ['agent-docs', 'lifecycle']]) {
      assert.equal(fs.existsSync(path.join(repo.dir, ...rel)), false, `reading created no ${rel.join('/')}`);
    }
    assert.equal(fs.existsSync(path.join(repo.dir, '.doflow')), false, 'and no .doflow folder');
    assertGitUntouched(repo, git);
  });
});

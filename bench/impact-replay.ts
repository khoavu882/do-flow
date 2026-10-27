'use strict';

/**
 * Impact replay benchmark (feature 089, IC-010, DD-7..DD-9).
 *
 * Walks historical non-merge commits reachable from --rev, exports each into a scratch directory,
 * verifies that co-changed tests pass at baseline, restores changed non-test files to their parent
 * versions, and runs the co-changed tests again to find the detecting set.
 *
 * Computes impact selection over the changed non-test files at the commit to identify misses
 * and full expansions, and renders a report with an automated verdict.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

// STATIC require: Guard G16 counts bench/ as a consumer root
const { selectImpactedTests } = require('../src/runtime/verification/impact.ts');
const { conventionFor } = require('../src/runtime/verification/test-selection.ts');

const REPO_ROOT = path.resolve(__dirname, '..');

const isNum = (x: any) => typeof x === 'number' && Number.isFinite(x);
const isObject = (x: any) => x !== null && typeof x === 'object' && !Array.isArray(x);
const show = (x: any) => (x === undefined ? 'undefined' : typeof x === 'number' ? String(x) : JSON.stringify(x));

/** Normalises a repository-relative path. */
function normalize(file: string) {
  return String(file).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

/**
 * Validates and loads the `impactReplay` block from config.
 */
function loadImpactReplayConfig(cfg: any) {
  const c = isObject(cfg) ? cfg.impactReplay : undefined;
  const refuse = (reason: string) => new Error(`bench/config.json impactReplay is invalid: ${reason}`);
  if (!isObject(c)) throw refuse(`block must be an object, got ${show(c)}`);
  if (!Number.isInteger(c.commits) || c.commits <= 0) {
    throw refuse(`commits must be a positive integer, got ${show(c.commits)}`);
  }
  if (!Number.isInteger(c.minCommits) || c.minCommits <= 0) {
    throw refuse(`minCommits must be a positive integer, got ${show(c.minCommits)}`);
  }
  if (!isNum(c.ceiling) || !(c.ceiling > 0 && c.ceiling <= 1)) {
    throw refuse(`ceiling must be a number with 0 < ceiling <= 1, got ${show(c.ceiling)}`);
  }
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs <= 0) {
    throw refuse(`timeoutMs must be a positive integer, got ${show(c.timeoutMs)}`);
  }
  return {
    commits: c.commits,
    minCommits: c.minCommits,
    ceiling: c.ceiling,
    timeoutMs: c.timeoutMs,
    note: typeof c.note === 'string' ? c.note : undefined,
  };
}

/**
 * Computes the median of an array of numbers. Empty array returns null.
 */
function computeMedian(numbers: number[]) {
  if (!Array.isArray(numbers) || numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) {
    return sorted[Math.floor(n / 2)];
  }
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Computes the selected fraction for a single evaluated commit.
 * A full expansion counts as 1.0.
 */
function computeSelectedFraction(commit: any) {
  if (!commit || commit.mode === 'full') return 1.0;
  if (!commit.totalCount || commit.totalCount <= 0) return 0;
  return commit.selectedCount / commit.totalCount;
}

/**
 * Computes the median selected fraction across evaluated commits.
 * Counts full expansions as 1.0; returns null when empty.
 */
function computeMedianSelectedFraction(evaluatedCommits: any[]) {
  if (!Array.isArray(evaluatedCommits) || evaluatedCommits.length === 0) return null;
  const fractions = evaluatedCommits.map(computeSelectedFraction);
  return computeMedian(fractions);
}

/**
 * Determines the closed verdict per IC-010:
 * - insufficient-data when evaluated < minCommits
 * - else keep-off when missedTotal > 0 or medianSelectedFraction >= ceiling
 * - else selection-candidate
 */
function determineVerdict({ evaluated, minCommits, missedTotal, medianSelectedFraction, ceiling }: any) {
  if (evaluated < minCommits) return 'insufficient-data';
  if (missedTotal > 0 || (medianSelectedFraction !== null && medianSelectedFraction >= ceiling)) {
    return 'keep-off';
  }
  return 'selection-candidate';
}

function isSrcModule(file: string) {
  const norm = normalize(file);
  return norm.startsWith('src/') && /\.[cm]?[jt]sx?$/.test(norm);
}

/**
 * Checks whether a commit qualifies:
 * changes at least one `src/**` module AND at least one test file.
 */
function qualifiesCommit({ changedFiles, isTest }: any) {
  if (!Array.isArray(changedFiles) || typeof isTest !== 'function') return false;
  let hasSrc = false;
  let hasTest = false;
  for (const f of changedFiles) {
    if (isSrcModule(f)) hasSrc = true;
    if (isTest(f)) hasTest = true;
    if (hasSrc && hasTest) return true;
  }
  return false;
}

/**
 * Derives testDirs generically from package.json `scripts.test` if simple, else defaults to ['test'].
 * Shell quotes around a word are not part of the path (`node --test "test/**\/*.test.js"`), and a script that
 * delegates to another package script (`npm run x`) names no directory.
 */
function deriveTestDirs(pkg: any) {
  if (pkg && pkg.scripts && typeof pkg.scripts.test === 'string') {
    const parts = pkg.scripts.test.split(/\s+/).map((p: string) => p.replace(/^["']+|["']+$/g, ''));
    if (!['npm', 'pnpm', 'yarn', 'npx'].includes(parts[0])) {
      const testArgs = parts.filter((p: string) => p && !p.startsWith('-') && p !== 'node');
      const dirs = testArgs
        .map((a: string) => a.replace(/\/\*\*.*$/, '').replace(/\/[^/]*$/, ''))
        .filter((d: string) => d && !d.includes('*'));
      const unique = [...new Set(dirs.map(normalize))];
      if (unique.length > 0) return unique;
    }
  }
  return ['test'];
}

/**
 * Parses `git diff-tree --no-commit-id --name-status -r -z <sha>`.
 */
function parseDiffTree(raw: string) {
  const tokens = raw.split('\0').filter(Boolean);
  const changed = [];
  const added = [];
  const deleted = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) break;
    const statusCode = status[0];
    if (statusCode === 'R' || statusCode === 'C') {
      const oldPath = normalize(tokens[i++]);
      const newPath = normalize(tokens[i++]);
      changed.push(newPath);
      deleted.push(oldPath);
      added.push(newPath);
    } else {
      const filePath = normalize(tokens[i++]);
      changed.push(filePath);
      if (statusCode === 'A') added.push(filePath);
      else if (statusCode === 'D') deleted.push(filePath);
    }
  }
  return { changed: [...new Set(changed)], added: [...new Set(added)], deleted: [...new Set(deleted)] };
}

/**
 * Parses failing test files from TAP reporter output.
 */
function extractFailingTestsFromTap(tapOutput: string, exportRoot: string, testFiles: string[]) {
  const failing = new Set();
  const normalizedTestFiles = testFiles.map(normalize);
  const lines = tapOutput.split('\n');
  let inNotOk = false;
  for (const line of lines) {
    if (/^not ok\b/.test(line)) {
      inNotOk = true;
      for (const tf of normalizedTestFiles) {
        if (line.includes(tf)) failing.add(tf);
      }
    } else if (/^ok\b/.test(line)) {
      inNotOk = false;
    }
    if (inNotOk) {
      const match = line.match(/\blocation:\s*['"]?([^:'"]+)/);
      if (match) {
        const fullOrRel = match[1];
        const rel = path.isAbsolute(fullOrRel)
          ? normalize(path.relative(exportRoot, fullOrRel))
          : normalize(fullOrRel);
        for (const tf of normalizedTestFiles) {
          if (rel === tf || rel.endsWith('/' + tf) || tf.endsWith('/' + rel)) {
            failing.add(tf);
          }
        }
      }
    }
  }

  // If exit was non-zero and not ok was logged, but no specific file matched:
  if (failing.size === 0 && /^not ok\b/m.test(tapOutput)) {
    if (normalizedTestFiles.length === 1) {
      failing.add(normalizedTestFiles[0]);
    }
  }

  return [...failing].sort();
}

/**
 * Runs a set of test files in an export directory under a scratch HOME.
 */
function runTestsInExport({ exportDir, testFiles, timeoutMs }: any) {
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-replay-home-'));
  const scratchXdg = path.join(scratchHome, '.config');
  fs.mkdirSync(scratchXdg, { recursive: true });

  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NODE_DISABLE_COLORS;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  env.HOME = scratchHome;
  env.XDG_CONFIG_HOME = scratchXdg;

  const t0 = process.hrtime.bigint();
  let result: any;
  try {
    result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
      cwd: exportDir,
      env,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } finally {
    try {
      fs.rmSync(scratchHome, { recursive: true, force: true });
    } catch {
      // ignore scratch cleanup failure
    }
  }
  const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const isFailed = Boolean(
    result.error ||
    result.status !== 0 ||
    result.signal ||
    /^not ok\b/m.test(result.stdout || '')
  );

  return {
    isFailed,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    signal: result.signal,
    durationMs,
  };
}

/**
 * Exports a commit to a scratch directory via git archive.
 */
function exportCommit({ repoRoot, sha, targetDir }: any) {
  const tarBuffer = execFileSync('git', ['archive', '--format=tar', sha], {
    cwd: repoRoot,
    maxBuffer: 100 * 1024 * 1024,
  });
  spawnSync('tar', ['-xf', '-', '-C', targetDir], {
    input: tarBuffer,
    maxBuffer: 100 * 1024 * 1024,
  });
}

/**
 * Replays qualifying historical commits and produces the IC-010 report.
 */
function replayCommits({
  repoRoot = REPO_ROOT,
  rev = 'HEAD',
  commitsCount = 60,
  minCommits = 20,
  ceiling = 0.5,
  timeoutMs = 120000,
  outPath = null,
  tmpDir = os.tmpdir(),
  skipBaseline = false,
  warn = (line: any) => process.stderr.write(`${line}\n`),
}: any = {}) {
  // 1. Get non-merge commits reachable from rev
  const logOutput = execFileSync('git', ['log', '--no-merges', '--format=%H', rev], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const allShas = logOutput.split('\n').map((s: string) => s.trim()).filter(Boolean);

  // 2. Discover qualifying commits
  const qualifyingCommits: any[] = [];
  for (const sha of allShas) {
    if (qualifyingCommits.length >= commitsCount) break;

    // Check parent exists (non-merge commits reachable from rev)
    let parentSha;
    try {
      parentSha = execFileSync('git', ['rev-parse', '--verify', `${sha}^`], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
    } catch {
      // Root commit has no parent
      continue;
    }

    const diffRaw = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', sha], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    const diff = parseDiffTree(diffRaw);

    // Initial check: must change at least one src/** module and at least one test file
    const isTestCandidate = (f: string) => f.includes('test') && /\.test\.[cm]?[jt]sx?$/.test(f);
    if (!qualifiesCommit({ changedFiles: diff.changed, isTest: isTestCandidate })) {
      continue;
    }

    qualifyingCommits.push({ sha, parentSha, diff });
  }

  const commitResults: any[] = [];
  const unevaluableCounts: Record<string, number> = {};
  let skippedByConvention = 0;

  // 3. Process each qualifying commit
  for (const { sha, parentSha, diff } of qualifyingCommits) {
    const exportDir = fs.mkdtempSync(path.join(tmpDir, `impact-replay-${sha.slice(0, 8)}-`));
    let totalRunMs = 0;

    try {
      // Export repository at sha
      exportCommit({ repoRoot, sha, targetDir: exportDir });

      // Load package.json in export
      let pkg = null;
      const pkgPath = path.join(exportDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        } catch {
          // ignore
        }
      }

      const testDirs = deriveTestDirs(pkg);
      const found = { source: 'package.json', testDirs };
      const convention = conventionFor(found);
      const isTest = convention ? convention.isTest : (f: string) => f.includes('test') && /\.test\.[cm]?[jt]sx?$/.test(f);

      // Verify that this commit qualifies under the exact convention
      if (!qualifiesCommit({ changedFiles: diff.changed, isTest })) {
        skippedByConvention += 1;
        continue;
      }

      const changedSrc = diff.changed.filter(isSrcModule).sort();
      const coChangedTests = diff.changed.filter((f: string) => isTest(f) && !diff.deleted.includes(f)).sort();

      if (coChangedTests.length === 0) {
        // No co-changed tests exist at the commit
        skippedByConvention += 1;
        continue;
      }

      // Step 1: Baseline run
      let baselineFailed = false;
      if (!skipBaseline) {
        const baselineResult = runTestsInExport({
          exportDir,
          testFiles: coChangedTests,
          timeoutMs,
        });
        totalRunMs += baselineResult.durationMs;
        if (baselineResult.isFailed) {
          baselineFailed = true;
        }
      }

      if (baselineFailed) {
        unevaluableCounts['baseline-fail'] = (unevaluableCounts['baseline-fail'] || 0) + 1;
        commitResults.push({
          sha,
          changedSrc,
          coChangedTests,
          mode: null,
          selectedCount: 0,
          totalCount: 0,
          unknownFiles: [],
          detecting: [],
          missed: [],
          selectorMs: 0,
          runMs: Math.round(totalRunMs),
          status: 'unevaluable: baseline-fail',
        });
        continue;
      }

      // Step 2: Impact test selection at commit sha
      const changedNonTest = diff.changed.filter((f: string) => !isTest(f)).sort();
      const deletedNonTest = diff.deleted.filter((f: string) => !isTest(f)).sort();

      const tSel0 = process.hrtime.bigint();
      const selection = selectImpactedTests({
        root: exportDir,
        found,
        changedFiles: changedNonTest,
        deletedFiles: deletedNonTest,
        fsImpl: fs,
      }) || { mode: 'full', tests: [], totalCount: 0, unknownFiles: [], spawnTests: 0, graphMs: 0 };
      const selectorMs = Number(process.hrtime.bigint() - tSel0) / 1e6;

      // Step 3: Restore every changed non-test file to the parent version
      for (const file of changedNonTest) {
        const fullExportPath = path.join(exportDir, file);
        if (diff.added.includes(file)) {
          // File was added in sha; delete from export
          fs.rmSync(fullExportPath, { force: true, recursive: true });
        } else {
          // File was modified or deleted; restore from parent
          try {
            const parentBytes = execFileSync('git', ['show', `${parentSha}:${file}`], {
              cwd: repoRoot,
              maxBuffer: 50 * 1024 * 1024,
            });
            fs.mkdirSync(path.dirname(fullExportPath), { recursive: true });
            fs.writeFileSync(fullExportPath, parentBytes);
          } catch {
            // If show fails (e.g. absent), delete it
            fs.rmSync(fullExportPath, { force: true, recursive: true });
          }
        }
      }

      // Step 4: Detecting run (run co-changed tests again)
      const detectResult = runTestsInExport({
        exportDir,
        testFiles: coChangedTests,
        timeoutMs,
      });
      totalRunMs += detectResult.durationMs;

      let detecting: any[] = [];
      if (detectResult.isFailed) {
        detecting = extractFailingTestsFromTap(detectResult.stdout, exportDir, coChangedTests);
        // Fallback: if multiple tests were run and TAP attribution found nothing, run each individually
        if (detecting.length === 0 && coChangedTests.length > 1) {
          for (const testFile of coChangedTests) {
            const singleRes = runTestsInExport({ exportDir, testFiles: [testFile], timeoutMs });
            if (singleRes.isFailed) detecting.push(testFile);
          }
        }
      }
      detecting.sort();

      // Step 5: Misses
      // A full expansion misses nothing
      let missed: string[] = [];
      if (selection.mode === 'selected') {
        const selectedSet = new Set(selection.tests);
        missed = detecting.filter((t) => !selectedSet.has(t)).sort();
      }

      commitResults.push({
        sha,
        changedSrc,
        coChangedTests,
        mode: selection.mode,
        selectedCount: selection.tests.length,
        totalCount: selection.totalCount,
        unknownFiles: selection.unknownFiles,
        detecting,
        missed,
        selectorMs: Math.round((selection.graphMs || selectorMs) * 100) / 100,
        runMs: Math.round(totalRunMs),
        status: 'evaluated',
      });
    } finally {
      // Always remove export directory
      try {
        fs.rmSync(exportDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // 4. Compute summary
  const evaluatedCommits = commitResults.filter((c) => c.status === 'evaluated');
  const evaluated = evaluatedCommits.length;
  const qualified = commitResults.length;
  const withMisses = evaluatedCommits.filter((c) => c.missed.length > 0).length;
  const missedTotal = evaluatedCommits.reduce((acc, c) => acc + c.missed.length, 0);
  const fullExpansions = evaluatedCommits.filter((c) => c.mode === 'full').length;
  const medianSelectedFraction = computeMedianSelectedFraction(evaluatedCommits);
  const verdict = determineVerdict({
    evaluated,
    minCommits,
    missedTotal,
    medianSelectedFraction,
    ceiling,
  });

  const report = {
    v: 1,
    rev,
    config: {
      commits: commitsCount,
      minCommits,
      ceiling,
      timeoutMs,
    },
    commits: commitResults,
    summary: {
      qualified,
      evaluated,
      unevaluable: unevaluableCounts,
      withMisses,
      missedTotal,
      fullExpansions,
      medianSelectedFraction,
      verdict,
    },
    bounds: 'detecting set is a lower bound: only co-changed tests run',
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  // The report shape is closed (IC-010): a convention that drops every candidate is made visible on stderr only.
  if (skippedByConvention > 0 && qualified < commitsCount) {
    warn(`skipped ${skippedByConvention} candidate commits that did not qualify under the test convention`);
  }

  return report;
}

/**
 * Runner dispatch entrypoint for `bench impact-replay`.
 */
function cmdImpactReplay(cfg: any, opts: any) {
  let impactCfg;
  try {
    impactCfg = loadImpactReplayConfig(cfg);
  } catch (err: any) {
    console.error(`bench: ${err.message}`);
    return 2;
  }

  const rev = typeof opts.rev === 'string' && opts.rev.trim() ? opts.rev.trim() : 'HEAD';

  let commitsCount = impactCfg.commits;
  if (opts.commits !== undefined) {
    const parsed = Number(opts.commits);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error('bench impact-replay: --commits must be a positive integer');
      return 2;
    }
    commitsCount = parsed;
  }

  // Compute default output file path if not specified
  let outPath = opts.out;
  if (!outPath) {
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..*$/, 'Z');
    outPath = path.join(REPO_ROOT, 'bench', 'runs', 'impact-replay', `${stamp}.json`);
  }

  let report;
  try {
    report = replayCommits({
      repoRoot: REPO_ROOT,
      rev,
      commitsCount,
      minCommits: impactCfg.minCommits,
      ceiling: impactCfg.ceiling,
      timeoutMs: impactCfg.timeoutMs,
      outPath,
    });
  } catch (err: any) {
    console.error(`bench impact-replay fault: ${err.message}`);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const s = report.summary;
    const med = s.medianSelectedFraction !== null ? s.medianSelectedFraction.toFixed(4) : 'none';
    console.log(`bench impact-replay: ${s.verdict}`);
    console.log(`  rev: ${report.rev}`);
    console.log(`  commits: ${s.evaluated} evaluated of ${s.qualified} qualified`);
    if (Object.keys(s.unevaluable).length > 0) {
      console.log(`  unevaluable: ${JSON.stringify(s.unevaluable)}`);
    }
    console.log(`  missed detecting tests: ${s.missedTotal} (across ${s.withMisses} commit(s))`);
    console.log(`  full expansions: ${s.fullExpansions}`);
    console.log(`  median selected fraction: ${med}`);
    console.log(`  report: ${path.relative(REPO_ROOT, path.resolve(outPath))}`);
  }

  return 0;
}

module.exports = {
  loadImpactReplayConfig,
  computeMedian,
  computeSelectedFraction,
  computeMedianSelectedFraction,
  determineVerdict,
  qualifiesCommit,
  deriveTestDirs,
  parseDiffTree,
  extractFailingTestsFromTap,
  replayCommits,
  cmdImpactReplay,
};

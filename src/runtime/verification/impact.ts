'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Impacted test selector (feature 089, IC-009, DD-7, DD-8).
 *
 * Statically discovers tests impacted by changed files through relative import/require graph
 * traversal, wildcard spawn-test reachability, guard directory inclusion, and unknown-file
 * fallback to the full test suite.
 */

const path = require('node:path');
const nodeFs = require('node:fs');
const { conventionFor, testFilesFor, GUARD_DIR } = require('./test-selection.ts');

const DISPATCHER_RE = /bin\/doflow|doflow-run/;
const CP_FUNCS = /\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(/;
const CP_TOKEN = ['child', 'process'].join('_');
const CP_RE = new RegExp(CP_TOKEN);

/** Normalises a repository-relative path: forward slashes, no leading `./`, no trailing `/`. */
function normalize(file: any): string {
  return String(file).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

function statOf(fsImpl: any, file: string): any {
  try {
    return fsImpl.statSync(file);
  } catch {
    return null;
  }
}

/** Determines whether a test file spawns the CLI / dispatcher and reaches every module. */
function isSpawnTest(text: string): boolean {
  if (!DISPATCHER_RE.test(text)) return false;
  if (CP_FUNCS.test(text)) return true;
  if (CP_RE.test(text) && /\bexec\s*\(/.test(text)) return true;
  if (/(?:^|[^.\w$])exec\s*\(/.test(text)) return true;
  return false;
}

/** Extracts static relative specifiers starting with `.` from file text. */
function extractRelativeSpecifiers(text: string): string[] {
  const specs = new Set<string>();
  // call forms: require and dynamic import with a literal relative specifier
  const callPattern = /\b(?:require|import)\s*\(\s*(['"`])(\.[^'"`]*)\1\s*\)/g;
  for (const match of text.matchAll(callPattern)) {
    specs.add(match[2]);
  }
  // static import and re-export forms with a from clause
  const fromPattern = /\b(?:import|export)\b(?:(?!import|export)[^;])*?\bfrom\s*(['"`])(\.[^'"`]*)\1/g;
  for (const match of text.matchAll(fromPattern)) {
    specs.add(match[2]);
  }
  // side-effect import with a literal specifier
  const sideImportPattern = /\bimport\s+(['"`])(\.[^'"`]*)\1/g;
  for (const match of text.matchAll(sideImportPattern)) {
    specs.add(match[2]);
  }
  return [...specs];
}

/** Resolves a relative specifier against `fromFile` checking exact, .ts, .js, /index.ts, /index.js. */
function resolveRelativeSpecifier(fromFile: string, spec: string, root: string, fsImpl: any): string | null {
  if (!spec.startsWith('.')) return null;
  const fromDir = path.dirname(fromFile);
  const targetBase = normalize(path.join(fromDir, spec));

  const candidates = [
    targetBase,
    `${targetBase}.ts`,
    `${targetBase}.js`,
    `${targetBase}/index.ts`,
    `${targetBase}/index.js`,
  ];
  if (targetBase.endsWith('.js')) {
    candidates.push(`${targetBase.slice(0, -3)}.ts`);
  }

  for (const candidate of candidates) {
    const absPath = path.join(root, candidate);
    try {
      const stat = fsImpl.statSync(absPath);
      if (stat && stat.isFile()) {
        return normalize(candidate);
      }
    } catch {
      // not found
    }
  }
  return null;
}

/** Checks whether a path belongs to the monitored module roots: src/**, bin/**, bench/**. */
function isModulePath(file: string): boolean {
  return file.startsWith('src/') || file.startsWith('bin/') || file.startsWith('bench/');
}

/**
 * Selects impacted tests for a set of changed files based on static dependency analysis (IC-009).
 *
 * @param {Object} input
 * @param {string} input.root project root directory
 * @param {Object} input.found detected testTargeted entry (from detectCommands)
 * @param {Array<string>} [input.changedFiles] changed repo-relative file paths
 * @param {Array<string>} [input.deletedFiles] deleted repo-relative file paths
 * @param {Object} [input.fsImpl] filesystem implementation (defaults to node:fs)
 * @returns {null|{ mode: "selected" | "full", tests: Array<string>, totalCount: number, unknownFiles: Array<string>, spawnTests: number, graphMs: number }}
 */
function selectImpactedTests({
  root,
  found,
  changedFiles = [],
  deletedFiles = [],
  fsImpl = nodeFs,
}: {
  root: string;
  found: any;
  changedFiles?: string[];
  deletedFiles?: string[];
  fsImpl?: any;
}): any {
  const convention = conventionFor(found);
  if (!convention) return null;

  const t0 = process.hrtime.bigint();

  const allTests: string[] = testFilesFor(found, root, fsImpl);
  const totalCount = allTests.length;
  const allTestFiles = new Set<string>(allTests);

  const guardDir = convention.guardDir && statOf(fsImpl, path.join(root, convention.guardDir))?.isDirectory()
    ? convention.guardDir
    : null;
  const guardTests = guardDir
    ? allTests.filter((file: string) => file.startsWith(`${guardDir}/`) || file === guardDir)
    : [];

  const spawnTests = new Set<string>();
  const testToModules = new Map<string, Set<string>>();
  const moduleQueue: string[] = [];

  for (const testFile of allTests) {
    testToModules.set(testFile, new Set());
    let text = '';
    try {
      text = fsImpl.readFileSync(path.join(root, testFile), 'utf8');
    } catch {
      continue;
    }
    if (isSpawnTest(text)) {
      spawnTests.add(testFile);
    }
    for (const spec of extractRelativeSpecifiers(text)) {
      const resolved = resolveRelativeSpecifier(testFile, spec, root, fsImpl);
      if (resolved && isModulePath(resolved)) {
        testToModules.get(testFile)!.add(resolved);
        moduleQueue.push(resolved);
      }
    }
  }

  const moduleDependencies = new Map<string, Set<string>>();
  const scannedModules = new Set<string>();

  while (moduleQueue.length > 0) {
    const mod = moduleQueue.shift()!;
    if (scannedModules.has(mod)) continue;
    scannedModules.add(mod);

    let text = '';
    try {
      text = fsImpl.readFileSync(path.join(root, mod), 'utf8');
    } catch {
      continue;
    }

    if (!moduleDependencies.has(mod)) {
      moduleDependencies.set(mod, new Set());
    }

    for (const spec of extractRelativeSpecifiers(text)) {
      const resolved = resolveRelativeSpecifier(mod, spec, root, fsImpl);
      if (resolved && isModulePath(resolved)) {
        moduleDependencies.get(mod)!.add(resolved);
        if (!scannedModules.has(resolved)) {
          moduleQueue.push(resolved);
        }
      }
    }
  }

  const reverseModuleDeps = new Map<string, Set<string>>();
  for (const [mod, targets] of moduleDependencies.entries()) {
    for (const target of targets) {
      if (!reverseModuleDeps.has(target)) reverseModuleDeps.set(target, new Set());
      reverseModuleDeps.get(target)!.add(mod);
    }
  }

  const moduleDirectTests = new Map<string, Set<string>>();
  for (const [t, targets] of testToModules.entries()) {
    for (const target of targets) {
      if (!moduleDirectTests.has(target)) moduleDirectTests.set(target, new Set());
      moduleDirectTests.get(target)!.add(t);
    }
  }

  function testsReachingModule(targetModule: string): Set<string> {
    const reachingTests = new Set<string>();
    const visitedModules = new Set<string>([targetModule]);
    const queue = [targetModule];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const direct = moduleDirectTests.get(current);
      if (direct) {
        for (const t of direct) reachingTests.add(t);
      }
      const callers = reverseModuleDeps.get(current);
      if (callers) {
        for (const caller of callers) {
          if (!visitedModules.has(caller)) {
            visitedModules.add(caller);
            queue.push(caller);
          }
        }
      }
    }
    return reachingTests;
  }

  const normalizedChanged = (changedFiles || []).map(normalize);
  const normalizedDeleted = (deletedFiles || []).map(normalize);
  const candidateFiles = [...new Set([...normalizedChanged, ...normalizedDeleted])];

  const unknownFiles = new Set<string>();
  const selectedTests = new Set<string>();
  let hasReachedModule = false;

  for (const file of candidateFiles) {
    if (scannedModules.has(file)) {
      hasReachedModule = true;
      for (const t of testsReachingModule(file)) {
        selectedTests.add(t);
      }
    } else if (convention.isTest(file)) {
      if (allTestFiles.has(file)) {
        selectedTests.add(file);
      }
    } else {
      unknownFiles.add(file);
    }
  }

  const fullSuite = () => ({
    mode: 'full' as const,
    tests: [...allTests].sort(),
    totalCount,
    unknownFiles: [...unknownFiles].sort(),
    spawnTests: spawnTests.size,
    graphMs: Number(process.hrtime.bigint() - t0) / 1e6,
  });

  /* UNKNOWN_EXPANSION */ if (unknownFiles.size > 0) return fullSuite();

  if (hasReachedModule) {
    /* SPAWN_WILDCARD */ for (const spawnTest of spawnTests) selectedTests.add(spawnTest);
  }

  for (const guardTest of guardTests) {
    selectedTests.add(guardTest);
  }

  return {
    mode: 'selected' as const,
    tests: [...selectedTests].sort(),
    totalCount,
    unknownFiles: [],
    spawnTests: spawnTests.size,
    graphMs: Number(process.hrtime.bigint() - t0) / 1e6,
  };
}

module.exports = { selectImpactedTests, isSpawnTest, resolveRelativeSpecifier, extractRelativeSpecifiers, GUARD_DIR };

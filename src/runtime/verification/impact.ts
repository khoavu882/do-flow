'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Impacted test selector (feature 089, IC-009, DD-7, DD-8; feature 090, IC-001, IC-002).
 *
 * Statically discovers tests impacted by changed files through relative import/require graph
 * traversal, non-test helper graph inclusion, CLI hub cutting and verb scoping, wildcard
 * spawn-test reachability, guard directory inclusion, and unknown-file fallback to the full
 * test suite.
 */

const path = require('node:path');
const nodeFs = require('node:fs');
const { conventionFor, testFilesFor, GUARD_DIR } = require('./test-selection.ts');

const DISPATCHER_RE = /bin\/doflow|doflow-run(?![a-z0-9-])|(['"])bin\1\s*,\s*(['"])doflow(?:\.js)?\2/;
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

/** Determines whether a test or helper file spawns the CLI / dispatcher. */
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

/** Checks whether a path belongs to the monitored module graph: src/**, bin/**, bench/**, or test/** non-test helper. */
function isGraphNode(file: string, convention: any): boolean {
  return (
    file.startsWith('src/') ||
    file.startsWith('bin/') ||
    file.startsWith('bench/') ||
    (file.startsWith('test/') && !convention.isTest(file))
  );
}

/** Checks whether a non-code file is guard-covered and should not trigger unknown-file expansion. */
function isGuardCoveredPath(file: string, hasGuardDir: boolean): boolean {
  if (!hasGuardDir) return false;
  return (
    file === 'CHANGELOG.md' ||
    file === 'AGENTS.md' ||
    file === 'CLAUDE.md' ||
    file.startsWith('docs/') ||
    file.startsWith('agent-docs/') ||
    file.startsWith('.doflow/')
  );
}

/** Parses CLI dispatch hubs and lazy handler functions to map CLI verbs to their target implementation modules. */
function parseCliVerbMap(root: string, fsImpl: any): Map<string, Set<string>> {
  const verbToModules = new Map<string, Set<string>>();
  const addVerbMod = (v: string, m: string | null) => {
    if (!m) return;
    if (!verbToModules.has(v)) verbToModules.set(v, new Set());
    verbToModules.get(v)!.add(m);
  };

  for (const hub of ['src/cli/runtime-commands.ts', 'src/cli/index.ts']) {
    let text = '';
    try {
      text = fsImpl.readFileSync(path.join(root, hub), 'utf8');
    } catch {
      continue;
    }

    const symToFile = new Map<string, string>();
    const reqRe = /(?:const|let|var)\s+(\{[^}]+\}|\w+)\s*=\s*require\(\s*(['"])(\.[^'"]+)\2\s*\)/g;
    for (const m of text.matchAll(reqRe)) {
      const target = resolveRelativeSpecifier(hub, m[3], root, fsImpl);
      if (!target) continue;
      const lhs = m[1].trim();
      if (lhs.startsWith('{')) {
        for (const part of lhs.slice(1, -1).split(',')) {
          const piece = part.trim();
          if (!piece) continue;
          const [orig, alias] = piece.split(':').map((s: string) => s.trim());
          symToFile.set(alias || orig, target);
        }
      } else {
        symToFile.set(lhs, target);
      }
    }

    const fnRe = /function\s+(\w+)\s*\([^)]*\)[^{]*\{\s*return\s+require\(\s*(['"])(\.[^'"]+)\2\s*\)/g;
    for (const m of text.matchAll(fnRe)) {
      const target = resolveRelativeSpecifier(hub, m[3], root, fsImpl);
      if (target) symToFile.set(m[1], target);
    }

    const caseRe = /case\s+(['"])([a-z0-9-]+)\1\s*:\s*return\s+(\w+)\s*\(/g;
    for (const m of text.matchAll(caseRe)) {
      const verb = m[2];
      const fn = m[3];
      if (symToFile.has(fn)) addVerbMod(verb, symToFile.get(fn)!);
      const helperRe = new RegExp('function\\s+' + fn + '\\b[\\s\\S]*?\\n}', 'm');
      const hm = text.match(helperRe);
      if (hm) {
        for (const [sym, f] of symToFile.entries()) {
          if (new RegExp('\\b' + sym + '\\b').test(hm[0])) addVerbMod(verb, f);
        }
        for (const rm of hm[0].matchAll(/require\(\s*(['"])(\.[^'"]+)\1\s*\)/g)) {
          addVerbMod(verb, resolveRelativeSpecifier(hub, rm[2], root, fsImpl));
        }
      }
    }

    const cmdBlock = text.match(/\bconst\s+COMMANDS\b[\s\S]*?=\s*\{([\s\S]*?)\};/);
    if (cmdBlock) {
      for (const m of cmdBlock[1].matchAll(/(?:['"]([a-z0-9-]+)['"]|([a-z0-9-]+))\s*:\s*(\w+)/g)) {
        const verb = m[1] || m[2];
        const sym = m[3];
        if (symToFile.has(sym)) addVerbMod(verb, symToFile.get(sym)!);
      }
    }
  }

  return verbToModules;
}

/** Strips handle*Command function bodies when extracting general library dependencies of a module that also exports library functions. */
function stripCommandHandlerBodies(text: string): string {
  return text.replace(/function\s+handle\w*Command\b[\s\S]*?\n\}/gm, '');
}

/** Extracts statically invoked CLI verbs from test or helper text. */
function extractInvokedVerbs(text: string, knownVerbsSet: Set<string>): Set<string> {
  const verbs = new Set<string>();
  const arrRe = /\[\s*(?:[A-Za-z0-9_$.]+\s*,\s*)?['"`]([a-z][a-z0-9-]*)['"`]/g;
  for (const m of text.matchAll(arrRe)) {
    if (knownVerbsSet.has(m[1])) verbs.add(m[1]);
  }
  const runCallRe = /\b(?:run\w*|cli\w*|doflow\w*|exec\w*|spawn\w*)\s*\(\s*(?:[^,()\n]+\s*,\s*)?['"`]([a-z][a-z0-9-]*)['"`]/gi;
  for (const m of text.matchAll(runCallRe)) {
    if (knownVerbsSet.has(m[1])) verbs.add(m[1]);
  }
  const cmdRe = /\bdoflow(?:-run)?(?:\.js)?['"`\s,]+\s*['"`]?([a-z][a-z0-9-]*)/g;
  for (const m of text.matchAll(cmdRe)) {
    if (knownVerbsSet.has(m[1])) verbs.add(m[1]);
  }
  return verbs;
}

/**
 * Resolves all .test.* files that directly or transitively import any of the specified non-test helper files (IC-002).
 *
 * @param {Object} input
 * @param {string} input.root project root directory
 * @param {Object} input.found detected testTargeted entry (from detectCommands)
 * @param {Array<string>} [input.helperFiles] repo-relative non-test helper paths under test/**
 * @param {Object} [input.fsImpl] filesystem implementation (defaults to node:fs)
 * @returns {Array<string>} sorted list of repo-relative test paths
 */
function resolveTestsImportingHelper({
  root,
  found,
  helperFiles = [],
  fsImpl = nodeFs,
}: {
  root: string;
  found: any;
  helperFiles?: string[];
  fsImpl?: any;
}): string[] {
  const convention = conventionFor(found);
  if (!convention) return [];
  const allTests: string[] = testFilesFor(found, root, fsImpl);
  if (!allTests || allTests.length === 0 || helperFiles.length === 0) return [];

  const normalizedHelpers = new Set(helperFiles.map(normalize));
  const testFilesSet = new Set<string>(allTests);

  const directImporters = new Map<string, Set<string>>();
  const helperQueue: string[] = [];
  const scanned = new Set<string>();

  for (const testFile of allTests) {
    let text = '';
    try {
      text = fsImpl.readFileSync(path.join(root, testFile), 'utf8');
    } catch {
      continue;
    }
    for (const spec of extractRelativeSpecifiers(text)) {
      const resolved = resolveRelativeSpecifier(testFile, spec, root, fsImpl);
      if (resolved && (resolved.startsWith('test/') || resolved.startsWith('bench/') || resolved.startsWith('src/'))) {
        if (!directImporters.has(resolved)) directImporters.set(resolved, new Set());
        directImporters.get(resolved)!.add(testFile);
        if (resolved.startsWith('test/') && !convention.isTest(resolved) && !scanned.has(resolved)) {
          helperQueue.push(resolved);
        }
      }
    }
  }

  while (helperQueue.length > 0) {
    const helper = helperQueue.shift()!;
    if (scanned.has(helper)) continue;
    scanned.add(helper);

    let text = '';
    try {
      text = fsImpl.readFileSync(path.join(root, helper), 'utf8');
    } catch {
      continue;
    }

    for (const spec of extractRelativeSpecifiers(text)) {
      const resolved = resolveRelativeSpecifier(helper, spec, root, fsImpl);
      if (resolved && (resolved.startsWith('test/') || resolved.startsWith('bench/') || resolved.startsWith('src/'))) {
        if (!directImporters.has(resolved)) directImporters.set(resolved, new Set());
        directImporters.get(resolved)!.add(helper);
        if (resolved.startsWith('test/') && !convention.isTest(resolved) && !scanned.has(resolved)) {
          helperQueue.push(resolved);
        }
      }
    }
  }

  const importingTests = new Set<string>();
  const visited = new Set<string>();
  const queue = [...normalizedHelpers];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const callers = directImporters.get(current);
    if (!callers) continue;

    for (const caller of callers) {
      if (testFilesSet.has(caller)) {
        importingTests.add(caller);
      }
      if (!visited.has(caller)) {
        queue.push(caller);
      }
    }
  }

  return [...importingTests].sort();
}

/**
 * Selects impacted tests for a set of changed files based on static dependency analysis (IC-001, IC-009).
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

  const isGraphNodePath = (file: string) => isGraphNode(file, convention);

  const verbToModules = parseCliVerbMap(root, fsImpl);
  const knownVerbsSet = new Set<string>(verbToModules.keys());

  const testTexts = new Map<string, string>();
  const testToModules = new Map<string, Set<string>>();
  const moduleQueue: string[] = [];

  for (const testFile of allTests) {
    testToModules.set(testFile, new Set());
    let text = '';
    try {
      text = fsImpl.readFileSync(path.join(root, testFile), 'utf8');
      testTexts.set(testFile, text);
    } catch {
      continue;
    }
    for (const spec of extractRelativeSpecifiers(text)) {
      const resolved = resolveRelativeSpecifier(testFile, spec, root, fsImpl);
      if (resolved && isGraphNodePath(resolved)) {
        testToModules.get(testFile)!.add(resolved);
        moduleQueue.push(resolved);
      }
    }
  }

  // Queue all modules from hubs and verbToModules
  const hubs = new Set<string>(['bin/doflow.js', 'src/cli/index.ts', 'src/cli/runtime-commands.ts']);
  for (const hub of hubs) {
    if (statOf(fsImpl, path.join(root, hub))) {
      moduleQueue.push(hub);
    }
  }
  for (const mods of verbToModules.values()) {
    for (const m of mods) {
      moduleQueue.push(m);
    }
  }

  const moduleDependencies = new Map<string, Set<string>>();
  const scannedModules = new Set<string>();
  const moduleTexts = new Map<string, string>();

  function drainModuleQueue() {
    while (moduleQueue.length > 0) {
      const mod = moduleQueue.shift()!;
      if (scannedModules.has(mod)) continue;
      scannedModules.add(mod);

      let text = '';
      try {
        text = fsImpl.readFileSync(path.join(root, mod), 'utf8');
        moduleTexts.set(mod, text);
      } catch {
        continue;
      }

      if (!moduleDependencies.has(mod)) {
        moduleDependencies.set(mod, new Set());
      }

      for (const spec of extractRelativeSpecifiers(text)) {
        const resolved = resolveRelativeSpecifier(mod, spec, root, fsImpl);
        if (resolved && isGraphNodePath(resolved)) {
          if (!scannedModules.has(resolved)) {
            moduleQueue.push(resolved);
          }
        }
      }

      if (hubs.has(mod)) continue;

      const libText = stripCommandHandlerBodies(text);
      for (const spec of extractRelativeSpecifiers(libText)) {
        const resolved = resolveRelativeSpecifier(mod, spec, root, fsImpl);
        if (resolved && isGraphNodePath(resolved)) {
          moduleDependencies.get(mod)!.add(resolved);
        }
      }
    }
  }

  drainModuleQueue();

  // Scan lazy requires in handle*Command functions for verbToModules expansion
  for (const [verb, mods] of [...verbToModules.entries()]) {
    for (const mod of [...mods]) {
      const txt = moduleTexts.get(mod) || '';
      for (const fnMatch of txt.matchAll(/function\s+handle\w*Command\b[\s\S]*?\n\}/gm)) {
        for (const s of extractRelativeSpecifiers(fnMatch[0])) {
          const resolved = resolveRelativeSpecifier(mod, s, root, fsImpl);
          if (resolved) {
            mods.add(resolved);
            if (!scannedModules.has(resolved)) {
              moduleQueue.push(resolved);
            }
          }
        }
      }
    }
  }

  drainModuleQueue();

  const allSpawnTests = new Set<string>();
  const spawnTests = new Set<string>(); // wildcard spawn tests

  for (const tf of allTests) {
    const tText = testTexts.get(tf) || '';
    let spawns = isSpawnTest(tText);
    let invokedVerbs = extractInvokedVerbs(tText, knownVerbsSet);

    // Transitive helper reachability from tf to test/** helpers
    const helperQueue = [...testToModules.get(tf)!].filter((m) => m.startsWith('test/'));
    const seenHelpers = new Set<string>(helperQueue);
    while (helperQueue.length > 0) {
      const h = helperQueue.shift()!;
      const hText = moduleTexts.get(h) || '';
      if (isSpawnTest(hText)) spawns = true;
      for (const dep of (moduleDependencies.get(h) || [])) {
        if (dep.startsWith('test/') && !seenHelpers.has(dep)) {
          seenHelpers.add(dep);
          helperQueue.push(dep);
        }
      }
    }

    if (spawns && invokedVerbs.size === 0) {
      for (const h of seenHelpers) {
        for (const v of extractInvokedVerbs(moduleTexts.get(h) || '', knownVerbsSet)) {
          invokedVerbs.add(v);
        }
      }
    }

    if (spawns) {
      allSpawnTests.add(tf);

      for (const hub of hubs) {
        if (scannedModules.has(hub)) {
          testToModules.get(tf)!.add(hub);
        }
      }

      if (invokedVerbs.size > 0) {
        for (const v of invokedVerbs) {
          const mods = verbToModules.get(v);
          if (mods) {
            for (const m of mods) {
              testToModules.get(tf)!.add(m);
            }
          }
        }
      } else {
        spawnTests.add(tf);
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
      if (!file.startsWith('test/')) {
        hasReachedModule = true;
      }
      for (const t of testsReachingModule(file)) {
        selectedTests.add(t);
      }
    } else if (convention.isTest(file)) {
      if (allTestFiles.has(file)) {
        selectedTests.add(file);
      }
    } else if (isGuardCoveredPath(file, guardDir !== null)) {
      // guard-covered: verified by guardTests, does not enter unknownFiles
    } else {
      unknownFiles.add(file);
    }
  }

  const fullSuite = () => ({
    mode: 'full' as const,
    tests: [...allTests].sort(),
    totalCount,
    unknownFiles: [...unknownFiles].sort(),
    spawnTests: allSpawnTests.size,
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
    spawnTests: allSpawnTests.size,
    graphMs: Number(process.hrtime.bigint() - t0) / 1e6,
  };
}

module.exports = {
  selectImpactedTests,
  isSpawnTest,
  resolveRelativeSpecifier,
  extractRelativeSpecifiers,
  resolveTestsImportingHelper,
  GUARD_DIR,
};

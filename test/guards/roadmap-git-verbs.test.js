'use strict';

// G53 — roadmap git-verb allow-list (feature 108, FR-013, NFR-007).
//
// The roadmap loop's mechanical steps (pick, gate, merge, render, cleanup) may execute git commands,
// but only within a strict allow-list:
//   - Read verbs: version, status, rev-parse, rev-list, diff, log, show, cat-file, symbolic-ref,
//     merge-base, ls-files, hash-object, for-each-ref, check-ref-format, var, config query, worktree list
//   - Plumbing / mutating verbs (strictly governed):
//       * merge-tree: modern --write-tree only (never deprecated trivial merge)
//       * commit-tree: pinned inputs and trailers (same SHA on re-run)
//       * merge: --ff-only only (never in-place 3-way merge)
//       * worktree: add with -b, remove without force, list
//       * branch: -d only (never -D or force)
//   - Tested repair-only verbs:
//       * read-tree, 3-arg update-ref (compare-and-swap), checkout-index -a, update-index -q --refresh
//
// Every git argv in src/runtime/roadmap/** is scanned against the allow-list and the forbidden set:
//   push, fetch, pull, tag, remote, reset, stash, checkout, switch, restore, clean, rebase, -D, --force, -f
//
// Static fail-closed rule:
//   Any git argv that cannot be read statically (e.g. dynamic/computed arguments, unresolvable array
//   references, computed verbs or subcommands) FAILS CLOSED.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp');

const ROADMAP_DIR = 'src/runtime/roadmap';
const CODE_EXT_RE = /\.(ts|js|mjs|cjs)$/;

const FORBIDDEN_TOKENS = new Set([
  'push',
  'fetch',
  'pull',
  'tag',
  'remote',
  'reset',
  'stash',
  'checkout',
  'switch',
  'restore',
  'clean',
  'rebase',
  '-D',
  '--force',
  '-f',
]);

const ALLOWED_READ_VERBS = new Set([
  'version',
  '--version',
  'status',
  'rev-parse',
  'rev-list',
  'diff',
  'log',
  'show',
  'cat-file',
  'symbolic-ref',
  'merge-base',
  'ls-files',
  'hash-object',
  'for-each-ref',
  'check-ref-format',
  'var',
]);

/**
 * Tokenize JS/TS source code, skipping comments and whitespace, keeping line numbers.
 */
function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Single-line comment
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Multi-line comment
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      if (i < source.length) i += 2;
      continue;
    }

    // String literals
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const startLine = line;
      let val = '';
      let isInterpolated = false;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          val += source[i] + (source[i + 1] ?? '');
          i += 2;
        } else if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          isInterpolated = true;
          val += '${';
          i += 2;
        } else if (source[i] === quote) {
          i++;
          break;
        } else {
          if (source[i] === '\n') line++;
          val += source[i];
          i++;
        }
      }
      tokens.push({
        type: isInterpolated ? 'template' : 'string',
        value: val,
        quote,
        line: startLine,
      });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      const startLine = line;
      let id = '';
      while (i < source.length && /[a-zA-Z0-9_$]/.test(source[i])) {
        id += source[i];
        i++;
      }
      tokens.push({ type: 'ident', value: id, line: startLine });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      const startLine = line;
      let num = '';
      while (i < source.length && /[0-9]/.test(source[i])) {
        num += source[i];
        i++;
      }
      tokens.push({ type: 'number', value: num, line: startLine });
      continue;
    }

    // Multi-char punctuation
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ type: 'punct', value: '...', line });
      i += 3;
      continue;
    }

    tokens.push({ type: 'punct', value: ch, line });
    i++;
  }

  return tokens;
}

function analyzeElement(elemTokens) {
  if (elemTokens.length === 0) return { type: 'empty' };
  if (elemTokens.length === 1 && elemTokens[0].type === 'string') {
    return { type: 'literal', value: elemTokens[0].value, line: elemTokens[0].line };
  }
  if (elemTokens.length === 1 && elemTokens[0].type === 'ident') {
    return { type: 'ident', value: elemTokens[0].value, line: elemTokens[0].line };
  }
  if (elemTokens.length === 1 && elemTokens[0].type === 'number') {
    return { type: 'number', value: elemTokens[0].value, line: elemTokens[0].line };
  }
  if (elemTokens[0].value === '...') {
    return { type: 'spread', line: elemTokens[0].line };
  }
  return { type: 'computed', line: elemTokens[0].line };
}

function parseArrayLiteral(tokens, startIdx) {
  const elements = [];
  let i = startIdx + 1;
  let depth = 1;
  let currentElemTokens = [];

  while (i < tokens.length && depth > 0) {
    const t = tokens[i];
    if (t.value === '[' || t.value === '(' || t.value === '{') {
      depth++;
      currentElemTokens.push(t);
      i++;
    } else if (t.value === ']' || t.value === ')' || t.value === '}') {
      depth--;
      if (depth === 0) {
        if (currentElemTokens.length > 0) {
          elements.push(analyzeElement(currentElemTokens));
        }
        break;
      }
      currentElemTokens.push(t);
      i++;
    } else if (t.value === ',' && depth === 1) {
      if (currentElemTokens.length > 0) {
        elements.push(analyzeElement(currentElemTokens));
        currentElemTokens = [];
      }
      i++;
    } else {
      currentElemTokens.push(t);
      i++;
    }
  }

  return { elements, endIndex: i };
}

/**
 * Validate an extracted git argv against the design §6 allow-list and forbidden set.
 * Returns an array of findings for this argv.
 */
function validateGitArgv(filePath, line, elements) {
  const findings = [];

  if (!Array.isArray(elements) || elements.length === 0) {
    findings.push(`${filePath}:${line} git argv is empty`);
    return findings;
  }

  // 1. Check for forbidden tokens everywhere in the argv
  for (const elem of elements) {
    // A spread can hide '--force', '-D' or a forbidden verb; a template or identifier (path, sha, ref) cannot.
    if (elem.type === 'spread') {
      findings.push(`${filePath}:${elem.line ?? line} cannot statically analyze git argv: spread element`);
    }
    if (elem.type === 'literal') {
      const val = elem.value;
      if (FORBIDDEN_TOKENS.has(val) || val === '--force' || val === '-f' || val === '-D' || val.startsWith('--force=')) {
        findings.push(`${filePath}:${elem.line ?? line} git argv contains forbidden token '${val}'`);
      }
    }
  }

  // 2. Strip optional leading 'git' token
  let idx = 0;
  if (elements[idx]?.type === 'literal' && elements[idx].value === 'git') {
    idx++;
  }

  // 3. Strip git global options (e.g. -C <path>, -c <k=v>, --git-dir, --work-tree, --no-pager)
  while (idx < elements.length) {
    const elem = elements[idx];
    if (elem?.type === 'literal') {
      const val = elem.value;
      if (val === '-C' || val === '--git-dir' || val === '--work-tree') {
        idx += 2;
        continue;
      }
      if (val === '-c') {
        idx += 2;
        continue;
      }
      if (val.startsWith('-c') || val.startsWith('--git-dir=') || val.startsWith('--work-tree=')) {
        idx += 1;
        continue;
      }
      if (val === '--no-pager' || val === '--literal-pathspecs') {
        idx += 1;
        continue;
      }
    }
    break;
  }

  if (idx >= elements.length) {
    findings.push(`${filePath}:${line} git argv has no verb`);
    return findings;
  }

  // 4. Inspect the verb
  const verbElem = elements[idx];
  if (verbElem.type !== 'literal') {
    findings.push(`${filePath}:${verbElem.line ?? line} cannot statically analyze git argv: computed verb`);
    return findings;
  }

  const verb = verbElem.value;
  const rest = elements.slice(idx + 1);

  // If the verb itself is forbidden, it was already reported in step 1.
  if (FORBIDDEN_TOKENS.has(verb)) {
    return findings;
  }

  // Case: Allowed read verbs
  if (ALLOWED_READ_VERBS.has(verb)) {
    return findings;
  }

  // Case: config (read-only query permitted): a --get*/--list flag, or exactly one bare key.
  if (verb === 'config') {
    const writeFlags = ['--add', '--unset', '--unset-all', '--replace-all', '--edit', '--global', '--system', '--file'];
    const literalVals = rest.filter((e) => e.type === 'literal').map((e) => e.value);
    const hasWriteFlag = literalVals.some((v) => writeFlags.some((f) => v === f || v.startsWith(`${f}=`)));
    const hasReadFlag = literalVals.some((v) => v.startsWith('--get') || v === '--list');
    const nonFlags = rest.filter((e) => (e.type === 'literal' ? !e.value.startsWith('-') : true));
    if (hasWriteFlag || !(hasReadFlag || nonFlags.length === 1)) {
      findings.push(`${filePath}:${line} git config command is not a recognized read-only query`);
    }
    return findings;
  }

  // Case: merge-tree --write-tree
  if (verb === 'merge-tree') {
    const hasWriteTree = rest.some((e) => e.type === 'literal' && e.value === '--write-tree');
    if (!hasWriteTree) {
      findings.push(`${filePath}:${line} git merge-tree requires '--write-tree'`);
    }
    return findings;
  }

  // Case: commit-tree
  if (verb === 'commit-tree') {
    return findings;
  }

  // Case: merge --ff-only
  if (verb === 'merge') {
    const hasFfOnly = rest.some((e) => e.type === 'literal' && e.value === '--ff-only');
    if (!hasFfOnly) {
      findings.push(`${filePath}:${line} git merge requires '--ff-only'`);
    }
    return findings;
  }

  // Case: worktree
  if (verb === 'worktree') {
    if (rest.length === 0 || rest[0].type !== 'literal') {
      findings.push(`${filePath}:${line} cannot statically analyze git worktree subcommand`);
      return findings;
    }
    const sub = rest[0].value;
    if (sub === 'list') {
      return findings;
    }
    if (sub === 'add') {
      const hasB = rest.some((e) => e.type === 'literal' && e.value === '-b');
      if (!hasB) {
        findings.push(`${filePath}:${line} git worktree add requires '-b'`);
      }
      return findings;
    }
    if (sub === 'remove') {
      const hasForce = rest.some((e) => e.type === 'literal' && (e.value === '--force' || e.value === '-f'));
      if (hasForce) {
        findings.push(`${filePath}:${line} git worktree remove must not use force`);
      }
      return findings;
    }
    findings.push(`${filePath}:${line} git worktree subcommand '${sub}' is outside allow-list`);
    return findings;
  }

  // Case: branch -d
  if (verb === 'branch') {
    const hasD = rest.some((e) => e.type === 'literal' && e.value === '-d');
    if (!hasD) {
      findings.push(`${filePath}:${line} git branch requires '-d'`);
    }
    return findings;
  }

  // Case: repair-only read-tree
  if (verb === 'read-tree') {
    return findings;
  }

  // Case: repair-only update-ref (3-arg compare-and-swap)
  if (verb === 'update-ref') {
    const nonFlags = rest.filter((e) => (e.type === 'literal' ? !e.value.startsWith('-') : true));
    if (nonFlags.length < 3) {
      findings.push(`${filePath}:${line} git update-ref requires 3 arguments (compare-and-swap)`);
    }
    return findings;
  }

  // Case: repair-only checkout-index -a
  if (verb === 'checkout-index') {
    const hasA = rest.some((e) => e.type === 'literal' && e.value === '-a');
    if (!hasA) {
      findings.push(`${filePath}:${line} git checkout-index requires '-a'`);
    }
    return findings;
  }

  // Case: repair-only update-index -q --refresh
  if (verb === 'update-index') {
    const hasRefresh = rest.some((e) => e.type === 'literal' && e.value === '--refresh');
    if (!hasRefresh) {
      findings.push(`${filePath}:${line} git update-index requires '--refresh'`);
    }
    return findings;
  }

  // Anything else is outside allow-list
  findings.push(`${filePath}:${line} git verb '${verb}' is outside allow-list`);
  return findings;
}

/**
 * Scan a single file's text for git invocations and argvs.
 */
function scanFileContent(filePath, text) {
  const findings = [];
  const tokens = tokenize(text);

  const declaredArrays = new Map();
  const declaredOther = new Map();

  // Pass 1: Collect variable declarations
  for (let i = 0; i < tokens.length - 2; i++) {
    const t = tokens[i];
    if (t.type === 'ident' && (t.value === 'const' || t.value === 'let' || t.value === 'var')) {
      const nameToken = tokens[i + 1];
      const eqToken = tokens[i + 2];
      if (nameToken?.type === 'ident' && eqToken?.value === '=') {
        const nextToken = tokens[i + 3];
        if (nextToken?.value === '[') {
          const { elements } = parseArrayLiteral(tokens, i + 3);
          declaredArrays.set(nameToken.value, { elements, line: nameToken.line });
        } else {
          declaredOther.set(nameToken.value, { line: nameToken.line });
        }
      }
    }
  }

  const handledArrays = new Set();

  // Pass 2: Detect git spawn / helper calls
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Spawn calls: spawn('git', argv) / spawnSync('git', argv) / execFile('git', argv) / execFileSync('git', argv)
    if (t.type === 'ident' && ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(t.value)) {
      if (tokens[i + 1]?.value === '(') {
        let arg0Idx = i + 2;
        const arg0 = tokens[arg0Idx];
        if (arg0?.type === 'string' && arg0.value === 'git') {
          if (tokens[arg0Idx + 1]?.value === ',') {
            const arg1Idx = arg0Idx + 2;
            const arg1 = tokens[arg1Idx];
            if (arg1?.value === '[') {
              const { elements } = parseArrayLiteral(tokens, arg1Idx);
              handledArrays.add(arg1Idx);
              findings.push(...validateGitArgv(filePath, arg1.line, elements));
            } else if (arg1?.type === 'ident') {
              if (declaredArrays.has(arg1.value)) {
                const { elements, line } = declaredArrays.get(arg1.value);
                findings.push(...validateGitArgv(filePath, line, elements));
              } else {
                findings.push(`${filePath}:${arg1.line} cannot statically analyze git argv: computed argv '${arg1.value}'`);
              }
            } else {
              findings.push(`${filePath}:${arg0.line} cannot statically analyze git argv: computed argv`);
            }
          }
        }
      }
    }

    // Git helper calls: git(argv) / gitSync(argv) / runGit(argv) / execGit(argv) / gitPlumbing(argv)
    if (t.type === 'ident' && ['git', 'gitSync', 'runGit', 'execGit', 'gitPlumbing'].includes(t.value)) {
      const prev = tokens[i - 1];
      if (!prev || (prev.value !== 'function' && prev.value !== 'class')) {
        if (tokens[i + 1]?.value === '(') {
          const arg0Idx = i + 2;
          const arg0 = tokens[arg0Idx];
          if (arg0?.value === '[') {
            const { elements } = parseArrayLiteral(tokens, arg0Idx);
            handledArrays.add(arg0Idx);
            findings.push(...validateGitArgv(filePath, arg0.line, elements));
          } else if (arg0?.type === 'ident') {
            if (declaredArrays.has(arg0.value)) {
              const { elements, line } = declaredArrays.get(arg0.value);
              findings.push(...validateGitArgv(filePath, line, elements));
            } else {
              findings.push(`${filePath}:${arg0.line} cannot statically analyze git argv: computed argv '${arg0.value}'`);
            }
          } else {
            findings.push(`${filePath}:${t.line} cannot statically analyze git argv: computed argv`);
          }
        }
      }
    }

    // String exec calls: exec('git ...') / execSync('git ...')
    if (t.type === 'ident' && ['exec', 'execSync'].includes(t.value)) {
      if (tokens[i + 1]?.value === '(') {
        const arg0 = tokens[i + 2];
        if (arg0?.type === 'string' && /^git(?:\s+|$)/.test(arg0.value)) {
          const parts = arg0.value.trim().split(/\s+/).map((p) => ({ type: 'literal', value: p, line: arg0.line }));
          findings.push(...validateGitArgv(filePath, arg0.line, parts));
        }
      }
    }

    // Direct array literals
    if (t.value === '[' && !handledArrays.has(i)) {
      const { elements } = parseArrayLiteral(tokens, i);

      // Determine if this array literal represents a git argv:
      // a) Assigned to a variable named *git*, *argv*, *args*, *cmd*
      const prev1 = tokens[i - 1];
      const prev2 = tokens[i - 2];
      const isArgvVar = prev1?.value === '=' && prev2?.type === 'ident' && /(git|argv|args|cmd)/i.test(prev2.value);

      // b) First element is 'git', or a known git verb or forbidden verb
      let firstWord = null;
      for (const elem of elements) {
        if (elem.type === 'literal') {
          firstWord = elem.value;
          break;
        }
      }

      const isGitVerb = firstWord && (
        firstWord === 'git' ||
        FORBIDDEN_TOKENS.has(firstWord) ||
        ALLOWED_READ_VERBS.has(firstWord) ||
        [
          'commit', 'clone', 'revert', 'cherry-pick', 'init', 'merge-tree', 'commit-tree',
          'merge', 'worktree', 'branch', 'read-tree', 'update-ref', 'checkout-index',
          'update-index', 'config', '-C',
        ].includes(firstWord)
      );

      if (isArgvVar || isGitVerb) {
        findings.push(...validateGitArgv(filePath, t.line, elements));
      }
    }
  }

  // Pass 3: Check any variable declared as argv/gitArgs/gitCmd that is assigned a computed expression
  for (const [name, info] of declaredOther) {
    if (/(git|argv|args|cmd)/i.test(name)) {
      findings.push(`${filePath}:${info.line} cannot statically analyze git argv: computed argv '${name}'`);
    }
  }

  return [...new Set(findings)];
}

/**
 * Scan roadmap modules under rootDir or from a provided file Map.
 * Returns { findings, moduleCount }.
 */
function checkRoadmapGitVerbs(target = REPO) {
  const findings = [];
  let moduleCount = 0;

  if (typeof target === 'string' || (target && typeof target === 'object' && !target.files && !(target instanceof Map))) {
    const rootDir = typeof target === 'string' ? target : (target?.rootDir ?? REPO);
    const roadmapPath = path.join(rootDir, ROADMAP_DIR);

    if (fs.existsSync(roadmapPath)) {
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            walk(full);
          } else if (CODE_EXT_RE.test(ent.name) && !ent.name.endsWith('.d.ts')) {
            moduleCount++;
            const rel = path.relative(rootDir, full).split(path.sep).join('/');
            const text = fs.readFileSync(full, 'utf8');
            findings.push(...scanFileContent(rel, text));
          }
        }
      };
      walk(roadmapPath);
    }

    return { findings, moduleCount };
  }

  let files;
  if (target instanceof Map) {
    files = target;
  } else if (target?.files instanceof Map) {
    files = target.files;
  } else if (target?.files && typeof target.files === 'object') {
    files = new Map(Object.entries(target.files));
  } else {
    files = new Map();
  }

  for (const [file, content] of files) {
    if (!CODE_EXT_RE.test(file) || file.endsWith('.d.ts')) continue;
    moduleCount++;
    findings.push(...scanFileContent(file, content));
  }

  return { findings, moduleCount };
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────

test('G53: shipped src/runtime/roadmap/** modules adhere to git-verb allow-list and forbidden set', (t) => {
  const { findings, moduleCount } = checkRoadmapGitVerbs(REPO);
  t.diagnostic(`G53: scanned ${moduleCount} roadmap module(s)`);
  assert.deepEqual(findings, [], `forbidden or unallowlisted git verbs found in roadmap modules:\n${findings.join('\n')}`);
});

test('G53: passes on empty tree and reports module count 0', (t) => {
  const tmp = tempDir(t, 'doflow-g53-empty-');
  const { findings, moduleCount } = checkRoadmapGitVerbs(tmp);
  assert.equal(moduleCount, 0, 'expected module count 0 for empty tree');
  assert.deepEqual(findings, []);
});

test('G53 control: scratch source with [\'push\'] turns guard red', () => {
  const seeded = new Map([
    ['src/runtime/roadmap/bad-push.ts', "const cmd = ['push'];\n"],
  ]);
  const { findings } = checkRoadmapGitVerbs({ files: seeded });
  assert.ok(findings.length >= 1, 'expected finding for [\'push\']');
  assert.ok(findings.some((f) => f.includes("forbidden token 'push'")), `missing forbidden push finding: ${findings.join('\n')}`);
});

test('G53 control: scratch source with [\'branch\', \'-D\'] turns guard red', () => {
  const seeded = new Map([
    ['src/runtime/roadmap/bad-branch.ts', "const args = ['branch', '-D'];\n"],
  ]);
  const { findings } = checkRoadmapGitVerbs({ files: seeded });
  assert.ok(findings.length >= 1, 'expected finding for [\'branch\', \'-D\']');
  assert.ok(findings.some((f) => f.includes("forbidden token '-D'")), `missing forbidden -D finding: ${findings.join('\n')}`);
});

test('G53 control: scratch source with [\'worktree\', \'remove\', \'--force\'] turns guard red', () => {
  const seeded = new Map([
    ['src/runtime/roadmap/bad-wt.ts', "const argv = ['worktree', 'remove', '--force'];\n"],
  ]);
  const { findings } = checkRoadmapGitVerbs({ files: seeded });
  assert.ok(findings.length >= 1, 'expected finding for [\'worktree\', \'remove\', \'--force\']');
  assert.ok(findings.some((f) => f.includes("forbidden token '--force'")), `missing forbidden --force finding: ${findings.join('\n')}`);
});

test('G53 control: scratch source with a computed argv turns guard red', () => {
  const seeded = new Map([
    ['src/runtime/roadmap/computed-var.ts', 'const argv = getComputedArgs();\ngit(argv);\n'],
    ['src/runtime/roadmap/computed-spawn.ts', "spawn('git', dynamicArgs);\n"],
  ]);
  const { findings } = checkRoadmapGitVerbs({ files: seeded });
  assert.ok(findings.length >= 2, 'expected findings for computed argvs');
  assert.ok(findings.some((f) => f.includes('cannot statically analyze git argv')), `missing computed argv finding: ${findings.join('\n')}`);
});

test('G53 control: git config reads pass, writes turn guard red', () => {
  const scan = (src) => checkRoadmapGitVerbs({ files: new Map([['src/runtime/roadmap/cfg.ts', src]]) }).findings;
  for (const src of ["git(['config', 'user.name', 'x']);", "git(['config', '--add', 'a.b', 'c']);", "git(['config', '--global', '--get', 'user.name']);"]) {
    assert.ok(scan(src).some((f) => f.includes('not a recognized read-only query')), `expected finding for: ${src}`);
  }
  for (const src of ["git(['config', 'user.name']);", "git(['config', '--get', 'user.name']);", "git(['config', '--list']);"]) {
    assert.deepEqual(scan(src), [], `expected no finding for: ${src}`);
  }
});

test('G53 control: spread element in a git argv turns guard red, path element stays green', () => {
  const scan = (src) => checkRoadmapGitVerbs({ files: new Map([['src/runtime/roadmap/spread.ts', src]]) }).findings;
  assert.ok(scan("git(['worktree', 'remove', ...flags]);").some((f) => f.includes('spread element')));
  assert.ok(scan("git(['status', ...extra]);").some((f) => f.includes('spread element')));
  assert.deepEqual(scan("git(['worktree', 'remove', path]);"), []);
  assert.deepEqual(scan("git(['worktree', 'remove', `${dir}/wt`]);"), []);
});

test('G53 control: forbidden verbs and flags turn guard red in all forms', () => {
  const forbiddenExamples = [
    "const a = ['push', 'origin', 'main'];",
    "const b = ['fetch', 'origin'];",
    "const c = ['pull', 'origin', 'main'];",
    "const d = ['tag', 'v1.0.0'];",
    "const e = ['remote', 'add', 'origin', 'url'];",
    "const f = ['reset', '--hard'];",
    "const g = ['stash', 'pop'];",
    "const h = ['checkout', 'develop'];",
    "const i = ['switch', 'main'];",
    "const j = ['restore', 'file.txt'];",
    "const k = ['clean', '-f'];",
    "const l = ['rebase', 'main'];",
    "const m = ['branch', '-D', 'feat/x'];",
    "const n = ['worktree', 'remove', '-f', 'path'];",
    "const o = ['commit', '-m', 'stray commit'];",
  ];
  for (const snippet of forbiddenExamples) {
    const seeded = new Map([['src/runtime/roadmap/bad.ts', snippet]]);
    const { findings } = checkRoadmapGitVerbs({ files: seeded });
    assert.ok(findings.length >= 1, `expected finding for: ${snippet}`);
  }
});

test('G53: design §6 allowed git verbs pass inspection', () => {
  const safeExamples = [
    "git(['rev-list', '--first-parent', '--merges', 'develop']);",
    "git(['merge-tree', '--write-tree', developHead, featureHead]);",
    "git(['commit-tree', tree, '-p', developHead, '-p', featureHead, '--no-gpg-sign']);",
    "git(['merge', '--ff-only', commit]);",
    "git(['worktree', 'add', '-b', branch, path, developHead]);",
    "git(['worktree', 'remove', path]);",
    "git(['branch', '-d', branch]);",
    "git(['read-tree', commit]);",
    "git(['update-ref', ref, newSha, oldSha]);",
    "git(['checkout-index', '-a']);",
    "git(['update-index', '-q', '--refresh']);",
    "git(['symbolic-ref', 'HEAD']);",
    "git(['status', '--porcelain', '--untracked-files=all']);",
    "git(['diff', '--name-status', `${developHead}...${featureHead}`]);",
    "git(['merge-base', '--is-ancestor', commit, head]);",
    "git(['cat-file', '-e', commit]);",
    "git(['ls-files', '-o', '--exclude-standard']);",
    "git(['hash-object', path]);",
    "git(['version']);",
    "git(['-C', dir, 'rev-parse', 'HEAD']);",
    "git(['worktree', 'list', '--porcelain']);",
    "git(['config', 'user.name']);",
  ].join('\n');

  const seeded = new Map([['src/runtime/roadmap/merge.ts', safeExamples]]);
  const { findings, moduleCount } = checkRoadmapGitVerbs({ files: seeded });
  assert.equal(moduleCount, 1);
  assert.deepEqual(findings, []);
});

test('G53 control: filesystem tempDir identifies seeded fault without touching tracked sources', (t) => {
  const tmp = tempDir(t, 'doflow-g53-git-verbs-');
  const targetDir = path.join(tmp, ROADMAP_DIR);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'fault.ts'), "const argv = ['push', 'origin'];\n");

  const { findings, moduleCount } = checkRoadmapGitVerbs(tmp);
  assert.equal(moduleCount, 1);
  assert.ok(findings.length >= 1);
  assert.ok(findings[0].includes("forbidden token 'push'"));
});

module.exports = {
  checkRoadmapGitVerbs,
  scanFileContent,
  validateGitArgv,
};

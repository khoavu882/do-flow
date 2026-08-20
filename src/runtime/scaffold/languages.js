'use strict';

/**
 * Language selection and emitters — everything `scaffold.js`'s generator needs to know about a
 * target language: which extension maps to which language, which extensions are content rather
 * than code, which source languages have no emitter yet, the per-language identifier-casing rules,
 * the emitters themselves, and `repoLanguage()`, which asks `command-detect.js` what toolchain the
 * repository itself uses (for test stubs, which have no file extension of their own to read).
 */

const { detectCommands } = require('../command-detect');

/**
 * Per-file language comes from the file's own extension, because `plan.md` already states it:
 * `files: src/runtime/scaffold/generate.js` is not ambiguous about being JavaScript, and asking a
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

module.exports = {
  EXTENSION_LANGUAGE,
  PROSE_EXTENSIONS,
  UNEMITTED_SOURCE_EXTENSIONS,
  words,
  camel,
  pascal,
  snake,
  EMITTERS,
  repoLanguage,
};

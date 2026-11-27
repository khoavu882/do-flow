'use strict';

// The shared parser for the shell suites a workflow runs (scripts/shell-suites.ts): every accepted form,
// and the refusal of a line it cannot read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseShellSuites } = require('../../scripts/shell-suites.ts');

const suites = (text: string) => parseShellSuites(text).suites;

test('shell suites: the plain inline form, in order, skipping steps that are not suites', () => {
  assert.deepEqual(suites('steps:\n  - run: npm install\n  - run: bash test/a.sh\n  - run: bash scripts/b.sh\n  - run: bash test/c.sh  \n'), ['test/a.sh', 'test/c.sh']);
});

test('shell suites: a tab or several spaces after run:, `sh`, and `./test/x.sh`', () => {
  assert.deepEqual(suites('      - run:\tbash test/a.sh\n        run:    sh ./test/b.sh\n        run: bash ./test/c.sh\n'), ['test/a.sh', 'test/b.sh', 'test/c.sh']);
});

test('shell suites: trailing arguments and a trailing comment', () => {
  assert.deepEqual(suites('  - run: bash test/a.sh --fast one\n  - run: bash test/b.sh # slow\n'), ['test/a.sh', 'test/b.sh']);
});

test('shell suites: the next-line form', () => {
  assert.deepEqual(suites('  - name: x\n    run:\n      bash test/a.sh\n  - name: y\n    run: >\n      bash test/b.sh\n'), ['test/a.sh', 'test/b.sh']);
});

test('shell suites: a `run: |` block reads each command line and ignores comment lines and later steps', () => {
  const text = [
    '  - name: block',
    '    run: |',
    '      # the suites',
    '      bash test/a.sh',
    '      echo hi',
    '',
    '      bash ./test/b.sh --x # note',
    '  - name: after',
    '    run: bash test/c.sh',
  ].join('\n');
  assert.deepEqual(parseShellSuites(text), { suites: ['test/a.sh', 'test/b.sh', 'test/c.sh'], unreadable: [] });
});

test('shell suites: a `- run:` item and a `run:` key under a step read alike', () => {
  assert.deepEqual(suites('- run: |\n    bash test/a.sh\n- name: s\n  run: |\n    bash test/b.sh\n'), ['test/a.sh', 'test/b.sh']);
});

test('shell suites: a comment line that names a suite is not a step and not unreadable', () => {
  assert.deepEqual(parseShellSuites('# test/a.sh is run below\n  - run: bash test/b.sh # not test/c.sh\n'), { suites: ['test/b.sh'], unreadable: [] });
});

test('shell suites: a line that mentions a suite and is not read is returned, never dropped', () => {
  for (const [text, line] of [
    ['  - run: bash test/a.sh && bash test/b.sh\n', 'line 1'],
    ['  - run: "bash test/a.sh"\n', 'line 1'],
    ['  - run: |\n      cd test && bash test/a.sh; echo\n', 'line 2'],
    ['  - name: Run test/a.sh\n', 'line 1'],
    ['  - run: zsh test/a.sh\n', 'line 1'],
  ]) {
    const parsed = parseShellSuites(text);
    assert.deepEqual(parsed.suites, [], text);
    assert.equal(parsed.unreadable.length, 1, text);
    assert.ok(parsed.unreadable[0].startsWith(line), parsed.unreadable[0]);
  }
});

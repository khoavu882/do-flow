'use strict';

/**
 * Frozen-behaviour regression assertions (feature 011, plan task C.2, design component CH9; FR-009, FR-012).
 *
 * Pins the two behaviours this feature explicitly promises NOT to change:
 *
 *   1. FR-009: Capability routing is frozen at its current callers.
 *      No skill that does not already resolve information needs through the capability router
 *      gains that behaviour in this feature. The router's current reach is treated as a
 *      deliberate posture pending measurement, not an incomplete rollout.
 *
 *   2. FR-012: The pre-implement-gate hook never depends on the Node runtime.
 *      The hook stays a fast, fail-open gate on requirement.md, design.md, and plan.md that
 *      never invokes Node, the runtime CLI or a JavaScript module. Feature 058 (its FR-012) lets
 *      it read the readiness record and the run file with jq and print the runtime's refusal
 *      text, so the pin looks for those commands at command position, not for their names.
 *      That reading (shellCommands, runtimeInvocations) is a best-effort scanner, not a shell
 *      parser: it covers the invocation forms its own test lists and errs toward finding one.
 *      `command -v`, `type`, `which` and `hash` are lookups and are allowed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, SKILLS } = require('./_shared');

/**
 * The exact set of skills authorized to resolve information needs through the capability router (FR-009).
 * Any addition or removal requires deliberate review and measurement (requirement.md §5).
 */
const FROZEN_ROUTER_CALLER_SKILLS = new Set([
  'do',
  'do-diagnose',
  'do-execute-plan',
]);

/** Returns all markdown files grouped by their owning skill directory. */
function skillFilesBySkill() {
  const bySkill = new Map();
  for (const entry of fs.readdirSync(SKILLS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const files = [];
    const skillDir = path.join(SKILLS, skillName);
    (function walk(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
        } else if (item.name.endsWith('.md')) {
          files.push({ rel: path.relative(REPO, full), text: fs.readFileSync(full, 'utf8') });
        }
      }
    }(skillDir));
    bySkill.set(skillName, files);
  }
  return bySkill;
}

test('FR-009: capability router invocations are frozen to the pinned set of skills', () => {
  const bySkill = skillFilesBySkill();
  const ROUTE_INVOCATION = /(?:doflow-run|\$\{?DOFLOW\}?"?|doflow)\s+route\b/g;

  const actualCallerSkills = new Set();
  for (const [skillName, files] of bySkill.entries()) {
    for (const { text } of files) {
      if (ROUTE_INVOCATION.test(text)) {
        actualCallerSkills.add(skillName);
        break;
      }
    }
  }

  const actual = [...actualCallerSkills].sort();
  const expected = [...FROZEN_ROUTER_CALLER_SKILLS].sort();

  assert.deepEqual(
    actual,
    expected,
    `the set of skills invoking the capability router ('doflow route') has changed (FR-009).\n`
    + `Expected frozen set: ${expected.join(', ')}\n`
    + `Actual caller set:   ${actual.join(', ')}`
  );
});

test('FR-012: pre-implement-gate hook scripts never invoke the Node runtime', () => {
  // 022-normalize-hooks moved the gate's actual logic into one canonical script every harness's
  // front door delegates to (design.md C1) — the per-harness files this test originally pointed
  // at are now thin exec dispatchers with none of this logic inline. The pinned properties below
  // still apply to wherever the logic actually lives, so this test follows it there.
  const hookPaths = [
    path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'pre-implementation-gate.sh'),
  ];

  for (const hookFile of hookPaths) {
    assert.ok(fs.existsSync(hookFile), `pre-implement-gate hook must exist at ${hookFile}`);
    const content = fs.readFileSync(hookFile, 'utf8');

    // 1. Must check requirement.md, design.md, and plan.md presence
    assert.ok(
      content.includes('has_requirement') && content.includes('has_design') && content.includes('has_plan'),
      `${path.basename(hookFile)} must check has_requirement, has_design, and has_plan`
    );

    // 2. Must allow edits under agent-docs/ unconditionally
    assert.ok(
      content.includes('agent-docs'),
      `${path.basename(hookFile)} must allow edits targeting agent-docs/`
    );

    // 3. Must not invoke Node, the runtime CLI or a JavaScript module (FR-012 independence). It may
    //    name them in messages and read the readiness record: feature 058's FR-012 has the hook
    //    check it and print the runtime's refusal text, which names the command to run.
    // The reading must see the script's real commands, or finding no invocation would mean nothing.
    const commandWords = new Set(shellCommands(content).map((words) => words.find((w) => !ASSIGNMENT.test(w))));
    assert.ok(commandWords.has('git') && commandWords.has('jq'), 'the pin reads the git and jq commands the hook runs');
    assert.deepEqual(
      runtimeInvocations(content),
      [],
      `${path.basename(hookFile)} must not invoke node, doflow-run or a .js module (FR-012; `
      + 'feature 058 FR-012 allows reading the readiness record, never invoking the runtime)'
    );
    const forbiddenPatterns = [
      /\bevidence-ledger\b/i,
      /\bretrieval-plan\b/i,
      /\boutcome\b/i,
      /\bcontext-pack\b/i,
    ];
    for (const pattern of forbiddenPatterns) {
      assert.ok(
        !pattern.test(content),
        `${path.basename(hookFile)} must not reference or invoke runtime module/verb ${pattern} (FR-012)`
      );
    }
  }
});

/**
 * The commands a shell script runs, as word lists: one per simple command, including those inside
 * `$(...)`, backticks and `( ... )`. Comments are dropped, a backslash-newline joins two lines,
 * heredoc bodies are skipped, and quoted text is a word's value, never a command of its own.
 * A best-effort reading for this guard, not a shell parser: it errs toward finding a command, and a
 * heredoc body or a `case` pattern list inside a substitution is not read.
 * @param {string} src
 * @returns {Array<Array<string>>}
 */
function shellCommands(src) {
  const commands = [];
  const heredocs = [];
  let i = 0;
  /** At a newline: skip the body of every heredoc opened on the line just ended. */
  function skipHeredocs() {
    while (heredocs.length) {
      const { delimiter, tabs } = heredocs.shift();
      for (;;) {
        const end = src.indexOf('\n', i);
        const line = src.slice(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end + 1;
        if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter || end === -1) break;
      }
    }
  }
  /** At `<<`: record the delimiter; the body starts after this line. */
  function readHeredoc() {
    i += 2;
    const tabs = src[i] === '-';
    if (tabs) i += 1;
    while (src[i] === ' ' || src[i] === '\t') i += 1;
    let delimiter = '';
    while (i < src.length && !/[\s;&|<>()]/.test(src[i])) {
      if (src[i] !== "'" && src[i] !== '"' && src[i] !== '\\') delimiter += src[i];
      i += 1;
    }
    if (delimiter) heredocs.push({ delimiter, tabs });
  }
  function scan(stop) {
    let words = [];
    let word = '';
    let inWord = false;
    const endWord = () => {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    };
    const endCommand = () => {
      endWord();
      if (words.length) commands.push(words);
      words = [];
    };
    while (i < src.length) {
      const c = src[i];
      if (stop && c === stop) {
        i += 1;
        endCommand();
        return;
      }
      if (c === '#' && !inWord) {
        while (i < src.length && src[i] !== '\n') i += 1;
      } else if (c === '\\' && src[i + 1] === '\n') {
        i += 2;
      } else if (c === '\\') {
        word += src[i + 1] ?? '';
        inWord = true;
        i += 2;
      } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        endWord();
        readHeredoc();
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1) === -1 ? src.length : src.indexOf("'", i + 1);
        word += src.slice(i + 1, end);
        inWord = true;
        i = end + 1;
      } else if (c === '"') {
        inWord = true;
        i += 1;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\' && src[i + 1] === '\n') {
            i += 2;
          } else if (src[i] === '\\') {
            word += src[i + 1] ?? '';
            i += 2;
          } else if (src[i] === '$' && src[i + 1] === '(') {
            i += 2;
            scan(')');
          } else if (src[i] === '`') {
            i += 1;
            scan('`');
          } else {
            word += src[i];
            i += 1;
          }
        }
        i += 1;
      } else if (c === '$' && src[i + 1] === '(') {
        i += 2;
        scan(')');
        inWord = true;
      } else if (c === '`') {
        i += 1;
        scan('`');
        inWord = true;
      } else if (c === '(') {
        i += 1;
        endCommand();
        scan(')');
      } else if (c === '\n') {
        i += 1;
        endCommand();
        skipHeredocs();
      } else if (/[;&|)]/.test(c)) {
        i += 1;
        endCommand();
      } else if (/\s/.test(c)) {
        i += 1;
        endWord();
      } else {
        word += c;
        inWord = true;
        i += 1;
      }
    }
    endCommand();
  }
  scan(null);
  return commands;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Commands that run the command named after their own options: `exec node x`, `timeout 5 node x`. */
const WRAPPERS = new Set(['exec', 'command', 'env', 'nohup', 'nice', 'sudo', 'timeout', 'xargs', 'coproc', 'time', 'stdbuf', 'setsid']);
/** An option or option value a wrapper takes before the command it runs. */
const WRAPPER_ARG = /^(-.*|\d+(\.\d+)?[smhd]?|\{\})$/;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const RUNTIME = (name) => name === 'node' || name === 'doflow-run' || name.endsWith('.js');
/** `command -v node`, `command -V node`: a lookup, not a run. `type`, `which` and `hash` are too, by name. */
const LOOKUP_FLAGS = new Set(['-v', '-V']);

/**
 * Every command in a shell script that runs `node`, `doflow-run` or a `.js` path. Its command word
 * is found after leading `VAR=x` assignments, reserved words such as `if` and `do`, and wrappers
 * (`exec`, `env` and `/usr/bin/env`, `timeout`, `nohup`, `xargs`, `sudo` ...) with their options.
 * A `bash -c`/`bash -lc` script, an `eval` argument and a `find -exec` command are read the same
 * way, and a variable used as the command word (`$NODE x`, `"${NODE:-node}" x`) counts when its
 * default or any value the script assigns it names the runtime. Text that is only printed,
 * assigned or commented is not a command word, so it never counts. Best effort, see shellCommands.
 * @param {string} src
 * @returns {Array<string>}
 */
function runtimeInvocations(src) {
  const all = shellCommands(src);
  const assigned = new Map();
  for (const words of all) {
    for (const w of words) {
      const m = w.match(/^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/s);
      if (m) assigned.set(m[1], [...(assigned.get(m[1]) || []), m[2]]);
    }
  }
  const namesRuntime = (value) => RUNTIME(String(value).trim().split(/\s+/)[0].split('/').pop());
  const variableRuns = (word) => {
    const m = word.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::?[-=]([^}]*))?\}?$/);
    if (!m) return false;
    return (m[2] !== undefined && namesRuntime(m[2])) || (assigned.get(m[1]) || []).some(namesRuntime);
  };
  const found = [];
  const check = (words) => {
    let k = 0;
    for (;;) {
      while (k < words.length && (ASSIGNMENT.test(words[k]) || KEYWORDS.has(words[k]))) k += 1;
      if (k >= words.length) return;
      const name = words[k].split('/').pop();
      if (name === 'command' && LOOKUP_FLAGS.has(words[k + 1])) return;
      if (name === 'eval') {
        found.push(...runtimeInvocations(words.slice(k + 1).join(' ')));
        return;
      }
      if (!WRAPPERS.has(name)) break;
      k += 1;
      while (k < words.length && (WRAPPER_ARG.test(words[k]) || ASSIGNMENT.test(words[k]))) k += 1;
    }
    const name = words[k].split('/').pop();
    if (RUNTIME(name) || variableRuns(words[k])) {
      found.push(words.slice(k).join(' '));
    } else if (SHELLS.has(name)) {
      const flag = words.findIndex((w, at) => at > k && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (flag !== -1 && words[flag + 1] !== undefined) found.push(...runtimeInvocations(words[flag + 1]));
    } else if (name === 'find') {
      words.forEach((w, at) => {
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(w) && words[at + 1] !== undefined) check(words.slice(at + 1));
      });
    }
  };
  for (const words of all) check(words);
  return found;
}

test('FR-012: the hook pin catches a runtime invocation and lets printed text and lookups through', () => {
  const invoking = [
    'doflow-run x',
    'node x.js',
    "bash -c 'node x'",
    'a=1; doflow-run status',
    'true && node x',
    'false || ./lib/run.js',
    'cat f | node x',
    'out=$(doflow-run status)',
    'out=`node x`',
    'echo "$(node x)"',
    'exec doflow-run handoff',
    'command node x',
    'env A=1 node x',
    'FOO=1 doflow-run x',
    '"$HOME/.doflow/bin/doflow-run" verify',
    'if [ -f x ]; then\n  node x\nfi',
    'if node x; then :; fi',
    'while doflow-run x; do :; done',
    '[ -f x ] && { doflow-run x; }',
    'eval node x',
    'eval "node x"',
    'xargs node x',
    'printf x | xargs -I {} node {}',
    'find . -exec node {} \\;',
    'find . -name "*.txt" -execdir doflow-run x {} +',
    'timeout 5 node x',
    'nice node x',
    'nice -n 5 node x',
    'nohup node x',
    'sudo node x',
    'coproc node x',
    '/usr/bin/env node x',
    'bash -lc "node x"',
    'sh -ec "node x"',
    'NODE=node; $NODE x',
    '"${NODE:-node}" x',
    'RUN="node"\n"$RUN" x',
    'a=1 \\\nnode x',
    'if \\\nnode x; then :; fi',
    'x=$(\\\nnode y)',
    "cat <<EOF\nit's here\nEOF\nnode x",
    "cat <<-'EOF'\n\tit's here\n\tEOF\ndoflow-run x",
  ];
  for (const script of invoking) {
    assert.notDeepEqual(runtimeInvocations(script), [], `the pin must catch: ${script}`);
  }
  const printing = [
    "printf '%s\\n' \"Next: doflow-run readiness --task-id x\" >&2",
    'echo "run node x.js, then doflow-run verify" >&2',
    '# doflow-run and node x.js are named here only',
    'next="doflow-run readiness --task-class $t --task-id $id"',
    "msg='node x.js'",
    'printf "%s has no record. Next: doflow-run readiness\\n" "$gate"',
    'command -v node >/dev/null 2>&1',
    'command -V node',
    'type node',
    'which node',
    'hash node 2>/dev/null',
    "cat <<EOF\nnode x\nEOF",
    'GATE=x; "$GATE" y',
  ];
  for (const script of printing) {
    assert.deepEqual(runtimeInvocations(script), [], `the pin must let printed text through: ${script}`);
  }
});

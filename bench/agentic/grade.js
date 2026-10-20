'use strict';

/**
 * Agentic baseline grader (feature 097, IC-006, IC-007): turns one run directory into a `grading`
 * record, offline and without writing, and grades a whole iteration directory.
 *
 * Three decisions are separate on purpose, because each one decides what a number means:
 *  - infra (096 `classifyRun`, plus `truncated` when the transcript never ended a turn): did the
 *    harness leave a usable run? An excluded run scores `null`, never 0, so an outage cannot lower an arm.
 *  - isolation: did arm N reach the tool under test, any arm call an MCP tool, or any arm read outside
 *    its workspace and profile? A run that did, or whose transcript cannot be read, scores `null` as
 *    well; the leak patterns come from config and are matched on parsed shell commands.
 *  - answer: a clean, completed run that produced no extractable answer is a model failure and
 *    scores 0.
 *
 * `serializeGrading` fixes the key order, so grading a directory twice yields byte-identical files.
 */

const fs = require('node:fs');
const path = require('node:path');

const { classifyRun } = require('../noise.js');
const { scoreTask } = require('../retrieval/lib/metrics.js');
const { loadManifest } = require('../retrieval/lib/snapshot.js');
const { UsageError, buildPrompt, promptSha256 } = require('./tasks.js');

/** Only this many distinct answer paths count (the prompt asks for up to 10). */
const MAX_FILES = 10;
/** Evidence strings are cut so a pathological command cannot bloat grading.json. */
const EVIDENCE_MAX = 200;

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Parsed events of a structured-output transcript (the registry parser id); lines that are not JSON objects are skipped. */
function parseTranscript(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const v = JSON.parse(trimmed);
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) events.push(v);
    } catch {
      // not an event: ignored
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Answer extraction

/** End index (exclusive) of the balanced `{...}` starting at `start`, string literals respected; -1 when unbalanced. */
function balancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Repository-relative POSIX form. An absolute path is kept as given: it is never guessed into a repo path. */
function normalisePath(p) {
  const posix = path.posix.normalize(String(p).trim().replace(/\\/g, '/'));
  return posix.replace(/^(?:\.\/)+/, '');
}

/**
 * The LAST JSON object in `text` that has a `files` array of strings, or null. Prose and code fences
 * around it are tolerated. A balanced object without such an array is searched inside (a wrapper
 * object may hold the answer); a matched answer is not searched inside. Worst case is quadratic in the
 * message length, which is a model's final message.
 * @returns {{files: string[]} | null}
 */
function extractAnswer(text) {
  if (typeof text !== 'string') return null;
  let found = null;
  let i = text.indexOf('{');
  while (i !== -1) {
    const end = balancedEnd(text, i);
    let next = i + 1;
    if (end !== -1) {
      try {
        const v = JSON.parse(text.slice(i, end));
        if (v !== null && typeof v === 'object' && Array.isArray(v.files) && v.files.every((f) => typeof f === 'string')) {
          found = v.files;
          next = end;
        }
      } catch {
        // balanced but not JSON: look inside
      }
    }
    i = text.indexOf('{', next);
  }
  if (found === null) return null;
  const files = [...new Set(found.map(normalisePath).filter((f) => f !== '' && f !== '.'))].slice(0, MAX_FILES);
  return { files };
}

// ---------------------------------------------------------------------------
// Shell commands (C-7): the leak and count patterns are tested against normalised simple commands,
// never the raw string, so a wrapper cannot hide a call and a quoted argument cannot fake one.

/** Index of the `)` closing a `$(` whose body starts at `start` (quotes respected); the end of text when unclosed. */
function closeParen(s, start) {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return s.length;
      i = end;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length;
}

/** Index of the backtick closing one opened before `start`, and its body with backtick escapes undone. */
function closeBacktick(s, start) {
  let body = '';
  let i = start;
  for (; i < s.length && s[i] !== '`'; i++) {
    if (s[i] === '\\' && i + 1 < s.length && '`\\$'.includes(s[i + 1])) i++;
    body += s[i];
  }
  return { end: i, body };
}

/**
 * Splits a shell script into simple commands `{ words, redirects }`, quotes and escapes removed. The
 * separators are `;` `&` `|` (so `&&` `||` too), newlines and parentheses; a redirection target goes
 * to `redirects`, not to the words. `$(...)` and backtick bodies are split as scripts of their own and
 * their commands returned too; the word they stand in reads as X for `$(which X)` / `$(command -v X)`,
 * else as `$()`. A `#` starting a word comments out the rest of the line. Heredoc bodies, `case`
 * patterns and arithmetic are not understood; they can only add commands, never hide one.
 * @returns {{words: string[], redirects: string[]}[]}
 */
function splitScript(script) {
  const s = String(script);
  const commands = [];
  let words = [];
  let redirects = [];
  let word = null;
  let redirectNext = false;
  const endWord = () => {
    if (word === null) return;
    (redirectNext ? redirects : words).push(word);
    redirectNext = false;
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
    redirectNext = false;
  };
  const substitute = (body) => {
    const inner = splitScript(body);
    commands.push(...inner);
    const w = inner.length === 1 ? inner[0].words : [];
    if (w.length === 2 && w[0] === 'which') return w[1];
    if (w.length === 3 && w[0] === 'command' && (w[1] === '-v' || w[1] === '-V')) return w[2];
    return '$()';
  };
  const append = (text) => { word = (word ?? '') + text; };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < s.length && s[i + 1] !== '\n') append(s[i + 1]);
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end === -1 ? s.length : end;
      append(s.slice(i + 1, stop));
      i = stop;
    } else if (c === '"') {
      let text = '';
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) {
          text += s[j + 1];
          j += 2;
        } else if (s[j] === '$' && s[j + 1] === '(') {
          const end = closeParen(s, j + 2);
          text += substitute(s.slice(j + 2, end));
          j = end + 1;
        } else if (s[j] === '`') {
          const { end, body } = closeBacktick(s, j + 1);
          text += substitute(body);
          j = end + 1;
        } else text += s[j++];
      }
      append(text);
      i = j;
    } else if (c === '$' && s[i + 1] === '(') {
      const end = closeParen(s, i + 2);
      append(substitute(s.slice(i + 2, end)));
      i = end;
    } else if (c === '`') {
      const { end, body } = closeBacktick(s, i + 1);
      append(substitute(body));
      i = end;
    } else if (c === '#' && word === null) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++;
    } else if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      if (word !== null && /^\d+$/.test(word)) word = null; // the fd number of `2>`
      endWord();
      while (i + 1 < s.length && '<>&|'.includes(s[i + 1])) i++;
      redirectNext = true;
    } else if (c === ' ' || c === '\t' || c === '\r') endWord();
    else if (';&|\n()'.includes(c)) endCommand();
    else append(c);
  }
  endCommand();
  return commands;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that only open or group a command: `{ doflow retrieve; }`, `if doflow retrieve; then`. */
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
/** node flags that take the next word as their value. */
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
/** node flags that mean there is no script to collapse to. */
const NODE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-i', '--interactive']);
const base = (word) => path.posix.basename(word);

/**
 * Strips the wrappers that run their argument as the command: leading assignments and keywords,
 * `env [-flags] [VAR=x]...`, `command` (not `command -v`), `exec`, `nohup`, `time`, `npx [-flags]`,
 * and `node [--flags] <script>` collapsing to the script. Repeats until nothing changes.
 */
function stripWrappers(words) {
  const w = words.slice();
  for (;;) {
    const before = w.length;
    while (w.length && (KEYWORDS.has(w[0]) || ASSIGNMENT.test(w[0]))) w.shift();
    const prog = w.length ? base(w[0]) : '';
    const dropFlags = (valued = new Set()) => {
      while (w.length && w[0].startsWith('-')) {
        if (valued.has(w.shift()) && w.length) w.shift();
      }
    };
    if (prog === 'env') {
      w.shift();
      while (w.length && (w[0].startsWith('-') || ASSIGNMENT.test(w[0]))) {
        if (['-u', '--unset', '-C', '--chdir'].includes(w.shift()) && w.length) w.shift();
      }
    } else if (prog === 'command' && w[1] !== '-v' && w[1] !== '-V') {
      w.shift();
      dropFlags();
    } else if (prog === 'exec') {
      w.shift();
      dropFlags(new Set(['-a']));
    } else if (prog === 'nohup' || prog === 'time') {
      w.shift();
      dropFlags();
    } else if (prog === 'npx') {
      w.shift();
      dropFlags(new Set(['-p', '--package', '-c', '--call']));
    } else if (prog === 'node') {
      let i = 1;
      while (i < w.length && w[i].startsWith('-') && !NODE_EVAL_FLAGS.has(w[i])) i += NODE_VALUE_FLAGS.has(w[i]) ? 2 : 1;
      if (i < w.length && !w[i].startsWith('-')) w.splice(0, i);
    }
    if (w.length === before) return w;
  }
}

/** The script of `sh|bash|zsh|dash [-flags] -c '<script>'` (any flag cluster holding c), else null. */
function shellScript(words) {
  if (!words.length || !SHELLS.has(base(words[0]))) return null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-o' || w === '+o') i++;
    else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) return i + 1 < words.length ? words[i + 1] : null;
    else if (!w.startsWith('-') && !w.startsWith('+')) return null;
  }
  return null;
}

/**
 * The normalised simple commands of a shell command string, `sh -c` scripts recursed: each is
 * `{ text, words, raw }` where `words` has its wrappers stripped and its program reduced to the
 * basename, `text` is those words joined by single spaces (what the config patterns are tested
 * against) and `raw` is every word and redirection target as written (for the outside-path rule).
 */
function simpleCommands(command) {
  const out = [];
  for (const { words, redirects } of splitScript(command)) {
    const w = stripWrappers(words);
    const script = shellScript(w);
    if (w.length) w[0] = base(w[0]);
    out.push({ text: w.join(' '), words: w, raw: [...words, ...redirects] });
    if (script !== null) out.push(...simpleCommands(script));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Isolation

/** Names a truth file or the run store in any form: leaked in both arms (C-4(b)). */
const TRUTH_SUBSTRINGS = Object.freeze(['tasks-heldout', 'bench/retrieval/tasks', 'bench/runs']);
/** Absolute prefixes a worker may name besides its workspace and profile. */
const SYSTEM_PREFIXES = Object.freeze(['/usr', '/bin', '/sbin', '/dev', '/etc', '/System', '/Library', '/opt', '/proc']);

/** `/private/X` and `/X` are one path (the macOS /var and /tmp aliases). */
const unalias = (p) => path.posix.normalize(p).replace(/^\/private(?=\/)/, '');
const within = (p, root) => p === root || p.startsWith(`${root}/`);

/**
 * The first word of a command that names a path outside `roots` (an absolute path, or a `..` path
 * resolved against the cwd, which follows `cd` from the workspace root), or null. A `--flag=value` or
 * `VAR=value` word is checked by its value too. Without roots, only the system prefixes are allowed.
 * Ceiling: any word starting with `/` counts as a path, so a pattern such as `rg '/api/'` is graded
 * leaked too (the run is excluded, never scored wrongly).
 */
function outsidePath(commands, roots) {
  const allowed = [...SYSTEM_PREFIXES];
  for (const r of [roots?.workspaceRoot, roots?.profileRoot]) if (typeof r === 'string' && r.startsWith('/')) allowed.push(unalias(r));
  const home = typeof roots?.workspaceRoot === 'string' && roots.workspaceRoot.startsWith('/') ? roots.workspaceRoot : '/';
  let cwd = home;
  for (const cmd of commands) {
    for (const word of cmd.raw) {
      const candidates = [word];
      const value = /^[^=/]*=(.+)$/.exec(word);
      if (value) candidates.push(value[1]);
      for (const p of candidates) {
        let abs = null;
        if (p.startsWith('/')) abs = p;
        else if (p.split('/').includes('..')) abs = path.posix.resolve(cwd, p);
        if (abs !== null && !allowed.some((root) => within(unalias(abs), root))) return word;
      }
    }
    if (cmd.words[0] === 'cd' && cmd.words[1] && !/^[-~$]/.test(cmd.words[1])) cwd = path.posix.resolve(cwd, cmd.words[1]);
  }
  return null;
}

/**
 * The tool-use events of a transcript: `{ target, commands }` where target is the command string or
 * `mcp:<server>/<tool>` and commands its normalised simple commands (none for an MCP call).
 */
function toolUse(event) {
  if (event?.type !== 'item.completed' || !event.item) return null;
  const { item } = event;
  if (item.type === 'command_execution' && typeof item.command === 'string') return { target: item.command, commands: simpleCommands(item.command) };
  if (item.type === 'mcp_tool_call') return { target: `mcp:${item.server}/${item.tool}`, commands: null };
  return null;
}

const compile = (sources) => (Array.isArray(sources) ? sources : []).map((s) => new RegExp(s));

/**
 * Isolation of one run. Arm patterns (IC-003) are tested against each normalised simple command of a
 * shell command (C-7) and against the `mcp:<server>/<tool>` name of an MCP call. In every arm, a
 * command naming a path outside the run's workspace and profile (`roots`, from launch.json) or a
 * truth path is leaked too (C-4(b)). Evidence is the raw command, cut to EVIDENCE_MAX.
 * @param {object[]} events parsed transcript events
 * @param {{leak?: string[], count?: string[]}} armConfig arm entry of config.json (IC-003)
 * @param {{workspaceRoot?: string, profileRoot?: string} | null} [roots] the run's launch roots
 * @returns {{isolation: 'clean'|'leaked'|'unverifiable', evidence: string[], retrieveCalls: number}}
 */
function classifyIsolation(events, armConfig, roots = null) {
  if (!Array.isArray(events) || events.length === 0) return { isolation: 'unverifiable', evidence: [], retrieveCalls: 0 };
  const leak = compile(armConfig?.leak);
  const count = compile(armConfig?.count);
  const evidence = [];
  let retrieveCalls = 0;
  for (const event of events) {
    const use = toolUse(event);
    if (use === null) continue;
    const texts = use.commands === null ? [use.target] : use.commands.map((c) => c.text);
    const leaked = texts.some((text) => leak.some((re) => re.test(text)))
      || (use.commands !== null && (TRUTH_SUBSTRINGS.some((s) => use.target.includes(s)) || outsidePath(use.commands, roots) !== null));
    if (leaked) evidence.push(use.target.slice(0, EVIDENCE_MAX));
    retrieveCalls += texts.filter((text) => count.some((re) => re.test(text))).length;
  }
  return { isolation: evidence.length ? 'leaked' : 'clean', evidence, retrieveCalls };
}

// ---------------------------------------------------------------------------
// Grading

/**
 * `pathInfo(path)` for `scoreTask`: the manifest entry of a repository path, or null outside it. The
 * manifest records bytes, not line counts, so `lineCount` is null; it is only read for candidates that
 * carry line ranges, and the file-level answers graded here carry none.
 */
function loadPathInfo(manifest = loadManifest()) {
  const entries = new Map((manifest.entries || []).map((e) => [e.path, e]));
  return (p) => {
    const e = entries.get(p);
    return e ? { lineCount: null, bytes: e.bytes } : null;
  };
}

/** The status string of run_status.json: 'absent' when the file is missing, 'malformed' when unreadable. */
function readRunStatus(runDir) {
  const raw = readText(path.join(runDir, 'run_status.json'));
  if (raw === null) return 'absent';
  try {
    const v = JSON.parse(raw);
    return typeof v?.status === 'string' ? v.status : 'malformed';
  } catch {
    return 'malformed';
  }
}

/** The parsed launch.json of a run directory, or null when it is missing or unreadable. */
function readLaunch(runDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(runDir, 'launch.json'), 'utf8'));
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * C-8: refuses (UsageError, exit 2) a run that has no launch.json, or whose launch `key` or
 * `promptSha256` differs from the current task and arm prompt, so an old answer is never restamped
 * with a new key. `label` names the run in the message.
 * @returns {object} the launch record
 */
function checkLaunch({ runDir, task, arm, config, label }) {
  const launch = readLaunch(runDir);
  if (launch === null) {
    throw new UsageError('launch-missing', `${label}: launch.json is missing or unreadable in ${runDir}; a run without its launch record cannot be graded`);
  }
  const expected = { key: task.key, promptSha256: promptSha256(buildPrompt(task, config.arms[arm].paragraph)) };
  for (const field of ['key', 'promptSha256']) {
    if (launch[field] !== expected[field]) {
      throw new UsageError('capture-stale', `${label}: launch.json ${field} ${JSON.stringify(launch[field])} differs from the current task's ${expected[field]}; capture the run again instead of regrading it`);
    }
  }
  return launch;
}

/**
 * Grades one run directory (IC-007). Pure: reads, never writes. launch.json, when present, gives the
 * workspace and profile roots of the outside-path rule; checking it against the task is `checkLaunch`.
 * @returns {object} the grading record, keys in `serializeGrading` order
 */
function gradeRun({ runDir, task, arm, config, pathInfo }) {
  const armConfig = config?.arms?.[arm];
  if (!armConfig) throw new Error(`gradeRun: arm "${arm}" is not in the config (known: ${Object.keys(config?.arms || {}).join(', ')})`);

  const status = readRunStatus(runDir);
  const events = parseTranscript(readText(path.join(runDir, 'transcript.jsonl')));
  const lastMessage = readText(path.join(runDir, 'last-message.txt')) ?? '';
  const hasOutput = events.length > 0 || lastMessage.trim() !== '';

  const cls = classifyRun({ status, hasOutput });
  // C-9: a run the status calls finished but whose transcript never ended a turn was cut short.
  const turnEnded = events.some((e) => e.type === 'turn.completed');
  const excluded = cls.excluded || !turnEnded;
  const infra = cls.infra ?? (cls.excluded ? 'malformed' : (turnEnded ? null : 'truncated'));
  const iso = classifyIsolation(events, armConfig, readLaunch(runDir));

  let answer = null;
  let passRate = null;
  if (!excluded && iso.isolation === 'clean') {
    answer = extractAnswer(lastMessage);
    const files = answer ? answer.files : [];
    const scored = scoreTask({
      task: { ...task, class: task.kind, expect: task.expect ?? {} },
      answer: { result: files.length ? 'RETRIEVED' : 'EMPTY', candidates: files.map((p, i) => ({ path: p, rank: i + 1 })) },
      pathInfo,
    });
    passRate = scored.metrics.fileRecallAt10;
  }

  return {
    key: task.key,
    id: task.id,
    split: task.split,
    kind: task.kind,
    arm,
    run_status: status,
    infra,
    isolation: iso.isolation,
    isolationEvidence: iso.evidence,
    retrieveCalls: iso.retrieveCalls,
    answer,
    pass_rate: passRate,
    metrics: { fileRecallAt10: passRate },
  };
}

/** Byte-stable text of a grading: fixed key order (the order `gradeRun` builds), two-space indent, final newline. */
function serializeGrading(g) {
  return `${JSON.stringify({
    key: g.key,
    id: g.id,
    split: g.split,
    kind: g.kind,
    arm: g.arm,
    run_status: g.run_status,
    infra: g.infra,
    isolation: g.isolation,
    isolationEvidence: g.isolationEvidence,
    retrieveCalls: g.retrieveCalls,
    answer: g.answer,
    pass_rate: g.pass_rate,
    metrics: g.metrics,
  }, null, 2)}\n`;
}

/**
 * Grades every task directory of an iteration (arm from iteration.json) and, unless `write` is false,
 * writes `grading.json` into each. A task without a directory is returned as `{ id, missing: true }`
 * and nothing is created for it. `taskSet` is the `loadTaskSet` result or a task array. Every run is
 * checked against its launch record first (`checkLaunch`), so a refusal writes nothing.
 * @returns {object[]} gradings in task order
 */
function gradeIteration({ iterationDir, taskSet, config, pathInfo, write = true }) {
  const meta = JSON.parse(fs.readFileSync(path.join(iterationDir, 'iteration.json'), 'utf8'));
  const tasks = Array.isArray(taskSet) ? taskSet : taskSet.tasks;
  const name = path.basename(iterationDir);
  const runs = tasks.map((task) => {
    const runDir = path.join(iterationDir, task.id);
    if (!fs.existsSync(runDir)) return { task, runDir: null };
    checkLaunch({ runDir, task, arm: meta.arm, config, label: `${name}/${task.id}` });
    return { task, runDir };
  });
  return runs.map(({ task, runDir }) => {
    if (runDir === null) return { id: task.id, missing: true };
    const grading = gradeRun({ runDir, task, arm: meta.arm, config, pathInfo });
    if (write) fs.writeFileSync(path.join(runDir, 'grading.json'), serializeGrading(grading));
    return grading;
  });
}

module.exports = {
  MAX_FILES, EVIDENCE_MAX,
  parseTranscript, extractAnswer, simpleCommands, classifyIsolation, loadPathInfo, readLaunch, checkLaunch, gradeRun, serializeGrading, gradeIteration,
};

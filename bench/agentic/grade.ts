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
const childProcess = require('node:child_process');

const { classifyRun } = require('../noise.ts');
const { scoreTask } = require('../retrieval/lib/metrics.ts');
const { loadManifest } = require('../retrieval/lib/snapshot.ts');
const { UsageError, buildPrompt, buildAbPrompt, promptSha256, REVIEW_FILE } = require('./tasks.ts');
const claudeStream = require('./ab/claude-stream.ts');
const { parseReviewJson } = require('./review-adapter.ts');

/** Only this many distinct answer paths count (the prompt asks for up to 10). */
const MAX_FILES = 10;
/** Evidence strings are cut so a pathological command cannot bloat grading.json. */
const EVIDENCE_MAX = 200;

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Parsed events of a structured-output transcript (the registry parser id); lines that are not JSON objects are skipped. */
function parseTranscript(text: any) {
  const events: any[] = [];
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
function balancedEnd(text: string, start: number) {
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
function normalisePath(p: any) {
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
function extractAnswer(text: any) {
  if (typeof text !== 'string') return null;
  let found = null;
  let i = text.indexOf('{');
  while (i !== -1) {
    const end = balancedEnd(text, i);
    let next = i + 1;
    if (end !== -1) {
      try {
        const v = JSON.parse(text.slice(i, end));
        if (v !== null && typeof v === 'object' && Array.isArray(v.files) && v.files.every((f: any) => typeof f === 'string')) {
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
  const files = [...new Set(found.map(normalisePath).filter((f: any) => f !== '' && f !== '.'))].slice(0, MAX_FILES);
  return { files };
}

// ---------------------------------------------------------------------------
// Shell commands (C-7): the leak and count patterns are tested against normalised simple commands,
// never the raw string, so a wrapper cannot hide a call and a quoted argument cannot fake one.

/** Index of the `)` closing a `$(` whose body starts at `start` (quotes respected); the end of text when unclosed. */
function closeParen(s: string, start: number) {
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
function closeBacktick(s: string, start: number) {
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
 * else as `$()`. A `#` starting a word comments out the rest of the line. A heredoc body (`<<WORD`,
 * `<<-WORD`, quoted or not) is data, not words: it is skipped, except that a heredoc feeding a shell
 * (`sh <<EOF`, `cat <<EOF | bash`, `eval`) is split as a script of its own and an unquoted one has its
 * `$(...)` and backtick bodies split (they run). `writes` is the subset of `redirects` that a `>`, `>>`
 * or `&>` writes. `case` patterns and arithmetic are not understood; they can only add commands, never
 * hide one.
 * @returns {{words: string[], redirects: string[], writes: string[]}[]}
 */
function splitScript(script: any, { cut = false }: { cut?: boolean } = {}) {
  const s = String(script);
  const commands: any[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let writes: string[] = [];
  let word: string | null = null;
  let redirectNext = false;
  let redirectWrite = false;
  let lineStart = 0; // index in `commands` of the first command of the current line
  const heredocs: { delim: string; strip: boolean; quoted: boolean }[] = [];
  const endWord = () => {
    if (word === null) return;
    if (redirectNext) {
      redirects.push(word);
      if (redirectWrite) writes.push(word);
    } else words.push(word);
    redirectNext = false;
    redirectWrite = false;
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length || redirects.length) commands.push({ words, redirects, writes });
    words = [];
    redirects = [];
    writes = [];
    redirectNext = false;
    redirectWrite = false;
  };
  const substitute = (body: string) => {
    const inner = splitScript(body);
    commands.push(...inner);
    const w = inner.length === 1 ? inner[0].words : [];
    if (w.length === 2 && w[0] === 'which') return w[1];
    if (w.length === 3 && w[0] === 'command' && (w[1] === '-v' || w[1] === '-V')) return w[2];
    return '$()';
  };
  const append = (text: string) => { word = (word ?? '') + text; };

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
      const opStart = i;
      while (i + 1 < s.length && '<>&|'.includes(s[i + 1])) i++;
      const op = s.slice(opStart, i + 1);
      if (op === '<<') {
        // heredoc: the delimiter word is read here (quotes tell whether the body expands), the body at the next newline
        const strip = s[i + 1] === '-';
        if (strip) i++;
        let j = i + 1;
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
        let delim = '';
        let quoted = false;
        while (j < s.length && !' \t\r\n;&|<>()'.includes(s[j])) {
          if (s[j] === "'" || s[j] === '"') {
            quoted = true;
            const end = s.indexOf(s[j], j + 1);
            const stop = end === -1 ? s.length : end;
            delim += s.slice(j + 1, stop);
            j = stop + 1;
          } else if (s[j] === '\\' && j + 1 < s.length) {
            quoted = true;
            delim += s[j + 1];
            j += 2;
          } else delim += s[j++];
        }
        heredocs.push({ delim, strip, quoted });
        i = j - 1;
      } else {
        redirectNext = true;
        redirectWrite = op.includes('>');
      }
    } else if (c === ' ' || c === '\t' || c === '\r') endWord();
    else if (';&|\n()'.includes(c)) {
      endCommand();
      if (c === '\n') {
        if (heredocs.length) {
          const feedsShell = commands.slice(lineStart).some((cmd) => cmd.words.some((w: string) => SHELLS.has(base(w)) || w === 'eval'));
          for (const h of heredocs) {
            // the body runs from the next line to the delimiter line (leading tabs ignored for `<<-`)
            let pos = i + 1;
            let body = '';
            let closed = false;
            while (pos < s.length) {
              let eol = s.indexOf('\n', pos);
              if (eol === -1) eol = s.length;
              const line = s.slice(pos, eol);
              pos = Math.min(eol + 1, s.length);
              if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) {
                closed = true;
                break;
              }
              body += `${line}\n`;
            }
            i = pos - 1;
            // a delimiter that never closes (an arithmetic `<<` mistaken for a heredoc) must not hide what follows
            // (a command the transcript cut short has no closing line because of the cut: its body is data, not code)
            if (feedsShell || (!closed && !cut)) commands.push(...splitScript(body));
            else if (!h.quoted) {
              for (let k = 0; k < body.length; k++) {
                if (body[k] === '\\') k++;
                else if (body[k] === '$' && body[k + 1] === '(') {
                  const end = closeParen(body, k + 2);
                  substitute(body.slice(k + 2, end));
                  k = end;
                } else if (body[k] === '`') {
                  const { end, body: inner } = closeBacktick(body, k + 1);
                  substitute(inner);
                  k = end;
                }
              }
            }
          }
          heredocs.length = 0;
        }
        lineStart = commands.length;
      }
    } else append(c);
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
const base = (word: string) => path.posix.basename(word);

/**
 * Strips the wrappers that run their argument as the command: leading assignments and keywords,
 * `env [-flags] [VAR=x]...`, `command` (not `command -v`), `exec`, `nohup`, `time`, `npx [-flags]`,
 * and `node [--flags] <script>` collapsing to the script. Repeats until nothing changes.
 */
function stripWrappers(words: string[]) {
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
        if (['-u', '--unset', '-C', '--chdir'].includes(w.shift()!) && w.length) w.shift();
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
function shellScript(words: string[]) {
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
 * `{ text, words, raw, writes }` where `words` has its wrappers stripped and its program reduced to the
 * basename, `text` is those words joined by single spaces (what the config patterns are tested
 * against), `raw` is every word and redirection target as written (for the outside-path rule) and
 * `writes` the redirection targets that are written (`>`, `>>`, `&>`).
 */
function simpleCommands(command: string, opts: { cut?: boolean } = {}): { text: string; words: string[]; raw: string[]; writes: string[] }[] {
  const out: { text: string; words: string[]; raw: string[]; writes: string[] }[] = [];
  for (const { words, redirects, writes } of splitScript(command, opts)) {
    const w = stripWrappers(words);
    const script = shellScript(w);
    if (w.length) w[0] = base(w[0]);
    out.push({ text: w.join(' '), words: w, raw: [...words, ...redirects], writes });
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
/** Variables that name the OS temp dir, where the pruned tool export and other runs' scratch live. */
const AB_TMP_VARS = Object.freeze(['TMPDIR', 'TMP', 'TEMP', 'TEMPDIR', 'TMP_DIR']);
/** Directories the harness itself keeps in the OS temp dir: other runs' workspaces and profiles, the pruned tool export. */
const AB_HARNESS_TMP = /^(?:abws-|abprof-|doflow-)/;
/** Length at which claude-stream.ts cuts a stored command (COMMAND_CHARS): a command that long is cut, its tail is unknown. */
const AB_COMMAND_CUT = 4000;
/**
 * Tier-2 fixtures define `scripts.test` as `node --test` (offline), so `npm test` there is the visible check, not the package
 * manager's network use that the arm patterns (`npm`, `npx`) exist to catch: it is not tested against them. `npm install`,
 * `npm view`, `npx` and the like still are.
 */
const TIER2_LOCAL_COMMANDS: RegExp[] = [/^npm (?:test|t|run test|run-script test)(?: |$)/];
/** Programs whose first operand is a pattern or script (`sed -n '/a/,/b/p' f`, `rg '/api/'`), not a path. */
const PATTERN_PROGRAMS = new Set(['sed', 'awk', 'gawk', 'grep', 'egrep', 'fgrep', 'rg', 'ag']);
/** Options of those programs whose value is a file, so the word after them is a path. */
const PATTERN_FILE_FLAGS = new Set(['-f', '--file', '--exclude-from', '--include-from', '--ignore-file']);
/** Programs whose last operand is a file the run writes (cp, mv) and whose every operand is a file it writes (tee), like a `>` target. `mkdir` owns nothing: it may name an existing directory. */
const COPY_PROGRAMS = new Set(['cp', 'mv', 'install']);
const TEE_PROGRAMS = new Set(['tee']);
const unalias = (p: string) => path.posix.normalize(p).replace(/^\/private(?=\/)/, '');
const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

/**
 * Indexes in `cmd.raw` of the words that are a pattern or script, not a path: the first operand of sed, awk, grep and rg
 * (every word after `-e`), unless it is the value of a file option (`-f`). `sed -n '/^A/,/^B/p' f` names no file.
 */
function patternOperands(cmd: any): Set<number> {
  const out = new Set<number>();
  const program = cmd.words[0];
  if (!PATTERN_PROGRAMS.has(program)) return out;
  const start = cmd.raw.findIndex((w: string) => base(w) === program);
  if (start === -1) return out;
  const sawE = cmd.raw.some((w: string, i: number) => i > start && (w === '-e' || w === '--regexp'));
  let skipped = false;
  for (let i = start + 1; i < cmd.raw.length; i++) {
    const prev = cmd.raw[i - 1];
    const w = cmd.raw[i];
    if (prev === '-e' || prev === '--regexp') out.add(i);
    else if (!w.startsWith('-') && !sawE && !skipped && !PATTERN_FILE_FLAGS.has(prev)) { out.add(i); skipped = true; }
  }
  return out;
}

/** The words a command writes without a redirect: the destination of cp, mv and install, every operand of tee. */
function implicitWriteWords(cmd: any): Set<string> {
  const operands = cmd.words.slice(1).filter((w: string) => !w.startsWith('-'));
  if (COPY_PROGRAMS.has(cmd.words[0]) && operands.length >= 2) return new Set([operands[operands.length - 1]]);
  if (TEE_PROGRAMS.has(cmd.words[0])) return new Set(operands);
  return new Set();
}

/**
 * The first word of a command that names a path outside `roots` (an absolute path, or a `..` path
 * resolved against the cwd, which follows `cd` from the workspace root), or null. A `--flag=value` or
 * `VAR=value` word is checked by its value too. Without roots, only the system prefixes are allowed.
 * Ceiling: any word starting with `/` counts as a path, so a pattern such as `rg '/api/'` is graded
 * leaked too (the run is excluded, never scored wrongly). A heredoc body is not words (see `splitScript`).
 * A/B only (`scratch` given): the run's own scratch under `/tmp` is allowed, that is a path below `/tmp`
 * the same run wrote earlier (a `>` / `>>` redirect, or a Write / Edit target) and what lies below it, so a
 * throwaway `cat > /tmp/chk.js <<'EOF'` then `node /tmp/chk.js` is not a leak while a read of any other
 * `/tmp` path (the pruned tool export, another run's scratch) still is. `/tmp` itself is never owned.
 */
function outsidePath(commands: any[], roots: any, { expandVars = false, scratch = null }: { expandVars?: boolean; scratch?: Set<string> | null } = {}) {
  const allowed = [...SYSTEM_PREFIXES];
  for (const r of [roots?.workspaceRoot, roots?.profileRoot]) if (typeof r === 'string' && r.startsWith('/')) allowed.push(unalias(r));
  const home = typeof roots?.workspaceRoot === 'string' && roots.workspaceRoot.startsWith('/') ? roots.workspaceRoot : '/';
  let cwd = home;
  let oldpwd = home; // `$OLDPWD`: the directory before the last `cd`
  // A/B: variables the same command assigns (`D=$PWD`, `D=$(dirname "$D")`): `$D/...` is a path the command built
  // itself, and the assigned value was checked as a word of its own (DoFlow's "find the runtime" snippet does this).
  const assigned = new Set<string>();
  if (expandVars) for (const cmd of commands) for (const word of cmd.raw) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word); if (m) assigned.add(m[1]); }
  // A/B: the OS temp dir (where this run's profile lives, and other runs' too) and what a command writes or names as a pattern.
  const osTmp: string | null = expandVars && typeof roots?.profileRoot === 'string' && roots.profileRoot.startsWith('/') && /^abprof-/.test(path.posix.basename(roots.profileRoot))
    ? unalias(path.posix.dirname(roots.profileRoot)) : null;
  for (const cmd of commands) {
    const patternWords = expandVars ? patternOperands(cmd) : new Set<number>();
    const implicitWrites = expandVars ? implicitWriteWords(cmd) : new Set<string>();
    for (let wi = 0; wi < cmd.raw.length; wi++) {
      const word = cmd.raw[wi];
      if (patternWords.has(wi)) continue;
      const candidates = [word];
      const value = /^[^=/]*=(.+)$/.exec(word);
      if (value) candidates.push(value[1]);
      for (const p of candidates) {
        let abs = null;
        if (expandVars) {
          // A/B: `$VAR` and `~` words are expanded where the value is known (HOME is the scratch home, PWD the
          // tracked cwd) and flagged where it is not (TMPDIR and friends, any other variable used as a path base).
          const v = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(\/.*)?$/.exec(p);
          const tilde = /^~(\/.*)?$/.exec(p);
          if (v || tilde) {
            const name = v ? (v[1] || v[2]) : 'HOME';
            const rest = (v ? v[3] : tilde![1]) || '';
            if (name === 'PWD') abs = path.posix.resolve(cwd, `.${rest}`);
            else if (name === 'OLDPWD') abs = path.posix.resolve(oldpwd, `.${rest}`);
            else if (name === 'HOME' && typeof roots?.profileRoot === 'string' && roots.profileRoot.startsWith('/')) abs = path.posix.resolve(roots.profileRoot, 'home', `.${rest}`);
            else if (AB_TMP_VARS.includes(name) && osTmp !== null && rest !== '') abs = path.posix.resolve(osTmp, `.${rest}`);
            else if (AB_TMP_VARS.includes(name) || name === 'HOME') return word;
            else if (rest !== '' && !assigned.has(name)) return word;
          } else if (/^~[^/]/.test(p)) return word;
          if (p === '/') continue; // the filesystem root as a bare word (`[ "$D" != / ]`), not a path being read
        }
        if (abs === null && p.startsWith('/')) abs = p;
        else if (abs === null && p.split('/').includes('..')) abs = path.posix.resolve(cwd, p);
        if (abs !== null && scratch !== null) {
          const norm = unalias(abs);
          if (norm !== '/tmp' && within(norm, '/tmp')) {
            if (p === word && (cmd.writes?.includes(word) || implicitWrites.has(word))) {
              scratch.add(norm);
              continue;
            }
            if ([...scratch].some((own) => within(norm, own))) continue;
          }
        }
        if (abs !== null && osTmp !== null) {
          // A path the run names below the OS temp dir (`$TMPDIR/ev-batch`, a `mktemp -d` result) is its own scratch;
          // the harness's directories there (other runs' workspaces and profiles, the tool export), a bare listing of
          // the temp dir and a `..` out of it are not.
          const norm = unalias(abs);
          if (norm !== osTmp && within(norm, osTmp) && !AB_HARNESS_TMP.test(norm.slice(osTmp.length + 1).split('/')[0])) continue;
        }
        if (abs !== null && !allowed.some((root) => within(unalias(abs), root))) return word;
      }
    }
    if (cmd.words[0] === 'cd' && cmd.words[1] && cmd.words[1] !== '-') oldpwd = cwd;
    if (cmd.words[0] === 'cd' && cmd.words[1] && !/^[-~$]/.test(cmd.words[1])) cwd = path.posix.resolve(cwd, cmd.words[1]);
  }
  return null;
}

/**
 * The tool-use events of a transcript: `{ target, commands }` where target is the command string or
 * `mcp:<server>/<tool>` and commands its normalised simple commands (none for an MCP call).
 */
function toolUse(event: any) {
  if (event?.type !== 'item.completed' || !event.item) return null;
  const { item } = event;
  if (item.type === 'command_execution' && typeof item.command === 'string') return { target: item.command, commands: simpleCommands(item.command) };
  if (item.type === 'mcp_tool_call') return { target: `mcp:${item.server}/${item.tool}`, commands: null };
  return null;
}

const compile = (sources: any) => (Array.isArray(sources) ? sources : []).map((s: any) => new RegExp(s));

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
function classifyIsolation(events: any[], armConfig: any, roots: any = null) {
  if (!Array.isArray(events) || events.length === 0) return { isolation: 'unverifiable', evidence: [], retrieveCalls: 0 };
  const leak = compile(armConfig?.leak);
  const count = compile(armConfig?.count);
  const evidence = [];
  let retrieveCalls = 0;
  for (const event of events) {
    const use = toolUse(event);
    if (use === null) continue;
    const texts = use.commands === null ? [use.target] : use.commands.map((c: any) => c.text);
    const leaked = texts.some((text: string) => leak.some((re: any) => re.test(text)))
      || (use.commands !== null && (TRUTH_SUBSTRINGS.some((s) => use.target.includes(s)) || outsidePath(use.commands, roots) !== null));
    if (leaked) evidence.push(use.target.slice(0, EVIDENCE_MAX));
    retrieveCalls += texts.filter((text: string) => count.some((re: any) => re.test(text))).length;
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
function loadPathInfo(manifest: any = loadManifest()) {
  const entries = new Map((manifest.entries || []).map((e: any) => [e.path, e]));
  return (p: string) => {
    const e: any = entries.get(p);
    return e ? { lineCount: null, bytes: e.bytes } : null;
  };
}

/** The status string of run_status.json: 'absent' when the file is missing, 'malformed' when unreadable. */
function readRunStatus(runDir: string) {
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
function readLaunch(runDir: string) {
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
function checkLaunch({ runDir, task, arm, config, label }: { runDir: string; task: any; arm: string; config: any; label: string }) {
  const launch = readLaunch(runDir);
  if (launch === null) {
    throw new UsageError('launch-missing', `${label}: launch.json is missing or unreadable in ${runDir}; a run without its launch record cannot be graded`);
  }
  // Tier 2, arm C: the prompt of session 1 is typed behind the arm's entryPrefix; every other arm has none.
  const prompt = config.mode === 'ab' ? buildAbPrompt(task, config.arms[arm].paragraph, config.arms[arm].entryPrefix || '') : buildPrompt(task, config.arms[arm].paragraph);
  const expected: Record<string, string> = { key: task.key, promptSha256: promptSha256(prompt) };
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
function gradeRun({ runDir, task, arm, config, pathInfo }: { runDir: string; task: any; arm: string; config: any; pathInfo: any }) {
  const armConfig = config?.arms?.[arm];
  if (!armConfig) throw new Error(`gradeRun: arm "${arm}" is not in the config (known: ${Object.keys(config?.arms || {}).join(', ')})`);

  const status = readRunStatus(runDir);
  const events = parseTranscript(readText(path.join(runDir, 'transcript.jsonl')));
  const lastMessage = readText(path.join(runDir, 'last-message.txt')) ?? '';
  const hasOutput = events.length > 0 || lastMessage.trim() !== '';

  const cls = classifyRun({ status, hasOutput });
  // C-9: a run the status calls finished but whose transcript never ended a turn was cut short.
  const turnEnded = events.some((e: any) => e.type === 'turn.completed');
  const excluded = cls.excluded || !turnEnded;
  const infra = cls.infra ?? (cls.excluded ? 'malformed' : (turnEnded ? null : 'truncated'));
  const iso = classifyIsolation(events, armConfig, readLaunch(runDir));

  let answer = null;
  let passRate = null;
  if (!excluded && iso.isolation === 'clean') {
    answer = extractAnswer(lastMessage);
    const files: any[] = answer ? answer.files : [];
    const scored = scoreTask({
      task: { ...task, class: task.kind, expect: task.expect ?? {} },
      answer: { result: files.length ? 'RETRIEVED' : 'EMPTY', candidates: files.map((p: string, i: number) => ({ path: p, rank: i + 1 })) },
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
function serializeGrading(g: any) {
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

// ---------------------------------------------------------------------------
// With/without-DoFlow A/B grading (`config.mode === 'ab'`)
//
// One run is graded from its own files: the Claude stream-json segments (`transcript.jsonl`,
// `transcript.2.jsonl`, ...), `run_status.json`, `launch.json`, `segments.json`, `timing.json`, and for
// an `edit` task the final workspace copy. Three decisions stay separate, as above: infra (did the
// harness leave a usable run), isolation (was the arm what it claims: no leak in arm A, DoFlow proven
// loaded in arm B, no network or truth access in either), and the answer (edit: the native checks
// run outside the model's workspace; review: scored later by the review-miss scorer through the
// adapter, so `pass_rate` stays null here).
// ---------------------------------------------------------------------------

/** Names of the truth and run-store paths a worker may never name, in any form (both arms). */
const AB_TRUTH_SUBSTRINGS = Object.freeze(['tasks-heldout', 'bench/native', 'bench/runs', 'bench/review-miss', 'bench/agentic', 'bench/retrieval/tasks', 'core/shared', 'doflow-agentic-tool']);
const NETWORK_TOOLS = Object.freeze(['WebFetch', 'WebSearch']);
const CHECKS_TIMEOUT_MS = 10000;
const CHECKS_OUTPUT_MAX = 400;
const TOKEN_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens']);

const readJsonFile = (file: string) => {
  const raw = readText(file);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

const addTok = (a: any, b: any) => Object.fromEntries(TOKEN_KEYS.map((k) => [k, (a?.[k] ?? 0) + (b?.[k] ?? 0)]));
const sumTok = (t: any) => (t ? TOKEN_KEYS.reduce((n, k) => n + (t[k] ?? 0), 0) : 0);

/** The first Claude Code release whose resumed-session usage and cost are documented as running totals (review item 13). */
const CUMULATIVE_USAGE_FROM = '2.1.277';
const versionParts = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
/** True when `version` is a release at or above `floor`; an unknown or unparsable version is not. */
function versionAtLeast(version: string | null, floor: string) {
  const v = version === null ? null : versionParts(version);
  const f = versionParts(floor)!;
  if (v === null) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== f[i]) return v[i] > f[i];
  return true;
}
/** `verified` when the harness version is known to report a resumed run's usage and cost cumulatively, else `cumulative-unverified`. */
const costBasisOf = (version: string | null) => (versionAtLeast(version, CUMULATIVE_USAGE_FROM) ? 'verified' : 'cumulative-unverified');

/**
 * One run's reports (a first segment plus any `--resume` segments) folded into one set of figures.
 * `cumulative` says the harness reports a resumed session's usage and cost as running totals (the last
 * segment then holds the whole run; a total that goes DOWN is `inconsistent`); otherwise the segments
 * are summed. Tokens are the whole tree (main loop plus subagents) when the result reports a model
 * table, else the main loop; `subagent` is the part outside the main loop. Tool calls always sum.
 */
function aggregateReports(reports: any[], cumulative: boolean) {
  const claudeCodeVersion: string | null = reports[0]?.init?.claudeCodeVersion ?? null;
  const rows = reports.map((r: any) => ({ tokens: r.wholeTree ?? r.usage ?? null, sub: r.outsideMainLoop ?? null, cost: r.totalCostUsd ?? null, byModel: r.modelUsage || {}, turns: r.numTurns ?? null }));
  const known = rows.filter((r: any) => r.tokens !== null);
  const costs = rows.filter((r: any) => r.cost !== null).map((r: any) => r.cost as number);
  const turnList = rows.filter((r: any) => r.turns !== null).map((r: any) => r.turns as number);
  let tokens: any = null; let sub: any = null; let cost: number | null = null; let turns: number | null = null; let byModel: any = {};
  let inconsistent = false;
  if (known.length > 0) {
    if (cumulative) {
      const lastRow = known[known.length - 1];
      tokens = lastRow.tokens; sub = lastRow.sub; byModel = lastRow.byModel;
      for (let i = 1; i < known.length; i++) if (sumTok(known[i].tokens) < sumTok(known[i - 1].tokens)) inconsistent = true;
      for (let i = 1; i < costs.length; i++) if (costs[i] < costs[i - 1]) inconsistent = true;
      cost = costs.length ? costs[costs.length - 1] : null;
      turns = turnList.length ? turnList[turnList.length - 1] : null;
    } else {
      for (const r of known) {
        tokens = addTok(tokens, r.tokens);
        if (r.sub) sub = addTok(sub, r.sub);
        for (const [m, row] of Object.entries(r.byModel) as [string, any][]) byModel[m] = { ...addTok(byModel[m], row), costUSD: (byModel[m]?.costUSD ?? 0) + (row.costUSD ?? 0) };
      }
      cost = costs.length ? costs.reduce((a: number, b: number) => a + b, 0) : null;
      turns = turnList.length ? turnList.reduce((a: number, b: number) => a + b, 0) : null;
    }
  }
  const toolCounts: Record<string, number> = {};
  for (const r of reports) for (const [name, n] of Object.entries(r.toolCounts || {}) as [string, number][]) toolCounts[name] = (toolCounts[name] ?? 0) + n;
  return {
    usage: tokens === null ? 'unknown' : 'reported',
    tokens, totalTokens: sumTok(tokens), subagent: sub, byModel, costUsd: cost, turns,
    toolCalls: reports.reduce((n: number, r: any) => n + (r.toolCalls?.length ?? 0), 0),
    toolCounts,
    subagentCalls: reports.reduce((n: number, r: any) => n + (r.subagentCalls?.length ?? 0), 0),
    askUserQuestion: reports.reduce((n: number, r: any) => n + (r.questions?.askUserQuestion ?? 0), 0),
    inconsistent,
    claudeCodeVersion,
    costBasis: costBasisOf(claudeCodeVersion),
  };
}

const metricTokens = (t: any) => (t === null ? null : {
  input: t.inputTokens, output: t.outputTokens, cacheCreation: t.cacheCreationInputTokens, cacheRead: t.cacheReadInputTokens, total: sumTok(t),
});

/**
 * Isolation and DoFlow proof of one A/B run, from its parsed segments. Order of precedence: a leak
 * (network or truth access, a path outside the run's roots, an arm pattern, a DoFlow trace in arm A)
 * beats `not-loaded` (arm B without P1-P3), which beats `unverifiable` (no init to read, or an init
 * model other than the pin). `proof` is the evidence in either arm.
 * @returns {{isolation: 'clean'|'leaked'|'not-loaded'|'unverifiable', evidence: string[], proof: object}}
 */
function classifyAbIsolation({ reports, armConfig, roots, expected, homeSetup, pin, infra, localCommands = [] }: { reports: any[]; armConfig: any; roots: any; expected: any; homeSetup: any; pin: string | null; infra: string | null; localCommands?: RegExp[] }) {
  const leak = compile(armConfig?.leak);
  const evidence: string[] = [];
  const scratch = new Set<string>(); // paths below /tmp this run wrote itself
  const note = (text: string) => { if (evidence.length < 12) evidence.push(String(text).slice(0, EVIDENCE_MAX)); };
  for (const report of reports) {
    for (const call of report.toolCalls) {
      const name: string = call.name;
      const target: string = call.target ?? '';
      // The outside-path rule reads the text with the caller's home directory kept: masked to `~` it would read as the scratch HOME.
      const rawTarget: string = call.rawTarget ?? target;
      const rawPaths: string[] = Array.isArray(call.rawPaths) ? call.rawPaths : (Array.isArray(call.paths) ? call.paths : []);
      if (name.startsWith('mcp__') || NETWORK_TOOLS.includes(name)) { note(`${name} ${target}`.trim()); continue; }
      // Bash: the whole stored command (not cut for display). Any other tool: every path-like input it names
      // (file_path, notebook_path, path, a Grep glob, a Glob pattern), so a Grep or Glob aimed outside the roots is seen.
      const pathsOf = (list: string[], main: string) => [...new Set([...list, ...(name !== 'Skill' && main ? [main] : [])])];
      const named = name === 'Bash' ? [] : pathsOf(Array.isArray(call.paths) ? call.paths : [], target);
      const rawNamed = name === 'Bash' ? [] : pathsOf(rawPaths, rawTarget);
      const writing = name === 'Write' || name === 'Edit' || name === 'NotebookEdit';
      const commands = name === 'Bash' ? simpleCommands(rawTarget, { cut: rawTarget.length >= AB_COMMAND_CUT }) : rawNamed.map((text: string) => ({ text, words: [text], raw: [text], writes: writing ? [text] : [] }));
      if (commands.length === 0) continue;
      let reason: string | null = null;
      if (commands.some((c: any) => !localCommands.some((re) => re.test(c.text)) && leak.some((re: any) => re.test(c.text)))) reason = 'arm-pattern';
      else if ((name === 'Bash' ? [rawTarget] : rawNamed).some((text: string) => AB_TRUTH_SUBSTRINGS.some((x) => text.includes(x)))) reason = 'truth-path';
      else { const word = outsidePath(commands, roots, { expandVars: true, scratch }); if (word !== null) reason = 'outside-path'; }
      if (reason !== null) note(`${name} [${reason}]: ${name === 'Bash' ? target : named.join(' ')}`);
    }
  }
  const proofs = reports.map((r: any) => claudeStream.loadProof(r, expected));
  const first = proofs[0] || claudeStream.loadProof({ init: null, hooks: [] } as any, expected);
  const initSeen = proofs.length > 0 && first.initSeen;
  const loaded = initSeen && first.loaded && proofs.slice(1).every((p: any) => p.missingSkills.length === 0 && p.missingAgents.length === 0);
  const absent = initSeen && proofs.every((p: any) => p.initSeen && p.absent);
  const p1 = homeSetup === null || homeSetup === undefined ? null : homeSetup.ok === true;
  const proof = {
    required: armConfig?.proof ?? null, p1, initSeen, loaded, absent, sessionStartOk: first.sessionStartOk,
    missingSkills: first.missingSkills, missingAgents: first.missingAgents, presentSkills: first.presentSkills, presentAgents: first.presentAgents,
  };
  const model = reports[0]?.init?.model ?? null;
  let isolation: string = evidence.length ? 'leaked' : 'clean';
  if (armConfig?.proof === 'absent' && initSeen && !absent) {
    isolation = 'leaked';
    note(`init lists DoFlow: skills ${first.presentSkills.join(',') || '-'}; agents ${first.presentAgents.join(',') || '-'}; hooks ${reports[0].hooks.length}`);
  }
  if (isolation === 'clean' && armConfig?.proof === 'loaded') {
    if (p1 === false) {
      isolation = 'not-loaded';
      note('P1 failed: the DoFlow install step did not exit 0');
    } else if (initSeen && !loaded) {
      isolation = 'not-loaded';
      note(`P2/P3 failed: missing skills ${first.missingSkills.join(',') || '-'}; missing agents ${first.missingAgents.join(',') || '-'}; SessionStart hook ok ${first.sessionStartOk}`);
    }
  }
  if (isolation === 'clean') {
    // Without an init a failed run (timeout, api-error) is graded by its infra class, not as unverifiable.
    if (!initSeen && infra === null) { isolation = 'unverifiable'; note('no system/init event in the transcript'); }
    else if (initSeen && pin && model !== pin) { isolation = 'unverifiable'; note(`model-mismatch: init model ${model} is not the pinned ${pin}`); }
  }
  return { isolation, evidence, proof };
}

// ---------------------------------------------------------------------------------------------
// Tier 2: checklist grading (agent-docs/briefs/ab-tier2-design-result.md sections 3 and 5)
// ---------------------------------------------------------------------------------------------
// The check semantics are those of bench/agentic/ab/tier2/validate-fixtures.js, which is the reference: keep the two in step.

/** Tier-2 task kinds (`single`: one session, `continuity`: two sessions with a cut). Not imported from tasks.ts so this file stands alone. */
const TIER2_KINDS = Object.freeze(['single', 'continuity']);
const T2_TIMEOUT_MS = 180_000;
const T2_NOTE_MAX = 160;

function t2Walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? t2Walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

function t2Sha256(file: string) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The environment of every command the grader runs inside a copy: the caller's PATH only, no git identity, no user config. */
function t2Env(home: string) {
  return { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

function t2Git(ws: string, args: string[], home: string) {
  return childProcess.spawnSync('git', args, { cwd: ws, encoding: 'utf8', env: t2Env(home), timeout: T2_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
}

/** The text from the line holding `marker` to the next heading of the same or a higher level (to the end when the marker is not a heading). */
function t2SectionAfter(text: string, marker: string) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) return null;
  const heading = /^(#+)\s/.exec(lines[start]);
  let end = lines.length;
  if (heading) {
    for (let i = start + 1; i < lines.length; i++) {
      const next = /^(#+)\s/.exec(lines[i]);
      if (next && next[1].length <= heading[1].length) { end = i; break; }
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * The seed tree (the last fixture commit, without the uncommitted overlays) exported into `dest`. The seed commit is
 * the N-th commit from the root of the workspace's first-parent history, N = the fixture's commit count, accepted only
 * when every one of those N subjects equals the fixture's message (basis `git-log`). When the agent rewrote that
 * history the tree is rebuilt from the fixture's own commit overlays instead (basis `fixture-overlays`).
 */
function t2ExportSeed(ws: string, commits: any[], dest: string, home: string) {
  const log = t2Git(ws, ['log', '--first-parent', '--reverse', '--format=%H%x09%s'], home);
  const rows: string[][] = log.status === 0 ? String(log.stdout).split('\n').filter(Boolean).map((l: string) => l.split('\t')) : [];
  const matches = rows.length >= commits.length && commits.every((c: any, i: number) => rows[i][1] === String(c.message).split('\n')[0]);
  if (matches) {
    const sha = rows[commits.length - 1][0];
    const archive = childProcess.spawnSync('git', ['archive', '--format=tar', sha], { cwd: ws, env: t2Env(home), maxBuffer: 256 * 1024 * 1024 });
    if (archive.status === 0) {
      const untar = childProcess.spawnSync('tar', ['-x', '-C', dest], { input: archive.stdout });
      if (untar.status === 0) return { basis: 'git-log', commit: sha };
    }
  }
  for (const c of commits) {
    for (const rel of t2Walk(c.filesDir)) {
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.copyFileSync(path.join(c.filesDir, rel), path.join(dest, rel));
    }
  }
  return { basis: 'fixture-overlays', commit: null };
}

/** `node --test --test-reporter=tap` over the hidden files: top-level `ok`/`not ok N - <title>` lines, by title. */
function t2RunHidden(ws: string, hiddenDir: string, home: string) {
  const results = new Map<string, boolean>();
  const files = t2Walk(hiddenDir).filter((rel) => rel.endsWith('.test.js')).map((rel) => path.join(hiddenDir, rel));
  if (files.length === 0) return results;
  const run = childProcess.spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: ws, encoding: 'utf8', env: t2Env(home), timeout: T2_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  for (const line of String(run.stdout).split('\n')) {
    const m = /^(not )?ok \d+ - (.*)$/.exec(line);
    if (m) results.set(m[2].replace(/\\([\\#])/g, '$1'), !m[1]);
  }
  return results;
}

/** The agent's added or changed test files under `testDir` must fail when run against the seed code. */
function t2Mutation(ws: string, ctx: any, check: any) {
  const seedDir = fs.mkdtempSync(path.join(ctx.scratch, 'seed-'));
  const seed = t2ExportSeed(ws, ctx.commits, seedDir, ctx.home);
  ctx.seed = seed;
  const changed = t2Walk(path.join(ws, check.testDir)).map((rel) => `${check.testDir}/${rel}`).filter((rel) => {
    const seeded = path.join(seedDir, rel);
    return !fs.existsSync(seeded) || t2Sha256(seeded) !== t2Sha256(path.join(ws, rel));
  });
  if (changed.length === 0) return { pass: false, note: 'no added or changed test file' };
  for (const rel of changed) {
    fs.mkdirSync(path.dirname(path.join(seedDir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ws, rel), path.join(seedDir, rel));
  }
  const run = childProcess.spawnSync(process.execPath, ['--test', ...changed], { cwd: seedDir, encoding: 'utf8', env: t2Env(ctx.home), timeout: T2_TIMEOUT_MS });
  return { pass: run.status !== 0, note: `${changed.length} test file(s) against the seed (${seed.basis})` };
}

function t2Evaluate(item: any, ws: string, ctx: any): { pass: boolean; note?: string } {
  const check = item.check || {};
  const target = typeof check.path === 'string' ? path.join(ws, check.path) : null;
  const pattern = () => new RegExp(check.regex, check.flags || '');
  switch (check.type) {
    case 'test': return ctx.hidden.has(check.name) ? { pass: ctx.hidden.get(check.name) === true } : { pass: false, note: 'no hidden test with that title ran' };
    case 'file-contains': {
      if (target === null || !fs.existsSync(target)) return { pass: false, note: 'file missing' };
      let text = fs.readFileSync(target, 'utf8');
      if (check.within) {
        const section = t2SectionAfter(text, check.within);
        if (section === null) return { pass: false, note: `marker not found: ${String(check.within).slice(0, 60)}` };
        text = section;
      }
      return { pass: pattern().test(text) };
    }
    case 'file-present': return { pass: target !== null && fs.existsSync(target) };
    case 'file-absent': return { pass: target !== null && !fs.existsSync(target) };
    case 'byte-identical': return target !== null && fs.existsSync(target) ? { pass: t2Sha256(target) === check.sha256 } : { pass: false, note: 'file missing' };
    case 'worktree-diff-empty': {
      const r = t2Git(ws, ['diff', 'HEAD', '--name-only', '--', ...(check.paths || [])], ctx.home);
      return r.status === 0 ? { pass: String(r.stdout).trim() === '' } : { pass: false, note: 'git diff failed' };
    }
    case 'worktree-modified': {
      if (target === null || !fs.existsSync(target)) return { pass: false, note: 'file missing' };
      const r = t2Git(ws, ['diff', 'HEAD', '--name-only', '--', check.path], ctx.home);
      return { pass: r.status === 0 && String(r.stdout).trim() !== '' && pattern().test(fs.readFileSync(target, 'utf8')) };
    }
    case 'mutation': return t2Mutation(ws, ctx, check);
    default: return { pass: false, note: `unknown check type ${check.type}` };
  }
}

/**
 * Evaluates the checklist of a tier-2 task and its visible command on a COPY of the kept workspace (so grading twice
 * gives the same answer and never touches the run). `meta` is the fixture's task.json.
 */
function gradeTier2Workspace({ workspaceDir, task, meta }: { workspaceDir: string; task: any; meta: any }) {
  const items: any[] = Array.isArray(meta.items) ? meta.items : [];
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tier2-grade-'));
  try {
    const ws = path.join(scratch, 'ws');
    fs.cpSync(workspaceDir, ws, { recursive: true });
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home);
    const ctx: any = { hidden: t2RunHidden(ws, path.join(task.tier2.dir, 'hidden'), home), commits: task.tier2.commits, home, scratch, seed: null };
    const visible = typeof meta.visibleCommand === 'string' && meta.visibleCommand
      ? childProcess.spawnSync(meta.visibleCommand, { cwd: ws, shell: true, encoding: 'utf8', env: t2Env(home), timeout: T2_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
      : { status: null, error: new Error('no visibleCommand') };
    const results = items.map((item: any) => {
      let r: { pass: boolean; note?: string };
      try { r = t2Evaluate(item, ws, ctx); } catch (e: any) { r = { pass: false, note: `check error: ${String(e.message).slice(0, 80)}` }; }
      return { id: item.id, title: item.title, type: item.check?.type, pass: r.pass === true, ...(r.note ? { note: String(r.note).slice(0, T2_NOTE_MAX) } : {}) };
    });
    const k = results.filter((r: any) => r.pass).length;
    return {
      items: results, coverage: { k, n: results.length }, itemsAllPass: results.length > 0 && k === results.length,
      visible: { command: meta.visibleCommand ?? null, exitCode: visible.status ?? null, pass: visible.status === 0 && !visible.error },
      seed: ctx.seed,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The files an item exercises: its declared `targets`, else the `path` of a file check; null when the fixture does not say. */
function t2ItemTargets(item: any): string[] | null {
  if (Array.isArray(item.targets) && item.targets.every((t: any) => typeof t === 'string')) return item.targets;
  return typeof item.check?.path === 'string' ? [item.check.path] : null;
}

/**
 * Continuity metric: items passing among those whose target file was untouched when the cut fired. Derivable only
 * when the cut fired and EVERY item names its target files (`targets` in task.json, or the path of a file check);
 * otherwise null and the reason, and the run reports coverage only.
 */
function t2Recovered(items: any[], results: any[], cut: any) {
  if (!cut) return { recovered: null, note: 'not a continuity task' };
  if (cut.fired !== true) return { recovered: null, note: 'the cut did not fire' };
  const mapped = items.map((item: any) => t2ItemTargets(item));
  const unmapped = items.filter((_: any, i: number) => mapped[i] === null).map((item: any) => item.id);
  if (unmapped.length > 0) return { recovered: null, note: `not derivable: items ${unmapped.join(', ')} declare no target file (add "targets" to the items in task.json); coverage only` };
  const untouched: string[] = Array.isArray(cut.untouchedAtCut) ? cut.untouchedAtCut : [];
  const pending = items.filter((_: any, i: number) => (mapped[i] as string[]).some((t) => untouched.includes(t)));
  const passed = pending.filter((item: any) => results.find((r: any) => r.id === item.id)?.pass === true);
  return { recovered: { pending: pending.length, passed: passed.length, items: pending.map((item: any) => item.id) }, note: null };
}

/** Sessions of a tier-2 run aggregated one by one (the cumulative rule holds inside a session, never across two), then summed. */
function aggregateSessions(groups: any[][], cumulative: boolean) {
  const parts = groups.map((g) => aggregateReports(g, cumulative));
  const known = parts.filter((p: any) => p.usage === 'reported');
  const costs = parts.filter((p: any) => p.costUsd !== null).map((p: any) => p.costUsd as number);
  let tokens: any = null; let sub: any = null; const byModel: any = {};
  for (const p of known) {
    tokens = addTok(tokens, p.tokens);
    if (p.subagent) sub = addTok(sub, p.subagent);
    for (const [m, row] of Object.entries(p.byModel) as [string, any][]) byModel[m] = { ...addTok(byModel[m], row), costUSD: (byModel[m]?.costUSD ?? 0) + (row.costUSD ?? 0) };
  }
  const turns = parts.filter((p: any) => p.turns !== null);
  const toolCounts: Record<string, number> = {};
  for (const p of parts) for (const [name, n] of Object.entries(p.toolCounts) as [string, number][]) toolCounts[name] = (toolCounts[name] ?? 0) + n;
  return {
    usage: known.length === 0 ? 'unknown' : (known.length === parts.length ? 'reported' : 'partial'),
    tokens, totalTokens: sumTok(tokens), subagent: sub, byModel, costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    turns: turns.length ? turns.reduce((n: number, p: any) => n + p.turns, 0) : null,
    toolCalls: parts.reduce((n: number, p: any) => n + p.toolCalls, 0), toolCounts,
    subagentCalls: parts.reduce((n: number, p: any) => n + p.subagentCalls, 0), askUserQuestion: parts.reduce((n: number, p: any) => n + p.askUserQuestion, 0),
    inconsistent: parts.some((p: any) => p.inconsistent), claudeCodeVersion: parts[0]?.claudeCodeVersion ?? null, costBasis: parts[0]?.costBasis ?? costBasisOf(null),
  };
}

/** Runs the native case's `checks` program against a copy of the final workspace, never inside the model's. */
function runChecks(workspaceCopy: string, checks: string) {
  const r = childProcess.spawnSync(process.execPath, ['-e', checks], {
    cwd: workspaceCopy, encoding: 'utf8', timeout: CHECKS_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { pass: r.status === 0 && !r.error, exitCode: r.status ?? null, output: out.slice(-CHECKS_OUTPUT_MAX) };
}

/**
 * The tier-2 part of one run's grading: the checklist on the kept workspace, regression-free, the delivery flag and
 * the two exclusion marks. User decision U3: a run stopped at its cap or timeout (`deliveryFailed`) is scored as a
 * FAILED delivery, and its `censored`/exclusion flags stay beside it as a separate sensitivity mark, never as a drop.
 * `excluded` is the mark that keeps a run out of the scored mean (a leak, a missing proof, an infra failure that is
 * not the cap or timeout itself); `exclusionMark` also counts the cap and timeout, for the "excluding capped/leaked
 * runs" line. Item results are kept for every run that left a workspace, excluded or not.
 */
function tier2Record({ runDir, task, statusRec, status, infra, iso, permission, workspaceCopy, timing }: any) {
  if (!task.tier2?.dir) throw new Error(`gradeAbRun: tier-2 task ${task.id} has no fixture directory (task.tier2.dir)`);
  const meta = readJsonFile(path.join(task.tier2.dir, 'task.json'));
  if (meta === null || !Array.isArray(meta.items)) throw new Error(`gradeAbRun: ${task.tier2.dir}/task.json is missing or has no items`);
  const rec = readJsonFile(path.join(runDir, 'tier2.json'));
  const procRec = readJsonFile(path.join(runDir, 'process.json'));
  const deliveryFailed = statusRec?.deliveryFailed === true || statusRec?.cap === true || status === 'timeout';
  const deliveryBy: string | null = statusRec?.cap === true ? 'cap' : (status === 'timeout' ? 'timeout' : null);
  const workspace = fs.existsSync(workspaceCopy) ? gradeTier2Workspace({ workspaceDir: workspaceCopy, task, meta }) : null;
  const items = workspace !== null ? workspace.items : meta.items.map((item: any) => ({ id: item.id, title: item.title, type: item.check?.type, pass: false, note: 'unreached: the run left no workspace' }));
  const k = items.filter((r: any) => r.pass).length;
  const regressionFree = workspace?.visible.pass === true;
  const itemsAllPass = items.length > 0 && k === items.length;
  const success = !deliveryFailed && itemsAllPass && regressionFree;
  const exclusionMark: string | null = iso.isolation === 'leaked' || iso.isolation === 'not-loaded' ? 'source-unverified' : (infra ?? (iso.isolation === 'clean' ? null : 'source-unverified'));
  const deliveryOnly = deliveryFailed && (infra === 'truncated' || infra === 'timeout') && iso.isolation === 'clean' && permission === null;
  const excluded: string | null = deliveryOnly ? null : exclusionMark;
  const cut = task.kind === 'continuity' ? (rec?.cut ?? { fired: false }) : null;
  const rc = t2Recovered(meta.items, items, cut);
  const artifacts = t2Walk(path.join(workspaceCopy, 'agent-docs', 'doflow')).length;
  const process = procRec === null ? null : {
    hookDenies: procRec.hookDenies ?? {}, skills: procRec.skills ?? [], class: procRec.class ?? null, subagentCalls: procRec.subagentCalls ?? 0,
    byModel: procRec.byModel ?? {}, totalTokens: procRec.totalTokens ?? null, totalCostUsd: procRec.totalCostUsd ?? null,
  };
  const graded = workspace !== null || deliveryFailed;
  return {
    passRate: graded && excluded === null ? (success ? 1 : 0) : null,
    record: {
      graded: workspace !== null, items, coverage: { k, n: items.length }, itemsAllPass, regressionFree,
      visible: workspace === null ? null : { command: workspace.visible.command, exitCode: workspace.visible.exitCode },
      success, deliveryFailed, deliveryBy, excluded, exclusionMark, seed: workspace?.seed ?? null,
      cutFired: cut === null ? null : cut.fired === true, cut: cut === null ? null : { cutMs: cut.cutMs ?? null, changedAtCut: cut.changedAtCut ?? null, untouchedAtCut: cut.untouchedAtCut ?? null, changedAtEnd: cut.changedAtEnd ?? null },
      recovered: rc.recovered, recoveredNote: rc.note,
      artifacts, process,
      sessions: Array.isArray(rec?.sessions) ? rec.sessions.map((x: any) => ({ n: x.n, tokens: x.tokens ?? null, costUsd: x.costUsd ?? null, source: x.source ?? null })) : null,
      entryPrefix: rec?.entryPrefix ?? null,
      costLowerBound: timing?.cost_usd_lower_bound === true,
    },
  };
}

/**
 * Grades one A/B run directory. Pure but for the child process that runs the checks. The returned record
 * has the keys `serializeAbGrading` writes.
 */
function gradeAbRun({ runDir, task, arm, config }: { runDir: string; task: any; arm: string; config: any }) {
  const armConfig = config?.arms?.[arm];
  if (!armConfig) throw new Error(`gradeAbRun: arm "${arm}" is not in the config (known: ${Object.keys(config?.arms || {}).join(', ')})`);
  const statusRec = readJsonFile(path.join(runDir, 'run_status.json'));
  const status: string = statusRec === null ? (fs.existsSync(path.join(runDir, 'run_status.json')) ? 'malformed' : 'absent') : (typeof statusRec.status === 'string' ? statusRec.status : 'malformed');
  const launch = readLaunch(runDir) || {};
  const segRec = readJsonFile(path.join(runDir, 'segments.json'));
  const segList: any[] = Array.isArray(segRec?.segments) && segRec.segments.length ? segRec.segments : [{ file: 'transcript.jsonl' }];
  const reports = segList.map((s: any) => claudeStream.parseTranscript(readText(path.join(runDir, path.basename(String(s.file)))) ?? ''));
  const lastReport = reports[reports.length - 1];
  const lastMessage = readText(path.join(runDir, 'last-message.txt')) ?? '';
  const hasOutput = reports.some((r: any) => r.init !== null || r.toolCalls.length > 0 || r.finalText) || lastMessage.trim() !== '';
  const timing = readJsonFile(path.join(runDir, 'timing.json')) || {};
  const homeSetup = readJsonFile(path.join(runDir, 'home-setup.json'));
  const homeSetupState = armConfig.homeSetup === null ? null : (homeSetup === null ? { ok: false } : homeSetup);

  const cls = classifyRun({ status, hasOutput });
  let infra: string | null = cls.infra ?? (cls.excluded ? 'malformed' : null);
  if (infra === null && lastReport.status !== 'success') infra = 'truncated';
  const isTier2 = TIER2_KINDS.includes(task.kind);
  // Tier 2 may hold two sessions: the cumulative rule applies inside a session, so each is aggregated alone and the sessions are summed.
  const sessionOfSegment = (i: number) => (Number.isInteger(segList[i]?.session) ? segList[i].session : 1);
  const sessionGroups: any[][] = [];
  if (isTier2) {
    const order = [...new Set(segList.map((_: any, i: number) => sessionOfSegment(i)))].sort((a: number, b: number) => a - b);
    for (const sn of order) sessionGroups.push(reports.filter((_: any, i: number) => sessionOfSegment(i) === sn));
  }
  const agg: any = isTier2 ? aggregateSessions(sessionGroups, config.resume?.cumulative !== false) : aggregateReports(reports, config.resume?.cumulative !== false);
  if (infra === null && agg.inconsistent) infra = 'malformed';
  const workspaceCopy = path.join(runDir, 'workspace');
  if (infra === null && (task.kind === 'edit' || isTier2) && !fs.existsSync(workspaceCopy)) infra = 'malformed';

  const iso = classifyAbIsolation({
    reports, armConfig, roots: launch, expected: launch.proofExpected || { skills: [], agents: [] }, homeSetup: homeSetupState, pin: config.model?.label ?? null, infra,
    localCommands: isTier2 ? TIER2_LOCAL_COMMANDS : [],
  });
  // Permissions: a run whose stream holds permission denials did not do the task it was given (its tools were refused),
  // and a run killed for a wrong init.permissionMode never started it. Both are excluded; the mark stays in the shared
  // vocabulary (`truncated`), the reason is kept in exclusionReason.
  const permissionDenials = reports.reduce((n: number, r: any) => n + Math.max(r.permissionDenials ?? 0, r.permissionDeniedEvents ?? 0), 0);
  const permission: string | null = statusRec?.infra === 'permission-mode-not-effective' ? 'permission-mode-not-effective' : (permissionDenials > 0 ? 'permission-denied' : null);
  if (permission !== null && infra === null) infra = 'truncated';
  const exclusionReason = iso.isolation !== 'clean' ? iso.isolation : (permission ?? infra);
  // A run stopped by the per-run cap, or by the timeout, is censored: the figures it reports are lower bounds of
  // what the task would have cost. It leaves the quality scores (excluded) but stays in the cost and wall figures.
  const censored: string | null = iso.isolation === 'clean' ? (statusRec?.cap === true ? 'cap' : (infra === 'timeout' ? 'timeout' : null)) : null;

  let passRate: number | null = null;
  let checks: any = null;
  let review: any = null;
  // The hidden check runs on the final files of every edit run that left a workspace and a transcript, excluded or not: an
  // excluded run keeps its result as a sensitivity figure, but only a run that is not excluded gets a pass_rate.
  if (task.kind === 'edit' && hasOutput && fs.existsSync(workspaceCopy)) checks = runChecks(workspaceCopy, task.checks);
  if (checks !== null && infra === null && iso.isolation === 'clean') passRate = checks.pass ? 1 : 0;
  if (task.kind === 'review') {
    const parsed = parseReviewJson(readText(path.join(runDir, REVIEW_FILE)), launch.workspaceRoot ?? null);
    review = { ok: parsed.ok, reason: parsed.reason, findings: parsed.findings.length, dropped: parsed.dropped };
  }

  const t2 = isTier2 ? tier2Record({ runDir, task, statusRec, status, infra, iso, permission, workspaceCopy, timing }) : null;
  if (t2 !== null) passRate = t2.passRate;

  // pauses = blocking questions only; closing offers ("Want me to ...?") are counted apart and never resume a run.
  const asked = segRec?.pauses ?? reports.filter((r: any) => r.questions.askUserQuestion > 0 || r.closing === 'blocking').length;
  const offered = segRec?.offers ?? reports.filter((r: any) => r.closing === 'offer').length;
  const blockedEnds = segRec?.blocked ?? reports.filter((r: any) => r.closing === 'blocked').length;
  const resultMs: number | null = reports.length > 0 && reports.every((r: any) => Number.isFinite(r.durationMs)) ? reports.reduce((n: number, r: any) => n + r.durationMs, 0) : null;
  const skills = [...new Set(reports.flatMap((r: any) => r.skillEvents.map((e: any) => e.skill)))] as string[];
  const routing = !isTier2 && armConfig.proof === 'loaded' && Array.isArray(task.expectedSkills)
    ? { expected: task.expectedSkills, used: skills, routed: task.expectedSkills.every((n: string) => skills.includes(n)) }
    : null;
  return {
    key: task.key,
    id: task.id,
    split: task.split,
    kind: task.kind,
    group: task.group,
    arm,
    run_status: status,
    infra,
    isolation: iso.isolation,
    isolationEvidence: iso.evidence,
    exclusionReason,
    proof: iso.proof,
    capped: statusRec?.cap === true,
    censored,
    permissionDenials,
    pass_rate: passRate,
    checks: checks === null ? null : { exitCode: checks.exitCode, output: checks.output },
    review,
    routing,
    ...(t2 !== null ? { tier2: t2.record } : {}),
    metrics: {
      usage: t2 !== null && Number.isFinite(timing.total_tokens) ? 'reported' : agg.usage,
      tokens: t2 !== null && Number.isFinite(timing.total_tokens)
        ? { ...(metricTokens(agg.tokens) ?? { input: null, output: null, cacheCreation: null, cacheRead: null }), total: timing.total_tokens }
        : metricTokens(agg.tokens),
      subagentTokens: agg.subagent === null ? null : sumTok(agg.subagent),
      byModel: agg.usage === 'reported' ? agg.byModel : null,
      costUsd: t2 !== null && Number.isFinite(timing.cost_usd) ? timing.cost_usd : agg.costUsd,
      claudeCodeVersion: agg.claudeCodeVersion,
      costBasis: agg.costBasis,
      // wall time is the harness's own duration_ms (result events, summed over segments); the process wall time, which
      // also holds start-up, is kept as wallMsProcess and is the fallback when a segment reported no duration
      wallMs: t2 !== null ? (Number.isFinite(timing.duration_ms) ? timing.duration_ms : null) : (resultMs !== null ? resultMs : (Number.isFinite(timing.duration_ms) ? timing.duration_ms : null)),
      wallMsProcess: Number.isFinite(timing.duration_ms) ? timing.duration_ms : null,
      capTokens: censored === 'cap' && statusRec?.budget !== true && Number.isSafeInteger(launch.maxTokensPerRun) ? launch.maxTokensPerRun : null,
      turns: agg.turns,
      toolCalls: agg.toolCalls,
      toolCounts: agg.toolCounts,
      subagentCalls: agg.subagentCalls,
      questions: { pauses: asked, offers: offered, blocked: blockedEnds, resumes: segRec?.resumes ?? 0, unanswered: segRec?.unansweredPause === true, askUserQuestion: agg.askUserQuestion },
    },
  };
}

/** Byte-stable text of an A/B grading (the key order `gradeAbRun` builds). */
function serializeAbGrading(g: any) {
  return `${JSON.stringify({
    key: g.key, id: g.id, split: g.split, kind: g.kind, group: g.group, arm: g.arm, run_status: g.run_status, infra: g.infra,
    isolation: g.isolation, isolationEvidence: g.isolationEvidence, exclusionReason: g.exclusionReason, proof: g.proof, capped: g.capped, censored: g.censored, permissionDenials: g.permissionDenials,
    pass_rate: g.pass_rate, checks: g.checks, review: g.review, routing: g.routing, ...(g.tier2 ? { tier2: g.tier2 } : {}), metrics: g.metrics,
  }, null, 2)}\n`;
}

/**
 * Grades every task directory of an iteration (arm from iteration.json) and, unless `write` is false,
 * writes `grading.json` into each. A task without a directory is returned as `{ id, missing: true }`
 * and nothing is created for it. `taskSet` is the `loadTaskSet` result or a task array. Every run is
 * checked against its launch record first (`checkLaunch`), so a refusal writes nothing.
 * @returns {object[]} gradings in task order
 */
function gradeIteration({ iterationDir, taskSet, config, pathInfo, write = true }: { iterationDir: string; taskSet: any; config: any; pathInfo: any; write?: boolean }) {
  const meta = JSON.parse(fs.readFileSync(path.join(iterationDir, 'iteration.json'), 'utf8'));
  const tasks = Array.isArray(taskSet) ? taskSet : taskSet.tasks;
  const name = path.basename(iterationDir);
  const runs = tasks.map((task: any) => {
    const runDir = path.join(iterationDir, task.id);
    if (!fs.existsSync(runDir)) return { task, runDir: null };
    checkLaunch({ runDir, task, arm: meta.arm, config, label: `${name}/${task.id}` });
    return { task, runDir };
  });
  return runs.map(({ task, runDir }: { task: any; runDir: any }) => {
    if (runDir === null) return { id: task.id, missing: true };
    const grading = config.mode === 'ab'
      ? gradeAbRun({ runDir, task, arm: meta.arm, config })
      : gradeRun({ runDir, task, arm: meta.arm, config, pathInfo });
    if (write) fs.writeFileSync(path.join(runDir, 'grading.json'), config.mode === 'ab' ? serializeAbGrading(grading) : serializeGrading(grading));
    return grading;
  });
}

module.exports = {
  MAX_FILES, EVIDENCE_MAX,
  parseTranscript, extractAnswer, simpleCommands, classifyIsolation, loadPathInfo, readLaunch, checkLaunch, gradeRun, serializeGrading, gradeIteration,
  aggregateReports, aggregateSessions, versionAtLeast, CUMULATIVE_USAGE_FROM, classifyAbIsolation, gradeAbRun, serializeAbGrading, runChecks,
  TIER2_KINDS, gradeTier2Workspace,
};

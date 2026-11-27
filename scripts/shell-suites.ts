'use strict';

// The shell suites a CI workflow runs, read from its `run:` steps. One parser for `npm run gate` and the G46
// guard, so the gate runs and the Repository facts row lists exactly what the workflow runs. It reads
// `run: bash test/x.sh` (inline, the value on the next line, or a `run: |` block of commands), with
// `./test/x.sh`, trailing arguments and a trailing `# comment`. A non-comment line that mentions
// `test/*.sh` and is not read as one of those is returned in `unreadable`, so a shape the parser does not
// know fails the caller instead of dropping a suite.
const SUITE_MENTION = /test\/[^\s'"`]*\.sh\b/;
const COMMAND = /^(?:bash|sh)[ \t]+(?:\.\/)?(test\/[^\s'"`;&|]+\.sh)(?:[ \t].*)?$/;
const CHAINED = /[;&|`<>]|\$\(/;
const RUN_KEY = /^([ \t]*)(-[ \t]+)?run:[ \t]*(.*)$/;

type Parsed = { suites: string[], unreadable: string[] };

/** The line without a trailing ` # comment` (a `#` that starts the line or follows white space). */
function withoutComment(line: string): string {
  return line.replace(/(^|[ \t])#.*$/, '$1').trimEnd();
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The shell suites of `workflow` in order, and the lines that mention a suite the parser could not read. */
function parseShellSuites(workflow: string): Parsed {
  const lines = workflow.split(/\r?\n/);
  const suites: string[] = [];
  const read = new Set<number>();
  const unreadable: string[] = [];

  /** Reads one command line; true when it was a suite command. */
  const command = (text: string, at: number): void => {
    const match = COMMAND.exec(text.trim());
    // Trailing arguments are fine; a second command (`&&`, `;`, a pipe, a substitution) is a shape not read.
    if (match && !CHAINED.test(text.slice(text.indexOf(match[1]) + match[1].length))) {
      suites.push(match[1]);
      read.add(at);
    }
  };

  for (let at = 0; at < lines.length; at += 1) {
    const key = RUN_KEY.exec(lines[at]);
    if (!key) continue;
    const inline = withoutComment(key[3]).trim();
    if (inline && !/^[|>][+-]?\d*$/.test(inline)) {
      command(inline, at);
      continue;
    }
    // A block (`|`, `>`) or the next-line form: the more indented lines that follow belong to the key.
    const keyColumn = indentOf(lines[at]) + (key[2] ? key[2].length : 0);
    for (let next = at + 1; next < lines.length; next += 1) {
      const text = withoutComment(lines[next]);
      if (!text.trim()) continue;
      if (indentOf(lines[next]) <= keyColumn) break;
      command(text, next);
    }
  }

  lines.forEach((line, at) => {
    if (!read.has(at) && SUITE_MENTION.test(withoutComment(line))) unreadable.push(`line ${at + 1}: ${line.trim()}`);
  });
  return { suites, unreadable };
}

module.exports = { parseShellSuites };

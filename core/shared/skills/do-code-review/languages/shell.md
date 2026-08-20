---
language: shell
extensions: [".sh", ".bash", ".zsh"]
---

# Shell — Language-Specific Review Notes

Load this file alongside `rules/universal.md`. Universal rules are not repeated here — only
shell-specific rules and idioms.

Shell sits in `languages/` rather than `content-types/` because it is executable code with real
control flow: functions, branches, loops, and a complexity reading that means something. Its
failure modes are its own, though — almost every serious shell bug is a quoting bug, an unchecked
exit status, or a command that ran in the wrong directory.

---

## PR Analyzer — Shell Risk Signals

- No `set -euo pipefail` (or equivalent) near the top of an executable script
- `rm -rf` with any variable in the path
- `eval`, or a command assembled by string concatenation
- `curl ... | bash`, or any pipe from the network into an interpreter
- `sudo` inside a script that is not documented as requiring it
- A `trap` that is registered but cleans up nothing, or is absent where a temp dir is created

## Code Quality — Shell Checks

- **Unquoted expansion** — `$VAR` rather than `"$VAR"` in any command touching a path. A value with
  a space becomes two arguments; a value with `*` becomes whatever the glob matched. This is the
  single most common real shell defect and the analyser flags it for path-acting commands.
- **Unchecked `cd`** — `cd "$dir"` without `|| exit` and without `set -e` leaves every subsequent
  line running in the previous directory. The commands still "succeed", against the wrong tree.
- **Unchecked command substitution** — `x=$(cmd)` swallows `cmd`'s exit status unless `set -e` and
  `pipefail` are both in force.
- **`[` vs `[[`** — prefer `[[ ]]` in bash: it does not word-split, so an empty variable does not
  turn a comparison into a syntax error.
- **Long functions** — the universal threshold applies; a shell function past it is usually several
  scripts that never got separated.

## Security

- Never interpolate untrusted input into a command string; pass it as an argument.
- `eval` is a finding unless the review can name why nothing else works.
- Secrets passed as command-line arguments are visible in `ps`; prefer an environment variable read
  from a file, or stdin.
- A temp file created without `mktemp` is a predictable path, which is a symlink attack.
- `IFS` changed without being restored affects every later word-split in the script.

## Async / Concurrency

- A backgrounded job (`&`) whose exit status is never collected by `wait` fails silently.
- `nohup ... &` detaches deliberately; the review should confirm the output redirection is explicit,
  since an inherited stdin or stdout fd can hold a pipe open and hang the caller.
- Parallel writes to one file from backgrounded jobs interleave; append-with-`>>` is not atomic
  above the pipe buffer size.

## Resource Management

- Every `mktemp` needs a matching `trap ... EXIT` that removes it, including on the error paths.
- A `trap` registered after the resource is created leaves a window where a signal leaks it.
- File descriptors opened with `exec 3<` are closed with `exec 3<&-`, not by falling off the end.

## Exception Handling

- Shell has no exceptions; `set -e` plus explicit `|| { ...; exit 1; }` is the mechanism.
- `set -e` does not apply inside a command substitution, a condition, or the left side of `&&` —
  a review that assumes it does will pass code that silently continues.
- An error message must go to stderr (`>&2`), or a caller capturing stdout will absorb it as data.
- A non-zero exit that is expected and handled should say so in a comment; a reader cannot tell an
  ignored failure from a tolerated one.

## Performance

- A loop calling an external binary per line is the usual cause of a slow script; `awk`, `sed` or a
  single `xargs` does the same work in one process.
- `$(cat file)` reads the whole file into memory; `< file` in a redirect does not.
- Subshells `( )` fork; braces `{ }` do not. Reaching for the first out of habit costs a process per
  iteration.

## Idioms and Best Practices

- `#!/usr/bin/env bash` rather than a hardcoded interpreter path.
- `set -euo pipefail` at the top of anything executable, with a comment where one of the three is
  deliberately omitted (a hook that must fail open, for example — see this repository's own hooks).
- Quote every expansion by default; make the unquoted ones the exception that carries a comment.
- `local` on every variable inside a function — shell variables are global otherwise.
- `readonly` for constants, so a later assignment is an error rather than a surprise.
- `shellcheck` catches most of the above; this file exists because the bundled analyser must work
  without it (see the skill's no-external-dependency constraint).

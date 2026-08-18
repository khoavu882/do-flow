# Answer — what `--prune` does in `doflow remove`

**Short answer: nothing.** `--prune <N>` is a real, globally-parsed option, and it means "keep only
the N most recent backups" — but `doflow remove` never reads it. Only `install` and `update` act on
it.

## What the flag means

`bin/doflow.js:884` (the `--help` text): `--prune <N>   Keep only N most recent backups`

`src/backup.js:157` `pruneBackups(backupRoot, keepN)` is the implementation: it lists the directories
under the backup root, sorts them newest-first by mtime, and `rmSync`s everything past the first
`keepN`. `keepN <= 0` is a no-op, as is a missing backup root. It returns the basenames of what it
deleted.

## Where it is actually wired

Parsed for every command at `bin/doflow.js:140–143` into `o.prune` (default `0`), but only two call
sites consume it, and both are guarded by `if (o.prune > 0)`:

- `bin/doflow.js:1030`, inside `cmdInstall` (starts at :950)
- `bin/doflow.js:1112`, inside `cmdUpdate` (starts at :1038)

Both run right after the run's own backup is written, so the effect is: take the backup, then trim
the backup directory down to the N newest — the one just created included in the count.

`cmdRemove` starts at `bin/doflow.js:1120` and never references `o.prune`. It also takes no backup of
its own; it resolves targets, builds a registry lifecycle view, confirms, calls `removeLifecycle`,
and prints a retention summary. So `doflow remove --prune 3` parses without error and silently does
no pruning.

## Two caveats worth knowing

- The parser is lenient here in a way its neighbours are not. `--days` rejects a non-positive value
  with an explicit exit 2 and a message; `--prune` uses `parseInt(val, 10) || 0`, so
  `--prune notanumber` becomes `0` — silently disabling the prune rather than complaining.
  `--prune` with no following value, or a following value starting with `-`, does exit 1.
- `--prune` appears nowhere in `docs/` or `README.md`. Its only documentation is the `--help` block.

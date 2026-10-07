# v1.18.0 install fixtures

MCP state as DoFlow v1.18.0 left it, used by the upgrade tests to check that a newer `update` keeps
every server and user entry and that a second run changes nothing. Each scenario holds only the
files that carry MCP state; the test lays down the non-MCP tree with the current `install` for the
same targets, then overlays these files.

## Capture

From a `git worktree` of tag `v1.18.0` (`<tag>`), with a fresh `mktemp -d` for `HOME` and for
`XDG_CONFIG_HOME` per scenario and `GIT_CONFIG_GLOBAL=/dev/null`:

| Scenario | Command |
|---|---|
| `global-multi` | `node <tag>/bin/doflow.js install -g -t claude,codex,gemini,opencode,pi --mcp context7,sequential-thinking --force` |
| `global-kiro` | `node <tag>/bin/doflow.js install -g -t kiro --force` |
| `project-claude-copilot` | `node <tag>/bin/doflow.js install -t claude,copilot --mcp context7 --force <project>` |

After the install each MCP file gained one entry named `user-server`, written by hand
(`command: user-cmd`, `--user-owned`). The Claude `sequential-thinking` entry in `global-multi` is
left as DoFlow wrote it.

## Layout

Per scenario directory, paths relative to the scenario root (`HOME` for the global scenarios, the
project directory for the project one), with the leading dot of the first path component dropped
because `.gitignore` ignores `.doflow`, `.pi`, `.codex` and `.mcp.json`:

- `doflow/doflow.lock` and `doflow/.install-manifest.json` (`.doflow/` on disk)
- each harness's MCP file: `claude.json`, `codex/config.toml`, `config/opencode/opencode.json`,
  `pi/agent/mcp.json`, `kiro/settings/mcp.json`, `mcp.json` (`.mcp.json` on disk)
- `mcp-ledger-rows.json`: the MCP rows of `.doflow/state/ledger.json` (`kind: mcp-server`,
  `kiro:mcp:*`, `copilot:mcp:registration`)

The scratch root is replaced by `@ROOT@` in every file, and the tag worktree path in the manifest's
`source_path` by `@ROOT@/v118`. Nothing else was edited.

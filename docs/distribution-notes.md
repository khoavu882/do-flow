# Distribution notes: Copilot plugin manifest and Pi package (issue #23)

Research record and close rationale for issue #23 (distribution packages). It answers the two
research questions with sources, states what was implemented and why, and records the blocking
gaps a future packaging effort must clear. Written because one half of the issue was implementable
truthfully today (Copilot) and the other was not (Pi), under the parity doctrine: *an installed
file is not evidence of activation*.

## A. GitHub Copilot CLI plugins — findings

**Do component paths have to be conventional? No.** `plugin.json` declares component locations
explicitly; conventions are only defaults:

| Field | Type | Default | Notes |
|---|---|---|---|
| `agents` | string \| string[] | `agents/` | Agent directories containing `.agent.md` files |
| `skills` | string \| string[] | `skills/` | Skill directories containing `SKILL.md` files |
| `hooks`, `mcpServers`, `lspServers`, `commands`, `extensions` | various | — | File paths or inline objects |

Source: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference>
(sections "`plugin.json`" → "Component path fields", "File locations").

**How does a repo become a plugin?**

- Imperative: `copilot plugin install SPECIFICATION`, where SPECIFICATION is `plugin@marketplace`,
  `OWNER/REPO` (repository root), `OWNER/REPO:PATH/TO/PLUGIN` (**subdirectory of a repository**),
  any Git URL, or a local path (`./my-plugin`, `/abs/path`). Same reference page, "Plugin
  specification for `install` command".
- Declarative: an `enabledPlugins` entry in user-level `~/.copilot/settings.json` or repo-level
  `.github/copilot/settings.json`. Source:
  <https://docs.github.com/en/copilot/concepts/agents/about-plugins>.
- Marketplace: `copilot plugin marketplace add SOURCE`; the marketplace's `marketplace.json` may
  live at the marketplace root, `.plugin/`, `.github/plugin/`, or `.claude-plugin/`. DoFlow's
  existing `core/.claude-plugin/marketplace.json` is therefore already discoverable by both Claude
  Code and Copilot CLI (the reference page notes explicitly that Copilot CLI also looks in
  `.claude-plugin/`).

**Manifest discovery order** (same reference page, "File locations"): `.plugin/plugin.json`,
`plugin.json`, `.github/plugin/plugin.json`, `.claude-plugin/plugin.json` — checked in this order.
**There is no `.copilot-plugin/` location.** This contradicts the issue's suggested
`.copilot-plugin/plugin.json` path under `core/`: such a file would never be read by Copilot CLI
and would be exactly the inert-artifact pattern the parity doctrine forbids. The implemented
manifest lives at the first-checked location instead: `core/.plugin/plugin.json`.

### What was implemented (Copilot)

- `core/.plugin/plugin.json` — a skills-only manifest: metadata + `"skills": "./shared/skills/"`.
  Every declared component activates per vendor documentation; nothing else is declared.
- Deliberately **not** declared:
  - `agents` — Copilot custom agents are `*.agent.md` files (deduplicated by file-name-derived ID);
    DoFlow's shared agent-specs are plain `*.md` with name/description frontmatter, authored for
    Claude Code's agent model. Declaring them would install without activating.
    Source: <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating>
    and the loading-order section of the plugin reference.
  - `hooks` — DoFlow's hook scripts are Claude-payload-coupled (tool names, stdin fields, env
    vars); this is already recorded as deliberately unprojected in `core/registry/harnesses.json`
    (copilot → capabilities → hooks).
  - `mcpServers` — MCP registration is installer-managed and opt-in (`--mcp context7,...`);
    a plugin declaration would force-enable servers for every plugin user.
- Guard coverage: `test/install/doflow.test.js` asserts name/version match `package.json`, the
  skills path resolves to real `SKILL.md` skill directories, and that none of the
  non-activating component fields appear.
- Docs: setup.md "GitHub Copilot CLI plugin" section (install commands, verification steps);
  architecture.md repo map row.

Install routes that work with these artifacts:

```bash
copilot plugin install /path/to/do-flow/core     # local checkout
copilot plugin install khoavu882/do-flow:core    # subdirectory of a GitHub repository
copilot plugin marketplace add /path/to/do-flow/core   # via the existing .claude-plugin/marketplace.json
```

**Verification limit:** no `copilot` binary was available locally, so activation claims rest on the
cited vendor pages rather than a live run. The guard encodes the documented contract so drift in
our own tree fails fast.

## B. Pi packages — findings

Schema (from <https://pi.dev/docs/latest/packages>, mirrored at
<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>):

- Manifest: a `pi` key in `package.json` — `{ "pi": { "extensions": [...], "skills": [...],
  "prompts": [...], "themes": [...] } }`. Paths are relative to the package root; arrays support
  glob patterns and `!exclusions`. Without a `pi` key, pi auto-discovers conventional directories
  (`extensions/`, `skills/`, `prompts/`, `themes/`).
- Discoverability: add `"keywords": ["pi-package"]`; the gallery at <https://pi.dev/packages>
  lists packages tagged `pi-package`.
- Install forms: `pi install npm:@foo/bar@1.0.0`, `pi install git:github.com/user/repo@v1`
  (also `git@github.com:...` shorthand, `https://`, `ssh://`), or local paths (`/abs`, `./rel`,
  which are added to settings without copying).
- Git/npm installs clone/download the **whole repository/package root** to
  `~/.pi/agent/git/<host>/<path>` (or `~/.pi/agent/npm/`) and run `npm install` there when a
  `package.json` exists.

**Can a subdirectory of a git repo be the package root? No.** The Package Sources section defines
repo-root URLs with an optional `@ref` pin and nothing else — there is no `#subdir`, `:path`, or
fragment syntax for git or npm sources. Arbitrary subpaths work only for *local* installs, which
are not a distribution channel (no copying, no fetching).

### Why the Pi package was NOT implemented

Making the do-flow CLI package itself a pi-package would require:

1. Adding `"pi-package"` to `@khoavu882/doflow`'s npm keywords — leaking Pi payload identity onto
   the installer CLI's npm page and listing it in the pi.dev package gallery alongside actual
   Pi payload packages. The tool and the payload would share one public identity.
2. `pi install git:github.com/khoavu882/do-flow` cloning the entire CLI repository (src/, test/,
   bench/, docs/) into every Pi user's package directory just to read `core/shared/skills/`, and
   running `npm install` inside it.

Both violate the decision rule (declare only what is truthful; do not pollute identity). Verdict:
**not implementable truthfully today**; no code shipped for Pi.

### What a future build-step packaging would look like

- Dedicated payload package: CI assembles a publishable artifact from `core/shared/` (skills plus
  any prompt templates) into its own npm package (e.g. `@khoavu882/doflow-skills`) or a separate
  repository/orphan branch whose root is the payload. The CLI package keeps clean keywords; Pi
  users run `pi install npm:@khoavu882/doflow-skills` or the git equivalent. The release step owns
  the copy, so the single-source rule stays intact (generated artifact, not a maintained duplicate).
- Upstream request: ask pi (earendil-works/pi) for git subdirectory support (`repo#subdir@ref`),
  which would let `core/` serve directly, mirroring how Copilot CLI accepts `OWNER/REPO:SUBDIR`.
- Copilot agents, if ever wanted: either upstream accepts plain `.md` agent files, or the same
  build step emits `.agent.md` variants into the packaged artifact — never as maintained
  per-harness copies in this repository.

## Disposition

- Copilot plugin manifest: implemented (`core/.plugin/plugin.json` + guard + docs).
- Pi package: closed as not-implementable-today (root-repo-only sources + keyword/identity leak);
  revisit via the build-step options above.

---
description: Settings keys, configuration scopes, defaults, and config home directory resolution.
---
# Settings

DoFlow configuration layers resolve settings across registry defaults, environment variables, and user and project settings files.

## Settings keys

<!-- BEGIN GENERATED:settings-keys -->
| Key | Type | Default | Scope | Env | Legacy file | Description |
|---|---|---|---|---|---|---|
| `advice.enabled` | boolean | `false` | narrow-only | — | `decision-model.json` | Turns the local decision model on; a project may only turn it off. |
| `advice.provider` | enum | `ollama` | global-only | — | `decision-model.json` | Decision-model provider id from advice.json. |
| `advice.endpoint` | url | `http://127.0.0.1:11434` | global-only | — | `decision-model.json` | Decision-model endpoint; default is the provider's defaultEndpoint. |
| `advice.model` | string | `—` | project-overridable | — | `decision-model.json` | Decision-model name; a project may choose it while advice is on. |
| `storage.prune` | enum | `on` | project-overridable | — | `prune` | Storage pruning; project value applies to project roots only. |
| `storage.retentionHours` | integer | `4320` | project-overridable | `DOFLOW_RETENTION_HOURS` | `—` | Lifecycle-events window in hours; an explicit value applies even while pruning is off. |
| `failure.capture` | enum | `on` | global-only | `DOFLOW_FAILURE_CAPTURE` | `failures/off` | Capture of DoFlow's own failures on this machine; any layer saying off wins. |
| `autopilot.enabled` | enum | `off` | global-only | `DOFLOW_AUTOPILOT_ENABLED` | `autopilot/off` | Roadmap autopilot kill switch, off until the owner turns it on; the env and the autopilot/off sentinel can only turn it off. |
| `guard.workerDropDatabases` | string | `—` | project-only | — | `—` | Space-separated exact database names a worker session may DROP DATABASE; project layer only. |
| `verify.reuse` | enum | `off` | global-only | `DOFLOW_VERIFY_REUSE` | `—` | Reuse of a recorded PASS at L1/L2 when the check key is unchanged, off until the owner turns it on; the env can only turn it off. |
| `dispatch.fallback` | enum | `ask` | narrow-only | — | `—` | Quota fallback ladder default for dispatch runs: ask holds and proposes, off holds without a proposal; auto exists only per run via --fallback. |
<!-- END GENERATED:settings-keys -->

`autopilot.enabled` is the roadmap loop's kill switch: `off` unless a person turns it on. It is global-only, so a project layer never sets it. To turn it on, write `{"schema":1,"autopilot.enabled":"on"}` into `<config home>/settings.json` yourself (`config set` is not supported). `DOFLOW_AUTOPILOT_ENABLED` accepts only the off words (`off`, `0`, `false`, `no`) and can only turn the loop off; it cannot turn it on. `src/runtime/settings/autopilot.ts` holds two readers: `readKillSwitch`, used by the roadmap loop and `orchestrate --action decide-gate --policy`, which fails to off on any doubt and counts the env off layer; and `readSeedSwitch`, used by the `roadmap seed` verb, which fails closed the other way: it refuses on any doubt, ignores the env layer, and allows only a verified durable off. The sentinel `<config home>/autopilot/off` also forces off, and a sentinel that cannot be read (any stat error but a missing file) counts as present: the loop's tripwire writes it when it sees a revert of an autopilot merge or a `merged-unverified` result, and only a person removes it. The loop and `orchestrate --action decide-gate --policy` read every layer on every call and fail to off on a missing config home or an unreadable setting. The key combines by `override`, so `doflow config -g` can show `on` while only the sentinel is set (the sentinel is listed as a shadowed candidate); the loop still stops and names `sentinel` in `annotations.switch`. Trust the loop's answer, not the `config` value.

`dispatch.fallback` accepts only `off` and `ask`, and `auto` never takes effect from settings: a user-scope `settings.json` naming `auto` is invalid and the key's fail-safe `off` applies, while a project or local file naming it is ignored and the other layers decide (default `ask`). `auto` exists only per run, and a project may only narrow the setting to `off`.

The default endpoint is the selected provider's `defaultEndpoint` in `advice.json`. `storage.retentionHours` defaults to the `lifecycle-events` bound in `storage.json`.

`advise --action configure` writes advice settings to `settings.json`; an existing `decision-model.json` is left intact and remains readable with a deprecation note. The old `prune` file is also still read with a deprecation note. Settings written by this release are not seen by earlier betas or 2.0.x; the older files are left intact for those versions.

`failure --action capture --set on|off` writes `failure.capture` in the global `settings.json`. An existing `failures/off` sentinel remains in place and still disables capture, including after `--set on`; remove the sentinel yourself to turn capture back on.

`guard.workerDropDatabases` configures a space-separated list of exact lowercase database names (`[a-z][a-z0-9_]{0,62}`, at most 32 names, at most 1 KiB, all-or-nothing); each name is at most 63 characters. A worker session may drop one listed name with a single `psql -c` or `mysql -e` command running `DROP DATABASE [IF EXISTS] <name>`. The key has `project-only` scope: set it in `<project>/.doflow/settings.json` or `.doflow/settings.local.json`; global values, environment variables, and CLI flags do not set it. At launch, the launcher resolves and validates the list from the owning project and exports `DOFLOW_GUARD_DROP_DATABASES`; the hook reads only this snapshot. An unset, empty, or invalid list grants no relaxation. The hook cannot verify which host the database client contacts.

Codex worker write access to `<project>/.doflow/settings.json` is measured only for the sandbox scope: Codex CLI 0.163 probes using `codex sandbox -P :workspace` denied the write when the project was outside sandbox-writable roots (not under `/tmp` or `$TMPDIR`, and not the command cwd), and allowed it when the project was under `/tmp` or `$TMPDIR`. The production launch flag `-s workspace-write` was not probed separately. FU-gxbryp tracks the possibility of a worker under a sandbox-writable root planting a database name for a later launch; the launch snapshot blocks self-authorization during the same run.

## Config home

DoFlow's per-machine files (`prompt-nudge`, `prune`, `decision-model.json`, `settings.json`, `failures/`, `reports/`, `session-env/`, `sessions.log`) live in one folder, `<base>/doflow`. The base is `XDG_CONFIG_HOME` when it is set to an absolute path, else `$HOME/.config` when `HOME` is set to an absolute path, else there is no config home. A relative or empty value is ignored, never read against the working directory, and DoFlow does not fall back to the account's home folder. Node code and every shell script and hook resolve it by the same rule.

With no config home, nothing is read from it, failure capture is skipped, session state is skipped (session hooks write nothing and exit 0; guard hooks still reach their own decision), and `doflow advise --action configure` exits 2 with a usage message naming an absolute `HOME` or `XDG_CONFIG_HOME`.

Failure capture also reads `failure.capture` from `<config home>/settings.json` with one text rule that the dispatcher, the shell policies, the JS hook runner and Node all apply to the file's bytes up to the first NUL: every `"failure.capture": <value>` pair found must have the value `"on"`, and any other value means capture is off. JSON validity does not matter, one pair that is not `"on"` makes it off even when another says `"on"`, and a file that is not a regular file or cannot be read means off. A missing file or a file without the key leaves capture on. The environment and the `failures/off` sentinel can still only turn capture off.

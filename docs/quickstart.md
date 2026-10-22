---
description: The shortest path from a clean machine to a verified installation and a first workflow.
---
# Quickstart

Use this page to reach a working installation quickly. For all flags, scopes, MCP configuration,
and recovery procedures, continue to [Setup](setup.md).

## 1. Install

DoFlow needs Node.js `^22.18.0 || >=24.3.0` (the `engines.node` range in `package.json`). A source
checkout runs its TypeScript directly through Node's type stripping; the npm package ships
JavaScript built by `npm run build:package`, and its `bin/doflow.js` still checks for type-stripping
support, so the same Node range applies. Git, `bash` and
`jq` are also needed for the hook scripts; [Setup](setup.md#prerequisites) lists every prerequisite.

DoFlow installs into eight tools: Claude Code, Codex, Gemini CLI, OpenCode, Pi, GitHub Copilot CLI,
Kiro, and Antigravity. Preview the plan, then install only the tools you use (`--target` takes
`claude`, `codex`, `gemini`, `opencode`, `pi`, `copilot`, `kiro` or `antigravity`):

```bash
npx @khoavu882/doflow install --dry-run -g --target claude,codex
npx @khoavu882/doflow install -g --target claude,codex
```

The examples below shorten `npx @khoavu882/doflow` to `doflow`; both are equivalent, and a linked
checkout (see [Setup](setup.md)) gives you the short form directly.

## 2. Verify

```bash
doflow status -g
doflow doctor
```

`status` shows what is installed and where; `doctor` checks the harness adapters, external tools,
and runtime capabilities. In Claude Code, run `/do`. In Codex, open a configured project and ask it
to use an installed skill such as `do-execute-plan` or `do-diagnose`.

## 3. Run one workflow

```text
/do-brainstorm "add an audit export"
/do-design
/do-plan
/do-execute-plan --scope next
/do-test
/do-code-review
```

Or let DoFlow advance the phase sequence with approval gates:

```text
/do-flow "add an audit export"
```

## Next steps

- [Setup](setup.md) for installation details and rollback.
- [Guide](guide.md) for task-based workflows.
- [Home](index.md#the-component-model) for the component and lifecycle diagrams.

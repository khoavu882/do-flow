# Quickstart

Use this page to reach a working installation quickly. For all flags, scopes, MCP configuration,
and recovery procedures, continue to [Setup](setup.md).

## 1. Choose an installation path

| Path | Best for |
|---|---|
| Claude-only | A personal Claude Code configuration with hooks and MCP support |
| CLI install | One source deployed to Claude, Codex, and/or Gemini; supports project scope and rollback |

### Claude Code only

```bash
git clone git@github.com:khoavu882/do-flow.git ~/.claude
chmod +x ~/.claude/hooks/*.sh
```

### CLI install

```bash
git clone git@github.com:khoavu882/do-flow.git ~/do-flow
cd ~/do-flow
npm link

# Preview, then install only the tools you use.
doflow install --dry-run -g --target claude,codex
doflow install -g --target claude,codex
```

## 2. Verify

```bash
doflow status -g
```

In Claude Code, run `/do-help`. In Codex, open a configured project and ask it to use an installed
skill such as `do-implement`.

## 3. Run one workflow

```text
/do-brainstorm "add an audit export"
/do-design
/do-plan
/do-execute-plan --next --safe
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
- [Overview](overview.md) for the component and lifecycle diagrams.

# Overview

How the framework's components — hooks, agents, skills, and MCP servers — fit together.

---

## Two Context Horizons

Every AI session has two layers of memory that operate at different timescales:

| Horizon | Scope | Managed By | Survives Session? |
|---------|-------|------------|-------------------|
| **Short-context** | Active conversation window | LLM token budget (auto-compacted at 75%) | No |
| **Long-context** | Cross-session persistence | Files on disk, native memory (MEMORY.md + agent-docs) | Yes |

Hooks bridge these two horizons. `SessionStart` captures state to disk, `UserPromptSubmit` injects lightweight context plus the prior session's compact summary directly on the first prompt, and compaction hooks preserve those summaries to disk for the next session to read.

---

## Session Initialization Flow

What happens when Claude Code opens:

```mermaid
flowchart TD
    A([Claude Code Starts]) --> B[Load settings.json]
    B --> C[Parse Hook Registrations]
    B --> D[Start MCP Servers]
    B --> E[Load CLAUDE.md into system prompt]

    E --> E1[FLAGS.md]
    E --> E2[PRINCIPLES.md]
    E --> E3[rules/RULE_01_SAFETY.md]
    E --> E4[rules/RULE_02_WORKFLOW.md]
    E --> E5[rules/RULE_03_QUALITY.md]
    E --> E6[rules/RULE_04_QUESTIONS.md]

    D --> D1[Context7]
    D --> D2[Sequential Thinking]
    D --> D4[Chrome DevTools]
    D --> D5[Playwright]

    C --> F[Fire SessionStart Hook]
    F --> F1{Git repo detected?}
    F1 -->|Yes| F2[Capture: branch + last commit]
    F1 -->|No| F3[Skip git capture]
    F2 --> G[Session Ready]
    F3 --> G

    G --> I([Context Window Active])
```

**Always in context** (every session): `FLAGS.md`, `PRINCIPLES.md`, and `rules/*.md`. Git state enters on the first prompt through `UserPromptSubmit`.

**Not auto-loaded** (on-demand): behavioral modes, MCP documentation, reference files, agents (instantiated on demand).

---

## Per-Turn Context Building

How context grows with each user message:

```mermaid
sequenceDiagram
    actor User
    participant H as Hooks
    participant C as Context Window
    participant LLM as Claude (LLM)
    participant T as Tools

    User->>C: Types message
    C->>H: UserPromptSubmit fires (first prompt only)
    H->>C: Injects git branch + last commit
    C->>LLM: Full context sent

    loop Until response complete
        LLM->>T: Tool call (Read / Edit / Bash / Agent / MCP...)

        alt PreToolUse — Bash
            T->>H: pre-bash-guard.sh fires
            H-->>T: Exit 0 = allow | Exit 2 = BLOCK
        end

        T-->>C: Tool result added to context
    end

    alt PostToolUse — Edit or Write
        T->>H: post-edit-lint.sh fires (async, non-blocking)
        Note over H: ruff / eslint / gofmt / spotless
    end

    LLM->>C: Response added to context
    C->>User: Display response

    alt Stop event
        LLM->>H: stop-check.sh fires
        H-->>LLM: Allow OR retry (TODO/stub found in last response)
    end
```

---

## Session Lifecycle States

```mermaid
stateDiagram-v2
    direction LR

    [*] --> Initializing: claude start

    Initializing --> Active: settings.json loaded\nSessionStart hook fired

    Active --> Working: User prompt received\nUserPromptSubmit hook fired

    Working --> Working: Tool calls and results\nadd to context window

    Working --> Active: Turn complete\nStop hook passes

    Working --> Blocked: Stop hook returns systemMessage\n(TODO/stub detected)

    Blocked --> Working: Claude completes the stub\nand retries

    Active --> PreCompact: Context reaches 75%

    PreCompact --> Compacting: pre-compact.sh fires\nWrites git state to compact summary

    Compacting --> Active: Context compressed

    Active --> Ending: exit or session close

    Ending --> [*]: session-end.sh fires\nLogs session, trims log
```

---

## Cross-Session Memory

How state persists from one session to the next:

```mermaid
flowchart TD
    subgraph SESSION_N["Session N"]
        WN[Work happens — context fills to 75%]
        PC[PreCompact fires]
        WN --> PC
        PC --> TS[post-compact.sh saves\ncompact summary to disk]
        WN --> SE[SessionEnd fires]
        SE --> LOG[Append END to sessions.log\nDelete session directory]
    end

    subgraph DISK["Persistent Storage"]
        TS2[last-compact-summary.md + meta.json\n~/.config/doflow/session-env/projects/]
        LOG2[sessions.log]
        MEM[Native memory: MEMORY.md + agent-docs]
    end

    subgraph SESSION_N1["Session N+1"]
        SS[SessionStart fires]
        INJ[UserPromptSubmit injects:\ngit context + prior compact summary,\nif present, directly into the first prompt]
        SS --> INJ
    end

    TS --> TS2
    SE --> LOG2
    TS2 -->|First prompt detects and injects directly| INJ
```

**Default behavior**: Sessions start with lightweight git context, plus the prior session's compact summary automatically injected on the first prompt if one exists on disk — no manual restore command needed.

---

## Agents vs Skills vs Modes

| Mechanism | How It Enters Context | Cost | Use When |
|-----------|----------------------|------|----------|
| **Skill** (`/do-*`) | Skill prompt expanded inline | Medium | Structured workflows |
| **Agent** (`Agent` tool) | Only return message in main context | Low | Parallel work, large tasks |
| **Mode** (manual Read) | Full `MODE_*.md` file loaded | High | Session-wide behavioral change |
| **MCP call** | Tool result injected | Varies | Library docs, code analysis |
| **Hook injection** | `additionalContext` at prompt | Very low | Ambient metadata (git state) |

**Subagent efficiency:** When a skill uses `Agent` tool delegation, the main session's context only grows by the size of the subagent's *return message* — not its full working context. This is why `--delegate` protects the main window on large operations.

---

## Context Budget

```
Total context budget: ~200K tokens (Sonnet 4.6)
Auto-compact threshold: 75% = ~150K tokens consumed

Typical per-session allocation:
├── System prompt (CLAUDE.md + rules + FLAGS + PRINCIPLES): ~8–12K tokens
├── Skill/mode expansions (if loaded): ~5–15K per skill
├── MCP server tool schemas (all 5 servers): ~10–20K tokens
├── Conversation turns: ~2–5K per turn (with thinking tokens)
└── Tool results: ~1–50K per call (varies widely)

At 75% -> PreCompact fires -> context compressed
Summary saved to disk -> next session's first prompt injects it automatically
```

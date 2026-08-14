# Capability Router & Provider Matrix

Abstract capabilities and provider fallback chain:

| Information Intent | Preferred Capability | Primary Provider | Fallback Chain |
| :--- | :--- | :--- | :--- |
| Exact symbol, path, or regex pattern | `code.exact-search` | `native.rg` (Ripgrep/Grep) | — |
| Natural-language concept or behavior | `code.semantic-search` | `semble.search` (Semble) | `code.exact-search` (`native.rg`) |
| Call graph, dependencies, caller/callee | `code.relationships` | `graphify.query` (Graphify) | `code.exact-search` (`native.rg`) |
| Change blast radius / impact analysis | `code.impact-analysis` | `graphify.query` (Graphify) | `code.relationships` $\rightarrow$ `code.exact-search` |
| Git commit rationale, blame, history | `history.search` | `git.native` (Git CLI) | — |
| Behavioral test execution | `behavior.verify` | `native.test` (Test Runner) | — |
| High-output CLI command execution | `command.compress` | `rtk` (Rust Token Killer) | Raw uncompressed command |
| External API/framework documentation | `docs.lookup` | `context7` MCP | Web search / Native docs |
| Multi-step structured reasoning | `reasoning.structured`| `sequential-thinking` MCP | In-context chain of thought |

## Progressive Escalation
1. If exact symbol/path is known $\rightarrow$ Use native Ripgrep / exact search immediately.
2. If concept is semantic $\rightarrow$ Try Semble semantic search, fall back to Ripgrep.
3. If structural impact $\rightarrow$ Query Graphify, fall back to Ripgrep call-site search.

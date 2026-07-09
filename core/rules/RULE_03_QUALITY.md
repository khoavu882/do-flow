# Quality Rules

## Organization & Hygiene
**Naming**: Follow language standards (camelCase JS, snake_case Python); no mixed conventions
**Files**: Organize by feature/domain; tests → `tests/`; scripts → `scripts/`; reports → `agent-docs/`
**Workspace**: Remove temp files, debug scripts, build artifacts after use; never leave clutter in VCS

OK: `getUserData()`, `tests/auth.test.js`, `scripts/deploy.sh`, `agent-docs/analysis.md`
NOT OK: `get_userData()`, `auth.test.js` next to source, `debug.sh` in root

---

## Professional Honesty
- No marketing language ("blazingly fast", "100% secure", "magnificent")
- No invented metrics; state "untested/MVP/needs validation" honestly
- Push back on bad approaches; evidence-based claims only

OK: "Faster but uses more memory — trade-off to consider"
NOT OK: "This magnificent solution is blazingly fast and 100% secure!"

---

## Tool Optimization
- MCP > Native > Basic; parallel-first for independent ops
- Use Grep (not bash grep), Glob (not find), MultiEdit (not sequential Edits)
- Task agents for >3-step operations; match MCP to purpose

# do-code-review

Code review automation for TypeScript, JavaScript, Python, Go, Swift, Kotlin, C#, .NET, Java, C,
C++, Rust, Ruby, PHP, Dart/Flutter and markdown/prose. All three bundled scripts (`pr_analyzer.py`,
`code_quality_checker.py`, `review_report_generator.py`, under `scripts/`) are stdlib-only — no
`pip install` required.

Everything else — dispatch tables, thresholds, verdict table, fixture harness — is in
[`SKILL.md`](./SKILL.md), the file the harnesses actually load. This README is a contributor
pointer, not a second copy.

---
content-type: config
extensions: [".yaml", ".yml", ".json"]
---

# Declarative Config — Content-Specific Review Notes

YAML and JSON are not `languages/*.md` entries. The language template's required sections
(Async/Concurrency, Resource Management, Exception Handling, Performance) describe code-execution
concerns that do not exist for declarative data. Forcing config through that template would produce
empty or fabricated sections — the same reasoning that puts markdown in `content-types/`.

More concretely: a cyclomatic complexity, a function count, or a SOLID verdict for a YAML file is a
number with nothing behind it. Reporting one is precisely the false-confidence defect that adding
these analysers was meant to remove, so the analyser reports none of them and this file names no
rule that would need one.

Load this file **instead of** `rules/universal.md` plus a language file. It has no universal
counterpart, same as `content-types/markdown.md`.

---

## What the analyser checks deterministically

`scripts/code_quality_checker.py` routes these extensions to its declarative path and reports:

| Check | Why it matters |
|---|---|
| Parse validity | A JSON file that does not parse is a deploy-time failure, not a review comment |
| Duplicate keys at one level | The later value silently wins; the earlier one looks live but is dead |
| Nesting depth | Past a point, an indentation mistake is undetectable by reading |
| Credential-shaped literals | A `password:`/`token:`/`api_key:` with a literal value in a committed file |

Everything below is for the reviewer, not the analyser.

## Correctness

- **Duplicate keys** — YAML permits them and resolves to the last; most parsers do not warn. Check
  merged or templated files especially, where a key can be introduced twice from different sources.
- **Type coercion** — unquoted `yes`, `no`, `on`, `off`, `true`, `false` become booleans in YAML 1.1;
  `NO` as a country code and `on` as a key have both caused real outages. Quote strings that could
  be read as another type.
- **Sexagesimal and octal** — an unquoted `1:30` can parse as 90, and a leading zero can mean octal.
  Version strings and identifiers are quoted.
- **Anchors and aliases** — `&anchor` / `*alias` save repetition but move the definition away from
  the use. Deep anchor chains are a readability finding; an alias that overrides only some keys via
  merge (`<<:`) is a correctness one, since merge order is not obvious.
- **Empty vs absent** — `key:` with no value is null, which is not the same as the key being absent.
  Confirm the consumer treats them the same way if the file relies on it.

## Security

- No credential literals: passwords, tokens, API keys, private keys, connection strings with
  embedded auth. A value that looks like a placeholder still ships if nothing replaces it.
- A permissive default is a finding: `allowAll`, `verify: false`, `insecureSkipTLSVerify`,
  `0.0.0.0/0`, a wildcard CORS origin. Each needs a comment saying why.
- Check that a config claiming to reference a secret store actually does, rather than naming one in
  a comment beside a literal.

## Structure and Maintainability

- **Depth** — deeply nested config is hard to review and easy to mis-indent. Prefer a flatter shape
  or a split file over another level.
- **Duplication across environments** — three near-identical env files drift. Look for the one key
  that differs by accident rather than by intent.
- **Ordering and grouping** — related keys adjacent, and a consistent order across sibling files, so
  a diff between two environments is readable.
- **Comments** — a non-obvious value (a timeout, a magic port, a feature flag) carries a comment
  saying what it is for. A config file has no other place to put the reasoning.

## API Specifications (OpenAPI, JSON Schema)

Treated as config here rather than as a separate content type — the checks above all apply, plus:

- Every operation has an `operationId`, and it is unique across the document.
- Every response the implementation can return is documented, including the error shapes.
- `required` is stated explicitly on request bodies; an omitted `required` reads as optional.
- `additionalProperties` is decided rather than defaulted, since the default is permissive.
- `$ref` targets resolve within the document or to a file that ships with it.
- Examples parse against their own schema — an example that contradicts its schema is worse than
  none, because tooling generates from it.
- No DoFlow-internal identifiers in `description` or `summary` fields — run
  `doflow leak-scan --path <spec>`; see the skill's Review Contract.

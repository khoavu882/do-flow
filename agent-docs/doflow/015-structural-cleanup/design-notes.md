# 015 — Structural cleanup: design notes

Three independent changes. Design only; nothing below has been executed or edited.

**Method note.** Everything marked *Read* cites `file:line` and was read directly in this working
tree. Everything marked *Concluded* is inference from those reads. I had Read/Grep/Glob/Write only —
no Bash — so **no command in this document was run**, no test was executed, and no fixture output was
regenerated. Where a claim would have needed execution to settle, it is in §4 (What I could not
determine), not asserted here.

---

## 0. Facts about the repo that constrain all three changes

| # | Fact | Source |
|---|---|---|
| F1 | `package.json` `files` is `["bin/", "src/", "core/"]` — three whole directories, **no enumerated file paths**. A directory move *inside* `src/` cannot invalidate it. | Read `package.json:35-39` |
| F2 | G7 walks the `files` trees recursively and fails on `__pycache__` and on `.bak/.pyc/...` names. | Read `test/guards/package.test.js:19-37` |
| F3 | G16 resolves a specifier as `base`, then `base + '.js'`, then `base + '/index.js'`. Requirer roots are `bin`, `src`, `test`, `bench` (minus `bench/runs/`). ALLOWLIST is currently **empty**. | Read `test/guards/module-reachability.test.js:24-36, 70-76` |
| F4 | G16 **silently drops an unresolvable specifier** (`if (resolved) reached.add(resolved)`). A require literal pointing at a file that does not exist causes no failure. | Read `test/guards/module-reachability.test.js:86-89` |
| F5 | G8 asserts every backticked path rooted at `core\|src\|bin\|test\|docs` in `core/shared/skills/**`, `core/shared/guidance/**`, `docs/**`, `README.md` **exists on disk**. | Read `test/guards/reachability.test.js:198-213`, roots at `:30-49` |
| F6 | G12 hardcodes `TRACE_FILE = <repo>/src/runtime/trace.js` and `readFileSync`s it at module load. | Read `test/guards/runtime-unification.test.js:335-336` |
| F7 | G12 asserts `trace.js` is the *only* writer under `src/`+`bin/` touching the ledger, and that it contains **exactly one** filesystem-write call. | Read `test/guards/runtime-unification.test.js:351-377` |
| F8 | G12's Python-location rule: any `.py` under `core/` whose `path.dirname` is not **exactly** `core/shared/skills/do-code-review/scripts` fails the guard. | Read `test/guards/runtime-unification.test.js:54-63` |
| F9 | G12's seam-bypass scan (`require(...src/runtime...)`) applies **only to `.md` files under `core/shared/skills/`** — it does not constrain JS. | Read `test/guards/runtime-unification.test.js:303-321` |
| F10 | G5 reads `src/adapters/` and `src/lifecycle/view.js` only. It never touches `src/runtime/`. | Read `test/guards/registry.test.js:86-87, 110` |
| F11 | G15 is entirely about `.md` files in the skill tree and the installed dispatcher path. No coupling to `src/runtime/` layout. | Read `test/guards/skill-seam.test.js:58-70, 74-87` |
| F12 | **There is not a single re-export barrel anywhere under `src/`** — `grep '\.\.\.require\(\|module\.exports = require\('` over `src/` returns nothing. The six existing `index.js` files are behaviour modules (e.g. `src/registry/index.js:48 loadRegistry`, `src/lifecycle/index.js:18+`). | Grep over `/src`; Read `src/registry/index.js:11-48`, `src/lifecycle/index.js:6-31` |
| F13 | `path.resolve(__dirname, '..', '..')` — "src/runtime is exactly two levels below the repo root" — appears **22 times across 14 of the 28 runtime modules**. Two of them carry a comment asserting the depth. | Grep `__dirname` in `src/runtime`; comment at `src/runtime/scaffold.js:835-838` and `src/runtime/verification.js:45-46` |

F13 is the single most important fact in this document. It makes `src/runtime/` a **depth-coupled
directory**: any regrouping that pushes a module one level deeper silently redefines its repo root
to `<repo>/src`.

---

## 1. Change 1 — string literals inflate cyclomatic complexity

### 1.1 What the code does now

*Read.* `calculate_cyclomatic_complexity(content)` at
`core/shared/skills/do-code-review/scripts/code_quality_checker.py:133-162`:

- `:139` calls `strip_comments(content)` first.
- `:143-156` counts twelve regexes — `\bif\b \belif\b \belse\b \bfor\b \bwhile\b \bcase\b \bcatch\b
  \bexcept\b \band\b \bor\b \|\| &&` — with `re.IGNORECASE` (`:159`).
- Base 1, one branch per match.

*Read.* `strip_comments` at `:85-107`:

- `:99` removes `/*...*/` with `DOTALL`, replacing each with **only its newlines** — so the string
  gets shorter; character offsets shift.
- `:101-107` per line: blank the whole line if `lstrip()` starts with `//`, `*`, or `#`; otherwise
  `re.sub(r"\s//.*$", "", line)` — note the **required leading whitespace**, which is why
  `"https://api.example/data"` at `assets/sample_csharp_smells.cs:47` survives today.
- `:95-96` the docstring already states the defect: *"an 'and'/'or' inside a string literal still
  counts … stripping strings correctly needs a real tokenizer."*

*Read.* The only caller of the complexity function is `find_functions` at `:287`, which already has
`language` in scope (`:189`). The only caller of `strip_comments` is `:139`. Blast radius inside the
script is therefore two call sites.

*Read.* `find_functions:273-284` slices a body from `match.end()` to the next signature match. For C
the pattern is `^`-anchored (`:220-226`) but `re.search` at `:276` is called **without
`re.MULTILINE`**, so `^` only matches offset 0 of the remainder — the "next function" is almost never
found and each C function's body is the rest of the file, truncated at 2000 chars (`:280`).

> *Concluded.* That is why every function in `expected_outputs/sample_c_smells_quality.json:128-153`
> reports `complexity: 2`: each body swallows `main`'s single `if` at `assets/sample_c_smells.c:60`.
> This is a **separate, larger defect** than the one being fixed, and fixing strings will not touch
> it. Do not fix it in this commit; note it.

### 1.2 Is a correct-enough solution possible without a tokenizer?

**Plainly: no. It cannot be made fully correct, and it should not be claimed as such.**

A single lexer that is correct for all seventeen languages in `LANGUAGE_EXTENSIONS`
(`code_quality_checker.py:26-44`) does not exist, because at least four of them require *parse*
context, not lex context, to decide where a string begins:

1. **JavaScript / TypeScript regex literals.** Whether `/` opens a regex or is division is decided by
   the *previous token's grammatical category*. `str.split(/'/)` contains a lone apostrophe that a
   lexer without that context reads as an opening string. This is the textbook
   not-solvable-by-lexing case.
2. **Ruby.** Heredocs (`<<~SQL`), `%w[]`/`%q{}`/`%i[]` literals, `?a` character literals, and `/re/`
   with the same ambiguity as JS. Ruby's own parser and lexer are mutually recursive.
3. **Shell.** `#` is a comment only at a word boundary — `${x#y}` and `a#b` are not comments.
   Heredocs (`<<EOF`), `$'...'`, and unquoted apostrophes in `echo don't` (a syntax error, but files
   in the wild contain it) all need word-splitting rules.
4. **PHP.** Code exists only inside `<?php … ?>`; everything else is literal output. Plus heredoc and
   nowdoc.

Add the merely-hard-but-doable set: C# verbatim `@"…"` (where `""` escapes and `//` is not a
comment), C# raw `"""…"""`, Rust raw strings with arbitrary hash counts `r##"…"##`, Rust **lifetimes**
(`&'a str` — a `'` that never closes), Python triple quotes and f-strings, Go raw backticks, and
template-literal interpolation in JS/TS/Kotlin/Swift/Dart where the interpolated region contains
*real code with real branches* that ought to be counted.

### 1.3 The achievable partial solution

Replace `strip_comments` with one **length-preserving, language-parameterised, single-pass scanner**.

```
strip_literals(content: str, language: str) -> str
```

Four properties, each load-bearing:

**P1 — one pass over the whole file, comments and strings together.** Not two passes. Two passes in
either order is wrong: strings-then-comments makes `// don't` open a phantom string; comments-then-
strings makes `"// not a comment"` disappear a line's code.

**P2 — preserve *character offsets*, not just newline count.** Every removed character becomes a
space; every `\n` is kept. The current `strip_comments` only preserves newlines (`:99`), which is
enough for line numbers but not for slicing. Offset preservation buys something specific: `find_functions`
can keep matching signatures against the **raw** text (so `location: "offset 117"` in
`expected_outputs/sample_c_smells_quality.json:70` is unchanged) while slicing the **identical byte
range** out of the stripped text for the complexity call. Which leads to:

**P3 — strip once per file, never per fragment.** A function body slice begins at `match.end()`, an
arbitrary offset. A scanner started there begins in an *unknown* state and can be wrong from its first
character. So `analyze_file` strips once, `find_functions` takes both strings, and
`calculate_cyclomatic_complexity` receives an already-stripped slice. Its signature becomes
`calculate_cyclomatic_complexity(content: str, already_stripped: bool = False)` or, simpler, the strip
call at `:139` is deleted and the contract moves to the caller. Prefer deleting `:139` and documenting
the precondition — a boolean flag that silently changes what a function does is worse.

**P4 — bounded failure. This is the safety property, and it matters more than accuracy.**
A single-quote scanner that meets a Rust lifetime or a shell apostrophe and keeps scanning will blank
the **remainder of the file**. A 40-branch function then reports complexity 1: a *false clean*, which
is strictly worse than today's *false alarm*. Rule: a string opened with `'` or `"` that does not
close on the same physical line is **retroactively treated as not a string** — the line is emitted
unstripped. Only the explicitly multi-line forms may cross a newline: `/* */`, Python `'''`/`"""`,
JS/TS backticks, Go backticks, C# `@"`, Rust `r#"`. Every one of those is opened by a two-or-three
character token, not by a bare quote, so the catastrophic case is closed by construction.

Accept a **known undercount** for interpolation: treat `${…}` / `\(…)` content as string, not code.
That loses a branch when someone writes `` `${a || b}` ``. Undercounting a branch is the same direction
of error as P4 and is recoverable; a phantom string is not.

What it will **still** get wrong, and this list belongs in the docstring, not in a commit message:

| Still wrong | Effect |
|---|---|
| JS/TS regex literal containing a quote or `//` | mis-stripped region; over- or under-count |
| Ruby heredoc, `%w[]`, `%q{}`, `?a` | body counted as code (over-count) or as string (under-count) |
| Shell heredoc; `#` inside `${x#y}` | `${x#y}` truncates the rest of the line (under-count) |
| PHP text outside `<?php … ?>` | counted as code (over-count) |
| Code inside `${…}` / `\(…)` interpolation | branches dropped (under-count, by design) |
| Rust lifetimes `'a` | mitigated by P4 + a `'\w+` -not-followed-by-`'` heuristic; not eliminated |
| C preprocessor `#if/#else/#elif` | **behaviour change** — today `strip_comments:103` blanks every `#`-leading line, so `#if` is free; a correct scanner must keep it as C code and it will start counting. Decide explicitly and record the decision. |

### 1.4 Fixture drift

*Read.* Eleven pairs exist under `expected_outputs/`. `test/code-review-fixtures.sh:38-49` iterates
`assets/sample_*`, requires a matching `expected_outputs/<base>_quality.json`, and routes `*.md` to
`doc_quality_checker.py` and everything else to `code_quality_checker.py`.

Fixtures that **structurally cannot** drift — 4:

- `sample_markdown_clean_quality.json`, `sample_markdown_smells_quality.json` — different script
  (`code-review-fixtures.sh:46-48`).
- `sample_yaml_smells_quality.json`, `sample_json_clean_quality.json` — declarative languages, no
  complexity term (`code_quality_checker.py:49`, `:961-966`, `:1211-1215`).

Fixtures **exposed** to drift — 7: `sample_c_clean`, `sample_c_smells`, `sample_csharp_clean`,
`sample_csharp_smells`, `sample_java_clean`, `sample_java_smells`, `sample_shell_smells`.

The fields that would move, in each of those: `metrics.avg_complexity`,
`function_details[].complexity`, `quality_score`, `grade`, and any `smells[]` entry of
`"type": "high_complexity"` (emitted at `code_quality_checker.py:427-434`). Nothing else — no
`location`, no `offset`, no `lines`, because P2 keeps offsets and P3 keeps the raw text as the match
surface.

**My prediction: none of the seven actually drift.** I read every code asset and found no counted
keyword inside any string literal:

- `sample_java_smells.java:21` `"jdbc:postgresql://prod/app?user=app&password=hunter2"` — one `&`, not `&&`; no word-boundary `or`/`and`.
- `sample_java_smells.java:35`, `sample_csharp_smells.cs:74`, `sample_java_clean.java:36`, `sample_csharp_clean.cs:89` — the `SELECT … WHERE id =` strings; no counted token.
- `sample_csharp_smells.cs:22` `"Server=prod;Database=app;Password=hunter2;"`; `:47` `"https://api.example/data"`; `:69` `"Style"`,`"IDE0060"` — none.
- `sample_csharp_clean.cs:37,47,61,66,72` — none.
- `sample_c_smells.c:25,29,36,45,49` (`"world"`, `"%s says hello"`, `"%s"`, `"leak"`, `"done\n"`) and `sample_c_clean.c:27,31,34,38,50,54,60` — none.
- `sample_shell_smells.sh` — Read in full; contains no string literal at all.
- The `#`-leading lines in the C/C# assets (`sample_c_smells.c:9-11`, `sample_csharp_smells.cs:67`) carry no branch keyword, so the §1.3 preprocessor behaviour change is also invisible here.

**Zero drift is itself the finding, and it must be reported as one.** It does not mean the change is
safe; it means *the committed fixture set does not exercise the defect being fixed*, so the change
would ship with no regression evidence at all. So the change is incomplete without new fixtures.

### 1.5 New fixtures — and a hard constraint on them

The loop at `code-review-fixtures.sh:38` picks up new `assets/sample_*` files automatically, and
`reachability.test.js:291` / `consumers.test.js:49` both exclude `assets/` and `expected_outputs/`
from their scans, so adding assets costs nothing elsewhere.

**Constraint (F8): a `.py` asset cannot be added.** `assets/sample_python_strings.py` would be a
`.py` file under `core/` whose directory is not the exempt scripts directory, and
`runtime-unification.test.js:56-63` would fail. So **the Python triple-quote path cannot be covered by
a fixture** in this repo's current guard set. Options: (a) cover triple-quotes by a `.rb`/`.cs`
analogue instead and state the Python gap honestly; (b) widen `PY_EXEMPT_DIR` to a set including
`assets/` — which weakens a guard whose comment (`:51-53`) explicitly says the exemption is a
*location*. **Choose (a).** Do not widen the exemption.

Proposed additions — three assets and three expected outputs:

- `assets/sample_csharp_strings.cs` — verbatim `@"C:\if\or\and"`, an interpolated `$"{x || y}"`, a
  `"//not a comment"`, an escaped `\"`.
- `assets/sample_shell_strings.sh` — `'don'\''t'`, `${VAR#prefix}`, a `"case or if"` string, a
  heredoc (documented as a known-wrong case, with the expected output recording whatever the scanner
  actually produces).
- `assets/sample_c_strings.c` — `'\0'`, `"if or and while"`, `/* comment with an apostrophe */`.

Each with a committed `expected_outputs/<base>_quality.json`. Generating them requires running the
script (`code-review-fixtures.sh:122`); I could not do that here.

### 1.6 File-by-file edit list — Change 1

| File | Edit |
|---|---|
| `core/shared/skills/do-code-review/scripts/code_quality_checker.py:85-107` | replace `strip_comments` with `strip_literals(content, language)` per §1.3 (P1–P4); keep the name-and-reason comment style of the surrounding file |
| same, `:133-139` | `calculate_cyclomatic_complexity` — drop the internal `strip_comments` call; document that it receives stripped text; update the docstring's now-false "still counts" note |
| same, `:189-296` | `find_functions` — strip once at entry, match signatures on raw, slice complexity input from the offset-identical stripped text |
| same, `:1035+` | `analyze_file` — if the strip is hoisted to file level, pass both texts down (decide at implementation time; either placement is consistent with §1.3 as long as the strip happens once) |
| same, `:110-130` | `trim_trailing_comment_block` — unchanged; it operates on raw text and still should |
| `core/shared/skills/do-code-review/assets/sample_{csharp,shell,c}_strings.*` | **new**, §1.5 |
| `core/shared/skills/do-code-review/expected_outputs/sample_{csharp,shell,c}_strings_quality.json` | **new**, generated |
| the 7 exposed `expected_outputs/*.json` | regenerate **only if** the run actually differs; if the run confirms §1.4, this row is empty and the PR says so |

### 1.7 Guard interactions — Change 1

- **G12 (F8)** — the binding constraint. No `.py` outside `.../do-code-review/scripts/`.
- **G7 (F2)** — running `python3` under `core/` can leave `__pycache__`, which G7 reports as shipping
  in the tarball (`package.test.js:26`). The prompt says G7 recently caught exactly this. **Check for
  and delete `__pycache__` before committing.**
- **G8, G3** — unaffected; both already exclude the fixture directories.
- `npm test` — unaffected. This change touches no `.js`. Verification is
  `bash test/code-review-fixtures.sh`, which is **not** part of `npm test`
  (`code-review-fixtures.sh:8-9`).

---

## 2. Change 2 — regroup `scaffold-*` and `trace-*`

### 2.1 Complete require-edge map

**Inbound — every static `require` literal that resolves to one of the seven.** This is the whole
set; grepped across `bin/`, `src/`, `test/`, `core/`, and `bench/` (excluding `bench/runs/`, which
G16 excludes at `module-reachability.test.js:27-29`).

| Requirer | Line | Specifier | Target |
|---|---|---|---|
| `bin/doflow.js` | 41 | `'../src/runtime/trace'` | `trace.js` |
| `bin/doflow.js` | 56 | `'../src/runtime/scaffold'` | `scaffold.js` |
| `test/guards/runtime-unification.test.js` | 337 | `'../../src/runtime/trace'` | `trace.js` |
| `test/guards/scaffold.test.js` | 35 | `'../../src/runtime/scaffold'` | `scaffold.js` |
| `src/runtime/trace.js` | 13 | `'./trace-views'` | `trace-views.js` |
| `src/runtime/trace.js` | 21 | `'./trace-render'` | `trace-render.js` |
| `src/runtime/scaffold.js` | 61 | `'./scaffold-artifacts'` | `scaffold-artifacts.js` |
| `src/runtime/scaffold.js` | 72 | `'./scaffold-languages'` | `scaffold-languages.js` |
| `src/runtime/scaffold.js` | 79 | `'./scaffold-fingerprint'` | `scaffold-fingerprint.js` |

Non-`require` inbound reference: `test/guards/runtime-unification.test.js:335`
`path.join(REPO, 'src', 'runtime', 'trace.js')` — a `readFileSync` at module load (F6).

Every one of `trace-views.js`, `trace-render.js`, `scaffold-artifacts.js`, `scaffold-languages.js`,
`scaffold-fingerprint.js` has **exactly one** requirer, its own group leader. *Concluded:* the two
groups are already closed subgraphs with a single entry point each. That is what makes the move
tractable.

**Outbound — everything the seven require that lives outside the group.**

| Source | Line | Specifier | Kind |
|---|---|---|---|
| `scaffold.js` | 57-59 | `node:fs`, `node:path`, `node:child_process` | builtin — unaffected |
| `scaffold.js` | 60 | `'./cli-result'` | **crosses the new boundary** |
| `scaffold.js` | 839 | `path.resolve(__dirname,'..','..')` | **depth-coupled (F13)** |
| `scaffold-languages.js` | 11 | `'./command-detect'` | **crosses the new boundary** |
| `scaffold-artifacts.js` | — | none | |
| `scaffold-fingerprint.js` | — | none relative | |
| `trace.js` | 3-5 | `node:fs`, `node:os`, `node:path` | builtin |
| `trace.js` | 551 | `require('./health')` — **lazy, inside a function body** | **crosses the new boundary; see §2.5** |
| `trace-views.js` | — | none | |
| `trace-render.js` | — | none | |

Prose (non-executable) references that go stale: `scaffold.js:48-51, 104, 134-135, 756`;
`scaffold-languages.js:15`; `trace.js:428-429`; `trace-render.js:6`; `retrieval-plan.js:67`;
`runtime-unification.test.js:301, 453`; and — **guard-enforced** —
`core/shared/skills/do-execute-plan/references/scaffold.md:59` and `:394`, both of which backtick
`src/runtime/scaffold.js` and are therefore covered by F5.

### 2.2 Barrel or not — the G16 argument

State the mechanism precisely, because the two shapes are not equally bad:

- **A pure re-export barrel** — `module.exports = { ...require('./views'), ...require('./render') }`
  — *does* weaken G16. G16 counts a module reached if any file under `bin|src|test|bench` names it in
  a static require literal (`module-reachability.test.js:84-90`), and a barrel is such a file. After
  the barrel, `views.js` is permanently reached whether or not anything uses it. G16's own header
  (`:5-9`) says the guard exists because four modules accumulated with no requirer; a barrel
  reintroduces exactly that hole, one directory at a time. **Prohibited.**
- **An `index.js` that is the real entry module** (i.e. today's `trace.js` body renamed) is *not* a
  weakening: its requires are uses, and the situation is structurally identical to today, where
  `trace-views.js` is reached only through `trace.js:13`.

So the honest statement is: the barrel is the forbidden shape, not the filename. But G16 cannot tell
the two apart — it sees a require literal either way — so nothing in the suite would fail on the day
someone converts a real `index.js` into a barrel to "tidy up the imports".

**Recommendation: no `index.js` in either new directory.** Callers name the file. Two reasons:

1. It removes the ambiguity rather than relying on intent. With explicit filenames, adding a barrel
   later is a visible new file plus an edit to every call-site, not a silent one-line rewrite of an
   existing file.
2. It matches what this repo already does. F12: `src/` contains **zero** barrels, and `src/helper/`
   — a six-module utility directory — has no `index.js` at all; its callers name files
   (`bin/doflow.js:12-14`). Introducing the first barrel-shaped file in the tree as part of a
   *move* commit is the wrong place to make that decision.

Cost of the recommendation: three public specifiers change instead of zero (`bin/doflow.js:41,56`,
two guard files). That is four lines. Accept it.

### 2.3 Target layout

```
src/runtime/scaffold/
  generate.js      ← scaffold.js              (981 lines, 46K)
  artifacts.js     ← scaffold-artifacts.js    (215 lines, 8.6K)
  languages.js     ← scaffold-languages.js    (243 lines, 9.2K)
  fingerprint.js   ← scaffold-fingerprint.js  (54 lines, 2.0K)

src/runtime/trace/
  ledger.js        ← trace.js                 (610 lines, 24.8K)
  views.js         ← trace-views.js           (457 lines, 22.0K)
  render.js        ← trace-render.js          (2.6K)
```

Naming note on `trace/ledger.js`: `trace.js` holds `TaskRunTelemetry` (`:66`), `RunLedger` (`:326`),
the sanitizer (`:264`) and three thin `handle*Command` functions (`:441, 489, 542`). `ledger.js` names
the thing two G12 assertions actually pin (F7). `commands.js` would name the thinnest part. Either is
defensible; pick one and make G12's `TRACE_FILE` agree.

**This change is a move, not a split.** `scaffold.js` at 981 lines and `trace.js` at 610 are both
splittable — `trace.js` has a clean three-way seam at `:66 / :148 / :441` — but splitting inside a
move commit makes the diff unreviewable and would force the G12 ledger assertions to be re-reasoned
at the same time as the paths change. Split later, separately, if at all.

### 2.4 File-by-file edit list — Change 2

**Moves (7)** — use `git mv` so blame survives; a delete+add makes the review of the depth fixes in
§2.5 impossible.

**Specifier edits (13):**

| File | Line | Old | New |
|---|---|---|---|
| `bin/doflow.js` | 41 | `'../src/runtime/trace'` | `'../src/runtime/trace/ledger'` |
| `bin/doflow.js` | 56 | `'../src/runtime/scaffold'` | `'../src/runtime/scaffold/generate'` |
| `test/guards/runtime-unification.test.js` | 335 | `path.join(REPO,'src','runtime','trace.js')` | `path.join(REPO,'src','runtime','trace','ledger.js')` |
| `test/guards/runtime-unification.test.js` | 337 | `'../../src/runtime/trace'` | `'../../src/runtime/trace/ledger'` |
| `test/guards/scaffold.test.js` | 35 | `'../../src/runtime/scaffold'` | `'../../src/runtime/scaffold/generate'` |
| `src/runtime/trace/ledger.js` | 13 | `'./trace-views'` | `'./views'` |
| `src/runtime/trace/ledger.js` | 21 | `'./trace-render'` | `'./render'` |
| `src/runtime/trace/ledger.js` | 551 | `require('./health')` | `require('../health')` |
| `src/runtime/scaffold/generate.js` | 60 | `'./cli-result'` | `'../cli-result'` |
| `src/runtime/scaffold/generate.js` | 61 | `'./scaffold-artifacts'` | `'./artifacts'` |
| `src/runtime/scaffold/generate.js` | 72 | `'./scaffold-languages'` | `'./languages'` |
| `src/runtime/scaffold/generate.js` | 79 | `'./scaffold-fingerprint'` | `'./fingerprint'` |
| `src/runtime/scaffold/languages.js` | 11 | `'./command-detect'` | `'../command-detect'` |

**Depth edit (1, and it is the dangerous one):**

| File | Line | Old | New |
|---|---|---|---|
| `src/runtime/scaffold/generate.js` | 839 | `path.resolve(__dirname, '..', '..')` | `path.resolve(__dirname, '..', '..', '..')` |

plus the comment at `:835-838`, which explicitly documents the two-level assumption and would
otherwise become a false statement sitting directly above the corrected line. *Read:* `trace.js` has
no `__dirname` use, so `trace/` needs no depth edit.

**Guard-required doc edits (2):** `core/shared/skills/do-execute-plan/references/scaffold.md:59` and
`:394` — `src/runtime/scaffold.js` → `src/runtime/scaffold/generate.js`. Without these, G8 fails
(F5).

**Stale-prose edits (7, not guard-enforced but wrong if left):** `scaffold/generate.js:48-51, 104,
134-135, 756`; `scaffold/languages.js:15`; `trace/ledger.js:428-429`; `trace/render.js:6`;
`src/runtime/retrieval-plan.js:67`; `test/guards/runtime-unification.test.js:301, 453`.

### 2.5 What breaks if this is done naively — ranked by how quiet the failure is

1. **`trace.js:551 require('./health')` — silent, and `npm test` stays green.** It is a *lazy* require
   inside `handleDiscoverCommand`, taken only when the caller did **not** pass `providerHealth`. Left
   unedited it resolves to `src/runtime/trace/health.js`, which does not exist. G16 will not catch it
   (F4: unresolvable specifiers are dropped, and `src/runtime/health.js` stays reached via
   `bin/doflow.js:40`, so no orphan is reported). G12's discover tests all inject
   `{ providerHealth: HEALTHY_PROVIDERS }` (`runtime-unification.test.js:509, 535`), so they take the
   branch that skips the require. **The full test suite passes and `doflow discover` throws
   MODULE_NOT_FOUND in a user's terminal.** This is the headline risk of the whole change.
2. **`scaffold.js:839 REPO_ROOT` — silent, and `npm test` stays green.** Unfixed, `REPO_ROOT` becomes
   `<repo>/src`, so `PATHS_HELPER` (`:843`) points at
   `<repo>/src/core/shared/scripts/doflow/bash/do-paths.sh`. `test/guards/scaffold.test.js:33-35`
   imports `generateScaffold` and constants — **not** `handleScaffoldCommand`, which is the function
   that consumes `PATHS_HELPER` via `resolveActiveFeature` (`:859`). So this too survives the suite.
3. **A barrel added to avoid the four specifier edits** — silent, permanent, and re-opens G16's
   original hole (§2.2).
4. **G8 doc-path failure** (`scaffold.md:59, 394`) — loud, immediate, well-named. Fine.
5. **G12 `TRACE_FILE` ENOENT at module load** (F6) — loud, immediate. Fine.
6. **G12 "only one writer" inverting** — if `TRACE_FILE` is *not* updated but the file moves,
   `runtimeJsFiles()` (which walks recursively, `:38-45, 341`) finds the new ledger module, does not
   exclude it, and reports it as a second writer. Loud, slightly confusing message. Acceptable.

**Mitigation, and it is worth its own commit-sized change:** items 1 and 2 both exist because *no
guard checks that a relative require literal resolves*. Add a third assertion to
`test/guards/module-reachability.test.js`, reusing the two functions already there
(`requireSpecifiers`, `resolveSpecifier`):

> G16: every relative `require('...')` literal under `bin/`, `src/`, `test/` resolves to a file.

That is roughly six lines, adds no dependency, executes nothing, and *strengthens* G16 rather than
weakening it — it closes exactly the gap at `module-reachability.test.js:87-88`. It catches item 1 at
commit time. It does not catch item 2 (a `__dirname` arithmetic bug is not a require), for which the
only real defence is reading each of the 22 sites in F13 — one, here.

### 2.6 Blast radius — Change 2

- Tests: 2 guard files edited (`runtime-unification`, `scaffold`); no test logic changes, only paths.
  No behavioural assertion changes. No new or deleted tests, except the optional §2.5 addition.
- Fixtures: none. Change 2 touches no Python and no `expected_outputs/`.
- Packaging: none (F1).
- `test/e2e/install-shapes.test.js:201` does `fs.cpSync(<repo>/src, …, {recursive:true})` — a
  subdirectory is copied identically.
- G16 after the move: `scaffold/{artifacts,languages,fingerprint}.js` reached from
  `scaffold/generate.js`; `trace/{views,render}.js` reached from `trace/ledger.js`; the two leaders
  reached from `bin/doflow.js`. No ALLOWLIST entry needed — it stays empty (F3).

---

## 3. Change 3 — `src/runtime/helper/`

### 3.1 Complete inventory of `src/runtime/` — 28 modules

Line counts are the `module.exports` line, read from each file, so they are a lower bound on file
length by 1–3 lines. "Requirers" excludes `bench/runs/`.

**Seam — owns a `handle*Command` that `bin/doflow.js` dispatches (16):**

| Module | ~lines | Command / entry | Requirers |
|---|---|---|---|
| `cli.js` | 594 | capabilities, readiness, evidence | bin:37; retrieval-plan:47; outcome:55 |
| `health.js` | 629 | doctor | bin:40; retrieval-plan:43; trace:551 (lazy) |
| `trace.js` | 610 | trace, stats, discover | bin:41; G12:337 |
| `readiness.js` | 295 | `ReadinessEngine` | bin:45; cli:11; outcome:46 |
| `claims.js` | 432 | claim | bin:46; cli:10; context-pack:4 |
| `task-classifier.js` | 466 | classify | bin:47 |
| `workflow-engine.js` | 563 | workflow | bin:48; task-classifier:4; outcome:48 |
| `capability-router.js` | 405 | route | bin:49; cli:7; health:22; readiness:5; workflow-engine:5; verification-registry:15 |
| `context-pack.js` | 227 | context-pack | bin:50 |
| `retrieval-plan.js` | 537 | retrieval-plan | bin:51; outcome:51 |
| `outcome.js` | 452 | outcome | bin:52 |
| `verification.js` | 955 | verify | bin:53; outcome:47 |
| `leak-scan.js` | 165 | leak-scan | bin:54 |
| `recovery.js` | 278 | recover | bin:55; verification:26 |
| `scaffold.js` | 981 | scaffold | bin:56 |
| `cli-result.js` | 34 | `finishRuntime`, `usageError` | bin:57 + 11 runtime modules |

**Engine / collaborator — no command, required by a sibling (10):**

`evidence-ledger.js` (226; from cli, claims, context-pack, retrieval-plan, outcome) ·
`command-detect.js` (457; from verification:25, scaffold-languages:11, health:357 lazy) ·
`locator-resolve.js` (146; from cli:9, readiness:6) ·
`verification-contract-runner.js` (228; verification only) ·
`verification-registry.js` (127; verification only) ·
`trace-views.js` (457) · `trace-render.js` (74) · `scaffold-artifacts.js` (215) ·
`scaffold-languages.js` (243) · `scaffold-fingerprint.js` (54) — the last five each with exactly one
requirer, their group leader.

**Neither (2) — and this is a finding:**

- `worktree.js` (335) — requirers are `bench/runner.js:32` and `test/guards/evals.test.js:18`. **No
  `src/` or `bin/` module requires it.** It is bench-harness support living in the runtime tree.
- `freshness.js` (136) — the only requirer anywhere is
  `test/runtime/runtime-readiness.test.js:8`. *Read:* `grep -i freshness src/runtime/readiness.js`
  returns **no matches** — `ReadinessEngine` does not consume `FreshnessValidator`, not even by
  injection. *Concluded:* `FreshnessValidator` has no production consumer and is kept alive in G16
  solely by its own unit test, because `test` is a requirer root (`module-reachability.test.js:24`).

### 3.2 Recommendation: **No. Do not create `src/runtime/helper/`.**

Five pieces of evidence, in order of weight.

**E1 — Exactly one of the 28 modules is a helper.** By any definition that excludes domain
knowledge, the only qualifying module is `cli-result.js`: 34 lines, two functions, and
`docs/architecture.md:47` already records that it *"deliberately depends on nothing else in the
tree"*. A directory holding one 34-line file is not a grouping. Every other plausible candidate is
domain-bound and says so in its own header: `trace-render.js:6` — *"Pure formatting over the view
models `trace-views.js` builds"*; `scaffold-fingerprint.js` owns the scaffold's tamper marker;
`locator-resolve.js` (146 lines) implements the locator's resolution contract;
`command-detect.js` is a 457-line engine. Moving any of those into `helper/` would be relabelling a
domain module as generic, which is the junk drawer forming.

**E2 — The name is already taken, with a contradictory definition.** `src/helper/` exists
(`git.js`, `marker-merge.js`, `prompt.js`, `settings-merge.js`, `settings-scope.js`, `toml.js`) and
`docs/architecture.md:50` defines it as *"cross-layer utilities with no harness-, install-, or
**runtime**-specific domain"*. `src/runtime/helper/` would be, by construction, the set that
directory is defined to exclude. Two directories named `helper/` with complementary definitions is
not a mild naming smell — it is a per-file judgement call imposed on every future contributor, and
the predictable resolution is "whichever is closer", which is how junk drawers fill. **Yes, this is
the junk-drawer risk, and it is present here specifically because of the name.**

**E3 — `src/runtime/` is depth-coupled (F13).** 22 occurrences of
`path.resolve(__dirname, '..', '..')` across 14 modules — `verification-registry.js:70`,
`scaffold.js:839`, `cli.js:22,110`, `retrieval-plan.js:493`, `readiness.js:28`, `verification.js:48`,
`task-classifier.js:7`, `freshness.js:14`, `workflow-engine.js:8,77`, `claims.js:45`,
`outcome.js:436`, `health.js:324,431`, `capability-router.js:10,33`, `evidence-ledger.js:45`. Every
module moved one level deeper needs its arithmetic corrected, and §2.5 item 2 shows the failure is
invisible to the test suite. This is a real, quantified cost that any grouping must pay and that a
one-file `helper/` buys nothing for. (`cli-result.js` itself has no `__dirname`, so the *specific*
move is safe — but a grouping justified only by its safest member is not justified.)

**E4 — The cost is 12 edits for zero measured benefit.** Moving `cli-result.js` to
`helper/cli-result.js` changes: `bin/doflow.js:57`, `context-pack.js:5`, `scaffold.js:60`,
`retrieval-plan.js:48`, `verification.js:27`, `recovery.js:21`, `task-classifier.js:5`,
`leak-scan.js:5`, `workflow-engine.js:6`, `claims.js:7`, `capability-router.js:6`, `outcome.js:56`.
Twelve specifiers, and `docs/architecture.md:47` names the old path.

**E5 — Flat is currently doing real work.** With 28 files and no subdirectories, "does `X` exist in
the runtime?" is one `ls`, and `path.resolve(__dirname,'..','..')` is uniformly correct. The naming
convention already encodes grouping without directories: `trace-*`, `scaffold-*`,
`verification-*`. Change 2 replaces two of those prefix-groups with directories because each is a
closed subgraph with one entry point (§2.1). No such subgraph exists around "helpers" — `cli-result`
has 12 requirers spanning the whole tree, which is the opposite shape.

### 3.3 What to do instead

The structural problems in `src/runtime/` are real, but none of them is "helpers are mixed with
engines". In priority order:

1. **Decide `freshness.js` (§3.1).** No production consumer; alive in G16 only via its own test.
   Either wire it into `ReadinessEngine` or delete it and its test. This is the exact defect class
   G16 was created for (`module-reachability.test.js:5-9`) and the case its requirer-root choice lets
   through. **Worth its own small commit; do not fold it into a move.**
2. **Consider whether `worktree.js` belongs in `src/runtime/` at all** — its only requirers are
   `bench/runner.js:32` and `test/guards/evals.test.js:18`. It is bench infrastructure. Moving it is
   a two-specifier change, but `bench/runner.js:402` also embeds the path inside the string constant
   `WT_REQUIRE`, which no guard checks and no `require`-scan sees. Note the hazard; decide separately.
3. **Consider one `src/runtime/repo-root.js`** exporting the single computation that F13's 22 sites
   duplicate. It removes the depth coupling that makes every future reorganisation of this directory
   risky — including the one in Change 2. But it touches 14 modules and is a behaviour-preserving
   refactor of its own; it must not ride along with a move.

---

## 4. Sequencing

**Order: Change 1 → Change 2 → Change 3.** Three commits, and Change 3 is a decision, not a commit.

**Change 1 first, and it is independent.** It touches only
`core/shared/skills/do-code-review/scripts/` and `assets/`/`expected_outputs/`; Change 2 touches only
`src/`, `bin/`, `test/guards/`, and one skill reference file. Disjoint file sets, no shared guard
except G12 — and they hit *different* assertions of it (Change 1: the Python-location rule at `:56`;
Change 2: the trace/ledger rules at `:335-377`). It is first because it is the one with a real
correctness question and an unverified-until-run outcome (§1.4), and it should not be queued behind a
refactor.

**Change 2 second.** If the §2.5 guard addition is adopted, land it as the *first hunk* of the Change
2 commit, or as a separate commit immediately before — either way, before the moves, so the resolver
check is already green on the old layout and any failure it reports afterwards is unambiguously
caused by the move.

**Change 3 is a "no" and produces no code.** If items §3.3(1)–(3) are taken up, they are separate
commits and **must not** be merged into Change 2. Specifically: do not fold the `repo-root.js`
refactor into the scaffold/trace move. Change 2's riskiest line is
`scaffold/generate.js:839` (§2.5 item 2); doing the depth fix inline makes it one reviewable line, and
doing it as part of a 14-module refactor buries it.

**Do the changes interact?** Only once, and weakly: `scaffold-languages.js:15` (moving in Change 2)
contains the prose `files: src/runtime/scaffold.js`, and `scaffold.js:48-51, 134-135` name sibling
modules by filename. Neither is guard-enforced and neither touches Change 1. There is **no** shared
file between the three changes.

---

## 5. What I could not determine

Read-only, no Bash. The following are open, and none of them is guessed at above.

1. **Whether the seven exposed fixtures actually drift (§1.4).** I read every asset and found no
   counted keyword in any string literal, and I state that as a prediction. It is not a run. Settle
   it with `bash test/code-review-fixtures.sh` before and after.
2. **The exact current numbers** in the seven exposed `expected_outputs/*.json`. I read
   `sample_c_smells_quality.json` in full and used it to derive the `find_functions` slicing
   behaviour (§1.1); I did not read the other six.
3. **`npm test` currently reporting 673 passing.** Taken from the task statement; not run. Note
   `CLAUDE.md` says 598 across 60 files, so one of the two numbers is stale — I did not resolve which.
4. **Whether the §2.5 "every relative require resolves" assertion passes on the tree as it stands
   today.** If any existing specifier is already unresolvable, that guard would fail on introduction.
   I did not check all of `src/`, `bin/`, `test/` for this.
5. **Whether `bench/runner.js:402`'s `WT_REQUIRE` string is the only path-in-a-string reference to a
   `src/runtime/` module.** I found that one; I did not do an exhaustive scan for module paths
   embedded in string literals rather than `require()` calls, and no guard covers that shape.
6. **The correct decision on C preprocessor `#if/#else/#elif` (§1.3).** Today they are blanked as
   comments (`code_quality_checker.py:103`); a correct scanner counts them. Which is *wanted* is a
   product question about what "cyclomatic complexity of a C function" should mean here. It affects no
   committed fixture, so it is a free choice — but it must be a stated one.
7. **Line counts** in §3.1 are `module.exports` line numbers, not `wc -l`. They understate each file
   by the length of its export block.
8. **Whether `docs/architecture.md` needs edits for Change 2.** `:43`, `:47` and `:140` backtick
   `src/runtime/` (still exists after the move) and `task-classifier.js` (a bare filename, which G8's
   pattern at `reachability.test.js:206` does not match since it is not rooted at a top-level
   directory). *Concluded:* no G8 failure. Not verified by running G8.

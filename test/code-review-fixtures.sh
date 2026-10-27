#!/usr/bin/env bash
# code-review-fixtures.sh — regression guard for do-code-review's bundled analyzer.
#
# Each assets/sample_* file has a committed --json output under expected_outputs/. A difference
# means code_quality_checker.py's behaviour changed; if that was intentional, regenerate the
# fixture, otherwise it is a regression.
#
# Invoked by path, like verify-hooks.sh and doflow-chain-test.sh — `npm test` is `node --test`
# and only discovers test/*.test.js, so this is not part of it.
#
# Skips cleanly when python3 is unavailable: this repo has zero runtime dependencies and does not
# require Python, so a missing interpreter is not a failure. It exits 0 with a SKIP notice rather
# than blocking anyone who does not have it.
#
# Exit: 0 = all fixtures match (or skipped), 1 = at least one drifted.

set -uo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)/core/shared/skills/do-code-review"

if ! command -v python3 >/dev/null 2>&1; then
  echo "SKIP: python3 not available — analyzer fixtures not checked"
  exit 0
fi
if [ ! -d "$SKILL_DIR/assets" ]; then
  echo "SKIP: $SKILL_DIR/assets not found — nothing to check"
  exit 0
fi

# The analyzer emits paths relative to the working directory, so the comparison only holds when
# run from the skill's own directory — that is what the committed fixtures record.
cd "$SKILL_DIR" || { echo "SKIP: cannot enter $SKILL_DIR"; exit 0; }

pass=0
fail=0
checked=0

for f in assets/sample_*; do
  [ -f "$f" ] || continue
  base="$(basename "${f%.*}")"
  expected="expected_outputs/${base}_quality.json"
  [ -f "$expected" ] || continue          # a sample without a committed fixture is not a failure
  checked=$((checked + 1))
  # Markdown fixtures are content-quality (doc_quality_checker.py), not code-smell
  # (code_quality_checker.py) -- same --json shape, different script, selected by extension.
  case "$f" in
    *.md) checker="scripts/doc_quality_checker.py" ;;
    *) checker="scripts/code_quality_checker.py" ;;
  esac
  if python3 "$checker" "$f" --json 2>/dev/null | diff -q - "$expected" >/dev/null 2>&1; then
    printf '  \033[32m✓\033[0m %s\n' "$(basename "$f")"
    pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %s — output differs from %s\n' "$(basename "$f")" "$expected"
    python3 "$checker" "$f" --json 2>/dev/null | diff - "$expected" | head -20 | sed 's/^/      /'
    fail=$((fail + 1))
  fi
done

# ── Agent-spec boundary classification ───────────────────────────────────────────────────────
# Keep both the legacy tools+model shape and the current effort+model shape eligible for
# Boundaries checks. The current shared shape may omit tools so the host supplies its tool pool.
if python3 - "$PWD" <<'PY'
import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True
skill_dir = Path(sys.argv[1])
checker_path = skill_dir / "scripts" / "doc_quality_checker.py"
spec = importlib.util.spec_from_file_location("doc_quality_checker", checker_path)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

cases = {
    "legacy tools+model agent": [
        "---", "name: reviewer", "description: Review code", "tools: Read, Grep",
        "model: sonnet", "---", "# Reviewer",
    ],
    "current effort+model agent without tools": [
        "---", "name: reviewer", "description: Review code", "model: inherit",
        "effort: medium", "---", "# Reviewer",
    ],
}
for name, lines in cases.items():
    path = Path("agents") / "reviewer.md"
    assert checker.is_agent_spec(path, lines), f"not recognized: {name}"
    findings = checker.check_boundaries(path, lines)
    assert any(f["rule"] == "missing_boundaries" for f in findings), name

skill_lines = ["---", "name: review", "model: sonnet", "effort: medium",
               "argument-hint: [path]", "---", "# Review"]
assert not checker.is_agent_spec(Path("agents/review.md"), skill_lines), \
    "skill argument-hint shape was misclassified as an agent"
print("  \033[32m✓\033[0m legacy and current agent shapes receive Boundaries checks")
PY
then
  pass=$((pass + 1))
  checked=$((checked + 1))
else
  printf '  \033[31m✗\033[0m legacy and current agent shapes receive Boundaries checks\n'
  fail=$((fail + 1))
fi

# ── Uncited vendor claims check (Feature 124, IC-004) ───────────────────────────────────────
if python3 - "$PWD" <<'PY'
import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True
skill_dir = Path(sys.argv[1])
checker_path = skill_dir / "scripts" / "doc_quality_checker.py"
spec = importlib.util.spec_from_file_location("doc_quality_checker", checker_path)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

# 1. Uncited vendor claim triggers finding
lines_uncited = [
    "# Library notes",
    "",
    "The express framework defaults to port 3000 in development mode.",
]
findings = checker.check_uncited_vendor_claims(Path("test.md"), lines_uncited)
assert len(findings) == 1, f"expected 1 finding, got {len(findings)}"
assert findings[0]["rule"] == "uncited_vendor_claim"
assert findings[0]["severity"] == "low"
assert findings[0]["line"] == 3

# 2. Context7 citation clears finding
lines_c7 = [
    "# Library notes",
    "",
    "The express framework defaults to port 3000 per context7 docs.",
]
assert len(checker.check_uncited_vendor_claims(Path("test.md"), lines_c7)) == 0

# 3. URL citation clears finding
lines_url = [
    "# Library notes",
    "",
    "The express framework defaults to port 3000 (https://expressjs.com).",
]
assert len(checker.check_uncited_vendor_claims(Path("test.md"), lines_url)) == 0

# 4. UNVERIFIED marker clears finding
lines_unverified = [
    "# Library notes",
    "",
    "The express framework defaults to port 3000 [UNVERIFIED].",
]
assert len(checker.check_uncited_vendor_claims(Path("test.md"), lines_unverified)) == 0

# 5. Non-vendor sentence with behavior verb does not trigger
lines_normal = [
    "# Guide",
    "",
    "This workflow requires a plan file before proceeding.",
]
assert len(checker.check_uncited_vendor_claims(Path("test.md"), lines_normal)) == 0

print("  \033[32m✓\033[0m uncited vendor claim linter detects uncited claims and respects citations")
PY
then
  pass=$((pass + 1))
  checked=$((checked + 1))
else
  printf '  \033[31m✗\033[0m uncited vendor claim linter detects uncited claims and respects citations\n'
  fail=$((fail + 1))
fi

# ── Voice tells (row 132, W2 + W3): opt-in `--voice`, advisory, no score ─────────────────────
if python3 - "$PWD" <<'PY'
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
skill_dir = Path(sys.argv[1])
checker_path = skill_dir / "scripts" / "doc_quality_checker.py"
spec = importlib.util.spec_from_file_location("doc_quality_checker", checker_path)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

def voice(text):
    return checker.check_voice(Path("t.md"), text.split("\n"))

def kinds(text):
    return sorted({f["rule"] for f in voice(text)})

# 1. Clean prose gives no findings.
clean = "# Install the tool\n\nRun the installer from the project root. It writes one file.\n\nThe config lives in `doflow.json`.\n"
assert voice(clean) == [], voice(clean)

# 2. Each tell kind is caught, with path:line data and the quoted text. The curly quote is a
#    weak tell, so it sits in a paragraph that carries two strong ones.
tells = {
    "voice_overused_word": "We delve into the storage layer.",
    "voice_sales_word": "The cache boasts a seamless design.",
    "voice_chatbot_residue": "I hope this helps with the setup.",
    "voice_knowledge_limit": "As of my last update the API had two routes.",
    "voice_serves_as": "The file serves as the entry point.",
    "voice_dash_habit": "The first step — reading the file — is quick.",
    "voice_bold_density": "Use **one** and **two** and **three** together.",
    "voice_repeated_opener": "The tool reads. The tool writes. The tool exits.",
}
for rule, line in tells.items():
    found = [f for f in voice("# Notes\n\n" + line + "\n") if f["rule"] == rule]
    assert found, f"{rule} not caught in: {line}"
    assert found[0]["line"] == 3 and found[0]["file"].endswith("t.md"), found[0]
    assert '"' in found[0]["message"], found[0]
tc = [f for f in voice("# Design Risks And Alternatives Considered\n\nText.\n") if f["rule"] == "voice_title_case_heading"]
assert tc and tc[0]["line"] == 1 and "Design Risks" in tc[0]["message"], tc
assert not voice("# Design risks and alternatives\n\nText.\n")
cq = [f for f in voice("We delve into it and it serves as a “hub”.\n") if f["rule"] == "voice_curly_quote"]
assert cq, "curly quote not caught beside two other tells"

# 3. Code, quotes, YAML and link targets inside an otherwise clean file are not flagged.
exempt = "\n".join([
    "---", "title: Delve into a seamless tapestry", "---", "",
    "# Setup", "",
    "Run the tool, then read the result.", "",
    "```", "we delve into the pivotal tapestry that serves as a testament", "```", "",
    "Call `delve()` and `seamless` and `serves as` from the shell.", "",
    "> I hope this helps. As of my last update it boasts a seamless tapestry.", "",
    "See [the guide](https://example.com/delve-pivotal-tapestry-seamless) for more.", "",
])
assert voice(exempt) == [], voice(exempt)

# 4. A lone weak tell is not flagged; weak tells with two others are.
assert voice("# Notes\n\nThe key step is to read the file.\n") == []
assert voice("# Notes\n\nThe first step — reading the file is quick.\n") == []
assert voice("# Notes\n\nUse **this** carefully.\n") == []
weak = [f for f in voice("# Notes\n\nWe delve into the key step, which serves as the entry point.\n") if "key" in f["message"]]
assert weak, "weak tell with two strong tells was not reported"

# 5. No aggregate score anywhere, the default output is unchanged without --voice, and
#    --voice never changes the exit status.
assert all(set(f) == {"file", "line", "rule", "severity", "message"} for f in voice("We delve in.\n"))
with tempfile.TemporaryDirectory() as d:
    f = Path(d) / "x.md"
    f.write_text("# Notes\n\nWe delve into it. It serves as a hub.\n")
    assert not [x for x in checker.analyze_file(f) if x["rule"].startswith("voice_")]
    r = subprocess.run([sys.executable, str(checker_path), str(f), "--voice", "--json"], capture_output=True, text=True)
    out = json.loads(r.stdout)
    assert r.returncode == 0 and any(x["rule"].startswith("voice_") for x in out), r
    assert isinstance(out, list) and not any("score" in x for x in out)

print("  \033[32m✓\033[0m voice check: tells caught, exempt regions skipped, weak tells gated, no score")
PY
then
  pass=$((pass + 1))
  checked=$((checked + 1))
else
  printf '  \033[31m✗\033[0m voice check: tells caught, exempt regions skipped, weak tells gated, no score\n'
  fail=$((fail + 1))
fi

# ── Facts diff (row 132, W4 + W5): a rewrite must not add, drop or change a fact ─────────────
if python3 - "$PWD" <<'PY'
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
skill_dir = Path(sys.argv[1])
checker_path = skill_dir / "scripts" / "doc_quality_checker.py"
spec = importlib.util.spec_from_file_location("doc_quality_checker", checker_path)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

BEFORE = (
    "# Release notes\n\n"
    "Alice Chen shipped version 2.0 on 2026-03-14 after 1,200 runs (see https://example.com/notes).\n"
    "The cache hit rate reached 93% [1] and Redis stayed under 40 ms.\n"
)

def diff(before, after):
    with tempfile.TemporaryDirectory() as d:
        b, a = Path(d) / "before.md", Path(d) / "after.md"
        b.write_text(before)
        a.write_text(after)
        found = checker.facts_diff(b, a)
        r = subprocess.run([sys.executable, str(checker_path), "--facts-diff", str(b), str(a), "--json"],
                           capture_output=True, text=True)
        return found, r.returncode, json.loads(r.stdout)

# 1. Unchanged facts, reworded prose: nothing reported, exit 0.
reworded = BEFORE.replace("shipped version 2.0", "released version 2.0").replace("stayed under", "stayed below")
found, code, out = diff(BEFORE, reworded)
assert found == [] and code == 0 and out == [], (found, code)

# 2. An added number, name, date, URL and citation is an error each, and exit status is 1.
added = BEFORE + "Bob Smith confirmed 17 more runs on 2026-04-01 (https://example.org/extra) [2].\n"
found, code, out = diff(BEFORE, added)
errors = {(f["rule"]) for f in found if f["severity"] == "error"}
assert errors == {"fact_added_number", "fact_added_name", "fact_added_date", "fact_added_url",
                  "fact_added_citation"}, errors
assert not [f for f in found if f["severity"] == "warning"], found
assert code == 1 and len(out) == len(found)
assert all(f["file"].endswith("after.md") and f["line"] >= 1 for f in found)

# 3. A dropped fact is a warning and leaves the exit status at 0; a changed number is both.
dropped = BEFORE.replace(" and Redis stayed under 40 ms", "")
found, code, _ = diff(BEFORE, dropped)
assert {f["severity"] for f in found} == {"warning"} and code == 0, found
assert {f["rule"] for f in found} == {"fact_dropped_number", "fact_dropped_name"}, found
changed = BEFORE.replace("93%", "94%")
found, code, _ = diff(BEFORE, changed)
assert {(f["rule"], f["severity"]) for f in found} == {("fact_added_number", "error"), ("fact_dropped_number", "warning")}, found
assert code == 1

# 4. Sentence-initial capitals and headings are not names; the first word of a sentence is skipped.
found, code, _ = diff("# Release Notes\n\nThe tool works.\n", "# Release notes\n\nIt works. Postgres is fast.\n")
assert found == [] and code == 0, found

print("  \033[32m✓\033[0m facts diff: added fact is an error, dropped fact a warning, unchanged facts silent")
PY
then
  pass=$((pass + 1))
  checked=$((checked + 1))
else
  printf '  \033[31m✗\033[0m facts diff: added fact is an error, dropped fact a warning, unchanged facts silent\n'
  fail=$((fail + 1))
fi

# ── Facts diff regressions (row 132 review): a correct rewrite must not exit 1 ───────────────
if python3 - "$PWD" <<'PY'
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
skill_dir = Path(sys.argv[1])
checker_path = skill_dir / "scripts" / "doc_quality_checker.py"
spec = importlib.util.spec_from_file_location("doc_quality_checker", checker_path)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

def F(before, after):
    with tempfile.TemporaryDirectory() as d:
        b, a = Path(d) / "before.md", Path(d) / "after.md"
        b.write_text(before)
        a.write_text(after)
        found = checker.facts_diff(b, a)
        code = subprocess.run([sys.executable, str(checker_path), "--facts-diff", str(b), str(a)],
                              capture_output=True, text=True).returncode
        return found, code

def errors(found):
    return [f for f in found if f["severity"] == "error"]

# Equivalent dates are one fact, whatever the form; a different date is still an error.
for before, after in [("Released on March 14, 2026.", "Released on 14 March 2026."),
                      ("Released on 2026-03-14.", "Released on 14 March 2026."),
                      ("Released on Mar 14th, 2026.", "Released on 2026-03-14."),
                      ("Updated in March 2026.", "Updated in Mar 2026.")]:
    found, code = F(before, after)
    assert found == [] and code == 0, (before, after, found)
found, code = F("Released on March 14, 2026.", "Released on 15 March 2026.")
assert [f["rule"] for f in errors(found)] == ["fact_added_date"] and code == 1, found

# A sentence-initial name that moves, or a sentence opener that changes, is not an added fact.
for before, after in [("Redis stores data.", "The data lives in Redis."),
                      ("The data lives in Redis.", "Redis stores data."),
                      ("Run the tool.", "Execute the tool.")]:
    found, code = F(before, after)
    assert errors(found) == [] and code == 0, (before, after, found)
found, code = F("The cache is fast.", "The cache is fast and uses Postgres.")
assert [f["rule"] for f in errors(found)] == ["fact_added_name"] and code == 1, found

# A name wrapped over two lines keeps its identity.
found, code = F("The owner is Alice Chen.", "The owner is Alice\nChen.")
assert found == [] and code == 0, found
found, code = F("The owner is Alice\nChen.", "The owner is Alice Chen.")
assert found == [] and code == 0, found

# A finding names the line the fact is really on, whatever precedes it.
found, _ = F("", "# A much longer heading\n\nThe owner is Alice Chen.")
assert [(f["rule"], f["line"]) for f in found] == [("fact_added_name", 3)], found
found, _ = F("", "One line.\nSecond.\n\nOn 2026-01-02 it shipped.")
assert [(f["rule"], f["line"]) for f in found] == [("fact_added_date", 4)], found

print("  \033[32m✓\033[0m facts diff regressions: date forms, moved names, wrapped names, real lines")
PY
then
  pass=$((pass + 1))
  checked=$((checked + 1))
else
  printf '  \033[31m✗\033[0m facts diff regressions: date forms, moved names, wrapped names, real lines\n'
  fail=$((fail + 1))
fi

# ── Voice masking regressions (row 132 review): skipped regions must not leak ────────────────
if python3 - "$PWD" <<'PY'
import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True
skill_dir = Path(sys.argv[1])
checker_path = skill_dir / "scripts" / "doc_quality_checker.py"
spec = importlib.util.spec_from_file_location("doc_quality_checker", checker_path)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

def V(text):
    return checker.check_voice(Path("t.md"), text.split("\n"))

BT = "`"
silent = {
    "a longer or different fence is not closed by a shorter or other one": "~~~~\n~~~\ndelve\n~~~\n~~~~",
    "a backtick fence is not closed by tildes": "```\n~~~\ndelve\n```",
    "inline code over two lines": f"Use {BT}delve\nx{BT} here.",
    "a reference identifier and its definition": "See [guide][delve].\n\n[delve]: /docs",
    "a collapsed reference": "See [delve][].\n\n[delve]: /docs \"tapestry\"",
    "a link destination with balanced parentheses": "See [guide](docs/(example)delve).",
    "a lazy blockquote line": "> Example:\ndelve\n",
    "an indented code block": "Intro text.\n\n    delve\n",
    "a tab-indented code block": "Intro text.\n\n\tdelve\n",
    "a one-line HTML comment": "<!-- delve -->",
    "a multi-line HTML comment": "Text.\n\n<!--\ndelve\n-->\n\nMore text.",
    "a comment inside a line": "Text <!-- delve --> here.",
}
for name, text in silent.items():
    assert V(text) == [], (name, V(text))

# Prose the masks must not swallow.
loud = {
    "text after a fence closes": "```\ncode\n```\n\nWe delve here.",
    "text after a blockquote and a blank line": "> quote\n\nWe delve here.",
    "an indented line continuing a list item": "- first\n    we delve here",
    "an indented line continuing a paragraph": "Intro line\n    we delve here",
    "text after a comment closes": "<!--\nnote\n-->\n\nWe delve here.",
}
for name, text in loud.items():
    assert [f["rule"] for f in V(text)] == ["voice_overused_word"], (name, V(text))

# A line holding only inline code does not split its paragraph: the weak tell still sees the others.
found = V(f"The key is\n{BT}x{BT}\nWe delve; it serves as a hub.")
assert any("key" in f["message"] for f in found), found

print("  \033[32m✓\033[0m voice masking regressions: fences, code, links, quotes, comments")
PY
then
  pass=$((pass + 1))
  checked=$((checked + 1))
else
  printf '  \033[31m✗\033[0m voice masking regressions: fences, code, links, quotes, comments\n'
  fail=$((fail + 1))
fi

# ── Coverage honesty (FR-006, FR-008) ────────────────────────────────────────────────────────
#
# A directory-level property, so the per-file fixture loop above structurally cannot express it:
# the defect was that unanalysable files vanished from the average without appearing anywhere in
# the report. Asserted on a scratch directory rather than a committed fixture, because what is being
# checked is the accounting, not any particular file's score.

cov_dir="$(mktemp -d)"
trap 'rm -rf "$cov_dir"' EXIT
printf 'export const a = 1;\n'                      > "$cov_dir/a.ts"
printf 'openapi: 3.0.0\ninfo:\n  title: t\n'        > "$cov_dir/spec.yaml"
printf '#!/usr/bin/env bash\nset -euo pipefail\n'    > "$cov_dir/run.sh"
printf 'a,b\n1,2\n'                                 > "$cov_dir/data.csv"

cov_json="$(python3 scripts/code_quality_checker.py "$cov_dir" --json 2>/dev/null)"
cov_checks_failed=0
cov_assert() {
  if printf '%s' "$cov_json" | python3 -c "$2"; then
    printf '  \033[32m✓\033[0m %s\n' "$1"
  else
    printf '  \033[31m✗\033[0m %s\n' "$1"
    cov_checks_failed=$((cov_checks_failed + 1))
  fi
}

echo ""
echo "[Coverage] directory-level accounting:"
cov_assert "yaml and shell are analysed, not dropped" \
  'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["files_analyzed"]==3 else 1)'
cov_assert "the unanalysable file is named, not silently excluded" \
  'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["files_skipped"]==1 and any(".csv" in s["file"] for s in d["skipped"]) else 1)'
cov_assert "coverage is reported as partial when anything was skipped" \
  'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["coverage"]=="partial" else 1)'
cov_assert "every skipped entry carries a reason" \
  'import json,sys; d=json.load(sys.stdin); sys.exit(0 if all(s.get("reason") for s in d["skipped"]) else 1)'

# An all-unanalysable directory must still account for its files rather than collapsing to an error
# string that discards them.
none_dir="$(mktemp -d)"
printf 'a,b\n' > "$none_dir/only.csv"
none_json="$(python3 scripts/code_quality_checker.py "$none_dir" --json 2>/dev/null)"
rm -rf "$none_dir"
if printf '%s' "$none_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("files_skipped")==1 and d.get("average_score") is None and "error" not in d else 1)'; then
  printf '  \033[32m✓\033[0m an all-unanalysable directory still names its files\n'
else
  printf '  \033[31m✗\033[0m an all-unanalysable directory still names its files\n'
  cov_checks_failed=$((cov_checks_failed + 1))
fi

fail=$((fail + cov_checks_failed))

# Zero fixtures found would otherwise report success while checking nothing — the failure mode a
# guard is least able to notice about itself.
if [ "$checked" -eq 0 ]; then
  echo "SKIP: no fixture pairs found under $SKILL_DIR"
  exit 0
fi

echo
echo "[Results] $pass passed, $fail failed"
[ "$fail" -eq 0 ] && { echo "ALL ANALYZER FIXTURES MATCH ✓"; exit 0; }
echo "Analyzer output drifted. If the change was intentional, regenerate the fixture:"
echo "  cd $SKILL_DIR && python3 scripts/code_quality_checker.py <sample> --json > <expected>   # code fixtures"
echo "  cd $SKILL_DIR && python3 scripts/doc_quality_checker.py <sample.md> --json > <expected>  # markdown fixtures"
exit 1

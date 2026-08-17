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

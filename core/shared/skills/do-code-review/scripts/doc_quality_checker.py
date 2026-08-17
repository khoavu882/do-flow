#!/usr/bin/env python3
"""
Doc Quality Checker

Analyzes markdown/prose content (SKILL.md files, agent specs, guidance-tree
references) for structural health issues: skill-creator's progressive-disclosure
length guideline, presence of an explicit Boundaries (Will / Will Not) section,
triggering-description strength, dangling references/modes/ cross-references, and
staleness markers.

This is deliberately NOT a code-smell checker: markdown/prose has no "language" in
the sense `code_quality_checker.py`'s LANGUAGE_EXTENSIONS assumes, so there is no
complexity scoring, no SOLID-violation detection, and no aggregate quality score —
per this repo's Professional Honesty principle, inventing a single quality number
for prose would claim more precision than a pattern match can support. Every
finding here is deterministic and cite-the-match: it names the exact line, phrase,
or reference that triggered it.

See `core/shared/skills/do-code-review/content-types/markdown.md` for the full
rationale behind each check.

Usage:
    python doc_quality_checker.py /path/to/SKILL.md
    python doc_quality_checker.py /path/to/directory
    python doc_quality_checker.py . --json
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# Structural thresholds, named the same way code_quality_checker.py's THRESHOLDS dict is.
THRESHOLDS = {
    "skill_md_max_lines": 500,
    "description_min_words": 40,
}


def read_file_content(filepath: Path) -> str:
    """Read file content safely."""
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception:
        return ""


def display_path(path: Path) -> str:
    """The form a path takes in emitted output: relative to the working directory.

    Mirrors code_quality_checker.py's own `display_path` exactly, so findings from both
    checkers can be merged by review_report_generator.py without reconciling two path
    conventions. os.path.relpath rather than Path.relative_to: the latter raises ValueError
    for a target outside the working directory, which is a supported input here.
    """
    return os.path.relpath(str(path), os.getcwd())


def is_skill_md(path: Path) -> bool:
    """True for any `.../skills/<skill-name>/SKILL.md` — matches the dispatch pattern
    `*/skills/*/SKILL.md`, regardless of what precedes `skills/` in the path."""
    return path.name == "SKILL.md" and path.parent.parent.name == "skills"


_TOP_LEVEL_FRONTMATTER_KEY_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*)\s*:")


def frontmatter_keys(lines: List[str]) -> List[str]:
    """Top-level YAML frontmatter keys only — values are irrelevant here, and parsing them
    would take on a YAML dependency this repo deliberately does not have (mirrors
    test/guards/_shared.js's frontmatterKeys(), same reasoning)."""
    if not lines or lines[0].strip() != "---":
        return []
    keys = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if line[:1].isspace() or not line.strip():
            continue  # nested value, not a top-level key
        m = _TOP_LEVEL_FRONTMATTER_KEY_RE.match(line)
        if m:
            keys.append(m.group(1))
    return keys


def is_agent_spec(path: Path, lines: Optional[List[str]] = None) -> bool:
    """True for a specialist agent-spec file. `agent-specs` is this repo's own SOURCE-TREE
    directory name — every harness projects it to a differently-named directory on install
    (`agents/` for claude/codex/gemini/copilot/kiro; never `agent-specs/`), so a real installed
    copy would silently never match a directory-name-only check. Since DoFlow is designed to be
    installed anywhere, this checks the installed-shape name too, but path name alone is too
    generic (an unrelated project can have its own unrelated `agents/` folder) — content shape
    is the tie-breaker: an agent-spec's frontmatter has `tools:` and `model:` but never
    `argument-hint:` (that key belongs to a skill's own invocation contract, never an agent's)."""
    if path.suffix.lower() != ".md" or path.parent.name not in ("agent-specs", "agents"):
        return False
    if lines is None:
        lines = read_file_content(path).splitlines()
    keys = set(frontmatter_keys(lines))
    return "tools" in keys and "model" in keys and "argument-hint" not in keys


def find_guidance_dir(start: Path) -> Optional[Path]:
    """Walk up from `start` (a file or directory) looking for an ancestor that contains
    `core/shared/guidance`. Self-contained — does not depend on the caller's cwd, so this
    check works standalone on a single file passed from anywhere on disk."""
    for parent in [start if start.is_dir() else start.parent, *start.parents]:
        candidate = parent / "core" / "shared" / "guidance"
        if candidate.is_dir():
            return candidate
    return None


def make_finding(path: Path, line: int, rule: str, severity: str, message: str) -> Dict:
    """One finding, shaped `{file, line, rule, message}` at minimum (plus `severity`, the
    same triage field code_quality_checker.py's `smells` already carry) — the schema
    `review_report_generator.py` can consume from either checker without a new aggregation
    path. `line` is 0 for a file-level finding with no single matching line (an absence,
    like a missing section) — the same "no specific line" sentinel
    review_report_generator.py's own `issue.get("line", 0)` already treats as the default.
    """
    return {
        "file": display_path(path),
        "line": line,
        "rule": rule,
        "severity": severity,
        "message": message,
    }


# --------------------------------------------------------------------------------------
# Check 1: SKILL.md length vs. skill-creator's progressive-disclosure guideline
# --------------------------------------------------------------------------------------

def check_length(path: Path, lines: List[str]) -> List[Dict]:
    if not is_skill_md(path):
        return []
    total = len(lines)
    # A file ending in a single trailing newline splits into one extra empty element —
    # that is not a line of content, so it should not count toward the guideline.
    if total and lines[-1] == "":
        total -= 1
    limit = THRESHOLDS["skill_md_max_lines"]
    if total <= limit:
        return []
    return [make_finding(
        path, total, "skill_md_length", "medium",
        f"SKILL.md has {total} lines, exceeding skill-creator's ~{limit}-line "
        "progressive-disclosure guideline — split overflow into a references/ file so this "
        "stays a dispatch/overview surface."
    )]


# --------------------------------------------------------------------------------------
# Check 2: Boundaries (Will / Will Not) section, for SKILL.md and agent-spec files
# --------------------------------------------------------------------------------------

_BOUNDARIES_HEADING_RE = re.compile(r'^#{1,6}\s*Boundaries\b', re.IGNORECASE)
_HEADING_RE = re.compile(r'^#{1,6}\s')
_WILL_RE = re.compile(r'\*\*Will:?\*\*', re.IGNORECASE)
_WILL_NOT_RE = re.compile(r'\*\*Will Not:?\*\*', re.IGNORECASE)


def _find_boundaries_section(lines: List[str]) -> Tuple[Optional[int], str]:
    """Return (0-based heading line index or None, section text from the heading to the
    next heading or EOF). section text is "" when no heading is found."""
    heading_idx = None
    for i, line in enumerate(lines):
        if _BOUNDARIES_HEADING_RE.match(line.strip()):
            heading_idx = i
            break
    if heading_idx is None:
        return None, ""
    end_idx = len(lines)
    for j in range(heading_idx + 1, len(lines)):
        if _HEADING_RE.match(lines[j]):
            end_idx = j
            break
    return heading_idx, "\n".join(lines[heading_idx:end_idx])


def check_boundaries(path: Path, lines: List[str]) -> List[Dict]:
    if not (is_skill_md(path) or is_agent_spec(path, lines)):
        return []

    heading_idx, section_text = _find_boundaries_section(lines)

    if heading_idx is not None:
        if _WILL_RE.search(section_text) and _WILL_NOT_RE.search(section_text):
            return []
        return [make_finding(
            path, heading_idx + 1, "missing_boundaries", "medium",
            "Has a '## Boundaries' heading but no explicit '**Will:**' / '**Will Not:**' "
            "framing within it — scope is headed but not actually stated."
        )]

    # No heading at all — an equivalent Will/Will-Not framing elsewhere in the file still
    # counts, per this check's own "or equivalent framing" allowance.
    full_text = "\n".join(lines)
    if _WILL_RE.search(full_text) and _WILL_NOT_RE.search(full_text):
        return []
    return [make_finding(
        path, 0, "missing_boundaries", "medium",
        "No '## Boundaries' heading or equivalent '**Will:**' / '**Will Not:**' framing "
        "found — this file's scope is not explicit."
    )]


# --------------------------------------------------------------------------------------
# Check 3: triggering description strength, SKILL.md frontmatter only
# --------------------------------------------------------------------------------------

# Same shape as G8's own `argument-hint` extraction regex (test/guards/_shared.js), applied
# to `description:` instead — an optional wrapping quote, non-greedy body, trailing quote.
_FRONTMATTER_DESCRIPTION_RE = re.compile(r'^description:\s*"?(.*?)"?\s*$')

_TRIGGER_SIGNAL_RE = re.compile(
    r"\buse\s+(when|whenever|if)\b|\bfor\s+example\b|\be\.g\.|['\"][^'\"]{6,}['\"]",
    re.IGNORECASE,
)


def _parse_frontmatter_description(lines: List[str]) -> Optional[Dict]:
    """Return {"description": str, "line": 1-based line number} if the file opens with a
    YAML frontmatter block (`---` ... `---`) containing a `description:` field, else None."""
    if not lines or lines[0].strip() != "---":
        return None
    closing = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            closing = i
            break
    if closing is None:
        return None
    for i in range(1, closing):
        m = _FRONTMATTER_DESCRIPTION_RE.match(lines[i])
        if m:
            return {"description": m.group(1), "line": i + 1}
    return None


def check_description(path: Path, lines: List[str]) -> List[Dict]:
    if not is_skill_md(path):
        return []
    fm = _parse_frontmatter_description(lines)
    if fm is None:
        return []

    desc = fm["description"]
    word_count = len(desc.split())
    problems = []

    min_words = THRESHOLDS["description_min_words"]
    if word_count < min_words:
        problems.append(f"only {word_count} words (skill-creator's guidance wants roughly {min_words}+)")
    if not _TRIGGER_SIGNAL_RE.search(desc):
        problems.append('no concrete trigger phrase or example (e.g. "Use when...", a quoted user phrase)')

    if not problems:
        return []
    return [make_finding(
        path, fm["line"], "weak_trigger_description", "low",
        "Description is not sufficiently 'pushy' per skill-creator's guidance: "
        + "; ".join(problems) + "."
    )]


# --------------------------------------------------------------------------------------
# Check 4: dangling references/X.md or modes/X.md cross-references
# --------------------------------------------------------------------------------------

# Same match shape as G3's own dangling-reference regex (test/guards/consumers.test.js).
_REFERENCE_MENTION_RE = re.compile(r'`?((?:modes|references)/[A-Za-z0-9_.-]+\.md)`?')


def check_dangling_references(path: Path, lines: List[str]) -> List[Dict]:
    findings: List[Dict] = []
    guidance_dir = find_guidance_dir(path)

    # Two candidate resolution roots: the file's own directory (a skill's or an agent
    # spec's own references/modes subdirectory) and the shared guidance tree (what most
    # SKILL.md `references/X.md` mentions actually point at). A reference is only dangling
    # if it resolves under NEITHER — checking both, rather than picking one based on which
    # tree the file lives in, avoids a false "dangling" result for a guidance-tree file that
    # also happens to keep a mention relative to its own subdirectory, and vice versa.
    bases = [path.parent]
    if guidance_dir is not None and guidance_dir != path.parent:
        bases.append(guidance_dir)

    in_fence = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in _REFERENCE_MENTION_RE.finditer(line):
            ref = m.group(1)
            if any((base / ref).is_file() for base in bases):
                continue
            base_desc = " or ".join(display_path(b) for b in bases)
            findings.append(make_finding(
                path, i + 1, "dangling_reference", "high",
                f"'{ref}' does not resolve to a real file relative to {base_desc}."
            ))
    return findings


# --------------------------------------------------------------------------------------
# Check 5: staleness markers (deprecated/legacy/no longer/outdated/obsolete)
# --------------------------------------------------------------------------------------

_STALE_KEYWORD_RE = re.compile(r"\b(deprecated|legacy|no longer|outdated|obsolete)\b", re.IGNORECASE)

# Any of these appearing in the same paragraph is a strong signal the paragraph is
# *describing a detection rule or an instruction about reviewed code* — e.g. "flag TODO/
# deprecated comments" — not asserting that this file's own content is stale. This feature's
# own design-phase investigation already found a naive keyword grep over-triggers on exactly
# this pattern; excluding whole paragraphs on this signal is deliberately conservative.
_SIGNAL_WORDS_RE = re.compile(
    r"\b(flags?|flagged|flagging|detects?|detecting|pattern|patterns|listing|quotes?|"
    r"quoting|prune|pruned|remove|removed|identify|consult|consider|searches?)\b",
    re.IGNORECASE,
)

# A paragraph opening with a conditional/temporal connector ("When an item is superseded,
# ...") is describing a general mechanism, not asserting the current file's state.
_CONDITIONAL_START_RE = re.compile(r"^[^a-zA-Z]{0,10}(when|if|once|after|before)\b", re.IGNORECASE)


def _iter_paragraphs(lines: List[str]):
    """Yield (0-based start line index, paragraph lines) for each blank-line-delimited
    block of prose, skipping fenced code blocks entirely."""
    in_fence = False
    start = None
    block: List[str] = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            if block:
                yield start, block
                block, start = [], None
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if not stripped:
            if block:
                yield start, block
                block, start = [], None
            continue
        if start is None:
            start = i
        block.append(line)
    if block:
        yield start, block


def _offset_to_line(start_idx: int, para_lines: List[str], offset: int) -> int:
    """Map a character offset in `" ".join(para_lines)` back to a 1-based source line."""
    consumed = 0
    for j, l in enumerate(para_lines):
        seg_len = len(l) + (1 if j < len(para_lines) - 1 else 0)  # +1 for the joining space
        if offset < consumed + seg_len:
            return start_idx + j + 1
        consumed += seg_len
    return start_idx + len(para_lines)


def check_staleness(path: Path, lines: List[str]) -> List[Dict]:
    findings: List[Dict] = []
    for start_idx, para_lines in _iter_paragraphs(lines):
        para_text = " ".join(para_lines)

        if _CONDITIONAL_START_RE.match(para_text.strip()):
            continue
        # A paragraph carrying inline code (backtick-wrapped identifiers) is virtually
        # always technical prose naming actual fields/functions/paths, not a claim that
        # this document's own content is stale — every real example this check was
        # calibrated against (e.g. "the legacy `overlaps`/`serialize` fields") is this shape.
        if "`" in para_text:
            continue
        if _SIGNAL_WORDS_RE.search(para_text):
            continue

        for m in _STALE_KEYWORD_RE.finditer(para_text):
            start, end = m.span()
            before = para_text[start - 1] if start > 0 else ""
            after = para_text[end] if end < len(para_text) else ""
            if before in "\"'/" or after in "\"'/":
                # The keyword itself is quoted or slash-enumerated ("deprecated / legacy /
                # outdated") — the word is the referent, not a claim about this file.
                continue
            line_no = _offset_to_line(start_idx, para_lines, start)
            findings.append(make_finding(
                path, line_no, "staleness_marker", "low",
                f"Possible staleness marker '{m.group(0)}' — confirm this prose actually "
                "asserts the surrounding content is outdated, not a rule/instruction "
                "quoting the word as a detection target."
            ))
    return findings


# --------------------------------------------------------------------------------------
# File / directory orchestration
# --------------------------------------------------------------------------------------

def analyze_file(filepath: Path) -> List[Dict]:
    """Analyze a single markdown file. Returns [] for a non-.md file or an unreadable one —
    the same quiet-skip behavior code_quality_checker.py's directory walk relies on."""
    if filepath.suffix.lower() != ".md":
        return []
    content = read_file_content(filepath)
    if not content:
        return []
    lines = content.split("\n")

    findings: List[Dict] = []
    findings.extend(check_length(filepath, lines))
    findings.extend(check_boundaries(filepath, lines))
    findings.extend(check_description(filepath, lines))
    findings.extend(check_dangling_references(filepath, lines))
    findings.extend(check_staleness(filepath, lines))
    return findings


def analyze_directory(dir_path: Path, recursive: bool = True) -> List[Dict]:
    """Analyze every .md file under a directory."""
    findings: List[Dict] = []
    pattern = "**/*.md" if recursive else "*.md"
    for filepath in sorted(dir_path.glob(pattern)):
        if "node_modules" in str(filepath) or ".git" in str(filepath):
            continue
        findings.extend(analyze_file(filepath))
    return findings


def print_report(findings: List[Dict], target: Path) -> None:
    """Print human-readable analysis report."""
    print("=" * 60)
    print("DOC QUALITY REPORT")
    print("=" * 60)
    print(f"\nTarget: {display_path(target)}")
    print(f"Findings: {len(findings)}")

    if not findings:
        print("\nNo findings.")
        print("\n" + "=" * 60)
        return

    by_file: Dict[str, List[Dict]] = {}
    for finding in findings:
        by_file.setdefault(finding["file"], []).append(finding)

    for file, file_findings in by_file.items():
        print(f"\n{file}")
        for finding in file_findings:
            print(f"  [{finding['severity'].upper()}] line {finding['line']} "
                  f"({finding['rule']}): {finding['message']}")

    print("\n" + "=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Analyze markdown/prose content quality (structural + staleness checks)"
    )
    parser.add_argument(
        "path",
        help="File or directory to analyze"
    )
    parser.add_argument(
        "--recursive", "-r",
        action="store_true",
        default=True,
        help="Recursively analyze directories for .md files (default: true)"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output in JSON format"
    )
    parser.add_argument(
        "--output", "-o",
        help="Write output to file"
    )

    args = parser.parse_args()

    target = Path(args.path).resolve()

    if not target.exists():
        print(f"Error: Path does not exist: {target}", file=sys.stderr)
        sys.exit(1)

    if target.is_file():
        findings = analyze_file(target)
    else:
        findings = analyze_directory(target, args.recursive)
        if not findings and not any(target.glob("**/*.md" if args.recursive else "*.md")):
            print(f"Warning: no .md files found under {display_path(target)}", file=sys.stderr)

    if args.json:
        output = json.dumps(findings, indent=2, default=str)
        if args.output:
            with open(args.output, "w") as f:
                f.write(output)
            print(f"Results written to {args.output}")
        else:
            print(output)
    else:
        print_report(findings, target)


if __name__ == "__main__":
    main()

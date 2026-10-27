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
    (`agents/` for claude/codex/copilot/kiro; never `agent-specs/`), so a real installed
    copy would silently never match a directory-name-only check. Since DoFlow is designed to be
    installed anywhere, this checks the installed-shape name too, but path name alone is too
    generic (an unrelated project can have its own unrelated `agents/` folder) — content shape
    is the tie-breaker: an agent-spec's frontmatter has `model:` and either `tools:` (the legacy
    shape) or `effort:` (the current shared shape), but never `argument-hint:` (that key belongs
    to a skill's own invocation contract, never an agent's). Its `tools:` field is optional in
    the current shape; omitting it lets the host provide the agent's available tools."""
    if path.suffix.lower() != ".md" or path.parent.name not in ("agent-specs", "agents"):
        return False
    if lines is None:
        lines = read_file_content(path).splitlines()
    keys = set(frontmatter_keys(lines))
    return (
        "model" in keys
        and ("tools" in keys or "effort" in keys)
        and "argument-hint" not in keys
    )


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


def _unresolved_reference_message(ref: str, bases: List[Path]) -> Optional[str]:
    """None if `ref` resolves under any candidate base; otherwise the human-readable
    "does not resolve" message citing every base that was tried."""
    if any((base / ref).is_file() for base in bases):
        return None
    base_desc = " or ".join(display_path(b) for b in bases)
    return f"'{ref}' does not resolve to a real file relative to {base_desc}."


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
            message = _unresolved_reference_message(m.group(1), bases)
            if message:
                findings.append(make_finding(path, i + 1, "dangling_reference", "high", message))
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
# Check 6: uncited vendor claims (Feature 124, IC-004)
# --------------------------------------------------------------------------------------

_VENDOR_KW_RE = re.compile(
    r"\b(library|libraries|framework|frameworks|runtime|runtimes|sdk|sdks|package|packages|dependency|dependencies|vendor|vendors|api|apis)\b",
    re.IGNORECASE,
)
_BEHAVIOR_KW_RE = re.compile(
    r"\b(returns|throws|behaves|defaults to|implements|requires|supports)\b",
    re.IGNORECASE,
)
_CITATION_RE = re.compile(
    r"\b(context7|c7|mcp__context7__)\b|https?://|\bUNVERIFIED\b",
    re.IGNORECASE,
)
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def check_uncited_vendor_claims(path: Path, lines: List[str]) -> List[Dict]:
    findings: List[Dict] = []
    # Skip YAML frontmatter
    fm_end = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                fm_end = i + 1
                break

    for start_idx, para_lines in _iter_paragraphs(lines):
        if start_idx < fm_end:
            continue
        para_text = " ".join(para_lines)
        offset = 0
        for sent in _SENTENCE_SPLIT_RE.split(para_text):
            sent_clean = sent.strip()
            if not sent_clean:
                offset += len(sent) + 1
                continue
            if _VENDOR_KW_RE.search(sent_clean) and _BEHAVIOR_KW_RE.search(sent_clean):
                if not _CITATION_RE.search(sent_clean):
                    sent_pos = para_text.find(sent, offset)
                    if sent_pos == -1:
                        sent_pos = offset
                    line_no = _offset_to_line(start_idx, para_lines, sent_pos)
                    findings.append(make_finding(
                        path, line_no, "uncited_vendor_claim", "low",
                        "States library/vendor fact without citation: use context7 first, else an HTTPS URL, else tag as UNVERIFIED."
                    ))
            offset += len(sent) + 1
    return findings


# --------------------------------------------------------------------------------------
# Check 7: voice tells (opt-in `--voice`; row 132)
# --------------------------------------------------------------------------------------
#
# Advisory and deterministic: it finds phrases the guidance tree's `ARTIFACT_VOICE.md` asks
# writers to avoid. Every finding quotes the match; there is no score, percentage or grade, and
# the check never changes this script's exit status. The word lists below are this repo's own.
#
# A tell is STRONG (reported on its own) or WEAK (a word or mark that is often fine alone: one
# dash, one bold word, "key"). A weak tell is reported only when at least two other tells share
# its paragraph, so a plain sentence with one dash stays silent.

_V_STRONG_WORDS = [
    ("overused_word", r"delv(?:e|es|ed|ing)|tapestry|pivotal|testament|intricate|interplay|"
                      r"foster(?:s|ed|ing)?|underscor(?:e|es|ed|ing)|showcas(?:e|es|ed|ing)|vibrant"),
    ("sales_word", r"boasts?|seamless(?:ly)?|cutting-edge|game-chang(?:er|ing)|groundbreaking|"
                   r"revolutionary|world-class|best-in-class|state-of-the-art|unparalleled"),
    ("chatbot_residue", r"i hope this helps|hope that helps|great question|good question|"
                        r"i'?d be happy to|happy to help|as an ai(?: language model)?|"
                        r"let me know if you|feel free to (?:ask|reach)|"
                        r"(?<![\w'])(?:certainly|absolutely|of course)(?=!)"),
    ("knowledge_limit", r"as of my (?:last|latest) (?:update|training)|as of my knowledge|"
                        r"knowledge cut-?off|my training data|up to my last (?:update|training)|"
                        r"i (?:don'?t|do not) have (?:access to )?real-time"),
    ("serves_as", r"serv(?:es|e|ing) as|stands? as|standing as"),
]
_V_WEAK_WORDS = [
    ("overused_word", r"actually|additionally|crucial|enhanc(?:e|es|ed|ing)|highlight(?:s|ed|ing)?|"
                      r"key|landscape|valuable"),
    ("sales_word", r"robust|powerful"),
]
_V_STRONG_RES = [(k, re.compile(r"\b(?:" + p + r")\b" if k != "chatbot_residue" else "(?:" + p + ")",
                                re.IGNORECASE)) for k, p in _V_STRONG_WORDS]
_V_WEAK_RES = [(k, re.compile(r"\b(?:" + p + r")\b", re.IGNORECASE)) for k, p in _V_WEAK_WORDS]

_V_DASH_RE = re.compile("[—–]")
_V_CURLY_RE = re.compile("[‘’“”]")
_V_BOLD_RE = re.compile(r"\*\*[^*\n]+?\*\*|__[^_\n]+?__")
_V_LIST_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_V_HEADING_LINE_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_V_HEADING_ID_RE = re.compile(r"^(?:\d+(?:\.\d+)*\.?|[A-Z]{1,4}-?\d+:?)\s+")
_V_MINOR = {"a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at", "as",
            "vs", "via", "nor", "but", "from", "into", "is", "are"}

_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_INLINE_CODE_RE = re.compile(r"(`+)(?:(?!\1).)+?\1")
_LINK_TARGET_RE = re.compile(r"(\]\()[^)\n]*(\))")
_AUTOLINK_RE = re.compile(r"<(?:https?|mailto):[^>\n]*>|https?://[^\s)>\]]+")
_REFDEF_RE = re.compile(r"^(\s*\[[^\]\n]+\]:)\s*\S+")


def _blank(match: "re.Match") -> str:
    return " " * len(match.group(0))


def mask_prose(lines: List[str]) -> List[str]:
    """Return `lines` with every region a voice check must not read replaced by spaces, so
    offsets and line numbers stay valid: YAML front matter, fenced code, block quotes, inline
    code, link targets (the `(url)` of `[text](url)`, autolinks, bare URLs, reference defs)."""
    out: List[str] = []
    i = 0
    if lines and lines[0].strip() == "---":
        for j in range(1, len(lines)):
            if lines[j].strip() == "---":
                out = [""] * (j + 1)
                i = j + 1
                break
    in_fence = False
    for line in lines[i:]:
        if _FENCE_RE.match(line):
            in_fence = not in_fence
            out.append("")
            continue
        if in_fence or line.lstrip().startswith(">"):
            out.append("")
            continue
        line = _INLINE_CODE_RE.sub(_blank, line)
        line = _LINK_TARGET_RE.sub(lambda m: m.group(1) + " " * (len(m.group(0)) - 3) + m.group(2), line)
        line = _AUTOLINK_RE.sub(_blank, line)
        line = _REFDEF_RE.sub(lambda m: m.group(1) + " " * (len(m.group(0)) - len(m.group(1))), line)
        out.append(line)
    return out


def _voice_paragraphs(masked: List[str]) -> List[Tuple[int, List[str]]]:
    """Paragraphs of masked lines as (0-based start index, lines): a blank line, a heading and
    each list item start a new paragraph."""
    paras: List[Tuple[int, List[str]]] = []
    start, block = None, []

    def flush():
        nonlocal start, block
        if block:
            paras.append((start, block))
        start, block = None, []

    for i, line in enumerate(masked):
        if not line.strip():
            flush()
            continue
        if _V_HEADING_LINE_RE.match(line):
            flush()
            paras.append((i, [line]))
            continue
        if _V_LIST_RE.match(line):
            flush()
        if start is None:
            start = i
        block.append(line)
    flush()
    return paras


def _quote(text: str, limit: int = 60) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _is_title_case(heading: str) -> bool:
    heading = _V_HEADING_ID_RE.sub("", heading)   # "3.", "R1:" and "FR-001:" are identifiers, not words
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", heading)
    rest = [w for w in words[1:] if w.lower() not in _V_MINOR and len(w) >= 3]
    return len(rest) >= 2 and all(w[0].isupper() for w in rest)


def check_voice(path: Path, lines: List[str]) -> List[Dict]:
    findings: List[Dict] = []
    masked = mask_prose(lines)
    for start_idx, para in _voice_paragraphs(masked):
        strong: List[Tuple[int, str, str]] = []   # (1-based line, kind, quoted text)
        weak: List[Tuple[int, str, str]] = []
        dashes: List[Tuple[int, int]] = []
        curly: List[Tuple[int, int]] = []
        bold: List[Tuple[int, str]] = []

        for off, line in enumerate(para):
            ln = start_idx + off + 1
            text = line
            hm = _V_HEADING_LINE_RE.match(line)
            if hm and _is_title_case(hm.group(2)):
                strong.append((ln, "title_case_heading", _quote(hm.group(2))))
            for kind, rx in _V_STRONG_RES:
                for m in rx.finditer(text):
                    strong.append((ln, kind, _quote(m.group(0))))
            for kind, rx in _V_WEAK_RES:
                for m in rx.finditer(text):
                    weak.append((ln, kind, _quote(m.group(0))))
            for m in _V_DASH_RE.finditer(text):
                dashes.append((ln, m.start()))
            for m in _V_CURLY_RE.finditer(text):
                curly.append((ln, m.start()))
            lead = _V_LIST_RE.match(text)
            body_start = lead.end() if lead else len(text) - len(text.lstrip())
            for m in _V_BOLD_RE.finditer(text):
                inner = m.group(0)[2:-2].strip()
                if m.start() <= body_start or inner.endswith(":"):
                    continue    # a label or a defined term opening the item, not emphasis
                bold.append((ln, m.group(0)))

        def around(ln: int, col: int) -> str:
            src = para[ln - start_idx - 1]
            return _quote(src[max(0, col - 20): col + 20])

        if len(dashes) >= 2:
            strong.append((dashes[0][0], "dash_habit", around(*dashes[0])))
        elif dashes:
            weak.append((dashes[0][0], "dash_habit", around(*dashes[0])))
        if curly:
            weak.append((curly[0][0], "curly_quote", around(*curly[0])))
        if len(bold) >= 3:
            strong.append((bold[0][0], "bold_density", _quote(" ".join(b[1] for b in bold[:3]))))
        elif bold:
            weak.append((bold[0][0], "bold_density", _quote(bold[0][1])))

        if not (para and _V_LIST_RE.match(para[0]) or para[0].lstrip().startswith("|")):
            joined = " ".join(p.strip() for p in para)
            sents = [s for s in _SENTENCE_SPLIT_RE.split(joined) if s.strip()]
            openers = []
            for s in sents:
                om = re.match(r"[A-Za-z][A-Za-z'-]*", s.lstrip(" \"'(*_"))
                openers.append(om.group(0) if om else None)
            for i in range(len(openers) - 2):
                a, b, c = openers[i:i + 3]
                if a and b and c and len(a) >= 2 and a.lower() == b.lower() == c.lower():
                    pos = joined.find(sents[i])
                    strong.append((_offset_to_line(start_idx, para, max(pos, 0)),
                                   "repeated_opener", f"{a} (opens 3 consecutive sentences)"))
                    break

        tells = len(strong) + len(weak)
        reported = list(strong) + (list(weak) if tells >= 3 else [])
        for ln, kind, quoted in sorted(reported, key=lambda t: (t[0], t[1])):
            is_weak = (ln, kind, quoted) in weak
            findings.append(make_finding(
                path, ln, f"voice_{kind}", "low",
                f"{kind}: \"{quoted}\"" + (" (weak tell, shown because the paragraph has others)"
                                           if is_weak else "")))
    return findings


# --------------------------------------------------------------------------------------
# Facts diff: what a rewrite must not change (opt-in `--facts-diff BEFORE AFTER`; row 132)
# --------------------------------------------------------------------------------------
#
# Extracts numbers, capitalised names, dates, URLs and citation markers from two versions of a
# file. A fact only in AFTER is an error (the rewrite added it); a fact only in BEFORE is a
# warning (the rewrite dropped or changed it). Presence is compared, not counts. Dates are
# compared as ISO dates ("March 14, 2026" and "14 March 2026" are one fact). Lines wrapped
# inside a paragraph are joined first, so a name split over two lines is one name.
#
# Names are a heuristic. A run of capitalised words is a name. A single capitalised word that
# opens a sentence is a name only when the same word is capitalised mid-sentence in either
# version, or has an inner capital or digit ("PostgreSQL"): so a name that moves to or from a
# sentence start still matches itself, and "Run" turned into "Execute" is not an added fact.
# Words in `_F_STOP_START` are never names.

_MONTHS = (r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
           r"Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?")
_MONTH_NUMBER = {m: n for n, m in enumerate(
    "jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
_F_URL_RE = re.compile(r"https?://[^\s)>\]\"'`]+")
_F_DATE_RE = re.compile(
    rf"\b\d{{4}}-\d{{2}}-\d{{2}}\b|\b{_MONTHS}\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}\b|"
    rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s+{_MONTHS}\s+\d{{4}}\b|\b{_MONTHS}\s+\d{{4}}\b")
_F_DATE_FORMS = [
    (re.compile(r"(\d{4})-(\d{2})-(\d{2})"), lambda g: f"{g[0]}-{g[1]}-{g[2]}"),
    (re.compile(rf"({_MONTHS})\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})"),
     lambda g: f"{g[2]}-{_month(g[0]):02d}-{int(g[1]):02d}"),
    (re.compile(rf"(\d{{1,2}})(?:st|nd|rd|th)?\s+({_MONTHS})\s+(\d{{4}})"),
     lambda g: f"{g[2]}-{_month(g[1]):02d}-{int(g[0]):02d}"),
    (re.compile(rf"({_MONTHS})\s+(\d{{4}})"), lambda g: f"{g[1]}-{_month(g[0]):02d}"),
]
_F_CITE_RE = re.compile(
    r"\[\^[^\]\s]+\]|\[@[^\]\s]+\]|\[\d+(?:\s*[,–-]\s*\d+)*\]|"
    r"\([A-Z][A-Za-z-]+(?: et al\.| (?:and|&) [A-Z][A-Za-z-]+)?,? \d{4}[a-z]?\)")
_F_NUM_RE = re.compile(r"(?<![\w.])\d[\d,]*(?:\.\d+)*%?(?![\w])")
_F_STOP_START = {
    "The", "A", "An", "This", "That", "These", "Those", "It", "Its", "We", "Our", "You", "Your", "In",
    "On", "At", "For", "If", "When", "While", "Then", "There", "Here", "And", "But", "Or", "So",
    "As", "By", "With", "Without", "To", "Of", "Each", "Every", "Some", "Any", "All", "No", "Not",
    "See", "Note", "Use", "Run", "Read", "Set", "Add", "Make", "Keep", "Do", "Does", "Is", "Are",
    "Was", "Were", "Be", "After", "Before", "Once", "Since", "Because", "However", "Also", "Both",
    "Most", "Many", "One", "Two", "Three", "Only", "Even", "Still", "Yet", "Now", "Today",
}
_F_NAME_RUN_RE = re.compile(r"[A-Z][\w'-]*(?:[ \t]+[A-Z][\w'-]*)*")
_F_LAYOUT_PREFIX_RE = re.compile(r"[\s\-+*>|]*(?:\d+[.)])?[\s\-+*>|]*")
_F_BLOCK_START_RE = re.compile(r"^\s*(?:[-*+>|#]|\d+[.)]|`{3,}|~{3,})")


def _month(name: str) -> int:
    return _MONTH_NUMBER[name.lower()[:3]]


def _iso_date(text: str) -> str:
    for rx, fmt in _F_DATE_FORMS:
        m = rx.fullmatch(text)
        if m:
            return fmt(m.groups())
    return text


def _join_wrapped(text: str) -> str:
    """Replace the line break inside a paragraph with a space (same length, so offsets hold)."""
    lines = text.split("\n")
    out = []
    for idx, line in enumerate(lines):
        out.append(line)
        if idx < len(lines) - 1:
            nxt = lines[idx + 1]
            joinable = bool(line.strip() and nxt.strip() and not _F_BLOCK_START_RE.match(nxt)
                            and not line.lstrip().startswith(("|", "```", "~~~")))
            out.append(" " if joinable else "\n")
    return "".join(out)


def _extract_facts(text: str) -> Tuple[List[Tuple[str, str, int]], List[Tuple[str, int]]]:
    """Return (facts, initials). facts are (kind, normalised value, 1-based line); initials are
    the single capitalised words that open a sentence, which `facts_diff` resolves."""
    facts: List[Tuple[str, str, int]] = []
    initials: List[Tuple[str, int]] = []
    line_starts: List[int] = []
    pos = 0
    for line in text.split("\n"):
        line_starts.append(pos)
        pos += len(line) + 1

    def line_of(offset: int) -> int:
        lo, hi = 0, len(line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if line_starts[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1

    work = list(text)

    def take(rx: "re.Pattern", kind: str, norm=lambda s: s):
        for m in rx.finditer("".join(work)):
            value = m.group(0)
            if kind == "url":
                value = value.rstrip(".,;:!?")
            facts.append((kind, norm(value), line_of(m.start())))
            for k in range(m.start(), m.end()):
                if work[k] != "\n":
                    work[k] = " "

    take(_F_URL_RE, "url")
    take(_F_DATE_RE, "date", lambda s: _iso_date(" ".join(s.split())))
    take(_F_CITE_RE, "citation", lambda s: re.sub(r"\s+", "", s))
    # ordered-list markers are layout, not facts
    body = re.sub(r"(?m)^(\s*)(\d+[.)])(\s)", lambda m: m.group(1) + " " * len(m.group(2)) + m.group(3),
                  "".join(work))
    for m in _F_NUM_RE.finditer(body):
        facts.append(("number", m.group(0).replace(",", ""), line_of(m.start())))
    # headings are layout for names; blank them in place so later offsets keep their lines
    name_body = "\n".join(" " * len(l) if re.match(r"^\s{0,3}#{1,6}\s", l) else l for l in body.split("\n"))
    name_body = _join_wrapped(_INLINE_CODE_RE.sub(lambda m: _spaces(m.group(0)), name_body))
    for m in _F_NAME_RUN_RE.finditer(name_body):
        words = m.group(0).split()
        while words and words[0] in _F_STOP_START:
            words.pop(0)
        if not words or (len(words) == 1 and len(words[0]) < 2):
            continue
        prefix = name_body[name_body.rfind("\n", 0, m.start()) + 1:m.start()]
        opener = prefix.rstrip(" \t*_\"'([")
        sentence_start = bool(_F_LAYOUT_PREFIX_RE.fullmatch(prefix)) or opener == "" or opener[-1] in ".!?:"
        if len(words) == 1 and sentence_start and not re.search(r"[A-Z].*[A-Z]|[a-z]\d|\d", words[0]):
            initials.append((words[0], line_of(m.start())))
            continue
        facts.append(("name", " ".join(words), line_of(m.start())))
    return facts, initials


def facts_diff(before: Path, after: Path) -> List[Dict]:
    """Compare the facts of two versions. Added facts are errors, dropped ones warnings."""
    b, b_initials = _extract_facts(read_file_content(before))
    a, a_initials = _extract_facts(read_file_content(after))
    confirmed = {v for k, v, _ in b + a if k == "name"}
    b += [("name", w, ln) for w, ln in b_initials if w in confirmed]
    a += [("name", w, ln) for w, ln in a_initials if w in confirmed]
    b_keys = {(k, v) for k, v, _ in b}
    a_keys = {(k, v) for k, v, _ in a}
    findings: List[Dict] = []
    done = set()
    for kind, value, line in a:
        if (kind, value) not in b_keys and (kind, value) not in done:
            done.add((kind, value))
            findings.append(make_finding(
                after, line, f"fact_added_{kind}", "error",
                f"{kind} \"{_quote(value)}\" is in the rewrite but not in the source: "
                "remove it, or restore the source's version."))
    for kind, value, line in b:
        if (kind, value) not in a_keys and (kind, value) not in done:
            done.add((kind, value))
            findings.append(make_finding(
                before, line, f"fact_dropped_{kind}", "warning",
                f"{kind} \"{_quote(value)}\" is in the source but not in the rewrite: "
                "confirm the removal was intended."))
    return findings


# --------------------------------------------------------------------------------------
# File / directory orchestration
# --------------------------------------------------------------------------------------

def analyze_file(filepath: Path, voice: bool = False) -> List[Dict]:
    """Analyze a single markdown file. Returns [] for a non-.md file or an unreadable one —
    the same quiet-skip behavior code_quality_checker.py's directory walk relies on. `voice`
    adds the opt-in voice-tell check (Check 7); without it the output is unchanged."""
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
    findings.extend(check_uncited_vendor_claims(filepath, lines))
    if voice:
        findings.extend(check_voice(filepath, lines))
    return findings


def analyze_directory(dir_path: Path, recursive: bool = True, voice: bool = False) -> List[Dict]:
    """Analyze every .md file under a directory."""
    findings: List[Dict] = []
    pattern = "**/*.md" if recursive else "*.md"
    for filepath in sorted(dir_path.glob(pattern)):
        if "node_modules" in str(filepath) or ".git" in str(filepath):
            continue
        findings.extend(analyze_file(filepath, voice))
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
        nargs="?",
        help="File or directory to analyze"
    )
    parser.add_argument(
        "--voice",
        action="store_true",
        help="Also report advisory voice tells (overused and sales words, chatbot residue, ...)"
    )
    parser.add_argument(
        "--facts-diff",
        nargs=2,
        metavar=("BEFORE", "AFTER"),
        help="Compare the numbers, names, dates, URLs and citations of two versions of a file: "
             "a fact only in AFTER is an error (exit 1), one only in BEFORE a warning"
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

    if args.facts_diff:
        before, after = (Path(p).resolve() for p in args.facts_diff)
        for p in (before, after):
            if not p.is_file():
                print(f"Error: Not a file: {p}", file=sys.stderr)
                sys.exit(1)
        findings = facts_diff(before, after)
        if args.json:
            print(json.dumps(findings, indent=2, default=str))
        else:
            print_report(findings, after)
        sys.exit(1 if any(f["severity"] == "error" for f in findings) else 0)

    if not args.path:
        parser.error("a path is required unless --facts-diff is given")
    target = Path(args.path).resolve()

    if not target.exists():
        print(f"Error: Path does not exist: {target}", file=sys.stderr)
        sys.exit(1)

    if target.is_file():
        findings = analyze_file(target, args.voice)
    else:
        findings = analyze_directory(target, args.recursive, args.voice)
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

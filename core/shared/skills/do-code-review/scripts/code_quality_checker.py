#!/usr/bin/env python3
"""
Code Quality Checker

Analyzes source code for quality issues, code smells, complexity metrics,
and SOLID principle violations.

Usage:
    python code_quality_checker.py /path/to/file.py
    python code_quality_checker.py /path/to/directory --recursive
    python code_quality_checker.py . --language typescript --json
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional


# Language-specific file extensions.
# `c` is declared before `cpp` so plain `.h` resolves to C, matching the
# dispatch table in SKILL.md. C++ headers use `.hpp` / `.hh` / `.hxx`.
LANGUAGE_EXTENSIONS = {
    "python": [".py"],
    "typescript": [".ts", ".tsx"],
    "javascript": [".js", ".jsx", ".mjs"],
    "go": [".go"],
    "swift": [".swift"],
    "kotlin": [".kt", ".kts"],
    "csharp": [".cs", ".csx", ".razor", ".cshtml"],
    "java": [".java"],
    "c": [".c", ".h"],
    "cpp": [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    "rust": [".rs"],
    "ruby": [".rb", ".rake", ".gemspec", ".ru"],
    "php": [".php", ".phtml"],
    "dart": [".dart"],
    "shell": [".sh", ".bash", ".zsh"],
    "yaml": [".yaml", ".yml"],
    "json": [".json"],
}

# Languages analysed as declarative structure rather than as code. Functions, classes, cyclomatic
# complexity and SOLID have no meaning here, and reporting them anyway is how a fabricated score
# gets attached to a file nobody analysed — the defect this coverage work exists to remove.
DECLARATIVE_LANGUAGES = {"yaml", "json"}

# Code smell thresholds
THRESHOLDS = {
    "long_function_lines": 50,
    "too_many_parameters": 5,
    "high_complexity": 10,
    "god_class_methods": 20,
    "max_imports": 15,
    "max_declarative_depth": 8,
}


def get_file_extension(filepath: Path) -> str:
    """Get file extension."""
    return filepath.suffix.lower()


def detect_language(filepath: Path) -> Optional[str]:
    """Detect programming language from file extension."""
    ext = get_file_extension(filepath)
    for lang, extensions in LANGUAGE_EXTENSIONS.items():
        if ext in extensions:
            return lang
    return None


def read_file_content(filepath: Path) -> str:
    """Read file content safely."""
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception:
        return ""


def strip_comments(content: str) -> str:
    """
    Remove comment text so prose is not measured as code.

    The keyword scan below matches \\band\\b and \\bor\\b — Python operators — against raw text,
    case-insensitively. A documented function was therefore charged for every "and" and "or" in its
    own prose, so the better a function was commented the worse it scored. Blank lines replace the
    removed text rather than deleting it, so any line number derived from this string still lines up
    with the original file.

    Deliberately not handled: an "and"/"or" inside a string literal still counts. That is a separate
    defect from the reported one, and stripping strings correctly needs a real tokenizer.
    """
    # Block comments first, preserving newline count so line numbers survive.
    content = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), content, flags=re.DOTALL)
    out = []
    for line in content.split("\n"):
        stripped = line.lstrip()
        if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("#"):
            out.append("")
        else:
            out.append(re.sub(r"\s//.*$", "", line))
    return "\n".join(out)


def trim_trailing_comment_block(body: str) -> str:
    """
    Drop a documentation comment sitting at the end of a sliced function body.

    `find_functions` slices a body from one function match to the *next* one, so whatever documents
    the next function landed inside this one — inflating its line count and its complexity. The
    comment belongs to what follows, not to what precedes it.
    """
    lines = body.split("\n")
    end = len(lines)
    while end > 0 and lines[end - 1].strip() == "":
        end -= 1
    # Walk back over a contiguous run of comment lines at the tail.
    start = end
    while start > 0:
        candidate = lines[start - 1].strip()
        if candidate.startswith(("//", "/*", "*", "#")) or candidate == "":
            start -= 1
        else:
            break
    return "\n".join(lines[:start]) if start < end else "\n".join(lines[:end])


def calculate_cyclomatic_complexity(content: str) -> int:
    """
    Estimate cyclomatic complexity based on control flow keywords.

    Comments are stripped first: counting keywords in prose made documentation a penalty.
    """
    content = strip_comments(content)
    complexity = 1  # Base complexity

    # Control flow patterns that increase complexity
    patterns = [
        r"\bif\b",
        r"\belif\b",
        r"\belse\b",
        r"\bfor\b",
        r"\bwhile\b",
        r"\bcase\b",
        r"\bcatch\b",
        r"\bexcept\b",
        r"\band\b",
        r"\bor\b",
        r"\|\|",
        r"&&"
    ]

    for pattern in patterns:
        matches = re.findall(pattern, content, re.IGNORECASE)
        complexity += len(matches)

    return complexity


def count_lines(content: str) -> Dict[str, int]:
    """Count different types of lines in code."""
    lines = content.split("\n")
    total = len(lines)
    blank = sum(1 for line in lines if not line.strip())
    comment = 0

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            comment += 1
        elif stripped.startswith("/*") or stripped.startswith("'''") or stripped.startswith('"""'):
            comment += 1

    code = total - blank - comment

    return {
        "total": total,
        "code": code,
        "blank": blank,
        "comment": comment
    }


def find_functions(content: str, language: str) -> List[Dict]:
    """Find function definitions and their metrics."""
    functions = []

    # Language-specific function patterns
    patterns = {
        "python": r"def\s+(\w+)\s*\(([^)]*)\)",
        # Both shell spellings: `name() {` and `function name {`.
        "shell": r"(?:function\s+(\w+)\s*(?:\(\s*\))?|(\w+)\s*\(\s*\))\s*\{",
        "typescript": r"(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)",
        "javascript": r"(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)",
        "go": r"func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)",
        "swift": r"func\s+(\w+)\s*\(([^)]*)\)",
        "kotlin": r"fun\s+(\w+)\s*\(([^)]*)\)",
        # C#: require at least one method modifier (public/private/etc. or static/async/...)
        # to distinguish declarations from invocations.
        "csharp": (
            r"(?:(?:public|private|protected|internal|static|async|virtual|"
            r"override|sealed|abstract|partial|new|readonly|extern)\s+)+"
            r"(?:[\w<>?,\s\[\]\.]+?\s+)?(\w+)\s*\(([^)]*)\)"
        ),
        # Java: require at least one method modifier to distinguish
        # declarations from invocations (mirrors the C# approach).
        "java": (
            r"(?:(?:public|private|protected|static|final|abstract|"
            r"synchronized|native|default|strictfp)\s+)+"
            r"(?:[\w<>?,\s\[\]\.]+?\s+)?(\w+)\s*\(([^)]*)\)"
        ),
        # C: require an opening brace after the parens so prototypes and
        # call sites don't get matched. Return type / qualifiers come first.
        # Skip C control-flow keywords that look like function calls.
        "c": (
            r"^(?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|"
            r"signed\s+|volatile\s+|register\s+)*"
            r"(?:[\w\*]+\s+\**)+"
            r"(?!(?:if|while|for|switch|return|sizeof)\b)"
            r"(\w+)\s*\(([^)]*)\)\s*\{"
        ),
        # C++: like C but also catches `ClassName::method(...)` definitions
        # and template return types like `std::vector<int>`.
        "cpp": (
            r"^(?:static\s+|inline\s+|extern\s+|const\s+|virtual\s+|"
            r"explicit\s+|constexpr\s+|noexcept\s+)*"
            r"(?:[\w:\*<>&,\s]+\s+\**)+"
            r"(?!(?:if|while|for|switch|return|sizeof)\b)"
            r"(\w+)(?:::\w+)?\s*\(([^)]*)\)\s*(?:const\s*)?"
            r"(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?\{"
        ),
        # Rust: `fn` keyword is always present and unambiguous.
        "rust": (
            r"(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?"
            r"(?:extern\s+\"[^\"]+\"\s+)?fn\s+(\w+)\s*"
            r"(?:<[^>]+>)?\s*\(([^)]*)\)"
        ),
        # Ruby: `def` keyword; params may be parenthesised or bare.
        "ruby": (
            r"def\s+(?:self\.)?(\w+[?!=]?)(?:\s*\(([^)]*)\)|\s*$|\s+\w)"
        ),
        # PHP: `function` keyword is always present.
        "php": (
            r"(?:(?:public|private|protected|static|abstract|final)\s+)*"
            r"function\s+(\w+)\s*\(([^)]*)\)"
        ),
        # Dart: typed return followed by name and parens. Constructors
        # (where name matches enclosing class) are not specially handled.
        "dart": (
            r"^\s*(?:static\s+|external\s+)*"
            r"(?:Future<[^>]*>|Stream<[^>]*>|void|[\w<>?,\s]+?)\s+"
            r"(\w+)\s*\(([^)]*)\)\s*(?:async\*?\s*|sync\*?\s*)?\{"
        ),
    }

    pattern = patterns.get(language, patterns["python"])
    matches = re.finditer(pattern, content, re.MULTILINE)

    for match in matches:
        name = next((g for g in match.groups() if g), "anonymous")
        params_str = match.group(2) if len(match.groups()) > 1 and match.group(2) else ""

        # Count parameters
        params = [p.strip() for p in params_str.split(",") if p.strip()]
        param_count = len(params)

        # Estimate function length
        start_pos = match.end()
        remaining = content[start_pos:]

        next_func = re.search(pattern, remaining)
        if next_func:
            func_body = remaining[:next_func.start()]
        else:
            func_body = remaining[:min(2000, len(remaining))]

        # The slice runs to the next function's *declaration*, so it swallows that function's
        # documentation comment. Give it back before measuring anything.
        func_body = trim_trailing_comment_block(func_body)

        line_count = len(func_body.split("\n"))
        complexity = calculate_cyclomatic_complexity(func_body)

        functions.append({
            "name": name,
            "parameters": param_count,
            "lines": line_count,
            "complexity": complexity
        })

    return functions


def find_classes(content: str, language: str) -> List[Dict]:
    """Find class definitions and their metrics."""
    classes = []

    patterns = {
        "python": r"class\s+(\w+)",
        "typescript": r"class\s+(\w+)",
        "javascript": r"class\s+(\w+)",
        "go": r"type\s+(\w+)\s+struct",
        "swift": r"class\s+(\w+)",
        "kotlin": r"class\s+(\w+)",
        "csharp": r"(?:class|struct|record|interface)\s+(\w+)",
        "java": r"(?:class|interface|enum|record)\s+(\w+)",
        # C has no classes; `struct` and `typedef struct` are the closest.
        "c": r"(?:typedef\s+)?struct\s+(\w+)",
        "cpp": r"(?:class|struct)\s+(\w+)",
        # Rust uses `struct`, `enum`, `trait`, `union` for type definitions.
        # `impl` blocks attach methods but are not type defs themselves.
        "rust": r"(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait|union)\s+(\w+)",
        "ruby": r"(?:class|module)\s+(\w+)",
        "php": (
            r"(?:abstract\s+|final\s+)?"
            r"(?:class|interface|trait|enum)\s+(\w+)"
        ),
        # Dart 3 class modifiers: final / interface / base / sealed / mixin.
        "dart": (
            r"(?:abstract\s+|sealed\s+|final\s+|base\s+|interface\s+)?"
            r"(?:class|mixin|enum|extension)\s+(\w+)"
        ),
    }

    pattern = patterns.get(language, patterns["python"])
    matches = re.finditer(pattern, content)

    for match in matches:
        name = match.group(1)

        start_pos = match.end()
        remaining = content[start_pos:]

        next_class = re.search(pattern, remaining)
        if next_class:
            class_body = remaining[:next_class.start()]
        else:
            class_body = remaining

        # Count methods
        method_patterns = {
            "python": r"def\s+\w+\s*\(",
            "typescript": r"(?:public|private|protected)?\s*\w+\s*\([^)]*\)\s*[:{]",
            "javascript": r"\w+\s*\([^)]*\)\s*\{",
            "go": r"func\s+\(",
            "swift": r"func\s+\w+",
            "kotlin": r"fun\s+\w+",
            "csharp": (
                r"(?:(?:public|private|protected|internal|static|async|virtual|"
                r"override|sealed|abstract|partial)\s+)+"
                r"(?:[\w<>?,\s\[\]\.]+?\s+)?\w+\s*\("
            ),
            "java": (
                r"(?:(?:public|private|protected|static|final|abstract|"
                r"synchronized|native|default|strictfp)\s+)+"
                r"(?:[\w<>?,\s\[\]\.]+?\s+)?\w+\s*\("
            ),
            # C has no classes; struct members are typically function pointers
            # rather than methods. Use the function definition pattern.
            "c": (
                r"^(?:static\s+|inline\s+)*(?:[\w\*]+\s+\**)+"
                r"(?!(?:if|while|for|switch|return|sizeof)\b)"
                r"\w+\s*\([^)]*\)\s*\{"
            ),
            "cpp": (
                r"^(?:static\s+|inline\s+|virtual\s+|explicit\s+|"
                r"constexpr\s+)*(?:[\w:\*<>&,\s]+\s+\**)+"
                r"(?!(?:if|while|for|switch|return|sizeof)\b)"
                r"\w+(?:::\w+)?\s*\([^)]*\)"
            ),
            "rust": (
                r"(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?"
                r"fn\s+\w+"
            ),
            "ruby": r"def\s+(?:self\.)?\w+[?!=]?",
            "php": (
                r"(?:(?:public|private|protected|static|abstract|final)\s+)*"
                r"function\s+\w+\s*\("
            ),
            "dart": (
                r"^\s*(?:static\s+|external\s+)*"
                r"(?:Future<[^>]*>|Stream<[^>]*>|void|[\w<>?,\s]+?)\s+"
                r"\w+\s*\([^)]*\)\s*(?:async\*?\s*|sync\*?\s*)?\{"
            ),
        }
        method_pattern = method_patterns.get(language, method_patterns["python"])
        methods = len(re.findall(method_pattern, class_body))

        classes.append({
            "name": name,
            "methods": methods,
            "lines": len(class_body.split("\n"))
        })

    return classes


def check_code_smells(content: str, functions: List[Dict], classes: List[Dict]) -> List[Dict]:
    """Check for code smells in the content."""
    smells = []

    # Long functions
    for func in functions:
        if func["lines"] > THRESHOLDS["long_function_lines"]:
            smells.append({
                "type": "long_function",
                "severity": "medium",
                "message": f"Function '{func['name']}' has {func['lines']} lines (max: {THRESHOLDS['long_function_lines']})",
                "location": func["name"]
            })

    # Too many parameters
    for func in functions:
        if func["parameters"] > THRESHOLDS["too_many_parameters"]:
            smells.append({
                "type": "too_many_parameters",
                "severity": "low",
                "message": f"Function '{func['name']}' has {func['parameters']} parameters (max: {THRESHOLDS['too_many_parameters']})",
                "location": func["name"]
            })

    # High complexity
    for func in functions:
        if func["complexity"] > THRESHOLDS["high_complexity"]:
            severity = "high" if func["complexity"] > 20 else "medium"
            smells.append({
                "type": "high_complexity",
                "severity": severity,
                "message": f"Function '{func['name']}' has complexity {func['complexity']} (max: {THRESHOLDS['high_complexity']})",
                "location": func["name"]
            })

    # God classes
    for cls in classes:
        if cls["methods"] > THRESHOLDS["god_class_methods"]:
            smells.append({
                "type": "god_class",
                "severity": "high",
                "message": f"Class '{cls['name']}' has {cls['methods']} methods (max: {THRESHOLDS['god_class_methods']})",
                "location": cls["name"]
            })

    # Magic numbers
    magic_pattern = r"\b(?<![.\"\'])\d{3,}\b(?!\.\d)"
    for i, line in enumerate(content.split("\n"), 1):
        if line.strip().startswith(("#", "//", "import", "from")):
            continue
        matches = re.findall(magic_pattern, line)
        for match in matches[:1]:  # One per line
            smells.append({
                "type": "magic_number",
                "severity": "low",
                "message": f"Magic number {match} should be a named constant",
                "location": f"line {i}"
            })

    # Commented code patterns
    commented_code_pattern = r"^\s*[#//]+\s*(if|for|while|def|function|class|const|let|var)\s"
    for i, line in enumerate(content.split("\n"), 1):
        if re.match(commented_code_pattern, line, re.IGNORECASE):
            smells.append({
                "type": "commented_code",
                "severity": "low",
                "message": "Commented-out code should be removed",
                "location": f"line {i}"
            })

    return smells


def _strip_csharp_comments(content: str) -> str:
    """Remove // line comments and /* */ block comments so regex detectors
    don't match keywords inside prose."""
    no_block = re.sub(r"/\*.*?\*/", "", content, flags=re.DOTALL)
    no_line = re.sub(r"//[^\n]*", "", no_block)
    return no_line


def check_csharp_specific_smells(content: str) -> List[Dict]:
    """C# / .NET-specific code smells documented in SKILL.md."""
    smells: List[Dict] = []
    content = _strip_csharp_comments(content)

    # async void (event handler exception only — caller must justify)
    for match in re.finditer(r"\basync\s+void\s+(\w+)\s*\(", content):
        smells.append({
            "type": "csharp_async_void",
            "severity": "high",
            "message": (
                f"'async void {match.group(1)}' — only safe for event handlers; "
                "prefer 'async Task'"
            ),
            "location": match.group(1),
        })

    # Blocking on async: .Result, .Wait(), .GetAwaiter().GetResult()
    for match in re.finditer(
        r"\.(?:Result\b|Wait\(\)|GetAwaiter\(\)\.GetResult\(\))", content
    ):
        smells.append({
            "type": "csharp_blocking_async",
            "severity": "high",
            "message": (
                "Blocking call on async operation ('.Result' / '.Wait()' / "
                "'.GetAwaiter().GetResult()') — can deadlock in ASP.NET contexts"
            ),
            "location": f"offset {match.start()}",
        })

    # Bare catch / catch (Exception) that swallows
    swallow_pattern = re.compile(
        r"catch\s*(?:\(\s*(?:System\.)?Exception(?:\s+\w+)?\s*\))?\s*\{\s*\}"
    )
    for match in swallow_pattern.finditer(content):
        smells.append({
            "type": "csharp_swallowed_exception",
            "severity": "high",
            "message": "Empty catch block swallows exceptions silently",
            "location": f"offset {match.start()}",
        })

    # IDisposable instantiated but not in `using` — heuristic: `new SomethingClient(`
    # / `new SomethingStream(` / `new SqlConnection(` outside a `using` line.
    disposable_hint = re.compile(
        r"^(?!\s*using\b)\s*(?:var|[\w<>]+)\s+\w+\s*=\s*new\s+"
        r"(\w*(?:Stream|Connection|Reader|Writer|Client|Context|Command))\s*\(",
        re.MULTILINE,
    )
    for match in disposable_hint.finditer(content):
        smells.append({
            "type": "csharp_undisposed_idisposable",
            "severity": "medium",
            "message": (
                f"'{match.group(1)}' looks like IDisposable but is not wrapped in "
                "'using' / 'using var'"
            ),
            "location": f"offset {match.start()}",
        })

    # HttpClient instantiated with `new` inside a method body (socket exhaustion)
    httpclient_inline = re.compile(r"new\s+HttpClient\s*\(\s*\)")
    for match in httpclient_inline.finditer(content):
        smells.append({
            "type": "csharp_new_httpclient",
            "severity": "medium",
            "message": (
                "'new HttpClient()' — prefer IHttpClientFactory or a long-lived "
                "static instance to avoid socket exhaustion"
            ),
            "location": f"offset {match.start()}",
        })

    # Missing await: `Task.Run(` / async method call assigned but never awaited.
    # Heuristic: a statement ending in `Async()` or `Async(...)` followed by `;`
    # with no `await` keyword on the same line.
    for line_no, line in enumerate(content.split("\n"), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith(("//", "/*", "*")):
            continue
        if re.search(r"\b\w+Async\s*\([^)]*\)\s*;\s*$", stripped) and "await " not in stripped:
            # Skip `return ...Async();` (forwarding the Task is legitimate)
            if stripped.startswith("return "):
                continue
            smells.append({
                "type": "csharp_missing_await",
                "severity": "medium",
                "message": "Async method called without 'await' — Task is discarded",
                "location": f"line {line_no}",
            })

    # Unnecessary `using` directives — heuristic: `using` directive whose
    # namespace tail isn't referenced anywhere else in the file.
    using_directives = re.findall(
        r"^using\s+(?:static\s+)?([A-Z]\w*(?:\.\w+)*)\s*;", content, re.MULTILINE
    )
    body = re.sub(r"^using\s+[^;]+;\s*$", "", content, flags=re.MULTILINE)
    for ns in using_directives:
        tail = ns.split(".")[-1]
        if not re.search(rf"\b{re.escape(tail)}\b", body):
            smells.append({
                "type": "csharp_unused_using",
                "severity": "low",
                "message": f"'using {ns};' appears unused",
                "location": ns,
            })

    return smells


def check_java_specific_smells(content: str) -> List[Dict]:
    """Java-specific code smells documented in languages/java.md."""
    smells: List[Dict] = []
    # Java comment syntax matches C#, so the same stripper applies.
    content = _strip_csharp_comments(content)

    # Empty catch block — swallows the exception silently.
    for match in re.finditer(r"catch\s*\([^)]*\)\s*\{\s*\}", content):
        smells.append({
            "type": "java_empty_catch",
            "severity": "high",
            "message": "Empty catch block swallows exceptions silently",
            "location": f"offset {match.start()}",
        })

    # printStackTrace() as error handling — use a logger instead.
    for match in re.finditer(r"\.printStackTrace\s*\(\s*\)", content):
        smells.append({
            "type": "java_print_stack_trace",
            "severity": "medium",
            "message": (
                "'printStackTrace()' is not real error handling — log via a "
                "proper logger or rethrow with context"
            ),
            "location": f"offset {match.start()}",
        })

    # InterruptedException caught without restoring the interrupt flag.
    for match in re.finditer(
        r"catch\s*\(\s*InterruptedException\s+(\w+)\s*\)\s*\{(.*?)\}",
        content,
        re.DOTALL,
    ):
        if "interrupt()" not in match.group(2):
            smells.append({
                "type": "java_swallowed_interrupt",
                "severity": "high",
                "message": (
                    "InterruptedException caught without "
                    "'Thread.currentThread().interrupt()' — breaks cooperative "
                    "cancellation"
                ),
                "location": f"offset {match.start()}",
            })

    # Closeable resource instantiated outside try-with-resources (leak heuristic).
    resource_hint = re.compile(
        r"^(?!\s*try\b)\s*(?:final\s+)?[\w<>\[\]]+\s+\w+\s*=\s*new\s+"
        r"(\w*(?:InputStream|OutputStream|Reader|Writer|Stream|Connection))\s*\(",
        re.MULTILINE,
    )
    for match in resource_hint.finditer(content):
        smells.append({
            "type": "java_unclosed_resource",
            "severity": "medium",
            "message": (
                f"'{match.group(1)}' looks like an AutoCloseable but is not in a "
                "try-with-resources statement"
            ),
            "location": f"offset {match.start()}",
        })

    # Heavy object built per use instead of shared as a singleton.
    # A `static` field assignment is the recommended singleton form — skip it.
    heavy_object = re.compile(
        r"^(?!.*\bstatic\b).*\bnew\s+(ObjectMapper|Gson)\s*\(\s*\)",
        re.MULTILINE,
    )
    for match in heavy_object.finditer(content):
        smells.append({
            "type": "java_per_use_heavy_object",
            "severity": "medium",
            "message": (
                f"'new {match.group(1)}()' is expensive — share a singleton "
                "instance instead of constructing per call"
            ),
            "location": f"offset {match.start()}",
        })

    return smells


def check_c_specific_smells(content: str) -> List[Dict]:
    """C-specific code smells documented in languages/c.md.

    Focuses on memory-safety and command/format-string patterns that the
    CERT C Coding Standard and the CWE catalogue rank as the
    highest-impact footguns. C uses the same line/block comment syntax as
    C# and Java, so the existing comment stripper applies.
    """
    smells: List[Dict] = []
    content = _strip_csharp_comments(content)

    # 1. Banned functions — no bounds check on any of them.
    banned = {
        "gets": "no bounds check, removed from C11 (CWE-242)",
        "strcpy": "no bounds check — prefer strncpy or strlcpy",
        "strcat": "no bounds check — prefer strncat or strlcat",
        "sprintf": "no bounds check — prefer snprintf",
        "vsprintf": "no bounds check — prefer vsnprintf",
    }
    for fn, reason in banned.items():
        for m in re.finditer(rf"\b{fn}\s*\(", content):
            smells.append({
                "type": f"c_banned_{fn}",
                "severity": "high",
                "message": f"'{fn}()' is unsafe: {reason}",
                "location": f"offset {m.start()}",
            })

    # 2. Format-string vulnerability — printf/syslog called with a bare
    # identifier as the format argument (CWE-134). Skip when the first
    # arg is a string literal.
    for fn in ("printf", "syslog"):
        pattern = rf"\b{fn}\s*\(\s*(?!\")(\w+)\s*[,\)]"
        for m in re.finditer(pattern, content):
            smells.append({
                "type": "c_format_string",
                "severity": "high",
                "message": (
                    f"'{fn}({m.group(1)})' uses a non-literal format string "
                    "— CWE-134 format string vulnerability"
                ),
                "location": f"offset {m.start()}",
            })

    # 3. Unbounded scanf — `%s` without a width specifier invites overflow.
    scanf_call = re.compile(
        r"\b(?:scanf|fscanf|sscanf)\s*\(\s*[^)]*?\"([^\"]*)\""
    )
    for m in scanf_call.finditer(content):
        fmt = m.group(1)
        if "%s" in fmt and not re.search(r"%\d+s", fmt):
            smells.append({
                "type": "c_unbounded_scanf",
                "severity": "high",
                "message": (
                    "scanf '%s' without a width specifier — unbounded read "
                    "can overflow the destination buffer"
                ),
                "location": f"offset {m.start()}",
            })

    # 4. malloc / calloc / realloc result dereferenced without a NULL check
    # within 5 lines. CWE-690.
    lines = content.split("\n")
    malloc_assign = re.compile(
        r"^\s*(?:[\w\*]+\s+)?\*?(\w+)\s*=\s*\(?[\w\s\*]*\)?\s*"
        r"(?:m|c|re)alloc\s*\("
    )
    for i, line in enumerate(lines):
        m = malloc_assign.match(line)
        if not m:
            continue
        var = m.group(1)
        window = "\n".join(lines[i + 1 : i + 6])
        null_check = re.compile(
            rf"\bif\s*\([^)]*(?:{re.escape(var)}\s*==\s*NULL"
            rf"|NULL\s*==\s*{re.escape(var)}"
            rf"|!\s*{re.escape(var)}\b"
            rf"|{re.escape(var)}\s*!=\s*NULL)"
        )
        if not null_check.search(window):
            smells.append({
                "type": "c_malloc_unchecked",
                "severity": "medium",
                "message": (
                    f"'{var}' from malloc/calloc/realloc is not NULL-checked "
                    "within 5 lines — dereferencing NULL is UB (CWE-690)"
                ),
                "location": f"line {i + 1}",
            })

    # 5. free(p) without setting p to NULL on the next real line.
    # CWE-416 use-after-free guardrail.
    free_call = re.compile(r"^\s*free\s*\(\s*(\w+)\s*\)\s*;")
    for i, line in enumerate(lines):
        m = free_call.match(line)
        if not m:
            continue
        var = m.group(1)
        for j in range(i + 1, min(i + 3, len(lines))):
            nxt = lines[j].strip()
            if not nxt:
                continue
            if re.match(rf"^{re.escape(var)}\s*=\s*NULL\s*;", nxt):
                break
            smells.append({
                "type": "c_free_without_null",
                "severity": "low",
                "message": (
                    f"'free({var})' not followed by '{var} = NULL;' — "
                    "dangling pointer can be reused (CWE-416)"
                ),
                "location": f"line {i + 1}",
            })
            break

    # 6. system() with a non-string-literal argument — command injection.
    system_pattern = re.compile(r"\bsystem\s*\(\s*(?!\"|NULL\b)(\w+)\s*\)")
    for m in system_pattern.finditer(content):
        smells.append({
            "type": "c_system_non_literal",
            "severity": "high",
            "message": (
                f"'system({m.group(1)})' with a non-literal argument — "
                "command injection (CWE-78); use execve with validated args"
            ),
            "location": f"offset {m.start()}",
        })

    return smells


def check_solid_violations(content: str) -> List[Dict]:
    """Check for potential SOLID principle violations."""
    violations = []

    # OCP: Type checking instead of polymorphism
    type_checks = len(re.findall(r"isinstance\(|type\(.*\)\s*==|typeof\s+\w+\s*===", content))
    if type_checks > 2:
        violations.append({
            "principle": "OCP",
            "name": "Open/Closed Principle",
            "severity": "medium",
            "message": f"Found {type_checks} type checks - consider using polymorphism"
        })

    # LSP/ISP: NotImplementedError
    not_impl = len(re.findall(r"raise\s+NotImplementedError|not\s+implemented", content, re.IGNORECASE))
    if not_impl:
        violations.append({
            "principle": "LSP/ISP",
            "name": "Liskov/Interface Segregation",
            "severity": "low",
            "message": f"Found {not_impl} unimplemented methods - may indicate oversized interface"
        })

    # DIP: Too many direct imports
    imports = len(re.findall(r"^(?:import|from)\s+", content, re.MULTILINE))
    if imports > THRESHOLDS["max_imports"]:
        violations.append({
            "principle": "DIP",
            "name": "Dependency Inversion Principle",
            "severity": "low",
            "message": f"File has {imports} imports - consider dependency injection"
        })

    return violations


def calculate_quality_score(
    line_metrics: Dict,
    functions: List[Dict],
    classes: List[Dict],
    smells: List[Dict],
    violations: List[Dict]
) -> int:
    """Calculate overall quality score (0-100)."""
    score = 100

    # Deduct for code smells
    for smell in smells:
        if smell["severity"] == "high":
            score -= 10
        elif smell["severity"] == "medium":
            score -= 5
        elif smell["severity"] == "low":
            score -= 2

    # Deduct for SOLID violations
    for violation in violations:
        if violation["severity"] == "high":
            score -= 8
        elif violation["severity"] == "medium":
            score -= 4
        elif violation["severity"] == "low":
            score -= 2

    # Bonus for good comment ratio (10-30%)
    if line_metrics["total"] > 0:
        comment_ratio = line_metrics["comment"] / line_metrics["total"]
        if 0.1 <= comment_ratio <= 0.3:
            score += 5

    # Bonus for reasonable function sizes
    if functions:
        avg_lines = sum(f["lines"] for f in functions) / len(functions)
        if avg_lines < 30:
            score += 5

    return max(0, min(100, score))


def get_grade(score: int) -> str:
    """Convert score to letter grade."""
    if score >= 90:
        return "A"
    elif score >= 80:
        return "B"
    elif score >= 70:
        return "C"
    elif score >= 60:
        return "D"
    else:
        return "F"


def display_path(path: Path) -> str:
    """The form a path takes in emitted output: relative to the working directory.

    Input is resolved to an absolute path so filesystem checks are unambiguous, but an
    absolute path in the *output* is machine-specific. That has two costs: committed
    fixtures under expected_outputs/ can only ever match the machine that produced them,
    and findings here cannot be matched against pr_analyzer.py's git-relative paths when
    review_report_generator.py merges both into one report.

    os.path.relpath rather than Path.relative_to: the latter raises ValueError for a
    target outside the working directory, which is a supported input here.
    """
    return os.path.relpath(str(path), os.getcwd())


def check_shell_specific_smells(content: str) -> List[Dict]:
    """Shell has real control flow, so it is analysed as code — but its failure modes are its own."""
    smells = []
    lines = content.split("\n")

    first_code = next((ln for ln in lines if ln.strip() and not ln.strip().startswith("#")), "")
    if lines and lines[0].startswith("#!") and "set -" not in content:
        smells.append({
            "type": "no_error_handling",
            "severity": "high",
            "message": "Script has no 'set -e'/'set -u'/'set -o pipefail' — a failing command is "
                       "silently ignored and the script continues with bad state",
            "location": "line 1",
        })

    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        # Unquoted expansion of a variable that may hold spaces or globs.
        if re.search(r"(?<![\"'\w])\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?![\"'\w])", stripped) and re.search(
            r"^\s*(?:rm|cp|mv|cat|source|\.|cd|mkdir|test|\[)\s", stripped
        ):
            if '"' not in stripped:
                smells.append({
                    "type": "unquoted_expansion",
                    "severity": "high",
                    "message": "Unquoted variable expansion in a command that acts on paths — a "
                               "value containing spaces or globs will not do what it looks like",
                    "location": f"line {i}",
                })
        if re.search(r"\bcd\s+[^&|;]+$", stripped) and "||" not in stripped and "set -e" not in content:
            smells.append({
                "type": "unchecked_cd",
                "severity": "medium",
                "message": "'cd' without '|| exit' or 'set -e' — the rest of the script runs in the "
                           "wrong directory if it fails",
                "location": f"line {i}",
            })

    return smells


def analyze_declarative(content: str, language: str) -> Dict:
    """
    Structural analysis for YAML and JSON.

    Reports parse validity, nesting depth, duplicate keys and plain-text secrets. Deliberately
    reports no cyclomatic complexity, no SOLID verdict and no function count: those readings do not
    exist for declarative data, and inventing them is exactly the false-confidence defect this
    coverage work removes.
    """
    smells = []
    lines = content.split("\n")

    parse_error = None
    if language == "json":
        try:
            json.loads(content)
        except ValueError as exc:
            parse_error = str(exc)
    else:
        seen_at_indent = {}
        for i, line in enumerate(lines, 1):
            match = re.match(r"^(\s*)([A-Za-z_][\w.-]*):", line)
            if not match:
                continue
            indent, key = len(match.group(1)), match.group(2)
            bucket = seen_at_indent.setdefault(indent, {})
            if key in bucket:
                smells.append({
                    "type": "duplicate_key",
                    "severity": "high",
                    "message": f"Key '{key}' is defined twice at the same level — the later value "
                               f"silently wins (first seen at line {bucket[key]})",
                    "location": f"line {i}",
                })
            else:
                bucket[key] = i

    if parse_error:
        smells.append({
            "type": "parse_error",
            "severity": "high",
            "message": f"File does not parse as {language}: {parse_error}",
            "location": "line 1",
        })

    max_depth = 0
    for line in lines:
        if not line.strip() or line.strip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        max_depth = max(max_depth, indent // 2)
    if max_depth > THRESHOLDS["max_declarative_depth"]:
        smells.append({
            "type": "deep_nesting",
            "severity": "medium",
            "message": f"Nesting reaches depth {max_depth} (threshold "
                       f"{THRESHOLDS['max_declarative_depth']}) — deeply nested config is hard to "
                       f"review and easy to mis-indent",
            "location": "file",
        })

    for i, line in enumerate(lines, 1):
        if re.search(r"(?i)\b(password|secret|token|api[_-]?key|private[_-]?key)\b\s*[:=]\s*['\"]?[^\s'\"{}$]{8,}", line):
            smells.append({
                "type": "plaintext_secret",
                "severity": "high",
                "message": "A credential-shaped key carries a literal value — secrets belong in a "
                           "secret store, not in a committed config file",
                "location": f"line {i}",
            })

    return {"smells": smells, "max_depth": max_depth, "parses": parse_error is None}


def analyze_file(filepath: Path) -> Dict:
    """Analyze a single file for code quality."""
    language = detect_language(filepath)
    if not language:
        return {"error": f"Unsupported file type: {filepath.suffix}"}

    content = read_file_content(filepath)
    if not content:
        return {"error": f"Could not read file: {filepath}"}

    if language in DECLARATIVE_LANGUAGES:
        line_metrics = count_lines(content)
        declarative = analyze_declarative(content, language)
        smells = declarative["smells"]
        # Scored on the same 100-point scale so a mixed change compares, but from structural
        # findings only — there is no complexity or SOLID term to include here.
        score = max(0, 100 - sum(
            15 if sm["severity"] == "high" else 8 if sm["severity"] == "medium" else 3
            for sm in smells
        ))
        return {
            "file": display_path(filepath),
            "language": language,
            "analysis_kind": "declarative",
            "metrics": {
                "lines": line_metrics,
                "max_depth": declarative["max_depth"],
                "parses": declarative["parses"],
            },
            "smells": smells,
            "solid_violations": [],
            "quality_score": score,
            "grade": get_grade(score),
        }

    line_metrics = count_lines(content)
    functions = find_functions(content, language)
    classes = find_classes(content, language)
    smells = check_code_smells(content, functions, classes)
    if language == "csharp":
        smells.extend(check_csharp_specific_smells(content))
    if language == "java":
        smells.extend(check_java_specific_smells(content))
    if language == "c":
        smells.extend(check_c_specific_smells(content))
    if language == "shell":
        smells.extend(check_shell_specific_smells(content))
    violations = check_solid_violations(content)
    score = calculate_quality_score(line_metrics, functions, classes, smells, violations)

    return {
        "file": display_path(filepath),
        "language": language,
        "metrics": {
            "lines": line_metrics,
            "functions": len(functions),
            "classes": len(classes),
            "avg_complexity": round(sum(f["complexity"] for f in functions) / max(1, len(functions)), 1)
        },
        "quality_score": score,
        "grade": get_grade(score),
        "smells": smells,
        "solid_violations": violations,
        "function_details": functions[:10],
        "class_details": classes[:10]
    }


def analyze_directory(
    dir_path: Path,
    recursive: bool = True,
    language: Optional[str] = None
) -> Dict:
    """
    Analyze all files in a directory, reporting what was NOT analysed as prominently as what was.

    This function used to enumerate only the extensions it recognised and then drop any per-file
    error before averaging (`if "error" not in result`). A change of nineteen OpenAPI files and two
    TypeScript files therefore reported "Files Analyzed: 2" with a score computed from the two, and
    the nineteen appeared nowhere. The skill's own Review Contract already forbids that — "a file
    the derivation includes but the review never opened is reported as not reviewed; it is never
    dropped from the list" — so this is the deterministic tool being made to obey a policy the
    bundle already publishes, not a new policy.

    Every file the walk sees ends up in exactly one of `files` or `skipped`. `coverage` is
    "complete" only when nothing was skipped.
    """
    results = []
    skipped = []

    pattern = "**/*" if recursive else "*"
    selected_extensions = set(LANGUAGE_EXTENSIONS.get(language, [])) if language else None

    for filepath in sorted(dir_path.glob(pattern)):
        if not filepath.is_file():
            continue
        parts = filepath.parts
        if "node_modules" in parts or ".git" in parts:
            continue

        detected = detect_language(filepath)
        if selected_extensions is not None and get_file_extension(filepath) not in selected_extensions:
            # An explicit --language narrowed the scope. Still reported: the caller chose it, but a
            # reader of the report did not, and a narrowed run that looks like a full one is the
            # same false confidence in a different costume.
            skipped.append({"file": display_path(filepath), "reason": f"excluded by --language {language}"})
            continue
        if not detected:
            skipped.append({
                "file": display_path(filepath),
                "reason": f"no analyser for '{filepath.suffix or filepath.name}'",
            })
            continue

        result = analyze_file(filepath)
        if "error" in result:
            skipped.append({"file": display_path(filepath), "reason": result["error"]})
            continue
        results.append(result)

    skipped_by_reason: Dict[str, int] = {}
    for item in skipped:
        skipped_by_reason[item["reason"]] = skipped_by_reason.get(item["reason"], 0) + 1

    base = {
        "directory": display_path(dir_path),
        "files_analyzed": len(results),
        "files_skipped": len(skipped),
        "coverage": "complete" if not skipped else "partial",
        "skipped": skipped,
        "skipped_by_reason": skipped_by_reason,
    }

    if not results:
        # Previously an error string, which discarded the skipped list with it — the caller was told
        # "No supported files found" and could not see WHICH files those were.
        return {
            **base,
            "average_score": None,
            "overall_grade": None,
            "total_code_smells": 0,
            "total_solid_violations": 0,
            "files": [],
        }

    total_score = sum(r["quality_score"] for r in results)
    avg_score = total_score / len(results)

    return {
        **base,
        "average_score": round(avg_score, 1),
        "overall_grade": get_grade(int(avg_score)),
        "total_code_smells": sum(len(r["smells"]) for r in results),
        "total_solid_violations": sum(len(r["solid_violations"]) for r in results),
        "files": sorted(results, key=lambda x: x["quality_score"]),
    }


def print_report(analysis: Dict) -> None:
    """Print human-readable analysis report."""
    if "error" in analysis:
        print(f"Error: {analysis['error']}")
        return

    print("=" * 60)
    print("CODE QUALITY REPORT")
    print("=" * 60)

    if "file" in analysis:
        print(f"\nFile: {analysis['file']}")
        print(f"Language: {analysis['language']}")
        print(f"Quality Score: {analysis['quality_score']}/100 ({analysis['grade']})")

        metrics = analysis["metrics"]
        print(f"\nLines: {metrics['lines']['total']} ({metrics['lines']['code']} code, {metrics['lines']['comment']} comments)")
        if analysis.get("analysis_kind") == "declarative":
            # No function, class or complexity line here on purpose: those readings do not exist for
            # declarative data, and printing a zero would read as "analysed and found none".
            print(f"Max nesting depth: {metrics['max_depth']}")
            print(f"Parses: {'yes' if metrics['parses'] else 'no'}")
            print("Analysed as declarative structure — complexity and SOLID do not apply.")
        else:
            print(f"Functions: {metrics['functions']}")
            print(f"Classes: {metrics['classes']}")
            print(f"Avg Complexity: {metrics['avg_complexity']}")

        if analysis["smells"]:
            print("\n--- CODE SMELLS ---")
            for smell in analysis["smells"][:10]:
                print(f"  [{smell['severity'].upper()}] {smell['message']} ({smell['location']})")

        if analysis["solid_violations"]:
            print("\n--- SOLID VIOLATIONS ---")
            for v in analysis["solid_violations"]:
                print(f"  [{v['principle']}] {v['message']}")
    else:
        print(f"\nDirectory: {analysis['directory']}")
        print(f"Files Analyzed: {analysis['files_analyzed']}")
        print(f"Files Skipped:  {analysis['files_skipped']}")
        if analysis["average_score"] is None:
            print("Average Score: n/a — nothing in this directory was analysed")
        else:
            print(f"Average Score: {analysis['average_score']}/100 ({analysis['overall_grade']})"
                  f" — over the {analysis['files_analyzed']} analysed file(s) only")
        print(f"Total Code Smells: {analysis['total_code_smells']}")
        print(f"Total SOLID Violations: {analysis['total_solid_violations']}")

        # The coverage line comes before the findings, not after: a reader who stops at the score
        # must already have been told what the score does not cover.
        if analysis["coverage"] == "partial":
            print(f"\n*** COVERAGE: PARTIAL — {analysis['files_skipped']} file(s) were not analysed. ***")
            print("*** This verdict describes the analysed files only, not the whole change.   ***")
        else:
            print("\nCoverage: complete — every file in scope was analysed.")

        if analysis["files"]:
            print("\n--- FILES BY QUALITY ---")
            for f in analysis["files"][:10]:
                print(f"  {f['quality_score']:3d}/100 [{f['grade']}] {f['file']}")

        if analysis["skipped"]:
            print("\n--- SKIPPED (not analysed) ---")
            for reason, count in sorted(analysis["skipped_by_reason"].items(), key=lambda kv: -kv[1]):
                print(f"  {count:3d} x {reason}")
            for item in analysis["skipped"][:20]:
                print(f"      {item['file']} — {item['reason']}")
            if len(analysis["skipped"]) > 20:
                print(f"      ... and {len(analysis['skipped']) - 20} more (use --json for the full list)")

    print("\n" + "=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Analyze code quality, smells, and SOLID violations"
    )
    parser.add_argument(
        "path",
        help="File or directory to analyze"
    )
    parser.add_argument(
        "--recursive", "-r",
        action="store_true",
        default=True,
        help="Recursively analyze directories (default: true)"
    )
    parser.add_argument(
        "--language", "-l",
        choices=list(LANGUAGE_EXTENSIONS.keys()),
        help="Filter by programming language"
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
        analysis = analyze_file(target)
    else:
        analysis = analyze_directory(target, args.recursive, args.language)

    if args.json:
        output = json.dumps(analysis, indent=2, default=str)
        if args.output:
            with open(args.output, "w") as f:
                f.write(output)
            print(f"Results written to {args.output}")
        else:
            print(output)
    else:
        print_report(analysis)


if __name__ == "__main__":
    main()

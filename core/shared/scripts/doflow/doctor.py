#!/usr/bin/env python3
"""
DoFlow Cross-Client Diagnostic Health Auditor
Validates binaries, plugin manifests, guidance sync, and tool readiness across Claude Code, OpenAI Codex, and Antigravity.
"""

import sys
import subprocess
import json
from pathlib import Path

def get_repo_root():
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / ".git").exists() or (parent / "core" / "registry").exists():
            return parent
    return Path.cwd()

def run_doctor():
    repo_root = get_repo_root()
    doflow_bin = repo_root / "bin" / "doflow.js"

    if doflow_bin.exists():
        res = subprocess.run(["node", str(doflow_bin), "doctor"], cwd=str(repo_root))
        return res.returncode
    else:
        print("Error: bin/doflow.js not found", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(run_doctor())

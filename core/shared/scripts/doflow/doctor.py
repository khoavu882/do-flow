#!/usr/bin/env python3
"""
DoFlow Cross-Client Diagnostic Health Auditor
Validates binaries, plugin manifests, guidance sync, and tool readiness across Claude Code, OpenAI Codex, and Antigravity.
"""

import sys
import subprocess
import json
from pathlib import Path

import shutil

def get_target_project():
    current = Path.cwd().resolve()
    for parent in [current] + list(current.parents):
        if (parent / ".git").exists() or (parent / ".doflow").exists():
            return parent
    return current

def run_doctor():
    target = get_target_project()
    # 1. Check if doflow is on PATH
    doflow_path = shutil.which("doflow")
    if doflow_path:
        res = subprocess.run([doflow_path, "doctor", str(target)])
        return res.returncode

    # 2. Check development repo bin/doflow.js
    current = Path(__file__).resolve()
    for parent in [current] + list(current.parents):
        doflow_bin = parent / "bin" / "doflow.js"
        if doflow_bin.exists():
            res = subprocess.run(["node", str(doflow_bin), "doctor", str(target)])
            return res.returncode

    print("Error: 'doflow' command not found on PATH and bin/doflow.js not found.", file=sys.stderr)
    return 1

if __name__ == "__main__":
    sys.exit(run_doctor())

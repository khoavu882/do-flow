#!/usr/bin/env python3
"""
DoFlow Deterministic Verification Contract Runner
Executes multi-stage verification checks ordered from cheapest/deterministic to most expensive:
Syntax -> Compile -> Types -> Lint -> Unit Tests -> Integration Tests -> Architecture -> Scope Diffs.
"""

import sys
import os
import json
import subprocess
from typing import Dict, Any, List, Optional
from pathlib import Path
from datetime import datetime, timezone

class VerificationContractRunner:
    def __init__(self, cwd: Optional[Path] = None):
        self.cwd = cwd or Path.cwd()

    def run_check(self, name: str, command: str, timeout: int = 60) -> Dict[str, Any]:
        """Execute a single deterministic shell check."""
        try:
            res = subprocess.run(
                command,
                shell=True,
                cwd=str(self.cwd),
                capture_output=True,
                text=True,
                timeout=timeout
            )
            passed = (res.returncode == 0)
            return {
                "name": name,
                "command": command,
                "status": "PASS" if passed else "FAIL",
                "exitCode": res.returncode,
                "stdout": res.stdout[:2000],
                "stderr": res.stderr[:2000]
            }
        except subprocess.TimeoutExpired:
            return {
                "name": name,
                "command": command,
                "status": "FAIL",
                "exitCode": 124,
                "error": "TimeoutExpired"
            }
        except Exception as e:
            return {
                "name": name,
                "command": command,
                "status": "FAIL",
                "exitCode": 1,
                "error": str(e)
            }

    def evaluate_contract(self, checks: List[Dict[str, str]]) -> Dict[str, Any]:
        """Runs ordered checks and compiles a VerificationReport."""
        results = []
        overall_status = "PASS"
        failed_checks = []

        for chk in checks:
            name = chk.get("name", "unnamed_check")
            cmd = chk.get("command", "true")
            res = self.run_check(name, cmd)
            results.append(res)

            if res["status"] == "FAIL":
                overall_status = "FAIL"
                failed_checks.append(name)
                # Short-circuit on fatal compile or syntax failures
                if any(fatal in name.lower() for fatal in ["syntax", "compile", "build"]):
                    break

        return {
            "status": overall_status,
            "checks": results,
            "failedChecks": failed_checks,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        runner = VerificationContractRunner()
        report = runner.evaluate_contract([
            {"name": "syntax_check", "command": "python3 -m py_compile core/shared/scripts/doflow/compiler.py"},
            {"name": "true_check", "command": "true"}
        ])
        print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
DoFlow Failure Classifier & Recovery Manager
Categorizes runtime execution and verification failures into 11 discrete classes:
CONTEXT_MISSING, WRONG_IMPLEMENTATION, TEST_FAILURE, BUILD_FAILURE, ARCHITECTURE_FAILURE,
REQUIREMENT_FAILURE, ENVIRONMENT_FAILURE, TOOL_FAILURE, AGENT_FAILURE, BUDGET_EXCEEDED, UNKNOWN_FAILURE.
Enforces bounded retry policies (max 3 iterations).
"""

from typing import Dict, Any, List, Optional

FAILURE_CLASSES = [
    "CONTEXT_MISSING",
    "WRONG_IMPLEMENTATION",
    "TEST_FAILURE",
    "BUILD_FAILURE",
    "ARCHITECTURE_FAILURE",
    "REQUIREMENT_FAILURE",
    "ENVIRONMENT_FAILURE",
    "TOOL_FAILURE",
    "AGENT_FAILURE",
    "BUDGET_EXCEEDED",
    "UNKNOWN_FAILURE"
]

class RecoveryManager:
    def __init__(self, max_iterations: int = 3):
        self.max_iterations = max_iterations

    def classify_failure(self, error_message: str, failed_checks: List[str] = None) -> str:
        """Classify a failure into one of 11 discrete failure classes."""
        failed_checks = failed_checks or []
        msg = error_message.lower()

        if any("syntax" in chk.lower() or "compile" in chk.lower() or "build" in chk.lower() for chk in failed_checks) or "build error" in msg:
            return "BUILD_FAILURE"
        elif any("test" in chk.lower() or "unit" in chk.lower() for chk in failed_checks) or "test failed" in msg or "assertionerror" in msg:
            return "TEST_FAILURE"
        elif "budget" in msg or "token limit" in msg:
            return "BUDGET_EXCEEDED"
        elif "missing file" in msg or "cannot find module" in msg or "not found" in msg:
            return "CONTEXT_MISSING"
        elif "timeout" in msg or "connection refused" in msg or "econnrefused" in msg:
            return "ENVIRONMENT_FAILURE"
        elif "tool error" in msg or "mcp error" in msg:
            return "TOOL_FAILURE"
        elif "architecture" in msg or "boundary" in msg:
            return "ARCHITECTURE_FAILURE"
        elif "requirement" in msg or "acceptance criterion" in msg:
            return "REQUIREMENT_FAILURE"
        elif "agent" in msg or "hallucination" in msg:
            return "AGENT_FAILURE"
        elif failed_checks:
            return "WRONG_IMPLEMENTATION"
        return "UNKNOWN_FAILURE"

    def plan_recovery(self, failure_class: str, current_iteration: int, last_agent: str = "codex") -> Dict[str, Any]:
        """Determine next recovery action and whether to switch agents."""
        if current_iteration >= self.max_iterations:
            return {
                "action": "ABORT",
                "reason": f"Maximum retry iterations ({self.max_iterations}) exceeded.",
                "switchAgent": False
            }

        strategy_map = {
            "CONTEXT_MISSING": {
                "action": "RETRIEVE_MORE_CONTEXT",
                "targetRole": "SCOUT",
                "switchAgent": False
            },
            "BUILD_FAILURE": {
                "action": "TARGETED_COMPILER_FIX",
                "targetRole": "DEBUGGER",
                "switchAgent": (current_iteration >= 2)
            },
            "TEST_FAILURE": {
                "action": "TARGETED_DEBUGGER_FIX",
                "targetRole": "DEBUGGER",
                "switchAgent": (current_iteration >= 2)
            },
            "ARCHITECTURE_FAILURE": {
                "action": "GRAPH_RE_EVALUATION",
                "targetRole": "PLANNER",
                "switchAgent": True
            },
            "REQUIREMENT_FAILURE": {
                "action": "SPEC_RECONCILIATION",
                "targetRole": "PLANNER",
                "switchAgent": True
            },
            "ENVIRONMENT_FAILURE": {
                "action": "ENVIRONMENT_DIAGNOSTIC",
                "targetRole": "VERIFIER",
                "switchAgent": False
            }
        }

        strategy = strategy_map.get(failure_class, {
            "action": "GENERIC_DEBUGGER_FIX",
            "targetRole": "DEBUGGER",
            "switchAgent": (current_iteration >= 2)
        })

        recommended_agent = last_agent
        if strategy["switchAgent"]:
            recommended_agent = "claude" if last_agent == "codex" else "codex"

        return {
            "iteration": current_iteration + 1,
            "failureClass": failure_class,
            "action": strategy["action"],
            "targetRole": strategy["targetRole"],
            "agent": recommended_agent,
            "canRetry": True
        }

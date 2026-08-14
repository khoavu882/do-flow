#!/usr/bin/env python3
"""
DoFlow Context Router & Retrieval Planner
Determines retrieval requirements based on task intent and enforces bounded token budgets.
"""

from typing import Dict, Any, List

class ContextRouter:
    def __init__(self, default_token_budget: int = 8000):
        self.default_token_budget = default_token_budget

    def classify_task(self, title: str, description: str) -> Dict[str, Any]:
        """Classify task type, risk level, and intent."""
        text = f"{title} {description}".lower()
        
        task_type = "IMPLEMENT"
        if any(k in text for k in ["bug", "fix", "error", "fail", "regression", "crash"]):
            task_type = "DEBUG"
        elif any(k in text for k in ["explore", "investigate", "where", "find", "research"]):
            task_type = "EXPLORE"
        elif any(k in text for k in ["refactor", "clean", "simplify", "reorganize"]):
            task_type = "REFACTOR"
        elif any(k in text for k in ["review", "audit", "security"]):
            task_type = "REVIEW"
        elif any(k in text for k in ["test", "coverage", "benchmark"]):
            task_type = "TEST"
        elif any(k in text for k in ["architect", "design", "system"]):
            task_type = "ARCHITECTURE"

        risk = "LOW"
        if any(k in text for k in ["security", "auth", "payment", "crypto", "database", "migration"]):
            risk = "HIGH"
        elif any(k in text for k in ["critical", "production", "breaking", "data loss"]):
            risk = "CRITICAL"
        elif task_type in ["IMPLEMENT", "REFACTOR"]:
            risk = "MEDIUM"

        return {
            "type": task_type,
            "risk": risk
        }

    def build_retrieval_plan(self, task_type: str, query: str) -> Dict[str, Any]:
        """Generate targeted retrieval plan based on classified task type."""
        queries = []

        if task_type == "DEBUG":
            queries.append({"provider": "graphify", "purpose": "dependency-path", "query": query})
            queries.append({"provider": "semble", "purpose": "implementation-search", "query": query})
            queries.append({"provider": "git", "purpose": "recent-changes", "query": query})
            queries.append({"provider": "tests", "purpose": "behavioral-contract", "query": query})
        elif task_type in ["EXPLORE", "ARCHITECTURE"]:
            queries.append({"provider": "semble", "purpose": "concept-search", "query": query})
            queries.append({"provider": "graphify", "purpose": "architecture-topology", "query": query})
        elif task_type in ["IMPLEMENT", "REFACTOR"]:
            queries.append({"provider": "semble", "purpose": "implementation-search", "query": query})
            queries.append({"provider": "graphify", "purpose": "caller-callee-graph", "query": query})
            queries.append({"provider": "tests", "purpose": "existing-test-cases", "query": query})
        else: # REVIEW / TEST
            queries.append({"provider": "git", "purpose": "diff-history", "query": query})
            queries.append({"provider": "graphify", "purpose": "blast-radius", "query": query})

        return {
            "intent": task_type,
            "queries": queries,
            "tokenBudget": self.default_token_budget,
            "maximumEvidenceItems": 30
        }

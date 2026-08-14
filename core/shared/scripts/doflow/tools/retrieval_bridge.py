#!/usr/bin/env python3
"""
DoFlow Retrieval Bridge
Connects coding agent harnesses to external intelligence and retrieval tools:
Semble (semantic search), Graphify (knowledge graph / call-trees), Git (history), and RTK (token compression).
"""

import sys
import os
import json
import shutil
import subprocess
import argparse
from pathlib import Path
from typing import Dict, Any, List, Optional

def get_repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / ".git").exists() or (parent / "core" / "registry").exists():
            return parent
    return Path.cwd()

def is_tool_available(binary: str) -> bool:
    return shutil.which(binary) is not None

def run_command(cmd: List[str], cwd: Optional[Path] = None, timeout: int = 30) -> Optional[str]:
    try:
        res = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        if res.returncode == 0:
            return res.stdout.strip()
        return None
    except Exception:
        return None

class RetrievalBridge:
    def __init__(self, repo_root: Optional[Path] = None):
        self.repo_root = repo_root or get_repo_root()

    def query_semantic(self, query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """Semantic search via Semble, fallback to rg regex search."""
        evidence = []
        if is_tool_available("semble"):
            output = run_command(["semble", "search", query, str(self.repo_root), "--top-k", str(top_k)])
            if output:
                evidence.append({
                    "source": "SEMBLE",
                    "content": output,
                    "provenance": {
                        "type": "DIRECT",
                        "provider": "semble.search",
                        "method": "semantic-embeddings"
                    },
                    "reliability": 0.95,
                    "relevance": 0.90
                })
                return evidence

        # Fallback to ripgrep exact search
        if is_tool_available("rg"):
            first_term = query.split()[0] if query else ""
            if first_term:
                output = run_command(["rg", "-n", first_term, str(self.repo_root), "--max-count", "10"])
                if output:
                    evidence.append({
                        "source": "FILESYSTEM",
                        "content": output,
                        "provenance": {
                            "type": "EXTRACTED",
                            "provider": "native.rg",
                            "method": "regex-fallback"
                        },
                        "reliability": 0.85,
                        "relevance": 0.70
                    })
        return evidence

    def query_graph(self, symbol: str) -> List[Dict[str, Any]]:
        """Call graph and impact analysis via Graphify."""
        evidence = []
        if is_tool_available("graphify"):
            output = run_command(["graphify", "query", symbol, str(self.repo_root)])
            if output:
                evidence.append({
                    "source": "GRAPHIFY",
                    "content": output,
                    "provenance": {
                        "type": "EXTRACTED",
                        "provider": "graphify.query",
                        "method": "ast-call-graph"
                    },
                    "reliability": 0.95,
                    "relevance": 0.95
                })
                return evidence

        # Fallback to ripgrep symbol references
        if is_tool_available("rg"):
            output = run_command(["rg", "-n", symbol, str(self.repo_root)])
            if output:
                evidence.append({
                    "source": "FILESYSTEM",
                    "content": output,
                    "provenance": {
                        "type": "INFERRED",
                        "provider": "native.rg",
                        "method": "text-occurrences"
                    },
                    "reliability": 0.75,
                    "relevance": 0.65
                })
        return evidence

    def query_history(self, path: str, max_count: int = 5) -> List[Dict[str, Any]]:
        """Git commit history and blame."""
        evidence = []
        if is_tool_available("git"):
            output = run_command(["git", "log", f"-n{max_count}", "--oneline", "--", path], cwd=self.repo_root)
            if output:
                evidence.append({
                    "source": "GIT",
                    "content": output,
                    "provenance": {
                        "type": "DIRECT",
                        "provider": "git.native",
                        "method": "log"
                    },
                    "reliability": 1.0,
                    "relevance": 0.85
                })
        return evidence

def main():
    parser = argparse.ArgumentParser(description="DoFlow Retrieval Bridge")
    parser.add_argument("--type", choices=["semantic", "graph", "history"], required=True)
    parser.add_argument("--query", required=True, help="Query string or symbol identifier")
    parser.add_argument("--json", action="store_true", help="Output JSON formatted evidence")
    args = parser.parse_args()

    bridge = RetrievalBridge()
    if args.type == "semantic":
        results = bridge.query_semantic(args.query)
    elif args.type == "graph":
        results = bridge.query_graph(args.query)
    else:
        results = bridge.query_history(args.query)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        for r in results:
            print(f"[{r['source']}] {r['provenance']['provider']} (reliability: {r['reliability']})")
            print(r['content'])
            print("-" * 40)

if __name__ == "__main__":
    main()

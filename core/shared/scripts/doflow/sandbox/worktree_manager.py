#!/usr/bin/env python3
"""
DoFlow Worktree Sandbox Manager
Manages ephemeral Git worktrees for isolated task execution.
"""

import sys
import subprocess
import shutil
from pathlib import Path
from typing import Optional, Dict, Any

class WorktreeManager:
    def __init__(self, repo_root: Path):
        self.repo_root = repo_root
        self.worktrees_dir = repo_root / ".doflow" / "worktrees"

    def create_worktree(self, task_id: str, base_branch: str = "HEAD") -> Path:
        """Create an isolated worktree for a task."""
        self.worktrees_dir.mkdir(parents=True, exist_ok=True)
        wt_path = self.worktrees_dir / task_id
        
        if wt_path.exists():
            return wt_path

        cmd = ["git", "worktree", "add", "-b", f"task/{task_id}", str(wt_path), base_branch]
        subprocess.run(cmd, cwd=str(self.repo_root), check=True, capture_output=True)
        return wt_path

    def remove_worktree(self, task_id: str):
        """Remove worktree cleanly."""
        wt_path = self.worktrees_dir / task_id
        if wt_path.exists():
            subprocess.run(["git", "worktree", "remove", "--force", str(wt_path)], cwd=str(self.repo_root), capture_output=True)
            if wt_path.exists():
                shutil.rmtree(wt_path, ignore_errors=True)

    def collect_diff(self, task_id: str) -> Optional[str]:
        """Collect uncommitted or committed diff from the task worktree."""
        wt_path = self.worktrees_dir / task_id
        if not wt_path.exists():
            return None
        res = subprocess.run(["git", "diff", "HEAD~1"], cwd=str(wt_path), capture_output=True, text=True)
        if res.returncode == 0:
            return res.stdout
        return None

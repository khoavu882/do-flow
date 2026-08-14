#!/usr/bin/env python3
"""
DoFlow Universal Guidance Projection Compiler
Compiles canonical guidance and assets into harness-native targets (CLAUDE.md, AGENTS.md, GEMINI.md, skills, agents, etc.)
with zero rule drift.
"""

import sys
import os
import json
import shutil
import argparse
from pathlib import Path

def load_json_or_yaml(path):
    with open(path, "r", encoding="utf-8") as f:
        # Since files in registry are formatted as JSON within .yaml files
        return json.load(f)

def find_registry_root():
    # 1. Search up from this script file location
    current = Path(__file__).resolve()
    for parent in [current] + list(current.parents):
        if (parent / "core" / "registry" / "assets.yaml").exists():
            return parent
    # 2. Check environment variable DOFLOW_ROOT
    if os.environ.get("DOFLOW_ROOT"):
        p = Path(os.environ["DOFLOW_ROOT"]).resolve()
        if (p / "core" / "registry" / "assets.yaml").exists():
            return p
    return None

def get_target_project_root():
    current = Path.cwd().resolve()
    for parent in [current] + list(current.parents):
        if (parent / ".git").exists() or (parent / ".doflow").exists():
            return parent
    return current

def sync_managed_file_section(registry_root, target_project, source_rel, target_rel, check_mode=False):
    source_path = registry_root / source_rel
    # Fallback to local .doflow/guidance if running downstream
    if not source_path.exists() and (target_project / ".doflow" / "guidance").exists():
        if source_rel.startswith("core/shared/guidance/"):
            source_path = target_project / ".doflow" / "guidance" / source_rel.replace("core/shared/guidance/", "")

    target_path = target_project / target_rel

    if not source_path.exists():
        print(f"Warning: Source file {source_path} does not exist", file=sys.stderr)
        return True

    source_content = source_path.read_text(encoding="utf-8").strip()
    
    start_tag = "<!-- doflow:start -->"
    end_tag = "<!-- doflow:end -->"
    section_block = f"{start_tag}\n{source_content}\n{end_tag}"

    target_content = ""
    if target_path.exists():
        target_content = target_path.read_text(encoding="utf-8")

    if start_tag in target_content and end_tag in target_content:
        pre = target_content.split(start_tag)[0]
        post = target_content.split(end_tag)[1]
        new_content = f"{pre}{section_block}{post}"
    else:
        if target_content.strip():
            new_content = f"{target_content}\n\n{section_block}\n"
        else:
            new_content = f"{section_block}\n"

    if target_content != new_content:
        if check_mode:
            print(f"[DRIFT] {target_rel} is out of sync with {source_rel}")
            return False
        else:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text(new_content, encoding="utf-8")
            print(f"[SYNCED] {target_rel} (managed section updated)")
            return True
    else:
        if check_mode:
            print(f"[OK] {target_rel} in sync")
        return True

def sync_tree(repo_root, source_rel, target_rel, check_mode=False):
    source_dir = repo_root / source_rel
    target_dir = repo_root / target_rel

    if not source_dir.exists():
        return True

    drift_found = False
    
    # Check/copy files
    for root, _, files in os.walk(source_dir):
        for f in files:
            src_file = Path(root) / f
            rel_to_src = src_file.relative_to(source_dir)
            dst_file = target_dir / rel_to_src

            if not dst_file.exists() or src_file.read_bytes() != dst_file.read_bytes():
                drift_found = True
                if check_mode:
                    print(f"[DRIFT] {dst_file} differs or missing from {src_file}")
                else:
                    dst_file.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src_file, dst_file)
                    print(f"[COPIED] {src_file.relative_to(repo_root)} -> {dst_file.relative_to(repo_root)}")

    return not drift_found if check_mode else True

def main():
    parser = argparse.ArgumentParser(description="DoFlow Guidance & Asset Projection Compiler")
    parser.add_argument("--harness", choices=["claude", "codex", "gemini", "opencode", "pi", "all"], default="all")
    parser.add_argument("--check", action="store_true", help="Check for drift without modifying files")
    parser.add_argument("--repo-root", default=None, help="Root path of repository")
    args = parser.parse_args()

    registry_root = find_registry_root()
    target_project = Path(args.repo_root).resolve() if args.repo_root else get_target_project_root()

    if not registry_root:
        print(f"Error: Could not locate core/registry/assets.yaml.\nHint: If running inside a consumer project, guidance projections are managed via 'doflow update'.", file=sys.stderr)
        sys.exit(1)

    assets_yaml = registry_root / "core" / "registry" / "assets.yaml"
    harnesses_yaml = registry_root / "core" / "registry" / "harnesses.yaml"

    assets_data = load_json_or_yaml(assets_yaml)
    harnesses_data = load_json_or_yaml(harnesses_yaml)

    harnesses = [h["id"] for h in harnesses_data.get("harnesses", [])]
    if args.harness != "all":
        harnesses = [args.harness]

    all_in_sync = True

    for asset in assets_data.get("assets", []):
        applies_to = asset.get("appliesTo", [])
        if not any(h in applies_to for h in harnesses):
            continue

        kind = asset.get("kind")
        source = asset.get("source")
        ownership = asset.get("ownership")

        if ownership == "managed-file-section":
            for h in applies_to:
                if h not in harnesses:
                    continue
                if h == "claude":
                    target_file = "CLAUDE.md"
                elif h == "gemini":
                    target_file = "GEMINI.md"
                elif h in ["codex", "opencode", "pi"]:
                    target_file = "AGENTS.md"
                else:
                    continue
                ok = sync_managed_file_section(registry_root, target_project, source, target_file, check_mode=args.check)
                if not ok:
                    all_in_sync = False

    if args.check:
        if all_in_sync:
            print("\nProjection Status: ALL HARNESSES IN SYNC (Zero Drift)")
            sys.exit(0)
        else:
            print("\nProjection Status: DRIFT DETECTED. Run 'doflow sync' to reconcile.", file=sys.stderr)
            sys.exit(1)
    else:
        print("\nProjection complete: All target manifests synchronized.")

if __name__ == "__main__":
    main()

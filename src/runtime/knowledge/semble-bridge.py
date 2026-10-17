"""Semble 0.7.0 public API adapter. One bounded JSON request per process.

The audit policy denies network and child processes even on model loader retry paths.
It also confines Python writes to the invocation's declared project-local cache/staging.
No library function or private provider implementation is patched.
"""
import importlib.metadata
import json
import math
import os
import platform
from pathlib import Path
import sys

VERSION = "0.7.0"  # must equal SEMBLE_VERSION in semble-provider.ts (tested)
RUNTIME_PACKAGES = ("numpy", "model2vec", "tokenizers", "huggingface-hub", "safetensors", "vicinity")


def runtime_identity():
    packages = {}
    for name in RUNTIME_PACKAGES:
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimeError("provider-runtime-dependency-missing") from error
    return {"python": platform.python_version(), "implementation": platform.python_implementation(),
            "platform": platform.platform(), "machine": platform.machine(), "packages": packages}


def install_policy(roots):
    roots = tuple(Path(root).resolve(strict=True) for root in roots)

    def permitted(value):
        if isinstance(value, int):
            return True  # already opened standard output/error descriptors
        candidate = Path(os.fsdecode(value)).resolve()
        return any(candidate == root or root in candidate.parents for root in roots)

    def audit(event, args):
        if event.startswith("socket.") or event in ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.fork"):
            raise PermissionError("provider-network-or-subprocess-denied")
        if event == "open":
            file, mode, flags = args
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            if writing and not permitted(file):
                raise PermissionError("provider-write-outside-state")
        if event in ("os.mkdir", "os.remove", "os.rmdir", "os.chmod", "os.utime", "os.truncate") and not permitted(args[0]):
            raise PermissionError("provider-write-outside-state")
        if event in ("os.rename", "os.link", "os.symlink"):
            if not permitted(args[0]) or not permitted(args[1]) or event != "os.rename":
                raise PermissionError("provider-unsafe-mutation")
    sys.addaudithook(audit)


def run(request):
    install_policy(request["allowedWriteRoots"])
    try:
        found = importlib.metadata.version("semble")
    except importlib.metadata.PackageNotFoundError:
        return {"ok": False, "reason": "provider-unavailable", "cause": f"semble is not installed for {sys.executable}"}
    if found != VERSION:
        return {"ok": False, "reason": "provider-version-mismatch", "cause": f"{sys.executable} has semble {found[:32]}; the bridge pins {VERSION}"}
    from semble.index import SembleIndex
    from semble.types import ContentType
    if request["action"] == "query":
        index = SembleIndex.load_from_disk(Path(request["indexPath"]))
        count = request["poolSize"]
        if index.stats.total_chunks != count:
            raise ValueError("persisted chunk count changed")
        results = index.search(request["query"], top_k=200, alpha=1.0, rerank=False)
        candidates = []
        for result in results:
            chunk = result.chunk
            score = float(result.score)
            if not math.isfinite(score):
                raise ValueError("nonfinite score")
            candidates.append({"locator": {"file": chunk.file_path, "line": chunk.start_line, "endLine": chunk.end_line}, "score": score})
        # Public scores are provider-native distinct ranks; sorting them cannot
        # recover dense ties hidden inside Semble. Preserve the returned order.
        return {"ok": True, "candidates": candidates, "poolSize": count}
    if request["action"] not in ("build", "refresh"):
        raise ValueError("invalid action")
    index = SembleIndex.from_path(Path(request["mirror"]), model_path=request["modelPath"], content=(ContentType.CODE,), show_progress_bar=False)
    index.save(Path(request["savePath"]))
    return {"ok": True}


def main():
    try:
        request = json.loads(sys.stdin.buffer.read(2097153))
        result = run(request)
    except importlib.metadata.PackageNotFoundError:
        result = {"ok": False, "reason": "provider-unavailable"}
    except (ImportError, AttributeError):
        result = {"ok": False, "reason": "provider-api-unavailable"}
    except Exception:
        # Provider exception text may contain source/query data. Return only a fixed cause.
        result = {"ok": False, "reason": "provider-load-or-operation-error"}
    if result.get("ok"):
        result["runtimeIdentity"] = runtime_identity()
    result["version"] = VERSION
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()

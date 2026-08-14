"""
DoFlow Evidence Normalizer & Deduper
Converts diverse provider outputs into standardized Evidence records with confidence weighting and deduplication.
"""

from typing import List, Dict, Any
import hashlib
from datetime import datetime, timezone

class EvidenceNormalizer:
    def __init__(self):
        self.seen_hashes = set()

    def normalize(self, raw_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized = []
        for idx, item in enumerate(raw_items):
            content = item.get("content", "").strip()
            if not content:
                continue

            content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
            if content_hash in self.seen_hashes:
                continue
            self.seen_hashes.add(content_hash)

            evidence_id = f"EV-{idx+1:03d}"
            normalized.append({
                "id": evidence_id,
                "source": item.get("source", "FILESYSTEM"),
                "content": content,
                "provenance": item.get("provenance", {
                    "type": "DIRECT",
                    "provider": "unknown",
                    "method": "direct"
                }),
                "relevance": float(item.get("relevance", 0.8)),
                "reliability": float(item.get("reliability", 0.9)),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "supports": [],
                "contradicts": []
            })
        return normalized

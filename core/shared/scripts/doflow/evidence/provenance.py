"""
DoFlow Provenance Tracking
Tracks whether evidence was DIRECT, EXTRACTED, INFERRED, or GENERATED.
"""

from typing import Dict, Any, Optional

class ProvenanceTracker:
    @staticmethod
    def tag_provenance(provider: str, prov_type: str = "DIRECT", method: Optional[str] = None) -> Dict[str, Any]:
        return {
            "type": prov_type,
            "provider": provider,
            "method": method or "default"
        }

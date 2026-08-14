"""
DoFlow Claim Builder
Synthesizes Evidence into explicit Claims marked as SUPPORTED, CONFLICTED, or UNKNOWN.
"""

from typing import List, Dict, Any

class ClaimBuilder:
    def build_claim(self, claim_id: str, text: str, support_evidence: List[str], contradict_evidence: List[str] = None) -> Dict[str, Any]:
        contradict_evidence = contradict_evidence or []
        
        status = "UNKNOWN"
        confidence = 0.0
        if support_evidence and contradict_evidence:
            status = "CONFLICTED"
            confidence = 0.5
        elif support_evidence:
            status = "SUPPORTED"
            confidence = 0.95
        elif contradict_evidence:
            status = "REJECTED"
            confidence = 0.95

        return {
            "id": claim_id,
            "text": text,
            "status": status,
            "supportEvidenceIds": support_evidence,
            "contradictoryEvidenceIds": contradict_evidence,
            "confidence": confidence
        }

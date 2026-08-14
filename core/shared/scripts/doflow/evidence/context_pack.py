"""
DoFlow ContextPack Assembler
Packages normalized Evidence, Claims, Constraints, and Verification requirements into a bounded payload.
"""

from typing import List, Dict, Any

class ContextPackAssembler:
    def assemble(self, task: Dict[str, Any], evidence: List[Dict[str, Any]], claims: List[Dict[str, Any]], token_budget: int = 8000) -> Dict[str, Any]:
        direct = [e for e in evidence if e.get("provenance", {}).get("type") == "DIRECT"]
        extracted = [e for e in evidence if e.get("provenance", {}).get("type") == "EXTRACTED"]
        
        supported = [c for c in claims if c.get("status") == "SUPPORTED"]
        conflicts = [c for c in claims if c.get("status") == "CONFLICTED"]
        unknowns = [c for c in claims if c.get("status") == "UNKNOWN"]

        return {
            "task": task,
            "constraints": task.get("constraints", []),
            "claims": supported,
            "directEvidence": direct,
            "structuralEvidence": extracted,
            "conflicts": conflicts,
            "unknowns": unknowns,
            "verificationRequirements": task.get("acceptanceCriteria", []),
            "tokenBudget": token_budget
        }

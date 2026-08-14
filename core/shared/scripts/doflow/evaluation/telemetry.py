#!/usr/bin/env python3
"""
DoFlow Telemetry & Execution Trajectory Recorder
Captures structured task spans, token consumption, latencies, and OpenTelemetry-compatible trace attributes.
"""

import sys
import json
import time
from typing import Dict, Any, List
from datetime import datetime, timezone

class TaskRunTelemetry:
    def __init__(self, task_id: str, agent: str = "codex", model: str = "default"):
        self.task_id = task_id
        self.agent = agent
        self.model = model
        self.start_time = time.time()
        self.events: List[Dict[str, Any]] = []

    def record_event(self, event_type: str, details: Dict[str, Any]):
        self.events.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": event_type,
            "details": details
        })

    def export_trace(self, success: bool, input_tokens: int = 0, output_tokens: int = 0) -> Dict[str, Any]:
        duration_ms = int((time.time() - self.start_time) * 1000)
        return {
            "taskId": self.task_id,
            "agent": self.agent,
            "model": self.model,
            "success": success,
            "durationMs": duration_ms,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "estimatedCostUsd": round((input_tokens * 0.000003) + (output_tokens * 0.000015), 6),
            "eventCount": len(self.events),
            "events": self.events
        }

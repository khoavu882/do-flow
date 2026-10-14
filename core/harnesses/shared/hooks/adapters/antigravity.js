'use strict';

/**
 * Antigravity native decision renderer for the Cross-Harness Hook Runner's
 * Decision Adapter seam, D2). The shared bridge owns native payload decoding.
 *
 * Antigravity's own native contracts — evidenced by core/harnesses/antigravity/hooks/*.sh (the
 * shims src/adapters/antigravity/index.js actually projects today) and
 * src/adapters/antigravity/index.js's own GATE_MATCHER/hookGroups — are NOT uniform across
 * events. Only PreToolUse and Stop are wired live there today:
 *
 *   PreToolUse : stdin  { toolCall: { name, args }, conversationId, workspacePaths, stepIdx }
 *                stdout { decision: "allow"|"deny"|"ask"|"force_ask", reason?, overwrite? }
 *   Stop       : stdin  { executionNum, terminationReason, fullyIdle, transcriptPath }
 *                stdout { decision: "continue", reason } to block the stop; NO positive field at
 *                all (silence) to let it proceed — confirmed by
 *                core/harnesses/antigravity/hooks/stop-check.sh's own header ("FAIL-OPEN
 *                DOCTRINE... silence lets the session end"). This is a different decision
 *                vocabulary than PreToolUse's allow/deny/ask/force_ask, not an oversight.
 *
 * SessionStart and PostToolUse have no dedicated Antigravity-native shim in
 * src/adapters/antigravity/index.js's live projection. No Phase A canonical policy owns PostToolUse today (only
 * session-context, pre-implementation-gate, mcp-tool-guard, stop-check, pre-bash-guard exist),
 * so its native shape is an ack passthrough either way.
 */

function toNative(event, decision) {
  const safeDecision = decision || { decision: 'allow' };
  const blocked = safeDecision.effect === 'block' || safeDecision.decision === 'deny';
  const reason = safeDecision.outcome === 'deny'
    ? safeDecision.reason
    : safeDecision.effect === 'block'
      ? `[${safeDecision.policy}] DoFlow policy error; details: doflow-run failure list`
      : safeDecision.reason;

  switch (event) {
    case 'PreToolUse':
      if (blocked) {
        return { decision: 'deny', reason };
      }
      return { decision: 'allow' };

    case 'PostToolUse':
      // Preserve the existing empty-ack contract — no policy decision to report.
      return {};

    case 'Stop':
      if (blocked) {
        return { decision: 'continue', reason };
      }
      // Silence (no positive field) lets the session stop, per Antigravity's own documented
      // Stop contract — not the allow/deny vocabulary PreToolUse uses.
      return {};

    case 'PreInvocation':
      return { injectSteps: [] };

    case 'SessionStart':
      // Side-effect-only event; Antigravity's own SessionStart routing writes no structured
      // stdout today (routed directly to bash, which produces none).
      return {};

    default:
      return { decision: 'allow' };
  }
}

module.exports = { toNative };

'use strict';

/**
 * Antigravity payload/decision adapter for the Cross-Harness Hook Runner (design.md C2's
 * Payload Adapter / Decision Adapter seam, D2).
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
 * src/adapters/antigravity/index.js's live projection; core/.antigravity-plugin/hooks.json (a
 * separate, read-only-to-this-task artifact) documents both routed directly to the *Gemini*
 * session-start.sh / post-edit-lint.sh scripts, which read the Claude/Gemini-style
 * session_id/cwd/tool_name/tool_input field names, not the toolCall envelope above — this
 * adapter honors that evidence for those two events rather than guessing at a toolCall shape
 * with no corroborating source. No Phase A canonical policy owns PostToolUse today (only
 * session-context, pre-implementation-gate, mcp-tool-guard, stop-check, pre-bash-guard exist),
 * so its native shape is an ack passthrough either way.
 */

const FILE_PATH_ARG_FIELDS = ['AbsolutePath', 'TargetFile', 'Path', 'file_path', 'path'];
const COMMAND_ARG_FIELDS = ['CommandLine', 'command'];

function firstArgField(args, fields) {
  for (const field of fields) {
    if (args && args[field]) return args[field];
  }
  return '';
}

function toCanonical(event, payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};

  switch (event) {
    case 'SessionStart':
      return { session_id: safePayload.session_id || '', cwd: safePayload.cwd || '' };

    case 'PreToolUse': {
      const toolCall = safePayload.toolCall || {};
      const args = toolCall.args || {};
      return {
        tool_name: toolCall.name || '',
        tool_input: {
          file_path: firstArgField(args, FILE_PATH_ARG_FIELDS),
          command: firstArgField(args, COMMAND_ARG_FIELDS),
        },
      };
    }

    case 'PostToolUse':
      // No Phase A policy consumes this event — canonical shape kept for symmetry only.
      return {
        tool_name: safePayload.tool_name || '',
        session_id: safePayload.session_id || '',
        tool_input: { file_path: (safePayload.tool_input && safePayload.tool_input.file_path) || '' },
      };

    case 'Stop':
      return {
        session_id: safePayload.session_id || '',
        transcript_path: safePayload.transcriptPath || safePayload.transcript_path || '',
      };

    case 'PreInvocation':
      // No Phase A policy — ack only (injectSteps handled entirely in toNative).
      return {};

    default:
      return safePayload;
  }
}

function toNative(event, decision) {
  const safeDecision = decision || { decision: 'allow' };

  switch (event) {
    case 'PreToolUse':
      if (safeDecision.decision === 'deny') {
        return { decision: 'deny', reason: safeDecision.reason };
      }
      return { decision: 'allow' };

    case 'PostToolUse':
      // Preserve the existing empty-ack contract — no policy decision to report.
      return {};

    case 'Stop':
      if (safeDecision.decision === 'deny') {
        return { decision: 'continue', reason: safeDecision.reason };
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

module.exports = { toCanonical, toNative };

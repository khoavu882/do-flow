'use strict';

/**
 * Gemini CLI payload/decision adapter for the Cross-Harness Hook Runner (design.md C2's
 * Payload Adapter / Decision Adapter seam, D2).
 *
 * Gemini's own native contract — evidenced by core/harnesses/gemini/hooks/*.sh and
 * core/harnesses/gemini/hooks/hooks.json, all currently invoked directly by bash rather than
 * through this runner — already speaks field names close to Claude/Codex/Kiro's, NOT
 * Antigravity's toolCall/args envelope:
 *
 *   SessionStart           : stdin  { session_id, cwd }                          (session-start.sh)
 *   BeforeTool (~PreToolUse): stdin  { tool_name, tool_input: { file_path, command } }
 *                             stdout { decision: "allow"|"deny", reason } — TOP-LEVEL, not
 *                             nested under hookSpecificOutput.permissionDecision like
 *                             Claude/Codex (confirmed in gemini/hooks/pre-bash-guard.sh's header).
 *   AfterTool (~PostToolUse): stdin { tool_name, tool_input: { file_path }, session_id }
 *                             (post-edit-lint.sh) — stdout {} (ack; no Phase A policy owns this
 *                             event, post-edit-lint.sh's collector role is out of FR-001's scope)
 *   Stop                    : NOT a documented Gemini lifecycle event — gemini/hooks/
 *                             post-edit-lint.sh's own comment states "Gemini has no
 *                             Stop-equivalent event," and no stop-check.sh ships under
 *                             gemini/hooks/ today. Handled defensively below (same field-name
 *                             union stop-check.sh itself accepts) in case a future Gemini
 *                             version adds one, or in case core/harnesses/shared/hooks/hooks.json's
 *                             existing (currently dangling) Stop entry is corrected to a real target.
 *
 * NFR-002 note: core/harnesses/shared/hooks/hooks.json has historically routed PreToolUse through
 * this runner using Antigravity's { toolCall: { name, args } } envelope — inherited from this
 * runner's original Antigravity-only design (see the runner's own prior header comment), not
 * verified against Gemini's own documented schema above. toCanonical() below reads the
 * tool_name/tool_input shape first (Gemini's own evidenced contract) and falls back to the
 * toolCall envelope only if that shape isn't present, so this adapter is correct once that
 * wiring is corrected without silently breaking before it is.
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
      if (safePayload.tool_name !== undefined || safePayload.tool_input !== undefined) {
        const toolInput = safePayload.tool_input || {};
        return {
          tool_name: safePayload.tool_name || '',
          tool_input: {
            file_path: toolInput.file_path || '',
            command: toolInput.command || '',
          },
        };
      }
      // Defensive fallback: Antigravity-shaped envelope (see header note).
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
      return {
        tool_name: safePayload.tool_name || '',
        session_id: safePayload.session_id || '',
        tool_input: { file_path: (safePayload.tool_input && safePayload.tool_input.file_path) || '' },
      };

    case 'Stop':
      return {
        session_id: safePayload.session_id || '',
        transcript_path: safePayload.transcript_path || safePayload.transcriptPath || '',
      };

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
      return {};

    case 'Stop':
      if (safeDecision.decision === 'deny') {
        return { decision: 'deny', reason: safeDecision.reason };
      }
      return { decision: 'allow' };

    case 'SessionStart':
      return {};

    default:
      return { decision: 'allow' };
  }
}

module.exports = { toCanonical, toNative };

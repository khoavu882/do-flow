'use strict';

// Shared hook-command verification — the one piece of codex/hooks.js and gemini/hooks.js that
// proved byte-identical on inspection (unlike SUPPORTED_EVENTS, validateHooksConfig, and
// classifyClaudeGuardrails, which encode genuine per-harness differences and stay in each
// adapter). verifyHookCommands and the two private helpers it calls, commandScriptNames and
// hookHandlers, check that a hook config's command handlers resolve to a real, executable script
// in the harness's own hooks directory — that check does not vary by harness, so it lives once.
const fs = require('node:fs');
const path = require('node:path');

function commandScriptNames(command) {
  // DoFlow's wrappers are shell scripts selected from a project or CODEX_HOME hooks directory.
  // Extracting the basename works for both literal and command-substitution based paths.
  return [...new Set((command.match(/[A-Za-z0-9][A-Za-z0-9_-]*\.sh\b/g) || []))];
}

function hookHandlers(config) {
  return Object.entries(config.hooks || {}).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : []).map((handler) => ({ event, handler }))));
}

// On `trusted`: both harnesses gate hook execution behind their own trust prompt — Codex through
// its config, Gemini by fingerprinting a hook's name and command and warning before running one
// that changed (geminicli.com/docs/hooks/). DoFlow verifies neither gate live; doing so would need
// a running CLI session. It reports trust as a prerequisite whose shape it observed, not one it
// bypassed or assumed satisfied. That reading is identical for both harnesses, which is part of
// why this function is shared.
function verifyHookCommands(config, { scriptsDir, trusted = false, fsImpl = fs } = {}) {
  const checks = [];
  for (const { event, handler } of hookHandlers(config)) {
    if (!handler || handler.type !== 'command' || typeof handler.command !== 'string' || !handler.command.trim()) continue;
    const names = commandScriptNames(handler.command);
    if (names.length === 0) {
      checks.push({ event, command: handler.command, ok: false, reason: 'Command does not identify a hook script', requiresTrust: true, trusted });
      continue;
    }
    for (const name of names) {
      const file = scriptsDir ? path.join(scriptsDir, name) : null;
      const exists = Boolean(file && fsImpl.existsSync(file));
      const executable = exists && Boolean(fsImpl.statSync(file).mode & 0o111);
      checks.push({ event, command: handler.command, script: name, file, exists, executable,
        ok: exists && executable, reason: !exists ? 'Hook script is missing' : (!executable ? 'Hook script is not executable' : null),
        requiresTrust: true, trusted });
    }
  }
  return { ok: checks.every((check) => check.ok), checks, trust: { required: checks.length > 0, trusted: Boolean(trusted), status: trusted ? 'trusted' : 'review-required' } };
}

module.exports = { commandScriptNames, hookHandlers, verifyHookCommands };

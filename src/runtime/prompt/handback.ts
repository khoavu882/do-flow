'use strict';

/**
 * The lines every dispatch brief ends with, so each report comes back in one shape (row 173, design
 * §6.3). `brief-tools` and the bash fallback of the task brief both take their report lines from here,
 * and the hand-back guard (G76) holds the status text to the enum.
 */

// The hand-back status ids, in the order of core/registry/workflows.json agents.handback.statuses;
// G76 holds this text, the fallback in do-task-brief.sh and every spec/TOML status line to that list.
const HANDBACK_IDS = Object.freeze(['done', 'done-with-concerns', 'needs-context', 'blocked']);

/**
 * The four hand-back lines: the brief-feedback line, the two lines that ask for `Tools used:`, and the
 * status line.
 * @param {{group?: boolean}} [options] `group` words the last line for a brief that covers several tasks
 * @returns {string[]}
 */
function handbackLines({ group = false }: { group?: boolean } = {}): string[] {
  return [
    "If this brief's scope was wrong or missed something, add one line `Brief feedback: <what>` before the tools line; leave it out otherwise.",
    'Put one line naming every tool and MCP server you used just before the final status line:',
    '`Tools used: <name>[=used|nothing-usable|unavailable|skipped:<reason>], ...`',
    `End ${group ? "each task's report" : 'your report'} with one line \`Status: <status>\`, where the status is one of ${HANDBACK_IDS.map((id) => `\`${id}\``).join(', ')}.`,
  ];
}

module.exports = { handbackLines, HANDBACK_IDS };

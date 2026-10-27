'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/** Common opt-out values used without loading the settings resolver. */
const OFF_WORDS = new Set(['off', '0', 'false', 'no']);

function isOffWord(value: unknown): boolean {
  return typeof value === 'string' && OFF_WORDS.has(value.trim().toLowerCase());
}

module.exports = { OFF_WORDS, isOffWord };

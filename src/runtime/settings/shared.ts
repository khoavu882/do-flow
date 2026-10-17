'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/** Shared parsing and redaction rules for settings and their compatibility adapters. */
const OFF_WORDS = new Set(['off', '0', 'false', 'no']);

function isOffWord(value: unknown): boolean {
  return typeof value === 'string' && OFF_WORDS.has(value.trim().toLowerCase());
}

/** A URL with query values and user-info redacted, including non-hierarchical endpoint forms. */
function maskUrl(text: string): string {
  let value = text;
  try {
    const url = new URL(text);
    if (url.username || url.password) value = `${url.protocol}//***@${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    // Keep the stricter historical fallback: only redact a URL-style authority here.
  }
  value = value.replace(/\/\/[^/\s]*@/g, '//***@');
  value = value.replace(/^([^/:]+:)[^@/]*@/, '$1***@');
  const hashAt = value.indexOf('#');
  const beforeHash = hashAt < 0 ? value : value.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : value.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt < 0) return value;
  const head = beforeHash.slice(0, queryAt + 1);
  const query = beforeHash.slice(queryAt + 1).split('&').map((part) => {
    const equalsAt = part.indexOf('=');
    return equalsAt < 0 ? part : `${part.slice(0, equalsAt)}=***`;
  }).join('&');
  return `${head}${query}${hash}`;
}

module.exports = { OFF_WORDS, isOffWord, maskUrl };

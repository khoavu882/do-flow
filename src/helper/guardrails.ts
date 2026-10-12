'use strict';

// DoFlow's destructive-command blocklist has exactly one authored home: the `permissions.deny`
// array in core/harnesses/claude/settings/settings.json (the projection Claude Code has shipped
// since the first release). Every other harness's opt-in permission projection DERIVES its
// entries from that file at plan time rather than restating the list, so the blocklist cannot
// drift between harnesses.
//
// Claude deny rules look like `Bash(<command glob>:*)`; the wrapper syntax is Claude-specific and
// the inner command glob is what every other harness wants.
//
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): authored as `.ts`, run directly by Node
// native type-stripping (process.features.typescript === 'strip', Node >=22.6) — no build step and
// no runtime dependency. The body stays CommonJS so a `.js` caller's `require('../helper/guardrails.ts')`
// keeps working while the rest of the tree is still `.js`; the explicit `.ts` extension is what the
// CommonJS resolver needs to find this file.

const fs = require('node:fs');
const path = require('node:path');

const DENY_RULE = /^Bash\((.*):\*\)$/;

interface FsReadFileSync {
  readFileSync(file: string, encoding: 'utf8'): string;
}

interface DestructiveCommandGlobsOptions {
  repoRoot: string;
  fsImpl?: FsReadFileSync;
}

/** Read the canonical blocklist as bare command globs, e.g. `git push --force*`. Throws when the
 * authored file is missing or malformed — a silent empty blocklist would look like success while
 * projecting no protection at all. */
function destructiveCommandGlobs({ repoRoot, fsImpl = fs }: DestructiveCommandGlobsOptions): string[] {
  const file = path.join(repoRoot, 'core', 'harnesses', 'claude', 'settings', 'settings.json');
  const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  const deny = parsed?.permissions?.deny;
  if (!Array.isArray(deny) || deny.length === 0) {
    throw new Error(`guardrails: no permissions.deny list in ${file}`);
  }
  return deny.map((rule: string) => {
    const m = DENY_RULE.exec(rule);
    if (!m) throw new Error(`guardrails: unrecognized deny rule '${rule}' in ${file}`);
    return m[1];
  });
}

module.exports = { destructiveCommandGlobs };

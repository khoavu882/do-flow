'use strict';

// Test fixture writer for scoped compact summaries (078 IC-010, DEC-045). Production summaries are
// written only by `policies/summary-store.sh` (`doflow_summary_write`, from post-compact.sh), so this
// writer lives with the tests: it produces the same IC-010 record in the same scope, so a summary it
// writes is claimed by either the hook or summary-store.ts exactly as a real compaction's would be.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SUMMARY_ID_PATTERN, summaryScope } = require('../../src/runtime/context/summary-store.ts');

const AT_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const ATTEMPT_PATTERN = /^[1-9][0-9]{0,3}$/;
const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A frontmatter value is one line: an embedded line break would forge a key. */
const oneLine = (value) => value.replace(/[\r\n]/g, ' ');

/** `mktemp <dir>/.summary.XXXXXX`: an exclusively created 0600 file with a six-character suffix. */
function makeTemp(dir) {
  for (let tries = 0; tries < 100; tries++) {
    let suffix = '';
    for (const b of crypto.randomBytes(6)) suffix += SUFFIX_CHARS[b % SUFFIX_CHARS.length];
    const file = path.join(dir, `.summary.${suffix}`);
    try {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
      return { file, suffix };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`cannot create a temporary file in ${dir}`);
}

/**
 * `doflow_summary_write` (IC-011 step 3): create the scope, write the IC-010 record to a
 * `.summary.XXXXXX` temporary, rename it to summary.md (a newer compaction replaces the pending one).
 * Returns { summaryId, path }, or null with nothing left behind on an invalid argument, an empty
 * body or a failed step.
 */
function writeSummary(options) {
  const { run, lineage, compactedAt, body, env = process.env } = options;
  const attempt = options.attempt ?? '';
  if (!body) return null;
  if (!AT_PATTERN.test(compactedAt)) return null;
  if (attempt !== '' && !ATTEMPT_PATTERN.test(attempt)) return null;
  const scope = summaryScope(options.worktree, run, lineage, env);
  if (scope === null) return null;
  const session = oneLine(options.sessionId ?? '');
  const trigger = oneLine(options.trigger ?? '');
  const branch = oneLine(options.branch ?? '');
  const role = oneLine(options.role ?? '');
  const worktree = oneLine(options.worktree);
  let tmp = '';
  try {
    fs.mkdirSync(scope, { recursive: true });
    const made = makeTemp(scope);
    tmp = made.file;
    const summaryId = `s-${compactedAt.replace(/[-:]/g, '')}-${made.suffix}`;
    if (!SUMMARY_ID_PATTERN.test(summaryId)) throw new Error('summary id');
    const record = '---\n'
      + `compacted_at: ${compactedAt}\n`
      + `session_id: ${session || 'unknown'}\n`
      + `trigger: ${trigger || 'unknown'}\n`
      + `branch: ${branch || 'unknown'}\n`
      + `role: ${role || 'main'}\n`
      + `summary_id: ${summaryId}\n`
      + `run: ${run}\n`
      + `lineage: ${lineage}\n`
      + `attempt:${attempt ? ` ${attempt}` : ''}\n`
      + `worktree: ${worktree}\n`
      + '---\n\n'
      + `${body}\n`;
    fs.writeFileSync(tmp, record);
    const target = path.join(scope, 'summary.md');
    fs.renameSync(tmp, target);
    return { summaryId, path: target };
  } catch {
    if (tmp) fs.rmSync(tmp, { force: true });
    return null;
  }
}

module.exports = { writeSummary };

'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// ── One release version, one CHANGELOG section, one GitHub Release body ─────────────────────────
//
// `gh release create --generate-notes` lists merged pull requests, and this repository merges
// locally, so every Release the workflow created carried only a compare link. CHANGELOG.md is
// where the release text is already written (Keep a Changelog, one `## [X.Y.Z]` heading per
// version), so the release workflow extracts the tagged version's section from it and passes that
// as the Release body. A tag whose section is missing or empty fails the job instead of
// publishing an empty Release.
//
// Usage: node src/release/changelog-section.ts <version|tag> [CHANGELOG path]

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../helper/repo-root.ts');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the body of a version's section: the lines after its `## [version]` heading up to the
 * next `## [` heading, trimmed. The closing `]` after the version makes 1.2.1 and 1.2.10 distinct.
 * A leading `v` on the version is ignored. Returns null when the heading is absent or the body is
 * empty.
 * @param {string} changelogText
 * @param {string} version
 * @returns {string|null}
 */
function changelogSection(changelogText: string, version: string): string | null {
  const wanted = String(version).trim().replace(/^v/, '');
  if (wanted === '') return null;
  const lines = changelogText.split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[${escapeRegExp(wanted)}\\](\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body === '' ? null : body;
}

if (require.main === module) {
  const version = process.argv[2];
  const file = process.argv[3] || path.join(REPO_ROOT, 'CHANGELOG.md');
  if (!version) {
    console.error('usage: node src/release/changelog-section.ts <version|tag> [CHANGELOG path]');
    process.exit(1);
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`cannot read ${file}: ${(err as Error).message}`);
    process.exit(1);
  }
  const body = changelogSection(text, version);
  if (body === null) {
    console.error(`no non-empty CHANGELOG section for ${String(version).replace(/^v/, '')} in ${file}`);
    process.exit(1);
  }
  process.stdout.write(`${body}\n`);
}

module.exports = { changelogSection };

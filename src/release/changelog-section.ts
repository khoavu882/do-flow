'use strict';

// ── One release version, one CHANGELOG section, one GitHub Release body ─────────────────────────
//
// `gh release create --generate-notes` lists merged pull requests, and this repository merges
// locally, so every Release the workflow created carried only a compare link. CHANGELOG.md is
// where the release text is already written (Keep a Changelog, one `## [X.Y.Z]` heading per
// version), so the release workflow extracts the tagged version's section from it and passes that
// as the Release body. A tag whose section is missing or empty fails the job instead of
// publishing an empty Release.
//
// GitHub refuses a Release body over 125,000 characters (HTTP 422), and one version's section can
// be longer than that (2.5.0's was 140,549). `releaseNotesBody` keeps the section as it is when it
// fits under NOTES_CAP and otherwise writes a shorter body: every heading, the first line of every
// entry, and a link to the whole CHANGELOG.md at the tag. Lengths are UTF-16 code units
// (`String.length`), which is never fewer than the code points GitHub counts; the cap applies to
// what the CLI prints (the body and its trailing newline) and leaves 5,000 of margin.
//
// Usage: node src/release/changelog-section.ts <version|tag> [CHANGELOG path]

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../helper/repo-root.ts');

const NOTES_CAP = 120000;
const ENTRY_LINE_MAX = 300;
// A markdown link or a code span: the two places a cut line would stop rendering.
const UNBREAKABLE = /`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)/g;

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

/**
 * Closes a `**` the cut left open. Only a bare `**` counts (not `2**10`, which sits against a word,
 * nor a run of three or more), and only when no closing `**` follows it in the kept text. A `_` that
 * opens right inside it and is not closed is closed too; a `**` that is the last thing kept is dropped.
 */
function closeBold(kept: string): string {
  const masked = kept.replace(UNBREAKABLE, (span) => '\0'.repeat(span.length));
  let open = -1;
  for (const run of masked.matchAll(/\*+/g)) {
    if (run[0].length !== 2) continue;
    const before = masked[run.index - 1] || '';
    const after = masked[run.index + 2] || '';
    if (open < 0) {
      if (!/\w/.test(before) && after !== '' && !/\s/.test(after)) open = run.index;
    } else if (before !== '' && !/\s/.test(before)) {
      open = -1;
    }
  }
  if (open < 0) return kept;
  if (open + 2 === kept.length) return kept.slice(0, open).trimEnd();
  const inner = masked.slice(open + 2);
  return `${kept}${inner.startsWith('_') && !inner.includes('_', 1) ? '_' : ''}**`;
}

/**
 * Cuts a line to about `max` characters at a space, never inside a link or a code span, and ends it
 * with an ellipsis. A line that opens with a span (after the bullet and any `**`) keeps that whole
 * span, so the entry still has visible text; a span longer than `max` is the one way a cut line
 * runs past it. An unclosed `**` is closed.
 */
function trimLine(line: string, max: number): string {
  if (line.length <= max) return line;
  const spans = [...line.matchAll(UNBREAKABLE)].map((m) => [m.index, m.index + m[0].length]);
  const inside = (at: number) => spans.some(([start, end]) => start < at && at < end);
  let cut = max;
  let floor = 0;
  const span = spans.find(([start, end]) => start < cut && cut < end);
  if (span) {
    const lead = line.slice(0, span[0]).replace(/^[-*+] /, '').replace(/[*_\s]+/g, '');
    cut = lead === '' ? span[1] : span[0];
    if (lead === '') floor = cut;
  }
  const space = line.lastIndexOf(' ', cut);
  if (space >= floor && space > cut - 40 && !inside(space)) cut = space;
  if (/[\uD800-\uDBFF]/.test(line[cut - 1] || '')) cut -= 1;
  return `${closeBold(line.slice(0, cut).trimEnd())}…`;
}

function repositoryUrl(repoRoot: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const match = String(pkg.repository?.url ?? pkg.repository ?? '')
    .match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) throw new Error('package.json repository is not a github.com URL');
  return `https://github.com/${match[1]}`;
}

/**
 * The text of a GitHub Release body for a version's section; with the newline the CLI prints after
 * it, at most `cap` characters. A section that fits is returned unchanged. A longer one keeps every
 * heading and the first line of every top-level bullet (cut at about 300 characters), then a link
 * to the whole CHANGELOG.md at the tag. If that is still too long, the last entries of the
 * heading with the most entries left are left out one at a time and each heading says how many
 * ("... and N more entries"). If even the headings and those lines are too long, only the headings,
 * "(entries omitted)" and the link remain; if those are too long, only the link.
 * @param {string} section a version's section from changelogSection
 * @param {string} tag the release tag; a missing leading v is added
 * @param {{cap?: number, repository?: string, repoRoot?: string}} [options] repoRoot is the checkout whose package.json names the repository
 * @returns {string}
 */
function releaseNotesBody(
  section: string,
  tag: string,
  { cap = NOTES_CAP, repository, repoRoot = REPO_ROOT }: { cap?: number, repository?: string, repoRoot?: string } = {},
): string {
  const limit = cap - 1; // the CLI prints a newline after the body
  if (section.length <= limit) return section;
  const link = `Full notes: ${repository ?? repositoryUrl(repoRoot)}/blob/v${String(tag).trim().replace(/^v/, '')}/CHANGELOG.md`;

  // One line per kept line of the section. Lines under an entry (indented, nested, lazy
  // continuation) and fenced blocks are dropped; a fence left open would break the rest of the page.
  type Line = { text: string, group: number, entry: boolean };
  const lines: Line[] = [];
  const entries: Line[][] = [[]];
  let inEntry = false;
  let inFence = false;
  for (const text of section.split('\n')) {
    if (/^(`{3,}|~{3,})/.test(text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const entry = /^[-*+] /.test(text);
    if (/^#{1,6} /.test(text)) {
      entries.push([]);
      inEntry = false;
      lines.push({ text, group: entries.length - 1, entry: false });
      continue;
    }
    if (!entry && text.trim() !== '') {
      if (inEntry && (/^\s/.test(text) || lines[lines.length - 1].text !== '')) continue;
      inEntry = false;
    }
    if (entry) inEntry = true;
    const line = { text: trimLine(text, ENTRY_LINE_MAX), group: entries.length - 1, entry };
    lines.push(line);
    if (entry) entries[line.group].push(line);
  }

  // keep[g] is how many entries of heading g are shown; the rest become one "and N more" line.
  const keep = entries.map((list) => list.length);
  const build = (): string => {
    const out: string[] = [];
    const seen = entries.map(() => 0);
    for (const line of lines) {
      if (line.entry && seen[line.group]++ >= keep[line.group]) {
        if (seen[line.group] === keep[line.group] + 1) {
          const n = entries[line.group].length - keep[line.group];
          out.push(`- … and ${n} more ${n === 1 ? 'entry' : 'entries'}`);
        }
        continue;
      }
      if (line.text === '' && out[out.length - 1] === '') continue;
      out.push(line.text);
    }
    while (out[out.length - 1] === '') out.pop();
    return `${out.join('\n')}\n\n${link}`;
  };

  let body = build();
  while (body.length > limit) {
    // Drop from the heading with the most entries left until the estimate fits, then measure.
    let excess = body.length - limit + 32 * entries.length;
    let dropped = false;
    while (excess > 0) {
      const g = keep.indexOf(Math.max(...keep));
      if (keep[g] === 0) break;
      keep[g] -= 1;
      excess -= entries[g][keep[g]].text.length + 1;
      dropped = true;
    }
    if (!dropped) {
      const headings = lines.filter((line) => /^#{1,6} /.test(line.text)).map((line) => line.text);
      const omitted = `${headings.join('\n')}\n\n(entries omitted)\n\n${link}`;
      return omitted.length <= limit ? omitted : link;
    }
    body = build();
  }
  return body;
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
  const section = changelogSection(text, version);
  if (section === null) {
    console.error(`no non-empty CHANGELOG section for ${String(version).replace(/^v/, '')} in ${file}`);
    process.exit(1);
  }
  process.stdout.write(`${releaseNotesBody(section, version)}\n`);
}

module.exports = { changelogSection, releaseNotesBody, NOTES_CAP };

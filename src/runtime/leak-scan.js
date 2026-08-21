'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { finishRuntime, usageError } = require('./cli-result');

/**
 * Reports DoFlow's own process vocabulary appearing in files that ship to people who never used
 * DoFlow (FR-009, FR-010).
 *
 * The rule lives here, in one module, because it has two callers: the Stop hook scans the turn's
 * edited files, and `/do-code-review` scans the reviewed set. Implementing it twice — once in bash
 * and once in Python — is what G12's one-implementation-per-verb rule exists to prevent, and the
 * drift would be invisible: the two would disagree about what counts as a leak and neither would
 * say so (design R6).
 *
 * This module reports and never blocks. A legitimate occurrence exists — documentation *about*
 * DoFlow — so a false positive that halted a write would cost more than the leak it prevented.
 */

/**
 * The vocabulary, as data rather than scattered through the callers, so a false positive is a
 * one-line change here (design R4).
 *
 * Deliberately absent: a bare component reference like `C1`/`C#`. `C#` is a language name, so that
 * pattern would report every shipped mention of C# as a DoFlow leak, and `C1` is too generic to
 * carry meaning on its own. Precision matters more than coverage for a check nobody can silence.
 */
const LEAK_PATTERNS = [
  { id: 'requirement-item', label: 'requirement item reference', pattern: /\b(?:FR|NFR)-\d{3}\b/ },
  { id: 'story-item', label: 'user story reference', pattern: /\bUS\d+\b/ },
  { id: 'artifact-path', label: 'DoFlow artifact path', pattern: /\bagent-docs\// },
  { id: 'state-path', label: 'DoFlow state path', pattern: /\.doflow\/state\// },
  { id: 'chain-artifact', label: 'chain artifact cross-reference', pattern: /\b(?:requirement|design|plan)\.md\b/ },
];

/** Occurrences inside the artifact tree are correct usage, so paths are excluded before matching. */
const DEFAULT_EXCLUDED_SEGMENTS = ['agent-docs'];

/** Why a named path produced no findings without being clean. */
const UNSCANNED_REASONS = new Set(['excluded', 'unreadable', 'not-a-file']);

function isExcluded(relPath, excludedSegments) {
  const segments = relPath.split(path.sep);
  return excludedSegments.some((seg) => segments.includes(seg));
}

/**
 * Resolves one requested path to readable content, or to the reason it was not read.
 *
 * Split out of `scanPaths` so that function is a loop over outcomes rather than a loop with path
 * resolution, exclusion and error handling folded into it. Every return here is one of the two
 * shapes `scanPaths` knows how to file.
 *
 * @returns {{relative: string, content: string}|{relative: string, reason: string}}
 */
function readScannable(target, root, excluded, impl) {
  const absolute = path.isAbsolute(target) ? target : path.join(root, target);
  const relative = path.relative(root, absolute);

  if (isExcluded(relative, excluded)) return { relative, reason: 'excluded' };

  try {
    if (!impl.existsSync(absolute) || !impl.statSync(absolute).isFile()) {
      return { relative, reason: 'not-a-file' };
    }
    return { relative, content: impl.readFileSync(absolute, 'utf8') };
  } catch {
    // An unreadable path is reported, never fatal: this runs from a hook that must not fail a
    // turn, and from a review that must not lose the rest of its file set to one bad path.
    return { relative, reason: 'unreadable' };
  }
}

/** Every pattern match in one file's lines, as finding records. */
function findLeaksInLines(lines, relative) {
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const rule of LEAK_PATTERNS) {
      const match = lines[i].match(rule.pattern);
      if (match) {
        findings.push({ file: relative, line: i + 1, pattern: rule.id, label: rule.label, text: match[0] });
      }
    }
  }
  return findings;
}

/**
 * Scans the named paths for internal-identifier occurrences.
 *
 * Every path given is accounted for in exactly one of `findings`' file set, `scanned`, or
 * `unscanned` — a path that was skipped is reported as skipped rather than dropped, for the same
 * reason the review bundle must report the files it could not read.
 *
 * @param {Object} options
 * @param {string[]} options.paths files to scan; relative paths resolve against `repoRoot`
 * @param {string} [options.repoRoot] defaults to cwd
 * @param {string[]} [options.excludedSegments] path segments whose contents are correct usage
 * @param {Object} [options.fsImpl] injectable fs, for tests
 * @returns {{findings: Array, scanned: string[], unscanned: Array}}
 */
function scanPaths({ paths: targets, repoRoot, excludedSegments, fsImpl } = {}) {
  const impl = fsImpl || fs;
  const root = repoRoot || process.cwd();
  const excluded = excludedSegments || DEFAULT_EXCLUDED_SEGMENTS;

  const findings = [];
  const scanned = [];
  const unscanned = [];

  for (const target of targets || []) {
    if (typeof target !== 'string' || target.trim() === '') continue;

    const read = readScannable(target, root, excluded, impl);
    if (read.reason) {
      unscanned.push({ file: read.relative, reason: read.reason });
      continue;
    }

    scanned.push(read.relative);
    findings.push(...findLeaksInLines(read.content.split('\n'), read.relative));
  }

  return { findings, scanned, unscanned };
}

/**
 * Handles `doflow leak-scan`. Exit 0 clean, 1 on findings, and never non-zero for a path it could
 * not read — that path is reported as unscanned instead.
 *
 * @param {Object} options
 * @param {string[]} options.paths
 * @param {string[]} [options.exclude] extra path segments to skip, on top of the artifact directory
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 * @returns {number} exit code
 */
function handleLeakScanCommand({ paths: targets, exclude, json = false, repoRoot } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return usageError('leak-scan', '--path is required (repeatable): the files to scan', json);
  }

  // `--exclude` extends the built-in artifact-directory exclusion rather than replacing it: a
  // caller narrowing the scan should not be able to accidentally widen it back over agent-docs/.
  const extra = Array.isArray(exclude) ? exclude.filter((e) => typeof e === 'string' && e.trim() !== '') : [];
  const excludedSegments = [...DEFAULT_EXCLUDED_SEGMENTS, ...extra];

  const result = scanPaths({ paths: targets, repoRoot, excludedSegments });

  if (json) {
    console.log(JSON.stringify({ ...result, findingsCount: result.findings.length }, null, 2));
  } else {
    console.log('\nDoFlow leak scan:');
    console.log('═'.repeat(78));
    if (result.findings.length === 0) {
      console.log(`No internal identifiers found in ${result.scanned.length} scanned file(s).`);
    } else {
      for (const f of result.findings) console.log(`  ${f.file}:${f.line}  ${f.text}  (${f.label})`);
    }
    if (result.unscanned.length > 0) {
      console.log('\nNot scanned:');
      for (const u of result.unscanned) console.log(`  ${u.file} — ${u.reason}`);
    }
    console.log('═'.repeat(78) + '\n');
  }

  return finishRuntime(result.findings.length > 0 ? 1 : 0);
}

module.exports = { scanPaths, handleLeakScanCommand, LEAK_PATTERNS, UNSCANNED_REASONS };

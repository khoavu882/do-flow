'use strict';

/**
 * Retrieval bridge — the JavaScript port of
 * `core/shared/scripts/doflow/tools/retrieval_bridge.py` (plan task B.3, serving component C4).
 *
 * Runs the external retrieval tools DoFlow routes to — Semble for semantic search, Graphify for
 * call graphs, Git for history — and falls back to ripgrep when the preferred tool is absent. The
 * provider ids it stamps onto evidence (`semble.search`, `graphify.query`, `git.native`,
 * `native.rg`) are the same ids `core/registry/capabilities.yaml` declares, so evidence produced
 * here lines up with what `capability-router.js` resolves.
 *
 * Ported from observed behaviour (plan decision D3): the provider order, the fall-through rule
 * (ripgrep is tried only when the preferred tool produced *no* output, not merely when it is
 * missing), the 30-second command timeout, and the DIRECT / EXTRACTED / INFERRED provenance
 * vocabulary are all unchanged.
 *
 * Five defects are fixed rather than reproduced, each explained at its site:
 *   1. The repo root was derived from the script's own location, so an installed copy searched the
 *      DoFlow package instead of the user's project.
 *   2. A non-zero exit collapsed to `None`, making "the tool errored" indistinguishable from "the
 *      tool found nothing" — the same conflation the worktree port fixed in `collect_diff`.
 *   3. The ripgrep fallback passed a natural-language term as a regex, so a term containing `(`
 *      or `*` failed to compile and silently returned nothing.
 *   4. `query_graph`'s ripgrep fallback had no output cap at all, so a common symbol could return
 *      a megabyte of matches into a context-budgeted evidence record.
 *   5. Every evidence record carried `reliability` and `relevance` floats — see NUMERIC CONFIDENCE
 *      below.
 *
 * NUMERIC CONFIDENCE (defect 5, the one judgement call in this file): the Python stamped fixed
 * scores such as `reliability: 0.95, relevance: 0.90` on Semble results and `0.75 / 0.65` on
 * ripgrep ones. Those numbers were constants chosen per code path, not measurements of anything,
 * and they restated information the `provenance.type` field already carries exactly — every
 * distinct score pair corresponds one-to-one with a distinct provenance/provider pair. FR-008 and
 * design C5 make this binding for the feature this port belongs to: retrieval relevance is never
 * written into a confidence field. They are dropped; no discrimination is lost, because
 * `provenance` still distinguishes every case they distinguished.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 30000;

/** Retrieval output is bounded before it becomes evidence: an uncapped whole-repo grep can exceed
 * any context budget the caller planned for. Generous enough to hold a real answer, small enough
 * that no single record can dominate a pack. */
const MAX_CONTENT_CHARS = 4000;

/** Markers that identify a directory as the root of the project being worked on. */
const ROOT_MARKERS = Object.freeze([['.git'], ['core', 'registry']]);

/** The same handful of binaries get asked about on every query. */
const availabilityCache = new Map();

/** On Windows an executable is identified by extension; elsewhere by the execute bit. */
const WINDOWS_EXTENSIONS = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';');

/**
 * Walks upward from `startDir` looking for a project root.
 *
 * Defect fix (1): the Python resolved this from `__file__`, which is correct only when the script
 * runs from a source checkout. Installed under `node_modules/`, it walked up into the DoFlow
 * package (or into whatever repo happened to contain it) and searched there instead of the
 * project the engineer is working in. `cli.js` already draws this distinction for evidence state —
 * "the caller's project state, not DoFlow package state" — and retrieval is the same question.
 * @param {string} [startDir=process.cwd()]
 * @returns {string}
 */
function findRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  for (;;) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(current, ...marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

/**
 * @param {string} candidate absolute or relative path to test
 * @returns {boolean} whether it is a file this process may execute
 */
function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    // A directory carries the execute bit too, hence the isFile check above.
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an external tool is installed.
 *
 * Scans `PATH` directly rather than spawning `which`, for two reasons. It matches what the
 * Python's `shutil.which` did — a pure lookup with no subprocess — and it does not make retrieval
 * depend on `which` itself being installed, which is exactly the kind of assumption NFR-002 is
 * about. Deliberately not `CapabilityRouter.isBinaryAvailable` either: that class loads the
 * capability and route registries to construct, and this bridge must work as a bare exec wrapper
 * with no registry present.
 * @param {string} binary
 * @returns {boolean}
 */
function isToolAvailable(binary) {
  if (!binary) return false;
  if (availabilityCache.has(binary)) return availabilityCache.get(binary);

  const extensions = process.platform === 'win32' ? WINDOWS_EXTENSIONS : [''];
  let available = false;

  if (binary.includes(path.sep) || path.isAbsolute(binary)) {
    available = extensions.some((ext) => isExecutableFile(binary + ext));
  } else {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    available = dirs.some((dir) => extensions.some((ext) => isExecutableFile(path.join(dir, binary + ext))));
  }

  availabilityCache.set(binary, available);
  return available;
}

/** Test seam: availability is cached process-wide, so a test that changes PATH needs a way back. */
function clearAvailabilityCache() {
  availabilityCache.clear();
}

/**
 * Runs a command with its arguments as an array — never through a shell, so a query string cannot
 * become shell syntax.
 *
 * Defect fix (2): returns the full outcome. The Python returned `stdout` on success and `None` on
 * anything else, so a caller could not tell an empty result from a crashed tool, and a broken
 * Semble install looked exactly like a repository with no matches.
 * @param {Array<string>} argv
 * @param {Object} [options]
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs=30000]
 * @returns {{ ok: boolean, stdout: string, stderr: string, code: number|null, error: string|null }}
 */
function runCommand(argv, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });

  if (res.error) {
    return { ok: false, stdout: '', stderr: '', code: null, error: res.error.message };
  }
  return {
    ok: res.status === 0,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    code: res.status,
    error: null,
  };
}

/**
 * @param {string} content
 * @returns {{ content: string, truncated: boolean }}
 */
function bound(content) {
  // Defect fix (4).
  if (content.length <= MAX_CONTENT_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_CONTENT_CHARS), truncated: true };
}

/**
 * @param {string} source
 * @param {string} rawContent
 * @param {{type: string, provider: string, method: string}} provenance
 * @returns {Object} evidence record
 */
function makeEvidence(source, rawContent, provenance) {
  const { content, truncated } = bound(rawContent);
  const record = { source, content, provenance };
  if (truncated) record.truncated = true;
  return record;
}

class RetrievalBridge {
  /**
   * @param {Object|string} [options] a string is accepted for parity with the Python's positional
   *   `repo_root` argument
   * @param {string} [options.repoRoot]
   * @param {number} [options.timeoutMs=30000]
   * @param {Function} [options.isAvailable] injection seam for tests
   * @param {Function} [options.run] injection seam for tests; same contract as `runCommand`
   */
  constructor(options = {}) {
    const opts = typeof options === 'string' ? { repoRoot: options } : options;
    this.repoRoot = opts.repoRoot || findRepoRoot();
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.isAvailable = opts.isAvailable || isToolAvailable;
    this.run = opts.run || runCommand;
  }

  /**
   * @param {Array<string>} argv
   * @returns {ReturnType<runCommand>}
   */
  exec(argv) {
    return this.run(argv, { cwd: this.repoRoot, timeoutMs: this.timeoutMs });
  }

  /**
   * Semantic search through Semble, falling back to a literal ripgrep search.
   * @param {string} query
   * @param {Object} [options]
   * @param {number} [options.topK=5]
   * @returns {{ evidence: Array<Object>, attempts: Array<Object> }}
   */
  querySemantic(query, { topK = 5 } = {}) {
    const evidence = [];
    const attempts = [];

    if (this.isAvailable('semble')) {
      const res = this.exec(['semble', 'search', query, this.repoRoot, '--top-k', String(topK)]);
      attempts.push(describeAttempt('semble.search', res));
      if (res.ok && res.stdout) {
        evidence.push(makeEvidence('SEMBLE', res.stdout, {
          type: 'DIRECT',
          provider: 'semble.search',
          method: 'semantic-embeddings',
        }));
        return { evidence, attempts };
      }
      // Falls through when Semble answered with nothing or failed — preserved from the Python,
      // where the early return sat inside `if output:`.
    } else {
      attempts.push({ provider: 'semble.search', status: 'absent' });
    }

    if (this.isAvailable('rg')) {
      // Defect fix (3): `--fixed-strings`. The Python handed `query.split()[0]` straight to
      // ripgrep as a pattern, so a first term containing regex metacharacters — `handleDoctor(`,
      // `*args` — made ripgrep exit non-zero, which the old `run_command` turned into `None` and
      // the caller read as "nothing found". A search term is a literal, not a pattern.
      const firstTerm = String(query || '').trim().split(/\s+/)[0] || '';
      if (firstTerm) {
        const res = this.exec(['rg', '-n', '--fixed-strings', firstTerm, this.repoRoot, '--max-count', '10']);
        attempts.push(describeAttempt('native.rg', res, { noMatchCode: RG_NO_MATCH }));
        if (res.ok && res.stdout) {
          evidence.push(makeEvidence('FILESYSTEM', res.stdout, {
            type: 'EXTRACTED',
            provider: 'native.rg',
            method: 'literal-fallback',
          }));
        }
      } else {
        attempts.push({ provider: 'native.rg', status: 'skipped', detail: 'empty query' });
      }
    } else {
      attempts.push({ provider: 'native.rg', status: 'absent' });
    }

    return { evidence, attempts };
  }

  /**
   * Call-graph and impact analysis through Graphify, falling back to literal symbol occurrences.
   * @param {string} symbol
   * @returns {{ evidence: Array<Object>, attempts: Array<Object> }}
   */
  queryGraph(symbol) {
    const evidence = [];
    const attempts = [];

    if (this.isAvailable('graphify')) {
      const res = this.exec(['graphify', 'query', symbol, this.repoRoot]);
      attempts.push(describeAttempt('graphify.query', res));
      if (res.ok && res.stdout) {
        evidence.push(makeEvidence('GRAPHIFY', res.stdout, {
          type: 'EXTRACTED',
          provider: 'graphify.query',
          method: 'ast-call-graph',
        }));
        return { evidence, attempts };
      }
    } else {
      attempts.push({ provider: 'graphify.query', status: 'absent' });
    }

    if (this.isAvailable('rg')) {
      // `--max-count` caps matches per file, which the Python's graph fallback lacked entirely;
      // `bound()` caps the total. Text occurrences of a symbol are INFERRED, not structural fact —
      // a preserved distinction and the reason the numeric scores were redundant.
      const res = this.exec(['rg', '-n', '--fixed-strings', String(symbol || ''), this.repoRoot, '--max-count', '20']);
      attempts.push(describeAttempt('native.rg', res, { noMatchCode: RG_NO_MATCH }));
      if (res.ok && res.stdout) {
        evidence.push(makeEvidence('FILESYSTEM', res.stdout, {
          type: 'INFERRED',
          provider: 'native.rg',
          method: 'text-occurrences',
        }));
      }
    } else {
      attempts.push({ provider: 'native.rg', status: 'absent' });
    }

    return { evidence, attempts };
  }

  /**
   * Commit history for a path. No fallback: git either answers or the history is unavailable.
   * @param {string} targetPath
   * @param {Object} [options]
   * @param {number} [options.maxCount=5]
   * @returns {{ evidence: Array<Object>, attempts: Array<Object> }}
   */
  queryHistory(targetPath, { maxCount = 5 } = {}) {
    const evidence = [];
    const attempts = [];

    if (!this.isAvailable('git')) {
      attempts.push({ provider: 'git.native', status: 'absent' });
      return { evidence, attempts };
    }

    const res = this.exec(['git', 'log', `-n${maxCount}`, '--oneline', '--', targetPath]);
    attempts.push(describeAttempt('git.native', res));
    if (res.ok && res.stdout) {
      evidence.push(makeEvidence('GIT', res.stdout, {
        type: 'DIRECT',
        provider: 'git.native',
        method: 'log',
      }));
    }

    return { evidence, attempts };
  }
}

/**
 * @param {string} provider
 * @param {ReturnType<runCommand>} res
 * @param {Object} [options]
 * @param {number} [options.noMatchCode] exit code this tool uses for "searched, found nothing"
 * @returns {{provider: string, status: string, detail?: string}}
 */
function describeAttempt(provider, res, { noMatchCode } = {}) {
  if (res.error) return { provider, status: 'error', detail: res.error };
  // ripgrep and grep exit 1 for "no matches" and 2 for a real failure. Without this, every search
  // that legitimately found nothing would be recorded as a tool error, which is the same
  // conflation defect (2) fixes in the other direction.
  if (!res.ok && noMatchCode !== undefined && res.code === noMatchCode) {
    return { provider, status: 'empty' };
  }
  if (!res.ok) return { provider, status: 'error', detail: res.stderr || `exit ${res.code}` };
  if (!res.stdout) return { provider, status: 'empty' };
  return { provider, status: 'ok' };
}

/** ripgrep's "no matches" exit code. */
const RG_NO_MATCH = 1;

/**
 * Renders evidence for a terminal, replacing the Python CLI's non-JSON output. The reliability
 * figure that line used to print is gone with the field; the provenance type says the same thing
 * without asserting a number.
 * @param {Array<Object>} evidence
 * @returns {string}
 */
function formatEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return 'No evidence retrieved.\n';
  }
  const lines = [];
  for (const item of evidence) {
    lines.push(`[${item.source}] ${item.provenance.provider} (${item.provenance.type.toLowerCase()}, ${item.provenance.method})`);
    lines.push(item.content);
    if (item.truncated) lines.push(`... truncated at ${MAX_CONTENT_CHARS} characters`);
    lines.push('-'.repeat(40));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  RetrievalBridge,
  findRepoRoot,
  isToolAvailable,
  clearAvailabilityCache,
  runCommand,
  formatEvidence,
  MAX_CONTENT_CHARS,
  DEFAULT_TIMEOUT_MS,
};

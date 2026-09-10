'use strict';

// Stage 5 (docs/refactor-plan.md) — upstream format-drift watcher.
//
// Registry evidence URLs record where each capability fact came from, but nothing noticed when
// those pages moved; two drifts were caught manually this cycle (antigravity hooks, copilot
// payloads). This script re-derives the watch list FROM THE REGISTRIES at runtime, fingerprints
// each cited page, and diffs the fingerprints against scripts/drift/baseline.json.
//
// Doctrine: plain Node >=18, zero dependencies (global fetch + node:crypto sha256). Deterministic:
// the same page content yields the same fingerprint regardless of fetch order, time of day, or
// cosmetic page churn — normalization strips tags/script/style, collapses whitespace, and drops
// date-like and copyright lines before hashing. Baseline lives under scripts/, NOT core/registry/
// (that family is ratcheted at exactly 12 files by G-B2; the baseline is CI state, not registry).
//
// Exit codes:
//   0  clean (or only benign UNREACHABLE / NEW / allowlisted claims)
//   1  at least one watched page DRIFTED from its baseline fingerprint
//   2  usage or configuration error (bad flag, malformed allowlist, stale allowlist id)
//   3  a page that HAD a fingerprint became unreachable — suspicious, investigate
// Exit precedence: 2 > 1 > 3 > 0. Network failures on never-seen URLs stay exit 0 so upstream
// flakiness cannot spam CI red; failures on previously-fingerprinted pages get their own loud 3.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..');
const REGISTRY_DIR = path.join(REPO, 'core', 'registry');
const BASELINE_FILE = path.join(REPO, 'scripts', 'drift', 'baseline.json');
const ALLOWLIST_FILE = path.join(REPO, 'scripts', 'drift', 'allowlist.json');

const FETCH_TIMEOUT_MS = 10_000;
const FETCH_RETRIES = 2; // initial attempt + 2 retries
const RETRY_DELAY_MS = 500;

// -------------------------------------------------------------------------- watch-spec derivation

/** Derive watch specs from the parsed registry documents (single-source — nothing hardcoded here).
 * Claim id shapes: `harnesses:<id>:<capability>` and `contracts:<harness>`. Rows without a
 * non-empty evidence array carry nothing to watch and are skipped. */
function buildWatchSpecs({ harnessesDoc, contractsDoc }) {
  const specs = [];
  for (const harness of (harnessesDoc && harnessesDoc.harnesses) || []) {
    for (const [capability, row] of Object.entries(harness.capabilities || {})) {
      if (!row || !Array.isArray(row.evidence) || row.evidence.length === 0) continue;
      specs.push({
        id: `harnesses:${harness.id}:${capability}`,
        urls: [...new Set(row.evidence)].sort(),
        claim: `${harness.displayName || harness.id} ${capability} (${row.status})`,
      });
    }
  }
  for (const contract of (contractsDoc && contractsDoc.contracts) || []) {
    if (!contract || !Array.isArray(contract.evidence) || contract.evidence.length === 0) continue;
    specs.push({
      id: `contracts:${contract.harness}`,
      urls: [...new Set(contract.evidence)].sort(),
      claim: `${contract.harness} contract evidence (${contract.completeness})`,
    });
  }
  specs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return specs;
}

// ------------------------------------------------------------------------------ allowlist handling

/** Load scripts/drift/allowlist.json. Default-deny: every entry needs a non-empty reason, and
 * every entry must name a claim the CURRENT registries still derive — otherwise the allowlist
 * could quietly outlive what it excludes. */
function loadAllowlist(file, specIds) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const doc = JSON.parse(raw);
  if (!doc || !Array.isArray(doc.excluded)) {
    throw new Error(`${path.relative(REPO, file)} must hold {"excluded":[{"id","reason"}]}`);
  }
  const known = new Set(specIds);
  const out = [];
  for (const entry of doc.excluded) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) {
      throw new Error(`${path.relative(REPO, file)}: every entry needs a non-empty "id"`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`${path.relative(REPO, file)}: "${entry.id}" needs a non-empty "reason" `
        + '(additions to the allowlist are default-deny)');
    }
    if (!known.has(entry.id)) {
      throw new Error(`${path.relative(REPO, file)}: "${entry.id}" names no claim derived from the `
        + 'current registries — fix the id or delete the entry');
    }
    out.push({ id: entry.id, reason: entry.reason });
  }
  return out;
}

// ------------------------------------------------------------------------------------ normalization

/** Normalize fetched HTML/text into the stable form that gets hashed. Cosmetic churn — tag soup,
 * whitespace, "Last updated" stamps, copyright footers — must NOT move the fingerprint. */
function normalizeText(raw) {
  let text = String(raw)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gis, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gis, ' ')
    .replace(/<(noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gis, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\n'); // every tag becomes a line break, so text nodes stay separate lines

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&copy;|&#0*169;/gi, '©')
    .replace(/&amp;/gi, '&');

  // Built via `new RegExp` only so the pattern can span two source lines; it is a constant.
  const DATE_LIKE = new RegExp(
    'last\\s+(?:updated|modified|edited)|page\\s+(?:updated|generated)|updated\\s+on'
    + '|\\b(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}\\b|\\b(?:19|20)\\d{2}/\\d{1,2}/\\d{1,2}\\b', 'i');
  const COPYRIGHT = /©|(?:all\s+)?rights\s+reserved|\bcopyright\b/i;

  const lines = [];
  for (let line of text.split('\n')) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (DATE_LIKE.test(line) || COPYRIGHT.test(line)) continue;
    lines.push(line);
  }
  return lines.join('\n');
}

/** Self-describing sha256 hex of already-normalized text. */
function fingerprintText(normalized) {
  return 'sha256:' + crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// ----------------------------------------------------------------------------------------- fetching

/** Fetch one URL with a hard timeout and bounded retries. Returns {ok:true, body} or
 * {ok:false, error}. fetchImpl/sleep are injectable so tests never touch the network. */
async function fetchText(url, {
  fetchImpl = ((url_, init) => fetch(url_, init)),
  timeoutMs = FETCH_TIMEOUT_MS,
  retries = FETCH_RETRIES,
  retryDelayMs = RETRY_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { ok: true, body: await response.text() };
    } catch (err) {
      lastError = controller.signal.aborted && !(err instanceof Error && err.message.startsWith('HTTP '))
        ? new Error(`timed out after ${timeoutMs}ms`)
        : err;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------------------- reporting

function summarize(results, excluded, staleUrlCount) {
  const summary = {
    watchedUrls: results.length,
    ok: 0, drifted: 0, new_: 0, unreachable: 0, unreachableSuspicious: 0,
    excludedClaims: excluded.length,
    staleBaselineUrls: staleUrlCount,
  };
  for (const row of results) {
    if (row.status === 'OK') summary.ok += 1;
    else if (row.status === 'DRIFTED') summary.drifted += 1;
    else if (row.status === 'NEW') summary.new_ += 1;
    else if (row.status === 'UNREACHABLE') {
      summary.unreachable += 1;
      if (row.suspicious) summary.unreachableSuspicious += 1;
    }
  }
  return summary;
}

function exitCodeFor(summary) {
  if (summary.drifted > 0) return 1;
  if (summary.unreachableSuspicious > 0) return 3;
  return 0;
}

function renderHuman(report) {
  const out = [];
  const { specs, results, excluded, summary } = report;
  out.push('upstream format-drift check');
  out.push(`watching ${specs.length} claims over ${summary.watchedUrls} urls`
    + (summary.excludedClaims ? ` (${summary.excludedClaims} claims allowlisted)` : '')
    + (summary.staleBaselineUrls ? ` (${summary.staleBaselineUrls} stale baseline entries)` : ''));
  out.push('');
  const width = Math.max(...['STATUS', ...results.map((r) => r.status.length)]);
  out.push(`${'STATUS'.padEnd(width)}  URL`);
  for (const row of results) {
    out.push(`${row.status.padEnd(width)}  ${row.url}`);
    out.push(`${''.padEnd(width)}  -> claims: ${row.claims.join(', ') || '(none)'}`);
    if (row.error) out.push(`${''.padEnd(width)}  -> ${row.error}`);
  }
  if (excluded.length) {
    out.push('');
    out.push('allowlisted (issue-tracked, deliberately unwatched):');
    for (const e of excluded) out.push(`  ${e.id} — ${e.reason}`);
  }
  out.push('');
  out.push(`summary: ok=${summary.ok} drifted=${summary.drifted} new=${summary.new_} `
    + `unreachable=${summary.unreachable}${summary.unreachableSuspicious
      ? ` (suspicious=${summary.unreachableSuspicious})` : ''}`);
  const code = exitCodeFor(summary);
  if (code === 1) out.push('DRIFTED pages differ from the baseline — confirm each change, then '
    + 'refresh explicitly with: npm run drift -- --update');
  if (code === 3) out.push('previously-fingerprinted pages became unreachable — suspicious, '
    + 'investigate before trusting the rest of this report');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------- run

/** Full check. Options (all injectable for tests): registriesDir, baselineFile, allowlistFile,
 * update, json, fetchImpl, timeoutMs, retries, retryDelayMs, sleep, out, updatedAt. Returns
 * {code, report}. Throws on configuration errors (exit-2 class). */
async function run(options = {}) {
  const o = {
    registriesDir: REGISTRY_DIR,
    baselineFile: BASELINE_FILE,
    allowlistFile: ALLOWLIST_FILE,
    update: false,
    json: false,
    updatedAt: () => new Date().toISOString(),
    ...options,
  };
  const out = o.out || ((chunk) => process.stdout.write(chunk));

  const harnessesDoc = JSON.parse(fs.readFileSync(path.join(o.registriesDir, 'harnesses.json'), 'utf8'));
  const contractsDoc = JSON.parse(fs.readFileSync(path.join(o.registriesDir, 'contracts.json'), 'utf8'));
  const specs = buildWatchSpecs({ harnessesDoc, contractsDoc });

  const excluded = loadAllowlist(o.allowlistFile, specs.map((s) => s.id));
  const excludedIds = new Set(excluded.map((e) => e.id));
  const activeSpecs = specs.filter((s) => !excludedIds.has(s.id));

  const claimsByUrl = new Map();
  for (const spec of activeSpecs) {
    for (const url of spec.urls) {
      if (!claimsByUrl.has(url)) claimsByUrl.set(url, []);
      claimsByUrl.get(url).push(spec.id);
    }
  }
  const urls = [...claimsByUrl.keys()].sort();

  let baseline = {};
  try {
    baseline = JSON.parse(fs.readFileSync(o.baselineFile, 'utf8')).urls || {};
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) throw err; // absent baseline: everything reports NEW
  }

  const results = [];
  for (const url of urls) {
    const outcome = await fetchText(url, o);
    const prior = Object.prototype.hasOwnProperty.call(baseline, url) ? baseline[url] : undefined;
    const row = {
      url,
      status: null,
      claims: claimsByUrl.get(url),
      fingerprint: null,
      baselineFingerprint: typeof prior === 'string' ? prior : null,
      error: null,
      suspicious: false,
    };
    if (outcome.ok) {
      row.fingerprint = fingerprintText(normalizeText(outcome.body));
      if (typeof prior !== 'string') row.status = 'NEW';       // first sighting (or prior run was offline)
      else if (prior === row.fingerprint) row.status = 'OK';
      else row.status = 'DRIFTED';
    } else {
      row.status = 'UNREACHABLE';
      row.suspicious = typeof prior === 'string';
      row.error = `error: ${outcome.error && outcome.error.message}`;
    }
    results.push(row);
  }

  const staleUrlCount = Object.keys(baseline).filter((url) => !claimsByUrl.has(url)).length;
  const summary = summarize(results, excluded, staleUrlCount);

  if (o.update) {
    const doc = { version: 1, generator: 'scripts/check-format-drift.js', updatedAt: o.updatedAt(), urls: {} };
    for (const row of results) doc.urls[row.url] = row.fingerprint; // null marks unreachable-at-baseline
    fs.mkdirSync(path.dirname(o.baselineFile), { recursive: true });
    fs.writeFileSync(o.baselineFile, `${JSON.stringify(doc, null, 2)}\n`);
  }

  const report = { summary, results, excluded, specs: activeSpecs };
  const code = o.update ? 0 : exitCodeFor(summary);
  out(o.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderHuman(report)}\n`);
  return { code, report };
}

// ----------------------------------------------------------------------------------------------- cli

function parseArgs(argv) {
  const flags = { json: false, update: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') flags.json = true;
    else if (arg === '--update') flags.update = true;
    else if (arg === '-h' || arg === '--help') flags.help = true;
    else throw new Error(`usage: node scripts/check-format-drift.js [--json] [--update] (unexpected: ${arg})`);
  }
  return flags;
}

module.exports = {
  buildWatchSpecs, loadAllowlist, normalizeText, fingerprintText, fetchText, parseArgs, run,
  REPO, BASELINE_FILE, ALLOWLIST_FILE,
};

if (require.main === module) {
  const flags = { help: false };
  try {
    Object.assign(flags, parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(String(err.message));
    process.exitCode = 2;
    process.exit(2);
  }
  if (flags.help) {
    console.log('usage: node scripts/check-format-drift.js [--json] [--update]');
    console.log('  --json     machine-readable report on stdout');
    console.log('  --update   rewrite scripts/drift/baseline.json from this run (explicit only)');
    process.exit(0);
  }
  run({ update: flags.update, json: flags.json })
    .then(({ code }) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`check-format-drift: ${err && err.stack || err}`);
      process.exit(2);
    });
}

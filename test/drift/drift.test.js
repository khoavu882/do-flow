'use strict';

// Stage 5 — unit coverage for scripts/check-format-drift.js (upstream format-drift watcher).
//
// Network discipline: nothing here touches the external network. Every HTTP interaction either
// goes through an injected fetchImpl stub or through a node:http server bound to 127.0.0.1 on an
// ephemeral port serving canned pages. That is what makes `npm test` deterministic and offline.
//
// Covered: fingerprint determinism under cosmetic churn, watch-spec derivation from the registry
// family, OK / DRIFTED / NEW / UNREACHABLE outcomes and their exit codes, retry + timeout paths,
// multi-page evidence keyed per url, allowlist exclusion (and its default-deny validation), and
// explicit-only --update behavior.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildWatchSpecs,
  loadAllowlist,
  normalizeText,
  fingerprintText,
  fetchText,
  parseArgs,
  run,
} = require('../../scripts/check-format-drift.js');

// ------------------------------------------------------------------------------ fixtures

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-drift-'));
}

/** Canned doc page; `noise` adds exactly the churn normalization must absorb. */
function page(paras, { noise = false } = {}) {
  if (!noise) {
    return `<!doctype html><html><head><title>t</title>`
      + `<style>.x{color:red}</style></head><body>`
      + paras.map((p) => `<p>${p}</p>`).join('')
      + `</body></html>`;
  }
  return `
    <!doctype html>
    <html>
      <head><title>t</title><script>var buildHash="abc123";</script></head>
      <body>
        <!-- nav rendered by site generator -->
        ${paras.map((p) => `<p>\n   ${p}\n  </p>`).join('\n')}
        <p>Last updated: 2026-08-23</p>
        <footer>&copy; 2026 ExampleCorp. All rights reserved.</footer>
      </body>
    </html>`;
}

/** Minimal stand-ins for core/registry/{harnesses,contracts}.json pointing at a loopback origin. */
function writeFixtureRegistries(dir, origin) {
  const harnessesDoc = {
    version: 1,
    harnesses: [
      {
        id: 'h1',
        displayName: 'Harness One',
        adapter: 'h1',
        capabilities: {
          skills: { status: 'supported', evidence: [`${origin}/stable`, `${origin}/stable-dup`] },
          modes: { status: 'supported', evidence: [`${origin}/stable`] }, // duplicate url, distinct claim
          hooks: { status: 'different', evidence: [`${origin}/mutable`] }, // allowlist target below
          agents: { status: 'unavailable' }, // no evidence array -> must be skipped
        },
      },
      {
        id: 'h2',
        displayName: 'Harness Two',
        adapter: 'h2',
        capabilities: {
          instructions: { status: 'supported', evidence: [`${origin}/multi-b`] },
        },
      },
    ],
  };
  const contractsDoc = {
    version: 1,
    contracts: [
      {
        harness: 'h1',
        completeness: 'lower-bound',
        hookEvents: ['PreToolUse'],
        evidence: [`${origin}/stable-dup`], // multi-page claim: stable + stable-dup
      },
      { harness: 'h9', completeness: 'lower-bound' }, // no evidence -> skipped
    ],
  };
  fs.writeFileSync(path.join(dir, 'harnesses.json'), JSON.stringify(harnessesDoc));
  fs.writeFileSync(path.join(dir, 'contracts.json'), JSON.stringify(contractsDoc));
  return { harnessesDoc, contractsDoc };
}

/** Loopback-only canned-page server with per-path hit counts. Never binds anything but 127.0.0.1. */
async function startServer(routes) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    hits.set(pathname, (hits.get(pathname) || 0) + 1);
    const route = routes[pathname];
    if (!route) { res.writeHead(404); res.end('not found'); return; }
    if (route.stallMs) { // hold the answer back so an injected timeout must fire first
      res.on('close', () => {});
      setTimeout(() => { try { res.writeHead(200); res.end('too late'); } catch { /* aborted */ } }, route.stallMs);
      return;
    }
    if (route.failFirst && hits.get(pathname) <= route.failFirst) {
      res.writeHead(500); res.end('transient boom'); return;
    }
    res.writeHead(route.status || 200, { 'content-type': 'text/html' });
    res.end(typeof route.body === 'function' ? route.body() : route.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    hits,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** run() wired to throwaway files and a stdout sink. */
function runIn(tmpDir, { routes, origin, ...options }) {
  const registriesDir = path.join(tmpDir, 'registry');
  fs.mkdirSync(registriesDir, { recursive: true });
  writeFixtureRegistries(registriesDir, origin);
  const printed = [];
  return run({
    registriesDir,
    baselineFile: path.join(tmpDir, 'baseline.json'),
    allowlistFile: path.join(tmpDir, 'allowlist.json'),
    out: (chunk) => printed.push(chunk),
    retryDelayMs: 0,
    ...options,
  }).then((result) => ({ ...result, printed }));
}

// ----------------------------------------------------------------------- normalization + fingerprints

test('fingerprints ignore whitespace, dates, copyright, script/style churn', () => {
  const clean = page(['Alpha rule applies', 'Beta gate blocks writes']);
  const noisy = page(['Alpha rule applies', 'Beta gate blocks writes'], { noise: true });
  assert.equal(fingerprintText(normalizeText(clean)), fingerprintText(normalizeText(noisy)));
});

test('fingerprints change when real content changes', () => {
  const before = fingerprintText(normalizeText(page(['Alpha rule applies'])));
  const after = fingerprintText(normalizeText(page(['Alpha rule applies everywhere'])));
  assert.notEqual(before, after);
});

test('normalization is deterministic across invocations', () => {
  const raw = page(['Deterministic output'], { noise: true });
  assert.equal(normalizeText(raw), normalizeText(raw));
});

// ----------------------------------------------------------------------------------- spec derivation

test('watch specs derive from both registries, dedupe urls, skip evidence-less rows', () => {
  const { harnessesDoc, contractsDoc } = writeFixtureRegistries(makeTempDir(), 'http://127.0.0.1:0');
  const specs = buildWatchSpecs({ harnessesDoc, contractsDoc });
  const byId = Object.fromEntries(specs.map((s) => [s.id, s]));

  // capability rows, contract row, deduped+sorted urls, evidence-less rows skipped
  assert.deepEqual(specs.map((s) => s.id), [
    'contracts:h1',
    'harnesses:h1:hooks',
    'harnesses:h1:modes',
    'harnesses:h1:skills',
    'harnesses:h2:instructions',
  ]);
  assert.deepEqual(byId['harnesses:h1:skills'].urls, ['http://127.0.0.1:0/stable', 'http://127.0.0.1:0/stable-dup']);
  assert.ok(byId['harnesses:h1:agents'] === undefined);
  assert.ok(byId['contracts:h9'] === undefined);
});

test('the real registries still derive a healthy watch list, and the shipped allowlist matches it', () => {
  // Pure-filesystem: proves derivation survives registry evolution and that no allowlist entry
  // has gone stale (a renamed harness/capability would otherwise silently stop being excluded).
  const { REPO, ALLOWLIST_FILE } = require('../../scripts/check-format-drift.js');
  const harnessesDoc = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8'));
  const contractsDoc = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'contracts.json'), 'utf8'));
  const specs = buildWatchSpecs({ harnessesDoc, contractsDoc });
  const urls = new Set(specs.flatMap((s) => s.urls));

  assert.ok(specs.length > 50, `expected the full claim set, got ${specs.length}`);
  assert.ok(urls.size > 30 && urls.size < specs.length, 'url deduplication should collapse shared evidence');
  for (const spec of specs) {
    assert.ok(spec.claim && spec.urls.every((u) => /^https:\/\//.test(u)), `${spec.id} is malformed`);
  }
  loadAllowlist(ALLOWLIST_FILE, specs.map((s) => s.id)); // throws if stale or reason-less
});

// ---------------------------------------------------------------------------------------- allowlist

test('allowlisted claims are neither fetched nor watched, and carry their reason', async () => {
  const tmpDir = makeTempDir();
  const server = await startServer({
    '/stable': { body: page(['Alpha rule applies']) },
    '/stable-dup': { body: page(['Shared evidence page']) },
    '/mutable': { body: page(['Hooks payload']) },
    '/multi-b': { body: page(['Second harness']) },
  });
  try {
    fs.writeFileSync(path.join(tmpDir, 'allowlist.json'), JSON.stringify({
      excluded: [{ id: 'harnesses:h1:hooks', reason: '#21 payload schemas session-gated' }],
    }));
    const { code, report } = await runIn(tmpDir, { origin: server.origin });
    assert.equal(code, 0);
    assert.equal(report.summary.excludedClaims, 1);
    assert.equal(report.excluded[0].reason, '#21 payload schemas session-gated');
    assert.ok(report.specs.every((s) => s.id !== 'harnesses:h1:hooks'), 'excluded claim must not be watched');
    assert.equal(server.hits.get('/mutable') || 0, 0, 'excluded claim url must never be fetched');
    assert.ok(report.results.every((r) => r.url !== `${server.origin}/mutable`));
  } finally {
    await server.close();
  }
});

test('allowlist additions are default-deny: no reason, or a stale id, is a hard error', async () => {
  const specIds = ['harnesses:h1:skills'];
  const file = path.join(makeTempDir(), 'allowlist.json');

  fs.writeFileSync(file, JSON.stringify({ excluded: [{ id: 'harnesses:h1:skills' }] }));
  assert.throws(() => loadAllowlist(file, specIds), /non-empty "reason"/);

  fs.writeFileSync(file, JSON.stringify({ excluded: [{ id: 'gone:claim', reason: 'why' }] }));
  assert.throws(() => loadAllowlist(file, specIds), /names no claim/);

  fs.writeFileSync(file, JSON.stringify({ notExcluded: [] }));
  assert.throws(() => loadAllowlist(file, specIds), /must hold/);

  fs.writeFileSync(file, JSON.stringify({ excluded: [{ id: 'harnesses:h1:skills', reason: 'fine' }] }));
  assert.deepEqual(loadAllowlist(file, specIds), [{ id: 'harnesses:h1:skills', reason: 'fine' }]);
});

// ------------------------------------------------------------------------------------- end-to-end

test('seed via --update, then a read-only run reports OK and leaves the baseline byte-identical', async () => {
  const tmpDir = makeTempDir();
  const server = await startServer({
    '/stable': { body: page(['Alpha rule applies']) },
    '/stable-dup': { body: page(['Shared evidence page']) },
    '/mutable': { body: page(['Hooks payload']) },
    '/multi-b': { body: page(['Second harness']) },
  });
  try {
    const seeded = await runIn(tmpDir, { origin: server.origin, update: true });
    assert.equal(seeded.code, 0);
    const baselineFile = path.join(tmpDir, 'baseline.json');
    const before = fs.readFileSync(baselineFile);

    const check = await runIn(tmpDir, { origin: server.origin });
    assert.equal(check.code, 0);
    assert.ok(check.report.results.every((r) => r.status === 'OK'), 'every watched url should be OK');
    assert.equal(check.report.results.length, 4); // stable, stable-dup, mutable, multi-b
    assert.deepEqual([...check.report.results.map((r) => r.url)].sort(), [...new Set([
      `${server.origin}/stable`, `${server.origin}/stable-dup`,
      `${server.origin}/mutable`, `${server.origin}/multi-b`,
    ])].sort());
    assert.ok(fs.readFileSync(baselineFile).equals(before), 'read-only run must not touch the baseline');
  } finally {
    await server.close();
  }
});

test('changed page content names the drifted url + claims and exits 1', async () => {
  const tmpDir = makeTempDir();
  let mutableBody = page(['Hooks payload v1']);
  const server = await startServer({
    '/stable': { body: page(['Alpha rule applies']) },
    '/stable-dup': { body: page(['Shared evidence page']) },
    '/mutable': { get body() { return mutableBody; } },
    '/multi-b': { body: page(['Second harness']) },
  });
  try {
    await runIn(tmpDir, { origin: server.origin, update: true });
    mutableBody = page(['Hooks payload v2 — decision schema changed']);

    const { code, report } = await runIn(tmpDir, { origin: server.origin, json: true });
    assert.equal(code, 1);
    const row = report.results.find((r) => r.url === `${server.origin}/mutable`);
    assert.equal(row.status, 'DRIFTED');
    assert.deepEqual(row.claims, ['harnesses:h1:hooks']);
    assert.notEqual(row.fingerprint, row.baselineFingerprint);
    assert.equal(report.summary.drifted, 1);
    assert.ok(report.results.filter((r) => r.status !== 'DRIFTED').length === report.results.length - 1,
      'only the changed page drifts');
  } finally {
    await server.close();
  }
});

test('--update is the only path that rewrites the baseline (and accepts a drift)', async () => {
  const tmpDir = makeTempDir();
  let mutableBody = page(['Hooks payload v1']);
  const server = await startServer({
    '/stable': { body: page(['Alpha rule applies']) },
    '/stable-dup': { body: page(['Shared evidence page']) },
    '/mutable': { get body() { return mutableBody; } },
    '/multi-b': { body: page(['Second harness']) },
  });
  try {
    await runIn(tmpDir, { origin: server.origin, update: true });
    mutableBody = page(['Hooks payload v2']);
    assert.equal((await runIn(tmpDir, { origin: server.origin })).code, 1);

    const updated = await runIn(tmpDir, { origin: server.origin, update: true });
    assert.equal(updated.code, 0, '--update accepts the observed state');
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'baseline.json'))).urls[`${server.origin}/mutable`],
      updated.report.results.find((r) => r.url === `${server.origin}/mutable`).fingerprint);

    assert.equal((await runIn(tmpDir, { origin: server.origin })).code, 0, 'back to green');
  } finally {
    await server.close();
  }
});

test('NEW urls (absent from baseline) are listed but stay exit 0', async () => {
  const tmpDir = makeTempDir();
  const server = await startServer({
    '/stable': { body: page(['Alpha rule applies']) },
    '/stable-dup': { body: page(['Shared evidence page']) },
    '/mutable': { body: page(['Hooks payload']) },
    '/multi-b': { body: page(['Second harness']) },
  });
  try {
    // Seed a baseline covering only part of the watch list, then check against the full list.
    fs.writeFileSync(path.join(tmpDir, 'baseline.json'), JSON.stringify({
      version: 1, urls: { [`${server.origin}/stable`]: fingerprintText(normalizeText(page(['Alpha rule applies']))) },
    }));
    const { code, report } = await runIn(tmpDir, { origin: server.origin });
    assert.equal(code, 0);
    assert.equal(report.results.find((r) => r.url === `${server.origin}/stable`).status, 'OK');
    assert.equal(report.summary.new_, 3);
    assert.ok(report.results.filter((r) => r.status === 'NEW').every((r) => r.baselineFingerprint === null));
  } finally {
    await server.close();
  }
});

test('UNREACHABLE is benign for never-seen urls (exit 0) and suspicious for known ones (exit 3)', async () => {
  const tmpDir = makeTempDir();
  const alwaysFail = async () => { throw new Error('ECONNREFUSED'); };
  const baselineFile = path.join(tmpDir, 'baseline.json');
  const registriesDir = path.join(tmpDir, 'registry');
  fs.mkdirSync(registriesDir);
  writeFixtureRegistries(registriesDir, 'http://127.0.0.1:1'); // nothing listens there

  const cold = await run({ registriesDir, baselineFile, allowlistFile: path.join(tmpDir, 'allowlist.json'),
    fetchImpl: alwaysFail, out: () => {}, retryDelayMs: 0 });
  assert.equal(cold.code, 0, 'cold unreachability must not spam red');
  assert.ok(cold.report.results.every((r) => r.status === 'UNREACHABLE' && !r.suspicious));

  fs.writeFileSync(baselineFile, JSON.stringify({
    version: 1,
    urls: { 'http://127.0.0.1:1/stable': 'sha256:' + 'a'.repeat(64) },
  }));
  const warm = await run({ registriesDir, baselineFile, allowlistFile: path.join(tmpDir, 'allowlist.json'),
    fetchImpl: alwaysFail, out: () => {}, retryDelayMs: 0 });
  assert.equal(warm.code, 3, 'previously-fingerprinted pages going dark is its own signal');
  const row = warm.report.results.find((r) => r.url === 'http://127.0.0.1:1/stable');
  assert.equal(row.suspicious, true);
});

// ------------------------------------------------------------------------------ transport behaviour

test('retries ride out transient failures', async () => {
  const tmpDir = makeTempDir();
  const calls = [];
  const flaky = async (url) => {
    calls.push(url);
    if (calls.length <= 2) throw new Error('HTTP 500');
    return { ok: true, status: 200, text: async () => page(['Recovered']) };
  };
  const outcome = await fetchText('https://example.test/flaky', { fetchImpl: flaky, sleep: async () => {} });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 3, 'initial attempt + 2 retries');
});

test('hard timeout turns a stalling server into a clean UNREACHABLE', async () => {
  const server = await startServer({ '/stall': { stallMs: 1000 } });
  try {
    const outcome = await fetchText(`${server.origin}/stall`, { timeoutMs: 80, retries: 1, retryDelayMs: 1 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /timed out after 80ms/);
  } finally {
    await server.close();
  }
});

test('a multi-page claim fingerprints each evidence url separately in the baseline', async () => {
  const tmpDir = makeTempDir();
  const server = await startServer({
    '/stable': { body: page(['Alpha rule applies']) },
    '/stable-dup': { body: page(['Shared evidence page']) },
    '/mutable': { body: page(['Hooks payload']) },
    '/multi-b': { body: page(['Second harness']) },
  });
  try {
    await runIn(tmpDir, { origin: server.origin, update: true });
    const urls = JSON.parse(fs.readFileSync(path.join(tmpDir, 'baseline.json'))).urls;
    assert.deepEqual(Object.keys(urls).sort(), [
      `${server.origin}/multi-b`,
      `${server.origin}/mutable`,
      `${server.origin}/stable`,
      `${server.origin}/stable-dup`,
    ]);
    assert.ok(Object.values(urls).every((fp) => /^sha256:[0-9a-f]{64}$/.test(fp)));
    assert.notEqual(urls[`${server.origin}/stable`], urls[`${server.origin}/stable-dup`]);
  } finally {
    await server.close();
  }
});

// -------------------------------------------------------------------------------------------- cli

test('cli flags: strict parsing, --json/--update recognized', () => {
  assert.deepEqual(parseArgs(['--json']), { json: true, update: false, help: false });
  assert.deepEqual(parseArgs(['--update', '--json']), { json: true, update: true, help: false });
  assert.throws(() => parseArgs(['--force']), /usage:/);
});

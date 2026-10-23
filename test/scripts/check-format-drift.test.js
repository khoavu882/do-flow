'use strict';

// Upstream format-drift watcher (docs/architecture.md#upstream-format-drift-watcher): the
// fingerprint covers the page's main content only, and a DRIFTED row carries a unified diff
// against a stored text snapshot. Everything runs on the injectable fetchImpl: no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const drift = require('../../scripts/check-format-drift.js');

const URL_A = 'https://docs.example.test/a';

function page({ nav = 'Home | Docs', main = '<p>Hooks use stdin JSON.</p>', wrap = 'main' } = {}) {
  const body = wrap === 'main' ? `<main>${main}</main>`
    : wrap === 'article' ? `<article>${main}</article>`
      : wrap === 'role' ? `<div role="main">${main}</div>`
        : main;
  return `<html><body><nav>${nav}</nav>${body}<footer>Terms</footer></body></html>`;
}

/** A scratch workspace: one-claim registries, an empty allowlist, and a swappable fake site. */
function setup(t, html) {
  const dir = tempDir(t, 'doflow-drift-');
  const registriesDir = path.join(dir, 'registry');
  fs.mkdirSync(registriesDir);
  fs.writeFileSync(path.join(registriesDir, 'harnesses.json'), JSON.stringify({
    harnesses: [{ id: 'h', displayName: 'H', capabilities: { hooks: { status: 'native', evidence: [URL_A] } } }],
  }));
  fs.writeFileSync(path.join(registriesDir, 'contracts.json'), JSON.stringify({ contracts: [] }));
  const site = { html };
  const env = {
    registriesDir,
    baselineFile: path.join(dir, 'drift', 'baseline.json'),
    allowlistFile: path.join(dir, 'no-allowlist.json'),
    snapshotDir: path.join(dir, 'drift', 'snapshots'),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => site.html }),
    retries: 0,
    retryDelayMs: 0,
    out: () => {},
    updatedAt: () => '2026-01-01T00:00:00.000Z',
  };
  return { dir, site, env, check: (extra = {}) => drift.run({ ...env, ...extra }) };
}

const rowOf = (result) => result.report.results[0];

test('a nav change around an unchanged <main> stays OK', async (t) => {
  const s = setup(t, page());
  await s.check({ update: true });
  s.site.html = page({ nav: 'Home | Docs | Blog | Pricing (new sidebar)' });
  const result = await s.check();
  assert.equal(rowOf(result).status, 'OK');
  assert.equal(rowOf(result).extractor, 'main');
  assert.equal(result.code, 0);
});

test('a <main> text change is DRIFTED and carries a unified diff, in the --json report too', async (t) => {
  const s = setup(t, page({ main: '<p>Hooks use stdin JSON.</p><p>Timeout 60s.</p>' }));
  await s.check({ update: true });
  s.site.html = page({ main: '<p>Hooks use stdin JSON.</p><p>Timeout 30s.</p>' });
  const chunks = [];
  const result = await s.check({ json: true, out: (c) => chunks.push(c) });
  const row = rowOf(result);
  assert.equal(row.status, 'DRIFTED');
  assert.equal(result.code, 1);
  assert.match(row.diff, /^--- baseline$/m);
  assert.match(row.diff, /^-Timeout 60s\.$/m);
  assert.match(row.diff, /^\+Timeout 30s\.$/m);
  assert.match(row.diff, /^ Hooks use stdin JSON\.$/m);
  const json = JSON.parse(chunks.join(''));
  assert.equal(json.results[0].diff, row.diff);
  assert.equal(json.results[0].extractor, 'main');
});

test('without <main> the extractor falls back to <article>, role=main, then the whole page', async (t) => {
  for (const [wrap, extractor] of [['article', 'article'], ['role', 'role=main'], ['none', 'page']]) {
    const s = setup(t, page({ wrap }));
    const first = await s.check({ update: true });
    assert.equal(rowOf(first).extractor, extractor, wrap);
    s.site.html = page({ wrap, nav: 'Changed nav' });
    const second = await s.check();
    // Only the whole-page fallback sees the nav, so only it drifts.
    assert.equal(rowOf(second).status, wrap === 'none' ? 'DRIFTED' : 'OK', wrap);
  }
});

test('extractMain takes the first complete block, skips tags inside scripts, and falls through on junk', () => {
  const nested = '<div><main>one<main>two</main>three</main>after</div>';
  assert.equal(drift.extractMain(nested).extractor, 'main');
  assert.match(drift.normalizeContent(nested).text, /^one\ntwo\nthree$/);
  const inScript = '<script>var s = "<main>fake</main>";</script><article>real</article>';
  assert.deepEqual(drift.normalizeContent(inScript), { extractor: 'article', text: 'real' });
  // An unterminated <main> and an empty <main> are not trusted: the next rule decides.
  assert.equal(drift.normalizeContent('<main>cut off<article>x</article>').extractor, 'article');
  assert.equal(drift.normalizeContent('<main> </main><p>whole page</p>').extractor, 'page');
  assert.equal(drift.normalizeContent('<mainframe>no</mainframe><p>y</p>').extractor, 'page');
  assert.equal(drift.normalizeContent('plain text, no tags').extractor, 'page');
});

test('role=main matches the role attribute, not data-role or aria-role', () => {
  const html = '<div data-role="main">WRONG</div><div aria-role="main">WRONG</div><div role="main">RIGHT</div>';
  assert.deepEqual(drift.normalizeContent(html), { extractor: 'role=main', text: 'RIGHT' });
  assert.equal(drift.normalizeContent('<div data-role="main">only a data attribute</div>').extractor, 'page');
  assert.equal(drift.normalizeContent("<section id=x role='main'>quoted</section>").extractor, 'role=main');
});

test('a baseline written by the old reader (hash strings only) is compared on the whole page', async (t) => {
  const s = setup(t, page());
  fs.mkdirSync(path.dirname(s.env.baselineFile), { recursive: true });
  fs.writeFileSync(s.env.baselineFile, JSON.stringify({
    version: 1, generator: 'scripts/check-format-drift.js', updatedAt: 'old',
    urls: { [URL_A]: drift.fingerprintText(drift.normalizeText(page())) },
  }));
  const same = await s.check();
  assert.equal(rowOf(same).status, 'OK', 'no false drift on the first run after the extractor change');
  assert.equal(rowOf(same).extractor, 'page');
  s.site.html = page({ nav: 'Changed nav' });
  const changed = await s.check();
  assert.equal(rowOf(changed).status, 'DRIFTED');
  assert.equal(rowOf(changed).diff, null, 'no snapshot for a legacy entry');
  await s.check({ update: true });
  const doc = JSON.parse(fs.readFileSync(s.env.baselineFile, 'utf8'));
  assert.equal(doc.extractors[URL_A], 'main', 'update migrates the entry to the new extractor');
  assert.equal(typeof doc.urls[URL_A], 'string', 'urls keeps the old string shape');
});

test('snapshots are capped: the file stays within SNAPSHOT_MAX_BYTES and a change past the cap still drifts', async (t) => {
  const lines = (n, tail) => Array.from({ length: n }, (_, i) => `<p>line ${i} ${'x'.repeat(40)}</p>`).join('') + tail;
  const s = setup(t, page({ main: lines(2000, '<p>tail A</p>') }));
  await s.check({ update: true });
  const files = fs.readdirSync(s.env.snapshotDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{40}\.txt$/);
  const snap = fs.readFileSync(path.join(s.env.snapshotDir, files[0]), 'utf8');
  assert.ok(Buffer.byteLength(snap) <= drift.SNAPSHOT_MAX_BYTES, `snapshot is ${Buffer.byteLength(snap)} bytes`);
  assert.match(snap.trimEnd(), /\[snapshot truncated\]$/);
  assert.match(snap, /^line 0 /);

  s.site.html = page({ main: lines(2000, '<p>tail B</p>') });
  const beyond = rowOf(await s.check());
  assert.equal(beyond.status, 'DRIFTED', 'the hash covers the full text');
  assert.equal(beyond.diff, '', 'the change lies past the stored snapshot, so there is nothing to show');

  s.site.html = page({ main: lines(2000, '<p>tail A</p>').replace('line 0 ', 'line zero ') });
  const within = rowOf(await s.check());
  assert.match(within.diff, /^-line 0 /m);
  assert.match(within.diff, /^\+line zero /m);
});

test('snapshots carry no home-directory path, and the diff ignores the redaction', () => {
  // Built from parts so this file itself holds no literal home path (guard G2).
  const home = (root, name) => ['', root, name, ''].join('/');
  const text = `cd ${home('Users', 'developer')}repo\nsee ${home('home', 'alice')}.config`;
  assert.equal(drift.capSnapshot(text), 'cd /Users/<name>/repo\nsee /home/<name>/.config');
  assert.equal(drift.unifiedDiff(drift.capSnapshot(text), drift.capSnapshot(text.replace('alice', 'bob'))), '');
});

test('an empty diff is reported as "no visible diff", covering the cap and redacted paths alike', async (t) => {
  const home = (name) => ['', 'Users', name, ''].join('/');
  const s = setup(t, page({ main: `<p>Run it from ${home('alice')}repo.</p>` }));
  await s.check({ update: true });
  s.site.html = page({ main: `<p>Run it from ${home('bob')}repo.</p>` });
  const chunks = [];
  const result = await s.check({ out: (c) => chunks.push(c) });
  assert.equal(rowOf(result).status, 'DRIFTED');
  assert.equal(rowOf(result).diff, '');
  const text = chunks.join('');
  assert.match(text, /no visible diff: change is beyond the 16384-byte snapshot cap or only in redacted paths/);
  assert.doesNotMatch(text, /change lies beyond/);
});

test('--update prunes snapshots of URLs that are no longer watched', async (t) => {
  const s = setup(t, page());
  fs.mkdirSync(s.env.snapshotDir, { recursive: true });
  const stale = path.join(s.env.snapshotDir, `${'0'.repeat(40)}.txt`);
  fs.writeFileSync(stale, 'old\n');
  await s.check({ update: true });
  assert.equal(fs.existsSync(stale), false);
  assert.deepEqual(fs.readdirSync(s.env.snapshotDir), [drift.snapshotName(URL_A)]);
});

test('--update keeps the fingerprint, extractor and snapshot of a URL that is unreachable during the update', async (t) => {
  const s = setup(t, page());
  await s.check({ update: true });
  const before = JSON.parse(fs.readFileSync(s.env.baselineFile, 'utf8'));
  const snapshotPath = path.join(s.env.snapshotDir, drift.snapshotName(URL_A));
  const snapshot = fs.readFileSync(snapshotPath, 'utf8');

  const down = await s.check({ update: true, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(rowOf(down).status, 'UNREACHABLE');
  const after = JSON.parse(fs.readFileSync(s.env.baselineFile, 'utf8'));
  assert.equal(after.urls[URL_A], before.urls[URL_A], 'fingerprint kept');
  assert.equal(after.extractors[URL_A], 'main', 'extractor kept');
  assert.equal(fs.readFileSync(snapshotPath, 'utf8'), snapshot, 'snapshot kept');

  s.site.html = page({ main: '<p>Hooks changed while the update was offline.</p>' });
  const back = rowOf(await s.check());
  assert.equal(back.status, 'DRIFTED', 'a change made during the outage is still reported, not turned into NEW');
  assert.match(back.diff, /^-Hooks use stdin JSON\.$/m);
});

test('--update still records null for a URL that was never fingerprinted and is unreachable', async (t) => {
  const s = setup(t, page());
  const down = await s.check({ update: true, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(rowOf(down).status, 'UNREACHABLE');
  const doc = JSON.parse(fs.readFileSync(s.env.baselineFile, 'utf8'));
  assert.equal(doc.urls[URL_A], null);
  assert.equal(URL_A in doc.extractors, false);
});

test('unifiedDiff renders hunks with context and caps a long diff', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
  const b = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h'].join('\n');
  assert.equal(drift.unifiedDiff(a, b), [
    '--- baseline', '+++ current', '@@ -3,5 +3,5 @@', ' c', ' d', '-e', '+E', ' f', ' g',
  ].join('\n'));
  assert.equal(drift.unifiedDiff(a, a), '');
  const big = drift.unifiedDiff('x', Array.from({ length: 500 }, (_, i) => `n${i}`).join('\n'));
  assert.ok(big.split('\n').length <= drift.DIFF_MAX_LINES + 3);
  assert.match(big, /\(\d+ more diff lines\)$/);
});

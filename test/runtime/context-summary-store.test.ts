'use strict';

// 078 C.2 (IC-010, IC-012, IC-013 in process): the TypeScript summary store and grantSummary(), and
// its parity with the bash store policies/summary-store.sh: a bash-written summary claimed by
// TypeScript, the reverse, and a TypeScript grant claimed by bash. Bash runs as macOS /bin/bash 3.2.

const { test }: any = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const {
  DEFAULT_GRANT_MAX_BYTES, SUMMARY_ID_PATTERN, SummaryStoreError,
  adoptLegacy, claimGrant, claimSummary, grantSummary, legacySummary, peekGrant, peekSummary, releaseClaim, summaryScope,
} = require('../../src/runtime/context/summary-store.ts');
const { writeSummary } = require('../helper/summary-fixture.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const REPO = path.resolve(__dirname, '..', '..');
const POLICIES = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies');
const LIB = path.join(POLICIES, 'lib.sh');
const STORE = path.join(POLICIES, 'summary-store.sh');
const BASH = process.platform === 'darwin' ? '/bin/bash' : 'bash';
const AT = '2026-10-14T10:00:00Z';

const scratch = createScratch('doflow-ts-summary-store-');
const ENV = scratch.env();
const ROOT = path.join(scratch.xdg, 'doflow', 'session-env');
test.after(() => scratch.remove());

let seq = 0;
function worktree() {
  const d = path.join(scratch.dir, `wt${seq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A fresh (run, lineage) recipient per test, so grants never collide across tests. */
function recipient() {
  seq += 1;
  return { toRun: `r-${seq}`, toLineage: `w-${seq}` };
}

function bash(body: any, args: any = []) {
  const script = `set -euo pipefail\n. "${LIB}"\n. "${STORE}"\n${body}`;
  const r = spawnSync(BASH, ['-c', script, 'summary-store-parity', ...args], { env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out: any = {};
  for (const line of r.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

function write(wt: any, extra: any = {}) {
  return writeSummary({ worktree: wt, run: 'local', lineage: 'main', compactedAt: AT, sessionId: 'sess-w', trigger: 'auto', branch: 'topic', role: 'main', body: 'the body', env: ENV, ...extra });
}

function grant(wt: any, to: any, extra: any = {}) {
  return grantSummary({ summary: 'pending', fromWorktree: wt, fromRun: 'local', fromLineage: 'main', env: ENV, ...to, ...extra });
}

function refusal(fn: any, code: any, exitCode: any) {
  assert.throws(fn, (error: any) => error instanceof SummaryStoreError && error.code === code && error.exitCode === exitCode);
}

test('writeSummary writes the IC-010 record under the scope, attempt empty when unset', () => {
  const wt = worktree();
  const written = write(wt);
  assert.match(written.summaryId, SUMMARY_ID_PATTERN);
  assert.ok(written.summaryId.startsWith('s-20261014T100000Z-'));
  const scope = path.join(ROOT, 'summaries', cwdHash(wt), 'local', 'main');
  assert.equal(written.path, path.join(scope, 'summary.md'));
  assert.equal(fs.readFileSync(written.path, 'utf8'),
    `---\ncompacted_at: ${AT}\nsession_id: sess-w\ntrigger: auto\nbranch: topic\nrole: main\nsummary_id: ${written.summaryId}\nrun: local\nlineage: main\nattempt:\nworktree: ${wt}\n---\n\nthe body\n`);
  assert.deepEqual(fs.readdirSync(scope), ['summary.md']);
  assert.match(fs.readFileSync(write(wt, { attempt: '2' }).path, 'utf8'), /\nattempt: 2\n/);
});

test('writeSummary refuses bad input and solo, leaving nothing behind', () => {
  const wt = worktree();
  assert.equal(write(wt, { body: '' }), null);
  assert.equal(write(wt, { compactedAt: '2026-10-14 10:00:00' }), null);
  assert.equal(write(wt, { attempt: '0' }), null);
  assert.equal(write(wt, { lineage: 'solo' }), null);
  assert.equal(write(wt, { run: 'bad/run' }), null);
  assert.equal(summaryScope(wt, 'local', 'solo', ENV), null);
  assert.equal(fs.existsSync(path.join(ROOT, 'summaries', cwdHash(wt))), false);
  // A line break in a value cannot forge a frontmatter key.
  const forged = fs.readFileSync(write(wt, { branch: 'x\nsession_id: evil' }).path, 'utf8');
  assert.match(forged, /\nbranch: x session_id: evil\n/);
});

test('claimSummary claims once by rename; own-write keeps the file; a later write survives', () => {
  const wt = worktree();
  write(wt);
  assert.equal(peekSummary(wt, 'local', 'main', 'sess-w', ENV).own, 'own-write');
  assert.equal(claimSummary(wt, 'local', 'main', 'sess-w', 'sess-w', ENV).claimed, null);
  const first = claimSummary(wt, 'local', 'main', 'sess-r', 'sess-r', ENV);
  assert.equal(first.own, 'pending');
  assert.equal(first.claimed, path.join(path.dirname(first.claimed), '.claimed.sess-r'));
  assert.match(fs.readFileSync(first.claimed, 'utf8'), /\n\nthe body\n$/);
  assert.equal(claimSummary(wt, 'local', 'main', 'sess-x', 'sess-x', ENV).own, 'none');
  write(wt, { body: 'newer' });
  assert.equal(peekSummary(wt, 'local', 'main', 'sess-r', ENV).own, 'pending');
});

test('claimSummary ignores a symlinked summary.md and cuts a large claim to 65536 bytes', () => {
  const wt = worktree();
  const scope = summaryScope(wt, 'local', 'main', ENV);
  fs.mkdirSync(scope, { recursive: true });
  const target = path.join(scratch.dir, `target-${seq}.md`);
  fs.writeFileSync(target, '---\nsession_id: x\n---\n\nbody\n');
  fs.symlinkSync(target, path.join(scope, 'summary.md'));
  assert.equal(claimSummary(wt, 'local', 'main', 'sess-r', 'sess-r', ENV).own, 'none');
  fs.unlinkSync(path.join(scope, 'summary.md'));
  write(wt, { body: 'x'.repeat(70000) });
  const claimed = claimSummary(wt, 'local', 'main', 'sess-r', 'sess-r', ENV);
  assert.ok(claimed.bytes > 70000);
  assert.equal(fs.statSync(claimed.claimed).size, 65536);
});

test('grantSummary copies the body into the IC-013 record and leaves the owner summary untouched', () => {
  const wt = worktree();
  const written = write(wt, { body: 'grant me — ü' });
  const before = fs.readFileSync(written.path);
  const to = recipient();
  const result = grant(wt, to, { now: new Date('2026-10-14T10:05:00.123Z') });
  assert.equal(result.summaryId, written.summaryId);
  assert.equal(result.path, path.join(ROOT, 'grants', to.toRun, to.toLineage, `${written.summaryId}.md`));
  assert.equal(result.bytes, Buffer.byteLength('grant me — ü'));
  assert.equal(fs.readFileSync(result.path, 'utf8'),
    `---\nsummary_id: ${written.summaryId}\ngranted_at: 2026-10-14T10:05:00Z\nfrom_worktree: ${wt}\nfrom_run: local\nfrom_lineage: main\nto_run: ${to.toRun}\nto_lineage: ${to.toLineage}\ncompacted_at: ${AT}\nbranch: topic\nbytes: ${result.bytes}\n---\n\ngrant me — ü\n`);
  assert.deepEqual(fs.readFileSync(written.path), before, 'owner summary is untouched');
  assert.deepEqual(fs.readdirSync(path.dirname(result.path)), [`${written.summaryId}.md`], 'no temporary left');
  assert.equal(peekSummary(wt, 'local', 'main', 'sess-r', ENV).own, 'pending', 'owner can still claim');
  // By id, to a second recipient.
  assert.equal(grant(wt, recipient(), { summary: written.summaryId }).summaryId, written.summaryId);
});

test('grantSummary refusals carry the IC-013 codes and exits, before any write', () => {
  const wt = worktree();
  const to = recipient();
  const grantDir = path.join(ROOT, 'grants', to.toRun, to.toLineage);
  refusal(() => grant(wt, to), 'summary-not-found', 1);
  const written = write(wt, { body: 'b'.repeat(200) });
  refusal(() => grant(wt, to, { summary: 'nope' }), 'usage', 2);
  refusal(() => grant(wt, { toRun: 'bad/run', toLineage: 'w' }), 'usage', 2);
  refusal(() => grant(wt, to, { maxBytes: 0 }), 'usage', 2);
  refusal(() => grant(wt, to, { fromLineage: 'solo' }), 'usage', 2);
  refusal(() => grant(wt, to, { summary: 's-20000101T000000Z-AAAAAA' }), 'summary-not-found', 1);
  // The rendered segment: header + "\n" + 200 body bytes.
  const header = '[Granted summary from lineage main, compacted 2026-10-14T10:00:00Z on branch topic]';
  refusal(() => grant(wt, to, { maxBytes: header.length + 200 }), 'over-budget', 3);
  assert.equal(fs.existsSync(grantDir), false, 'nothing written on a refusal');
  assert.equal(grant(wt, to, { maxBytes: header.length + 201 }).summaryId, written.summaryId);
  refusal(() => grant(wt, to), 'grant-exists', 1);
  assert.equal(DEFAULT_GRANT_MAX_BYTES, 16384);
});

test('a legacy record without summary_id cannot be granted', () => {
  const wt = worktree();
  const scope = summaryScope(wt, 'local', 'main', ENV);
  fs.mkdirSync(scope, { recursive: true });
  fs.writeFileSync(path.join(scope, 'summary.md'), `---\ncompacted_at: ${AT}\nsession_id: old\ntrigger: auto\nbranch: topic\n---\n\nlegacy body\n`);
  const to = recipient();
  refusal(() => grant(wt, to), 'summary-legacy', 1);
  assert.equal(fs.existsSync(path.join(ROOT, 'grants', to.toRun)), false);
});

test('peekGrant and claimGrant: oldest valid name first, symlinks and bad names ignored; the claim takes exactly the named grant', () => {
  const to = recipient();
  const dir = path.join(ROOT, 'grants', to.toRun, to.toLineage);
  fs.mkdirSync(dir, { recursive: true });
  const rec = (body: any) => `---\nsummary_id: x\nfrom_lineage: main\ncompacted_at: ${AT}\nbranch: unknown\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, 's-bad.md'), rec('bad'));
  const target = path.join(scratch.dir, `link-${seq}.md`);
  fs.writeFileSync(target, rec('link'));
  fs.symlinkSync(target, path.join(dir, 's-20260101T000000Z-AAAAAA.md'));
  fs.writeFileSync(path.join(dir, 's-20260102T000000Z-BBBBBB.md'), rec('older'));
  fs.writeFileSync(path.join(dir, 's-20260103T000000Z-CCCCCC.md'), rec('newer'));
  const header = `[Granted summary from lineage main, compacted ${AT}]`;
  const peek = peekGrant(to.toRun, to.toLineage, header.length + 1 + 5, ENV);
  assert.deepEqual({ grant: peek.grant, id: peek.id, bytes: peek.bytes }, { grant: 'fits', id: 's-20260102T000000Z-BBBBBB', bytes: 5 });
  assert.equal(peekGrant(to.toRun, to.toLineage, header.length + 5, ENV).grant, 'over', 'a body that fits under a header that does not is over');
  assert.equal(claimGrant(to.toRun, to.toLineage, 'L.r.w.1', 's-20260101T000000Z-AAAAAA', ENV).claimed, null, 'a symlinked grant is never claimed');
  assert.equal(claimGrant(to.toRun, to.toLineage, 'L.r.w.1', 's-20260109T000000Z-ZZZZZZ', ENV).claimed, null, 'an absent grant is none');
  const claimed = claimGrant(to.toRun, to.toLineage, 'L.r.w.1', 's-20260102T000000Z-BBBBBB', ENV);
  assert.equal(path.basename(claimed.claimed), '.claimed.L.r.w.1.s-20260102T000000Z-BBBBBB');
  assert.equal(claimed.id, 's-20260102T000000Z-BBBBBB');
  assert.equal(peekGrant(to.toRun, to.toLineage, 16384, ENV).id, 's-20260103T000000Z-CCCCCC');
});

test('parity: a bash-written summary is claimed by TypeScript', () => {
  const wt = worktree();
  const out: any = bash('doflow_summary_write "$@"\nprintf "id=%s\\npath=%s\\n" "$DF_SUMMARY_ID" "$DF_SUMMARY_PATH"',
    [wt, 'r-1', 'w-1', '3', AT, 'sess-b', 'auto', 'topic', 'worker', 'bash body']);
  assert.equal(out.path, path.join(summaryScope(wt, 'r-1', 'w-1', ENV), 'summary.md'));
  assert.equal(peekSummary(wt, 'r-1', 'w-1', 'sess-b', ENV).own, 'own-write');
  const claimed = claimSummary(wt, 'r-1', 'w-1', 'L.r-1.w-1.3', 'sess-t', ENV);
  assert.equal(claimed.own, 'pending');
  const text = fs.readFileSync(claimed.claimed, 'utf8');
  assert.match(text, new RegExp(`\\nsummary_id: ${out.id}\\n`));
  assert.match(text, /\nattempt: 3\n[^]*\n\nbash body\n$/);
});

test('parity: a TypeScript-written summary is claimed by bash, byte-identical to a bash write', () => {
  const wt = worktree();
  const written = write(wt, { run: 'r-2', lineage: 'w-2', role: 'worker' });
  const out: any = bash('rc=0; doflow_summary_claim "$@" || rc=$?\nprintf "rc=%s\\nown=%s\\nclaimed=%s\\n" "$rc" "$DF_SUMMARY_OWN" "$DF_SUMMARY_CLAIMED"',
    [wt, 'r-2', 'w-2', 'sess-b', 'sess-b']);
  assert.deepEqual({ rc: out.rc, own: out.own }, { rc: '0', own: 'pending' });
  const tsRecord: any = fs.readFileSync(out.claimed, 'utf8');
  const bashOut: any = bash('doflow_summary_write "$@"\nprintf "id=%s\\npath=%s\\n" "$DF_SUMMARY_ID" "$DF_SUMMARY_PATH"',
    [wt, 'r-2', 'w-2', '', AT, 'sess-w', 'auto', 'topic', 'worker', 'the body']);
  assert.equal(tsRecord.replace(written.summaryId, 'ID'), fs.readFileSync(bashOut.path, 'utf8').replace(bashOut.id, 'ID'));
});

test('parity: a TypeScript grant is claimed by bash doflow_grant_claim, fitting at the same byte', () => {
  const wt = worktree();
  const body = 'grant body — ü';
  write(wt, { body });
  const to = recipient();
  const result = grant(wt, to);
  const header = '[Granted summary from lineage main, compacted 2026-10-14T10:00:00Z on branch topic]';
  const exact = Buffer.byteLength(header) + 1 + Buffer.byteLength(body);
  const PRINT = 'printf "rc=%s\\ngrant=%s\\nid=%s\\nbytes=%s\\nclaimed=%s\\n" "$rc" "$DF_GRANT" "$DF_GRANT_ID" "$DF_GRANT_BYTES" "${DF_GRANT_CLAIMED:-}"';
  const over: any = bash(`rc=0; doflow_grant_claim "$@" || rc=$?\n${PRINT}`, [to.toRun, to.toLineage, 'L.r.w.1', String(exact - 1)]);
  assert.deepEqual({ rc: over.rc, grant: over.grant }, { rc: '1', grant: 'over' });
  assert.equal(peekGrant(to.toRun, to.toLineage, exact - 1, ENV).grant, 'over');
  assert.equal(peekGrant(to.toRun, to.toLineage, exact, ENV).grant, 'fits');
  const out: any = bash(`rc=0; doflow_grant_claim "$@" || rc=$?\n${PRINT}`, [to.toRun, to.toLineage, 'L.r.w.1', String(exact)]);
  assert.deepEqual({ rc: out.rc, grant: out.grant, id: out.id, bytes: out.bytes }, { rc: '0', grant: 'fits', id: result.summaryId, bytes: String(result.bytes) });
  assert.match(fs.readFileSync(out.claimed, 'utf8'), /\n\ngrant body — ü\n$/);
});

// ── Batch B (DEC-038, DEC-039, DEC-043) ───────────────────────────────────────────────────────────

test('DEC-039 grantSummary refuses recipients no launched unit can be: local/solo, local/main, <run>/solo', () => {
  const wt = worktree();
  write(wt);
  for (const to of [{ toRun: 'local', toLineage: 'solo' }, { toRun: 'local', toLineage: 'main' }, { toRun: 'r-solo', toLineage: 'solo' }]) {
    refusal(() => grant(wt, to), 'usage', 2);
    assert.equal(fs.existsSync(path.join(ROOT, 'grants', to.toRun, to.toLineage)), false, `${to.toRun}/${to.toLineage}: nothing written`);
  }
  // Negative control: a local run with a launched lineage is a legal recipient.
  assert.match(grant(wt, { toRun: 'local', toLineage: 'w1' }).summaryId, SUMMARY_ID_PATTERN);
});

test('L1-05 claimGrant never takes an older grant that appeared after the peek', () => {
  const to = recipient();
  const dir = path.join(ROOT, 'grants', to.toRun, to.toLineage);
  fs.mkdirSync(dir, { recursive: true });
  const rec = (body: any) => `---\nsummary_id: x\nfrom_lineage: main\ncompacted_at: ${AT}\nbranch: unknown\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, 's-20260105T000000Z-EEEEEE.md'), rec('peeked'));
  const peek = peekGrant(to.toRun, to.toLineage, 16384, ENV);
  fs.writeFileSync(path.join(dir, 's-20260101T000000Z-AAAAAA.md'), rec('older, arrived later'));
  const c = claimGrant(to.toRun, to.toLineage, 'L.r.w.1', peek.id, ENV);
  assert.equal(c.id, 's-20260105T000000Z-EEEEEE');
  assert.match(fs.readFileSync(c.claimed, 'utf8'), /peeked/);
  assert.ok(fs.existsSync(path.join(dir, 's-20260101T000000Z-AAAAAA.md')), 'the other grant is untouched');
});

test('DEC-038 releaseClaim gives a claim back without replacing a newer file', () => {
  const wt = worktree();
  write(wt);
  const c = claimSummary(wt, 'local', 'main', 'sess-r', 'sess-r', ENV);
  assert.equal(releaseClaim(c.claimed, c.origin), true);
  assert.equal(fs.existsSync(c.claimed), false);
  assert.equal(peekSummary(wt, 'local', 'main', 'sess-r', ENV).own, 'pending');
  const again = claimSummary(wt, 'local', 'main', 'sess-r', 'sess-r', ENV);
  const newer = write(wt, { body: 'newer' });
  assert.equal(releaseClaim(again.claimed, again.origin), false, 'a newer summary keeps the name');
  assert.match(fs.readFileSync(newer.path, 'utf8'), /\n\nnewer\n$/);
});

/** The pre-078 project summary for cwd, as a pre-078 install left it. */
function legacyFile(cwd: any, body: any = 'legacy body') {
  const dir = path.join(ROOT, 'projects', cwdHash(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'last-compact-summary.md');
  fs.writeFileSync(file, `---\ncompacted_at: ${AT}\nsession_id: old\ntrigger: auto\nbranch: topic\n---\n\n${body}\n`);
  return file;
}

test('DEC-043 adoptLegacy moves the legacy summary into local/main once, frontmatter kept', () => {
  const wt = worktree();
  const old = legacyFile(wt);
  assert.equal(legacySummary(wt, ENV), old);
  assert.equal(adoptLegacy(wt, wt, ENV), true);
  assert.equal(legacySummary(wt, ENV), null);
  assert.deepEqual(fs.readdirSync(path.dirname(old)), [], 'no .adopting file left');
  const target = path.join(summaryScope(wt, 'local', 'main', ENV), 'summary.md');
  assert.match(fs.readFileSync(target, 'utf8'), /^---\ncompacted_at: [^]*\n\nlegacy body\n$/);
  assert.equal(adoptLegacy(wt, wt, ENV), false, 'a second adoption finds nothing');
});

test('DEC-043 adoptLegacy retires the legacy file when a newer summary is pending, and never adopts a symlink', () => {
  const wt = worktree();
  const newer = write(wt, { body: 'newer' });
  const old = legacyFile(wt);
  assert.equal(adoptLegacy(wt, wt, ENV), true);
  assert.equal(fs.existsSync(old), false);
  assert.match(fs.readFileSync(newer.path, 'utf8'), /\n\nnewer\n$/, 'the pending summary is never replaced');

  const wt2 = worktree();
  const real = path.join(scratch.dir, `legacy-target-${seq}.md`);
  fs.writeFileSync(real, 'x\n');
  const dir = path.join(ROOT, 'projects', cwdHash(wt2));
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(real, path.join(dir, 'last-compact-summary.md'));
  assert.equal(adoptLegacy(wt2, wt2, ENV), false);
  assert.equal(fs.existsSync(path.join(summaryScope(wt2, 'local', 'main', ENV), 'summary.md')), false);
});

test('DEC-043 adoptLegacy claims by rename first: a second adopter mid-adoption finds nothing to adopt', () => {
  const wt = worktree();
  legacyFile(wt);
  const target = path.join(summaryScope(wt, 'local', 'main', ENV), 'summary.md');
  const realLink = fs.linkSync;
  let nested: any = null;
  // Between the first adopter's claim and its link, the owner claims nothing yet and a second
  // adopter runs: with the legacy file already renamed away it must find nothing.
  fs.linkSync = (from: any, to: any): any => {
    if (to === target && nested === null) {
      nested = { adopted: adoptLegacy(wt, wt, ENV), legacy: legacySummary(wt, ENV) };
    }
    return realLink(from, to);
  };
  try {
    assert.equal(adoptLegacy(wt, wt, ENV), true);
  } finally {
    fs.linkSync = realLink;
  }
  assert.deepEqual(nested, { adopted: false, legacy: null });
  assert.match(fs.readFileSync(target, 'utf8'), /\n\nlegacy body\n$/);
});

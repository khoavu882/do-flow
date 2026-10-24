'use strict';

// 080 D.2 (IC-014, DEC-010): scopeContext() lists the run scope's pending summary, leftover claimed
// copies and grants with what their headers record, and never renames, removes or writes;
// compareScopeContext() is the pure comparison resume applies to it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../helper/scratch-env.ts');
const { writeSummary } = require('../helper/summary-fixture.ts');
const { compareScopeContext, grantSummary, scopeContext, summaryScope } = require('../../src/runtime/context/summary-store.ts');

const AT = '2026-10-14T10:00:00Z';
const scratch = createScratch('doflow-context-scope-');
const ENV = scratch.env({ DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'L1', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: scratch.dir });
const ROOT = path.join(scratch.xdg, 'doflow', 'session-env');
test.after(() => scratch.remove());

let seq = 0;
function worktree() {
  const d = path.join(scratch.dir, `wt${seq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const lineage = () => `L${seq++}`;

/** A summary.md written by hand, so a header can carry a `commit` field no 078 writer records. */
function handSummary(wt, run, lin, fields) {
  const scope = summaryScope(wt, run, lin, ENV);
  fs.mkdirSync(scope, { recursive: true });
  const head = Object.entries(fields).map(([k, v]) => `${k}: ${v}\n`).join('');
  const file = path.join(scope, 'summary.md');
  fs.writeFileSync(file, `---\n${head}---\n\nBODY\n`);
  return file;
}

/** Every path under ROOT with its type, size, mtime and content hash. */
function snapshot() {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      const rel = path.relative(ROOT, p);
      if (st.isDirectory()) {
        out[rel] = `dir ${st.mtimeMs}`;
        walk(p);
      } else {
        out[rel] = `file ${st.size} ${st.mtimeMs} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
      }
    }
  };
  walk(ROOT);
  return out;
}

test('a pending summary reports its summary id, branch, commit, worktree and compacted_at', () => {
  const wt = worktree();
  const lin = lineage();
  const file = handSummary(wt, 'r1', lin, {
    compacted_at: AT, summary_id: 's-20261014T100000Z-abcDEF', branch: 'feat/080', commit: 'a35d618', worktree: wt,
  });
  const ctx = scopeContext(wt, 'r1', lin, ENV);
  assert.deepEqual(ctx.pending, {
    path: file, summaryId: 's-20261014T100000Z-abcDEF', branch: 'feat/080', commit: 'a35d618', worktree: wt, compactedAt: AT,
  });
  assert.deepEqual(ctx.claimed, []);
  assert.deepEqual(ctx.grants, []);
});

test('a 078-written summary records no commit, and `unknown` reads as null', () => {
  const wt = worktree();
  const lin = lineage();
  const written = writeSummary({ worktree: wt, run: 'r1', lineage: lin, compactedAt: AT, body: 'B', env: ENV });
  const ctx = scopeContext(wt, 'r1', lin, ENV);
  assert.equal(ctx.pending.summaryId, written.summaryId);
  assert.equal(ctx.pending.branch, null);
  assert.equal(ctx.pending.commit, null);
  assert.equal(ctx.pending.worktree, wt);
});

test('a leftover .claimed.<unitId> copy is listed; a malformed unit name is not', () => {
  const wt = worktree();
  const lin = lineage();
  const scope = summaryScope(wt, 'r1', lin, ENV);
  fs.mkdirSync(scope, { recursive: true });
  fs.writeFileSync(path.join(scope, '.claimed.L.r1.L2.1'), '---\nbranch: x\n---\n\nB\n');
  fs.writeFileSync(path.join(scope, '.claimed.'), 'x');
  fs.writeFileSync(path.join(scope, '.summary.ABCDEF'), 'x');
  const ctx = scopeContext(wt, 'r1', lin, ENV);
  assert.equal(ctx.pending, null);
  assert.deepEqual(ctx.claimed, [{ path: path.join(scope, '.claimed.L.r1.L2.1'), unitId: 'L.r1.L2.1' }]);
});

test('a grant addressed to the scope is listed with its recorded branch and source worktree', () => {
  const from = worktree();
  const fromLin = lineage();
  writeSummary({ worktree: from, run: 'r1', lineage: fromLin, compactedAt: AT, branch: 'feat/a', body: 'GRANTED', env: ENV });
  const wt = worktree();
  const lin = lineage();
  const g = grantSummary({ summary: 'pending', toRun: 'r1', toLineage: lin, fromWorktree: from, fromRun: 'r1', fromLineage: fromLin, env: ENV });
  const ctx = scopeContext(wt, 'r1', lin, ENV);
  assert.deepEqual(ctx.grants, [{ path: g.path, summaryId: g.summaryId, branch: 'feat/a', commit: null, fromWorktree: from, compactedAt: AT }]);
});

test('no scope (lineage solo, a bad id or no worktree) is empty', () => {
  const empty = { pending: null, claimed: [], grants: [] };
  assert.deepEqual(scopeContext(worktree(), 'r1', 'solo', ENV), empty);
  assert.deepEqual(scopeContext(worktree(), 'bad id', 'L1', ENV), empty);
  assert.deepEqual(scopeContext('', 'r1', 'L1', ENV), empty);
});

test('the state tree bytes and mtimes are unchanged after the call', () => {
  const wt = worktree();
  const lin = lineage();
  writeSummary({ worktree: wt, run: 'r1', lineage: lin, compactedAt: AT, branch: 'main', body: 'KEEP', env: ENV });
  const scope = summaryScope(wt, 'r1', lin, ENV);
  fs.writeFileSync(path.join(scope, '.claimed.L.r1.x.1'), 'C');
  const from = worktree();
  const fromLin = lineage();
  writeSummary({ worktree: from, run: 'r1', lineage: fromLin, compactedAt: AT, body: 'G', env: ENV });
  grantSummary({ summary: 'pending', toRun: 'r1', toLineage: lin, fromWorktree: from, fromRun: 'r1', fromLineage: fromLin, env: ENV });
  const before = snapshot();
  const ctx = scopeContext(wt, 'r1', lin, ENV);
  assert.ok(ctx.pending && ctx.claimed.length === 1 && ctx.grants.length === 1);
  assert.deepEqual(snapshot(), before);
});

test('compareScopeContext: branch, detached commit, unknown, worktree and claimed reasons', () => {
  const item = (branch, commit, wt) => ({ path: `p-${branch}-${commit}-${wt}`, summaryId: null, branch, commit, worktree: wt, compactedAt: null });
  const cmp = (pending, current) => compareScopeContext({ pending, claimed: [], grants: [] }, current);
  const on = { worktree: '/w', branch: 'main', commit: 'c1' };
  const detached = { worktree: '/w', branch: null, commit: 'c1' };

  assert.deepEqual(cmp(item('main', null, '/w'), on), []);
  assert.deepEqual(cmp(item('other', null, '/w'), on)[0].reasons, ['branch-differs']);
  // Both sides detached: compare commits (critic A m9).
  assert.deepEqual(cmp(item(null, 'c1', '/w'), detached), []);
  assert.deepEqual(cmp(item(null, 'c2', '/w'), detached)[0].reasons, ['commit-differs']);
  // Either branch unknown without a commit basis on both sides.
  assert.deepEqual(cmp(item(null, 'c1', '/w'), on)[0].reasons, ['branch-unknown']);
  assert.deepEqual(cmp(item('main', 'c1', '/w'), detached)[0].reasons, ['branch-unknown']);
  assert.deepEqual(cmp(item(null, null, '/w'), detached)[0].reasons, ['branch-unknown']);
  assert.deepEqual(cmp(item(null, 'c1', '/w'), { worktree: '/w', branch: null, commit: null })[0].reasons, ['branch-unknown']);
  assert.deepEqual(cmp(item('other', null, '/x'), on)[0].reasons, ['branch-differs', 'worktree-differs']);
  assert.deepEqual(cmp(item('main', null, null), on), []);

  const stale = compareScopeContext({
    pending: null,
    claimed: [{ path: '/c', unitId: 'u' }],
    grants: [{ path: '/g', summaryId: 's-20261014T100000Z-abcDEF', branch: 'main', commit: null, fromWorktree: '/other', compactedAt: null }],
  }, on);
  assert.deepEqual(stale, [
    { kind: 'claimed-summary', path: '/c', reasons: ['claimed-not-consumed'] },
    { kind: 'grant', path: '/g', reasons: ['worktree-differs'] },
  ]);
});

'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// The bash summary store policies/summary-store.sh (feature 078, IC-010, IC-011 store write, IC-012,
// IC-014; DEC-003, DEC-012, DEC-014): the scoped write, the owner claim by rename, grant selection
// and claim, and the legacy adopter. Records are read back through emission.jq, the renderer the
// hook passes the claimed file to. Runs under macOS /bin/bash 3.2.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const REPO = path.resolve(__dirname, '..', '..');
const POLICIES = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies');
const STORE = path.join(POLICIES, 'summary-store.sh');
const LIB = path.join(POLICIES, 'lib.sh');
const EMISSION = path.join(POLICIES, 'emission.jq');
const BASH = bashPath();
const SUMMARY_ID = /^s-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{6}$/;
const AT = '2026-10-14T10:00:00Z';

const scratch = createScratch('doflow-summary-store-');
const ENV_ROOT = path.join(scratch.xdg, 'doflow', 'session-env');
test.after(() => scratch.remove());

let seq = 0;
function worktree() {
  const d = path.join(scratch.dir, `wt${seq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Runs `body` after sourcing lib.sh (cwd_hash, STATE_DIR) and summary-store.sh, under set -euo pipefail. */
function sh(body: any, args: any = []) {
  const script = `set -euo pipefail\n. "${LIB}"\n. "${STORE}"\n${body}`;
  const r = spawnSync(BASH, ['-c', script, 'user-prompt-submit.sh', ...args], { env: scratch.env(), encoding: 'utf8' });
  return r;
}

function ok(body: any, args: any = []) {
  const r = sh(body, args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function vars(stdout: any) {
  const out: any = {};
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

const PRINT_SUMMARY = 'printf "rc=%s\\nown=%s\\nclaimed=%s\\nbytes=%s\\nscope=%s\\n" "$rc" "$DF_SUMMARY_OWN" "$DF_SUMMARY_CLAIMED" "$DF_SUMMARY_BYTES" "$DF_SUMMARY_SCOPE"';
const PRINT_GRANT = 'printf "rc=%s\\ngrant=%s\\nfile=%s\\nid=%s\\nbytes=%s\\nclaimed=%s\\n" "$rc" "$DF_GRANT" "$DF_GRANT_FILE" "$DF_GRANT_ID" "$DF_GRANT_BYTES" "${DF_GRANT_CLAIMED:-}"';

function write(wt: any, { run = 'local', lineage = 'main', attempt = '', session = 'sess-w', branch = 'topic', role = 'main', body = 'the body', at = AT }: any = {}) {
  const out: any = vars(ok('rc=0; doflow_summary_write "$@" || rc=$?\nprintf "rc=%s\\nid=%s\\npath=%s\\n" "$rc" "$DF_SUMMARY_ID" "$DF_SUMMARY_PATH"',
    [wt, run, lineage, attempt, at, session, 'auto', branch, role, body]));
  return out;
}

function claim(wt: any, { run = 'local', lineage = 'main', unit = 'sess-r', session = 'sess-r', prelude = '' }: any = {}) {
  return vars(ok(`${prelude}\nrc=0; doflow_summary_claim "$@" || rc=$?\n${PRINT_SUMMARY}`, [wt, run, lineage, unit, session]));
}

function grantClaim(run: any, lineage: any, max: any = 16384, unit: any = 'L.r-7.w-3.1') {
  return vars(ok(`rc=0; doflow_grant_claim "$@" || rc=$?\n${PRINT_GRANT}`, [run, lineage, unit, String(max)]));
}

function grantPeek(run: any, lineage: any, max: any = 16384) {
  return vars(ok(`rc=0; doflow_grant_peek "$@" || rc=$?\n${PRINT_GRANT}`, [run, lineage, String(max)]));
}

function scope(wt: any, run: any = 'local', lineage: any = 'main') {
  return vars(ok('doflow_summary_scope "$@" || true\nprintf "scope=%s\\n" "$DF_SUMMARY_SCOPE"', [wt, run, lineage])).scope;
}

/** emission.jq in render mode over one record file passed as --rawfile summary or grant. */
function render(segment: any, action: any, file: any, maxBytes: any = 16384, summaryBytes?: any) {
  const plan: any = { actions: { [segment]: action }, maxBytes, mode: 'render' };
  if (summaryBytes !== undefined) plan.summaryBytes = summaryBytes;
  const files: any = { git: '/dev/null', summary: '/dev/null', grant: '/dev/null', warning: '/dev/null' };
  files[segment] = file;
  const args: any = ['-n', '-f', EMISSION, '--argjson', 'plan', JSON.stringify(plan)];
  for (const [name, f] of Object.entries(files)) args.push('--rawfile', name, f);
  args.push('--arg', 'nudge', '');
  const r = spawnSync('jq', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function grantDir(run: any, lineage: any) {
  const d = path.join(ENV_ROOT, 'grants', run, lineage);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function grantRecord(id: any, body: any, extra: any = '') {
  return `---\nsummary_id: ${id}\ngranted_at: 2026-10-14T10:05:00Z\nfrom_worktree: /abs/wt\nfrom_run: local\nfrom_lineage: main\nto_run: r-7\nto_lineage: w-3\ncompacted_at: 2026-10-14T10:00:00Z\nbranch: topic\nbytes: 0\n${extra}---\n\n${body}\n`;
}

function legacyFile(cwd: any) {
  const hash: any = ok('cwd_hash "$1"', [cwd]).trim();
  const d = path.join(ENV_ROOT, 'projects', hash);
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, 'last-compact-summary.md');
}

const LEGACY = '---\ncompacted_at: 2026-01-02T03:04:05Z\nsession_id: old-session\ntrigger: auto\nbranch: legacy-branch\nrole: main\n---\n\nlegacy body\n';

// ── Sourcing ────────────────────────────────────────────────────────────────────────────────────

test('sourcing defines functions only: no output, no option, no variable, no trap', () => {
  const script = `set +euo pipefail\nbefore_o=$(set +o); before_v=$(compgen -v | sort); before_t=$(trap -p)\n. "${STORE}" >"$1/out" 2>&1\nafter_o=$(set +o); after_v=$(compgen -v | sort); after_t=$(trap -p)\n[ "$before_o" = "$after_o" ] || echo options-changed\n[ "$before_t" = "$after_t" ] || echo trap-changed\ndiff <(printf '%s\\n' "$before_v") <(printf '%s\\n' "$after_v") | grep '^[<>]' | grep -v -e before_ -e after_ || true\n[ -s "$1/out" ] && echo printed || true\ndeclare -F | grep -c 'doflow_' || true`;
  const d = worktree();
  const r = spawnSync(BASH, ['-c', script, 'x', d], { env: scratch.env(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines.slice(0, -1), []);
  assert.ok(Number(lines[lines.length - 1]) >= 7);
});

test('the literal legacy file name appears once, inside doflow_summary_adopt_legacy', () => {
  const text = fs.readFileSync(STORE, 'utf8');
  const hits = text.split('\n').map((l: any, i: any) => [l, i]).filter(([l]: any) => l.includes('last-compact-summary.md'));
  assert.equal(hits.length, 1);
  const start = text.split('\n').findIndex((l: any) => l.startsWith('doflow_summary_adopt_legacy()'));
  assert.ok(start >= 0 && hits[0][1] > start);
  assert.ok(!/^\s*#/.test(hits[0][0]));
});

// ── IC-010, IC-011: the scoped write ──────────────────────────────────────────────────────────────

test('write: the IC-010 record lands at summaries/<cwd_hash>/<run>/<lineage>/summary.md, no temp left', () => {
  const wt: any = worktree();
  const w: any = write(wt, { run: 'r-7', lineage: 'w-3', attempt: '2', session: 'sess-a', role: 'worker' });
  assert.equal(w.rc, '0');
  assert.match(w.id, SUMMARY_ID);
  assert.ok(w.id.startsWith('s-20261014T100000Z-'));
  const hash: any = ok('cwd_hash "$1"', [wt]).trim();
  assert.equal(w.path, path.join(ENV_ROOT, 'summaries', hash, 'r-7', 'w-3', 'summary.md'));
  assert.equal(fs.readFileSync(w.path, 'utf8'),
    `---\ncompacted_at: ${AT}\nsession_id: sess-a\ntrigger: auto\nbranch: topic\nrole: worker\nsummary_id: ${w.id}\nrun: r-7\nlineage: w-3\nattempt: 2\nworktree: ${wt}\n---\n\nthe body\n`);
  assert.deepEqual(fs.readdirSync(path.dirname(w.path)), ['summary.md']);
  assert.equal(w.id.slice(-6), w.id.split('-').pop());
});

test('write: an empty attempt is an empty key, defaults fill today\'s keys, and a newer write replaces', () => {
  const wt = worktree();
  write(wt, { body: 'first' });
  const w: any = write(wt, { session: '', branch: '', body: 'second' });
  const text = fs.readFileSync(w.path, 'utf8');
  assert.match(text, /\nsession_id: unknown\n/);
  assert.match(text, /\nbranch: unknown\n/);
  assert.match(text, /\nattempt:\nworktree: /);
  assert.match(text, /\n\nsecond\n$/);
});

test('write refuses an empty body, a solo or invalid lineage, an invalid run and a bad timestamp', () => {
  const wt = worktree();
  for (const opts of [{ body: '' }, { lineage: 'solo' }, { lineage: 'bad/x' }, { run: '-x' }, { at: '2026-10-14 10:00' }, { attempt: '0' }]) {
    assert.equal(write(wt, opts).rc, '1', JSON.stringify(opts));
  }
  assert.ok(!fs.existsSync(path.join(scope(wt), 'summary.md')));
});

test('scopes: worktree, run and lineage each give a distinct directory; a symlinked worktree shares its key', () => {
  const a = worktree();
  const b = worktree();
  const link = path.join(scratch.dir, `link${seq++}`);
  fs.symlinkSync(a, link);
  const s: any = new Set([scope(a), scope(b), scope(a, 'r-1'), scope(a, 'local', 'w-1')]);
  assert.equal(s.size, 4);
  assert.equal(scope(link), scope(a));
  assert.equal(scope(a, 'local', 'solo'), '');
  assert.equal(scope(a, 'x'.repeat(57)), '');
});

// ── IC-012: owner claim ──────────────────────────────────────────────────────────────────────────

test('write then claim once: the claimed file renders through emission.jq; a second claim finds none', () => {
  const wt = worktree();
  write(wt, { body: 'line one\nline two' });
  const c: any = claim(wt);
  assert.equal(c.rc, '0');
  assert.equal(c.own, 'pending');
  assert.equal(c.claimed, path.join(c.scope, '.claimed.sess-r'));
  assert.ok(!fs.existsSync(path.join(c.scope, 'summary.md')));
  const r = render('summary', 'truncate', c.claimed, 16384, Number(c.bytes));
  assert.equal(r.text, `[Prior session summary, compacted ${AT} on branch topic]\nline one\nline two`);
  fs.rmSync(c.claimed);
  const again: any = claim(wt, { unit: 'sess-q', session: 'sess-q' });
  assert.equal(again.rc, '1');
  assert.equal(again.own, 'none');
  assert.equal(again.claimed, '');
});

test('a summary written after the rename survives as the next pending summary', () => {
  const wt = worktree();
  write(wt, { body: 'old' });
  // Every mv or cp onto a claim temporary is followed by a concurrent compaction's write.
  const prelude = [
    '_concurrent() { case "${@: -1}" in */.claimed.*) printf -- "---\\nsession_id: other\\n---\\n\\nnew\\n" >"${DF_SUMMARY_SCOPE}/summary.md" ;; esac; }',
    'mv() { command mv "$@"; local rc=$?; _concurrent "$@"; return $rc; }',
    'cp() { command cp "$@"; local rc=$?; _concurrent "$@"; return $rc; }',
  ].join('\n');
  const c: any = claim(wt, { prelude });
  assert.equal(c.rc, '0');
  assert.match(fs.readFileSync(c.claimed, 'utf8'), /\n\nold\n$/);
  const pending = path.join(c.scope, 'summary.md');
  assert.ok(fs.existsSync(pending), 'the summary written after the claim must survive');
  assert.match(fs.readFileSync(pending, 'utf8'), /\n\nnew\n$/);
});

test('own-write: the session that wrote the summary leaves it; another session claims it', () => {
  const wt: any = worktree();
  write(wt, { session: 'sess-a' });
  const peek: any = vars(ok('doflow_summary_peek "$@"\nprintf "own=%s\\nfile=%s\\n" "$DF_SUMMARY_OWN" "$DF_SUMMARY_FILE"', [wt, 'local', 'main', 'sess-a']));
  assert.equal(peek.own, 'own-write');
  assert.ok(peek.file.endsWith('/summary.md'));
  const mine: any = claim(wt, { unit: 'sess-a', session: 'sess-a' });
  assert.equal(mine.rc, '1');
  assert.equal(mine.own, 'own-write');
  assert.ok(fs.existsSync(path.join(mine.scope, 'summary.md')));
  const other: any = claim(wt, { unit: 'sess-b', session: 'sess-b' });
  assert.equal(other.rc, '0');
  assert.equal(other.own, 'pending');
});

test('own-write reads the frontmatter as parse_record does: CRLF, first key wins, a body line does not count', () => {
  const wt: any = worktree();
  const dir = scope(wt);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.md'), '---\r\nsession_id:   sess-c\r\nsession_id: sess-d\r\n---\r\n\r\nsession_id: sess-e\r\n');
  const peek: any = (sid: any) => vars(ok(`doflow_summary_peek "$@"\nprintf "own=%s\\n" "$DF_SUMMARY_OWN"`, [wt, 'local', 'main', sid])).own;
  assert.equal(peek('sess-c'), 'own-write');
  assert.equal(peek('sess-d'), 'pending');
  assert.equal(peek('sess-e'), 'pending');
});

test('a symlinked summary.md is never claimed; another lineage\'s scope is never reached', () => {
  const wt = worktree();
  const dir = scope(wt);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(scratch.dir, `target${seq++}.md`);
  fs.writeFileSync(target, '---\nsession_id: x\n---\n\nsecret\n');
  fs.symlinkSync(target, path.join(dir, 'summary.md'));
  assert.equal(claim(wt).rc, '1');
  assert.ok(fs.lstatSync(path.join(dir, 'summary.md')).isSymbolicLink());
  write(wt, { lineage: 'w-1', body: 'w-1 only' });
  const c: any = claim(wt, { lineage: 'w-2' });
  assert.equal(c.rc, '1');
  assert.ok(fs.existsSync(path.join(scope(wt, 'local', 'w-1'), 'summary.md')));
});

test('claim reads at most 65536 bytes and reports the full size for the truncation notice', () => {
  const wt = worktree();
  write(wt, { body: 'é'.repeat(40000) });
  const c: any = claim(wt);
  assert.equal(c.rc, '0');
  assert.equal(fs.statSync(c.claimed).size, 65536);
  assert.ok(Number(c.bytes) > 65536);
  const r = render('summary', 'truncate', c.claimed, 65536, Number(c.bytes));
  assert.match(r.text, /\[summary truncated: first 4000 of at least \d+ characters\]$/);
});

// ── IC-012: grants ───────────────────────────────────────────────────────────────────────────────

test('grant: the oldest by name is claimed first, then the next; the claimed copy renders whole', () => {
  const dir = grantDir('r-7', 'w-3');
  const older = 's-20261014T100000Z-Aa11Bb';
  const newer = 's-20261014T110000Z-Cc22Dd';
  fs.writeFileSync(path.join(dir, `${newer}.md`), grantRecord(newer, 'newer body'));
  fs.writeFileSync(path.join(dir, `${older}.md`), grantRecord(older, 'older body'));
  const first: any = grantClaim('r-7', 'w-3');
  assert.equal(first.rc, '0');
  assert.equal(first.grant, 'fits');
  assert.equal(first.id, older);
  assert.equal(first.claimed, path.join(dir, `.claimed.L.r-7.w-3.1.${older}`));
  assert.equal(first.bytes, String(Buffer.byteLength('older body')));
  assert.equal(render('grant', 'whole', first.claimed).text, '[Granted summary from lineage main, compacted 2026-10-14T10:00:00Z on branch topic]\nolder body');
  const second: any = grantClaim('r-7', 'w-3');
  assert.equal(second.id, newer);
  const none: any = grantClaim('r-7', 'w-3');
  assert.equal(none.rc, '1');
  assert.equal(none.grant, 'none');
});

test('grant: a symlink, a bad name and a directory are ignored', () => {
  const dir = grantDir('r-8', 'w-1');
  const target = path.join(scratch.dir, `gtarget${seq++}.md`);
  fs.writeFileSync(target, grantRecord('s-20260101T000000Z-Zz99Yy', 'via link'));
  fs.symlinkSync(target, path.join(dir, 's-20260101T000000Z-Zz99Yy.md'));
  fs.writeFileSync(path.join(dir, 's-bad.md'), grantRecord('s-bad', 'bad name'));
  fs.writeFileSync(path.join(dir, 'notes.md'), grantRecord('x', 'other'));
  fs.mkdirSync(path.join(dir, 's-20260101T000001Z-Dir000.md'));
  assert.equal(grantPeek('r-8', 'w-1').grant, 'none');
  const good = 's-20261231T000000Z-Good00';
  fs.writeFileSync(path.join(dir, `${good}.md`), grantRecord(good, 'the one'));
  const g: any = grantClaim('r-8', 'w-1');
  assert.equal(g.id, good);
  assert.ok(fs.lstatSync(path.join(dir, 's-20260101T000000Z-Zz99Yy.md')).isSymbolicLink());
  assert.ok(fs.existsSync(target));
});

test('grant: body bytes match parse_record (CRLF, multibyte, blank lines); over the budget stays in place', () => {
  const dir = grantDir('r-9', 'w-1');
  const id = 's-20261014T100000Z-Mm33Nn';
  const body = '\r\n\r\nfirst é line\r\n\r\n\r\nlast 日本\r\n\r\n';
  fs.writeFileSync(path.join(dir, `${id}.md`), grantRecord(id, body).replace(/\n/g, '\r\n'));
  const peek: any = grantPeek('r-9', 'w-1');
  const pointer = render('grant', 'pointer', peek.file, 1);
  assert.equal(pointer.text, `[Granted summary ${id} withheld: ${peek.bytes} bytes exceed the 1-byte context budget]`);
  const n = Buffer.byteLength(render('grant', 'whole', peek.file).text);
  assert.equal(grantPeek('r-9', 'w-1', n).grant, 'fits');
  assert.equal(render('grant', 'whole', peek.file, n).refused, false);
  const over: any = grantClaim('r-9', 'w-1', n - 1);
  assert.equal(over.rc, '1');
  assert.equal(over.grant, 'over');
  assert.equal(render('grant', 'whole', peek.file, n - 1).refused, true);
  assert.ok(fs.existsSync(path.join(dir, `${id}.md`)));
});

test('grant: a body that fits under a rendered header that does not is over and is not claimed', () => {
  const dir = grantDir('r-11', 'w-1');
  const id = 's-20261014T100000Z-Hdr000';
  const file = path.join(dir, `${id}.md`);
  // `]` is removed and "unknown" omitted by header_tail; from_lineage is shown as written.
  const record = grantRecord(id, 'short body')
    .replace('from_lineage: main', 'from_lineage: a-long-lineage-name')
    .replace('compacted_at: 2026-10-14T10:00:00Z', 'compacted_at: 2026-10-14T10:00:00Z]]')
    .replace('branch: topic', 'branch: unknown');
  fs.writeFileSync(file, record);
  const whole = render('grant', 'whole', file).text;
  assert.equal(whole, '[Granted summary from lineage a-long-lineage-name, compacted 2026-10-14T10:00:00Z]\nshort body');
  const n = Buffer.byteLength(whole);
  const body = Buffer.byteLength('short body');
  assert.equal(grantPeek('r-11', 'w-1', n).grant, 'fits');
  for (const max of [n - 1, body]) {
    const g: any = grantClaim('r-11', 'w-1', max);
    assert.equal(g.rc, '1');
    assert.equal(g.grant, 'over');
    assert.equal(g.bytes, String(body), 'DF_GRANT_BYTES stays the body bytes the pointer quotes');
    assert.equal(g.claimed, '');
    assert.equal(render('grant', 'whole', file, max).refused, true, 'emission.jq agrees it does not render whole');
  }
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fs.readdirSync(dir).filter((f: any) => f.startsWith('.claimed.')), []);
});

test('grant: a file larger than the budget plus the read bound is over without being read', () => {
  const dir = grantDir('r-10', 'w-1');
  const id = 's-20261014T100000Z-Big000';
  fs.writeFileSync(path.join(dir, `${id}.md`), grantRecord(id, 'x'.repeat(70000)));
  const g: any = grantPeek('r-10', 'w-1', 100);
  assert.equal(g.grant, 'over');
  assert.equal(g.bytes, '');
  assert.equal(grantPeek('r-10', 'w-1', 1).grant, 'over');
});

test('grant: an invalid run, lineage or budget reaches no path', () => {
  for (const [run, lineage, max] of [['../x', 'w-1', 100], ['r-7', 'a/b', 100], ['r-7', 'w-3', 0], ['r-7', 'w-3', 'x']]) {
    assert.equal(grantPeek(run, lineage, max).grant, 'none');
  }
});

// ── IC-014: legacy adopter ───────────────────────────────────────────────────────────────────────

test('adopt without a pending summary: moved into local/main with its frontmatter, then claimed once', () => {
  const wt: any = worktree();
  const old = legacyFile(wt);
  fs.writeFileSync(old, LEGACY);
  const r: any = vars(ok('rc=0; doflow_summary_adopt_legacy "$1" "$1" || rc=$?\nprintf "rc=%s\\n" "$rc"', [wt]));
  assert.equal(r.rc, '0');
  assert.ok(!fs.existsSync(old));
  const pending = path.join(scope(wt), 'summary.md');
  assert.equal(fs.readFileSync(pending, 'utf8'), LEGACY);
  const own: any = claim(wt, { unit: 'old-session', session: 'old-session' });
  assert.equal(own.own, 'own-write');
  const c: any = claim(wt);
  assert.equal(c.rc, '0');
  assert.equal(render('summary', 'truncate', c.claimed).text, '[Prior session summary, compacted 2026-01-02T03:04:05Z on branch legacy-branch]\nlegacy body');
  const again: any = vars(ok('rc=0; doflow_summary_adopt_legacy "$1" "$1" || rc=$?\nprintf "rc=%s\\n" "$rc"', [wt]));
  assert.equal(again.rc, '1');
});

test('adopt with a pending summary: the pending one is kept and the old file is removed', () => {
  const wt: any = worktree();
  const w: any = write(wt, { body: 'newer pending' });
  const old = legacyFile(wt);
  fs.writeFileSync(old, LEGACY);
  const r: any = vars(ok('rc=0; doflow_summary_adopt_legacy "$1" "$1" || rc=$?\nprintf "rc=%s\\n" "$rc"', [wt]));
  assert.equal(r.rc, '0');
  assert.ok(!fs.existsSync(old));
  assert.match(fs.readFileSync(w.path, 'utf8'), /\n\nnewer pending\n$/);
});

test('adopt uses the cwd for the legacy key and the worktree for the scope', () => {
  const cwd: any = worktree();
  const wt: any = worktree();
  const old = legacyFile(cwd);
  fs.writeFileSync(old, LEGACY);
  assert.equal(vars(ok('rc=0; doflow_summary_adopt_legacy "$1" "$2" || rc=$?\nprintf "rc=%s\\n" "$rc"', [cwd, wt])).rc, '0');
  assert.ok(fs.existsSync(path.join(scope(wt), 'summary.md')));
  assert.ok(!fs.existsSync(path.join(scope(cwd), 'summary.md')));
});

test('adopt never runs for a symlinked legacy file', () => {
  const wt: any = worktree();
  const old = legacyFile(wt);
  const target = path.join(scratch.dir, `ltarget${seq++}.md`);
  fs.writeFileSync(target, LEGACY);
  fs.symlinkSync(target, old);
  const r: any = vars(ok('rc=0; doflow_summary_adopt_legacy "$1" "$1" || rc=$?\nprintf "rc=%s\\n" "$rc"', [wt]));
  assert.equal(r.rc, '1');
  assert.ok(fs.lstatSync(old).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), LEGACY);
  assert.ok(!fs.existsSync(path.join(scope(wt), 'summary.md')));
});

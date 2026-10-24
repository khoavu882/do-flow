'use strict';

// 119 C.1 (IC-002 second half, D-5, FR-007, INV-1): a findings record may declare who authored the reviewed change
// (`author`) and who sat each seat (`agent`/`session`/`family`). The validator refuses a seat that is the author's own
// agent or session (INV-1 is OR, C-4), applies the same-family rule, and `review --action check` cross-reads the head's Co-Authored-By
// trailers and the slug's task-attempt owners. Scratch repos and records only; a test reads only its own repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSettingsEnv } = require('../helper/settings-fixtures.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { validateFindings, reviewAdvisories } = require('../../src/runtime/review/findings.ts');
const { handleReviewCommand } = require('../../src/runtime/review/command.ts');
const { crossCheckAuthor } = require('../../src/runtime/review/identity.ts');
const { projectRoot } = require('../../src/runtime/lifecycle/root.ts');
const { storeFile } = require('../../src/runtime/task-attempts.ts');

const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures', 'roadmap', 'findings');
const base = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'schema-1.json'), 'utf8'));
const AUTHOR = { agent: 'core-implementer', session: 'sess-1', family: 'claude' };

/** The schema-1 fixture with an author and identity on its two seats. */
function withIdentity({ author = AUTHOR, noAuthor = false, seatA = {}, seatB = {} } = {}) {
  const record = base();
  if (!noAuthor) record.author = author;
  Object.assign(record.seats[0], seatA);
  Object.assign(record.seats[1], seatB);
  return record;
}
const errorsOf = (record, option) => validateFindings(record, option).errors;
// The fixture's own advisories (unverified-blocker) are not this file's concern.
const identityOf = (record, option) => reviewAdvisories(record, option).filter((a) => /^(same-family|family-unverified)/.test(a));

// ---- the validator ------------------------------------------------------------------------------

test('INV-1: a seat with the author\'s agent and session (both) is error independence:<seatId>', () => {
  const record = withIdentity({ seatA: { agent: 'core-implementer', session: 'sess-1', family: 'gpt' } });
  assert.deepEqual(errorsOf(record), ['independence:backend-expert']);
});

test('INV-1 is OR (C-4): the author\'s agent with a different or null session is error independence:<seatId>', () => {
  const err = ['independence:backend-expert'];
  assert.deepEqual(errorsOf(withIdentity({ seatA: { agent: 'core-implementer', session: 'sess-2', family: 'gpt' } })), err);
  assert.deepEqual(errorsOf(withIdentity({ seatA: { agent: 'core-implementer', session: null, family: 'gpt' } })), err);
  assert.deepEqual(errorsOf(withIdentity({ author: { ...AUTHOR, session: null }, seatA: { agent: 'core-implementer', session: 'sess-1', family: 'gpt' } })), err);
  assert.deepEqual(errorsOf(withIdentity({ author: { ...AUTHOR, session: null }, seatA: { agent: 'core-implementer', session: null, family: 'gpt' } })), err);
});

test('INV-1 is OR (C-4): the author\'s session under a different agent is error independence:<seatId>', () => {
  assert.deepEqual(errorsOf(withIdentity({ seatA: { agent: 'reviewer', session: 'sess-1', family: 'gpt' } })), ['independence:backend-expert']);
});

test('INV-1: a different agent with a different or null session on either side passes', () => {
  assert.deepEqual(errorsOf(withIdentity({ seatA: { agent: 'reviewer', session: 'sess-2', family: 'gpt' } })), []);
  assert.deepEqual(errorsOf(withIdentity({ seatA: { agent: 'reviewer', session: null, family: 'gpt' } })), []);
  assert.deepEqual(errorsOf(withIdentity({ author: { ...AUTHOR, session: null }, seatA: { agent: 'reviewer', session: null, family: 'gpt' } })), []);
  assert.deepEqual(errorsOf(withIdentity({ author: { ...AUTHOR, session: null }, seatA: { agent: 'reviewer', session: 'sess-1', family: 'gpt' } })), []);
});

test('a seat identity without an author declares nothing to compare: valid, no advisory', () => {
  const record = withIdentity({ noAuthor: true, seatA: { agent: 'core-implementer', session: 'sess-1', family: 'claude' } });
  assert.deepEqual(errorsOf(record), []);
  assert.deepEqual(identityOf(record), []);
});

test('same non-unknown family: an advisory under warn (the default), an error under refuse', () => {
  const record = withIdentity({ seatA: { agent: 'reviewer', session: 's9', family: 'claude' }, seatB: { agent: 'reviewer', session: 's8', family: 'gpt' } });
  assert.deepEqual(errorsOf(record), []);
  assert.deepEqual(errorsOf(record, { sameFamily: 'warn' }), []);
  assert.deepEqual(identityOf(record), ['same-family:backend-expert']);
  assert.deepEqual(identityOf(record, { sameFamily: 'warn' }), ['same-family:backend-expert']);
  assert.deepEqual(errorsOf(record, { sameFamily: 'refuse' }), ['same-family:backend-expert']);
  assert.deepEqual(identityOf(record, { sameFamily: 'refuse' }), []);
});

test('an unknown family, or a missing seat family, on either side is family-unverified', () => {
  const record = withIdentity({ seatA: { agent: 'reviewer', session: 's9', family: 'unknown' }, seatB: { agent: 'reviewer', session: 's8' } });
  assert.deepEqual(errorsOf(record, { sameFamily: 'refuse' }), []);
  assert.deepEqual(identityOf(record), ['family-unverified:backend-expert', 'family-unverified:principle-software-engineer']);
  const unknownAuthor = withIdentity({ author: { ...AUTHOR, family: 'unknown' }, seatA: { agent: 'reviewer', session: 's9', family: 'claude' }, seatB: { agent: 'reviewer', session: 's8', family: 'gpt' } });
  assert.deepEqual(identityOf(unknownAuthor), ['family-unverified:backend-expert', 'family-unverified:principle-software-engineer']);
});

test('a bad author shape is error author; a bad seat identity is error seat-identity:<seatId>', () => {
  for (const author of ['me', null, [], {}, { agent: '', session: null, family: 'claude' }, { agent: 'a', session: '', family: 'claude' },
    { agent: 'a', session: 1, family: 'claude' }, { agent: 'a', session: null, family: 'Claude' }, { agent: 'a', session: null },
    { agent: 'a', session: null, family: 'claude', extra: true }]) {
    assert.deepEqual(errorsOf(withIdentity({ author })), ['author'], JSON.stringify(author));
  }
  assert.deepEqual(errorsOf(withIdentity({ author: { agent: 'a', session: null, family: 'unknown' } })), []);
  for (const bad of [{ agent: '' }, { agent: 3 }, { session: '' }, { session: 7 }, { family: 'GPT' }, { family: '' }, { family: null }]) {
    assert.deepEqual(errorsOf(withIdentity({ seatA: bad })), ['seat-identity:backend-expert'], JSON.stringify(bad));
  }
  assert.deepEqual(errorsOf(withIdentity({ seatA: { agent: 'x', session: null, family: 'unknown' } })), []);
});

test('a record with a bad author stays valid-checked for its other fields and yields no identity advisory', () => {
  const record = withIdentity({ author: 'me' });
  assert.deepEqual(identityOf(record), []);
});

test('control (a): a record without author validates and advises exactly as the fixtures always did', () => {
  for (const name of fs.readdirSync(FIXTURES)) {
    const record = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
    assert.deepEqual(validateFindings(record), { ok: true, errors: [] }, name);
    assert.deepEqual(validateFindings(record, { sameFamily: 'refuse' }), { ok: true, errors: [] }, name);
    assert.ok(!reviewAdvisories(record).some((a) => /^(same-family|family-unverified)/.test(a)), name);
    assert.deepEqual(reviewAdvisories(record, { sameFamily: 'refuse' }), reviewAdvisories(record), name);
  }
  // Every committed findings.json under agent-docs/ (when this checkout carries any) still validates.
  const docs = path.join(REPO_ROOT, 'agent-docs', 'doflow');
  const found = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'findings.json' && full.includes(`${path.sep}review${path.sep}`)) found.push(full);
    }
  })(docs);
  for (const file of found) {
    const result = validateFindings(fs.readFileSync(file));
    // A record committed before the protocol keys existed may name a retired value; only identity keys are this test's concern.
    assert.ok(!result.errors.some((e) => /^(author|independence|same-family|seat-identity)/.test(e)), file);
  }
});

// ---- the check verb -----------------------------------------------------------------------------

function scratchRepo(t) {
  const f = createSettingsEnv(t, { prefix: 'doflow-review-indep-' });
  const env = f.env();
  const git = (...args) => {
    const r = spawnSync('git', ['-C', f.project, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q');
  fs.writeFileSync(path.join(f.project, 'a.txt'), 'a');
  git('add', 'a.txt');
  const commit = (subject, trailer) => {
    fs.appendFileSync(path.join(f.project, 'a.txt'), subject);
    git('add', 'a.txt');
    git('commit', '-q', '-m', subject, ...(trailer ? ['-m', trailer] : []));
    return git('rev-parse', 'HEAD');
  };
  return { f, env, git, commit };
}

function check(s, record, extraEnv = {}) {
  const file = path.join(s.f.project, 'review', 'findings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record));
  const lines = [];
  const code = handleReviewCommand({
    action: 'check', path: file, json: true, cwd: s.f.project, env: { ...s.env, ...extraEnv },
    out: (line) => lines.push(line), writer: { write() {} },
  });
  return { code, result: JSON.parse(lines.join('\n')) };
}

const CLAUDE_TRAILER = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>';

test('check: a project review.sameFamily refuse turns a same-family record invalid; the default warns', (t) => {
  const s = scratchRepo(t);
  const head = s.commit('one');
  const record = withIdentity({ seatA: { agent: 'reviewer', session: 's9', family: 'claude' }, seatB: { agent: 'reviewer', session: 's8', family: 'gpt' } });
  record.reviewedHead = head;
  const warned = check(s, record);
  assert.equal(warned.code, 0);
  assert.ok(warned.result.advisories.includes('same-family:backend-expert'), warned.result.advisories.join());
  s.f.writeProjectSettings({ schema: 1, 'review.sameFamily': 'refuse' });
  const refused = check(s, record);
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.result.errors, ['same-family:backend-expert']);
  assert.equal(refused.result.valid, false);
});

test('check: through bin/doflow.js the refuse setting reaches the verb', (t) => {
  const s = scratchRepo(t);
  const head = s.commit('one');
  s.f.writeProjectSettings({ schema: 1, 'review.sameFamily': 'refuse' });
  const record = withIdentity({ seatA: { agent: 'reviewer', session: 's9', family: 'claude' }, seatB: { agent: 'reviewer', session: 's8', family: 'gpt' } });
  record.reviewedHead = head;
  const file = path.join(s.f.project, 'findings.json');
  fs.writeFileSync(file, JSON.stringify(record));
  const env = { ...s.env, DOFLOW_TELEMETRY: 'off' };
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'doflow.js'), 'review', '--action', 'check', '--path', file, '--json'], { cwd: s.f.project, env, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).errors, ['same-family:backend-expert']);
});

test('check: INV-1 is an error through the verb too', (t) => {
  const s = scratchRepo(t);
  const record = withIdentity({ seatA: { agent: 'core-implementer', session: 'sess-1', family: 'gpt' } });
  record.reviewedHead = s.commit('one');
  const got = check(s, record);
  assert.equal(got.code, 1);
  assert.deepEqual(got.result.errors, ['independence:backend-expert']);
});

test('check: unreadable settings (a broken project file, or a load that throws) are error same-family-setting-unread, exit 1 (C-6)', (t) => {
  const s = scratchRepo(t);
  const record = withIdentity({ seatA: { agent: 'reviewer', session: 's9', family: 'claude' }, seatB: { agent: 'reviewer', session: 's8', family: 'gpt' } });
  record.reviewedHead = s.commit('one');
  fs.writeFileSync(path.join(s.f.project, '.doflow', 'settings.json'), '{ not json');
  const broken = check(s, record);
  assert.equal(broken.code, 1);
  assert.deepEqual(broken.result.errors, ['same-family-setting-unread', 'review-preset-setting-unread'], 'a broken file is unreadable for every review.* key (C-2 closure reads review.preset too)');
  assert.ok(!broken.result.advisories.includes('same-family-setting-unread'));
  fs.rmSync(path.join(s.f.project, '.doflow', 'settings.json'));
  const file = path.join(s.f.project, 'review', 'findings.json');
  const lines = [];
  const code = handleReviewCommand({
    action: 'check', path: file, json: true, cwd: s.f.project, env: { ...s.env, DOFLOW_CONFIG_DIR: undefined },
    out: (line) => lines.push(line), writer: { write() {} },
    loadSettings: () => { throw new Error('boom'); },
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(lines.join('\n')).errors, ['same-family-setting-unread', 'review-preset-setting-unread']);
});

test('check: a Claude trailer against author family gpt is author-trailer-contradiction; against claude or unknown, nothing', (t) => {
  const s = scratchRepo(t);
  const head = s.commit('one', CLAUDE_TRAILER);
  const seats = { seatA: { agent: 'reviewer', session: 's9', family: 'gpt' }, seatB: { agent: 'reviewer', session: 's8', family: 'gpt' } };
  const mk = (family) => ({ ...withIdentity({ author: { ...AUTHOR, family }, ...seats }), reviewedHead: head });
  assert.ok(check(s, mk('gpt')).result.advisories.includes('author-trailer-contradiction'));
  assert.ok(!check(s, mk('claude')).result.advisories.includes('author-trailer-contradiction'));
  assert.ok(!check(s, mk('unknown')).result.advisories.includes('author-trailer-contradiction'));
});

test('check: family claude against only a non-Claude trailer is a contradiction; no trailer adds nothing', (t) => {
  const s = scratchRepo(t);
  const other = s.commit('two', 'Co-Authored-By: Codex <noreply@openai.com>');
  const bare = s.commit('three');
  const seats = { seatA: { agent: 'reviewer', session: 's9', family: 'gpt' }, seatB: { agent: 'reviewer', session: 's8', family: 'gpt' } };
  const rec = (head) => ({ ...withIdentity(seats), reviewedHead: head });
  assert.ok(check(s, rec(other)).result.advisories.includes('author-trailer-contradiction'));
  assert.deepEqual(check(s, rec(bare)).result.advisories.filter((a) => a.startsWith('author-')), []);
});

test('check: a head git cannot find is author-unchecked:trailers', (t) => {
  const s = scratchRepo(t);
  s.commit('one');
  const record = { ...withIdentity(), reviewedHead: 'f'.repeat(40) };
  assert.ok(check(s, record).result.advisories.includes('author-unchecked:trailers'));
});

function writeStore(s, slug, body) {
  const file = storeFile(projectRoot(s.f.project), slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

test('check: attempt owners that do not include the author agent are author-attempt-contradiction', (t) => {
  const s = scratchRepo(t);
  const record = { ...withIdentity({ author: { ...AUTHOR, agent: 'system-architect' }, seatA: { agent: 'reviewer', session: 's9', family: 'gpt' } }), reviewedHead: s.commit('one') };
  writeStore(s, record.slug, JSON.stringify({ tasks: { 'A.1': { attempts: [{ owner: 'core-implementer', state: 'finished' }] } } }));
  assert.ok(check(s, record).result.advisories.includes('author-attempt-contradiction'));
  record.author.agent = 'core-implementer';
  assert.ok(!check(s, record).result.advisories.includes('author-attempt-contradiction'));
});

test('check: an absent store adds nothing; a malformed one is author-unchecked:attempts', (t) => {
  const s = scratchRepo(t);
  const record = { ...withIdentity({ seatA: { agent: 'reviewer', session: 's9', family: 'gpt' } }), reviewedHead: s.commit('one') };
  assert.deepEqual(check(s, record).result.advisories.filter((a) => a.startsWith('author-')), []);
  writeStore(s, record.slug, '{ nope');
  assert.ok(check(s, record).result.advisories.includes('author-unchecked:attempts'));
  writeStore(s, record.slug, JSON.stringify({ tasks: 'x' }));
  assert.ok(check(s, record).result.advisories.includes('author-unchecked:attempts'));
});

test('check: a record without author runs no cross-check and no settings read', (t) => {
  const s = scratchRepo(t);
  const record = { ...base(), reviewedHead: s.commit('one', CLAUDE_TRAILER) };
  writeStore(s, record.slug, '{ nope');
  const got = check(s, record);
  assert.equal(got.code, 0);
  assert.deepEqual(got.result.advisories.filter((a) => a.startsWith('author-') || a.startsWith('same-family')), []);
});

test('crossCheckAuthor never throws: a failing git runner and an unreadable store become author-unchecked advisories', () => {
  const record = { ...withIdentity(), reviewedHead: 'a'.repeat(40) };
  const advisories = crossCheckAuthor({
    record, cwd: '/nonexistent-doflow-cwd', env: {},
    git: () => { throw new Error('no git'); },
    readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  assert.deepEqual(advisories, ['author-unchecked:attempts', 'author-unchecked:trailers']);
});

'use strict';

// 176 T3 (design section 7, IC-005): the `review-findings` case source. The fixture tree under
// test/fixtures/advice-replay/review-findings holds one folder per slug (kept outside an `agent-docs` folder, which git
// ignores); each test copies it into a scratch project's `agent-docs/doflow/`, so the real checkout is never read.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../../../helper/tmp.ts');
const { REPO_ROOT } = require('../../../../../src/helper/repo-root.ts');
const { itemText, pairState } = require('../../../../../src/runtime/advice/same-issue/rule.ts');
const { SOURCE_IDS, getSource } = require('../../../../../src/runtime/advice/replay/sources/index.ts');
const reviewFindings = require('../../../../../src/runtime/advice/replay/sources/review-findings.ts');

const { source, build, CODE_DIGEST, computeCodeDigest } = reviewFindings;
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'advice-replay', 'review-findings');
const KIND = {
  id: 'same-issue',
  params: { itemBytes: 512, questionsPerCall: 8, maxPairs: 32, perItem: 2, candidateAtPct: 15, flagAtPct: 40, locatorBonusPct: 15, maxCompare: 2000 },
};

/** A scratch project whose `agent-docs/doflow` is a copy of the fixture, plus a symlinked record, a symlinked review folder, a symlinked slug and a plain file. */
function project(t: any) {
  const root = tempDir(t, 'doflow-advice-replay-findings-');
  const doflow = path.join(root, 'agent-docs', 'doflow');
  fs.mkdirSync(path.dirname(doflow), { recursive: true });
  fs.cpSync(FIXTURE, doflow, { recursive: true });
  fs.mkdirSync(path.join(doflow, 'slug-linked', 'review'), { recursive: true });
  fs.symlinkSync(path.join(doflow, 'slug-alpha', 'review', 'findings.json'), path.join(doflow, 'slug-linked', 'review', 'findings.json'));
  fs.mkdirSync(path.join(doflow, 'slug-reviewlink'), { recursive: true });
  fs.symlinkSync(path.join(doflow, 'slug-alpha', 'review'), path.join(doflow, 'slug-reviewlink', 'review'));
  fs.symlinkSync(path.join(doflow, 'slug-alpha'), path.join(doflow, 'slug-dirlink'));
  fs.writeFileSync(path.join(doflow, 'notes.md'), 'not a slug');
  return { root, doflow };
}

const run = (p: any, extra: any = {}) => build({ projectRoot: p.root, roots: {}, kind: KIND, ...extra });
const caseId = (slug: string, a: string, b: string) => {
  const [low, high] = a < b ? [a, b] : [b, a];
  return crypto.createHash('sha256').update(`${slug}\n${low}\n${high}`).digest('hex').slice(0, 16);
};

/** The finding of the fixture record `slug` named `id`, as the source turns it into an item. */
function itemOf(slug: string, id: string) {
  const record = JSON.parse(fs.readFileSync(path.join(FIXTURE, slug, 'review', 'findings.json'), 'utf8'));
  const finding = record.seats.flatMap((seat: any) => seat.findings).find((f: any) => f.id === id);
  return { id, text: itemText(`${finding.locator} — ${finding.summary}`, KIND.params.itemBytes), locator: finding.locator };
}

// slug, lower id, higher id, label, rule: what the fixture records say, written out by hand.
const EXPECTED: Array<[string, string, string, string, string]> = [
  ['slug-alpha', 'a-1', 'a-3', 'yes', 'yes'], // merged in c-1
  ['slug-alpha', 'a-2', 'a-5', 'no', 'yes'],  // similar, placed in c-2 and c-3
  ['slug-beta', 'b-1', 'b-2', 'yes', 'yes'],
  ['slug-beta', 'b-2', 'b-4', 'no', 'no'],
  ['slug-beta', 'b-2', 'b-5', 'no', 'no'],
  ['slug-beta', 'b-4', 'b-5', 'yes', 'yes'],
];

describe('metadata', () => {
  test('the source is registered and carries the design facts and the code pin as its params', () => {
    assert.ok(SOURCE_IDS.includes('review-findings'));
    assert.equal(getSource('review-findings'), source);
    assert.deepEqual([source.id, source.builderVersion, source.labelIsRule, source.origin], ['review-findings', 1, false, 'project']);
    assert.deepEqual(source.params, { codeDigest: CODE_DIGEST });
    assert.match(CODE_DIGEST, /^[0-9a-f]{64}$/);
  });
});

describe('cases', () => {
  test('(a)(e) one case per candidate pair: label yes exactly when one converged entry holds both, state from the item texts', (t: any) => {
    const built = run(project(t));
    const want = EXPECTED.map(([slug, a, b, label, rule]) => ({
      id: caseId(slug, a, b), state: pairState(itemOf(slug, a), itemOf(slug, b)), label, rule,
    })).sort((x, y) => (x.id < y.id ? -1 : 1));
    assert.deepEqual(built.cases, want);
    assert.equal(built.cases[0].state.split('\n').length >= 2, true);
  });

  test('(b) each skip is counted by its reason; the symlinked record, review folder and slug add nothing but two unreadable files', (t: any) => {
    const { skipped } = run(project(t));
    assert.deepEqual(skipped, {
      'not-a-review-record': 1,   // slug-schema-two
      'not-a-directory': 2,       // slug-dirlink (a link to a folder), notes.md
      'single-seat': 1,           // slug-oneseat: production asks only multi-seat reviews
      'unreadable-file': 3,       // slug-broken, slug-linked, slug-reviewlink
      ungrouped: 1,               // a-6 / a-7: neither is in a converged entry
      'not-a-candidate': 25,      // 19 in alpha (21 placed pairs, 2 candidates), 6 in beta (10 placed pairs, 4 candidates)
      'merged-not-a-candidate': 1, // a-8 / a-9: merged by the synthesizer, no shared words
    });
  });

  test('(b) a schema-one record whose seats or converged is not an array is not a review record', (t: any) => {
    const p = project(t);
    for (const [slug, body] of [['slug-noseats', { schema: 1, seats: {}, converged: [] }], ['slug-noconv', { schema: 1, seats: [], converged: null }]] as any[]) {
      fs.mkdirSync(path.join(p.doflow, slug, 'review'), { recursive: true });
      fs.writeFileSync(path.join(p.doflow, slug, 'review', 'findings.json'), JSON.stringify(body));
    }
    assert.equal(run(p).skipped['not-a-review-record'], 3);
  });

  test('(b) a record over 8 MiB is unreadable and is not read', (t: any) => {
    const p = project(t);
    const big = path.join(p.doflow, 'slug-beta', 'review', 'findings.json');
    const read: string[] = [];
    const fsImpl = {
      ...fs,
      lstatSync: (file: string) => { const s = fs.lstatSync(file); return file === big ? { isFile: () => true, size: 8 * 1024 * 1024 + 1 } : s; },
      readFileSync: (file: string, ...rest: any[]) => { read.push(file); return fs.readFileSync(file, ...rest); },
    };
    const built = run(p, { fsImpl });
    assert.equal(built.skipped['unreadable-file'], 4);
    assert.ok(!read.includes(big));
    assert.ok(built.cases.every((c: any) => !EXPECTED.slice(2).some(([slug, a, b]) => caseId(slug, a, b) === c.id)));
  });

  test('(b) an id reached twice is left out of every occurrence and counted per occurrence', (t: any) => {
    const p = project(t);
    const fsImpl = { ...fs, readdirSync: (dir: string, opts: any) => { const list = fs.readdirSync(dir, opts); return dir === p.doflow ? [...list, ...list] : list; } };
    const built = run(p, { fsImpl });
    assert.deepEqual(built.cases, []);
    assert.equal(built.skipped['duplicate-case'], 12);
  });

  test('(c) a linked record is not followed: the link to the alpha record yields no alpha case beyond its own', (t: any) => {
    const p = project(t);
    const link = path.join(p.doflow, 'slug-linked', 'review', 'findings.json');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    const ids = run(p).cases.map((c: any) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.includes(caseId('slug-linked', 'a-1', 'a-3')), false);
  });

  test('(c) a linked review folder is not followed: it is an unreadable file and yields no case', (t: any) => {
    const p = project(t);
    const link = path.join(p.doflow, 'slug-reviewlink', 'review');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    const built = run(p);
    assert.equal(built.skipped['unreadable-file'], 3);
    assert.equal(built.cases.some((c: any) => c.id === caseId('slug-reviewlink', 'a-1', 'a-3')), false);
  });

  test('(b) a finding id repeated within or across seats keeps its first item: no pair of an id with itself, each repeat counted', (t: any) => {
    const p = project(t);
    const finding = (id: string, summary: string) => ({ id, severity: 'should-fix', locator: 'src/api.ts:20', summary });
    const record = {
      schema: 1, row: '900', slug: 'slug-dup', rounds: 1,
      seats: [
        { id: 'seat-1', findings: [finding('d-1', 'handler returns an error on an empty body'), finding('d-1', 'handler returns an error on an empty body again')] },
        { id: 'seat-2', findings: [finding('d-1', 'handler returns an error on an empty body'), finding('d-2', 'empty request body causes a server error')] },
      ],
      converged: [{ id: 'c-1', from: ['d-1', 'd-2'] }],
    };
    fs.mkdirSync(path.join(p.doflow, 'slug-dup', 'review'), { recursive: true });
    fs.writeFileSync(path.join(p.doflow, 'slug-dup', 'review', 'findings.json'), JSON.stringify(record));
    const built = run(p);
    assert.equal(built.skipped['duplicate-finding-id'], 2);
    const dup = built.cases.filter((c: any) => [caseId('slug-dup', 'd-1', 'd-1'), caseId('slug-dup', 'd-1', 'd-2')].includes(c.id));
    assert.deepEqual(dup.map((c: any) => [c.id, c.label]), [[caseId('slug-dup', 'd-1', 'd-2'), 'yes']]);
  });

  test('(b) a finding with an empty id or an empty summary is not an item and is counted as incomplete', (t: any) => {
    const p = project(t);
    const finding = (id: any, summary: any) => ({ id, severity: 'should-fix', locator: 'src/api.ts:20', summary });
    const record = {
      schema: 1, row: '900', slug: 'slug-incomplete', rounds: 1,
      seats: [
        { id: 'seat-1', findings: [finding('', 'handler returns an error on an empty body'), finding('i-1', ''), finding('i-2', '   '), finding('i-3', 'handler returns an error on an empty body')] },
        { id: 'seat-2', findings: [finding('i-4', 'empty request body causes a server error')] },
      ],
      converged: [{ id: 'c-1', from: ['i-3', 'i-4'] }],
    };
    fs.mkdirSync(path.join(p.doflow, 'slug-incomplete', 'review'), { recursive: true });
    fs.writeFileSync(path.join(p.doflow, 'slug-incomplete', 'review', 'findings.json'), JSON.stringify(record));
    const built = run(p);
    assert.equal(built.skipped['incomplete-finding'], 3);
    assert.equal(built.cases.some((c: any) => c.id === caseId('slug-incomplete', 'i-3', 'i-4')), true);
  });

  test('(d) cases are sorted by id and the same on a second run', (t: any) => {
    const p = project(t);
    const first = run(p);
    const ids = first.cases.map((c: any) => c.id);
    assert.deepEqual(ids, [...ids].sort());
    assert.deepEqual(run(p), first);
  });

  test('a project with no agent-docs/doflow folder gives no cases and no skips', (t: any) => {
    assert.deepEqual(build({ projectRoot: tempDir(t, 'doflow-advice-replay-empty-'), roots: {}, kind: KIND }), { cases: [], skipped: {} });
  });
});

describe('(f) reads and writes', () => {
  /** Every directory and record path read, and a throw on any call that could write. */
  function spy(p: any) {
    const touched: string[] = [];
    const reads = new Set(['readdirSync', 'lstatSync', 'readFileSync']);
    const fsImpl: any = new Proxy(fs, {
      get(target: any, name: string) {
        if (reads.has(name)) return (file: string, ...rest: any[]) => { touched.push(String(file)); return target[name](file, ...rest); };
        if (typeof target[name] === 'function' && /write|append|mkdir|rm|unlink|rename|copy|symlink|link|chmod|chown|truncate|utimes|open|create/i.test(name)) {
          return () => { throw new Error(`write call ${name}`); };
        }
        return target[name];
      },
    });
    return { fsImpl, touched, root: p.root };
  }

  test('only agent-docs/doflow and its slugs\' review records are touched, and nothing is written', (t: any) => {
    const p = project(t);
    const before = fs.readdirSync(p.root, { recursive: true }).sort();
    const { fsImpl, touched } = spy(p);
    const built = run(p, { fsImpl });
    assert.ok(built.cases.length > 0);
    const record = /^agent-docs\/doflow\/[^/]+\/review\/findings\.json$/;
    for (const file of touched) {
      const rel = path.relative(p.root, file).split(path.sep).join('/');
      assert.ok(rel === 'agent-docs/doflow' || /^agent-docs\/doflow\/[^/]+\/review$/.test(rel) || record.test(rel), `unexpected read of ${rel}`);
    }
    assert.deepEqual(fs.readdirSync(p.root, { recursive: true }).sort(), before);
  });
});

describe('the code pin', () => {
  const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file));
  const SELF = 'src/runtime/advice/replay/sources/review-findings.ts';
  const withoutPin = (text: string) => text.split('\n').filter((line) => !line.includes('CODE_DIGEST =')).join('\n');
  const expected = (self: string = read(SELF).toString('utf8')) => crypto.createHash('sha256')
    .update(read('src/runtime/advice/same-issue/rule.ts')).update(read('src/runtime/advice/batch.ts')).update(withoutPin(self)).digest('hex');

  test('the constant equals the digest of rule.ts, batch.ts and this file without its pin line; set CODE_DIGEST to computeCodeDigest() after a change', () => {
    assert.equal(computeCodeDigest(), expected());
    assert.equal(CODE_DIGEST, computeCodeDigest());
  });

  test('the pin line itself does not move the digest; one changed byte in any of the three files does; an unreadable file gives null', () => {
    const swapped = (file: string, edit: (text: string) => string) => ({
      ...fs,
      readFileSync: (name: string, ...rest: any[]) => {
        const real = fs.readFileSync(name, ...rest);
        return String(name).endsWith(file) ? (Buffer.isBuffer(real) ? Buffer.from(edit(real.toString('utf8'))) : edit(real)) : real;
      },
    });
    assert.equal(computeCodeDigest(swapped('review-findings.ts', (text) => text.replace(CODE_DIGEST, '0'.repeat(64)))), CODE_DIGEST);
    for (const file of ['same-issue/rule.ts', 'advice/batch.ts', 'sources/review-findings.ts']) {
      assert.notEqual(computeCodeDigest(swapped(file, (text) => `${text} `)), CODE_DIGEST, file);
    }
    assert.equal(computeCodeDigest({ ...fs, readFileSync: () => { throw new Error('gone'); } }), null);
  });
});

'use strict';

// Path placement and bounded text (feature 151, IC-006, IC-024; FR-005, FR-008, FR-027, NFR-002,
// NFR-010; DEC-025, D12): a path reaches a body only as {anchor, rel}; free text has every anchor
// value replaced in the whole string, longest first, before `maskLite` runs over the whole result;
// a bounded text over its cap is withheld whole, never cut. No anchor value is in any output.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { anchorsOf, placePath, placeText, boundedText, Mismatch, WITHHELD, TOO_LONG } = require('../src/place.ts');
const { maskLite, MASKED, EMAIL, IP } = require('../src/mask-lite.ts');

/** Paths that do not exist, so `anchorsOf` keeps only the value as given. */
const GONE = '/doflow-151-place-absent';
const HOME = `${GONE}/u/kai`;
const PROJECT = `${HOME}/work/app`;
const LAYERS = `${HOME}/work/main`;
const CONFIG = `${HOME}/.config/doflow`;
const plain = anchorsOf({ projectRoot: PROJECT, home: HOME, configHome: CONFIG, layersFrom: LAYERS });

/** Every anchor value of `anchors`, for the "never in any output" checks. */
const valuesOf = (anchors: any): string[] => [...anchors.project, ...anchors.projectLayers, ...anchors.configHome, ...anchors.home];

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('anchorsOf keeps each value and its realpath form, and drops short values and the root', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-place-')));
  dirs.push(base);
  const real: Record<string, string> = {};
  const link: Record<string, string> = {};
  for (const name of ['project', 'layers', 'config', 'home']) {
    real[name] = path.join(base, `real-${name}`);
    link[name] = path.join(base, `link-${name}`);
    fs.mkdirSync(real[name]);
    fs.symlinkSync(real[name], link[name], 'dir');
  }
  const anchors = anchorsOf({ projectRoot: link.project, home: link.home, configHome: link.config, layersFrom: link.layers });
  assert.deepEqual(anchors.project, [link.project, real.project]);
  assert.deepEqual(anchors.projectLayers, [link.layers, real.layers]);
  assert.deepEqual(anchors.configHome, [link.config, real.config]);
  assert.deepEqual(anchors.home, [link.home, real.home]);

  // A value whose realpath is itself is listed once; one that does not resolve is kept as given.
  const same = anchorsOf({ projectRoot: real.project, home: HOME });
  assert.deepEqual(same.project, [real.project]);
  assert.deepEqual(same.home, [HOME]);
  assert.deepEqual(same.configHome, []);
  assert.deepEqual(same.projectLayers, []);

  // Shorter than 2 characters, or `/`, is dropped; a trailing separator is not part of the value.
  const dropped = anchorsOf({ projectRoot: '/', home: 'h', configHome: null, layersFrom: '' });
  assert.deepEqual(dropped, { project: [], projectLayers: [], configHome: [], home: [] });
  assert.deepEqual(anchorsOf({ projectRoot: `${PROJECT}/`, home: HOME }).project, [PROJECT]);

  // A path under the link and under the real directory places the same.
  assert.deepEqual(placePath(path.join(link.project, 'a.json'), anchors), { anchor: 'project', rel: 'a.json' });
  assert.deepEqual(placePath(path.join(real.project, 'a.json'), anchors), { anchor: 'project', rel: 'a.json' });
  const text = placeText(`read ${link.config}/s.json then ${real.config}/s.json`, anchors);
  assert.equal(text, 'read <config home>/s.json then <config home>/s.json');
});

test('placePath tries the anchors longest value first, so a nested anchor wins', () => {
  assert.deepEqual(placePath(`${PROJECT}/.doflow/settings.json`, plain), { anchor: 'project', rel: '.doflow/settings.json' });
  assert.deepEqual(placePath(`${LAYERS}/.doflow/settings.json`, plain), { anchor: 'project-layers', rel: '.doflow/settings.json' });
  assert.deepEqual(placePath(`${CONFIG}/settings.json`, plain), { anchor: 'config-home', rel: 'settings.json' });
  assert.deepEqual(placePath(`${HOME}/notes/x.md`, plain), { anchor: 'home', rel: 'notes/x.md' });
  assert.deepEqual(placePath(PROJECT, plain), { anchor: 'project', rel: '' });
  assert.deepEqual(placePath(HOME, plain), { anchor: 'home', rel: '' });
  // A sibling that only shares a prefix with an anchor is not under it.
  assert.deepEqual(placePath(`${PROJECT}2/x.json`, plain), { anchor: 'home', rel: 'work/app2/x.json' });

  // Longest first beats the group order: a worktree inside the layers checkout is the project.
  const nested = anchorsOf({ projectRoot: `${LAYERS}/wt`, home: HOME, layersFrom: LAYERS });
  assert.deepEqual(placePath(`${LAYERS}/wt/.doflow/local.json`, nested), { anchor: 'project', rel: '.doflow/local.json' });
  assert.deepEqual(placePath(`${LAYERS}/.doflow/settings.json`, nested), { anchor: 'project-layers', rel: '.doflow/settings.json' });

  // placeText follows the same order over nested anchors.
  assert.equal(
    placeText(`a ${PROJECT}/x b ${LAYERS}/y c ${CONFIG}/z d ${HOME}/w`, plain),
    'a <project>/x b <project layers>/y c <config home>/z d ~/w',
  );
});

test('placeText replaces a project root outside the home folder, which maskLite alone leaves', () => {
  const outside = anchorsOf({ projectRoot: '/srv/doflow-151-absent/app', home: HOME });
  const text = 'cannot read /srv/doflow-151-absent/app/.doflow/settings.json (unparseable)';
  assert.ok(maskLite(text).includes('/srv/doflow-151-absent/app'), 'control: the home rule does not cover this root');
  const out = placeText(text, outside);
  assert.equal(out, 'cannot read <project>/.doflow/settings.json (unparseable)');
  for (const value of valuesOf(outside)) assert.ok(!out.includes(value));
});

test('a `\\` separator is read as `/` on every platform', () => {
  const win = anchorsOf({ projectRoot: 'C:\\w\\app', home: 'C:\\Users\\kai' });
  assert.deepEqual(placePath('C:\\w\\app\\.doflow\\settings.json', win), { anchor: 'project', rel: '.doflow/settings.json' });
  assert.deepEqual(placePath('C:/w/app/.doflow/settings.json', win), { anchor: 'project', rel: '.doflow/settings.json' });
  assert.deepEqual(placePath('C:\\Users\\kai\\AppData\\x.json', win), { anchor: 'home', rel: 'AppData/x.json' });
  assert.deepEqual(placePath('core\\registry\\settings.json', win), { anchor: 'registry', rel: 'settings.json' });
  assert.deepEqual(placePath('D:\\elsewhere\\deep\\file.json', win), { anchor: 'other', rel: 'file.json' });
  // Text in either separator form loses the anchor value.
  const out = placeText('at C:\\w\\app\\a.json and C:/w/app/b.json and C:/Users/kai/c', win);
  assert.equal(out, 'at <project>\\a.json and <project>/b.json and ~/c');
});

test('`..`, an unsafe segment, an over-long rel and a rel the mask would change are withheld', () => {
  assert.deepEqual(placePath(`${PROJECT}/../secret/x.json`, plain), { anchor: 'project', rel: WITHHELD });
  assert.deepEqual(placePath(`${PROJECT}/has space/x.json`, plain), { anchor: 'project', rel: WITHHELD });
  assert.deepEqual(placePath(`${PROJECT}/a//b.json`, plain), { anchor: 'project', rel: WITHHELD });
  assert.deepEqual(placePath(`${PROJECT}/${'s'.repeat(129)}`, plain), { anchor: 'project', rel: WITHHELD });
  assert.deepEqual(placePath(`${PROJECT}/${'s'.repeat(128)}`, plain), { anchor: 'project', rel: 's'.repeat(128) });
  assert.deepEqual(placePath(`${PROJECT}/jane.doe@example.invalid`, plain), { anchor: 'project', rel: WITHHELD });
  assert.deepEqual(placePath('core/registry/../../etc/passwd', plain), { anchor: 'registry', rel: WITHHELD });

  // 512 bytes is the bound: three 128-byte segments, a 125-byte one and three separators.
  const seg = 'r'.repeat(128);
  const at512 = `${seg}/${seg}/${seg}/${'r'.repeat(125)}`;
  assert.equal(Buffer.byteLength(at512), 512);
  assert.deepEqual(placePath(`${PROJECT}/${at512}`, plain), { anchor: 'project', rel: at512 });
  assert.deepEqual(placePath(`${PROJECT}/${at512}c`, plain), { anchor: 'project', rel: WITHHELD });
});

test('registry, a safe relative path, and anything else as other with its last segment only', () => {
  assert.deepEqual(placePath('core/registry/settings.json', plain), { anchor: 'registry', rel: 'settings.json' });
  assert.deepEqual(placePath('core/registry/', plain), { anchor: 'registry', rel: '' });
  assert.deepEqual(placePath('.doflow/settings.json', plain), { anchor: 'project', rel: '.doflow/settings.json' });
  assert.deepEqual(placePath('/etc/doflow/settings.json', plain), { anchor: 'other', rel: 'settings.json' });
  assert.deepEqual(placePath('/Users/jane/private/plan.md', plain), { anchor: 'other', rel: 'plan.md' });
  assert.deepEqual(placePath('../outside/x.json', plain), { anchor: 'other', rel: 'x.json' });
  assert.deepEqual(placePath('~/x/y.json', plain), { anchor: 'other', rel: 'y.json' });
  assert.deepEqual(placePath('/opt/has space/bad name', plain), { anchor: 'other', rel: WITHHELD });
  assert.deepEqual(placePath('/', plain), { anchor: 'other', rel: '' });
  for (const value of [null, undefined, '', 7, {}, ['/x']]) assert.equal(placePath(value, plain), null);
});

test('placeText places anchors, then maskLite masks a planted secret, email, IP and /home/<name> path', () => {
  const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const text = `in ${PROJECT}/x.ts token ${GH} from jane.doe@example.invalid at 10.20.30.40 see /home/bob/notes.md`;
  const out = placeText(text, plain);
  assert.equal(out, `in <project>/x.ts token ${MASKED} from ${EMAIL} at ${IP} see /home/${MASKED}/notes.md`);
  for (const planted of [GH, 'jane.doe@example.invalid', '10.20.30.40', '/home/bob', ...valuesOf(plain)]) {
    assert.ok(!out.includes(planted), planted);
  }
  // Placing first and masking the whole result agrees with maskLite run over the placed text.
  assert.equal(maskLite(out), out);
});

test('boundedText withholds a result over its cap whole: no prefix of a planted value crosses the cut', () => {
  const planted = '/home/bobsecret/notes.md';
  const cap = 64;
  const filler = 'w'.repeat(1) + ' x'.repeat(26); // 53 bytes, so the planted value spans bytes 53 to 77
  const over = `${filler}${planted}`;
  assert.ok(Buffer.byteLength(filler) < cap && Buffer.byteLength(over) > cap, 'control: the planted value crosses the cap');
  const out = boundedText(cap, plain)(over);
  assert.equal(out, TOO_LONG);
  assert.equal(TOO_LONG, '(withheld: too long)');
  for (let i = 2; i <= planted.length; i += 1) assert.ok(!out.includes(planted.slice(0, i)), `prefix ${i}`);
  assert.ok(!out.includes(filler));

  // At or under the cap the placed, masked text is returned whole.
  const fits = `${PROJECT}/a.json for jane.doe@example.invalid`;
  assert.equal(boundedText(cap, plain)(fits), `<project>/a.json for ${EMAIL}`);
  const exact = 'e'.repeat(cap);
  assert.equal(boundedText(cap, plain)(exact), exact);
  assert.equal(boundedText(cap, plain)(`${exact}e`), TOO_LONG);
  // The cap is in bytes, not characters.
  assert.equal(boundedText(cap, plain)('é'.repeat(33)), TOO_LONG);
  assert.equal(boundedText(cap, plain)('é'.repeat(32)), 'é'.repeat(32));
  // The cap applies to the placed result: a long anchor path that places short fits.
  const placedShort = `${PROJECT}/${'d'.repeat(40)}`;
  assert.ok(Buffer.byteLength(placedShort) > cap);
  assert.equal(boundedText(cap, plain)(placedShort), `<project>/${'d'.repeat(40)}`);
});

test('a non-string is refused', () => {
  const check = boundedText(64, plain);
  for (const value of [42, null, undefined, {}, ['text'], true]) {
    assert.throws(() => check(value), (error: unknown) => error instanceof Mismatch, String(value));
  }
  for (const value of [42, null, undefined, {}]) assert.throws(() => placeText(value, plain), TypeError);
});

test('no anchor value is returned in any output', () => {
  const values = valuesOf(plain);
  const outputs: string[] = [];
  for (const value of values) {
    for (const suffix of ['', '/x.json', '/../y', '/has space']) {
      const placed = placePath(`${value}${suffix}`, plain);
      outputs.push(placed.anchor, placed.rel);
      outputs.push(placeText(`see ${value}${suffix} and ${value}`, plain));
      outputs.push(boundedText(4096, plain)(`see ${value}${suffix}`));
    }
  }
  for (const out of outputs) for (const value of values) assert.ok(!out.includes(value), `${value} in ${out}`);
});

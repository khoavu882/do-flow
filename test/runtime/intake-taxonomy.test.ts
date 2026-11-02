'use strict';
// 136 A.1, IC-005: the intake taxonomy loader and its closed-shape validation. Fixtures edit a copy of the
// shipped file, never the file itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTaxonomy, validateTaxonomy, validateCategory, categoryFolder } = require('../../src/runtime/intake/taxonomy.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const shipped = (): any => JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'intake.json'), 'utf8'));
const errorsOf = (registry: any): string[] => validateTaxonomy(registry).errors;
const category = (registry: any, id: string): any => registry.categories.find((c: any) => c.id === id);

test('the shipped registry loads: core categories in file order, each marked core', () => {
  const loaded = loadTaxonomy({ repoRoot: REPO, contributions: false });
  assert.equal(loaded.ok, true, loaded.detail);
  assert.deepEqual(loaded.taxonomy.categories.map((c: any) => c.id), ['raw-prd', 'discuss-session', 'hld', 'references', 'prompt']);
  assert.ok(loaded.taxonomy.categories.every((c: any) => c.origin === 'core'));
  assert.equal(loaded.taxonomy.recentWindowSeconds, 60);
  assert.equal(loaded.taxonomy.pointerMaxBytes, 262144);
  assert.deepEqual(errorsOf(shipped()), []);
});

test('loading twice gives the same categories (NFR-005)', () => {
  assert.deepEqual(loadTaxonomy({ repoRoot: REPO, contributions: false }), loadTaxonomy({ repoRoot: REPO, contributions: false }));
});

test('an unreadable or invalid file is config-invalid, never a throw', (t: any) => {
  const dir = tempDir(t, 'doflow-intake-tax-');
  const missing = loadTaxonomy({ file: path.join(dir, 'absent.json') });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'config-invalid');

  const torn = path.join(dir, 'torn.json');
  fs.writeFileSync(torn, '{ not json');
  assert.equal(loadTaxonomy({ file: torn }).reason, 'config-invalid');

  const bad = shipped();
  bad.version = 2;
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify(bad));
  const loaded = loadTaxonomy({ file: badFile });
  assert.equal(loaded.ok, false);
  assert.match(loaded.detail, /version must be 1/);
});

test('keys are closed at every level', () => {
  const top = shipped();
  top.extra = true;
  assert.ok(errorsOf(top).some((m) => /registry\.extra is not an allowed key/.test(m)));

  const cat = shipped();
  category(cat, 'hld').colour = 'red';
  assert.ok(errorsOf(cat).some((m) => /colour is not an allowed key/.test(m)));

  const rule = shipped();
  category(rule, 'hld').rules[0].priority = 1;
  assert.ok(errorsOf(rule).some((m) => /priority is not an allowed key/.test(m)));
});

test('a missing top-level or category key is named', () => {
  const top = shipped();
  delete top.promptCategory;
  assert.ok(errorsOf(top).some((m) => /registry\.promptCategory is missing/.test(m)));

  const cat = shipped();
  delete category(cat, 'references').summary;
  assert.ok(errorsOf(cat).some((m) => /summary is missing/.test(m)));
});

test('ids and names must be lower-kebab', () => {
  const reg = shipped();
  category(reg, 'hld').id = 'HLD_Notes';
  category(reg, 'references').names = ['docs', 'Vendor Docs'];
  const errors = errorsOf(reg);
  assert.ok(errors.some((m) => /categories\[2\]\.id must be lower-kebab/.test(m)));
  assert.ok(errors.some((m) => /categories\[3\]\.names must be an array of lower-kebab/.test(m)));
});

test('an id or name used twice across categories is refused, naming both owners', () => {
  const dupName = shipped();
  category(dupName, 'references').names.push('design');
  assert.ok(errorsOf(dupName).some((m) => /'design' is used by both 'hld' and 'references'/.test(m)), errorsOf(dupName).join('; '));

  const dupId = shipped();
  category(dupId, 'references').id = 'hld';
  assert.ok(errorsOf(dupId).some((m) => /'hld' is used by both/.test(m)));

  const selfDup = shipped();
  category(selfDup, 'hld').names.push('hld');
  assert.ok(errorsOf(selfDup).some((m) => /'hld' is used by both 'hld' and 'hld'/.test(m)));
});

test('extensions are lower case without a dot; a pattern must compile', () => {
  const reg = shipped();
  category(reg, 'references').rules[0].extensions = ['PDF', '.docx', 'pdf', 'pdf'];
  const errors = errorsOf(reg);
  assert.ok(errors.some((m) => /"PDF" must be a lower-case extension/.test(m)));
  assert.ok(errors.some((m) => /"\.docx" must be a lower-case extension/.test(m)));
  assert.ok(errors.some((m) => /names an extension twice/.test(m)));

  const pattern = shipped();
  category(pattern, 'raw-prd').rules[0].namePattern = '(unclosed';
  assert.ok(errorsOf(pattern).some((m) => /namePattern does not compile/.test(m)));

  const empty = shipped();
  category(empty, 'raw-prd').rules[0].extensions = [];
  assert.ok(errorsOf(empty).some((m) => /extensions must be a non-empty array/.test(m)));

  const text = shipped();
  text.textExtensions = ['MD'];
  assert.ok(errorsOf(text).some((m) => /textExtensions entry "MD"/.test(m)));
});

test('into is a relative sub-path with no traversal, and a companion rule takes none', () => {
  for (const into of ['../up', 'a/../b', '/abs', 'a//b', '.hidden', 'a\\b', '', 7]) {
    const reg = shipped();
    category(reg, 'discuss-session').rules[0].into = into;
    assert.ok(errorsOf(reg).some((m) => /\.into must be a relative sub-path/.test(m)), `into ${JSON.stringify(into)}`);
  }
  const ok = shipped();
  category(ok, 'discuss-session').rules[0].into = 'records/audio';
  assert.deepEqual(errorsOf(ok), []);

  const companion = shipped();
  category(companion, 'hld').rules[1].into = 'diagrams';
  assert.ok(errorsOf(companion).some((m) => /companionOf, so it follows its companion and takes no into/.test(m)));
});

test('the prompt category exists and has no rules', () => {
  const missing = shipped();
  missing.promptCategory = 'nowhere';
  assert.ok(errorsOf(missing).some((m) => /promptCategory 'nowhere' is not a category id/.test(m)));

  const ruled = shipped();
  category(ruled, 'prompt').rules.push({ extensions: ['md'] });
  assert.ok(errorsOf(ruled).some((m) => /prompt category 'prompt' must have no rules/.test(m)));
});

test('numeric limits are validated', () => {
  const reg = shipped();
  reg.recentWindowSeconds = -1;
  reg.pointerMaxBytes = 0;
  const errors = errorsOf(reg);
  assert.ok(errors.some((m) => /recentWindowSeconds must be an integer of 0 or more/.test(m)));
  assert.ok(errors.some((m) => /pointerMaxBytes must be a positive integer/.test(m)));
  const zero = shipped();
  zero.recentWindowSeconds = 0;
  assert.deepEqual(errorsOf(zero), []);
});

test('validateCategory judges one category alone (the contribution point uses it)', () => {
  const one = { id: 'sketches', names: ['drawings'], summary: 'Hand drawings.', rules: [{ extensions: ['jpg'] }] };
  assert.deepEqual(validateCategory(one, 'entry'), []);
  assert.ok(validateCategory({ ...one, id: 'Not Kebab' }, 'entry').length > 0);
  assert.deepEqual(validateCategory('x', 'entry'), ['entry must be an object']);
});

test('categoryFolder reuses the first existing known name, else the id (FR-003)', () => {
  const hld = { id: 'hld', names: ['design', 'architecture'] };
  assert.equal(categoryFolder(hld, new Set()), 'hld');
  assert.equal(categoryFolder(hld, new Set(['architecture'])), 'architecture');
  assert.equal(categoryFolder(hld, new Set(['architecture', 'design'])), 'design');
  assert.equal(categoryFolder(hld, new Set(['architecture', 'hld'])), 'hld');
  assert.equal(categoryFolder(hld, new Set(['unrelated'])), 'hld');
});

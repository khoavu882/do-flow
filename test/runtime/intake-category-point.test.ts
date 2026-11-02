'use strict';
// 136 C.2, IC-006: the `intake-category` contribution point (validator, template, and the contributions
// `loadTaxonomy` joins after the core categories). Packages are stand-in view entries in temporary folders.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { POINT_VALIDATORS } = require('../../src/runtime/packages/points.ts');
const { loadTaxonomy } = require('../../src/runtime/intake/taxonomy.ts');
const { sortFolder } = require('../../src/runtime/intake/engine.ts');
const { MANIFEST_FILE } = require('../../src/runtime/packages/manifest.ts');

const REPO = path.resolve(__dirname, '../..');
const validate = POINT_VALIDATORS['intake-category-v1'];
const sketches = (): any => ({ id: 'sketches', names: ['drawings'], summary: 'Hand drawings and whiteboard photos.', rules: [{ extensions: ['jpg'] }] });

/** A stand-in package view: one active package per entry, each contributing the given categories (id -> body). */
function viewOf(t: any, packages: Array<{ id: string; categories: Record<string, any>; state?: string }>): any {
  const root = tempDir(t, 'doflow-intake-point-');
  return {
    packages: packages.map((pkg) => {
      const storeDir = path.join(root, pkg.id);
      fs.mkdirSync(path.join(storeDir, 'categories'), { recursive: true });
      const contributions = Object.entries(pkg.categories).map(([id, body]) => {
        fs.writeFileSync(path.join(storeDir, 'categories', `${id}.json`), JSON.stringify(body));
        return { point: 'intake-category', version: 1, id, file: `categories/${id}.json` };
      });
      fs.writeFileSync(path.join(storeDir, MANIFEST_FILE), JSON.stringify({ contributions }));
      return { id: pkg.id, state: pkg.state ?? 'active', storeDir, firstParty: false, contentDigest: 'x', source: 'test' };
    }),
  };
}

test('the validator takes IC-005\'s category shape whose id is the contribution id', () => {
  assert.deepEqual(validate('sketches', sketches(), { packageId: 'acme' }), []);
  assert.match(validate('other', sketches(), { packageId: 'acme' }).join('\n'), /package 'acme' intake category 'other'\.id must equal the contribution id 'other'/);
  assert.match(validate('sketches', { ...sketches(), colour: 'red' }).join('\n'), /colour is not an allowed key/);
  assert.match(validate('sketches', { ...sketches(), rules: [{ extensions: ['JPG'] }] }).join('\n'), /lower-case extension/);
  assert.match(validate('sketches', { ...sketches(), rules: [{ extensions: ['jpg'], namePattern: '(' }] }).join('\n'), /does not compile/);
  assert.deepEqual(validate('sketches', 'text'), ["intake category 'sketches' must be an object"]);
});

test('the shipped template renders a category the validator accepts', () => {
  const dir = path.join(REPO, 'core', 'registry', 'package-templates', 'intake-category');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'template.json'), 'utf8'));
  assert.equal(config.path, 'categories/{{local}}.json');
  const body = JSON.parse(fs.readFileSync(path.join(dir, 'files', 'category.json'), 'utf8').replaceAll('{{local}}', 'sketches'));
  assert.deepEqual(validate('sketches', body, { packageId: 'acme' }), []);
});

test('contributed categories follow every core category, in qualified-id order, with their qualified id as folder name', (t: any) => {
  const view = viewOf(t, [
    { id: 'zeta', categories: { notes: { id: 'notes', names: [], summary: 'Notes.', rules: [{ extensions: ['rtf'] }] } } },
    { id: 'acme', categories: { sketches: sketches() } },
  ]);
  const core = loadTaxonomy({ repoRoot: REPO, contributions: false }).taxonomy.categories;
  const problems: string[] = [];
  const loaded = loadTaxonomy({ repoRoot: REPO, view, problems });
  assert.equal(loaded.ok, true);
  assert.deepEqual(problems, []);
  const ids = loaded.taxonomy.categories.map((c: any) => c.id);
  assert.deepEqual(ids, [...core.map((c: any) => c.id), 'acme.sketches', 'zeta.notes']);
  assert.deepEqual(loaded.taxonomy.categories.slice(0, core.length), core, 'the core categories are untouched');
  assert.deepEqual(loaded.taxonomy.categories.slice(-2).map((c: any) => c.origin), ['acme.sketches', 'zeta.notes']);
  assert.deepEqual(loaded.taxonomy.categories[core.length].names, ['drawings']);
});

test('a contribution that collides with a core category or an earlier one, or is invalid, is left out and named', (t: any) => {
  const view = viewOf(t, [
    { id: 'acme', categories: {
      sketches: sketches(),
      clash: { id: 'clash', names: ['design'], summary: 'Takes a core name.', rules: [{ extensions: ['jpg'] }] },
      broken: { id: 'broken', names: [], summary: 'Bad rule.', rules: [{ extensions: [] }] },
    } },
    { id: 'beta', categories: { dupe: { id: 'dupe', names: ['drawings'], summary: 'Takes a name acme.sketches has.', rules: [{ extensions: ['gif'] }] } } },
    { id: 'gone', state: 'disabled', categories: { hidden: { id: 'hidden', names: [], summary: 'Not active.', rules: [{ extensions: ['bmp'] }] } } },
  ]);
  const problems: string[] = [];
  const loaded = loadTaxonomy({ repoRoot: REPO, view, problems });
  assert.deepEqual(loaded.taxonomy.categories.slice(-1).map((c: any) => c.id), ['acme.sketches']);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.ok(problems.some((m) => /acme\.clash.*left out: 'design' is already/.test(m)), problems.join('\n'));
  assert.ok(problems.some((m) => /acme\.broken.*left out/.test(m) && /extensions must be a non-empty array/.test(m)), problems.join('\n'));
  assert.ok(problems.some((m) => /beta\.dupe.*left out: 'drawings' is already/.test(m)), problems.join('\n'));
});

test('a file no core rule claims is filed into a contributed category; one a core rule claims stays with the core', (t: any) => {
  const view = viewOf(t, [{ id: 'acme', categories: { sketches: { id: 'sketches', names: [], summary: 'Pictures.', rules: [{ extensions: ['jpg', 'pdf'] }] } } }]);
  const { taxonomy } = loadTaxonomy({ repoRoot: REPO, view });
  const dir = tempDir(t, 'doflow-intake-point-');
  const ctx = path.join(dir, 'feature', 'additional-context');
  fs.mkdirSync(ctx, { recursive: true });
  const old = new Date(Date.now() - 86_400_000);
  for (const name of ['photo.jpg', 'spec.pdf']) {
    fs.writeFileSync(path.join(ctx, name), name);
    fs.utimesSync(path.join(ctx, name), old, old);
  }
  const result = sortFolder({ contextDir: ctx, taxonomy, now: new Date() });
  assert.deepEqual(result.moves.map((m: any) => [m.from, m.to, m.category]), [
    ['photo.jpg', 'acme.sketches/photo.jpg', 'acme.sketches'],
    ['spec.pdf', 'references/spec.pdf', 'references'],
  ]);
});

test('no package view, and a package view with no active package, give the core list alone', (t: any) => {
  const core = loadTaxonomy({ repoRoot: REPO, contributions: false });
  assert.deepEqual(loadTaxonomy({ repoRoot: REPO, view: { packages: [] } }), core);
  assert.deepEqual(loadTaxonomy({ repoRoot: REPO, view: viewOf(t, [{ id: 'quiet', categories: {} }]) }), core);
});

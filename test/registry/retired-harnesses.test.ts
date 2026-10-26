'use strict';
// Row 127 IC-001: the `retired[]` list in core/registry/harnesses.json, its validator, and the
// retiredFor/isRetired lookups. Fixtures retire a made-up 'oldtool' (replacement 'antigravity');
// the shipped registry retires 'gemini' (replacement 'antigravity').
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry, validateRegistry, retiredFor, isRetired, harnessFor } = require('../../src/registry/index.ts');
const { resolveTargets, VALID } = require('../../src/install/targets.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const REGISTRY_DIR = path.join(REPO, 'core', 'registry');

function oldtool(overrides: any = {}): any {
  return {
    id: 'oldtool',
    displayName: 'Old Tool',
    replacement: 'antigravity',
    retiredOn: '2026-10-26',
    reason: 'Replaced upstream by Antigravity CLI.',
    evidence: ['fixture (row 127)'],
    removal: {
      hookCommands: { renderer: 'oldtool-hooks', key: 'hooks', commands: ['bash "$OLDTOOL_DIR/hooks/session-start.sh"'] },
      markerSectionRenderers: ['oldtool-instructions'],
      handover: [{ renderer: 'oldtool-instructions', scope: 'global', to: 'antigravity', surface: 'instruction' }],
    },
    ...overrides,
  };
}

/** A copy of the shipped registry directory whose harnesses.json is rewritten by `edit`. */
function registryCopy(t: any, edit: (raw: any) => void): string {
  const dir = tempDir(t, 'doflow-retired-registry-');
  fs.cpSync(REGISTRY_DIR, dir, { recursive: true });
  const file = path.join(dir, 'harnesses.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(raw);
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  return dir;
}

function withRetired(retired: any): any {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  delete registry.validation;
  registry.retired = retired;
  return registry;
}

function errorsFor(retired: any): string {
  const result = validateRegistry(withRetired(retired), { repoRoot: REPO });
  assert.equal(result.ok, false, 'the injected retired list must be rejected');
  return result.errors.join('\n');
}

test('a registry with a valid retired[] loads and retiredFor/isRetired answer from it', (t: any) => {
  const dir = registryCopy(t, (raw) => { raw.retired = [oldtool()]; });
  const registry = loadRegistry({ repoRoot: REPO, dir });
  assert.equal(registry.validation.ok, true);
  assert.deepEqual(retiredFor(registry, 'oldtool'), oldtool());
  assert.equal(isRetired(registry, 'oldtool'), true);
  assert.equal(retiredFor(registry, 'antigravity'), null);
  assert.equal(isRetired(registry, 'antigravity'), false);
  assert.equal(isRetired(registry, 'nope'), false);
});

/** The 7 hook commands of core/harnesses/gemini/hooks/hooks.json @ c35f681b, in file order. */
const GEMINI_HOOK_COMMANDS = ['session-start', 'session-end', 'pre-bash-guard', 'mcp-tool-guard', 'pre-implement-gate', 'post-edit-lint', 'pre-compact']
  .map((name) => `bash "$GEMINI_PROJECT_DIR/.gemini/hooks/${name}.sh"`);

test('the shipped registry retires gemini for antigravity, with its handover entry, and keeps 7 live harnesses', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.equal(registry.retired.length, 1);
  const [gemini] = registry.retired;
  assert.equal(gemini.id, 'gemini');
  assert.equal(gemini.displayName, 'Gemini CLI');
  assert.equal(gemini.replacement, 'antigravity');
  assert.equal(gemini.retiredOn, '2026-10-26');
  assert.deepEqual(gemini.removal.hookCommands, { renderer: 'gemini-hooks', key: 'hooks', commands: GEMINI_HOOK_COMMANDS });
  assert.deepEqual(gemini.removal.markerSectionRenderers, ['gemini-instructions']);
  assert.deepEqual(gemini.removal.handover, [{ renderer: 'gemini-instructions', scope: 'global', to: 'antigravity', surface: 'instruction' }]);
  assert.deepEqual(registry.harnesses.map((h: any) => h.id), ['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']);
  assert.equal(isRetired(registry, 'gemini'), true);
  assert.throws(() => harnessFor(registry, 'gemini'), /Unknown registry harness 'gemini'/);
});

test('resolveTargets maps agy to antigravity and refuses gemini with the IC-002 message', () => {
  assert.deepEqual(resolveTargets(['agy']), ['antigravity']);
  assert.equal(VALID.includes('gemini'), false);
  assert.throws(() => resolveTargets(['gemini']), (error: any) => {
    assert.equal(Object.getPrototypeOf(error), Error.prototype);
    assert.equal(error.message, "Target 'gemini' was retired on 2026-10-26; use 'antigravity' (alias agy). Its DoFlow files are released by the next 'doflow install' or 'doflow update' in that scope.");
    return true;
  });
});

test('a registry without the retired key loads unchanged', (t: any) => {
  const withKey = loadRegistry({ repoRoot: REPO });
  const withoutKey = loadRegistry({ repoRoot: REPO, dir: registryCopy(t, (raw) => { delete raw.retired; }) });
  assert.equal(withoutKey.validation.ok, true);
  assert.deepEqual(withoutKey.retired, []);
  assert.deepEqual(withoutKey.harnesses, withKey.harnesses);
  assert.equal(isRetired(withoutKey, 'oldtool'), false);
  // A hand-built registry object with no retired field at all is also valid and answers "not retired".
  const bare = structuredClone(withKey);
  delete bare.validation; delete bare.retired;
  assert.equal(validateRegistry(bare, { repoRoot: REPO }).ok, true);
  assert.equal(retiredFor(bare, 'oldtool'), null);
});

test('harnessFor still throws on a retired id', (t: any) => {
  const registry = loadRegistry({ repoRoot: REPO, dir: registryCopy(t, (raw) => { raw.retired = [oldtool()]; }) });
  assert.throws(() => harnessFor(registry, 'oldtool'), /Unknown registry harness 'oldtool'/);
});

test('a retired id equal to a live id is rejected with an error naming both', () => {
  assert.match(errorsFor([oldtool({ id: 'claude' })]), /retired harness 'claude'.*live harness 'claude'/);
});

test('a replacement that is not a live harness is rejected', () => {
  assert.match(errorsFor([oldtool({ replacement: 'ghost' })]), /retired harness 'oldtool'.*replacement 'ghost' is not a live harness/);
  // Another retired id is not live either.
  assert.match(errorsFor([oldtool(), oldtool({ id: 'oldertool', replacement: 'oldtool' })]), /retired harness 'oldertool'.*replacement 'oldtool' is not a live harness/);
});

test('empty or non-string removal.hookCommands.commands are rejected', () => {
  const empty = oldtool(); empty.removal.hookCommands.commands = [];
  assert.match(errorsFor([empty]), /retired harness 'oldtool'.*removal\.hookCommands\.commands must be a non-empty array of non-empty strings/);
  const blank = oldtool(); blank.removal.hookCommands.commands = ['bash x.sh', ' '];
  assert.match(errorsFor([blank]), /removal\.hookCommands\.commands must be a non-empty array of non-empty strings/);
});

test('a removal.handover[].to that is not a live harness is rejected', () => {
  const entry = oldtool(); entry.removal.handover[0].to = 'ghost';
  assert.match(errorsFor([entry]), /retired harness 'oldtool'.*removal\.handover\[0\]\.to 'ghost' is not a live harness/);
});

test('every retired field is required and typed', () => {
  const cases: Array<[string, (entry: any) => void, RegExp]> = [
    ['id pattern', (e) => { e.id = 'Old_Tool'; }, /id must match/],
    ['displayName', (e) => { delete e.displayName; }, /displayName must be a non-empty string/],
    ['replacement', (e) => { e.replacement = 7; }, /replacement must be a non-empty string/],
    ['retiredOn format', (e) => { e.retiredOn = '26/10/2026'; }, /retiredOn must be a YYYY-MM-DD date/],
    ['retiredOn calendar', (e) => { e.retiredOn = '2026-02-30'; }, /retiredOn must be a YYYY-MM-DD date/],
    ['reason', (e) => { e.reason = ''; }, /reason must be a non-empty string/],
    ['evidence', (e) => { e.evidence = 'x'; }, /evidence must be a non-empty array of non-empty strings/],
    ['removal', (e) => { delete e.removal; }, /removal must be an object/],
    ['hookCommands', (e) => { e.removal.hookCommands = []; }, /removal\.hookCommands must be an object/],
    ['hookCommands.renderer', (e) => { delete e.removal.hookCommands.renderer; }, /removal\.hookCommands\.renderer must be a non-empty string/],
    ['hookCommands.key', (e) => { e.removal.hookCommands.key = ''; }, /removal\.hookCommands\.key must be a non-empty string/],
    ['markerSectionRenderers', (e) => { e.removal.markerSectionRenderers = [1]; }, /removal\.markerSectionRenderers must be an array of non-empty strings/],
    ['handover', (e) => { delete e.removal.handover; }, /removal\.handover must be an array/],
    ['handover entry', (e) => { e.removal.handover = ['x']; }, /removal\.handover\[0\] must be an object/],
    ['handover.renderer', (e) => { e.removal.handover[0].renderer = ''; }, /removal\.handover\[0\]\.renderer must be a non-empty string/],
    ['handover.scope', (e) => { e.removal.handover[0].scope = 'user'; }, /removal\.handover\[0\]\.scope must be global or project/],
    ['handover.surface', (e) => { delete e.removal.handover[0].surface; }, /removal\.handover\[0\]\.surface must be a non-empty string/],
  ];
  for (const [label, mutate, expected] of cases) {
    const entry = oldtool(); mutate(entry);
    assert.match(errorsFor([entry]), expected, label);
  }
  assert.match(errorsFor({}), /^retired: must be an array when present/m);
  assert.match(errorsFor(['oldtool']), /retired\[0\]: must be an object/);
});

test('retired ids are unique', () => {
  assert.match(errorsFor([oldtool(), oldtool()]), /retired: duplicate id 'oldtool'/);
});

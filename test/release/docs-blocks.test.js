'use strict';
// docs-blocks.test.js — the generated documentation blocks and llms.txt (087b IC-001, IC-002,
// IC-003, IC-009). Every test runs on a temp root holding a copy of the registries, the two help
// sources and synthetic docs pages, so a fault is seeded in the copy and never in the repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { BLOCKS, LLMS_CAP, renderBlock, renderLlms, readNav, captureHelp, pageDescription, checkAll, writeAll } = require('../../src/release/docs-blocks.ts');
const { renderEnforcementMatrix, renderBehaviourMatrix } = require('../../src/lifecycle/coverage.ts');
const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { checkSettingsDocs } = require('../helper/settings-doc-guard');

const REPO = path.resolve(__dirname, '../..');

const NAV = [
  ['Home', [['Home', 'index.md']]],
  ['Get started', [['Quickstart', 'quickstart.md'], ['Setup', 'setup.md']]],
  ['Use DoFlow', [['Guide', 'guide.md'], ['How DoFlow works', 'how-doflow-work.md'], ['Harnesses', 'capability-map.md']]],
  ['Reference', [['Commands and skills', 'reference.md'], ['Settings', 'settings.md']]],
  ['Contributing', [['Architecture', 'architecture.md'], ['Specs', [['Operating modes', 'specs/operating-modes.md']]]]],
];

function navYaml() {
  const lines = ['site_url: https://example.test/site', 'nav:'];
  for (const [section, items] of NAV) {
    if (items.length === 1 && section === 'Home') { lines.push(`  - Home: ${items[0][1]}`); continue; }
    lines.push(`  - ${section}:`);
    for (const [title, target] of items) {
      if (Array.isArray(target)) {
        lines.push(`      - ${title}:`);
        for (const [leaf, file] of target) lines.push(`          - ${leaf}: ${file}`);
      } else lines.push(`      - ${title}: ${target}`);
    }
  }
  lines.push('', 'not_in_nav: |', '  /overview.md', '');
  return lines.join('\n');
}

function navPages() {
  const pages = [];
  for (const [, items] of NAV) for (const [, target] of items) {
    if (Array.isArray(target)) for (const [, file] of target) pages.push(file);
    else pages.push(target);
  }
  return pages;
}

function markers(id) {
  return `<!-- BEGIN GENERATED:${id} -->\n<!-- END GENERATED:${id} -->`;
}

/** A repo-shaped temp root: real registries and help sources, synthetic docs and mkdocs.yml. */
function fixture(t) {
  const root = tempDir(t, 'doflow-docs-blocks-');
  for (const dir of ['core/registry', 'core/shared/scripts', 'bin', 'src']) {
    fs.cpSync(path.join(REPO, dir), path.join(root, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  fs.writeFileSync(path.join(root, 'mkdocs.yml'), navYaml());
  const blocksByPage = new Map();
  for (const block of BLOCKS) blocksByPage.set(block.page, [...(blocksByPage.get(block.page) || []), block.id]);
  for (const page of navPages()) {
    const file = path.join(root, 'docs', page);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ids = blocksByPage.get(page) || [];
    const heading = page === 'settings.md' ? '## Settings keys\n\n' : '';
    fs.writeFileSync(file, `---\ndescription: About ${page}.\n---\n# ${page}\n\nIntro.\n\n${heading}${ids.map(markers).join('\n\nBetween blocks.\n\n')}\n\nOutro.\n`);
  }
  return root;
}

function cli(root, args, env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'src/release/docs-blocks.ts'), ...args], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8',
  });
}

function editFile(file, edit) {
  fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
}

test('IC-001: --write on a fresh root leaves --check clean, and text outside spans is untouched', (t) => {
  const root = fixture(t);
  assert.deepEqual(writeAll(root), []);
  assert.deepEqual(checkAll(root), []);
  const map = fs.readFileSync(path.join(root, 'docs/capability-map.md'), 'utf8');
  assert.ok(map.startsWith('---\ndescription: About capability-map.md.\n---\n# capability-map.md\n\nIntro.\n\n'));
  assert.ok(map.includes('\n<!-- END GENERATED:capability-matrix -->\n\nBetween blocks.\n\n<!-- BEGIN GENERATED:enforcement-matrix -->\n'));
  assert.ok(map.endsWith('<!-- END GENERATED:context-behaviour-matrix -->\n\nOutro.\n'));
  assert.equal(cli(root, ['--check']).status, 0);
});

test('IC-002: a changed settings description makes settings.md settings-keys stale, and nothing else', (t) => {
  const root = fixture(t);
  writeAll(root);
  editFile(path.join(root, 'core/registry/settings.json'), (text) => {
    const raw = JSON.parse(text);
    raw.keys['storage.prune'].description = 'A changed description.';
    return JSON.stringify(raw, null, 2);
  });
  assert.deepEqual(checkAll(root), [{ page: 'settings.md', id: 'settings-keys', kind: 'stale' }]);
  const run = cli(root, ['--check']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^docs-blocks: settings\.md: settings-keys: stale$/m);
});

test('IC-002: a stale block after another block on the same page is found (multi-block page)', (t) => {
  const root = fixture(t);
  writeAll(root);
  editFile(path.join(root, 'docs/capability-map.md'), (text) => text.replace(
    /(<!-- BEGIN GENERATED:context-behaviour-matrix -->\n)[\s\S]*?(<!-- END GENERATED:context-behaviour-matrix -->)/,
    '$1| hand | edit |\n$2',
  ));
  assert.deepEqual(checkAll(root), [{ page: 'capability-map.md', id: 'context-behaviour-matrix', kind: 'stale' }]);
});

test('IC-002: an unpaired start, an unknown id and a doubled block are orphan; an absent block is missing', (t) => {
  const root = fixture(t);
  writeAll(root);
  const settings = path.join(root, 'docs/settings.md');
  const written = fs.readFileSync(settings, 'utf8');

  fs.writeFileSync(settings, written.replace(/<!-- END GENERATED:settings-keys -->\n/, ''));
  assert.deepEqual(checkAll(root), [{ page: 'settings.md', id: 'settings-keys', kind: 'orphan' }]);

  fs.writeFileSync(settings, `${written}\n<!-- BEGIN GENERATED:no-such-block -->\n<!-- END GENERATED:no-such-block -->\n`);
  assert.deepEqual(checkAll(root), [{ page: 'settings.md', id: 'no-such-block', kind: 'orphan' }]);

  fs.writeFileSync(settings, `${written}\n${markers('settings-keys')}\n`);
  assert.deepEqual(checkAll(root), [{ page: 'settings.md', id: 'settings-keys', kind: 'orphan' }]);

  fs.writeFileSync(settings, '---\ndescription: About settings.md.\n---\n# Settings\n');
  assert.deepEqual(checkAll(root), [{ page: 'settings.md', id: 'settings-keys', kind: 'missing' }]);

  fs.rmSync(settings);
  assert.ok(checkAll(root).some((f) => f.page === 'settings.md' && f.id === 'settings-keys' && f.kind === 'missing'));
});

test('IC-001: an unreadable registry or help source is source-unreadable, never an empty table', (t) => {
  const root = fixture(t);
  writeAll(root);
  fs.writeFileSync(path.join(root, 'core/registry/workflows.json'), '{');
  assert.deepEqual(checkAll(root), [{ page: 'how-doflow-work.md', id: 'task-classes', kind: 'source-unreadable' }]);

  const other = fixture(t);
  writeAll(other);
  fs.writeFileSync(path.join(other, 'core/shared/scripts/doflow/bin/doflow-run'), '#!/usr/bin/env bash\necho "nothing here"\n');
  assert.throws(() => captureHelp(other), /yielded no verb/);
  assert.deepEqual(checkAll(other), [{ page: 'reference.md', id: 'command-index', kind: 'source-unreadable' }]);
});

test('IC-009: llms.txt lists nav pages by section with their descriptions, and over the cap is a finding', (t) => {
  const root = fixture(t);
  writeAll(root);
  const llms = fs.readFileSync(path.join(root, 'docs/llms.txt'), 'utf8');
  const lines = llms.split('\n');
  assert.equal(lines[0], '# DoFlow');
  assert.match(lines[2], /^> DoFlow is a registry-driven installer/);
  assert.deepEqual(lines.filter((line) => line.startsWith('## ')), NAV.map(([section]) => `## ${section}`));
  assert.ok(lines.includes('- [Home](https://example.test/site/): About index.md.'));
  assert.ok(lines.includes('- [Operating modes](https://example.test/site/specs/operating-modes/): About specs/operating-modes.md.'));
  assert.ok(!llms.includes('overview'), 'a not_in_nav page is never listed');
  assert.ok(llms.endsWith('.\n') && !llms.endsWith('\n\n'));
  assert.deepEqual(readNav(root).map((page) => page.path), navPages());
  assert.equal(readNav(root).find((page) => page.path === 'specs/operating-modes.md').section, 'Contributing');

  fs.writeFileSync(path.join(root, 'docs/llms.txt'), `${llms}${'x'.repeat(LLMS_CAP)}\n`);
  const findings = checkAll(root);
  assert.ok(findings.some((f) => f.id === 'llms.txt' && f.kind === 'over-cap'), JSON.stringify(findings));

  editFile(path.join(root, 'docs/guide.md'), (text) => text.replace(/^---\ndescription: .*\n---\n/, ''));
  assert.ok(checkAll(root).some((f) => f.id === 'llms.txt' && f.kind === 'source-unreadable'));
});

test('IC-004: the front-matter description is read only from a block that opens the page', () => {
  assert.equal(pageDescription('---\ndescription: One line.\n---\n# T\n'), 'One line.');
  assert.equal(pageDescription("---\ndescription: 'Quoted: value'\n---\n# T\n"), 'Quoted: value');
  assert.equal(pageDescription('# T\n\n---\ndescription: Not front matter.\n---\n'), null);
  assert.equal(pageDescription('---\ntitle: x\n---\n'), null);
});

test('NFR-007: two --write runs under different TZ, LANG and COLUMNS give byte-identical output', (t) => {
  const a = fixture(t);
  const b = fixture(t);
  assert.equal(cli(a, ['--write'], { TZ: 'Pacific/Honolulu', LANG: 'fr_FR.UTF-8', COLUMNS: '20', FORCE_COLOR: '1' }).status, 0);
  assert.equal(cli(b, ['--write'], { TZ: 'Asia/Tokyo', LANG: 'ja_JP.UTF-8', COLUMNS: '300' }).status, 0);
  for (const page of ['capability-map.md', 'how-doflow-work.md', 'settings.md', 'reference.md', 'llms.txt']) {
    assert.equal(fs.readFileSync(path.join(a, 'docs', page), 'utf8'), fs.readFileSync(path.join(b, 'docs', page), 'utf8'), page);
  }
});

test('NFR-007: help capture runs in a pinned environment, whatever the parent sets', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'core/shared/scripts/doflow/bin/doflow-run'), [
    '#!/usr/bin/env bash',
    'echo "Probe group:"',
    'echo "  probe            cols=${COLUMNS:-unset} lang=${LANG:-unset} tz=${TZ:-unset} color=${FORCE_COLOR:-unset} leak=${DOCS_BLOCKS_LEAK:-unset}"',
    '',
  ].join('\n'));
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, { COLUMNS: '17', LANG: 'de_DE.UTF-8', TZ: 'Europe/Berlin', FORCE_COLOR: '3', DOCS_BLOCKS_LEAK: 'yes' });
  assert.deepEqual(captureHelp(root).doflowRun, [{ verb: 'probe', group: 'Probe group', summary: 'cols=200 lang=C tz=UTC color=unset leak=unset' }]);
});

test('IC-003: help capture finds the doflow commands and doflow-run verbs with their groups', () => {
  const help = captureHelp(REPO);
  const doflow = help.doflow.map((row) => row.verb);
  const run = help.doflowRun.map((row) => row.verb);
  for (const verb of ['install', 'doctor', 'orchestrate', 'review']) assert.ok(doflow.includes(verb), verb);
  for (const verb of ['paths', 'orchestrate', 'task-attempt', 'slot']) assert.ok(run.includes(verb), verb);
  assert.equal(new Set(doflow).size, doflow.length, 'no doflow command is read twice (continuation lines are skipped)');
  assert.equal(new Set(run).size, run.length, 'no doflow-run verb is read twice');
  assert.equal(help.doflowRun.find((row) => row.verb === 'paths').group, 'Artifact and repository state');
  assert.ok(help.doflow.every((row) => row.summary && !row.summary.startsWith(' ')));
});

test('IC-003: no command-index row starts like a full reference row (`| \`doflow <verb>`)', (t) => {
  const root = fixture(t);
  const index = renderBlock('command-index', root);
  assert.ok(index.includes('| `install` |') && index.includes('| `paths` | Artifact and repository state |'));
  assert.ok(!index.split('\n').some((line) => /^\| `doflow(-run)? /.test(line)), 'a row starting "| `doflow <verb>" would shadow the reference row');
});

test('IC-003: the coverage blocks are the coverage renderers unchanged', (t) => {
  const root = fixture(t);
  const coverage = JSON.parse(fs.readFileSync(path.join(root, 'core/registry/lifecycle.json'), 'utf8')).coverage;
  assert.equal(renderBlock('enforcement-matrix', root), renderEnforcementMatrix(coverage));
  assert.equal(renderBlock('context-behaviour-matrix', root), renderBehaviourMatrix(coverage));
});

test('IC-003: the settings-keys block passes the G44 S2 column check and carries each description', (t) => {
  const root = fixture(t);
  const block = renderBlock('settings-keys', root);
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/settings.json'), 'utf8'));
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true });
  assert.equal(loaded.ok, true);
  assert.deepEqual(checkSettingsDocs(raw, `## Settings keys\n\n${block}\n`, loaded.registry), []);
  for (const spec of Object.values(raw.keys)) assert.ok(block.includes(spec.description.replace(/\|/g, '\\|')));
});

test('IC-001: any argv other than exactly --write or --check exits 2 with the usage line', (t) => {
  const root = fixture(t);
  for (const args of [[], ['--wat'], ['--write', '--check'], ['check']]) {
    const run = cli(root, args);
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /^usage: node src\/release\/docs-blocks\.ts --write\|--check$/m);
  }
});

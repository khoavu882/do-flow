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
const { BLOCKS, LLMS_CAP, markerFindings, text, code, inert, renderBlock, renderLlms, readNav, captureHelp, pageDescription, checkAll, writeAll } = require('../../src/release/docs-blocks.ts');
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
  assert.deepEqual(checkAll(root).map(({ page, id, kind }) => ({ page, id, kind })), [{ page: 'how-doflow-work.md', id: 'task-classes', kind: 'source-unreadable' }]);

  const other = fixture(t);
  writeAll(other);
  fs.writeFileSync(path.join(other, 'core/shared/scripts/doflow/bin/doflow-run'), '#!/usr/bin/env bash\necho "nothing here"\n');
  assert.throws(() => captureHelp(other), /yielded no verb/);
  const findings = checkAll(other);
  assert.deepEqual(findings.map(({ page, id, kind }) => ({ page, id, kind })), [{ page: 'reference.md', id: 'command-index', kind: 'source-unreadable' }]);
  assert.match(findings[0].detail, /cannot read the line|yielded no verb/, 'the finding says why');
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

test('IC-003: the coverage blocks are the coverage renderers unchanged, fed the inert copy of the registry', (t) => {
  const root = fixture(t);
  const coverage = JSON.parse(fs.readFileSync(path.join(root, 'core/registry/lifecycle.json'), 'utf8')).coverage;
  assert.equal(renderBlock('enforcement-matrix', root), renderEnforcementMatrix(inert(coverage)));
  assert.equal(renderBlock('context-behaviour-matrix', root), renderBehaviourMatrix(inert(coverage)));
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

// ── Review round (C-2, C-6, C-7, C-8, C-9) ───────────────────────────────────────────────────────

function editJson(file, edit) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(raw);
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

function writeHelp(root, doflowText, runText) {
  if (doflowText !== null) fs.writeFileSync(path.join(root, 'bin/doflow.js'), `process.stdout.write(${JSON.stringify(doflowText)});\n`);
  if (runText !== null) fs.writeFileSync(path.join(root, 'core/shared/scripts/doflow/bin/doflow-run'), `#!/usr/bin/env bash\ncat <<'HELP_EOF'\n${runText}HELP_EOF\n`);
}

test('C-2: text() keeps operands and placeholders visible: <, >, & become entities; pipes, backticks and newlines are inert', () => {
  assert.equal(text('plan-check <plan path> [--json]'), 'plan-check &lt;plan path&gt; \\[--json\\]');
  assert.equal(text('[--row <id>] [--run <id>]'), '\\[--row &lt;id&gt;\\] \\[--run &lt;id&gt;\\]');
  assert.equal(text('a & b'), 'a &amp; b');
  assert.equal(text('a | b\nc `d`'), 'a \\| b c \\`d\\`');
  assert.equal(text(''), '—');
  assert.equal(code('settings.json'), '`settings.json`');
  assert.equal(code('a|b'), 'a\\|b', 'a pipe never sits inside a code span');
  assert.equal(code('a`b'), 'a\\`b');
  assert.equal(code(null), '—');
});

test('C-2: the command index shows the plan-check operand and the roadmap flag values as text, not as HTML tags', (t) => {
  const index = renderBlock('command-index', fixture(t));
  const planCheck = index.split('\n').find((line) => line.startsWith('| `plan-check` |'));
  assert.ok(planCheck, 'plan-check row');
  assert.match(planCheck, /plan-check &lt;plan path&gt; \\\[--json\\\]/);
  assert.ok(!/<[a-z][^>]*>/i.test(index), 'no raw tag-shaped text in the generated index');
});

test('C-6: a registry value with pipes, a newline, HTML and backticks leaves the table intact and inert (headers too)', (t) => {
  const root = fixture(t);
  writeAll(root);
  editJson(path.join(root, 'core/registry/harnesses.json'), (raw) => {
    raw.harnesses[6].displayName = 'A | B\n<script>alert(2)</script>';
    raw.harnesses[0].nativeTargets.instructions = 'CLA|UDE`.md';
  });
  editJson(path.join(root, 'core/registry/settings.json'), (raw) => {
    raw.keys['storage.prune'].description = 'x <img src=x onerror=alert(1)> | y `z`';
  });
  for (const id of ['capability-matrix', 'settings-keys']) {
    const block = renderBlock(id, root);
    const lines = block.split('\n');
    const columns = (line) => line.split(/(?<!\\)\|/).length;
    assert.ok(lines.every((line) => columns(line) === columns(lines[0])), `${id}: every row has the header's column count`);
    assert.ok(!/<(script|img)/i.test(block), `${id}: no raw HTML`);
  }
  assert.match(renderBlock('capability-matrix', root), /A \\\| B &lt;script&gt;alert\\\(2\\\)&lt;\/script&gt;/);
  assert.match(renderBlock('settings-keys', root), /x &lt;img src=x onerror=alert\\\(1\\\)&gt; \\\| y \\`z\\`/);
});

test('C-6: coverage rows render from inert data, so a pipe or tag in lifecycle.json cannot split or inject a row', (t) => {
  const root = fixture(t);
  editJson(path.join(root, 'core/registry/lifecycle.json'), (raw) => {
    raw.coverage.rows[0].doesNotCover = ['a | b <script>'];
  });
  const block = renderBlock('enforcement-matrix', root);
  assert.ok(!block.includes('<script>'));
  assert.ok(block.includes('a \\| b &lt;script&gt;'));
});

test('C-7: an END marker inside a registry value is inert, and --write still converges with a clean check', (t) => {
  const root = fixture(t);
  writeAll(root);
  const file = path.join(root, 'core/registry/settings.json');
  const original = fs.readFileSync(file, 'utf8');
  editJson(file, (raw) => { raw.keys['storage.prune'].description = 'x <!-- END GENERATED:settings-keys --> y'; });
  assert.equal(cli(root, ['--write']).status, 0, 'write converges');
  assert.deepEqual(checkAll(root), []);
  fs.writeFileSync(file, original);
  assert.equal(cli(root, ['--write']).status, 0, 'restoring the registry and writing again converges too');
  assert.deepEqual(checkAll(root), []);
  assert.ok(!fs.readFileSync(path.join(root, 'docs/settings.md'), 'utf8').includes('x <!--'));
});

test('C-7: markers are whole lines; a lone END, a nested span and a pair on the wrong page are orphans', () => {
  const pair = (id) => `<!-- BEGIN GENERATED:${id} -->\nx\n<!-- END GENERATED:${id} -->\n`;
  assert.deepEqual(markerFindings('settings.md', pair('settings-keys')), []);
  assert.deepEqual(markerFindings('settings.md', 'text <!-- END GENERATED:settings-keys --> text\n'), [], 'not a whole line: not a marker');
  assert.deepEqual(markerFindings('guide.md', '<!-- END GENERATED:task-classes -->\n'), [{ page: 'guide.md', id: 'task-classes', kind: 'orphan' }]);
  assert.deepEqual(markerFindings('guide.md', pair('settings-keys')), [{ page: 'guide.md', id: 'settings-keys', kind: 'orphan' }]);
  const nested = `<!-- BEGIN GENERATED:capability-matrix -->\n${pair('enforcement-matrix')}<!-- END GENERATED:capability-matrix -->\n`;
  assert.equal(markerFindings('capability-map.md', nested).length, 2);
  assert.deepEqual(markerFindings('capability-map.md', '<!-- END GENERATED:capability-matrix -->\n<!-- BEGIN GENERATED:capability-matrix -->\n').length, 1, 'END before BEGIN');
});

test('C-8: a help line the parser cannot read fails capture with the line; a failed help run names its exit and stderr', (t) => {
  const run = 'Group A:\n  paths            resolve paths\n';
  const doflowOk = 'Commands:\n  install [path]       Install configs\n  status               Show status\n                       continued summary line\n\nOptions:\n  --json  x\n';
  const root = fixture(t);
  writeHelp(root, doflowOk, run);
  assert.deepEqual(captureHelp(root).doflow.map((row) => row.verb), ['install', 'status'], 'baseline: continuation lines are skipped');
  const bad = {
    emptyDesc: 'Commands:\n  install [path]       Install configs\n  newverb\n',
    wrappedVerb: 'Commands:\n  a-very-long-verb-name-that-fills-the-column\n                       its summary\n',
    singleSpace: 'Commands:\n  install [path] Install configs\n',
    tabs: 'Commands:\n\tinstall\t\tInstall configs\n',
    subheader: 'Commands:\n Advanced:\n  install [path]       Install configs\n',
  };
  for (const [name, helpText] of Object.entries(bad)) {
    writeHelp(root, helpText, run);
    assert.throws(() => captureHelp(root), /cannot read the line/, name);
  }
  writeHelp(root, doflowOk, 'Group A:\n  paths            resolve\n\nExamples:\n  doflow-run paths --json   # print paths\n');
  assert.throws(() => captureHelp(root), /cannot read the line/, 'an example line is not a verb');
  fs.writeFileSync(path.join(root, 'bin/doflow.js'), 'process.stderr.write("boom\\n"); process.exit(3);\n');
  assert.throws(() => captureHelp(root), /bin\/doflow\.js --help failed \(exit 3\): boom/);
});

test('C-9: the llms.txt summary takes the harness names and the Node range from their sources, and says how the npm package is built', (t) => {
  const root = fixture(t);
  writeAll(root);
  const summary = fs.readFileSync(path.join(root, 'docs/llms.txt'), 'utf8').split('\n')[2];
  assert.match(summary, /eight AI coding tools: Claude Code, Codex, .*, and Antigravity CLI\./);
  assert.match(summary, /Node\.js \^22\.18\.0 \|\| >=24\.3\.0/);
  assert.match(summary, /npm run build:package/);
  assert.doesNotMatch(summary, /no build step/);
  editJson(path.join(root, 'core/registry/harnesses.json'), (raw) => { raw.harnesses[6].displayName = 'Kiro IDE'; });
  assert.ok(checkAll(root).some((f) => f.page === 'llms.txt' && f.kind === 'stale'), 'a renamed harness makes llms.txt stale');
  writeAll(root);
  editJson(path.join(root, 'package.json'), (raw) => { raw.engines.node = '>=26'; });
  assert.deepEqual(checkAll(root), [{ page: 'llms.txt', id: 'llms.txt', kind: 'stale' }], 'a new Node range makes llms.txt stale');
});

// ── Final round (R-2, N-1, N-2, N-3) ─────────────────────────────────────────────────────────────

test('R-2: Markdown link, image and emphasis syntax from a registry value is escaped, so no live link, image or emphasis can render', (t) => {
  assert.equal(text('[click](javascript:alert(1))'), '\\[click\\]\\(javascript:alert\\(1\\)\\)');
  assert.equal(text('![img](http://evil.example/t.png)'), '\\!\\[img\\]\\(http://evil.example/t.png\\)');
  assert.equal(text('*em* **b** _u_'), '\\*em\\* \\*\\*b\\*\\* \\_u\\_');
  const root = fixture(t);
  editJson(path.join(root, 'core/registry/settings.json'), (raw) => {
    raw.keys['advice.enabled'].description = '[click](javascript:alert(1)) ![img](http://evil.example/t.png) *em* **b**';
  });
  editJson(path.join(root, 'core/registry/harnesses.json'), (raw) => { raw.harnesses[6].displayName = '[k](javascript:alert(2))'; });
  const settings = renderBlock('settings-keys', root);
  assert.ok(settings.includes('\\[click\\]\\(javascript:alert\\(1\\)\\) \\!\\[img\\]\\(http://evil.example/t.png\\) \\*em\\* \\*\\*b\\*\\*'), settings);
  assert.ok(!settings.includes('[click](') && !settings.includes('![img]('), 'no live link or image syntax');
  const matrix = renderBlock('capability-matrix', root);
  assert.ok(matrix.includes('| \\[k\\]\\(javascript:alert\\(2\\)\\) |') && !matrix.includes('[k]('), 'the header is escaped too');
});

test('N-1: an unindented heading inside Commands:, a doflow-run group without a colon, a verb before any group and a hint-only row all fail capture', (t) => {
  const run = 'Intro\n\nGroup A:\n  paths            resolve paths\n';
  const doflowOk = 'Commands:\n  install [path]       Install configs\n\n  status               Show status\n\nOptions:\n  --json  x\n';
  const root = fixture(t);
  writeHelp(root, doflowOk, run);
  assert.deepEqual(captureHelp(root).doflow.map((row) => row.verb), ['install', 'status'], 'a blank line inside Commands: does not end it; a blank line then a heading does');
  writeHelp(root, 'Commands:\n  install [path]       Install configs\nAdvanced commands:\n  hidden               x\n', run);
  assert.throws(() => captureHelp(root), /cannot read the line "Advanced commands:"/);
  writeHelp(root, 'Commands:\n  install  [path]\n', run);
  assert.throws(() => captureHelp(root), /cannot read the line "  install  \[path\]"/);
  writeHelp(root, doflowOk, 'Intro\n\nGroup A:\n  paths            resolve\nGroup B (new)\n  gamma            dropped\n');
  assert.throws(() => captureHelp(root), /cannot read the line "Group B \(new\)"/);
  writeHelp(root, doflowOk, 'Intro\n  zeta             before any group\n\nGroup A:\n  paths            resolve\n');
  assert.throws(() => captureHelp(root), /cannot read the line "  zeta/);
});

test('N-2: the G44 checker formats every expected cell as the generator does (a legacy path with a pipe and angle brackets passes)', (t) => {
  const root = fixture(t);
  editJson(path.join(root, 'core/registry/settings.json'), (raw) => {
    raw.keys['storage.prune'].legacy[0].path = 'x|y<z>.json';
    raw.keys['storage.prune'].legacy[1].path = 'x|y<z>.json';
  });
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'core/registry/settings.json'), 'utf8'));
  const loaded = loadSettingsRegistry({ repoRoot: root, fsImpl: fs, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const block = renderBlock('settings-keys', root);
  assert.match(block, /x\\\|y&lt;z&gt;\.json/);
  assert.deepEqual(checkSettingsDocs(raw, `## Settings keys\n\n${block}\n`, loaded.registry), []);
});

test('N-3: a marker with indentation, trailing white space or a CR is still recognised, and reported', () => {
  assert.deepEqual(markerFindings('guide.md', '  <!-- BEGIN GENERATED:nosuch -->\n| t |\n<!-- END GENERATED:nosuch -->\n'), [{ page: 'guide.md', id: 'nosuch', kind: 'orphan' }]);
  assert.deepEqual(markerFindings('settings.md', '<!-- BEGIN GENERATED:settings-keys --> \nx\n<!-- END GENERATED:settings-keys -->\n'), [{ page: 'settings.md', id: 'settings-keys', kind: 'orphan' }]);
  assert.deepEqual(markerFindings('settings.md', '<!-- BEGIN GENERATED:settings-keys -->\r\nx\r\n<!-- END GENERATED:settings-keys -->\r\n'), [{ page: 'settings.md', id: 'settings-keys', kind: 'orphan' }]);
});

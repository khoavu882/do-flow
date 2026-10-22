'use strict';

// G61 — generated docs stay aligned with their registries, CLI help, navigation and workflow pins.
// (a) generated blocks are current; (b) generated markers are paired and registered;
// (c) docs pages are in nav or valid moved-page stubs; (d) documented CLI verbs exist;
// (e) MkDocs link validation warns; (f) docs actions are not older than other workflows;
// (g) llms.txt stays within its byte cap. Every check takes a root for seeded controls.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { BLOCKS, LLMS_CAP, checkAll, captureHelp, readNav } = require('../../src/release/docs-blocks.ts');

const REPO = path.resolve(__dirname, '../..');
const COPY_PATHS = [
  'docs', 'mkdocs.yml', 'core/registry', '.github/workflows', 'bin', 'src',
  'core/shared/scripts', 'package.json',
];
let COPY;

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(root, rel, text) {
  fs.writeFileSync(path.join(root, rel), text);
}

function copyGuardInputs(source, destination) {
  for (const rel of COPY_PATHS) {
    const from = path.join(source, rel);
    const to = path.join(destination, rel);
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true });
    else fs.copyFileSync(from, to);
  }
}

function docsMarkdown(root) {
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(path.join(root, 'docs'), full).split(path.sep)[0] !== 'javascripts') walk(full);
      } else if (entry.name.endsWith('.md')) {
        pages.push(path.relative(path.join(root, 'docs'), full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(root, 'docs'));
  return pages.sort();
}

function notInNavPages(root) {
  const lines = read(root, 'mkdocs.yml').split(/\r?\n/);
  const start = lines.findIndex((line) => /^not_in_nav:\s*(?:\|\s*)?$/.test(line));
  const pages = new Set();
  if (start < 0) return pages;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s*(?:-\s+)?\/?([^\s#]+\.md)\s*$/);
    if (match) pages.add(match[1].replace(/^\//, ''));
  }
  return pages;
}

function checkStub(root, page, navPages) {
  const problems = [];
  const text = read(root, `docs/${page}`).replace(/\r\n/g, '\n').replace(/\n$/, '');
  const lines = text.split('\n');
  if (lines.length > 8) problems.push(`docs/${page} has ${lines.length} lines (maximum 8)`);
  let body = lines;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) problems.push(`docs/${page} has unclosed front matter`);
    else body = lines.slice(end + 1);
  }
  const headings = body.filter((line) => /^#\s+\S/.test(line));
  if (headings.length !== 1) problems.push(`docs/${page} must have exactly one H1`);
  const sentences = body.filter((line) => /\[[^\]]+\]\([^)]+\.md\)/.test(line));
  if (sentences.length !== 1) problems.push(`docs/${page} must have one sentence linking to a nav page`);
  let targetPage = null;
  if (sentences.length === 1) {
    const sentence = sentences[0];
    const match = sentence.match(/^This page moved to \[[^\]]+\]\(([^)]+\.md)\)\.$/);
    if (!match || match[1].startsWith('/') || /^[a-z]+:/i.test(match[1])) {
      problems.push(`docs/${page} must have one sentence with a relative .md link`);
    } else {
      targetPage = path.posix.normalize(path.posix.join(path.posix.dirname(page), match[1]));
      if (!navPages.has(targetPage)) problems.push(`docs/${page} links to non-nav page ${targetPage}`);
    }
  }
  const refreshes = body.filter((line) => /^<meta http-equiv="refresh" content="0; url=\.\.\/[^\"]*">$/.test(line));
  if (refreshes.length !== 1) problems.push(`docs/${page} must have one relative meta refresh line`);
  if (refreshes.length === 1 && targetPage) {
    const targetUrl = targetPage === 'index.md' ? '../' : `../${targetPage.replace(/\.md$/, '')}/`;
    if (refreshes[0] !== `<meta http-equiv="refresh" content="0; url=${targetUrl}">`) {
      problems.push(`docs/${page} refresh does not target ${targetPage}`);
    }
  }
  const expectedBody = [headings[0], '', sentences[0], '', refreshes[0]];
  if (body.length !== 5 || body.some((line, index) => line !== expectedBody[index])) {
    problems.push(`docs/${page} has content outside its H1, move sentence and refresh line`);
  }
  return problems;
}

function checkNavAndStubs(root) {
  const problems = [];
  const nav = new Set(readNav(root).map((entry) => entry.path));
  const notNav = notInNavPages(root);
  for (const page of docsMarkdown(root)) {
    if (!nav.has(page) && !notNav.has(page)) problems.push(`docs/${page} is neither in nav nor not_in_nav`);
  }
  for (const page of notNav) {
    if (!fs.existsSync(path.join(root, 'docs', page))) problems.push(`mkdocs.yml lists missing docs/${page}`);
    else problems.push(...checkStub(root, page, nav));
  }
  return problems;
}

// The verb is the leading lowercase word of the token, so output text such as `doflow slot: <name>`
// reads as `slot`. A flag, placeholder, variable, path or file name is not a verb mention.
function mentionedVerb(token) {
  if (/^(?:-|<|\[|\$|\{)/.test(token) || /[/.]/.test(token)) return null;
  const match = token.match(/^[a-z][a-z0-9-]*/);
  return match ? match[0] : null;
}

function checkCommandVerbs(root, help) {
  const validDoflow = new Set(help.doflow.map((row) => row.verb));
  const validRun = new Set(help.doflowRun.map((row) => row.verb));
  const problems = [];
  for (const page of readNav(root).map((entry) => entry.path)) {
    const lines = read(root, `docs/${page}`).split(/\r?\n/);
    let inFence = false;
    lines.forEach((line, index) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return;
      }
      const mentions = [];
      if (inFence) {
        const command = line.match(/^\s*(?:\$\s+)?(doflow-run|doflow|"\$DOFLOW")\s+(\S+)/);
        if (command) mentions.push({ kind: command[1] === 'doflow' ? 'doflow' : 'run', word: command[2] });
      }
      for (const span of line.matchAll(/`([^`\n]+)`/g)) {
        const command = span[1].match(/^\s*(doflow-run|doflow)\s+(\S+)/);
        if (command) mentions.push({ kind: command[1] === 'doflow' ? 'doflow' : 'run', word: command[2] });
      }
      for (const mention of mentions) {
        const verb = mentionedVerb(mention.word);
        if (verb === null) continue;
        const known = mention.kind === 'doflow' ? validDoflow : validRun;
        if (!known.has(verb)) problems.push(`${page}:${index + 1}: ${verb}`);
      }
    });
  }
  return problems;
}

function checkValidation(root) {
  const lines = read(root, 'mkdocs.yml').split(/\r?\n/);
  const start = lines.findIndex((line) => /^validation:\s*$/.test(line));
  if (start < 0) return ['mkdocs.yml is missing validation:'];
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z_][\w-]*):\s*(\S+)\s*$/);
    if (match) block.push([match[1], match[2]]);
  }
  const expected = ['omitted_files', 'absolute_links', 'unrecognized_links', 'anchors'];
  const problems = [];
  for (const key of expected) {
    const values = block.filter(([name]) => name === key).map(([, value]) => value);
    if (values.length !== 1 || values[0] !== 'warn') problems.push(`mkdocs.yml validation.${key} must be exactly warn`);
  }
  for (const [key] of block) {
    if (!expected.includes(key)) problems.push(`mkdocs.yml validation has unexpected key ${key}`);
  }
  return problems;
}

function actionMajor(ref, line) {
  const tagged = ref.match(/^v(\d+)(?:\.|$)/);
  if (tagged) return Number(tagged[1]);
  const comment = line.match(/#\s*v(\d+)\b/);
  return comment ? Number(comment[1]) : null;
}

function workflowFiles(root) {
  const dir = path.join(root, '.github/workflows');
  return fs.readdirSync(dir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml')).map((name) => name);
}

function workflowActions(root, file) {
  const actions = [];
  read(root, `.github/workflows/${file}`).split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/\buses:\s*(actions\/[^@\s]+)@([^\s#]+)/);
    if (match) actions.push({ name: match[1].slice('actions/'.length), major: actionMajor(match[2], line), line: index + 1 });
  });
  return actions;
}

function checkWorkflowMajors(root) {
  const docs = workflowActions(root, 'docs.yml');
  const others = workflowFiles(root).filter((file) => file !== 'docs.yml').flatMap((file) => workflowActions(root, file));
  const problems = [];
  for (const action of docs) {
    if (action.major === null) {
      problems.push(`.github/workflows/docs.yml:${action.line}: ${action.name} has no recognizable major`);
      continue;
    }
    const highest = Math.max(-1, ...others.filter((entry) => entry.name === action.name && entry.major !== null).map((entry) => entry.major));
    if (highest > action.major) problems.push(`.github/workflows/docs.yml:${action.line}: ${action.name} v${action.major} is below v${highest}`);
  }
  return problems;
}

function checkLlmsCap(root) {
  const size = fs.statSync(path.join(root, 'docs/llms.txt')).size;
  return size <= LLMS_CAP ? [] : [`docs/llms.txt is ${size} bytes (maximum ${LLMS_CAP})`];
}

before((t) => {
  COPY = tempDir(t, 'doflow-docs-generated-');
  copyGuardInputs(REPO, COPY);
});

test('G61 helper copies only the inputs required by clauses a-g', () => {
  assert.deepEqual(fs.readdirSync(COPY).sort(), COPY_PATHS.map((entry) => entry.split('/')[0]).filter((entry, index, all) => all.indexOf(entry) === index).sort());
  for (const rel of COPY_PATHS) assert.ok(fs.existsSync(path.join(COPY, rel)), `${rel} was not copied`);
});

test('G61.a generated blocks match their sources', () => {
  assert.deepEqual(checkAll(REPO), [], `repo findings: ${JSON.stringify(checkAll(REPO))}`);
  assert.deepEqual(checkAll(COPY), [], `copy findings: ${JSON.stringify(checkAll(COPY))}`);
  const file = path.join(COPY, 'core/registry/settings.json');
  const original = fs.readFileSync(file, 'utf8');
  try {
    const settings = JSON.parse(original);
    const first = Object.values(settings.keys)[0];
    first.description += ' seeded drift';
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    const findings = checkAll(COPY);
    assert.ok(findings.some((finding) => finding.page === 'settings.md' && finding.id === 'settings-keys' && finding.kind === 'stale'), JSON.stringify(findings));
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('G61.b generated markers are registered, paired and complete', () => {
  const checkMarkers = (root) => {
    const findings = checkAll(root).filter((finding) => ['orphan', 'missing'].includes(finding.kind));
    const registered = new Set(BLOCKS.map((block) => block.id));
    const reported = new Set(findings.map((finding) => `${finding.page}:${finding.id}`));
    for (const page of docsMarkdown(root)) {
      const text = read(root, `docs/${page}`);
      for (const match of text.matchAll(/<!-- BEGIN GENERATED:([^\s>]+) -->/g)) {
        const key = `${page}:${match[1]}`;
        if (!registered.has(match[1]) && !reported.has(key)) findings.push({ page: `docs/${page}`, id: match[1], kind: 'orphan' });
      }
    }
    return findings;
  };
  assert.deepEqual(checkMarkers(REPO), [], JSON.stringify(checkMarkers(REPO)));
  assert.deepEqual(checkMarkers(COPY), [], JSON.stringify(checkMarkers(COPY)));
  const file = path.join(COPY, 'docs/guide.md');
  const original = fs.readFileSync(file, 'utf8');
  write(COPY, 'docs/guide.md', `${original}\n<!-- BEGIN GENERATED:nosuch -->\n<!-- END GENERATED:nosuch -->\n`);
  const findings = checkMarkers(COPY);
  assert.ok(findings.some((finding) => finding.page.includes('guide.md') && finding.id === 'nosuch'), JSON.stringify(findings));
  write(COPY, 'docs/guide.md', original);
});

test('G61.c every docs page is in nav or a valid moved-page stub', () => {
  assert.deepEqual(checkNavAndStubs(REPO), [], JSON.stringify(checkNavAndStubs(REPO)));
  assert.deepEqual(checkNavAndStubs(COPY), [], JSON.stringify(checkNavAndStubs(COPY)));
  fs.writeFileSync(path.join(COPY, 'docs/orphan.md'), '# Orphan\n');
  assert.ok(checkNavAndStubs(COPY).some((problem) => problem.includes('docs/orphan.md')), checkNavAndStubs(COPY).join('\n'));
  fs.rmSync(path.join(COPY, 'docs/orphan.md'));
  const file = path.join(COPY, 'docs/overview.md');
  const original = fs.readFileSync(file, 'utf8');
  write(COPY, 'docs/overview.md', `${original}\n\nAnother paragraph.\n`);
  assert.ok(checkNavAndStubs(COPY).some((problem) => problem.includes('docs/overview.md')), checkNavAndStubs(COPY).join('\n'));
  write(COPY, 'docs/overview.md', original);
});

test('G61.d documented command verbs exist in CLI help', () => {
  const repoHits = checkCommandVerbs(REPO, captureHelp(REPO));
  const copyHits = checkCommandVerbs(COPY, captureHelp(COPY));
  const file = path.join(COPY, 'docs/guide.md');
  const original = fs.readFileSync(file, 'utf8');
  const seeded = `${original}\nRun \`doflow-run nosuchverb\`.\n`;
  write(COPY, 'docs/guide.md', seeded);
  const hits = checkCommandVerbs(COPY, captureHelp(COPY));
  assert.ok(hits.some((hit) => hit.startsWith('guide.md:') && hit.endsWith(': nosuchverb')), hits.join('\n'));
  write(COPY, 'docs/guide.md', original);
  assert.deepEqual(repoHits, [], `repo command hits (page:line: word):\n${repoHits.join('\n')}`);
  assert.deepEqual(copyHits, [], `copy command hits (page:line: word):\n${copyHits.join('\n')}`);
});

test('G61.e MkDocs validation contains exactly four warn settings', () => {
  assert.deepEqual(checkValidation(REPO), []);
  assert.deepEqual(checkValidation(COPY), []);
  const original = read(COPY, 'mkdocs.yml');
  write(COPY, 'mkdocs.yml', original.replace(/^  anchors: warn\n/m, ''));
  assert.ok(checkValidation(COPY).some((problem) => problem.includes('validation.anchors')), checkValidation(COPY).join('\n'));
  write(COPY, 'mkdocs.yml', original.replace(/^  anchors: warn\n/m, '  anchors: info\n'));
  assert.ok(checkValidation(COPY).some((problem) => problem.includes('validation.anchors')), checkValidation(COPY).join('\n'));
  write(COPY, 'mkdocs.yml', original);
});

test('G61.f docs workflow action majors are current against other workflows', () => {
  assert.deepEqual(checkWorkflowMajors(REPO), [], JSON.stringify(checkWorkflowMajors(REPO)));
  assert.deepEqual(checkWorkflowMajors(COPY), []);
  const file = path.join(COPY, '.github/workflows/docs.yml');
  const original = fs.readFileSync(file, 'utf8');
  write(COPY, '.github/workflows/docs.yml', original.replace('actions/checkout@v7', 'actions/checkout@v4'));
  const problems = checkWorkflowMajors(COPY);
  assert.ok(problems.some((problem) => problem.includes('checkout')), problems.join('\n'));
  write(COPY, '.github/workflows/docs.yml', original);
});

test('G61.g llms.txt is within its byte cap', () => {
  assert.deepEqual(checkLlmsCap(REPO), []);
  assert.deepEqual(checkLlmsCap(COPY), []);
  const file = path.join(COPY, 'docs/llms.txt');
  const original = fs.readFileSync(file, 'utf8');
  write(COPY, 'docs/llms.txt', `${original}${'x'.repeat(LLMS_CAP + 1)}`);
  assert.ok(checkLlmsCap(COPY).some((problem) => problem.includes('docs/llms.txt')), checkLlmsCap(COPY).join('\n'));
  write(COPY, 'docs/llms.txt', original);
});

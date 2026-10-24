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
const { tempDir } = require('../helper/tmp.ts');
const { LLMS_CAP, checkAll, captureHelp, markerFindings, readNav } = require('../../src/release/docs-blocks.ts');

const REPO = path.resolve(__dirname, '../..');
const COPY_PATHS: any = [
  'docs', 'mkdocs.yml', 'core/registry', '.github/workflows', 'bin', 'src',
  'core/shared/scripts', 'package.json',
];
let COPY: any;

function read(root: any, rel: any) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(root: any, rel: any, text: any) {
  fs.writeFileSync(path.join(root, rel), text);
}

function withSeededFile(root: any, rel: any, seed: any, check: any) {
  const file = path.join(root, rel);
  const original = fs.readFileSync(file, 'utf8');
  try {
    fs.writeFileSync(file, seed(original));
    return check(original);
  } finally {
    fs.writeFileSync(file, original);
  }
}

function copyGuardInputs(source: any, destination: any) {
  for (const rel of COPY_PATHS) {
    const from = path.join(source, rel);
    const to = path.join(destination, rel);
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true });
    else fs.copyFileSync(from, to);
  }
}

function docsMarkdown(root: any): any {
  const pages: any = [];
  const walk = (dir: any) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        pages.push(path.relative(path.join(root, 'docs'), full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(root, 'docs'));
  return pages.sort();
}

function notInNavPages(root: any) {
  const lines = read(root, 'mkdocs.yml').split(/\r?\n/);
  const start = lines.findIndex((line: any) => /^not_in_nav:\s*(?:\|\s*)?$/.test(line));
  const pages: any = new Set();
  if (start < 0) return pages;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s*(?:-\s+)?\/?([^\s#]+\.md)\s*$/);
    if (match) pages.add(match[1].replace(/^\//, ''));
  }
  return pages;
}

function checkStub(root: any, page: any, navPages: any) {
  const problems: any = [];
  const text = read(root, `docs/${page}`).replace(/\r\n/g, '\n').replace(/\n$/, '');
  const lines = text.split('\n');
  if (lines.length > 8) problems.push(`docs/${page} has ${lines.length} lines (maximum 8)`);
  let body = lines;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) problems.push(`docs/${page} has unclosed front matter`);
    else body = lines.slice(end + 1);
  }
  const headings = body.filter((line: any) => /^#\s+\S/.test(line));
  if (headings.length !== 1) problems.push(`docs/${page} must have exactly one H1`);
  const sentences = body.filter((line: any) => /\[[^\]]+\]\([^)]+\.md\)/.test(line));
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
  const refreshes = body.filter((line: any) => /^<meta http-equiv="refresh" content="0; url=\.\.\/[^\"]*">$/.test(line));
  if (refreshes.length !== 1) problems.push(`docs/${page} must have one relative meta refresh line`);
  if (refreshes.length === 1 && targetPage) {
    const targetUrl = targetPage === 'index.md' ? '../' : `../${targetPage.replace(/\.md$/, '')}/`;
    if (refreshes[0] !== `<meta http-equiv="refresh" content="0; url=${targetUrl}">`) {
      problems.push(`docs/${page} refresh does not target ${targetPage}`);
    }
  }
  const expectedBody: any = [headings[0], '', sentences[0], '', refreshes[0]];
  if (body.length !== 5 || body.some((line: any, index: any) => line !== expectedBody[index])) {
    problems.push(`docs/${page} has content outside its H1, move sentence and refresh line`);
  }
  return problems;
}

function checkNavAndStubs(root: any) {
  const problems: any = [];
  const nav: any = new Set(readNav(root).map((entry: any) => entry.path));
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
function mentionedVerb(token: any) {
  if (/^(?:-|<|\[|\$|\{)/.test(token) || /[/.]/.test(token)) return null;
  const match = token.match(/^[a-z][a-z0-9-]*/);
  return match ? match[0] : null;
}

function checkCommandVerbs(root: any, help: any): any {
  const validDoflow: any = new Set(help.doflow.map((row: any) => row.verb));
  const validRun: any = new Set(help.doflowRun.map((row: any) => row.verb));
  const problems: any = [];
  for (const page of readNav(root).map((entry: any) => entry.path)) {
    const lines = read(root, `docs/${page}`).split(/\r?\n/);
    let inFence = false;
    lines.forEach((line: any, index: any) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return;
      }
      const mentions: any = [];
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

function checkValidation(root: any) {
  const lines = read(root, 'mkdocs.yml').split(/\r?\n/);
  // PyYAML keeps the last of two duplicate keys, and a quoted or spaced key ("validation":,
  // validation :) is the same key, so any top-level spelling of it other than the one block is a
  // second validation key that can override the first.
  const validationLines = lines.map((line: any, index: any) => ({ line, index })).filter(({ line }: any) => /^["']?validation["']?\s*:/.test(line));
  const expected: any = ['omitted_files', 'absolute_links', 'unrecognized_links', 'anchors'];
  const problems: any = [];
  if (validationLines.length !== 1 || validationLines[0].line !== 'validation:') {
    return ['mkdocs.yml must contain one block-form validation: key'];
  }
  const block: any = [];
  for (const line of lines.slice(validationLines[0].index + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim() !== '') block.push(line);
  }
  if (block.some((line: any) => /[{}\[\]]/.test(line))) problems.push('mkdocs.yml validation block cannot use flow syntax');
  const indent = block[0]?.match(/^(\s+)/)?.[1];
  const actual: any = [];
  for (const line of block) {
    const match = line.match(/^(\s+)([A-Za-z_][\w-]*): warn$/);
    if (!match || match[1] !== indent) {
      problems.push(`mkdocs.yml validation has invalid or nested line ${line.trim()}`);
      continue;
    }
    actual.push(match[2]);
  }
  for (const key of expected) {
    if (actual.filter((name: any) => name === key).length !== 1) problems.push(`mkdocs.yml validation.${key} must be exactly warn`);
  }
  for (const key of actual) {
    if (!expected.includes(key)) problems.push(`mkdocs.yml validation has unexpected key ${key}`);
  }
  return problems;
}

function actionMajor(ref: any, line: any) {
  const tagged = ref.match(/^v(\d+)(?:\.|$)/);
  if (tagged) return Number(tagged[1]);
  const comment = line.match(/#\s*v(\d+)\b/);
  return comment ? Number(comment[1]) : null;
}

function workflowFiles(root: any) {
  const dir = path.join(root, '.github/workflows');
  return fs.readdirSync(dir).filter((name: any) => name.endsWith('.yml') || name.endsWith('.yaml')).map((name: any) => name);
}

function workflowActions(root: any, file: any): any {
  const actions: any = [];
  read(root, `.github/workflows/${file}`).split(/\r?\n/).forEach((line: any, index: any) => {
    const match = line.match(/\buses:\s*(actions\/[^@\s]+)@([^\s#]+)/);
    if (match) actions.push({ name: match[1].slice('actions/'.length), major: actionMajor(match[2], line), line: index + 1 });
  });
  return actions;
}

function checkWorkflowMajors(root: any) {
  const docs = workflowActions(root, 'docs.yml');
  const others = workflowFiles(root).filter((file: any) => file !== 'docs.yml').flatMap((file: any) => workflowActions(root, file));
  const problems: any = [];
  const floors: any = { checkout: 7, 'setup-python': 7, 'configure-pages': 6, 'upload-pages-artifact': 5, 'deploy-pages': 5 };
  for (const [name, floor] of Object.entries(floors)) {
    const matches = docs.filter((action: any) => action.name === name);
    if (matches.length === 0) {
      problems.push(`.github/workflows/docs.yml: ${name} is missing (minimum v${floor})`);
      continue;
    }
    for (const action of matches) {
      if (action.major === null || action.major < floor) problems.push(`.github/workflows/docs.yml:${action.line}: ${name} is below v${floor}`);
    }
  }
  for (const action of docs) {
    if (action.major === null) {
      problems.push(`.github/workflows/docs.yml:${action.line}: ${action.name} has no recognizable major`);
      continue;
    }
    const highest = Math.max(-1, ...others.filter((entry: any) => entry.name === action.name && entry.major !== null).map((entry: any) => entry.major));
    if (highest > action.major) problems.push(`.github/workflows/docs.yml:${action.line}: ${action.name} v${action.major} is below v${highest}`);
  }
  return problems;
}

function checkLlmsCap(root: any) {
  const size = fs.statSync(path.join(root, 'docs/llms.txt')).size;
  return size <= LLMS_CAP ? [] : [`docs/llms.txt is ${size} bytes (maximum ${LLMS_CAP})`];
}

before((t) => {
  COPY = tempDir(t, 'doflow-docs-generated-');
  copyGuardInputs(REPO, COPY);
});

test('G61 helper copies only the inputs required by clauses a-g', (): any => {
  assert.deepEqual(fs.readdirSync(COPY).sort(), COPY_PATHS.map((entry: any) => entry.split('/')[0]).filter((entry: any, index: any, all: any) => all.indexOf(entry) === index).sort());
  for (const rel of COPY_PATHS) assert.ok(fs.existsSync(path.join(COPY, rel)), `${rel} was not copied`);
});

test('G61.a generated blocks match their sources', (): any => {
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
    assert.ok(findings.some((finding: any) => finding.page === 'settings.md' && finding.id === 'settings-keys' && finding.kind === 'stale'), JSON.stringify(findings));
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('G61.b generated markers on every docs page are registered to that page, paired, not nested and complete', (): any => {
  const checkMarkers = (root: any) => {
    const findings = checkAll(root).filter((finding: any) => finding.kind === 'missing');
    for (const page of docsMarkdown(root)) {
      const text = read(root, `docs/${page}`);
      findings.push(...markerFindings(page, text));
    }
    return findings;
  };
  assert.deepEqual(checkMarkers(REPO), [], JSON.stringify(checkMarkers(REPO)));
  assert.deepEqual(checkMarkers(COPY), [], JSON.stringify(checkMarkers(COPY)));
  withSeededFile(COPY, 'docs/guide.md', (original: any) => `${original}\n<!-- BEGIN GENERATED:nosuch -->\n<!-- END GENERATED:nosuch -->\n`, () => {
    const findings = checkMarkers(COPY);
    assert.ok(findings.some((finding: any) => finding.page.includes('guide.md') && finding.id === 'nosuch'), JSON.stringify(findings));
  });
  const settingsPair = read(COPY, 'docs/settings.md').match(/<!-- BEGIN GENERATED:settings-keys -->[\s\S]*?<!-- END GENERATED:settings-keys -->/)[0];
  withSeededFile(COPY, 'docs/guide.md', (original: any) => `${original}\n${settingsPair}\n`, () => {
    const findings = checkMarkers(COPY);
    assert.ok(findings.some((finding: any) => finding.page.includes('guide.md') && finding.id === 'settings-keys'), JSON.stringify(findings));
  });
  withSeededFile(COPY, 'docs/guide.md', (original: any) => `${original}\n<!-- END GENERATED:task-classes -->\n`, () => {
    const findings = checkMarkers(COPY);
    assert.ok(findings.some((finding: any) => finding.page.includes('guide.md') && finding.id === 'task-classes'), JSON.stringify(findings));
  });
  withSeededFile(COPY, 'docs/specs/operating-modes.md', (original: any) => `${original}\n${settingsPair}\n`, () => {
    const findings = checkMarkers(COPY);
    assert.ok(findings.some((finding: any) => finding.page.includes('specs/operating-modes.md') && finding.id === 'settings-keys'), JSON.stringify(findings));
  });
  withSeededFile(COPY, 'docs/guide.md', (original: any) => `${original}\n  <!-- BEGIN GENERATED:nosuch -->\n| stale | table |\n<!-- END GENERATED:nosuch --> \n`, () => {
    const findings = checkMarkers(COPY);
    assert.ok(findings.some((finding: any) => finding.page.includes('guide.md') && finding.id === 'nosuch'), `an indented or trailing-space marker is still a marker: ${JSON.stringify(findings)}`);
  });
  withSeededFile(COPY, 'docs/capability-map.md', (original: any) => original.replace(/(<!-- BEGIN GENERATED:[^\s>]+ -->)/, '$1\n<!-- BEGIN GENERATED:settings-keys -->'), () => {
    const findings = checkMarkers(COPY);
    assert.ok(findings.some((finding: any) => finding.page.includes('capability-map.md')), JSON.stringify(findings));
  });
});

test('G61.c every docs page is in nav or a valid moved-page stub', (): any => {
  assert.deepEqual(checkNavAndStubs(REPO), [], JSON.stringify(checkNavAndStubs(REPO)));
  assert.deepEqual(checkNavAndStubs(COPY), [], JSON.stringify(checkNavAndStubs(COPY)));
  fs.writeFileSync(path.join(COPY, 'docs/orphan.md'), '# Orphan\n');
  assert.ok(checkNavAndStubs(COPY).some((problem: any) => problem.includes('docs/orphan.md')), checkNavAndStubs(COPY).join('\n'));
  fs.rmSync(path.join(COPY, 'docs/orphan.md'));
  const file = path.join(COPY, 'docs/overview.md');
  const original = fs.readFileSync(file, 'utf8');
  write(COPY, 'docs/overview.md', `${original}\n\nAnother paragraph.\n`);
  assert.ok(checkNavAndStubs(COPY).some((problem: any) => problem.includes('docs/overview.md')), checkNavAndStubs(COPY).join('\n'));
  write(COPY, 'docs/overview.md', original);
});

test('G61.d documented command verbs exist in CLI help', (): any => {
  const repoHits = checkCommandVerbs(REPO, captureHelp(REPO));
  const copyHits = checkCommandVerbs(COPY, captureHelp(COPY));
  const file = path.join(COPY, 'docs/guide.md');
  const original = fs.readFileSync(file, 'utf8');
  const seeded = `${original}\nRun \`doflow-run nosuchverb\`.\n`;
  write(COPY, 'docs/guide.md', seeded);
  const hits = checkCommandVerbs(COPY, captureHelp(COPY));
  assert.ok(hits.some((hit: any) => hit.startsWith('guide.md:') && hit.endsWith(': nosuchverb')), hits.join('\n'));
  write(COPY, 'docs/guide.md', original);
  assert.deepEqual(repoHits, [], `repo command hits (page:line: word):\n${repoHits.join('\n')}`);
  assert.deepEqual(copyHits, [], `copy command hits (page:line: word):\n${copyHits.join('\n')}`);
});

test('G61.e MkDocs validation is one block with exactly the four keys at warn', (): any => {
  assert.deepEqual(checkValidation(REPO), []);
  assert.deepEqual(checkValidation(COPY), []);
  withSeededFile(COPY, 'mkdocs.yml', (original: any) => original.replace(/^  anchors: warn\n/m, ''), (): any => {
    assert.ok(checkValidation(COPY).some((problem: any) => problem.includes('validation.anchors')), checkValidation(COPY).join('\n'));
  });
  withSeededFile(COPY, 'mkdocs.yml', (original: any) => original.replace(/^  anchors: warn\n/m, '  anchors: info\n'), (): any => {
    assert.ok(checkValidation(COPY).some((problem: any) => problem.includes('validation.anchors')), checkValidation(COPY).join('\n'));
  });
  withSeededFile(COPY, 'mkdocs.yml', (original: any) => original.replace('  anchors: warn', '  links: {anchors: info}\n  anchors: warn'), (): any => {
    assert.ok(checkValidation(COPY).length > 0, checkValidation(COPY).join('\n'));
  });
  withSeededFile(COPY, 'mkdocs.yml', (original: any) => original.replace('  anchors: warn', '  links:\n    anchors: info\n  anchors: warn'), (): any => {
    assert.ok(checkValidation(COPY).length > 0, checkValidation(COPY).join('\n'));
  });
  withSeededFile(COPY, 'mkdocs.yml', (original: any) => original.replace(/validation:\n(?:  .*\n)+/, 'validation: {omitted_files: warn, absolute_links: warn, unrecognized_links: warn, anchors: warn}\n'), (): any => {
    assert.ok(checkValidation(COPY).length > 0, checkValidation(COPY).join('\n'));
  });
  withSeededFile(COPY, 'mkdocs.yml', (original: any) => `${original.replace(/\n*$/, '\n')}"validation": {links: {anchors: info}}\n`, (): any => {
    withSeededFile(COPY, 'docs/guide.md', (guide: any) => `${guide}\nSee [a dead anchor](setup.md#no-such-heading).\n`, (): any => {
      assert.ok(checkValidation(COPY).some((problem: any) => problem.includes('one block-form validation')), checkValidation(COPY).join('\n'));
    });
  });
  withSeededFile(COPY, 'mkdocs.yml', (original: any) => `${original.replace(/\n*$/, '\n')}validation : {anchors: info}\n`, (): any => {
    assert.ok(checkValidation(COPY).some((problem: any) => problem.includes('one block-form validation')), checkValidation(COPY).join('\n'));
  });
  withSeededFile(COPY, 'mkdocs.yml', (original: any) => original.replace('  anchors: warn', "  anchors: 'warn'"), (): any => {
    assert.ok(checkValidation(COPY).some((problem: any) => problem.includes('validation.anchors')), checkValidation(COPY).join('\n'));
  });
});

test('G61.f docs workflow actions are at or above their floors and not below the same action in another workflow', (): any => {
  assert.deepEqual(checkWorkflowMajors(REPO), [], JSON.stringify(checkWorkflowMajors(REPO)));
  assert.deepEqual(checkWorkflowMajors(COPY), []);
  withSeededFile(COPY, '.github/workflows/docs.yml', (original: any) => original.replace('actions/checkout@v7', 'actions/checkout@v4'), () => {
    const problems = checkWorkflowMajors(COPY);
    assert.ok(problems.some((problem: any) => problem.includes('checkout')), problems.join('\n'));
  });
  for (const [name, current, old] of [
    ['deploy-pages', 'actions/deploy-pages@v5', 'actions/deploy-pages@v1'],
    ['setup-python', 'actions/setup-python@v7', 'actions/setup-python@v1'],
    ['upload-pages-artifact', 'actions/upload-pages-artifact@v5', 'actions/upload-pages-artifact@v1'],
    ['configure-pages', 'actions/configure-pages@v6', 'actions/configure-pages@v1'],
  ]) {
    withSeededFile(COPY, '.github/workflows/docs.yml', (original: any) => original.replace(current, old), () => {
      const problems = checkWorkflowMajors(COPY);
      assert.ok(problems.some((problem: any) => problem.includes(name)), problems.join('\n'));
    });
  }
  withSeededFile(COPY, '.github/workflows/docs.yml', (original: any) => original.replace('        uses: actions/deploy-pages@v5\n', ''), () => {
    const problems = checkWorkflowMajors(COPY);
    assert.ok(problems.some((problem: any) => problem.includes('deploy-pages')), problems.join('\n'));
  });
});

test('G61.g llms.txt is within its byte cap', (): any => {
  assert.deepEqual(checkLlmsCap(REPO), []);
  assert.deepEqual(checkLlmsCap(COPY), []);
  const file = path.join(COPY, 'docs/llms.txt');
  const original = fs.readFileSync(file, 'utf8');
  write(COPY, 'docs/llms.txt', `${original}${'x'.repeat(LLMS_CAP + 1)}`);
  assert.ok(checkLlmsCap(COPY).some((problem) => problem.includes('docs/llms.txt')), checkLlmsCap(COPY).join('\n'));
  write(COPY, 'docs/llms.txt', original);
});

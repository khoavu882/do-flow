'use strict';

// G30 — decision-model advice cannot leak into hooks, dependencies or unsafe runtime modules. The one child process the
//       advice folder may start is the detached shadow call (row 174 O-2): `child_process` is allowed only in
//       shadow-dispatcher.ts, and there only as `spawn(process.execPath, [RUNNER, handoff], ...)` with RUNNER the shadow-runner beside it,
//       named with the dispatcher's own extension so it resolves in the published `.js` package too (G30.3). The detached child is why record.ts and the hooks stay free of it too.
// G31 — advice corpus and tier criteria remain synchronized with their source registries, and every registered
//       advice kind has a call site that still exists, outside comments and prose: asked by a runtime verb, or an
//       `advise --kind` step in a bash block of a skill with an `advise --action outcome` line beside it (G31.4).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { adviceCoverage } = require('../../bench/advice.ts');

function entries(files: any) {
  return files instanceof Map ? [...files.entries()] : Object.entries(files || {});
}

function getFile(files: any, file: any) {
  return files instanceof Map ? files.get(file) : files?.[file];
}

function parseJsonFile(files: any, file: any, findings: any) {
  try { return JSON.parse(getFile(files, file)); }
  catch (error: any) {
    findings.push(`${file}:1 invalid JSON (${error.message})`);
    return null;
  }
}

function pathLines(files: any, predicate: any): any {
  const result: any = [];
  for (const [file, text] of entries(files)) {
    if (!predicate(file)) continue;
    text.split('\n').forEach((line: any, index: any) => result.push({ file, line: index + 1, text: line }));
  }
  return result;
}

function checkG30Hooks({ files }: any) {
  const findings: any = [];
  for (const hit of pathLines(files, (file: any) => /^core\/harnesses\/(?:[^/]+\/)*hooks\//.test(file))) {
    if (/\badvise\b(?!-)|runtime\/advice|--request/.test(hit.text)) {
      findings.push(`${hit.file}:${hit.line} contains an advice dispatch token`);
    }
  }
  return findings;
}

function checkG30Dependencies({ files }: any): any {
  const file = 'package.json';
  const text = getFile(files, file);
  if (text === undefined) return [`${file}:1 package.json is required for G30.2`];
  const findings: any = [];
  const manifest = parseJsonFile(files, file, findings);
  if (!manifest) return findings;
  for (const key of ['dependencies', 'optionalDependencies']) {
    if (!Object.hasOwn(manifest, key)) continue;
    const value = manifest[key];
    const hasEntries = Array.isArray(value) ? value.length > 0
      : value && typeof value === 'object' ? Object.keys(value).length > 0
        : Boolean(value);
    if (!hasEntries) continue;
    const line = text.split('\n').findIndex((entry: any) => new RegExp(`^\\s*"${key}"\\s*:`).test(entry)) + 1;
    findings.push(`${file}:${line || 1} nonempty ${key} are not permitted`);
  }
  return findings;
}

const SHADOW_DISPATCHER = 'src/runtime/advice/shadow-dispatcher.ts';

/** Blanks comments, keeping every newline, so a regex over the result still reports the source line. */
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** The one spawn shadow-dispatcher.ts may hold: spawn(process.execPath, [RUNNER, handoff], ...), no shell, no exec*, no fork. */
function checkShadowSpawn(file: string, text: string): any {
  const code = blankComments(text);
  const lineAt = (index: number) => code.slice(0, index).split('\n').length;
  const findings: any = [];
  const importMatch = code.match(/const\s*\{([^}]*)\}\s*=\s*require\s*\(\s*(['"])(?:node:)?child_process\2\s*\)/);
  if (!importMatch || importMatch[1].trim() !== 'spawn') {
    findings.push(`${file}:${importMatch ? lineAt(importMatch.index as number) : 1} must import exactly { spawn } from child_process`);
  }
  const calls = [...code.matchAll(/\bspawn\s*\)?\s*\(\s*([^,()]+?)\s*,\s*(\[[^\]]*\])/g)];
  const callCount = [...code.matchAll(/\bspawn\s*\)?\s*\(/g)].length;
  if (callCount !== 1 || calls.length !== 1) findings.push(`${file}:1 must hold exactly one spawn call (found ${callCount})`);
  for (const call of calls) {
    if (call[1] !== 'process.execPath' || call[2].replace(/\s+/g, '') !== '[RUNNER,handoff]') {
      findings.push(`${file}:${lineAt(call.index as number)} the only spawn is spawn(process.execPath, [RUNNER, handoff], ...)`);
    }
  }
  if (!/const RUNNER = path\.join\(__dirname, `shadow-runner\$\{path\.extname\(__filename\)\}`\);/.test(code)) {
    findings.push(`${file}:1 RUNNER must be path.join(__dirname, \`shadow-runner\${path.extname(__filename)}\`)`);
  }
  for (const match of code.matchAll(/\b(?:exec|execSync|execFile|execFileSync|spawnSync|fork)\s*\(|\bshell\s*:/g)) {
    findings.push(`${file}:${lineAt(match.index as number)} '${match[0].replace(/\s*\($/, '')}' is not permitted: only a plain spawn of the runner`);
  }
  return findings;
}

function checkG30Requires({ files }: any) {
  const findings: any = [];
  const importPattern = /(?:require\s*\(|\bfrom\b|\bimport\s*\()\s*(['"])(?:node:)?child_process\1/;
  for (const hit of pathLines(files, (file: any) => file.startsWith('src/runtime/advice/') && file !== SHADOW_DISPATCHER)) {
    if (importPattern.test(hit.text)) findings.push(`${hit.file}:${hit.line} child_process is allowed only in ${SHADOW_DISPATCHER}`);
  }
  const dispatcher = getFile(files, SHADOW_DISPATCHER);
  if (dispatcher !== undefined) findings.push(...checkShadowSpawn(SHADOW_DISPATCHER, dispatcher));
  const requirePattern = /require\s*\(\s*(['"])(?:node:)?(http|https|dns|net|child_process)\1\s*\)/g;
  for (const hit of pathLines(files, (file: any) => file.startsWith('src/runtime/advice/'))) {
    for (const match of hit.text.matchAll(requirePattern)) {
      const moduleName = match[2];
      const base = hit.file.slice('src/runtime/advice/'.length);
      const provider = /^providers\/[^/]+\.(?:js|ts)$/.test(base);
      let allowed = true;
      if (moduleName === 'child_process') continue; // judged above, per file
      if (moduleName === 'net') allowed = false;
      else if (['record', 'config'].includes(base.replace(/\.(?:js|ts)$/, ''))) allowed = false;
      else if (['http', 'https'].includes(moduleName)) allowed = base.replace(/\.(?:js|ts)$/, '') === 'client' || provider;
      else if (moduleName === 'dns') allowed = base.replace(/\.(?:js|ts)$/, '') === 'endpoint-guard';
      if (!allowed) findings.push(`${hit.file}:${hit.line} require('${match[0].includes('node:') ? 'node:' : ''}${moduleName}') is not permitted here`);
    }
  }
  return findings;
}

function checkG30ProviderRoutes({ files }: any) {
  const findings: any = [];
  const forbidden = /\/api\/(?:pull|push|create|copy|delete)|ollama serve/;
  for (const hit of pathLines(files, (file: any) => file.startsWith('src/runtime/advice/providers/'))) {
    if (forbidden.test(hit.text)) findings.push(`${hit.file}:${hit.line} contains a provider write route or server start`);
  }
  return findings;
}

function adviceInputs(files: any, findings: any) {
  const registry = parseJsonFile(files, 'core/registry/advice.json', findings);
  const sources: any = {};
  for (const [name, file] of Object.entries({
    workflows: 'core/registry/workflows.json',
    verification: 'core/registry/verification.json',
    mcp: 'core/registry/mcp.json',
  })) sources[name] = parseJsonFile(files, file, findings);
  const corpus: any = {};
  for (const [file, text] of entries(files)) {
    const match = file.match(/^bench\/advice\/([^/]+)\.json$/);
    if (match) {
      try { corpus[match[1]] = JSON.parse(text); }
      catch (error: any) { findings.push(`${file}:1 invalid JSON (${error.message})`); }
    }
  }
  return { registry, sources, corpus };
}

function checkG31Coverage({ files }: any): any {
  const findings: any = [];
  const { registry, sources, corpus } = adviceInputs(files, findings);
  if (!registry) return findings;
  const result = adviceCoverage({ adviceRegistry: registry, sources, corpus });
  for (const gap of result.gaps) {
    const kind = gap.match(/^([^:]+):/)?.[1];
    const path = kind && Object.hasOwn(corpus, kind) ? `bench/advice/${kind}.json` : 'core/registry/advice.json';
    findings.push(`${path}:1 ${gap}`);
  }
  return findings;
}

function tierContext(files: any, findings: any) {
  const advice = parseJsonFile(files, 'core/registry/advice.json', findings);
  const models = parseJsonFile(files, 'core/registry/models.json', findings);
  const kind = advice?.kinds?.find((item: any) => item.id === 'tier');
  const criteria = kind?.criteria;
  const tiers = models?.dispatchTiers?.tiers;
  if (!criteria || !tiers) findings.push('core/registry/advice.json:1 tier criteria or models dispatch tiers are missing');
  return { criteria, tiers };
}

function checkG31TierKeys({ files }: any): any {
  const findings: any = [];
  const { criteria, tiers } = tierContext(files, findings);
  if (!criteria || !tiers) return findings;
  const actual = Object.keys(criteria);
  if (JSON.stringify(actual) !== JSON.stringify(tiers)) {
    findings.push(`core/registry/advice.json:1 tier criteria keys [${actual.join(', ')}] do not match models dispatch tiers [${tiers.join(', ')}]`);
  }
  return findings;
}

function checkG31TierText({ files }: any): any {
  const findings: any = [];
  const { criteria, tiers } = tierContext(files, findings);
  if (!criteria || !tiers) return findings;
  const guidancePath = 'core/shared/guidance/references/MODEL_SELECTION.md';
  const guidance = getFile(files, guidancePath);
  if (typeof guidance !== 'string') return [`${guidancePath}:1 guidance file is missing`];
  const lines = guidance.split('\n');
  const sectionStart = lines.findIndex((line) => line.trim() === '## Capability tiers');
  if (sectionStart < 0) return [`${guidancePath}:1 section '## Capability tiers' is missing`];
  const nextSection = lines.findIndex((line, index) => index > sectionStart && /^##\s/.test(line.trim()));
  const sectionEnd = nextSection < 0 ? lines.length : nextSection;
  const sectionLines = lines.slice(sectionStart + 1, sectionEnd);
  const cellsOf = (line: any) => line.trim().startsWith('|')
    ? line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell: any) => cell.trim()) : [];
  const headerOffset = sectionLines.findIndex((line) => {
    const headers = cellsOf(line).map((cell: any) => cell.replaceAll('`', ''));
    return headers.includes('Tier') && headers.includes('Work');
  });
  if (headerOffset < 0) return [`${guidancePath}:${sectionStart + 1} capability-tier table lacks Tier or Work column`];
  const headers = cellsOf(sectionLines[headerOffset]).map((cell: any) => cell.replaceAll('`', ''));
  const tierIndex = headers.indexOf('Tier');
  const workIndex = headers.indexOf('Work');
  const work: any = {};
  const workLines: any = {};
  for (let index = headerOffset + 1; index < sectionLines.length; index += 1) {
    const cells = cellsOf(sectionLines[index]);
    const tier = cells[tierIndex]?.replaceAll('`', '');
    if (tiers.includes(tier) && cells[workIndex] !== undefined) {
      work[tier] = cells[workIndex];
      workLines[tier] = sectionStart + index + 2;
    }
  }
  for (const tier of tiers) {
    const expected: any = work[tier];
    const actual = criteria[tier];
    if (actual !== expected) {
      findings.push(`core/registry/advice.json:1 tier '${tier}' criteria ${JSON.stringify(actual)} does not match ${guidancePath}:${workLines[tier] || sectionStart + 1} Work text ${JSON.stringify(expected)}`);
    }
  }
  return findings;
}

// G31.4 — every registered advice kind that something asks has a call site that still exists. Comments never count.
//  - A runtime-asked kind names the verb that asks it: that source file must, outside comments, ask advice for the kind
//    (`ask`) and, where the verb records the outcome (`outcome`), record it. `review-depth` records no outcome today
//    (`review start` returns no pick id; its dispatcher path writes the pick line only), so it has `outcome: null`; a skill step cannot close that gap, and the day the verb records
//    one this entry must say so.
//  - Every other kind needs an `advise --kind <id>` line inside a fenced bash block of a SKILL.md or reference, with an
//    `advise --action outcome` line in the same block or in the next bash block of that file, if that block asks nothing itself. Prose, shell comments and
//    HTML comments do not count. A new kind lands in one of the two places, or this fails.
const RUNTIME_ASKED: any = {
  // Row 174 O-6: classify records no task-class outcome; the class the workflow ran under is not linked to the pick.
  'task-class': { caller: 'classify', file: 'src/runtime/task-classifier.ts', outcome: null },
  'review-depth': { caller: 'review', file: 'src/runtime/review/start.ts', outcome: null },
  // 141 D.3: the detached shadow hook of `claim --action link` asks it; the recorded relation is the static answer, so no outcome line.
  'claim-support': { caller: 'claim', file: 'src/runtime/claims.ts', outcome: null },
};
const ASKS_ADVICE = /\b(?:client\.ask|interceptDecisionPoint)\(/;

function blankKeepingLines(text: string) { return text.replace(/[^\n]/g, ' '); }

/** Source text with `/* *\/` and `//` comments and `#` lines blanked (line numbers kept). */
function stripSourceComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, blankKeepingLines).split('\n')
    .map((line: string) => (/^\s*#/.test(line) ? '' : line.replace(/(^|[^:])\/\/.*$/, '$1')))
    .join('\n');
}

/** The bash fences of a markdown file, HTML comments blanked and shell comment lines dropped: [{ lines: [{ line, text }] }]. */
function bashBlocks(markdown: string) {
  const blocks: any = [];
  let open: any = null;
  let marker = '';
  markdown.replace(/<!--[\s\S]*?-->/g, blankKeepingLines).split('\n').forEach((text: string, index: number) => {
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(text);
    if (open === null) {
      if (fence) { marker = fence[1]; open = /^(?:bash|sh|shell|zsh)$/.test(fence[2]) ? { lines: [] } : { skip: true }; if (!open.skip) blocks.push(open); }
    } else if (fence && fence[1][0] === marker[0] && fence[1].length >= marker.length && fence[2] === '') open = null;
    else if (!open.skip && !/^\s*#/.test(text)) open.lines.push({ line: index + 1, text });
  });
  return blocks;
}

function checkG31CallSites({ files, docs }: any): any {
  const findings: any = [];
  const registry = parseJsonFile(files, 'core/registry/advice.json', findings);
  if (!registry) return findings;
  const blocksByFile: any = [...(docs instanceof Map ? docs.entries() : Object.entries(docs))]
    .filter(([file]: any) => /(?:^|\/)SKILL\.md$|\/references\/[^/]+\.md$/.test(file))
    .map(([file, text]: any) => ({ file, blocks: bashBlocks(text) }));
  for (const kind of registry.kinds) {
    // A kind nothing asks (an empty askedBy, `rerank`: measured offline by `bench advice-gate`) has no call site to keep.
    if (kind.askedBy.length === 0) continue;
    const runtime = RUNTIME_ASKED[kind.id];
    if (runtime) {
      if (!kind.askedBy.includes(runtime.caller)) findings.push(`${kind.id}: askedBy must name '${runtime.caller}'`);
      const source = stripSourceComments(getFile(docs, runtime.file) || '');
      if (!source.includes(`'${kind.id}'`) || !ASKS_ADVICE.test(source)) findings.push(`${kind.id}: ${runtime.file} no longer asks it outside a comment`);
      if (runtime.outcome && !runtime.outcome.test(source)) findings.push(`${kind.id}: ${runtime.file} no longer records its outcome outside a comment`);
      continue;
    }
    const call = new RegExp(`advise --kind ${kind.id}(?![\\w-])`);
    let first: any = null;
    let recorded = false;
    for (const { file, blocks } of blocksByFile) {
      blocks.forEach((block: any, index: number) => {
        const site = block.lines.find((entry: any) => call.test(entry.text));
        if (!site) return;
        first = first || `${file}:${site.line}`;
        const outcome = (candidate: any) => candidate && candidate.lines.some((entry: any) => entry.text.includes('advise --action outcome'));
        // The next block only counts when it is not another call's own block, so a neighbour's outcome line is not borrowed.
        const next = blocks[index + 1];
        if (outcome(block) || (next && !next.lines.some((entry: any) => /advise --kind /.test(entry.text)) && outcome(next))) recorded = true;
      });
    }
    if (!first) findings.push(`${kind.id}: no skill or reference has an 'advise --kind ${kind.id}' step in a bash block`);
    else if (!recorded) findings.push(`${kind.id}: no 'advise --action outcome' line in the bash block of its call site, or the next one (${first})`);
  }
  return findings;
}

function readSkillDocs() {
  const docs: any = new Map();
  function walk(directory: any) {
    for (const entry of fs.readdirSync(path.join(REPO, directory), { withFileTypes: true })) {
      const rel = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && rel.endsWith('.md')) docs.set(rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
    }
  }
  walk('core/shared/skills');
  for (const { file } of Object.values(RUNTIME_ASKED) as any) docs.set(file, fs.readFileSync(path.join(REPO, file), 'utf8'));
  return docs;
}

function readTree() {
  const files: any = new Map();
  function walk(directory: any) {
    for (const entry of fs.readdirSync(path.join(REPO, directory), { withFileTypes: true })) {
      const rel = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.set(rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
    }
  }
  for (const directory of ['core/harnesses', 'src/runtime/advice', 'bench/advice']) walk(directory);
  for (const file of [
    'package.json', 'core/registry/advice.json', 'core/registry/models.json', 'core/registry/mcp.json',
    'core/registry/workflows.json', 'core/registry/verification.json',
    'core/shared/guidance/references/MODEL_SELECTION.md',
  ]) files.set(file, fs.readFileSync(path.join(REPO, file), 'utf8'));
  return files;
}

const shipped = readTree();
const skillDocs = readSkillDocs();

test('G30.1: shipped hooks contain no advice dispatch surface', () => {
  assert.deepEqual(checkG30Hooks({ files: shipped }), []);
});
test('G30.1 control: names violating hook paths, including nested hooks, and line', () => {
  const findings = checkG30Hooks({ files: new Map([
    ['core/harnesses/demo/hooks/hook.sh', 'safe\ndoflow advise --kind tier\n'],
    ['core/harnesses/demo/sub/hooks/hook.js', "require('runtime/advice/client');\n"],
    ['core/harnesses/demo/hooks/prose.sh', '# the gate is advise-only, never denies\n'],
  ]) });
  assert.ok(findings.some((finding: any) => finding.includes('core/harnesses/demo/hooks/hook.sh:2')));
  assert.ok(!findings.some((finding: any) => finding.includes('prose.sh')));
  assert.ok(findings.some((finding: any) => finding.includes('core/harnesses/demo/sub/hooks/hook.js:1')));
});
test('G30.2: shipped package has no runtime dependencies', () => {
  assert.deepEqual(checkG30Dependencies({ files: shipped }), []);
});
test('G30.2 controls: missing manifest and nonempty object/array dependencies fail closed', () => {
  const missing = checkG30Dependencies({ files: new Map() });
  assert.ok(missing.some((finding: any) => finding.includes('package.json:1')));
  const object = checkG30Dependencies({ files: new Map([['package.json', '{\n  "dependencies": {\n    "sample": "1"\n  }\n}\n']]) });
  assert.ok(object.some((finding: any) => finding.includes('package.json:2')));
  const array = checkG30Dependencies({ files: new Map([['package.json', '{\n  "optionalDependencies": ["sample"]\n}\n']]) });
  assert.ok(array.some((finding: any) => finding.includes('package.json:2')));
});
test('G30.3: shipped runtime requires stay within approved boundaries', () => {
  assert.deepEqual(checkG30Requires({ files: shipped }), []);
});
test('G30.3 controls: rejects forbidden record/config placements and permits approved boundaries', () => {
  const fixture: any = new Map([
    ['src/runtime/advice/record.ts', "require('node:net');\n"],
    ['src/runtime/advice/config.ts', "require('dns');\n"],
    ['src/runtime/advice/strength.ts', "require('https');\n"],
    ['src/runtime/advice/other.js', "require('dns');\n"],
    ['src/runtime/advice/endpoint-guard.ts', "require('http');\nrequire('node:dns');\n"],
    ['src/runtime/advice/client.ts', "require('node:http');\n"],
    ['src/runtime/advice/providers/example.js', "require('https');\n"],
    ['src/runtime/advice/providers/process.js', "require('node:child_process');\n"],
  ]);
  const findings = checkG30Requires({ files: fixture });
  assert.ok(findings.some((finding: any) => finding.includes('src/runtime/advice/record.ts:1')));
  assert.ok(findings.some((finding: any) => finding.includes('src/runtime/advice/config.ts:1')));
  assert.ok(findings.some((finding: any) => finding.includes('src/runtime/advice/strength.ts:1')));
  assert.ok(findings.some((finding: any) => finding.includes('src/runtime/advice/other.js:1')));
  assert.ok(findings.some((finding: any) => finding.includes('src/runtime/advice/endpoint-guard.ts:1')));
  assert.ok(findings.some((finding: any) => finding.includes('src/runtime/advice/providers/process.js:1')));
  assert.equal(findings.length, 6);
});
test('G30.3 controls: child_process is allowed only in shadow-dispatcher.ts, and there only as the spawn of the runner', () => {
  const dispatcher = 'src/runtime/advice/shadow-dispatcher.ts';
  const good = [
    "const { spawn } = require('node:child_process');",
    'const RUNNER = path.join(__dirname, `shadow-runner${path.extname(__filename)}`);',
    '// exec(...) and spawn(other, [x]) in a comment are not code',
    'const child = (services.spawn || spawn)(process.execPath, [RUNNER, handoff], { detached: true });',
    '',
  ].join('\n');
  const run = (extra: any) => checkG30Requires({ files: new Map(Object.entries(extra)) });
  assert.deepEqual(run({ [dispatcher]: good }), [], 'the approved spawn passes');
  const other = run({ [dispatcher]: good, 'src/runtime/advice/client.ts': "const cp = require('node:child_process');\n" });
  assert.deepEqual(other.map((f: any) => f.split(' ')[0]), ['src/runtime/advice/client.ts:1']);
  assert.ok(run({ 'src/runtime/advice/shadow-runner.ts': "import { spawn } from 'child_process';\n" }).length === 1, 'an import form of child_process elsewhere');
  const rejected: Record<string, string> = {
    'a second spawn of another command': good + "spawn('git', ['status']);\n",
    'a different first argument': good.replace('process.execPath', "'node'"),
    'a different second argument': good.replace('[RUNNER, handoff]', "['other.js']"),
    'an argument more': good.replace('[RUNNER, handoff]', "[RUNNER, handoff, '--eval']"),
    'the runner alone': good.replace('[RUNNER, handoff]', '[RUNNER]'),
    'a shell option': good.replace('detached: true', 'shell: true'),
    'exec': good + "exec('ls');\n",
    'execFileSync': good + "execFileSync('ls');\n",
    'spawnSync': good + "spawnSync('ls', []);\n",
    'a wider import': good.replace('{ spawn }', '{ spawn, exec }'),
    'a RUNNER elsewhere': good.replace('`shadow-runner${', '`../elsewhere${'),
    'a RUNNER with a fixed extension': good.replace('`shadow-runner${path.extname(__filename)}`', "'shadow-runner.ts'"),
  };
  for (const [name, text] of Object.entries(rejected)) {
    assert.ok(run({ [dispatcher]: text }).length > 0, `${name} must fail`);
  }
  assert.ok(run({ [dispatcher]: good + "spawn('git', ['status']);\n" })[0].startsWith(`${dispatcher}:`), 'findings carry file:line');
});
test('G30.4: shipped providers contain no write routes or server start', () => {
  assert.deepEqual(checkG30ProviderRoutes({ files: shipped }), []);
});
test('G30.4 control: scans nested non-JavaScript provider files too', () => {
  const findings = checkG30ProviderRoutes({ files: new Map([
    ['src/runtime/advice/providers/example.js', "const route = '/api/pull';\n"],
    ['src/runtime/advice/providers/nested/notes.txt', 'ollama serve\n'],
  ]) });
  assert.ok(findings.some((finding: any) => finding.includes('src/runtime/advice/providers/example.js:1')));
  assert.ok(findings.some((finding: any) => finding.includes('src/runtime/advice/providers/nested/notes.txt:1')));
});
test('G31.1: shipped advice corpus has complete coverage', () => {
  assert.deepEqual(checkG31Coverage({ files: shipped }), []);
});
test('G31.1 control: names kind and missing coverage item', () => {
  const fixture: any = new Map(shipped);
  const file = 'bench/advice/tier.json';
  const corpus = JSON.parse(fixture.get(file));
  // Drop every case of one option: the seeded corpus holds several per option, so one pop no longer uncovers it.
  const dropped = corpus.cases[corpus.cases.length - 1].expected;
  corpus.cases = corpus.cases.filter((item: any) => item.expected !== dropped);
  fixture.set(file, JSON.stringify(corpus));
  const findings = checkG31Coverage({ files: fixture });
  assert.ok(findings.some((finding: any) => finding.includes('tier:') && finding.includes('missing expected')));
});
test('G31.2: shipped tier criteria keys follow model dispatch order', () => {
  assert.deepEqual(checkG31TierKeys({ files: shipped }), []);
});
test('G31.2 control: identifies a renamed tier criterion key', () => {
  const fixture: any = new Map(shipped);
  const advice = JSON.parse(fixture.get('core/registry/advice.json'));
  advice.kinds.find((kind: any) => kind.id === 'tier').criteria.lightweight = advice.kinds.find((kind: any) => kind.id === 'tier').criteria.light;
  delete advice.kinds.find((kind: any) => kind.id === 'tier').criteria.light;
  fixture.set('core/registry/advice.json', JSON.stringify(advice, null, 2));
  const findings = checkG31TierKeys({ files: fixture });
  assert.ok(findings.some((finding: any) => finding.includes('light')));
});
test('G31.3: shipped tier criteria match the guidance Work cells verbatim', () => {
  assert.deepEqual(checkG31TierText({ files: shipped }), []);
});
test('G31.3 control: reads Work by header even when another column follows it', () => {
  const fixture: any = new Map(shipped);
  const guidancePath = 'core/shared/guidance/references/MODEL_SELECTION.md';
  const guidance = fixture.get(guidancePath)
    .replace('| Tier | Work |', '| Tier | Work | Note |')
    .replace('| `light` | Verbatim extraction, classification, mechanical or high-volume work. |', '| `light` | Verbatim extraction, classification, mechanical or high-volume work. | unused |')
    .replace('| `standard` | Normal coding, debugging, writing, analysis, routine research, and evidence gathering. |', '| `standard` | Normal coding, debugging, writing, analysis, routine research, and evidence gathering. | unused |')
    .replace('| `frontier` | Architecture, hard debugging, broad refactors, consequential decisions, and every review. |', '| `frontier` | Architecture, hard debugging, broad refactors, consequential decisions, and every review. | unused |');
  fixture.set(guidancePath, guidance);
  assert.deepEqual(checkG31TierText({ files: fixture }), []);
});
test('G31.3 control: names tier and both differing texts', () => {
  const fixture: any = new Map(shipped);
  const advice = JSON.parse(fixture.get('core/registry/advice.json'));
  advice.kinds.find((kind: any) => kind.id === 'tier').criteria.standard = 'edited text';
  fixture.set('core/registry/advice.json', JSON.stringify(advice, null, 2));
  const findings = checkG31TierText({ files: fixture });
  assert.ok(findings.some((finding: any) => finding.includes('standard') && finding.includes('edited text') && finding.includes('Normal coding')));
});
test('G31.4: every registered advice kind has a runtime ask or a skill call site with an outcome line', () => {
  assert.deepEqual(checkG31CallSites({ files: shipped, docs: skillDocs }), []);
});
{
  const REFERENCE = 'core/shared/skills/do/references/advice_calls.md';
  const mutate = (file: string, edit: (text: string) => string) => {
    const docs: any = new Map(skillDocs);
    const before = docs.get(file);
    docs.set(file, edit(before));
    assert.notEqual(docs.get(file), before, `fixture anchor moved in ${file}`);
    return checkG31CallSites({ files: shipped, docs });
  };
  const names = (findings: any, kind: string) => findings.some((finding: any) => finding.startsWith(`${kind}:`));

  test('G31.4 control: a deleted call site, or a deleted outcome line, names the kind', () => {
    assert.ok(names(mutate(REFERENCE, (t) => t.replace('advise --kind mcp-need', 'advise --kind gone')), 'mcp-need'));
    assert.ok(names(mutate('core/shared/skills/do-test/SKILL.md', (t) => t.replace('advise --action outcome', 'advise --action noted')), 'verify-risk'));
  });
  test('G31.4 control: a commented-out call site fails (shell comment, HTML comment)', () => {
    assert.ok(names(mutate(REFERENCE, (t) => t.replace('"$DOFLOW" advise --kind mcp-need', '# "$DOFLOW" advise --kind mcp-need')), 'mcp-need'));
    assert.ok(names(mutate(REFERENCE, (t) => t.replace(/```bash\n("\$DOFLOW" advise --kind mcp-need[^]*?```)/, '<!-- ```bash\n$1 -->')), 'mcp-need'));
    assert.ok(names(mutate(REFERENCE, (t) => t.replace(/("\$DOFLOW" advise --action outcome[^\n]*yes\|no[^\n]*)/, '# $1')), 'mcp-need'));
  });
  test('G31.4 control: a call in prose outside a bash fence fails', () => {
    assert.ok(names(mutate(REFERENCE, (t) => t.replace(/```bash\n("\$DOFLOW" advise --kind mcp-need)/, 'Run $1')), 'mcp-need'));
    assert.ok(names(mutate(REFERENCE, (t) => t.replaceAll('```bash', '```text')), 'tier'));
  });
  test('G31.4 control: a kind with an empty askedBy needs no call site, and one with a caller does', () => {
    const files: any = new Map(shipped);
    const advice = JSON.parse(files.get('core/registry/advice.json'));
    const offline = advice.kinds.find((kind: any) => kind.id === 'rerank');
    assert.deepEqual(offline.askedBy, []);
    assert.equal(names(checkG31CallSites({ files, docs: skillDocs }), 'rerank'), false);
    offline.askedBy = ['retrieve'];
    files.set('core/registry/advice.json', JSON.stringify(advice));
    assert.ok(names(checkG31CallSites({ files, docs: skillDocs }), 'rerank'), 'a named caller with no call site is reported');
  });
  test('G31.4 control: a runtime-asked kind is named when its call or its outcome record is gone or commented out', () => {
    const classifier = 'src/runtime/task-classifier.ts';
    assert.ok(names(mutate(classifier, (t) => t.replace(/\b(client\.ask|interceptDecisionPoint)\(/g, '// $1(')), 'task-class'));
    // No shipped runtime kind records an outcome now (O-6), so the outcome check is exercised with a stand-in pattern that
    // the classifier source does match, then restored.
    const entry = RUNTIME_ASKED['task-class'];
    entry.outcome = /\bsecondOpinion\(/;
    try {
      assert.deepEqual(checkG31CallSites({ files: shipped, docs: skillDocs }), []);
      const findings = mutate(classifier, (t) => t.replace(/\bsecondOpinion\(/g, '// secondOpinion('));
      assert.ok(findings.some((finding: any) => /^task-class: .* no longer records its outcome/.test(finding)), JSON.stringify(findings));
    } finally { entry.outcome = null; }
    const review = 'src/runtime/review/start.ts';
    assert.ok(names(mutate(review, (t) => t.replace(/\b(client\.ask|interceptDecisionPoint)\(/g, '/* $1( */')), 'review-depth'));
    assert.ok(names(mutate(review, (t) => t.replaceAll("'review-depth'", "/* 'review-depth' */")), 'review-depth'));
  });
}

module.exports = {
  checkG30Hooks, checkG30Dependencies, checkG30Requires, checkG30ProviderRoutes,
  checkG31Coverage, checkG31TierKeys, checkG31TierText, checkG31CallSites,
};

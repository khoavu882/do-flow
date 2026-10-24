'use strict';

// G30 — decision-model advice cannot leak into hooks, dependencies or unsafe runtime modules.
// G31 — advice corpus and tier criteria remain synchronized with their source registries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { adviceCoverage } = require('../../bench/advice.ts');

function entries(files) {
  return files instanceof Map ? [...files.entries()] : Object.entries(files || {});
}

function getFile(files, file) {
  return files instanceof Map ? files.get(file) : files?.[file];
}

function parseJsonFile(files, file, findings) {
  try { return JSON.parse(getFile(files, file)); }
  catch (error) {
    findings.push(`${file}:1 invalid JSON (${error.message})`);
    return null;
  }
}

function pathLines(files, predicate) {
  const result = [];
  for (const [file, text] of entries(files)) {
    if (!predicate(file)) continue;
    text.split('\n').forEach((line, index) => result.push({ file, line: index + 1, text: line }));
  }
  return result;
}

function checkG30Hooks({ files }) {
  const findings = [];
  for (const hit of pathLines(files, (file) => /^core\/harnesses\/(?:[^/]+\/)*hooks\//.test(file))) {
    if (/\badvise\b|runtime\/advice|--request/.test(hit.text)) {
      findings.push(`${hit.file}:${hit.line} contains an advice dispatch token`);
    }
  }
  return findings;
}

function checkG30Dependencies({ files }) {
  const file = 'package.json';
  const text = getFile(files, file);
  if (text === undefined) return [`${file}:1 package.json is required for G30.2`];
  const findings = [];
  const manifest = parseJsonFile(files, file, findings);
  if (!manifest) return findings;
  for (const key of ['dependencies', 'optionalDependencies']) {
    if (!Object.hasOwn(manifest, key)) continue;
    const value = manifest[key];
    const hasEntries = Array.isArray(value) ? value.length > 0
      : value && typeof value === 'object' ? Object.keys(value).length > 0
        : Boolean(value);
    if (!hasEntries) continue;
    const line = text.split('\n').findIndex((entry) => new RegExp(`^\\s*"${key}"\\s*:`).test(entry)) + 1;
    findings.push(`${file}:${line || 1} nonempty ${key} are not permitted`);
  }
  return findings;
}

function checkG30Requires({ files }) {
  const findings = [];
  const requirePattern = /require\s*\(\s*(['"])(?:node:)?(http|https|dns|net|child_process)\1\s*\)/g;
  for (const hit of pathLines(files, (file) => file.startsWith('src/runtime/advice/'))) {
    for (const match of hit.text.matchAll(requirePattern)) {
      const moduleName = match[2];
      const base = hit.file.slice('src/runtime/advice/'.length);
      const provider = /^providers\/[^/]+\.(?:js|ts)$/.test(base);
      let allowed = true;
      if (['net', 'child_process'].includes(moduleName)) allowed = false;
      else if (['record', 'config'].includes(base.replace(/\.(?:js|ts)$/, ''))) allowed = false;
      else if (['http', 'https'].includes(moduleName)) allowed = base.replace(/\.(?:js|ts)$/, '') === 'client' || provider;
      else if (moduleName === 'dns') allowed = base.replace(/\.(?:js|ts)$/, '') === 'endpoint-guard';
      if (!allowed) findings.push(`${hit.file}:${hit.line} require('${match[0].includes('node:') ? 'node:' : ''}${moduleName}') is not permitted here`);
    }
  }
  return findings;
}

function checkG30ProviderRoutes({ files }) {
  const findings = [];
  const forbidden = /\/api\/(?:pull|push|create|copy|delete)|ollama serve/;
  for (const hit of pathLines(files, (file) => file.startsWith('src/runtime/advice/providers/'))) {
    if (forbidden.test(hit.text)) findings.push(`${hit.file}:${hit.line} contains a provider write route or server start`);
  }
  return findings;
}

function adviceInputs(files, findings) {
  const registry = parseJsonFile(files, 'core/registry/advice.json', findings);
  const sources = {};
  for (const [name, file] of Object.entries({
    workflows: 'core/registry/workflows.json',
    verification: 'core/registry/verification.json',
    mcp: 'core/registry/mcp.json',
  })) sources[name] = parseJsonFile(files, file, findings);
  const corpus = {};
  for (const [file, text] of entries(files)) {
    const match = file.match(/^bench\/advice\/([^/]+)\.json$/);
    if (match) {
      try { corpus[match[1]] = JSON.parse(text); }
      catch (error) { findings.push(`${file}:1 invalid JSON (${error.message})`); }
    }
  }
  return { registry, sources, corpus };
}

function checkG31Coverage({ files }) {
  const findings = [];
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

function tierContext(files, findings) {
  const advice = parseJsonFile(files, 'core/registry/advice.json', findings);
  const models = parseJsonFile(files, 'core/registry/models.json', findings);
  const kind = advice?.kinds?.find((item) => item.id === 'tier');
  const criteria = kind?.criteria;
  const tiers = models?.dispatchTiers?.tiers;
  if (!criteria || !tiers) findings.push('core/registry/advice.json:1 tier criteria or models dispatch tiers are missing');
  return { criteria, tiers };
}

function checkG31TierKeys({ files }) {
  const findings = [];
  const { criteria, tiers } = tierContext(files, findings);
  if (!criteria || !tiers) return findings;
  const actual = Object.keys(criteria);
  if (JSON.stringify(actual) !== JSON.stringify(tiers)) {
    findings.push(`core/registry/advice.json:1 tier criteria keys [${actual.join(', ')}] do not match models dispatch tiers [${tiers.join(', ')}]`);
  }
  return findings;
}

function checkG31TierText({ files }) {
  const findings = [];
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
  const cellsOf = (line) => line.trim().startsWith('|')
    ? line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()) : [];
  const headerOffset = sectionLines.findIndex((line) => {
    const headers = cellsOf(line).map((cell) => cell.replaceAll('`', ''));
    return headers.includes('Tier') && headers.includes('Work');
  });
  if (headerOffset < 0) return [`${guidancePath}:${sectionStart + 1} capability-tier table lacks Tier or Work column`];
  const headers = cellsOf(sectionLines[headerOffset]).map((cell) => cell.replaceAll('`', ''));
  const tierIndex = headers.indexOf('Tier');
  const workIndex = headers.indexOf('Work');
  const work = {};
  const workLines = {};
  for (let index = headerOffset + 1; index < sectionLines.length; index += 1) {
    const cells = cellsOf(sectionLines[index]);
    const tier = cells[tierIndex]?.replaceAll('`', '');
    if (tiers.includes(tier) && cells[workIndex] !== undefined) {
      work[tier] = cells[workIndex];
      workLines[tier] = sectionStart + index + 2;
    }
  }
  for (const tier of tiers) {
    const expected = work[tier];
    const actual = criteria[tier];
    if (actual !== expected) {
      findings.push(`core/registry/advice.json:1 tier '${tier}' criteria ${JSON.stringify(actual)} does not match ${guidancePath}:${workLines[tier] || sectionStart + 1} Work text ${JSON.stringify(expected)}`);
    }
  }
  return findings;
}

function readTree() {
  const files = new Map();
  function walk(directory) {
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

test('G30.1: shipped hooks contain no advice dispatch surface', () => {
  assert.deepEqual(checkG30Hooks({ files: shipped }), []);
});
test('G30.1 control: names violating hook paths, including nested hooks, and line', () => {
  const findings = checkG30Hooks({ files: new Map([
    ['core/harnesses/demo/hooks/hook.sh', 'safe\ndoflow advise --kind tier\n'],
    ['core/harnesses/demo/sub/hooks/hook.js', "require('runtime/advice/client');\n"],
  ]) });
  assert.ok(findings.some((finding) => finding.includes('core/harnesses/demo/hooks/hook.sh:2')));
  assert.ok(findings.some((finding) => finding.includes('core/harnesses/demo/sub/hooks/hook.js:1')));
});
test('G30.2: shipped package has no runtime dependencies', () => {
  assert.deepEqual(checkG30Dependencies({ files: shipped }), []);
});
test('G30.2 controls: missing manifest and nonempty object/array dependencies fail closed', () => {
  const missing = checkG30Dependencies({ files: new Map() });
  assert.ok(missing.some((finding) => finding.includes('package.json:1')));
  const object = checkG30Dependencies({ files: new Map([['package.json', '{\n  "dependencies": {\n    "sample": "1"\n  }\n}\n']]) });
  assert.ok(object.some((finding) => finding.includes('package.json:2')));
  const array = checkG30Dependencies({ files: new Map([['package.json', '{\n  "optionalDependencies": ["sample"]\n}\n']]) });
  assert.ok(array.some((finding) => finding.includes('package.json:2')));
});
test('G30.3: shipped runtime requires stay within approved boundaries', () => {
  assert.deepEqual(checkG30Requires({ files: shipped }), []);
});
test('G30.3 controls: rejects forbidden record/config placements and permits approved boundaries', () => {
  const fixture = new Map([
    ['src/runtime/advice/record.js', "require('node:net');\n"],
    ['src/runtime/advice/config.js', "require('dns');\n"],
    ['src/runtime/advice/strength.js', "require('https');\n"],
    ['src/runtime/advice/other.js', "require('dns');\n"],
    ['src/runtime/advice/endpoint-guard.js', "require('http');\nrequire('node:dns');\n"],
    ['src/runtime/advice/client.js', "require('node:http');\n"],
    ['src/runtime/advice/providers/example.js', "require('https');\n"],
    ['src/runtime/advice/providers/process.js', "require('node:child_process');\n"],
  ]);
  const findings = checkG30Requires({ files: fixture });
  assert.ok(findings.some((finding) => finding.includes('src/runtime/advice/record.js:1')));
  assert.ok(findings.some((finding) => finding.includes('src/runtime/advice/config.js:1')));
  assert.ok(findings.some((finding) => finding.includes('src/runtime/advice/strength.js:1')));
  assert.ok(findings.some((finding) => finding.includes('src/runtime/advice/other.js:1')));
  assert.ok(findings.some((finding) => finding.includes('src/runtime/advice/endpoint-guard.js:1')));
  assert.ok(findings.some((finding) => finding.includes('src/runtime/advice/providers/process.js:1')));
  assert.equal(findings.length, 6);
});
test('G30.4: shipped providers contain no write routes or server start', () => {
  assert.deepEqual(checkG30ProviderRoutes({ files: shipped }), []);
});
test('G30.4 control: scans nested non-JavaScript provider files too', () => {
  const findings = checkG30ProviderRoutes({ files: new Map([
    ['src/runtime/advice/providers/example.js', "const route = '/api/pull';\n"],
    ['src/runtime/advice/providers/nested/notes.txt', 'ollama serve\n'],
  ]) });
  assert.ok(findings.some((finding) => finding.includes('src/runtime/advice/providers/example.js:1')));
  assert.ok(findings.some((finding) => finding.includes('src/runtime/advice/providers/nested/notes.txt:1')));
});
test('G31.1: shipped advice corpus has complete coverage', () => {
  assert.deepEqual(checkG31Coverage({ files: shipped }), []);
});
test('G31.1 control: names kind and missing coverage item', () => {
  const fixture = new Map(shipped);
  const file = 'bench/advice/tier.json';
  const corpus = JSON.parse(fixture.get(file));
  corpus.cases.pop();
  fixture.set(file, JSON.stringify(corpus));
  const findings = checkG31Coverage({ files: fixture });
  assert.ok(findings.some((finding) => finding.includes('tier:') && finding.includes('missing expected')));
});
test('G31.2: shipped tier criteria keys follow model dispatch order', () => {
  assert.deepEqual(checkG31TierKeys({ files: shipped }), []);
});
test('G31.2 control: identifies a renamed tier criterion key', () => {
  const fixture = new Map(shipped);
  const advice = JSON.parse(fixture.get('core/registry/advice.json'));
  advice.kinds.find((kind) => kind.id === 'tier').criteria.lightweight = advice.kinds.find((kind) => kind.id === 'tier').criteria.light;
  delete advice.kinds.find((kind) => kind.id === 'tier').criteria.light;
  fixture.set('core/registry/advice.json', JSON.stringify(advice, null, 2));
  const findings = checkG31TierKeys({ files: fixture });
  assert.ok(findings.some((finding) => finding.includes('light')));
});
test('G31.3: shipped tier criteria match the guidance Work cells verbatim', () => {
  assert.deepEqual(checkG31TierText({ files: shipped }), []);
});
test('G31.3 control: reads Work by header even when another column follows it', () => {
  const fixture = new Map(shipped);
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
  const fixture = new Map(shipped);
  const advice = JSON.parse(fixture.get('core/registry/advice.json'));
  advice.kinds.find((kind) => kind.id === 'tier').criteria.standard = 'edited text';
  fixture.set('core/registry/advice.json', JSON.stringify(advice, null, 2));
  const findings = checkG31TierText({ files: fixture });
  assert.ok(findings.some((finding) => finding.includes('standard') && finding.includes('edited text') && finding.includes('Normal coding')));
});

module.exports = {
  checkG30Hooks, checkG30Dependencies, checkG30Requires, checkG30ProviderRoutes,
  checkG31Coverage, checkG31TierKeys, checkG31TierText,
};

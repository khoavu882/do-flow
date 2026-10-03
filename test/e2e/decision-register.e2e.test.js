'use strict';
// decision-register.e2e.test.js — feature 044 acceptance scenarios (requirement §6), driven through
// the real dispatcher `doflow-run` (what every harness calls) against scratch git repos. Needs no
// model, no network and no ~/.doflow: HOME is redirected to a scratch directory and every feature
// folder lives in a throwaway repo, so the orchestration journal lands under that repo's .doflow/.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW_RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const { IS_WIN } = require('../helper-platform');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-decision-e2e-'));
const HOME = path.join(SCRATCH, 'home');
fs.mkdirSync(HOME, { recursive: true });
after(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

let repoCounter = 0;

/** A minimal, explicit environment: no inherited DOFLOW_CLI, GIT_* or provider keys (NFR-001). */
function baseEnv() {
  return {
    PATH: process.env.PATH, HOME, USERPROFILE: HOME, TMPDIR: SCRATCH,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

/** A scratch git repo with one commit, on branch feat/<slug>. Returns { repo, slug, dir }. */
function makeRepo(slug = '044-scratch') {
  const repo = path.join(SCRATCH, `repo-${repoCounter++}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, {
      cwd: repo, encoding: 'utf8',
      env: { ...baseEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'initial');
  git('checkout', '-q', '-b', `feat/${slug}`);
  return { repo, slug, dir: path.join(repo, 'agent-docs', 'doflow', slug) };
}

/** Runs doflow-run with cwd = the scratch repo. Parses stdout as JSON when it is. */
function run(repo, args, { input } = {}) {
  const r = spawnSync('bash', [DOFLOW_RUN, ...args], {
    cwd: repo,
    env: { ...baseEnv(), DOFLOW_CONFIG_DIR: path.join(repo, '.doflow') },
    input: input ?? '',
    encoding: 'utf8',
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function decision(repo, args, opts) { return run(repo, ['decision', ...args, '--json'], opts); }

function add(repo, topic, statement, extra = []) {
  return decision(repo, ['--action', 'add', '--topic', topic, '--statement', statement,
    '--channel', 'question', '--stage', 'design', '--rationale', `because ${statement}`, ...extra]);
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function register(dir) { return readJson(path.join(dir, 'decisions', 'register.json')); }
function read(file) { return fs.readFileSync(file, 'utf8'); }

/** Every file under dir as { relativePath: bytes }, for before/after comparison. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}

function writeFiles(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

const SKIP = IS_WIN ? 'doflow-run is a bash script' : false;

test('1. live view keeps only the latest decision on a topic; the archive keeps the replaced one (FR-006, FR-007)', { skip: SKIP }, () => {
  const { repo, slug, dir } = makeRepo();
  const init = decision(repo, ['--action', 'init']);
  assert.strictEqual(init.status, 0, init.stderr);
  assert.strictEqual(init.json.created, true);
  assert.strictEqual(init.json.slug, slug);

  const first = add(repo, 'wire-id', 'Wire carries the UUID');
  assert.strictEqual(first.status, 0, first.stderr);
  assert.deepStrictEqual(first.json.added, [{ id: 'DEC-001', topic: 'wire-id' }]);

  const registerFile = path.join(dir, 'decisions', 'register.json');
  const before = fs.readFileSync(registerFile);
  const conflict = add(repo, 'wire-id', 'Wire carries the numeric key');
  assert.strictEqual(conflict.status, 1);
  assert.strictEqual(conflict.json.finding, 'topic-conflict');
  assert.match(conflict.json.message, /DEC-001/);
  assert.ok(before.equals(fs.readFileSync(registerFile)), 'a topic-conflict must leave the register bytes unchanged');

  const second = add(repo, 'wire-id', 'Wire carries the UUID except the biller key', ['--supersedes', 'DEC-001']);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.deepStrictEqual(second.json.superseded, [{ id: 'DEC-001', by: 'DEC-002' }]);

  const live = read(path.join(dir, 'decisions.md'));
  assert.match(live, /\| DEC-002 \| wire-id \|/);
  assert.doesNotMatch(live, /DEC-001/, 'the replaced decision must not appear in the live view');
  assert.strictEqual((live.match(/^\| DEC-/gm) || []).length, 1);

  const archive = read(path.join(dir, 'decisions', 'archive.md'));
  assert.match(archive, /### DEC-001: wire-id/);
  const block = (id) => archive.split(/^### /m).find((b) => b.startsWith(`${id}:`)) || '';
  assert.match(block('DEC-001'), /^- \*\*Status:\*\* Superseded → DEC-002$/m);
  assert.match(block('DEC-002'), /^- \*\*Status:\*\* Live$/m);
  assert.match(archive, /### DEC-002: wire-id/);
  assert.match(archive, /because Wire carries the UUID\b/, 'the replaced decision keeps its rationale');
});

test('2. manual-prompt and gate decisions are captured as user decisions through one batch (FR-002, FR-003, FR-015)', { skip: SKIP }, () => {
  const { repo, dir } = makeRepo();
  assert.strictEqual(decision(repo, ['--action', 'init']).status, 0);

  const item = (topic, channel, extra = {}) => ({
    topic, statement: `statement for ${topic}`, channel, stage: 'discovery', rationale: `why ${topic}`,
    supersedes: [], refs: ['FR-001'], source: `intention/q.md#${topic}`, ...extra,
  });
  const batchFile = path.join(SCRATCH, 'batch-2.json');
  fs.writeFileSync(batchFile, JSON.stringify([
    item('channels-q', 'question'), item('approval-gate', 'gate'), item('typed-prompt', 'prompt'),
    item('picked-default', 'default'), item('settled-open', 'resolution'),
  ]));
  const res = decision(repo, ['--action', 'add', '--batch', batchFile]);
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.deepStrictEqual(res.json.added.map((a) => a.id), ['DEC-001', 'DEC-002', 'DEC-003', 'DEC-004', 'DEC-005']);

  const by = Object.fromEntries(register(dir).decisions.map((d) => [d.topic, d.decidedBy]));
  assert.deepStrictEqual(by, {
    'channels-q': 'user', 'approval-gate': 'user', 'typed-prompt': 'user',
    'picked-default': 'agent', 'settled-open': 'agent',
  });

  // The stage hands off after its one batch call; every channel's decision is in the register.
  const handoff = run(repo, ['orchestrate', '--action', 'handoff', '--task-id', path.basename(dir), '--task-class', 'feature',
    '--calling-skill', 'do-brainstorm', '--note', 'discovery done', '--json']);
  assert.strictEqual(handoff.status, 0, handoff.stdout + handoff.stderr);
  assert.ok(handoff.json.compaction, 'handoff reports a compaction field');
  const afterHandoff = register(dir).decisions;
  assert.deepStrictEqual(afterHandoff.map((d) => [d.topic, d.channel]).sort(),
    [['approval-gate', 'gate'], ['channels-q', 'question'], ['picked-default', 'default'], ['settled-open', 'resolution'], ['typed-prompt', 'prompt']]);
  assert.ok(afterHandoff.every((d) => d.status === 'live'));

  // Same contract from stdin (`--batch -`).
  const stdinBatch = JSON.stringify([item('from-stdin', 'prompt')]);
  const viaStdin = decision(repo, ['--action', 'add', '--batch', '-'], { input: stdinBatch });
  assert.strictEqual(viaStdin.status, 0, viaStdin.stdout + viaStdin.stderr);
  assert.deepStrictEqual(viaStdin.json.added, [{ id: 'DEC-006', topic: 'from-stdin' }]);
  assert.strictEqual(register(dir).decisions.find((d) => d.topic === 'from-stdin').decidedBy, 'user');

  // An invalid item refuses the whole batch and writes nothing (exit 2).
  const bytes = fs.readFileSync(path.join(dir, 'decisions', 'register.json'));
  const bad = decision(repo, ['--action', 'add', '--batch', '-'], {
    input: JSON.stringify([item('good-one', 'prompt'), item('bad-one', 'nonsense')]),
  });
  assert.strictEqual(bad.status, 2);
  assert.ok(bytes.equals(fs.readFileSync(path.join(dir, 'decisions', 'register.json'))), 'a refused batch must write nothing');
});

test('3. identifiers never collide across several adds and supersessions (FR-004)', { skip: SKIP }, () => {
  const { repo, dir } = makeRepo();
  assert.strictEqual(decision(repo, ['--action', 'init']).status, 0);
  for (const t of ['alpha', 'beta', 'gamma']) assert.strictEqual(add(repo, t, `first ${t}`).status, 0);
  assert.strictEqual(add(repo, 'alpha', 'second alpha', ['--supersedes', 'DEC-001']).status, 0);
  assert.strictEqual(add(repo, 'beta', 'second beta', ['--supersedes', 'DEC-002']).status, 0);
  assert.strictEqual(add(repo, 'alpha', 'third alpha', ['--supersedes', 'DEC-004']).status, 0);
  assert.strictEqual(add(repo, 'delta', 'merges two', ['--supersedes', 'DEC-003,DEC-005']).status, 0);

  const ids = register(dir).decisions.map((d) => d.id);
  const expected = Array.from({ length: ids.length }, (_, i) => `DEC-${String(i + 1).padStart(3, '0')}`);
  assert.strictEqual(ids.length, 7);
  assert.deepStrictEqual(ids, expected, 'register ids are unique and sequential');

  const archiveIds = [...read(path.join(dir, 'decisions', 'archive.md')).matchAll(/^### (DEC-\d+):/gm)].map((m) => m[1]);
  assert.deepStrictEqual(archiveIds, expected, 'archive holds every decision once, in id order');

  const liveIds = [...read(path.join(dir, 'decisions.md')).matchAll(/^\| (DEC-\d+) \|/gm)].map((m) => m[1]);
  assert.strictEqual(new Set(liveIds).size, liveIds.length, 'live ids are unique');
  assert.deepStrictEqual(liveIds.sort(), register(dir).decisions.filter((d) => d.status === 'live').map((d) => d.id).sort());
  assert.ok(liveIds.every((id) => expected.includes(id)));
  assert.strictEqual(register(dir).nextId, 8);
});

test('4. a stale artifact line is flagged; a line citing the whole chain is not (FR-009, FR-011)', { skip: SKIP }, () => {
  const { repo, dir } = makeRepo();
  assert.strictEqual(decision(repo, ['--action', 'init']).status, 0);
  writeFiles(dir, {
    'intention/requirement.md': '# Requirement\n\n## 1. Overview\n\nScope text.\n\n## 9. History\n\nNone — initial version.\n',
    'design/design.md': [
      '# Design', '', '## 1. Overview', '',
      'The wire follows DEC-001 here.',
      'The wire follows DEC-001 and was replaced by DEC-002.',
      'The wire follows DEC-002 here.', '',
      '## 9. History', '', 'None — initial version.', '',
    ].join('\n'),
  });
  assert.strictEqual(add(repo, 'wire', 'old wire').json.added[0].id, 'DEC-001');
  assert.strictEqual(add(repo, 'wire', 'new wire', ['--supersedes', 'DEC-001']).json.added[0].id, 'DEC-002');

  const res = run(repo, ['validate', '--json']);
  assert.strictEqual(res.status, 1, res.stdout + res.stderr);
  const stale = res.json.findings.filter((f) => f.rule === 'stale');
  assert.deepStrictEqual(stale.map((f) => [path.basename(f.file), f.id, f.message]),
    [['design.md', 'DEC-001', 'line 5 cites DEC-001, superseded by DEC-002']]);
  assert.strictEqual(res.json.findings.length, 1, 'no other finding: the both-cited and live-cited lines are clean');
});

const HISTORY_ARTIFACTS = {
  'intention/requirement.md': ['requirement.md', '## 9. History', ['- 2026-10-01 widened scope', '- 2026-10-02 dropped US7']],
  'design/design.md': ['design.md', '## 9. History', ['- 2026-10-01 swapped store', '- 2026-10-02 renamed flow']],
  'design/specs.md': ['specs.md', '## 2. History', ['- **IC-001** — superseded by IC-002 on 2026-10-01', '- 2026-10-02 reworded IC-002']],
  'design/data-model.md': ['data-model.md', '## 3. History', ['- 2026-10-01 split the entity']],
  'plan.md': ['plan.md', '## 9. History', ['- 2026-10-01 reordered phase B', '- 2026-10-02 added task C.4']],
};

function historyArtifacts() {
  const files = {};
  for (const [rel, [, heading, lines]] of Object.entries(HISTORY_ARTIFACTS)) {
    const body = ['# Artifact', '', '## 1. Content', ''];
    if (rel === 'design/specs.md') {
      body.push('| ID | Contract | Status |', '|---|---|---|', '| IC-001 | old | Superseded -> IC-002 |', '| IC-002 | new | Live |', '',
        '**Detail**', '', '- **IC-001:** old.', '- **IC-002:** new.', '');
    } else {
      body.push('Body line that must stay.', '');
    }
    body.push(heading, '', '<!-- keep this comment -->', '', ...lines, '');
    files[rel] = body.join('\n');
  }
  return files;
}

test('5. compaction is lossless and idempotent (FR-012, FR-014, NFR-004)', { skip: SKIP }, () => {
  const { repo, dir } = makeRepo();
  assert.strictEqual(decision(repo, ['--action', 'init']).status, 0);
  const files = historyArtifacts();
  writeFiles(dir, files);
  assert.strictEqual(add(repo, 'anything', 'first take').status, 0);
  assert.strictEqual(add(repo, 'anything', 'second take', ['--supersedes', 'DEC-001']).status, 0);

  const outside = {};
  for (const rel of Object.keys(files)) outside[rel] = files[rel].slice(0, files[rel].indexOf(HISTORY_ARTIFACTS[rel][1]));

  const first = decision(repo, ['--action', 'compact']);
  assert.strictEqual(first.status, 0, first.stdout + first.stderr);
  assert.strictEqual(first.json.status, 'compacted');
  assert.deepStrictEqual(first.json.moved.map((m) => m.artifact).sort(),
    ['data-model.md', 'design.md', 'plan.md', 'requirement.md', 'specs.md']);

  for (const [rel, [name, heading, lines]] of Object.entries(HISTORY_ARTIFACTS)) {
    const archive = read(path.join(dir, 'decisions', 'history', name));
    for (const line of lines) assert.ok(archive.includes(line), `${name}: moved line missing from archive: ${line}`);
    const after = read(path.join(dir, rel));
    for (const line of lines) assert.ok(!after.split('\n').includes(line), `${rel}: line still in the artifact: ${line}`);
    const section = after.slice(after.indexOf(heading));
    const link = path.relative(path.dirname(path.join(dir, rel)), path.join(dir, 'decisions', 'history', name)).split(path.sep).join('/');
    assert.ok(section.split('\n').includes(`Earlier entries: [decisions/history/${name}](${link}).`), `${rel}: pointer line with link ${link}`);
    assert.ok(section.includes('<!-- keep this comment -->'), `${rel}: the comment stays`);
    assert.ok(after.startsWith(outside[rel]), `${rel}: content before History is untouched`);
  }
  assert.ok(read(path.join(dir, 'design', 'specs.md')).includes('| IC-001 | old | Superseded -> IC-002 |'), 'index tombstone row untouched');

  const archivesAfterFirst = snapshot(path.join(dir, 'decisions'));
  const artifactsAfterFirst = Object.keys(files).map((rel) => read(path.join(dir, rel)));
  const second = decision(repo, ['--action', 'compact']);
  assert.strictEqual(second.status, 0, second.stdout + second.stderr);
  assert.strictEqual(second.json.status, 'unchanged');
  assert.deepStrictEqual(second.json.moved, []);
  assert.deepStrictEqual(snapshot(path.join(dir, 'decisions')), archivesAfterFirst, 'a second run changes no archive');
  assert.deepStrictEqual(Object.keys(files).map((rel) => read(path.join(dir, rel))), artifactsAfterFirst, 'a second run changes no artifact');

  const archiveMd = read(path.join(dir, 'decisions', 'archive.md'));
  assert.match(archiveMd, /^### DEC-001: anything$/m, 'the superseded id is still in the archive after compaction');
  assert.match(archiveMd, /Superseded → DEC-002/);

  const validate = run(repo, ['validate', '--json']);
  assert.ok(validate.json, `validate must emit JSON: ${validate.stdout}${validate.stderr}`);
  assert.strictEqual(validate.status, 0, validate.stdout + validate.stderr);
  assert.ok(Array.isArray(validate.json.findings) || validate.json.ok === true, validate.stdout);
  const bad = (validate.json.findings || []).filter((f) => f.rule === 'history' || f.rule === 'stale');
  assert.deepStrictEqual(bad, [], `no history or stale finding after compaction: ${validate.stdout}`);
});

test('6. compaction runs at handoff for a feature slug and is skipped for a plan task id (FR-013, IC-013)', { skip: SKIP }, () => {
  const { repo, slug, dir } = makeRepo();
  assert.strictEqual(decision(repo, ['--action', 'init']).status, 0);
  writeFiles(dir, {
    'intention/requirement.md': '# Requirement\n\n## 1. Overview\n\nText.\n\n## 9. History\n\n<!-- kept -->\n\n- 2026-10-01 first revision\n- 2026-10-02 second revision\n',
  });
  assert.strictEqual(add(repo, 'scope', 'narrow scope').json.added[0].id, 'DEC-001');
  assert.strictEqual(add(repo, 'scope', 'wide scope', ['--supersedes', 'DEC-001']).status, 0);

  const handoff = (taskId) => run(repo, ['orchestrate', '--action', 'handoff', '--task-id', taskId, '--task-class', 'feature',
    '--calling-skill', 'do-brainstorm', '--note', 'discovery done', '--json']);

  const real = handoff(slug);
  assert.strictEqual(real.status, 0, real.stdout + real.stderr);
  assert.strictEqual(real.json.disposition, 'completed');
  assert.strictEqual(real.json.compaction.status, 'compacted');
  assert.deepStrictEqual(real.json.compaction.moved.map((m) => [m.artifact, m.lines]), [['requirement.md', 2]]);
  assert.ok(read(path.join(dir, 'decisions', 'history', 'requirement.md')).includes('- 2026-10-02 second revision'));
  const liveView = read(path.join(dir, 'decisions.md'));
  assert.doesNotMatch(liveView, /DEC-001|narrow scope/, 'the superseded decision is absent from the live view at handoff');
  assert.match(liveView, /\| DEC-002 \| scope \| wide scope \|/);
  const hist = read(path.join(dir, 'intention', 'requirement.md'));
  const histBody = hist.slice(hist.indexOf('## 9. History')).split('\n').slice(1).filter((l) => l.trim() !== '');
  assert.deepStrictEqual(histBody, ['<!-- kept -->', 'Earlier entries: [decisions/history/requirement.md](../decisions/history/requirement.md).'],
    'History holds only the comment and the pointer line');
  assert.ok(fs.existsSync(path.join(repo, '.doflow', 'state')), 'the journal lands under the scratch repo');

  const planTask = handoff('B.1');
  assert.strictEqual(planTask.status, 0, planTask.stdout + planTask.stderr);
  assert.strictEqual(planTask.json.compaction.status, 'skipped');
  assert.match(planTask.json.compaction.reason, /B\.1/);
});

test('7. the context pack carries live decisions only (US2, IC-012)', { skip: SKIP }, () => {
  const { repo, slug } = makeRepo();
  assert.strictEqual(decision(repo, ['--action', 'init']).status, 0);
  assert.strictEqual(add(repo, 'store', 'use sqlite').status, 0);
  assert.strictEqual(add(repo, 'queue', 'use a queue').status, 0);
  assert.strictEqual(add(repo, 'store', 'use postgres', ['--supersedes', 'DEC-001']).status, 0);

  const pack = run(repo, ['context-pack', '--task-id', slug, '--json']);
  assert.strictEqual(pack.status, 0, pack.stdout + pack.stderr);
  assert.strictEqual(pack.json.decisions.available, true);
  assert.deepStrictEqual(pack.json.decisions.live.map((d) => d.id).sort(), ['DEC-002', 'DEC-003']);
  assert.strictEqual(pack.json.decisions.liveCount, 2);
  assert.deepStrictEqual(pack.json.decisions.live.find((d) => d.id === 'DEC-003'),
    { id: 'DEC-003', topic: 'store', statement: 'use postgres', decidedBy: 'user', stage: 'design' });

  // A plan task id still finds the feature's decisions through the branch.
  const viaPlanId = run(repo, ['context-pack', '--task-id', 'B.1', '--json']);
  assert.strictEqual(viaPlanId.json.decisions.liveCount, 2);
});

test('8. existing features are untouched (FR-016)', { skip: SKIP }, () => {
  const layouts = {
    legacy: { 'requirement.md': '# Requirement\n\n## 1. Overview\n\nOld flat feature.\n\n## 9. History\n\n- 2026-09-01 an entry\n' },
    structured: { 'intention/requirement.md': '# Requirement\n\n## 1. Overview\n\nOld structured feature.\n\n## 9. History\n\n- 2026-09-01 an entry\n' },
  };
  for (const [layout, files] of Object.entries(layouts)) {
    const { repo, slug, dir } = makeRepo(`012-${layout}`);
    writeFiles(dir, files);
    const before = snapshot(dir);

    const init = decision(repo, ['--action', 'init']);
    assert.strictEqual(init.status, 1, `${layout}: ${init.stdout}${init.stderr}`);
    assert.strictEqual(init.json.finding, 'predates-register');

    for (const action of ['add', 'list', 'compact']) {
      const args = ['--action', action];
      if (action === 'add') args.push('--topic', 't', '--statement', 's', '--channel', 'question', '--stage', 'design', '--rationale', 'r');
      const res = decision(repo, args);
      assert.strictEqual(res.status, 1, `${layout} ${action}: ${res.stdout}${res.stderr}`);
      assert.strictEqual(res.json.finding, 'no-register', `${layout} ${action}`);
    }

    const handoff = run(repo, ['orchestrate', '--action', 'handoff', '--task-id', slug, '--task-class', 'feature',
      '--calling-skill', 'do-brainstorm', '--note', 'done', '--json']);
    assert.strictEqual(handoff.status, 0, `${layout}: ${handoff.stdout}${handoff.stderr}`);
    assert.strictEqual(handoff.json.compaction.status, 'skipped', layout);

    const validated = run(repo, ['validate', '--json']);
    assert.ok([0, 1].includes(validated.status), `${layout} validate: ${validated.stdout}${validated.stderr}`);
    const pack = run(repo, ['context-pack', '--task-id', slug, '--json']);
    // An empty pack exits 1 by the CLI's existing `empty` contract; a legacy folder holds no decisions to change that.
    assert.ok(pack.json, `${layout} context-pack: ${pack.stdout}${pack.stderr}`);
    assert.strictEqual(pack.status, pack.json.empty ? 1 : 0, `${layout} context-pack exit follows empty`);
    assert.strictEqual(pack.json.decisions.available, false, layout);
    assert.deepStrictEqual(pack.json.decisions.live, []);

    assert.deepStrictEqual(snapshot(dir), before, `${layout}: file listing and bytes identical before and after`);
    assert.ok(!fs.existsSync(path.join(dir, 'decisions')) && !fs.existsSync(path.join(dir, 'decisions.md')), `${layout}: no register files appear`);
  }
});

test('9. fifty supersessions on one topic leave exactly one live row (NFR-003)', { skip: SKIP }, () => {
  const { repo, dir } = makeRepo();
  assert.strictEqual(decision(repo, ['--action', 'init']).status, 0);
  assert.strictEqual(add(repo, 'only-topic', 'version 0').status, 0);
  for (let i = 1; i <= 50; i++) {
    const res = add(repo, 'only-topic', `version ${i}`, ['--supersedes', `DEC-${String(i).padStart(3, '0')}`]);
    assert.strictEqual(res.status, 0, `supersession ${i}: ${res.stdout}${res.stderr}`);
  }
  const live = read(path.join(dir, 'decisions.md'));
  assert.strictEqual((live.match(/^\| DEC-/gm) || []).length, 1, 'exactly one live row');
  assert.match(live, /\| DEC-051 \| only-topic \| version 50 \|/);
  assert.strictEqual(register(dir).decisions.length, 51);
  assert.strictEqual(register(dir).decisions.filter((d) => d.status === 'live').length, 1);
  assert.strictEqual((read(path.join(dir, 'decisions', 'archive.md')).match(/^### DEC-/gm) || []).length, 51, 'nothing is lost to the archive');
});

test('10. the active stage fixes only its own flagged line (FR-010)', { skip: SKIP }, () => {
  const { repo, dir } = makeRepo();
  assert.strictEqual(decision(repo, ['--action', 'init']).status, 0);
  const design = ['# Design', '', '## 1. Overview', '', 'Shared line stays.', 'The store follows DEC-001 here.', 'Another untouched line.', '',
    '## 9. History', '', 'None — initial version.', ''].join('\n');
  const plan = ['# Plan', '', '## 1. Basis', '', 'The tasks rest on DEC-001.', '', '## 9. History', '', 'None — initial version.', ''].join('\n');
  writeFiles(dir, {
    'intention/requirement.md': '# Requirement\n\n## 1. Overview\n\nText.\n\n## 9. History\n\nNone — initial version.\n',
    'design/design.md': design, 'plan.md': plan,
  });
  assert.strictEqual(add(repo, 'store', 'sqlite').json.added[0].id, 'DEC-001');
  assert.strictEqual(add(repo, 'store', 'postgres', ['--supersedes', 'DEC-001']).json.added[0].id, 'DEC-002');

  const first = run(repo, ['validate', '--json']);
  assert.strictEqual(first.status, 1, first.stdout + first.stderr);
  const stale = first.json.findings.filter((f) => f.rule === 'stale');
  assert.deepStrictEqual(stale.map((f) => [path.basename(f.file), f.id]), [['design.md', 'DEC-001'], ['plan.md', 'DEC-001']]);

  // The design stage owns design.md only: correct the flagged line by its reported number.
  const designFinding = stale.find((f) => path.basename(f.file) === 'design.md');
  const lineNo = Number(/^line (\d+) /.exec(designFinding.message)[1]);
  const lines = design.split('\n');
  assert.ok(lines[lineNo - 1].includes('DEC-001'));
  const fixedLines = [...lines];
  fixedLines[lineNo - 1] = lines[lineNo - 1].replace('DEC-001', 'DEC-002');
  fs.writeFileSync(path.join(dir, 'design', 'design.md'), fixedLines.join('\n'));

  const second = run(repo, ['validate', '--json']);
  assert.strictEqual(second.status, 1, second.stdout + second.stderr);
  assert.deepStrictEqual(second.json.findings.map((f) => [path.basename(f.file), f.rule, f.id]), [['plan.md', 'stale', 'DEC-001']],
    'design.md is clean; the plan-owned finding is still reported, not edited');

  const after = read(path.join(dir, 'design', 'design.md')).split('\n');
  assert.strictEqual(after.length, lines.length);
  after.forEach((l, i) => { if (i !== lineNo - 1) assert.strictEqual(l, lines[i], `design.md line ${i + 1} unchanged`); });
  assert.strictEqual(read(path.join(dir, 'plan.md')), plan, 'plan.md bytes unchanged');
});

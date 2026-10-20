'use strict';

/**
 * Feature 097 B.2 (IC-006, IC-007): the grader over committed run-directory fixtures
 * (test/fixtures/agentic/runs, hand-built, see its README.txt). Offline and pure: no harness, no
 * network. The config under test is the real bench/agentic/config.json so a leak regex that stops
 * matching its own targets fails here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractAnswer, classifyIsolation, gradeRun, gradeIteration, loadPathInfo, serializeGrading, parseTranscript,
} = require('../../bench/agentic/grade.js');
const { loadTaskSet } = require('../../bench/agentic/tasks.js');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'agentic', 'runs');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'agentic', 'config.json'), 'utf8'));
const taskSet = loadTaskSet();
const pathInfo = loadPathInfo();
const byId = (id) => taskSet.tasks.find((t) => t.id === id);
const DC011 = byId('DC-011');

/** DC-011 plus a second relevant file, so a partial answer has a fraction to score (every real task has one). */
const TWO_QREL = {
  ...DC011,
  qrels: [...DC011.qrels, { id: 'q2', path: 'src/state/run-lock.ts', startLine: 1, endLine: 2, rel: 1 }],
};

/** scenario -> { task, arm }: the folder does not say which task or arm it is graded as. */
const SCENARIO = {
  'full-answer': { task: DC011, arm: 'N' },
  'partial-answer': { task: TWO_QREL, arm: 'N' },
  'no-answer': { task: DC011, arm: 'N' },
  timeout: { task: DC011, arm: 'N' },
  'api-error': { task: DC011, arm: 'N' },
  silent: { task: DC011, arm: 'N' },
  'empty-transcript': { task: DC011, arm: 'N' },
  'leak-doflow-retrieve': { task: DC011, arm: 'N' },
  'leak-doflow-run-retrieve': { task: DC011, arm: 'N' },
  'leak-node-doflow-retrieve': { task: DC011, arm: 'N' },
  'clean-rg-retrieve-src': { task: DC011, arm: 'N' },
  'clean-rg-doflow-retrieve-docs': { task: DC011, arm: 'N' },
  'mcp-call': { task: DC011, arm: 'N' },
  'arm-d-two-retrieves': { task: DC011, arm: 'D' },
  'twelve-files': { task: DC011, arm: 'N' },
};

function grade(name, over = {}) {
  const s = SCENARIO[name];
  return gradeRun({ runDir: path.join(FIXTURES, name), task: s.task, arm: s.arm, config, pathInfo, ...over });
}

// ---------------------------------------------------------------------------
// Scoring

test('a clean full answer scores 1.0', () => {
  const g = grade('full-answer');
  assert.equal(g.pass_rate, 1);
  assert.deepEqual(g.metrics, { fileRecallAt10: 1 });
  assert.equal(g.infra, null);
  assert.equal(g.isolation, 'clean');
  assert.deepEqual(g.isolationEvidence, []);
  assert.equal(g.run_status, 'completed');
  assert.deepEqual(g.answer, { files: ['test/helper/tmp.js', 'test/helper/fs.js'] });
  assert.equal(g.key, DC011.key);
  assert.equal(g.id, 'DC-011');
  assert.equal(g.split, 'train');
  assert.equal(g.kind, 'conceptual-discovery');
  assert.equal(g.arm, 'N');
});

test('a partial answer scores the expected fraction (1 of 2 relevant files), fenced JSON tolerated', () => {
  const g = grade('partial-answer');
  assert.equal(g.pass_rate, 0.5);
  assert.deepEqual(g.metrics, { fileRecallAt10: 0.5 });
});

test('no answer from a completed run with output scores 0, answer null', () => {
  const g = grade('no-answer');
  assert.equal(g.infra, null);
  assert.equal(g.pass_rate, 0);
  assert.deepEqual(g.metrics, { fileRecallAt10: 0 });
  assert.equal(g.answer, null);
});

test('only the first 10 paths count: the relevant file at position 11 scores 0', () => {
  const g = grade('twelve-files');
  assert.equal(g.answer.files.length, 10);
  assert.equal(g.answer.files.includes('test/helper/tmp.js'), false);
  assert.equal(g.pass_rate, 0);
});

// ---------------------------------------------------------------------------
// Infra exclusion (096 classes)

test('timeout, api-error and silent runs are excluded with their 096 class and a null pass rate', () => {
  for (const [name, infra, status] of [['timeout', 'timeout', 'timeout'], ['api-error', 'api-error', 'api-error'], ['silent', 'no-output', 'completed']]) {
    const g = grade(name);
    assert.equal(g.infra, infra, name);
    assert.equal(g.run_status, status, name);
    assert.equal(g.pass_rate, null, `${name} must be null, never 0`);
    assert.deepEqual(g.metrics, { fileRecallAt10: null }, name);
  }
});

test('a missing run_status.json is status absent: output makes it a run, no output makes it no-output', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-grade-'));
  try {
    for (const f of ['transcript.jsonl', 'last-message.txt']) fs.copyFileSync(path.join(FIXTURES, 'full-answer', f), path.join(tmp, f));
    const withOutput = gradeRun({ runDir: tmp, task: DC011, arm: 'N', config, pathInfo });
    assert.equal(withOutput.run_status, 'absent');
    assert.equal(withOutput.infra, null);
    assert.equal(withOutput.pass_rate, 1);
    fs.writeFileSync(path.join(tmp, 'transcript.jsonl'), '');
    fs.writeFileSync(path.join(tmp, 'last-message.txt'), '');
    const none = gradeRun({ runDir: tmp, task: DC011, arm: 'N', config, pathInfo });
    assert.equal(none.infra, 'no-output');
    assert.equal(none.pass_rate, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an unreadable run_status.json is malformed and excluded; a truncated status keeps its class', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-grade-'));
  try {
    for (const f of ['transcript.jsonl', 'last-message.txt']) fs.copyFileSync(path.join(FIXTURES, 'full-answer', f), path.join(tmp, f));
    fs.writeFileSync(path.join(tmp, 'run_status.json'), '{not json');
    const bad = gradeRun({ runDir: tmp, task: DC011, arm: 'N', config, pathInfo });
    assert.equal(bad.infra, 'malformed');
    assert.equal(bad.pass_rate, null);
    fs.writeFileSync(path.join(tmp, 'run_status.json'), JSON.stringify({ status: 'truncated' }));
    const trunc = gradeRun({ runDir: tmp, task: DC011, arm: 'N', config, pathInfo });
    assert.equal(trunc.infra, 'truncated');
    assert.equal(trunc.pass_rate, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Isolation

test('arm N: the three doflow retrieve forms are leaked, with the matched command as evidence', () => {
  for (const name of ['leak-doflow-retrieve', 'leak-doflow-run-retrieve', 'leak-node-doflow-retrieve']) {
    const g = grade(name);
    assert.equal(g.isolation, 'leaked', name);
    assert.equal(g.pass_rate, null, name);
    assert.equal(g.isolationEvidence.length, 1, name);
    assert.match(g.isolationEvidence[0], /retrieve/, name);
  }
});

test('arm N: `rg retrieve src` and `rg -n "doflow retrieve" docs` are clean and score normally', () => {
  for (const name of ['clean-rg-retrieve-src', 'clean-rg-doflow-retrieve-docs']) {
    const g = grade(name);
    assert.equal(g.isolation, 'clean', name);
    assert.deepEqual(g.isolationEvidence, [], name);
    assert.equal(g.pass_rate, 1, name);
  }
});

test('any MCP tool call is leaked in both arms, named mcp:<server>/<tool>', () => {
  for (const arm of ['N', 'D']) {
    const g = grade('mcp-call', { arm });
    assert.equal(g.isolation, 'leaked', arm);
    assert.deepEqual(g.isolationEvidence, ['mcp:semble/search'], arm);
    assert.equal(g.pass_rate, null, arm);
  }
});

test('an empty transcript is unverifiable and scores null even with an answer', () => {
  const g = grade('empty-transcript');
  assert.equal(g.infra, null);
  assert.equal(g.isolation, 'unverifiable');
  assert.equal(g.pass_rate, null);
});

test('retrieveCalls counts the arm D commands matching count patterns; 0 for arm N', () => {
  const d = grade('arm-d-two-retrieves');
  assert.equal(d.retrieveCalls, 2);
  assert.equal(d.isolation, 'clean');
  assert.equal(d.pass_rate, 1);
  assert.equal(grade('full-answer').retrieveCalls, 0);
});

test('classifyIsolation: evidence is cut to 200 characters; web_search and other events are ignored', () => {
  const long = `doflow retrieve --query "${'x'.repeat(400)}"`;
  const events = [
    { type: 'item.completed', item: { type: 'web_search', query: 'doflow retrieve' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'doflow retrieve' } },
    { type: 'turn.completed', usage: {} },
    { type: 'item.completed', item: { type: 'command_execution', command: long } },
  ];
  const r = classifyIsolation(events, config.arms.N);
  assert.equal(r.isolation, 'leaked');
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].length, 200);
  assert.equal(classifyIsolation(events.slice(0, 3), config.arms.N).isolation, 'clean');
  assert.equal(classifyIsolation([], config.arms.N).isolation, 'unverifiable');
});

// ---------------------------------------------------------------------------
// Answer extraction

test('extractAnswer: last files object wins, prose and fences tolerated, others ignored', () => {
  assert.deepEqual(extractAnswer('{"files":["a.js"]}'), { files: ['a.js'] });
  assert.deepEqual(extractAnswer('first {"files":["a.js"]} then ```json\n{"files":["b.js","c.js"]}\n``` done'), { files: ['b.js', 'c.js'] });
  assert.deepEqual(extractAnswer('{"files":["a.js"]} and then {"other":1}'), { files: ['a.js'] });
  assert.deepEqual(extractAnswer('{"result":{"files":["deep.js"]},"note":"x"}'), { files: ['deep.js'] });
  assert.deepEqual(extractAnswer('{"files":["a }.js"]}'), { files: ['a }.js'] });
  assert.deepEqual(extractAnswer('{"files":[]}'), { files: [] });
  assert.equal(extractAnswer('no json here'), null);
  assert.equal(extractAnswer('{"files":"a.js"}'), null);
  assert.equal(extractAnswer('{"files":["a.js", 3]}'), null);
  assert.equal(extractAnswer('{"files":["a.js"'), null);
  assert.equal(extractAnswer(''), null);
  assert.equal(extractAnswer(null), null);
});

test('extractAnswer: paths are POSIX relative, de-duplicated before the first 10 are taken', () => {
  const r = extractAnswer(JSON.stringify({ files: ['./a.js', 'a.js', 'src\\b.ts', '/abs/c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'i.js', 'j.js', 'k.js', 'l.js'] }));
  assert.deepEqual(r.files, ['a.js', 'src/b.ts', '/abs/c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'i.js', 'j.js']);
});

test('parseTranscript skips lines that are not JSON objects', () => {
  assert.equal(parseTranscript('garbage\n{"type":"turn.started"}\n\n42\nnull\n[1]\n').length, 1);
  assert.deepEqual(parseTranscript(''), []);
});

// ---------------------------------------------------------------------------
// Iteration grading

test('gradeIteration writes grading.json per task, byte-identical when graded twice, and reports missing tasks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-iter-'));
  try {
    fs.writeFileSync(path.join(tmp, 'iteration.json'), JSON.stringify({ arm: 'N', model: 'm', sourceAt: 'abc', snapshot: 's', harness: 'h', harnessVersion: '1', startedAt: 't' }));
    const tasks = [DC011, byId('DC-012')];
    fs.cpSync(path.join(FIXTURES, 'full-answer'), path.join(tmp, 'DC-011'), { recursive: true });
    const first = gradeIteration({ iterationDir: tmp, taskSet: { tasks }, config, pathInfo });
    assert.equal(first.length, 2);
    assert.equal(first[0].pass_rate, 1);
    assert.deepEqual(first[1], { id: 'DC-012', missing: true });
    const file = path.join(tmp, 'DC-011', 'grading.json');
    const bytes1 = fs.readFileSync(file);
    assert.equal(bytes1.toString('utf8'), serializeGrading(first[0]));
    assert.equal(fs.existsSync(path.join(tmp, 'DC-012')), false);
    gradeIteration({ iterationDir: tmp, taskSet: { tasks }, config, pathInfo });
    assert.deepEqual(fs.readFileSync(file), bytes1);
    assert.deepEqual(Object.keys(JSON.parse(bytes1)), [
      'key', 'id', 'split', 'kind', 'arm', 'run_status', 'infra', 'isolation', 'isolationEvidence', 'retrieveCalls', 'answer', 'pass_rate', 'metrics',
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gradeIteration with write=false leaves the directory untouched; gradeRun alone never writes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-iter-'));
  try {
    fs.writeFileSync(path.join(tmp, 'iteration.json'), JSON.stringify({ arm: 'D' }));
    fs.cpSync(path.join(FIXTURES, 'arm-d-two-retrieves'), path.join(tmp, 'DC-011'), { recursive: true });
    const out = gradeIteration({ iterationDir: tmp, taskSet: [DC011], config, pathInfo, write: false });
    assert.equal(out[0].arm, 'D');
    assert.equal(out[0].retrieveCalls, 2);
    assert.equal(fs.existsSync(path.join(tmp, 'DC-011', 'grading.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('grading the committed fixtures leaves them unchanged (gradeRun is pure)', () => {
  const before = fs.readdirSync(path.join(FIXTURES, 'full-answer')).sort();
  grade('full-answer');
  assert.deepEqual(fs.readdirSync(path.join(FIXTURES, 'full-answer')).sort(), before);
  assert.equal(before.includes('grading.json'), false);
});

test('an unknown arm is refused', () => {
  assert.throws(() => grade('full-answer', { arm: 'X' }), /arm/);
});

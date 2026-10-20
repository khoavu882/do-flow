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
const path = require('node:path');

const {
  extractAnswer, classifyIsolation, gradeRun, gradeIteration, loadPathInfo, serializeGrading, parseTranscript,
} = require('../../bench/agentic/grade.js');
const { loadTaskSet, buildPrompt, promptSha256, UsageError } = require('../../bench/agentic/tasks.js');
const { tempDir } = require('../helper/tmp.js');

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

/** The launch record the executor writes for `task` under `arm` (the fields the grader checks), plus `extra`. */
function writeLaunch(runDir, task, arm, extra = {}) {
  const launch = { key: task.key, arm, promptSha256: promptSha256(buildPrompt(task, config.arms[arm].paragraph)), ...extra };
  fs.writeFileSync(path.join(runDir, 'launch.json'), JSON.stringify(launch));
}

/** One command_execution event per command, then a turn end. */
const commandEvents = (...commands) => [
  ...commands.map((command, i) => ({ type: 'item.completed', item: { id: `item_${i}`, type: 'command_execution', command } })),
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
];

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

test('a missing run_status.json is status absent: output makes it a run, no output makes it no-output', (t) => {
  const tmp = tempDir(t, 'doflow-agentic-grade-');
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

test('an unreadable run_status.json is malformed and excluded; a truncated status keeps its class', (t) => {
  const tmp = tempDir(t, 'doflow-agentic-grade-');
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

test('an empty transcript is unverifiable, has no turn end (truncated), and scores null even with an answer', () => {
  const g = grade('empty-transcript');
  assert.equal(g.infra, 'truncated');
  assert.equal(g.isolation, 'unverifiable');
  assert.equal(g.pass_rate, null);
});

test('C-9: a completed run whose transcript has no turn.completed is infra truncated and scores null', (t) => {
  const tmp = tempDir(t, 'doflow-agentic-grade-');
  fs.copyFileSync(path.join(FIXTURES, 'full-answer', 'last-message.txt'), path.join(tmp, 'last-message.txt'));
  fs.writeFileSync(path.join(tmp, 'run_status.json'), JSON.stringify({ status: 'completed', exitCode: 0, signal: null }));
  const events = fs.readFileSync(path.join(FIXTURES, 'full-answer', 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l && !l.includes('turn.completed'));
  fs.writeFileSync(path.join(tmp, 'transcript.jsonl'), `${events.join('\n')}\n`);
  const cut = gradeRun({ runDir: tmp, task: DC011, arm: 'N', config, pathInfo });
  assert.equal(cut.infra, 'truncated');
  assert.equal(cut.run_status, 'completed');
  assert.equal(cut.pass_rate, null);
  assert.deepEqual(cut.metrics, { fileRecallAt10: null });

  fs.writeFileSync(path.join(tmp, 'transcript.jsonl'), '{}\n');
  const empty = gradeRun({ runDir: tmp, task: DC011, arm: 'N', config, pathInfo });
  assert.equal(empty.pass_rate, null, 'a {}-only transcript scores null');
  assert.equal(empty.infra, 'truncated');

  // control: the same run with its turn end scores normally
  fs.copyFileSync(path.join(FIXTURES, 'full-answer', 'transcript.jsonl'), path.join(tmp, 'transcript.jsonl'));
  const whole = gradeRun({ runDir: tmp, task: DC011, arm: 'N', config, pathInfo });
  assert.equal(whole.infra, null);
  assert.equal(whole.pass_rate, 1);
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

// Every form below is matched on the tokenised, normalised simple commands, never on the raw string
// (C-7). The roots make the C-4(b) outside-path rule allow the absolute paths these strings use, so
// what is asserted here is the shipped leak and count patterns alone.
const OPEN_ROOTS = { workspaceRoot: '/x', profileRoot: '/home' };
const RETRIEVAL_FORMS = [
  // the forms the executor test used to pin against the raw-string regex
  'doflow retrieve --scope code --query x --root .',
  '/usr/local/bin/doflow retrieve --query x',
  'doflow-run retrieve --query x',
  'node /home/user/proj/bin/doflow.js retrieve --query x',
  'cd src && doflow retrieve --query x',
  'rg frob | doflow retrieve --query x',
  'ls; doflow retrieve --query x',
  'echo $(doflow retrieve --query x)',
  '/bin/zsh -lc "doflow retrieve --scope code --query x"',
  "bash -c 'doflow retrieve --query x'",
  // wrappers, npx, node flags, command lookups and quoted paths (C-7)
  'env doflow retrieve --query x',
  'env FOO=1 doflow retrieve -q x',
  'npx doflow retrieve --query x',
  'npx -y doflow retrieve',
  'node --no-warnings bin/doflow.js retrieve --query x',
  '$(which doflow) retrieve --query x',
  '$(command -v doflow) retrieve',
  '`which doflow` retrieve --query x',
  '"/x/abs path/bin/doflow" retrieve',
  "node '/x/bin/doflow.js' retrieve",
  'env node /x/checkout/bin/doflow.js retrieve --scope code',
  'FOO=1 nohup time doflow retrieve -q x',
  "/bin/zsh -lc 'exec doflow retrieve -q x'",
  'command doflow retrieve -q x',
  'bash -lc "echo \\"$(doflow retrieve -q x)\\""',
];
const BENIGN_FORMS = [
  'rg retrieve src',
  'rg -n "doflow retrieve" docs',
  'rg -c "doflow retrieve" docs',
  'cat bin/doflow.js | head',
  'echo doflow retrieve',
  '/bin/zsh -lc "rg doflow retrieve"',
  'grep -rn retrieve src/runtime',
  "printf '%s\\n' 'a; doflow retrieve --query x'",
  'echo "doflow retrieve"',
  "rg -n 'doflow retrieve' docs",
  'command -v doflow',
  'which doflow',
  '# doflow retrieve --query x',
];

test('C-7 leak and count: every retrieval form is leaked in arm N and counted in arm D (shipped config)', () => {
  for (const cmd of RETRIEVAL_FORMS) {
    const n = classifyIsolation(commandEvents(cmd), config.arms.N, OPEN_ROOTS);
    assert.equal(n.isolation, 'leaked', `N leak: ${cmd}`);
    assert.deepEqual(n.evidence, [cmd], `N evidence: ${cmd}`);
    const d = classifyIsolation(commandEvents(cmd), config.arms.D, OPEN_ROOTS);
    assert.equal(d.retrieveCalls, 1, `D count: ${cmd}`);
    assert.equal(d.isolation, 'clean', `arm D may call the tool: ${cmd}`);
  }
});

test('C-7 leak and count: benign strings (the phrase as data, a quoted argument, a lookup) are clean and uncounted', () => {
  for (const cmd of BENIGN_FORMS) {
    const n = classifyIsolation(commandEvents(cmd), config.arms.N, OPEN_ROOTS);
    assert.equal(n.isolation, 'clean', `N leak: ${cmd} -> ${JSON.stringify(n.evidence)}`);
    assert.equal(classifyIsolation(commandEvents(cmd), config.arms.D, OPEN_ROOTS).retrieveCalls, 0, `D count: ${cmd}`);
  }
});

test('C-7 MCP: tool calls are leaked in both arms by name; mcp in a command or file name is not', () => {
  const mcpEvent = (server, tool) => [{ type: 'item.completed', item: { type: 'mcp_tool_call', server, tool } }, { type: 'turn.completed' }];
  for (const arm of ['N', 'D']) {
    for (const [server, tool] of [['semble', 'search'], ['context7', 'query-docs']]) {
      const r = classifyIsolation(mcpEvent(server, tool), config.arms[arm], OPEN_ROOTS);
      assert.equal(r.isolation, 'leaked', `${arm} ${server}/${tool}`);
      assert.deepEqual(r.evidence, [`mcp:${server}/${tool}`]);
    }
  }
  for (const pattern of config.arms.D.leak) assert.equal(new RegExp(pattern).test('mcp__semble__search'), true, 'the underscore form');
  for (const cmd of ['rg mcp src', 'node mcp-server.js', 'cat docs/mcp.md']) {
    assert.equal(classifyIsolation(commandEvents(cmd), config.arms.D, OPEN_ROOTS).isolation, 'clean', cmd);
  }
  assert.equal(classifyIsolation(commandEvents('doflow retrieve --query x'), config.arms.D, OPEN_ROOTS).isolation, 'clean', 'arm D may call the tool');
});

// C-4(b): a command that reads outside the run's workspace and profile is graded leaked in BOTH arms.
const WS = '/private/var/folders/zz/doflow-agentic-ws-1/workspace';
const PROFILE = '/private/var/folders/zz/doflow-agentic-profile-1';
const ROOTS = { workspaceRoot: WS, profileRoot: PROFILE };

test('C-4(b): outside-path reads, ../ escapes and truth-path names are leaked in both arms with the command as evidence', () => {
  const leaked = [
    'cat /abs/checkout/bench/agentic/tasks-heldout.json',
    'cat ../../../x',
    'cd src && cat ../../secret',
    'rg -n HC-901 /Users/someone/do-flow',
    'ls bench/runs',
    'cat bench/retrieval/tasks/dev.json',
    'rg -l x tasks-heldout.json',
    "/bin/zsh -lc 'cat /tmp/elsewhere/file'",
    'find / -name tasks.json',
    'cat "/abs path/heldout.json"',
    'rg --files --glob=x /opt2/x',
  ];
  for (const arm of ['N', 'D']) {
    for (const cmd of leaked) {
      const r = classifyIsolation(commandEvents('rg -n lock src', cmd), config.arms[arm], ROOTS);
      assert.equal(r.isolation, 'leaked', `${arm}: ${cmd}`);
      assert.deepEqual(r.evidence, [cmd], `${arm}: ${cmd}`);
    }
  }
  const long = `cat /abs/${'y'.repeat(400)}`;
  assert.equal(classifyIsolation(commandEvents(long), config.arms.N, ROOTS).evidence[0].length, 200, 'evidence is cut');
});

test('C-4(b): the workspace, the profile, system dirs and the /private alias are clean', () => {
  const clean = [
    `rg foo ${WS}/src`,
    `rg foo ${WS.replace(/^\/private/, '')}/src`,
    'ls /usr/bin',
    `cat ${PROFILE}/home/x`,
    'rg -n lock src 2>/dev/null',
    'cd src && cat ../package.json',
    `/bin/zsh -lc "sed -n 1,40p ${WS}/test/helper/tmp.js"`,
    'cat /etc/hosts; ls /System/Library',
  ];
  for (const arm of ['N', 'D']) {
    for (const cmd of clean) {
      const r = classifyIsolation(commandEvents(cmd), config.arms[arm], ROOTS);
      assert.equal(r.isolation, 'clean', `${arm}: ${cmd} -> ${JSON.stringify(r.evidence)}`);
    }
  }
});

test('C-4(b): without launch roots only the system prefixes are allowed; gradeRun reads the roots from launch.json', (t) => {
  assert.equal(classifyIsolation(commandEvents(`rg foo ${WS}/src`), config.arms.N).isolation, 'leaked', 'no roots: the workspace is not known');
  assert.equal(classifyIsolation(commandEvents('ls /usr/bin'), config.arms.N).isolation, 'clean');

  const tmp = tempDir(t, 'doflow-agentic-grade-');
  for (const f of ['run_status.json', 'last-message.txt']) fs.copyFileSync(path.join(FIXTURES, 'full-answer', f), path.join(tmp, f));
  fs.writeFileSync(path.join(tmp, 'transcript.jsonl'), commandEvents(`sed -n 1,40p ${WS}/test/helper/tmp.js`).map((e) => JSON.stringify(e)).join('\n'));
  const before = gradeRun({ runDir: tmp, task: DC011, arm: 'N', config, pathInfo });
  assert.equal(before.isolation, 'leaked', 'no launch.json');
  writeLaunch(tmp, DC011, 'N', ROOTS);
  const after = gradeRun({ runDir: tmp, task: DC011, arm: 'N', config, pathInfo });
  assert.equal(after.isolation, 'clean');
  assert.equal(after.pass_rate, 1);
  fs.writeFileSync(path.join(tmp, 'transcript.jsonl'), commandEvents('cat /abs/checkout/bench/agentic/tasks-heldout.json').map((e) => JSON.stringify(e)).join('\n'));
  for (const arm of ['N', 'D']) {
    const g = gradeRun({ runDir: tmp, task: DC011, arm, config, pathInfo });
    assert.equal(g.isolation, 'leaked', arm);
    assert.equal(g.pass_rate, null, arm);
    assert.deepEqual(g.isolationEvidence, ['cat /abs/checkout/bench/agentic/tasks-heldout.json']);
  }
});

// C-8: a run is graded only as the task and prompt it was launched with.
test('C-8: gradeIteration refuses a run without launch.json or whose launch key or prompt differs from the current task', (t) => {
  const tmp = tempDir(t, 'doflow-agentic-iter-');
  fs.writeFileSync(path.join(tmp, 'iteration.json'), JSON.stringify({ arm: 'N', model: 'm', sourceAt: 'abc' }));
  const runDir = path.join(tmp, 'DC-011');
  fs.cpSync(path.join(FIXTURES, 'full-answer'), runDir, { recursive: true });
  const run = () => gradeIteration({ iterationDir: tmp, taskSet: [DC011], config, pathInfo });
  const refused = (reason, ...words) => (e) => e instanceof UsageError && e.reason === reason && words.every((w) => e.message.includes(w));

  assert.throws(run, refused('launch-missing', 'DC-011', 'launch.json'));
  writeLaunch(runDir, DC011, 'N', { key: 'agentic/DC-011@00000000' });
  assert.throws(run, refused('capture-stale', 'DC-011', 'key'), 'an edited question or truth moves the key');
  writeLaunch(runDir, DC011, 'N', { promptSha256: '0'.repeat(64) });
  assert.throws(run, refused('capture-stale', 'DC-011', 'promptSha256'), 'an edited prompt or arm paragraph');
  writeLaunch(runDir, DC011, 'D');
  assert.throws(run, refused('capture-stale', 'promptSha256'), 'arm D prompt graded as arm N');
  assert.equal(fs.existsSync(path.join(runDir, 'grading.json')), false, 'a refusal writes nothing');

  writeLaunch(runDir, DC011, 'N');
  assert.equal(run()[0].pass_rate, 1, 'the matching launch record grades');
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

test('gradeIteration writes grading.json per task, byte-identical when graded twice, and reports missing tasks', (t) => {
  const tmp = tempDir(t, 'doflow-agentic-iter-');
  try {
    fs.writeFileSync(path.join(tmp, 'iteration.json'), JSON.stringify({ arm: 'N', model: 'm', sourceAt: 'abc', snapshot: 's', harness: 'h', harnessVersion: '1', startedAt: 't' }));
    const tasks = [DC011, byId('DC-012')];
    fs.cpSync(path.join(FIXTURES, 'full-answer'), path.join(tmp, 'DC-011'), { recursive: true });
    writeLaunch(path.join(tmp, 'DC-011'), DC011, 'N');
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

test('gradeIteration with write=false leaves the directory untouched; gradeRun alone never writes', (t) => {
  const tmp = tempDir(t, 'doflow-agentic-iter-');
  try {
    fs.writeFileSync(path.join(tmp, 'iteration.json'), JSON.stringify({ arm: 'D' }));
    fs.cpSync(path.join(FIXTURES, 'arm-d-two-retrieves'), path.join(tmp, 'DC-011'), { recursive: true });
    writeLaunch(path.join(tmp, 'DC-011'), DC011, 'D');
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

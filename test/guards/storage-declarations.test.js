'use strict';

// G26 — storage declarations (feature 061, IC-020; FR-021, FR-022, FR-023, NFR-001).
//
// `core/registry/storage.json` is the one place a store's retention is declared. This guard fails
// when the registry and the shipped code or documentation disagree: a writer nobody declared, a path
// a real run produces that no declaration covers, a bound quoted in two places that differ, or a
// storage module that could reach the network or spawn a process. Each IC-020 part is its own test;
// the checking functions are pure so the self-tests can run them on in-memory input.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./_shared');
const { createScratch } = require('../helper/scratch-env');
const { encodeEnvelope } = require('../helper/hook-fixtures');
const { loadStorageRegistry, validateStorageRegistry, renderSourcePattern, formatBound } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');

const REGISTRY_FILE = 'core/registry/storage.json';
const DOCS_FILE = 'docs/reference.md';
const DOCS_HEADER = '| Store | Location | Bound |';
const SCAN_DIRS = ['src', 'bin', 'core/shared/scripts', 'core/harnesses'];
const JS_WRITE_CALL = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|renameSync|copyFileSync|cpSync|symlinkSync|linkSync|mkdtempSync)\s*\(/;
const BASH_WRITE_COMMAND = /(?:^|[\s;&|(){`])(mkdir|touch|mktemp|mv|cp|tee)(?=[\s;&|)}`]|$)/;
const BASH_REDIRECTION = /(?:^|[\s;&|(){`])(\d*)(>>?)(?!&)\s*([^\s;&|<>()]+)/g;
const FORBIDDEN_MODULES = ['http', 'https', 'net', 'dns', 'child_process'];

// --- Part (b): static writers ------------------------------------------------------------------

function walkFiles(relativeDir) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(REPO, relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walkFiles(relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

/** The language of a shipped source file, by extension or shebang; null for data and prose files.
 * `.ts` is a JS-family source: DoFlow runs it directly through Node native type-stripping
 * (agent-docs/BRIEF_GOAL_DOFLOW.md), so a converted writer still makes the same fs write calls and
 * must still be scanned and declared. `.d.ts` is a declaration file, not a module, and is excluded. */
function sourceKind(file, text) {
  if (/\.d\.ts$/.test(file)) return null;
  if (/\.(?:js|cjs|mjs|ts)$/.test(file)) return 'js';
  if (/\.sh$/.test(file)) return 'bash';
  const shebang = text.startsWith('#!') ? text.split('\n', 1)[0] : '';
  if (/\bnode\b/.test(shebang)) return 'js';
  if (/\b(?:ba)?sh\b/.test(shebang)) return 'bash';
  return null;
}

/**
 * Blanks everything in a bash source that is not a command word or a redirection: comments, quoted
 * text, heredoc bodies. The text inside `$( )` in double quotes stays, because `"$(mktemp -d)"` is a
 * write. Newlines and offsets are preserved so a hit keeps its line number.
 */
function maskBash(source) {
  const out = source.split('');
  const blank = (index) => { if (out[index] !== '\n') out[index] = ' '; };
  const stack = [{ mode: 'code', depth: 0 }];
  const pendingHeredocs = [];
  let i = 0;
  while (i < source.length) {
    const top = stack[stack.length - 1];
    const char = source[i];
    if (top.mode === 'sq') {
      if (char === "'") stack.pop(); else blank(i);
      i++;
    } else if (top.mode === 'dq') {
      if (char === '\\') { blank(i); if (i + 1 < source.length) blank(i + 1); i += 2; }
      else if (char === '"') { stack.pop(); i++; }
      else if (char === '$' && source[i + 1] === '(') { stack.push({ mode: 'code', depth: 0 }); i += 2; }
      else { blank(i); i++; }
    } else if (char === '\\') {
      blank(i); if (i + 1 < source.length) blank(i + 1); i += 2;
    } else if (char === "'") { stack.push({ mode: 'sq' }); i++; }
    else if (char === '"') { stack.push({ mode: 'dq' }); i++; }
    else if (char === '#' && (i === 0 || /[\s;&|(]/.test(source[i - 1]))) {
      while (i < source.length && source[i] !== '\n') { blank(i); i++; }
    } else if (char === '(' && stack.length > 1) { top.depth++; i++; }
    else if (char === ')' && stack.length > 1) {
      if (top.depth === 0) stack.pop(); else top.depth--;
      i++;
    } else if (char === '<' && source[i + 1] === '<' && source[i + 2] !== '<') {
      const word = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(source.slice(i, i + 80));
      if (word) pendingHeredocs.push(word[2]);
      i += 2;
    } else if (char === '\n' && pendingHeredocs.length > 0) {
      i++;
      for (const delimiter of pendingHeredocs.splice(0)) {
        while (i < source.length) {
          const end = source.indexOf('\n', i);
          const lineEnd = end === -1 ? source.length : end;
          const isDelimiter = source.slice(i, lineEnd).trim() === delimiter;
          for (let at = i; at < lineEnd; at++) blank(at);
          i = Math.min(lineEnd + 1, source.length);
          if (isDelimiter) break;
        }
      }
    } else i++;
  }
  return out.join('');
}

/** Every write call in one source file, `[{ line, call }]`, one per line. The text is read as is: a NUL byte never hides a file. */
function writeCalls(file, text) {
  const kind = sourceKind(file, text);
  if (!kind) return [];
  const calls = [];
  if (kind === 'js') {
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(lines[index])) continue;
      const match = JS_WRITE_CALL.exec(lines[index]);
      if (match) calls.push({ line: index + 1, call: match[1] });
    }
    return calls;
  }
  const original = text.split('\n');
  const lines = maskBash(text).split('\n');
  for (let index = 0; index < lines.length; index++) {
    const command = BASH_WRITE_COMMAND.exec(lines[index]);
    let redirection = null;
    for (const match of lines[index].matchAll(BASH_REDIRECTION)) {
      if (match[3] === '/dev/null') continue;
      const start = match.index + match[0].length - match[3].length;
      redirection = `${match[2]} ${original[index].slice(start, start + match[3].length)}`;
      break;
    }
    if (command || redirection) calls.push({ line: index + 1, call: command ? command[1] : redirection });
  }
  return calls;
}

/** The first write call in one source file, or null. */
function firstWriteCall(file, text) {
  return writeCalls(file, text)[0] || null;
}

function scanShippedWriters() {
  const hits = new Map();
  for (const dir of SCAN_DIRS) {
    for (const file of walkFiles(dir)) {
      const calls = writeCalls(file, fs.readFileSync(path.join(REPO, file), 'utf8'));
      if (calls.length) hits.set(file, calls);
    }
  }
  return hits;
}

/** Both directions of IC-020 (b): every write call is in a declared file, every declared file has a call. */
function checkWriters(registry, hits, fileExists = (file) => fs.existsSync(path.join(REPO, file))) {
  const errors = [];
  const declared = new Map();
  for (const store of registry.stores) for (const file of store.writers) declared.set(file, `store ${store.id}`);
  for (const writer of registry.externalWriters) declared.set(writer.file, 'externalWriters');
  for (const [file, calls] of hits) {
    if (declared.has(file)) continue;
    for (const hit of calls) errors.push(`${file}:${hit.line} ${hit.call} is in no store's writers and not in externalWriters`);
  }
  for (const [file, owner] of declared) {
    if (!fileExists(file)) errors.push(`${owner} lists ${file}, which does not exist`);
    else if (!hits.has(file)) errors.push(`${owner} lists ${file}, which has no write call`);
  }
  return errors;
}

// --- Part (c): sandbox locations ---------------------------------------------------------------

/** Whether a declaration owns the path whose segments, relative to the store's root, are `segs`. */
function storeCovers(store, segs) {
  const base = store.path ? store.path.split('/') : [];
  if (base.length === 0) {
    const pattern = new RegExp(store.match);
    return pattern.test(segs[0]) || pattern.test(segs[segs.length - 1]);
  }
  if (segs.length < base.length) return false;
  if (base.every((part, index) => part === segs[index])) return true;
  // The declared file name followed by `.` and a suffix is the file's lock or temp sibling (AM2).
  const last = base.length - 1;
  return store.entry === 'file' && segs.length === base.length
    && base.slice(0, last).every((part, index) => part === segs[index])
    && segs[last].startsWith(`${base[last]}.`);
}

/** True when `segs` is a folder that holds a declared store without being one: a root or a parent folder. */
function isContainer(store, segs) {
  const base = store.path ? store.path.split('/') : [];
  return segs.length < base.length && segs.every((part, index) => part === base[index]);
}

/** The declaration ids that cover `file`, or `{ container: true }` for a folder that only holds stores. */
function coverage(registry, roots, file) {
  const ids = [];
  let container = false;
  for (const store of registry.stores) {
    const root = roots[store.root];
    if (!root) continue;
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const segs = relative === '' ? [] : relative.split(path.sep);
    if (segs.length === 0 || isContainer(store, segs)) container = true;
    else if (storeCovers(store, segs)) ids.push(store.id);
  }
  return { ids, container };
}

/** IC-020 (c): `observations` is `[{ file, step }]`; returns the unmapped paths and the unexercised stores. */
function checkLocations(registry, roots, observations, displayRoot) {
  const errors = [];
  const exercised = new Set();
  for (const { file, step } of observations) {
    const { ids, container } = coverage(registry, roots, file);
    ids.forEach((id) => exercised.add(id));
    if (ids.length === 0 && !container) errors.push(`${path.relative(displayRoot, file)} written by ${step}`);
  }
  for (const store of registry.stores) {
    if (store.rule !== 'existing' && !exercised.has(store.id)) errors.push(`store ${store.id} not exercised`);
  }
  return errors;
}

const DOFLOW_RUN = path.join(REPO, 'core/shared/scripts/doflow/bin/doflow-run');
const DOFLOW_CLI = path.join(REPO, 'bin/doflow.js');
const TARGETS = 'claude,codex';

// Wraps the three removal calls so a path DoFlow creates and deletes inside one command (the pass
// lock, the run lock and its claim file) is still seen on disk, just before it goes.
const OBSERVER_SOURCE = `'use strict';
const fs = require('node:fs');
const log = process.env.G26_OBSERVED;
function record(target) { try { fs.lstatSync(target); fs.appendFileSync(log, target + '\\n'); } catch {} }
for (const name of ['unlinkSync', 'rmdirSync', 'rmSync']) {
  const original = fs[name];
  fs[name] = function observed(target, ...rest) { if (log && typeof target === 'string') record(target); return original.call(this, target, ...rest); };
}
`;

function walkTree(dir, found = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    found.push(file);
    if (entry.isDirectory()) walkTree(file, found);
  }
  return found;
}

function runScenario() {
  const started = Date.now();
  const scratch = createScratch('doflow-g26-', { prune: 'on' });
  const project = path.join(scratch.dir, 'project');
  const mirror = path.join(scratch.dir, 'mirror');
  const observer = path.join(scratch.dir, 'observer.cjs');
  const observed = path.join(scratch.dir, 'observed.log');
  fs.mkdirSync(project);
  fs.writeFileSync(observer, OBSERVER_SOURCE);
  try {
    const built = spawnSync('bash', [path.join(REPO, 'test/hooks/build-install-mirror.sh'), mirror], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const env = scratch.env({ DOFLOW_TELEMETRY: 'on', DOFLOW_CLI, NODE_OPTIONS: `--require=${observer}`, G26_OBSERVED: observed });
    const git = spawnSync('git', ['init', '-q'], { cwd: project, env, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    fs.writeFileSync(path.join(project, 'plan.md'), [
      '# Scenario plan',
      '- [x] A.1 one check; files: f.js',
      '```doflow-verification',
      '{"parse":null,"build":null,"lint":null,"typecheck":null,"test":"node -e \\"console.log(1);process.exit(1)\\""}',
      '```',
      '',
    ].join('\n'));
    // A feature folder with one plan task, so `task-attempt claim` has a ledger to write (feature 070).
    fs.mkdirSync(path.join(project, 'agent-docs', 'doflow', 'g26-task'), { recursive: true });
    fs.writeFileSync(path.join(project, 'agent-docs', 'doflow', 'g26-task', 'plan.md'), '# Plan\n\n## Tasks\n\n- [ ] A.1 one task; owner: core-implementer; files: f.js\n');
    fs.writeFileSync(path.join(project, '.gitignore'), '.doflow/\n');
    // The verify report step needs a real head for IC-007; the runtime state stays ignored.
    const seeded = spawnSync('git', ['-c', 'user.name=G26', '-c', 'user.email=g26@example.test', 'add', '.'], { cwd: project, env, encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
    const committed = spawnSync('git', ['-c', 'user.name=G26', '-c', 'user.email=g26@example.test', 'commit', '-q', '-m', 'G26 fixture'], { cwd: project, env, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr);
    const registry = loadStorageRegistry({ repoRoot: REPO });
    const roots = resolveRoots({ registry, projectRoot: project, env });
    const sessionPayload = { session_id: 'g26-session', cwd: project, source: 'startup' };
    const verb = (...args) => ({ cmd: '/bin/bash', args: [DOFLOW_RUN, ...args] });
    const cli = (...args) => ({ cmd: process.execPath, args: [DOFLOW_CLI, ...args] });
    const node = (...args) => ({ cmd: process.execPath, args });
    const hook = (script, payload) => ({
      cmd: '/bin/bash', args: [script],
      input: script.endsWith('/session-context.sh')
        ? encodeEnvelope('claude', 'SessionStart', 'session-context', JSON.stringify(payload))
        : JSON.stringify(payload),
    });
    const target = ['--force', '--target', TARGETS];
    const enableAdvice = "const fs=require('node:fs'),path=require('node:path');const f=path.join(process.env.XDG_CONFIG_HOME,'doflow','decision-model.json');fs.writeFileSync(f,JSON.stringify({schema:1,enabled:true,provider:'ollama',endpoint:'http://127.0.0.1:9',model:'clef-flash'})+'\\n');";
    // The bash summary store (feature 078): a scoped summary write and its owner claim, then a grant
    // seeded where grantSummary() would write it and claimed by rename.
    const summaryStore = (script) => ({
      cmd: '/bin/bash',
      args: ['-c', `set -euo pipefail\n. "$1/lib.sh"\n. "$1/summary-store.sh"\n${script}`, 'summary-store.sh', path.join(mirror, '.doflow/shared/hooks/policies'), project],
    });
    const summaryWriteClaim = 'doflow_summary_write "$2" local main "" 2026-10-14T10:00:00Z g26-writer auto main main "a summary"\ndoflow_summary_claim "$2" local main g26-session g26-session\nrm -f "$DF_SUMMARY_CLAIMED"';
    const grantWriteClaim = 'd="$STATE_DIR/grants/local/w-1"\nmkdir -p "$d"\nprintf -- "---\\nsummary_id: s-20261014T100500Z-G26aaa\\nfrom_lineage: main\\n---\\n\\na grant\\n" >"$d/s-20261014T100500Z-G26aaa.md"\ndoflow_grant_claim local w-1 g26-session 16384\nrm -f "$DF_GRANT_CLAIMED"';
    const seedOldAdvice = "const fs=require('node:fs'),path=require('node:path');for(const root of process.argv.slice(1)){const d=path.join(root,'advice','picks');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'2000-01-01.jsonl'),'{}\\n');}";
    // The real registry makes every harness ineligible (DEC-017), so no `worker --action run` step can
    // write `worker-runs` or `worker-output`: one run is inserted in process with a fake descriptor's
    // recipe, and one line goes through the supervisor's own output sink (081 IC-031, DEC-039).
    const seedWorkerRun = `const path=require('node:path');
const { insertRun, newRunId } = require(${JSON.stringify(path.join(REPO, 'src/runtime/worker/run-store.ts'))});
const { createOutputSink } = require(${JSON.stringify(path.join(REPO, 'src/runtime/worker/supervisor.ts'))});
const descriptor = require(${JSON.stringify(path.join(REPO, 'test/fixtures/worker/descriptors.json'))}).claude;
const stateRoot = process.argv[1];
const runId = newRunId();
const inserted = insertRun(path.join(stateRoot, 'worker-runs', 'g26-task.json'), { runId, task: 'A.1', token: 1, harness: 'claude', phase: 'starting', descriptor });
if (!inserted.applied) { console.error(JSON.stringify(inserted)); process.exit(1); }
const sink = createOutputSink({ stateRoot, runId, stream: 'stdout' });
sink.write('one line\\n');
sink.end().then(() => process.exit(0), () => process.exit(1));`;
    // No CLI step can write the three dispatch stores: the real registry makes every harness
    // ineligible for editing and `dispatch start` needs a git project with a graph plan. One dispatch
    // run, one handoff envelope and one attempt-worktree directory are written in process, with no git
    // command and no binary lookup, so the scratch PATH never reaches a harness (082 IC-037, DEC-037).
    const seedDispatch = `const fs=require('node:fs'),path=require('node:path');
const { mutateDispatch, newDispatchRunId, newDispatchId } = require(${JSON.stringify(path.join(REPO, 'src/runtime/dispatch/store.ts'))});
const { buildHandoff, writeEnvelope } = require(${JSON.stringify(path.join(REPO, 'src/runtime/dispatch/envelope.ts'))});
const stateRoot = process.argv[1];
const dispatchRunId = newDispatchRunId();
const dispatchId = newDispatchId();
mutateDispatch(path.join(stateRoot, 'dispatch', 'g26-task.json'), (store) => { store.run = { dispatchRunId, slug: 'g26-task', mode: 'manual' }; return { write: true, result: null }; });
const worktree = path.join(stateRoot, 'dispatch-worktrees', dispatchId);
const handoff = buildHandoff({ dispatchId, dispatchRunId, slug: 'g26-task', mode: 'manual',
  task: { id: 'A.1', phase: 'A', owner: 'core-implementer', text: 'one task', files: ['f.js'], dependsOn: [] },
  acceptance: [], sources: [], deltas: { runBase: null, attemptBase: null, changes: [] }, budget: { attempts: { used: 0, limit: 1 } },
  grant: null, worktree: { path: worktree, branch: 'doflow-attempt/g26-task/' + dispatchId, base: null }, report: null });
writeEnvelope({ stateRoot, dispatchId, kind: 'handoff', value: handoff });
fs.mkdirSync(worktree, { recursive: true });`;
    // The telemetry store (088 IC-018): one line through the writer 088 ships. `state/runs` exists by
    // now (the verbs above append to the run ledger), and the writer creates only `telemetry/`.
    const writeTelemetry = `const fs=require('node:fs'),path=require('node:path');
const { TelemetryWriter } = require(${JSON.stringify(path.join(REPO, 'src/runtime/trace/telemetry.ts'))});
new TelemetryWriter({ start: process.argv[1], env: process.env }).write([{ kind: 'verify.tier' }]);
if (!fs.readdirSync(path.join(process.argv[1], '.doflow', 'state', 'runs', 'telemetry')).length) process.exit(1);`;
    // The verification-v0 store (088 IC-018): a real failed test goes through runContract's
    // failed-first state write, so this scenario covers the production path rather than a helper.
    const writeVerificationV0 = `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const { VerificationEngine } = require(${JSON.stringify(path.join(REPO, 'src/runtime/verification/engine.ts'))});
const root=process.argv[1],configDir=path.join(root,'.doflow');
// A nested Node test runner must not inherit the outer runner's child context.
delete process.env.NODE_TEST_CONTEXT;
fs.mkdirSync(path.join(root,'test'),{recursive:true});
fs.writeFileSync(path.join(root,'test/g26.test.js'),"require('node:test')('G26 failure',()=>{throw new Error('expected G26 failure')});\\n");
const command='npm test';
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({private:true,scripts:{test:'node --test "test/**/*.test.js"'}}));
const plan=path.join(root,'g26-failed-first-plan.md');
fs.writeFileSync(plan,'# Plan\\n\\n\`\`\`doflow-verification\\n'+JSON.stringify({parse:null,build:null,lint:null,typecheck:null})+'\\n\`\`\`\\n');
const engine=new VerificationEngine({cwd:root,repoRoot:${JSON.stringify(REPO)},configDir,v0:true});
const contract=engine.compileContract({taskId:'g26-task',riskLevel:'MEDIUM',projectRoot:root,planPath:plan,changedFiles:['test/g26.test.js'],scope:{allowedPaths:['test/']}});
const report=engine.runContract(contract,{changedFiles:['test/g26.test.js']});
assert.equal(report.status,'FAIL');
const check=report.tiers.find(t=>t.id==='broad-tests').checks[0];
assert.equal(check.status,'FAIL');
assert.deepEqual(check.failedFiles,['test/g26.test.js']);
const stateFile=path.join(configDir,'state','verification','v0','failed-first-g26-task.json');
const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
const sha16=text=>crypto.createHash('sha256').update(text).digest('hex').slice(0,16);
assert.equal(fs.statSync(stateFile).mode&0o777,0o600);
assert.equal(state.v,1);
assert.equal(state.cwd,sha16(fs.realpathSync(root)));
assert.deepEqual(state.checks[check.name],{cmd:sha16(command),files:[sha16('test/g26.test.js')]});`;
    // G.4: exercise the inflight writer independently of the engine's failed-first writer.
    const writeInflight = `const fs=require('node:fs'),path=require('node:path');
const { runInflight } = require(${JSON.stringify(path.join(REPO, 'src/runtime/verification/inflight.ts'))});
const dir=path.join(process.argv[1], '.doflow', 'state', 'verification', 'v0');
const out=runInflight({dir,key:'0123456789abcdef',timeoutMs:1000,execute:()=>({status:0,stdout:'',stderr:''})});
if(out.shared!=='leader'||!fs.readdirSync(dir).some(n=>n.endsWith('.result.json')))process.exit(1);`;
    // Exercise the production intent writer without any merge or external process.
    const writeRoadmap = `const path=require('node:path');
const { writeIntent } = require(${JSON.stringify(path.join(REPO, 'src/runtime/roadmap/merge.ts'))});
writeIntent(path.join(process.argv[1], '.doflow/state/roadmap/intents/113.json'), { schema:1, row:'113', phase:'intent' });`;
    // `trace -g` comes first so the user state exists when the project's ignore file is first
    // written: only then does the pass record the project in the roots index (IC-017).
    const steps = [
      ['trace -g', verb('trace', '-g'), 0],
      ['advise configure off', cli('advise', '--action', 'configure', '--off'), 0],
      ['write enabled decision model', node('-e', enableAdvice), 0],
      ['advise project pick store', cli('advise', '--kind', 'tier', '--state', 'x'), 0],
      ['advise user pick store', cli('advise', '-g', '--kind', 'tier', '--state', 'x'), 0],
      ['orchestrate start', verb('orchestrate', '--action', 'start', '--task-id', 'g26-task', '--task-class', 'feature'), 0],
      ['evidence add', verb('evidence', '--task-id', 'g26-task', '--action', 'add', '--kind', 'documentation', '--provenance', 'asserted', '--provider', 'test', '--capability', 'scenario', '--content', 'a note'), 0],
      ['claim add', verb('claim', '--task-id', 'g26-task', '--action', 'add', '--statement', 'a claim'), 0],
      ['context-pack', verb('context-pack', '--task-id', 'g26-task', '--task-class', 'feature'), 0],
      ['readiness', verb('readiness', '--task-class', 'bug', '--task-id', 'g26-task'), 0],
      ['research-request', verb('research-request', '--task-id', 'g26-task', '--action', 'open', '--stage-id', 'discovery', '--question', 'a question', '--reason', 'user-request'), 0],
      ['outcome', verb('outcome', '--task-id', 'g26-task', '--action', 'record', '--state', 'BLOCKED', '--task-class', 'bug'), 0],
      ['retrieval-plan', verb('retrieval-plan', '--task-id', 'g26-task', '--action', 'declare', '--need', 'locate-concept'), 0],
      ['retrieval-plan attempt', verb('retrieval-plan', '--task-id', 'g26-task', '--action', 'attempt', '--need', 'locate-concept', '--provider', 'semble.search', '--status', 'UNREACHED', '--reason', 'provider-unavailable'), 0],
      ['evidence add absence', verb('evidence', '--task-id', 'g26-task', '--action', 'add', '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'native.rg', '--capability', 'code.exact-search', '--absence', '--need', 'locate-concept'), 0],
      ['task-attempt claim', verb('task-attempt', '--action', 'claim', '--slug', 'g26-task', '--task', 'A.1', '--owner', 'core-implementer', '--mode', 'manual'), 0],
      ['verify report (verification-runs)', verb('verify', '--action', 'report', '--task-id', 'g26-task', '--plan-path', 'plan.md'), 1],
      ['followup report', verb('followup', '--action', 'report', '--statement', 'a problem', '--text', 'its body'), 0],
      ['lifecycle', verb('lifecycle'), 0],
      ['trace', verb('trace'), 0],
      ['telemetry write', node('-e', writeTelemetry, project), 0],
      ['verification-v0 write', node('-e', writeVerificationV0, project), 0],
      ['roadmap intent write', node('-e', writeRoadmap, project), 0],
      ['verification-v0 inflight write', node('-e', writeInflight, project), 0],
      ['session-context.sh', hook(path.join(mirror, '.doflow/shared/hooks/policies/session-context.sh'), sessionPayload), 0],
      ['summary-store.sh write and claim', summaryStore(summaryWriteClaim), 0],
      ['summary-store.sh grant claim', summaryStore(grantWriteClaim), 0],
      ['post-edit-lint.sh', hook(path.join(mirror, '.claude/hooks/post-edit-lint.sh'), { ...sessionPayload, tool_name: 'Edit', tool_input: { file_path: path.join(project, 'f.js') } }), 0],
      ['project install', cli('install', project, ...target, '--mcp', 'none'), 0],
      ['project update', cli('update', project, ...target), 0],
      ['global install', cli('install', '-g', ...target, '--mcp', 'none'), 0],
      ['global update', cli('update', '-g', ...target), 0],
      ['seed old advice partitions', node('-e', seedOldAdvice, roots['project-state'], roots['user-state']), 0],
      ['seed worker run and output', node('-e', seedWorkerRun, roots['project-state']), 0],
      // `empty-bin` does not exist, so every harness is `not-on-path` and no process but Node starts:
      // no real harness binary runs (081 IC-031, IC-032). `/usr/bin/env` is absent on win32 (RK8).
      ['worker probe (empty PATH)', { cmd: '/usr/bin/env', args: [`PATH=${path.join(scratch.dir, 'empty-bin')}`, process.execPath, DOFLOW_CLI, 'worker', '--action', 'probe', '--json'] }, 0],
      // In process with an empty PATH and no identity variables: the seed spawns nothing and looks up
      // no binary, and no harness is reachable even by accident (NFR-002, DEC-056).
      ['seed dispatch record, envelope and worktree layout', { cmd: '/usr/bin/env', args: [...['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'].flatMap((name) => ['-u', name]), `PATH=${path.join(scratch.dir, 'empty-bin')}`, process.execPath, '-e', seedDispatch, roots['project-state']] }, 0],
      ['storage --action prune', cli('storage', '--action', 'prune'), 0],
      ['project remove', cli('remove', project, ...target), 0],
      ['global remove', cli('remove', '-g', ...target), 0],
    ];
    const watched = [roots['project-doflow'], roots['user-doflow'], roots['config-home']];
    const snapshot = () => new Set(watched.flatMap((dir) => walkTree(dir)));
    const observations = [];
    const failures = [];
    let known = snapshot();
    for (const [step, { cmd, args, input }, expected] of steps) {
      fs.rmSync(observed, { force: true });
      const result = spawnSync(cmd, args, { cwd: project, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== expected) failures.push(`${step}: exit ${result.status}, expected ${expected}: ${result.stderr || result.stdout}`);
      const after = snapshot();
      const touched = new Set([...after].filter((file) => !known.has(file)));
      if (fs.existsSync(observed)) {
        for (const file of fs.readFileSync(observed, 'utf8').split('\n')) if (file && watched.some((dir) => file.startsWith(dir))) touched.add(file);
      }
      for (const file of touched) observations.push({ file, step });
      known = after;
    }
    return { registry, roots, observations, failures, displayRoot: scratch.dir, wallMs: Date.now() - started };
  } finally {
    scratch.remove();
  }
}

// --- Part (d): one home per bound --------------------------------------------------------------

/** Every `existing` store's rendered source pattern must be present in its source file. */
function checkExistingSources(registry, readSource = (file) => fs.readFileSync(path.join(REPO, file), 'utf8')) {
  const errors = [];
  for (const store of registry.stores.filter((candidate) => candidate.rule === 'existing')) {
    const pattern = renderSourcePattern(store);
    let text = null;
    try { text = readSource(store.source.file); } catch { /* reported below */ }
    if (text === null) errors.push(`${REGISTRY_FILE} store ${store.id}: source file ${store.source.file} cannot be read`);
    else if (!text.includes(pattern)) errors.push(`${REGISTRY_FILE} store ${store.id}: '${pattern}' is absent from ${store.source.file}`);
  }
  return errors;
}

/** The `| Store | Location | Bound |` table of the reference: `[{ line, id, bound }]` and the header line. */
function parseDocsTable(markdown) {
  const lines = markdown.split('\n');
  const header = lines.findIndex((line) => line.trim() === DOCS_HEADER);
  if (header === -1) return { header: 0, rows: [] };
  const rows = [];
  for (let index = header + 2; index < lines.length && lines[index].trim().startsWith('|'); index++) {
    const cells = lines[index].trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    rows.push({ line: index + 1, id: cells[0].replace(/`/g, ''), bound: cells[2] });
  }
  return { header: header + 1, rows };
}

/** IC-020 (d): the table equals IC-002 by id set and by `formatBound()` text. */
function checkDocsTable(registry, markdown) {
  const errors = [];
  const { header, rows } = parseDocsTable(markdown);
  if (header === 0) return [`${DOCS_FILE}: no table headed '${DOCS_HEADER}'`];
  const expected = new Map(registry.stores.filter((store) => store.rule !== 'control').map((store) => [store.id, store]));
  const seen = new Set();
  for (const row of rows) {
    const store = expected.get(row.id);
    if (!store) errors.push(`${DOCS_FILE}:${row.line} row '${row.id}' names no pruned or existing store in ${REGISTRY_FILE}`);
    else if (seen.has(row.id)) errors.push(`${DOCS_FILE}:${row.line} ${REGISTRY_FILE} store ${row.id}: listed twice`);
    else if (row.bound !== formatBound(store)) errors.push(`${DOCS_FILE}:${row.line} ${REGISTRY_FILE} store ${row.id}: bound '${row.bound}' differs from '${formatBound(store)}'`);
    seen.add(row.id);
  }
  for (const id of expected.keys()) {
    if (!seen.has(id)) errors.push(`${DOCS_FILE}:${header} ${REGISTRY_FILE} store ${id}: has no row`);
  }
  return errors;
}

// --- Part (e): no network or process -----------------------------------------------------------

function checkStorageImports(files) {
  const errors = [];
  for (const [file, text] of files) {
    for (const mod of FORBIDDEN_MODULES) {
      if (new RegExp(`require\\(\\s*['"](?:node:)?${mod}['"]\\s*\\)|from\\s+['"](?:node:)?${mod}['"]`).test(text)) errors.push(`${file} requires node:${mod}`);
    }
  }
  return errors;
}

// --- Tests -------------------------------------------------------------------------------------

const registry = loadStorageRegistry({ repoRoot: REPO });

// `age` walks directory children. Applying it to files silently ignores ENOTDIR,
// so no file is ever selected; file stores need a file-compatible retention rule.
function checkRuleEntries(registry) {
  return registry.stores.filter((store) => store.entry === 'file' && store.rule === 'age')
    .map((store) => `${REGISTRY_FILE} store ${store.id}: entry:file cannot use directory-only rule:age`);
}

test('G26: file stores never use the directory-only age rule', () => {
  assert.deepEqual(checkRuleEntries(registry), []);
});

test('G26 self-test: a fixture file store with rule:age is rejected', () => {
  const fixture = structuredClone(registry);
  const store = fixture.stores.find((entry) => entry.id === 'verification-v0');
  store.rule = 'age';
  const errors = checkRuleEntries(fixture);
  assert.deepEqual(errors, [`${REGISTRY_FILE} store verification-v0: entry:file cannot use directory-only rule:age`]);
});

test('G26: verification-v0 uses mtime and requires both age and count for failed-first files', (t) => {
  const { tempDir } = require('../helper/tmp');
  const { selectCandidates } = require('../../src/runtime/storage/rules.ts');
  const dir = tempDir(t, 'doflow-rb-storage-age-');
  const store = registry.stores.find((entry) => entry.id === 'verification-v0');
  const day = 86400000, now = Date.parse('2026-10-10T12:00:00Z');
  const oldest = 'failed-first-0000000000000000.json';
  const touch = (name, time) => fs.utimesSync(path.join(dir, name), new Date(time), new Date(time));
  const put = (name, time) => { fs.writeFileSync(path.join(dir, name), '{}'); touch(name, time); };
  const entries = () => fs.readdirSync(dir).map((name) => ({ name, stat: fs.statSync(path.join(dir, name)) }));
  const select = (time, list = entries()) => selectCandidates(store, list, { now: time, fsImpl: fs, storeDir: dir, roots: {} });

  put(oldest, now - day);
  for (let index = 1; index <= store.bound.keepNewest; index++) {
    put(`failed-first-${index.toString(16).padStart(16, '0')}.json`, now - day / 2);
  }
  // First prune while every entry is recent. The old rule removes a recent file by count,
  // leaving only keepNewest files, then returns [] below instead of selecting the old file.
  const recent = select(now);
  for (const entry of recent) fs.unlinkSync(path.join(dir, entry.name));
  const later = now + 29 * day;
  for (const name of fs.readdirSync(dir)) if (name !== oldest) touch(name, later - day);
  const oldMtime = fs.statSync(path.join(dir, oldest)).mtimeMs;
  const selected = select(later);
  assert.deepEqual(selected.map((entry) => entry.name), [oldest]);
  assert.equal(selected[0].mtimeMs, oldMtime);
  assert.deepEqual(recent, [], 'a one-day-old file beyond keepNewest must survive');
  assert.deepEqual(select(later, entries().reverse()), selected, 'mtime ordering must not depend on directory order');
  assert.deepEqual(select(later, entries().filter((entry) => entry.name === oldest)), [], 'age alone must not remove a kept entry');

  touch(oldest, later - store.bound.maxAgeDays * day);
  assert.deepEqual(select(later), [], 'an entry exactly at maxAgeDays must survive');
  touch(oldest, later - day);
  assert.deepEqual(select(later), [], 'recent overflow must survive');
});

test('G26 (a): the storage registry has the IC-001 shape', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));
  const validation = validateStorageRegistry(raw);
  assert.deepEqual(validation.errors, []);
  const ids = raw.stores.map((store) => store.id);
  assert.equal(new Set(ids).size, ids.length, 'store ids collide');
  for (const store of raw.stores) assert.doesNotThrow(() => new RegExp(store.match), `store ${store.id} field match does not compile`);
});

test('G26: verification-runs is a per-task record pruned only after finished work', () => {
  const store = registry.stores.find((entry) => entry.id === 'verification-runs');
  assert.ok(store, 'the verify report writer has a declared state store');
  assert.deepEqual({ root: store.root, path: store.path, entry: store.entry, rule: store.rule, bound: store.bound, writers: store.writers }, {
    root: 'project-state',
    path: 'verification/runs',
    entry: 'record',
    rule: 'work',
    bound: { finishedDays: 30 },
    writers: ['src/runtime/verification/engine.ts'],
  });
});

test('G26: roadmap declares its intent writer and inherits dispatch retention', () => {
  const store = registry.stores.find((entry) => entry.id === 'roadmap');
  const dispatch = registry.stores.find((entry) => entry.id === 'dispatch');
  assert.ok(store, 'roadmap intent phases need a declared store');
  assert.equal(store.root, 'project-state');
  assert.equal(store.path, 'roadmap');
  assert.equal(store.rule, 'work');
  assert.deepEqual(store.bound, dispatch.bound);
  assert.ok(store.writers.includes('src/runtime/roadmap/merge.ts'));
});

test('G26: roadmap pruning keeps old open intents and selects only archived done intents', (t) => {
  const { tempDir } = require('../helper/tmp');
  const { selectCandidates } = require('../../src/runtime/storage/rules.ts');
  const { workStatus } = require('../../src/runtime/storage/work-status.ts');
  const root = tempDir(t, 'doflow-roadmap-retention-');
  const state = path.join(root, '.doflow/state');
  const storeDir = path.join(state, 'roadmap');
  const store = registry.stores.find((entry) => entry.id === 'roadmap');
  const plan = path.join(root, 'agent-docs/doflow/113-toy');
  fs.mkdirSync(plan, { recursive: true }); fs.writeFileSync(path.join(plan, 'plan.md'), '- [x] A.1 done\n');
  fs.mkdirSync(path.join(storeDir, 'intents'), { recursive: true });
  fs.mkdirSync(path.join(storeDir, 'done'), { recursive: true });
  for (const name of ['intents/113.json', 'done/113.json']) {
    const file = path.join(storeDir, name);
    fs.writeFileSync(file, JSON.stringify({ schema: 1, row: '113', slug: '113-toy', phase: 'cleaned' }));
    fs.utimesSync(file, new Date(0), new Date(0));
  }
  const openStatus = workStatus({ projectRoot: root, store: 'roadmap', taskId: '113', namespace: 'intents', mtimeMs: 0, fsImpl: fs });
  assert.deepEqual({ state: openStatus.state, reason: openStatus.reason }, { state: 'open', reason: 'roadmap-intent-open' });
  const doneStatus = workStatus({ projectRoot: root, store: 'roadmap', taskId: '113', namespace: 'done', mtimeMs: 0, fsImpl: fs });
  assert.deepEqual({ state: doneStatus.state, since: doneStatus.since }, { state: 'finished', since: 0 });
  const entries = fs.readdirSync(storeDir).map((name) => ({ name, stat: fs.statSync(path.join(storeDir, name)) }));
  const selected = selectCandidates(store, entries, { now: Date.parse('2026-10-19'), fsImpl: fs,
    storeDir, roots: { 'project-state': state }, settings: registry.settings });
  assert.equal(selected.some((entry) => entry.name === 'intents/113.json'), false,
    'a cleaned intent remains open until the archive move');
  assert.deepEqual(selected.map((entry) => entry.name), ['done/113.json'], 'only the done namespace is eligible for pruning');
});

test('G26 (b): every file with a write call is declared, and every declared writer writes', () => {
  assert.deepEqual(checkWriters(registry, scanShippedWriters()), []);
});

test('G26 (c): every path a sandbox run produces maps to a declaration, and every pruned or control store is exercised', { timeout: 240000 }, (t) => {
  const scenario = runScenario();
  t.diagnostic(`G26 scenario wall time ${scenario.wallMs} ms`);
  assert.deepEqual(scenario.failures, []);
  assert.deepEqual(checkLocations(scenario.registry, scenario.roots, scenario.observations, scenario.displayRoot), []);
});

test('G26 (d): existing-store sources hold their bound, and the reference table equals the registry', () => {
  assert.deepEqual(checkExistingSources(registry), []);
  assert.deepEqual(checkDocsTable(registry, fs.readFileSync(path.join(REPO, DOCS_FILE), 'utf8')), []);
});

test('G26 (e): no storage module can reach the network or spawn a process', () => {
  const files = walkFiles('src/runtime/storage').map((file) => [file, fs.readFileSync(path.join(REPO, file), 'utf8')]);
  assert.ok(files.length > 0);
  assert.deepEqual(checkStorageImports(files), []);
});

// --- Self-tests: the checks fail on bad input ---------------------------------------------------

test('G26 self-test: a new writer without a declared retention fails, naming file and line', () => {
  const hits = new Map([['src/runtime/new-writer.js', writeCalls('src/runtime/new-writer.js', "const fs = require('node:fs');\nfs.writeFileSync(target, text);\nfs.linkSync(temp, target);\n")]]);
  assert.deepEqual(hits.get('src/runtime/new-writer.js'), [{ line: 2, call: 'writeFileSync' }, { line: 3, call: 'linkSync' }]);
  const errors = checkWriters(registry, hits, () => true).join('\n');
  assert.match(errors, /src\/runtime\/new-writer\.js:2 writeFileSync is in no store's writers/);
  assert.match(errors, /src\/runtime\/new-writer\.js:3 linkSync is in no store's writers/, 'every call is reported, not only the first');
  assert.equal(firstWriteCall('x.js', 'fs.unlinkSync(a);\nfs.symlinkSync(a, b);\n').call, 'symlinkSync', 'unlinkSync is a removal, not a write');
  const stale = checkWriters(registry, new Map(), () => false);
  assert.ok(stale.some((message) => message.includes('does not exist')));
});

test('G26 self-test: the scanner reads every file as text and tells bash writes from quoted text', () => {
  assert.deepEqual(firstWriteCall('x.js', 'const a = 1;\u0000\nfs.mkdirSync(d);\n'), { line: 2, call: 'mkdirSync' });
  assert.equal(firstWriteCall('x.js', '// fs.writeFileSync(a)\n/* fs.mkdir(a) */\n * fs.cpSync(a)\n'), null);
  assert.equal(firstWriteCall('x.sh', 'echo "a > b"; jq \'length > 0\' f 2>/dev/null; cat f >&2; x=1 # mkdir d\ncat <<EOF\nmkdir hidden\nEOF\n'), null);
  assert.deepEqual(firstWriteCall('x.sh', 'a=1\nd="$(mktemp -d)"\n'), { line: 2, call: 'mktemp' });
  assert.deepEqual(firstWriteCall('x.sh', 'echo hi > out.txt\n'), { line: 1, call: '> out.txt' });
  assert.deepEqual(firstWriteCall('run', '#!/bin/sh\nprintf x >> log\n'), { line: 2, call: '>> log' });
  assert.equal(firstWriteCall('data.json', 'mkdir(x)'), null);
});

test('G26 self-test: a path no declaration covers fails, naming the path and the step', () => {
  const sandbox = '/sandbox';
  const roots = resolveRoots({ registry, projectRoot: `${sandbox}/project`, env: { HOME: `${sandbox}/home`, XDG_CONFIG_HOME: `${sandbox}/xdg` } });
  const mapped = [
    `${sandbox}/xdg/doflow/sessions.log.lock.d`, `${sandbox}/xdg/doflow/sessions.log.ab12cd`, `${sandbox}/project/.doflow/state/evidence/t.json.lock`,
    `${sandbox}/project/.doflow/state`, `${sandbox}/project/.doflow/state/verification`, `${sandbox}/project/.doflow/doflow.lock`,
  ].map((file) => ({ file, step: 'fixture' }));
  const errors = checkLocations(registry, roots, [...mapped, { file: `${sandbox}/project/.doflow/state/stray.dat`, step: 'fixture step' }], sandbox);
  assert.ok(errors.includes('project/.doflow/state/stray.dat written by fixture step'), errors.join('\n'));
  assert.equal(errors.filter((message) => message.includes(' written by ')).length, 1, errors.join('\n'));
  assert.ok(errors.includes('store verification-logs not exercised'));
  assert.ok(!errors.some((message) => message.startsWith('store sessions-log') || message.startsWith('store task-locks')));
});

test('G26 self-test: a docs row with a different bound fails, naming the line and the store', () => {
  const rows = registry.stores.filter((store) => store.rule !== 'control').map((store) => `| \`${store.id}\` | somewhere | ${formatBound(store)} |`);
  const table = (lines) => ['intro', DOCS_HEADER, '|---|---|---|', ...lines, '', 'after'].join('\n');
  assert.deepEqual(checkDocsTable(registry, table(rows)), []);
  const changed = [...rows];
  changed[0] = changed[0].replace(/\| [^|]+ \|$/, '| keep newest 41; prune entries older than 30 days |');
  const errors = checkDocsTable(registry, table(changed));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /docs\/reference\.md:4 core\/registry\/storage\.json store verification-logs: bound 'keep newest 41/);
  assert.match(checkDocsTable(registry, table(rows.slice(1))).join('\n'), /store verification-logs: has no row/);
  assert.match(checkDocsTable(registry, 'no table here').join('\n'), /no table headed/);
});

test('G26 self-test: an existing-store source without its bound fails, and a network import is named', () => {
  const store = registry.stores.find((candidate) => candidate.rule === 'existing' && candidate.source.pattern.includes('{value}'));
  const errors = checkExistingSources(registry, () => 'nothing relevant');
  assert.ok(errors.some((message) => message.includes(`store ${store.id}`) && message.includes(REGISTRY_FILE)));
  assert.deepEqual(checkStorageImports([['src/runtime/storage/x.js', "const net = require('node:net');\nconst cp = require('child_process');\n"]]),
    ['src/runtime/storage/x.js requires node:net', 'src/runtime/storage/x.js requires node:child_process']);
});

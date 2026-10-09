'use strict';

// The prompt-nudge decision program (IC-005): one jq run over the hook payload that prints `nudge`,
// `suppress` or an empty line, reading its rules from the registry's `promptNudge` object. Each case
// spawns the exact invocation the hook uses against the shipped registry (or a scratch copy of it)
// and asserts the one output line; a non-zero jq exit fails the case unless the case expects it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const PROGRAM = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'prompt-nudge.jq');
const REGISTRY = path.join(REPO, 'core', 'registry', 'workflows.json');
const HAS_JQ = (() => {
  const r = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
})();

const scratch = createScratch('doflow-prompt-nudge-decision-');
test.after(() => scratch.remove());

/** Runs IC-005's invocation: payload on stdin, registry slurped as $R. */
function run(payload, registry = REGISTRY) {
  return spawnSync('jq', ['-r', '--slurpfile', 'R', registry, '-f', PROGRAM], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: scratch.env(),
    encoding: 'utf8',
  });
}

/** The program's single output line for `payload`; any jq error fails the calling case. */
function verdict(payload, registry) {
  const r = run(payload, registry);
  assert.equal(r.status, 0, `jq exited ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /^(nudge|suppress|)\n$/, `not exactly one decision line: ${JSON.stringify(r.stdout)}`);
  return r.stdout.slice(0, -1);
}

function decide(prompt, registry) {
  return verdict({ session_id: 's1', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt }, registry);
}

let copies = 0;
/** A scratch copy of the shipped registry with `promptNudge` changed by `edit`; returns its path. */
function registryWith(edit) {
  const doc = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  edit(doc.promptNudge, doc);
  const file = path.join(scratch.dir, `workflows-${copies++}.json`);
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

const LOG = [
  'Traceback (most recent call last):',
  '  File "worker.py", line 12, in run',
  '    raise TimeoutError("upstream took too long")',
  'TimeoutError: upstream took too long',
].join('\n');

test('prompt-nudge decision (IC-005)', { skip: HAS_JQ ? false : 'jq is not installed' }, async (t) => {
  await t.test('step 2: a /do command token suppresses, even below the length floor', () => {
    assert.equal(decide('fix src/a.js then run /do-plan'), 'suppress');
    assert.equal(decide('/do'), 'suppress');
    assert.equal(decide('please use `/do` for this'), 'suppress');
  });

  await t.test('step 2: a path segment that starts with do is not a /do token', () => {
    assert.equal(decide('move src/domain/a.js into lib/'), 'nudge');
  });

  await t.test('step 3: shorter than minChars is empty, at minChars it is judged', () => {
    assert.equal(decide('fix a.js'), '');
    assert.equal(decide('fix lib/a.js'), 'nudge');
  });

  await t.test('step 4: each excluded prefix gives empty', () => {
    assert.equal(decide('fix the parser in src/a.js'), 'nudge');
    for (const prefix of ['/', '$', '!', '#', '@', '>']) {
      assert.equal(decide(`${prefix}fix the parser in src/a.js`), '', `prefix ${prefix}`);
    }
  });

  await t.test('step 5: a stall word with trailing punctuation gives empty', () => {
    assert.equal(decide('thanks!'), '');
    assert.equal(decide('sounds good!! '), '');
    assert.equal(decide('fix the parser!!'), 'nudge');
    const stalled = registryWith((n) => { n.stallWords.push('fix the parser'); });
    assert.equal(decide('fix the parser!!', stalled), '');
  });

  await t.test('step 6: a trailing question mark, spaces allowed, gives empty', () => {
    assert.equal(decide('fix the parser in src/a.js ?   '), '');
    assert.equal(decide('fix the parser in src/a.js?'), '');
  });

  await t.test('step 7: an excludeContainsPhrases entry gives empty', () => {
    assert.equal(decide('fix the parser in src/a.js but don\'t change the tests'), '');
  });

  await t.test('step 8: the first and the last non-empty lines are judged', () => {
    assert.equal(decide(`fix the timeout handling in worker.py\n\n${LOG}\n`), 'nudge', 'request on the first line');
    assert.equal(decide(`${LOG}\n\nadd a retry to worker.py`), 'nudge', 'request on the last line');
    assert.equal(decide('add a retry to the upload client'), 'nudge', 'one line');
    assert.equal(decide(`see below\nadd a retry to worker.py\n${LOG}`), '', 'a middle line is not judged');
  });

  await t.test('step 9: nothing qualifies gives empty', () => {
    assert.equal(decide('the build went red after the last merge'), '');
  });

  await t.test('line test 1: a judged line ending in ? does not qualify', () => {
    assert.equal(decide('fix the parser in src/a.js?\nthat is all I wonder about'), '');
    assert.equal(decide('fix the parser in src/a.js\nthat is all I wonder about'), 'nudge');
  });

  await t.test('line test 2: an excludeStartWords entry blocks even a listed verb', () => {
    const verb = registryWith((n) => { n.verbs.push('explain'); });
    const both = registryWith((n) => {
      n.verbs.push('explain');
      n.excludeStartWords = n.excludeStartWords.filter((w) => w !== 'explain');
    });
    assert.equal(decide('explain the parser in src/a.js'), '');
    assert.equal(decide('explain the parser in src/a.js', verb), '');
    assert.equal(decide('explain the parser in src/a.js', both), 'nudge');
  });

  await t.test('line test 3: the line must start with a verb as a whole word', () => {
    assert.equal(decide('the parser in src/a.js needs a fix'), '');
    assert.equal(decide('fixed the parser in src/a.js'), '');
  });

  await t.test('line test 4: an object blocker right after the verb', () => {
    assert.equal(decide('update me on the build for src/a.js'), '');
    assert.equal(decide('update the build for src/a.js'), 'nudge');
  });

  await t.test('line test 5: a context blocker anywhere in the line', () => {
    assert.equal(decide('write a commit message for src/a.js'), '');
    assert.equal(decide('write a test for src/a.js'), 'nudge');
  });

  await t.test('line test 6: a plural noun counts', () => {
    assert.equal(decide('remove the unused params'), 'nudge');
    assert.equal(decide('remove the unused stuff'), '');
  });

  await t.test('lead-ins: a run of lead-ins, each with an optional comma, is skipped', () => {
    assert.equal(decide('ok, please, now fix the parser'), 'nudge');
    assert.equal(decide('go ahead and add a retry to the upload client'), 'nudge');
  });

  await t.test('maxScanChars: a noun only past the cut does not count', () => {
    assert.equal(decide(`fix ${'the '.repeat(50)}parser`), 'nudge');
    assert.equal(decide(`fix ${'the '.repeat(110)}parser`), '');
  });

  await t.test('line test 6: a path matched only by pathPattern counts', () => {
    assert.equal(decide('fix the thing in lib/upload.js'), 'nudge');
    assert.equal(decide('fix the thing in uploadFile'), 'nudge');
    assert.equal(decide('fix the thing over there'), '');
  });

  await t.test('CRLF input is read as LF', () => {
    assert.equal(decide('the log:\r\nerror at line 3\r\nfix the parser in src/a.js\r\n'), 'nudge');
    assert.equal(decide('fix the parser in src/a.js ?\r\n'), '');
  });

  await t.test('a prompt that is absent, not a string, or whitespace gives empty', () => {
    assert.equal(verdict({ session_id: 's1', cwd: '/tmp' }), '');
    assert.equal(verdict({ session_id: 's1', prompt: 42 }), '');
    assert.equal(verdict({ session_id: 's1', prompt: null }), '');
    assert.equal(decide(' \n\t \r\n '), '');
    assert.equal(verdict('[1,2]'), '');
  });

  await t.test('a 20 KB prompt with the request on its first line is decided', (tt) => {
    const filler = `${LOG}\n`.repeat(Math.ceil(20480 / (LOG.length + 1)));
    const prompt = `add a retry to the upload client\n${filler}`;
    assert.ok(prompt.length >= 20480);
    const started = process.hrtime.bigint();
    assert.equal(decide(prompt), 'nudge');
    tt.diagnostic(`prompt-nudge decision on ${prompt.length} chars: ${Number(process.hrtime.bigint() - started) / 1e6} ms`);
  });

  await t.test('a 20 KB interior whitespace run stays linear (no regex retry from every position)', () => {
    const prompt = `fix the parser${' '.repeat(20000)}x`;
    const started = process.hrtime.bigint();
    assert.equal(decide(prompt), 'nudge');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // A quadratic trim took 1.7 s here; linear is about 20 ms. Timing is not asserted on Windows (RK4).
    if (process.platform !== 'win32') assert.ok(ms < 1000, `took ${ms} ms`);
  });

  await t.test('FR-010: one extra verb in the registry changes the decision with no program change', () => {
    assert.equal(decide('harden the parser in src/a.js'), '');
    assert.equal(decide('harden the parser in src/a.js', registryWith((n) => { n.verbs.push('harden'); })), 'nudge');
  });

  await t.test('list entries are matched literally, not as regexes', () => {
    const dotted = registryWith((n) => { n.verbs.push('re.do'); });
    assert.equal(decide('re.do the parser in src/a.js', dotted), 'nudge');
    assert.equal(decide('rexdo the parser in src/a.js', dotted), '');
  });

  await t.test('a pathPattern that does not compile makes jq exit non-zero', () => {
    const r = run({ prompt: 'fix the parser in src/a.js' }, registryWith((n) => { n.pathPattern = '('; }));
    assert.notEqual(r.status, 0);
    const short = run({ prompt: 'ok' }, registryWith((n) => { n.pathPattern = '('; }));
    assert.notEqual(short.status, 0, 'the pattern is checked on every prompt, not only when a line reaches it');
  });

  await t.test('a registry without promptNudge, or with a mistyped field, makes jq exit non-zero', () => {
    assert.notEqual(run({ prompt: 'fix the parser in src/a.js' }, registryWith((n, doc) => { delete doc.promptNudge; })).status, 0);
    assert.notEqual(run({ prompt: 'fix the parser in src/a.js' }, registryWith((n) => { n.minChars = '12'; })).status, 0);
    assert.notEqual(run({ prompt: 'fix the parser in src/a.js' }, registryWith((n) => { n.excludePrefixes = '/'; })).status, 0);
  });

  await t.test('program constraints: no input, environment or post-1.5 builtin, every if has an else', () => {
    const code = fs.readFileSync(PROGRAM, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const banned = /(?<![\w$@])(input|inputs|input_filename|env|debug|stderr|IN|INDEX|trim|ltrim|rtrim|pick|abs|toarray|splits|halt_error|walk|utf8bytelength|have_decnum)(?!\w)|\$ENV|\$__loc__|@sh|\?\/\//;
    const hit = code.match(banned);
    assert.equal(hit, null, `banned construct: ${hit && hit[0]}`);
    assert.equal((code.match(/\bif\b/g) || []).length, (code.match(/\belse\b/g) || []).length, 'if without else');
  });
});

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

  await t.test('office and document artifacts stay silent even beside a word that is also a code noun', () => {
    const silent = [
      'Build a spreadsheet formula that sums column B wherever column A says paid.',
      'Create an excel formula that looks up the key in column C of the table',
      'Write a worksheet function that totals each row',
      'Build a PowerPoint with a table and a chart for each column',
      'Create a workbook with one sheet per key and a column for totals',
      'Build a spreadsheet with a column for each field',
      'Make a google doc with a table of the function names',
      'Write an itinerary table with a column for each day',
      'Make a playlist for the road trip with a row for each key',
      'Draft a cover letter template with a field for the company name',
      'Write a newsletter template with a table of contents field',
      'Build a slide deck with a table of the results by column',
      'Update my résumé template, the header field needs a new row',
      'Create an invoice for the client with a row for each field',
    ];
    const nudged = silent.filter((p) => decide(p) !== '');
    assert.deepEqual(nudged, [], 'office or document requests that nudged');
  });

  await t.test('real code requests that share words with the office family still nudge', () => {
    const nudge = [
      'add a column to the orders table in migrations/002_orders.sql',
      'rename the template field in billing/email_template.py',
      'fix the pivot table query in reports/pivot.py',
      'add a spreadsheet export function to src/report.py',
      'fix the resume handling in src/download.js',
      'add an invoice total column to billing/invoice.py',
      'implement the playlist shuffle function in src/player.js',
      'add a worksheet parser to lib/xlsx_reader.py',
      'add a key column to the sheet model in app/models.py',
    ];
    const silent = nudge.filter((p) => decide(p) !== 'nudge');
    assert.deepEqual(silent, [], 'code requests that lost their nudge');
  });

  await t.test('personal sheet, budget and list requests stay silent even beside a word that is also a code noun', () => {
    const silent = [
      'Add a column to my budget sheet that sums the rows above it.',
      'Add a column for notes to the budget sheet',
      'Rename the column headers in the sales sheet',
      'Fix the totals column in this sheet',
      'Add a row for rent to my budget table',
      'Rename the key column in my sheet',
      'Remove the duplicate rows from the budget sheet',
      'Add a field for the due date to my budget list',
      'Update the rows in this sheet so totals match',
    ];
    const nudged = silent.filter((p) => decide(p) !== '');
    assert.deepEqual(nudged, [], 'personal sheet or budget requests that nudged');
  });

  await t.test('code requests that share sheet and budget words still nudge', () => {
    const nudge = [
      'add a style sheet loader to src/theme.ts',
      'rename the sheet_name parameter in lib/xlsx_reader.py',
      'add a column to the budget table in db/schema.sql',
      'fix the budget calculation in src/budget.py',
      'update the sheet model in app/models.py',
      'add a sheet parameter to the export function in lib/xlsx.py',
      'fix the budget sheet renderer in src/ui/BudgetSheet.tsx',
      'rename the sales column in the report table in reports/sales.sql',
    ];
    const lost = nudge.filter((p) => decide(p) !== 'nudge');
    assert.deepEqual(lost, [], 'code requests that lost their nudge');
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

// ── differential: the bounded program against the whole-prompt one ─────────────
//
// prompt-nudge.jq avoids whole-prompt lowercasing and per-line work so its cost does not grow
// with the prompt (G.2). OLD_PROGRAM is the program as it stood before that change (commit
// 73fb7b4), verbatim, which applied IC-005's steps to the whole prompt literally. Both must give
// the same answer on every corpus prompt and on long variants of them; the whitespace-padded
// variants must also give the short form's answer.
const OLD_PROGRAM = String.raw`# prompt-nudge.jq — decision program for the standalone-prompt nudge (IC-005)
#
# Invocation, identical in the UserPromptSubmit hook and in the corpus runner:
#   printf '%s' "$INPUT" | jq -r --slurpfile R <registry> -f prompt-nudge.jq
# Input is the hook payload on stdin; $R[0] is core/registry/workflows.json and its
# ${'`'}promptNudge${'`'} object holds every rule (IC-007). Output is one line: ${'`'}nudge${'`'}, ${'`'}suppress${'`'},
# or empty. jq exits non-zero only on an error, and the caller treats that as silence.
#
# The rules are data; this file is the algorithm. It reads only ${'`'}.${'`'} and $R[0].promptNudge,
# keeps no state, and gives the same output for the same input. A missing or mistyped
# rule, or a pathPattern that does not compile, is an error on every prompt, never a default.
#
# Portability: jq 1.5 built with Oniguruma. No builtin newer than 1.5 (no IN, trim, pick,
# abs, toarray, splits, $__loc__, halt_error), no if without else, no input or environment.
# Only the step 2 pattern and pathPattern are regexes; every list entry is matched literally.
# Whole-prompt anchors use \A and \z so a newline inside the prompt never ends a match.

# Whitespace removed from both ends. The trailing match may start only where a whitespace run
# starts: a plain \s+$ retries from every position of a long interior run, which is quadratic
# (a 20 KB run of spaces took 1.7 s).
def strip_ws: sub("^\\s+"; "") | sub("(?<!\\s)\\s+$"; "");

# A list entry with every regex metacharacter escaped. An empty entry makes ${'`'}add${'`'} null and
# ${'`'}implode${'`'} fail, so an empty entry is an error rather than a pattern that matches anything.
def esc:
  ("\\.*+?()[]{}|^$" | explode) as $meta
  | explode
  | map(. as $c | if any($meta[]; . == $c) then [92, $c] else [$c] end)
  | add
  | implode;

def string_list($v; $name):
  if ($v | type) == "array" and ($v | length) > 0 and all($v[]; type == "string")
  then $v
  else error("promptNudge.\($name) is not a non-empty list of strings")
  end;

def int($v; $name):
  if ($v | type) == "number" and $v == ($v | floor)
  then $v
  else error("promptNudge.\($name) is not an integer")
  end;

# One alternation of literal entries, for use inside (?: ... ).
def alt($v; $name): string_list($v; $name) | map(esc) | join("|");

# The line test: one line, already trimmed and non-empty, judged against the compiled rules.
def line_ok($re):
  .[0:$re.maxScan] as $l
  | ($l | ascii_downcase | sub($re.lead; "")) as $ll
  | ($ll | sub($re.verb; "")) as $after
  | ($ll | test("\\?\\s*$") | not)
    and ($ll | test($re.startWord) | not)
    and ($ll | test($re.verb))
    and ($after | test($re.objectBlocker) | not)
    and ($ll | test($re.contextBlocker) | not)
    and (($after | test($re.noun)) or ($l | test($re.path)));

($R[0].promptNudge) as $n
| if ($n | type) == "object" then . else error("promptNudge is missing or not an object") end
| {
    minChars: int($n.minChars; "minChars"),
    maxScan: int($n.maxScanChars; "maxScanChars"),
    prefixes: string_list($n.excludePrefixes; "excludePrefixes"),
    phrases: string_list($n.excludeContainsPhrases; "excludeContainsPhrases"),
    stall: ("\\A(?:" + alt($n.stallWords; "stallWords") + ")[[:punct:]\\s]*\\z"),
    lead: ("^(?:(?:" + alt($n.leadIns; "leadIns") + "),?\\s+)+"),
    startWord: ("^(?:" + alt($n.excludeStartWords; "excludeStartWords") + ")\\b"),
    verb: ("^(?:" + alt($n.verbs; "verbs") + ")\\b"),
    objectBlocker: ("^\\s+(?:" + alt($n.objectBlockers; "objectBlockers") + ")\\b"),
    contextBlocker: ("\\b(?:" + alt($n.contextBlockers; "contextBlockers") + ")\\b"),
    noun: ("\\b(?:" + alt($n.nouns; "nouns") + ")s?\\b"),
    path: $n.pathPattern
  } as $re
# pathPattern is compiled here on every prompt, so a broken pattern never hides behind an
# early return.
| ("" | test($re.path)) as $path_compiles
# Step 1: the prompt as a string, carriage returns removed, trimmed, ASCII-lowercased.
| (if type == "object" then .prompt else null end) as $raw
| (if ($raw | type) == "string" then $raw else "" end | split("\r") | join("") | strip_ws) as $t
| ($t | ascii_downcase) as $lt
# Step 2 runs before the length floor so a short /do-plan also ends evaluation (suppress).
| if ($lt | test("(^|[\\s${'`'}'\"(])/do(-[a-z]+)?\\b")) then "suppress"
  elif ($t | length) < $re.minChars then ""
  elif any($re.prefixes[]; . as $x | $t | startswith($x)) then ""
  elif ($lt | test($re.stall)) then ""
  elif ($lt | endswith("?")) then ""
  elif any($re.phrases[]; . as $x | $lt | contains($x)) then ""
  # Step 8: only the first and the last non-empty lines are judged.
  elif ([$t | split("\n")[] | select(test("\\S"))] | [.[0], .[-1]] | unique
        | any(.[]; strip_ws | line_ok($re))) then "nudge"
  else ""
  end
`;

const PAD_LINE = '2026-10-09T10:00:01 INFO worker[7] processed batch 12 in 12ms (queue=4, retries=0) path=lib/x.py\n';
const pasted = (n) => PAD_LINE.repeat(Math.ceil(n / PAD_LINE.length)).slice(0, n).replace(/\n?$/, '');
const SHAPES = {
  blank: (p, n) => '\n'.repeat(n) + p + '\n'.repeat(n),
  spaces: (p, n) => ' '.repeat(n) + p + ' '.repeat(n),
  'log-mid': (p, n) => `${p}\n${pasted(n)}\n${p}`,
  crlf: (p, n) => `${p}\n${pasted(n)}`.replace(/\n/g, '\r\n'),
  'log-first': (p, n) => `${pasted(n)}\n${p}`,
  'question-end': (p, n) => `${p}\n${pasted(n)}\nis that right?`,
};

/** One jq run over many payloads (one decision line each); the status must be 0. */
function decideAll(program, prompts) {
  const r = spawnSync('jq', ['-r', '--slurpfile', 'R', REGISTRY, '-f', program], {
    input: prompts.map((prompt) => JSON.stringify({ session_id: 's1', cwd: '/tmp', prompt })).join('\n'),
    env: scratch.env(), encoding: 'utf8', maxBuffer: 1 << 26,
  });
  assert.equal(r.status, 0, `jq exited ${r.status}: ${r.stderr}`);
  const lines = r.stdout.split('\n').slice(0, -1);
  assert.equal(lines.length, prompts.length);
  return lines;
}

test('differential: the bounded program answers as the whole-prompt program on the corpus and long variants', { skip: HAS_JQ ? false : 'jq is not installed' }, (t) => {
  const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompt-nudge.corpus.json'), 'utf8'));
  const shapeNames = Object.keys(SHAPES);
  const inputs = [];
  cases.forEach((c, i) => {
    inputs.push({ id: c.id, shape: 'short', prompt: c.prompt });
    // Every case gets one 1 KB variant, the shapes taken in turn; some get every shape at 20 KB and 200 KB.
    const one = shapeNames[i % shapeNames.length];
    inputs.push({ id: c.id, shape: `${one}-1k`, prompt: SHAPES[one](c.prompt, 1024) });
    for (const [size, every] of [[20 * 1024, 37], [200 * 1024, 142]]) {
      if (i % every !== 0) continue;
      for (const name of shapeNames) inputs.push({ id: c.id, shape: `${name}-${size / 1024}k`, prompt: SHAPES[name](c.prompt, size) });
    }
  });
  const oldFile = path.join(scratch.dir, 'prompt-nudge-73fb7b4.jq');
  fs.writeFileSync(oldFile, OLD_PROGRAM);
  const prompts = inputs.map((x) => x.prompt);
  const before = decideAll(oldFile, prompts);
  const after = decideAll(PROGRAM, prompts);
  const short = {};
  inputs.forEach((x, i) => { if (x.shape === 'short') short[x.id] = after[i]; });
  const differ = [];
  const unlikeShort = [];
  inputs.forEach((x, i) => {
    if (before[i] !== after[i]) differ.push(`${x.id} ${x.shape}: ${JSON.stringify(before[i])} -> ${JSON.stringify(after[i])}`);
    if (/^(blank|spaces)-/.test(x.shape) && after[i] !== short[x.id]) unlikeShort.push(`${x.id} ${x.shape}`);
  });
  t.diagnostic(`prompt-nudge differential: ${inputs.length} inputs, ${cases.length} corpus prompts`);
  assert.deepStrictEqual(differ, [], 'answers that changed');
  assert.deepStrictEqual(unlikeShort, [], 'whitespace-padded prompts answered unlike their short form');
});

'use strict';

// Row 171 T6 (IC-005, FR-011..FR-013, D7; design §6): `worker --action conform --harness <id> [--json]`.
//
// Conform checks a built-in or package worker descriptor against a fake binary and names each part that fails.
// Where it runs (§6.1): an OS-temp scratch `doflow-conform-*` holding bin/, home/ and log/, removed in `finally`,
// and on SIGINT or SIGTERM by a handler that kills the running fake, removes the scratch and re-raises the signal.
// The fake is `<scratch>/bin/<cli.binary>` (the name checked by the registry's bare-command pattern first), a
// mode-0700 `#!/bin/sh` wrapper that execs `$DOFLOW_CONFORM_NODE $DOFLOW_CONFORM_FAKE "$@"` (conform-fake.ts).
// Each spawn is by absolute path, `shell: false`, 10 s, with an environment built from nothing: PATH=<scratch>/bin,
// HOME=<scratch>/home, LANG=C.UTF-8 and the DOFLOW_CONFORM_* variables. No real binary or package program runs, no
// caller variable reaches the child, and nothing is written outside the scratch: no telemetry, no store, and the
// CLI runs no storage upkeep after it (`runsUpkeep` in src/cli/runtime-commands.ts).
//
// Parts, in order (§6.2): binary, one-shot, prompt-transport, model-flag, main-session, stream, login. A part is
// `unchecked: not-declared` when its entry is not `supported`, and `unchecked: depends-on <part>` when a part it
// needs failed. The stream cases are synthesized from the field map (§6.3); a code parser leaves stream
// `unchecked: code-parser`. Exit (§6.4): 0 when no part failed, 1 naming each failed part, 2 for
// `unknown-harness`, `platform-unsupported` or `scratch-failed`. Each reason is cut to 160 characters, a refusal's
// message to 512 and an echoed harness or parser id to 64; when the answer, `--json` or text, is still over 4 KiB the
// reasons are cut further until it fits.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { workerCatalogue } = require('./catalogue.ts');
const { assembleArgv, mainArgv, promptInput, refuseUnknownMainParser } = require('./launch.ts');
const { PARSERS, parserOf, parserIdOf, UNPARSED } = require('./parsers.ts');
const { compileFieldMap, compileTest } = require('./parsers/field-map.ts');
const { cutChars } = require('./parsers/common.ts');
const { BARE_COMMAND } = require('../../registry/index.ts');
const { exitFact } = require('./readiness.ts');
const { wideningProblem, wideningFlagsProblem } = require('../../registry/widening-flags.ts');
const { secretProblem, secretFlagsProblem } = require('../../registry/secret-flags.ts');
const { checkLogin, loginExpiredOf } = require('./login.ts');

const PARTS = Object.freeze(['binary', 'one-shot', 'prompt-transport', 'model-flag', 'provider', 'effort', 'main-session', 'stream', 'login']);
const FAKE = path.join(__dirname, 'conform-fake.ts');
const TIMEOUT_MS = 10000;
const REASON_CHARS = 160;
const MESSAGE_CHARS = 512;
const NAME_CHARS = 64;
const ANSWER_BYTES = 4096;
const STDOUT_MAX = 4 * 1048576;
const MODEL_ID = 'conform-model-1';
const PROVIDER_ID = 'conform-provider-1';
const EFFORT_ID = 'conform-effort-1';
/** Spaces, both quote kinds, `$`, a backslash, a newline and non-ASCII: any shell or re-encoding on the way shows. */
const MARKER = 'conform marker: \'single\' "double" $HOME \\back\\slash\nsecond line, non-ASCII é ü 漢字';
const LAST_MESSAGE = 'conform last message';

type Result = 'passed' | 'failed' | 'unchecked';
type Part = { part: string; result: Result; reason: string };
type Run = { result: any; log: any; stdout: string };

const part = (name: string, result: Result, reason: string): Part => ({ part: name, result, reason: cutChars(String(reason), REASON_CHARS) });
const supported = (entry: any): boolean => entry?.status === 'supported';
const isArgv = (value: any): boolean => Array.isArray(value) && value.every((item: any) => typeof item === 'string');
const sameArgv = (a: any, b: string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((item, i) => item === b[i]);
const json = (value: any): string => JSON.stringify(value);
const declaredOf = (worker: any) => (Array.isArray(worker.wideningFlags) && wideningFlagsProblem(worker.wideningFlags) === null ? worker.wideningFlags : []);

const describeExit = (result: any): string => (result.status === 'exited'
  ? (result.code === null ? `signal ${result.signal}` : `exit ${result.code}`)
  : (result.status === 'timeout' ? 'timeout' : `spawn-failed ${result.error}`));

/** One spawn of the fake, killed (SIGKILL) after `timeoutMs` or past STDOUT_MAX bytes of stdout. The child is kept
 * in `ctx.child` while it runs, so a signal handler can kill it. Spawning without blocking lets that handler run. */
function spawnFake(ctx: any, argv: string[], env: any, stdin: Buffer, timeoutMs = TIMEOUT_MS): Promise<{ result: any; stdout: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped: string | null = null;
    let settled = false;
    const child = spawn(ctx.fake, argv, { cwd: ctx.home, env, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    ctx.child = child;
    const stop = (why: string) => {
      stopped ??= why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const settle = (result: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.child = null;
      resolve({ result, stdout: Buffer.concat(chunks).toString('utf8') });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDOUT_MAX) stop('ENOBUFS');
      else chunks.push(chunk);
    });
    // A fake that exits before reading closes the pipe; its exit is what counts.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    child.on('error', (error: any) => settle({ status: 'error', code: null, signal: null, error: error?.code || 'spawn-failed' }));
    child.on('close', (code: number | null, signal: string | null) => settle(stopped === 'timeout'
      ? { status: 'timeout', code: null, signal }
      : (stopped ? { status: 'error', code: null, signal: null, error: stopped } : { status: 'exited', code, signal })));
  });
}

/** Runs the fake once with `argv`; the script says what it prints and whether it writes the last-message file, or,
 * with `byArgv`, what it prints and exits with for each argv it may receive (conform-fake.ts). */
async function runFake(ctx: any, argv: string[], { stdin = null, exit = 0, stdout = [], lastMessage = null, byArgv = null, timeoutMs = TIMEOUT_MS }: any = {}): Promise<Run> {
  const n = ctx.spawns++;
  const script = path.join(ctx.dir, 'log', `${n}.script.json`);
  const log = path.join(ctx.dir, 'log', `${n}.log`);
  fs.writeFileSync(script, JSON.stringify({ stdout, lastMessage, lastMessageFile: ctx.lastMessageFile, ...(byArgv ? { byArgv } : {}) }));
  const { result, stdout: out } = await spawnFake(ctx, argv, {
    PATH: ctx.bin, HOME: ctx.home, LANG: 'C.UTF-8',
    DOFLOW_CONFORM_NODE: process.execPath, DOFLOW_CONFORM_FAKE: FAKE, DOFLOW_CONFORM_SCRIPT: script,
    DOFLOW_CONFORM_LOG: log, DOFLOW_CONFORM_EXIT: String(exit),
  }, stdin ?? Buffer.alloc(0), timeoutMs);
  let logged: any = null;
  try {
    logged = JSON.parse(fs.readFileSync(log, 'utf8'));
  } catch {
    logged = null;
  }
  if (logged && typeof ctx.onLog === 'function') ctx.onLog(logged);
  return { result, log: logged, stdout: out };
}

/** The first difference between the argv the fake received and the one expected, or null. */
function argvProblem(run: Run, expected: string[]): string | null {
  if (!run.log) return `the fake logged nothing (${describeExit(run.result)})`;
  if (sameArgv(run.log.argv, expected)) return null;
  return `the fake received ${json(run.log.argv)}, want ${json(expected)}`;
}

/** §6.2 prompt-transport: argv carries the marker as one whole element; stdin carries its exact bytes and argv none of it. */
function transportProblem(entry: any, input: any, log: any): string | null {
  if (entry.promptVia !== 'argv' && entry.promptVia !== 'stdin') return `promptVia ${json(entry.promptVia)} is neither argv nor stdin`;
  const got = Buffer.from(String(log.stdinBase64 || ''), 'base64');
  if (entry.promptVia === 'argv') {
    const hits = log.argv.filter((item: string) => item.includes(MARKER)).length;
    const whole = log.argv.filter((item: string) => item === MARKER).length;
    if (hits !== 1 || whole !== 1) return `the marker arrived in ${hits} argv elements (${whole} whole), want one whole element`;
    if (got.length > 0) return `stdin carried ${got.length} bytes though promptVia is argv`;
    return null;
  }
  if (entry.argv.includes('{prompt}')) return "the argv holds '{prompt}' though promptVia is stdin";
  if (log.argv.some((item: string) => item.includes(MARKER))) return 'the marker is in the argv though promptVia is stdin';
  if (!got.equals(input.stdin)) return `stdin is not the marker byte for byte (${got.length} bytes, want ${input.stdin.length})`;
  return null;
}

// ---- the field-map stream cases (§6.3) ---------------------------------------------------------------------

const plain = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

function read(event: any, at: string[]): { present: boolean; value: any } {
  let current = event;
  for (const segment of at) {
    if (!plain(current) || !Object.hasOwn(current, segment)) return { present: false, value: undefined };
    current = current[segment];
  }
  return { present: true, value: current };
}

/** One `when` test, read as grammar §3.2 reads it. */
function holds(test: any, event: any): boolean {
  const found = read(event, test.path);
  if (!found.present) return false;
  const value = found.value;
  if (Object.hasOwn(test, 'equals')) return value === test.equals;
  if (Object.hasOwn(test, 'in')) return test.in.some((item: any) => item === value);
  switch (test.is) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'count': return Number.isInteger(value) && value >= 0;
    case 'boolean': return typeof value === 'boolean';
    case 'object': return plain(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

function set(event: any, at: string[], value: any): void {
  let current = event;
  for (const segment of at.slice(0, -1)) {
    if (!plain(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[at[at.length - 1]] = value;
}

function placeholder(kind: string, index: number): any {
  switch (kind) {
    case 'number': case 'integer': case 'count': return 1;
    case 'boolean': return true;
    case 'object': return {};
    case 'array': return [];
    case 'null': return null;
    default: return `conform text rules[${index}]`;
  }
}

const samePath = (a: string[], b: string[]): boolean => a.length === b.length && a.every((segment, i) => segment === b[i]);

/** True when `value` at `at` meets every test of `when` on that same path. */
function meetsAll(when: any[], at: string[], value: any): boolean {
  const probe = {};
  set(probe, at, value);
  return when.every((test: any) => !samePath(test.path, at) || holds(test, probe));
}

/**
 * The smallest event that meets rule `index`'s `when`: on each path an `equals` or `in` test names, the first of its
 * values that meets every test on that path (so `equals` and `in` hold together), then a typed placeholder per `is`
 * the event does not meet yet. Incompatible tests on one path are the validator's business; their first value stands.
 */
function eventFor(rule: any, index: number): any {
  const event = {};
  for (const test of rule.when) {
    if (!Object.hasOwn(test, 'equals') && !Object.hasOwn(test, 'in')) continue;
    const values = Object.hasOwn(test, 'equals') ? [test.equals] : test.in;
    const fits = values.find((value: any) => meetsAll(rule.when, test.path, value));
    set(event, test.path, fits === undefined ? values[0] : fits);
  }
  for (const test of rule.when) if (Object.hasOwn(test, 'is') && !holds(test, event)) set(event, test.path, placeholder(test.is, index));
  return event;
}

const firstMatch = (map: any, event: any): number => map.rules.findIndex((rule: any) => rule.when.every((test: any) => holds(test, event)));

/** §6.3: each case is `{name, events: [{event, rule}], exit, lastMessage?, expect}`. */
function streamCases(map: any): any[] {
  const events = map.rules.map((rule: any, i: number) => ({ event: eventFor(rule, i), rule: i }));
  const index = (pred: (then: any) => boolean) => map.rules.findIndex((rule: any) => pred(rule.then));
  const finalAt = index((then) => Boolean(then.final));
  const completedAt = index((then) => then.terminal?.outcome === 'completed');
  const completed = completedAt === -1 ? [] : [events[completedAt]];
  const at = (i: number, pathOf: string[] | undefined) => (pathOf ? read(events[i].event, pathOf).value : null);
  const cases: any[] = [];
  if (finalAt !== -1 && completedAt !== -1) {
    const stream = finalAt === completedAt ? [events[finalAt]] : [events[finalAt], events[completedAt]];
    cases.push({ name: 'success', events: stream, exit: 0, expect: { status: 'success', reason: null, summary: at(finalAt, map.rules[finalAt].then.final) } });
  }
  if (completedAt !== -1 && !map.rules[completedAt].then.final) {
    if (map.finalFallback === 'last-message-file') {
      cases.push({ name: 'success-from-file', events: completed, exit: 0, lastMessage: LAST_MESSAGE, expect: { status: 'success', reason: null, summary: LAST_MESSAGE } });
    } else {
      cases.push({ name: 'no-final', events: completed, exit: 0, expect: { status: 'unparsed', reason: 'no-final-message', summary: null } });
    }
  }
  map.rules.forEach((rule: any, i: number) => {
    const then = rule.then;
    if (then.terminal?.outcome === 'failed') {
      cases.push({ name: `rules[${i}] failed`, events: [events[i]], exit: 1, expect: { status: 'failure', reason: null, summary: at(i, then.terminal.summary) } });
    }
    if (then.streamError) cases.push({ name: `rules[${i}] stream-error`, events: [events[i]], exit: 1, expect: { status: 'failure', reason: 'stream-error', summary: at(i, then.streamError) } });
    if (then.spawn) cases.push({ name: `rules[${i}] spawn`, events: [events[i], ...completed], exit: 0, expect: { status: 'failure', reason: 'spawn-observed' } });
    if (then.denial) cases.push({ name: `rules[${i}] denial`, events: [events[i]], exit: 0, expect: { status: 'denied' } });
  });
  cases.push({ name: 'empty', events: [], exit: 1, expect: { status: 'unparsed', reason: map.missingTerminal, summary: null } });
  const wrongType = {};
  set(wrongType, map.eventType, 7);
  cases.push({ name: 'noise', events: [], lines: ['not json', '{}', JSON.stringify(wrongType)], exit: 0, expect: { ignoredLines: 3 } });
  return cases;
}

async function streamPart(ctx: any, worker: any): Promise<Part> {
  const entry = worker.structuredOutput;
  const map = entry.fieldMap;
  const id = parserIdOf(entry);
  if (!map) {
    if (typeof id === 'string' && Object.hasOwn(PARSERS, id)) return part('stream', 'unchecked', 'code-parser');
    return part('stream', 'failed', `parser ${json(id)} is not in core PARSERS and there is no field map`);
  }
  try {
    compileFieldMap(map);
  } catch (error: any) {
    return part('stream', 'failed', error.message);
  }
  const factory = parserOf(worker, 'structured');
  if (factory.id === UNPARSED) return part('stream', 'failed', `parser '${id}' resolves to unparsed`);
  const argv = isArgv(entry.argv) ? entry.argv.map((item: string) => (item === '{lastMessageFile}' ? ctx.lastMessageFile : item)) : [];
  const cases = streamCases(map);
  const problems: string[] = [];
  for (const c of cases) {
    const shadow = c.events.map(({ event, rule }: any) => ({ first: firstMatch(map, event), rule })).find(({ first, rule }: any) => first !== rule);
    if (shadow) {
      problems.push(shadow.first === -1 || shadow.first > shadow.rule
        ? `${c.name}: no event meets rules[${shadow.rule}]`
        : `${c.name}: shadowed by rules[${shadow.first}]`);
      continue;
    }
    fs.rmSync(ctx.lastMessageFile, { force: true });
    const lines = c.lines ?? c.events.map(({ event }: any) => JSON.stringify(event));
    const run = await runFake(ctx, argv, { exit: c.exit, stdout: lines, lastMessage: c.lastMessage ?? null });
    if (run.result.status !== 'exited' || run.result.code !== c.exit) {
      problems.push(`${c.name}: the fake ended ${describeExit(run.result)}, want exit ${c.exit}`);
      continue;
    }
    const parser = factory.create();
    const out = run.stdout.split('\n');
    if (out[out.length - 1] === '') out.pop();
    for (const line of out) parser.line(line);
    if (typeof parser.lastMessage === 'function' && fs.existsSync(ctx.lastMessageFile)) parser.lastMessage(fs.readFileSync(ctx.lastMessageFile, 'utf8'));
    const report = parser.end();
    const wrong = Object.entries(c.expect).filter(([key, value]) => report[key] !== value);
    if (wrong.length > 0) problems.push(`${c.name}: ${wrong.map(([key, value]) => `${key} ${json(report[key])}, want ${json(value)}`).join(', ')}`);
  }
  if (problems.length > 0) return part('stream', 'failed', problems.join('; '));
  return part('stream', 'passed', `${cases.length} cases`);
}

// ---- the parts ---------------------------------------------------------------------------------------------

async function binaryPart(ctx: any, worker: any): Promise<Part> {
  const name = worker.cli?.binary;
  if (typeof name !== 'string' || !BARE_COMMAND.test(name)) return part('binary', 'failed', `cli.binary is not a bare command name: ${json(name)}`);
  const probe = supported(worker.runnableProbe) ? 'runnableProbe' : 'cli.versionArgv';
  const argv = probe === 'runnableProbe' ? worker.runnableProbe.argv : worker.cli.versionArgv;
  if (!isArgv(argv)) return part('binary', 'failed', `${probe} has no argv`);
  const widening = wideningProblem(argv, { binary: name, declared: declaredOf(worker) });
  if (widening) return part('binary', 'failed', `the ${probe} argv holds the widening flag '${widening}'`);
  ctx.fake = path.join(ctx.bin, name);
  fs.writeFileSync(ctx.fake, '#!/bin/sh\nexec "$DOFLOW_CONFORM_NODE" "$DOFLOW_CONFORM_FAKE" "$@"\n', { mode: 0o700 });
  const run = await runFake(ctx, argv);
  if (exitFact(run.result, '').state !== 'yes') return part('binary', 'failed', `the ${probe} run did not exit 0 (${describeExit(run.result)})`);
  const problem = argvProblem(run, argv);
  if (problem) return part('binary', 'failed', problem);
  return part('binary', 'passed', `exit 0 on the ${probe} argv`);
}

/** one-shot, then prompt-transport on the same run. */
async function oneShotParts(ctx: any, worker: any): Promise<Part[]> {
  const entry = worker.oneShot;
  const check = async (): Promise<Part> => {
    if (!isArgv(entry.argv)) return part('one-shot', 'failed', 'oneShot has no argv');
    if (entry.promptVia === 'argv' && !entry.argv.includes('{prompt}')) return part('one-shot', 'failed', "promptVia is argv but oneShot.argv has no '{prompt}' element");
    let expected: string[];
    try {
      expected = assembleArgv(worker, MARKER, false, ctx.lastMessageFile);
    } catch (error: any) {
      return part('one-shot', 'failed', error.message);
    }
    const input = promptInput(worker, MARKER);
    const run = await runFake(ctx, expected, { stdin: input.stdin });
    const problem = argvProblem(run, expected);
    if (problem) return part('one-shot', 'failed', problem);
    ctx.oneShot = { input, log: run.log };
    return part('one-shot', 'passed', 'the argv equals assembleArgv');
  };
  const oneShot = await check();
  if (oneShot.result !== 'passed') return [oneShot, part('prompt-transport', 'unchecked', 'depends-on one-shot')];
  const problem = transportProblem(entry, ctx.oneShot.input, ctx.oneShot.log);
  if (problem) return [oneShot, part('prompt-transport', 'failed', problem)];
  return [oneShot, part('prompt-transport', 'passed', entry.promptVia === 'argv' ? 'one whole argv element' : 'stdin byte for byte, absent from argv')];
}

async function modelPart(ctx: any, worker: any, oneShot: Part): Promise<Part> {
  const binding = { model: MODEL_ID, flag: 'supported' };
  let via: 'one-shot' | 'main-session';
  let expected: string[];
  if (supported(worker.oneShot)) {
    if (oneShot.result !== 'passed') return part('model-flag', 'unchecked', 'depends-on one-shot');
    via = 'one-shot';
  } else if (supported(worker.mainSession)) via = 'main-session';
  else return part('model-flag', 'unchecked', 'not-declared: oneShot, mainSession');
  if (!isArgv(worker.model.argv)) return part('model-flag', 'failed', 'model has no argv');
  try {
    expected = via === 'one-shot' ? assembleArgv(worker, MARKER, false, ctx.lastMessageFile, binding) : mainArgv(worker, MARKER, ctx.lastMessageFile, MODEL_ID);
  } catch (error: any) {
    return part('model-flag', 'failed', error.message);
  }
  const run = await runFake(ctx, expected, { stdin: promptInput(worker, MARKER, via === 'main-session').stdin });
  const problem = argvProblem(run, expected);
  if (problem) return part('model-flag', 'failed', problem);
  const count = run.log.argv.filter((item: string) => item === MODEL_ID).length;
  if (count !== 1) return part('model-flag', 'failed', `${MODEL_ID} appears ${count} times in the ${via} argv, want once`);
  const modelArgv = worker.model.argv.map((item: string) => (item === '{model}' ? MODEL_ID : item));
  const placed = run.log.argv.some((_: string, i: number) => modelArgv.every((item: string, k: number) => run.log.argv[i + k] === item));
  if (!placed) return part('model-flag', 'failed', `the argv does not hold model.argv ${json(modelArgv)} in one place`);
  return part('model-flag', 'passed', `${MODEL_ID} once, via ${via}`);
}

/** 169 IC-002: the `provider` or `effort` part. Binds `conform-provider-1` or the first declared level (`conform-effort-1` for
 * `per-model`) with the model, checks the fake received the composed argv, and that the value reached it once: a flag
 * transport's flag once (no fixed copy left in the recipe), an id transport's composed id once. */
async function transportPart(ctx: any, worker: any, kind: 'provider' | 'effort', oneShot: Part): Promise<Part> {
  const entry = worker[kind];
  const value = kind === 'provider' ? PROVIDER_ID : (Array.isArray(entry.levels) ? entry.levels[0] : EFFORT_ID);
  const choice = { model: MODEL_ID, provider: kind === 'provider' ? value : null, effort: kind === 'effort' ? value : null };
  let via: 'one-shot' | 'main-session';
  if (supported(worker.oneShot)) {
    if (oneShot.result !== 'passed') return part(kind, 'unchecked', 'depends-on one-shot');
    via = 'one-shot';
  } else if (supported(worker.mainSession)) via = 'main-session';
  else return part(kind, 'unchecked', 'not-declared: oneShot, mainSession');
  if (!supported(worker.model)) return part(kind, 'failed', `${kind} is supported but model is not`);
  let expected: string[];
  try {
    expected = via === 'one-shot'
      ? assembleArgv(worker, MARKER, false, ctx.lastMessageFile, { ...choice, flag: 'supported' })
      : mainArgv(worker, MARKER, ctx.lastMessageFile, choice);
  } catch (error: any) {
    return part(kind, 'failed', error.message);
  }
  const run = await runFake(ctx, expected, { stdin: promptInput(worker, MARKER, via === 'main-session').stdin });
  const problem = argvProblem(run, expected);
  if (problem) return part(kind, 'failed', problem);
  if (entry.via === 'flag') {
    const flag = entry.argv[0];
    const count = run.log.argv.filter((item: string) => item === flag || item.startsWith(`${flag}=`)).length;
    if (count !== 1) return part(kind, 'failed', `${flag} appears ${count} times in the ${via} argv, want once`);
    return part(kind, 'passed', `${flag} ${value} once, via ${via}`);
  }
  const composed = expected.filter((item) => item.includes(value));
  if (composed.length !== 1) return part(kind, 'failed', `${value} appears in ${composed.length} argv elements of the ${via} argv, want one`);
  return part(kind, 'passed', `${composed[0]} once, via ${via}`);
}

/** The argv and parser checks launchMainSession makes before it spawns, in its order, then the transport. */
async function mainSessionPart(ctx: any, worker: any): Promise<Part> {
  const entry = worker.mainSession;
  if (!isArgv(entry.argv)) return part('main-session', 'failed', 'mainSession has no argv');
  let expected: string[];
  try {
    expected = mainArgv(worker, MARKER, ctx.lastMessageFile, null);
    refuseUnknownMainParser(worker);
  } catch (error: any) {
    return part('main-session', 'failed', error.message);
  }
  const input = promptInput(worker, MARKER, true);
  const run = await runFake(ctx, expected, { stdin: input.stdin });
  const problem = argvProblem(run, expected) ?? transportProblem(entry, input, run.log);
  if (problem) return part('main-session', 'failed', problem);
  return part('main-session', 'passed', `the argv equals mainArgv; the prompt by ${entry.promptVia}`);
}

// ---- the login part (172 design §8) -------------------------------------------------------------------------

const LOGIN_PROVIDER = 'conform-provider';
/** The slow case's bound, set through checkLogin's spawn seam, and how long its fake sleeps: well past the bound. */
const LOGIN_SLOW_MS = 300;
const LOGIN_SLEEP_MS = 5000;
/** The exit a fake run gives for an argv its script does not name; the seam reports that argv before any reading. */
const STRAY_EXIT = 125;

/** The listing's stdout naming one provider, `conform-provider`, in the form the declared `parse` reads. */
function listingLines(parse: unknown): string[] {
  if (parse === 'tsv-first-column') return [`${LOGIN_PROVIDER}\tConform provider`];
  const column = typeof parse === 'string' ? /^table-column:(.+)$/.exec(parse) : null;
  return column ? [column[1], LOGIN_PROVIDER] : [LOGIN_PROVIDER];
}

/** The first secret-printing or widening flag in `argv`, worded for a reason, or null (step 1). */
function loginFlag(worker: any, argv: string[]): string | null {
  const binary = worker.cli.binary;
  const secrets = Array.isArray(worker.secretFlags) && secretFlagsProblem(worker.secretFlags) === null ? worker.secretFlags : [];
  const secret = secretProblem(argv, { binary, declared: secrets });
  if (secret) return `secret flag '${secret}'`;
  const widening = wideningProblem(argv, { binary, declared: declaredOf(worker) });
  return widening ? `widening flag '${widening}'` : null;
}

const testsOf = (rule: any): any[] => (Array.isArray(rule.when) ? rule.when : []);
/** The rule checkLogin takes for `exit` and the parsed `event`: the first with that exit whose tests all hold, or -1. */
const firstAnswer = (answers: any[], exit: number, event: any): number => answers
  .findIndex((rule: any) => rule.exit === exit && testsOf(rule).every((test: any) => compileTest(test)(event)));
const stateText = (answer: any): string => (answer.reason ? `${answer.state} ${answer.reason}` : answer.state);

/**
 * One case (step 2): checkLogin runs the recipe through its `spawn` seam, each process one run of the fake, whose
 * script picks by the argv it receives: the listing argv prints `conform-provider` in the declared column, the check
 * argv prints `check.stdout` and exits `check.exit` (after `check.sleepMs`). `bound` caps the check's timeout.
 * Resolves the answer to compare, the provider's with `providers`, or `{stray}` when the fake got an argv neither names.
 */
async function loginCase(ctx: any, worker: any, check: any, bound = TIMEOUT_MS): Promise<any> {
  const recipe = worker.loginProbe;
  const checkArgv = recipe.argv.map((item: string) => (item === '{provider}' ? LOGIN_PROVIDER : item));
  const byArgv = [
    ...(recipe.providers ? [{ argv: recipe.providers.argv, stdout: listingLines(recipe.providers.parse), exit: 0 }] : []),
    { argv: checkArgv, ...check },
  ];
  let stray: string[] | null = null;
  const spawn = async ({ argv, timeoutMs }: any) => {
    const run = await runFake(ctx, argv, { byArgv, exit: STRAY_EXIT, timeoutMs: sameArgv(argv, checkArgv) ? Math.min(timeoutMs, bound) : timeoutMs });
    if (run.log && !byArgv.some((entry) => sameArgv(run.log.argv, entry.argv))) stray ??= run.log.argv;
    return { ...run.result, error: run.result.error ?? null, stdout: run.stdout, truncated: false };
  };
  const answer = await checkLogin({ harness: worker.cli.binary, worker, env: {}, cwd: ctx.home, binaryPath: ctx.fake, spawn });
  if (stray) return { stray };
  return recipe.providers ? answer.providers[0] ?? answer : answer;
}

/**
 * Design §8, replacing row 171 A-5: no secret or widening flag; each answer rule's own case (the smallest JSON
 * object meeting its `when`, `eventFor`, and its exit) reads the rule's state and reason; an exit no rule names reads
 * `unknown exit <n>`; a check that sleeps past a 300 ms bound reads `unknown timeout`; each expiry sign is found in a
 * failure summary made of itself with `{provider}` set to `conform-provider`.
 */
async function loginPart(ctx: any, worker: any): Promise<Part> {
  const recipe = worker.loginProbe;
  if (!isArgv(recipe.argv) || recipe.argv.length === 0) return part('login', 'failed', 'loginProbe has no argv');
  if (recipe.providers && !isArgv(recipe.providers.argv)) return part('login', 'failed', 'loginProbe.providers has no argv');
  const answers = recipe.answers;
  if (!Array.isArray(answers) || answers.length === 0 || !answers.every(plain)) return part('login', 'failed', 'loginProbe has no answers');
  for (const [where, argv] of [['argv', recipe.argv], ['providers argv', recipe.providers?.argv]] as const) {
    const flag = argv ? loginFlag(worker, argv) : null;
    if (flag) return part('login', 'failed', `the loginProbe ${where} holds the ${flag}`);
  }
  const signs: any[] = Array.isArray(recipe.expirySigns?.signs) ? recipe.expirySigns.signs : [];
  const problems: string[] = [];
  const expect = async (name: string, check: any, want: any, bound?: number) => {
    const got = await loginCase(ctx, worker, check, bound);
    if (got.stray) problems.push(`${name}: the fake received ${json(got.stray)}, not a recipe argv`);
    else if (got.state !== want.state || (got.reason ?? null) !== want.reason) problems.push(`${name} reads ${stateText(got)}, want ${stateText(want)}`);
  };
  try {
    for (const [i, rule] of answers.entries()) {
      const event = testsOf(rule).length > 0 ? eventFor(rule, i) : {};
      const first = firstAnswer(answers, rule.exit, event);
      if (first !== i) {
        problems.push(first === -1 ? `no stdout meets answers[${i}]` : `answers[${i}] is shadowed by answers[${first}]`);
        continue;
      }
      await expect(`answers[${i}]`, { stdout: [json(event)], exit: rule.exit }, { state: rule.state, reason: rule.reason ?? null });
    }
    let unnamed = 0;
    while (answers.some((rule: any) => rule.exit === unnamed)) unnamed += 1;
    await expect(`exit ${unnamed}`, { stdout: [], exit: unnamed }, { state: 'unknown', reason: `exit ${unnamed}` });
    await expect('the slow fake', { stdout: [], exit: 0, sleepMs: LOGIN_SLEEP_MS }, { state: 'unknown', reason: 'timeout' }, LOGIN_SLOW_MS);
    for (const [i, sign] of signs.entries()) {
      const slot = typeof sign === 'string' && sign.includes('{provider}');
      const found = loginExpiredOf({ status: 'failure', summary: String(sign).split('{provider}').join(LOGIN_PROVIDER) }, worker);
      const k = found ? signs.indexOf(found.sign) : -1;
      if (k === -1) problems.push(`expirySigns.signs[${i}] does not match its own sample`);
      else if (k !== i) problems.push(`expirySigns.signs[${i}] is matched as signs[${k}]`);
      else if (found.provider !== (slot ? LOGIN_PROVIDER : null)) problems.push(`expirySigns.signs[${i}] reads provider ${json(found.provider)}`);
    }
  } catch (error: any) {
    return part('login', 'failed', error?.message ?? String(error));
  }
  if (problems.length > 0) return part('login', 'failed', problems.join('; '));
  return part('login', 'passed', `${answers.length} answers, ${signs.length} signs, providers ${recipe.providers ? 'yes' : 'no'}`);
}

/** §6.2: every part in order, with `not-declared` and `depends-on` applied before a part runs. */
async function checkParts(ctx: any, worker: any): Promise<Part[]> {
  const gate = (name: string, entry: any, needs: Part | null): Part | null => {
    if (!supported(entry)) return part(name, 'unchecked', 'not-declared');
    if (needs && needs.result !== 'passed') return part(name, 'unchecked', `depends-on ${needs.part}`);
    return null;
  };
  const binary = gate('binary', worker.cli, null) ?? await binaryPart(ctx, worker);
  const shot = gate('one-shot', worker.oneShot, binary);
  const [oneShot, transport] = shot ? [shot, part('prompt-transport', 'unchecked', shot.reason)] : await oneShotParts(ctx, worker);
  return [
    binary,
    oneShot,
    transport,
    gate('model-flag', worker.model, binary) ?? await modelPart(ctx, worker, oneShot),
    gate('provider', worker.provider, binary) ?? await transportPart(ctx, worker, 'provider', oneShot),
    gate('effort', worker.effort, binary) ?? await transportPart(ctx, worker, 'effort', oneShot),
    gate('main-session', worker.mainSession, binary) ?? await mainSessionPart(ctx, worker),
    gate('stream', worker.structuredOutput, binary) ?? await streamPart(ctx, worker),
    gate('login', worker.loginProbe, binary) ?? await loginPart(ctx, worker),
  ];
}

const refusal = (error: string, message: string) => ({ exit: 2, body: { ok: false, error, message: cutChars(message, MESSAGE_CHARS) } });
const answerBytes = (body: any): number => Math.max(
  Buffer.byteLength(`${JSON.stringify(body, null, 2)}\n`),
  Buffer.byteLength(`${conformLines(body).join('\n')}\n`),
);

/** B6: the answer, `--json` or text, is at most ANSWER_BYTES. Ids are cut to NAME_CHARS, so the reasons alone can be
 * over; they are cut 20 characters at a time until it fits (with every reason empty the body is about 1.5 KB). */
function fit(body: any): any {
  for (let chars = REASON_CHARS - 20; chars >= 0 && answerBytes(body) > ANSWER_BYTES; chars -= 20) {
    body.parts = body.parts.map((p: Part) => ({ ...p, reason: cutChars(p.reason, chars) }));
  }
  return body;
}

/**
 * IC-005: conforms `harness` (a built-in id or a package `<pkg>.<local>` id) and resolves `{ exit, body }`.
 * `registry`, `view` and `repoRoot` reach `workerCatalogue`; `tmpDir` is where the scratch is made; `onLog` (a
 * test seam) receives each record the fake logged.
 */
async function conform({ harness, registry, view, repoRoot, platform = process.platform, tmpDir = os.tmpdir(), onLog = null }: any = {}): Promise<{ exit: number; body: any }> {
  const entries = workerCatalogue({ registry, view, ...(repoRoot ? { repoRoot } : {}) });
  const entry = entries.find((item: any) => item.id === harness);
  if (!entry) return refusal('unknown-harness', `unknown harness '${cutChars(String(harness), NAME_CHARS)}'; known: ${entries.map((item: any) => item.id).join(', ')}`);
  if (platform === 'win32') return refusal('platform-unsupported', 'conform runs its fake through a POSIX shell wrapper; win32 is unsupported (DEC-008)');
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(tmpDir, 'doflow-conform-'));
    for (const sub of ['bin', 'home', 'log']) fs.mkdirSync(path.join(dir, sub), { mode: 0o700 });
  } catch (error: any) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return refusal('scratch-failed', `conform could not make its scratch directory (${error?.code || error?.message}) in ${tmpDir}`);
  }
  const scratch = dir;
  const ctx: any = {
    dir: scratch, bin: path.join(scratch, 'bin'), home: path.join(scratch, 'home'), lastMessageFile: path.join(scratch, 'home', 'last-message.txt'),
    fake: null, spawns: 0, onLog, oneShot: null, child: null,
  };
  // B5: a signal ends the running fake and removes the scratch, then takes its default course (it is re-raised once
  // no other listener is left; a process that has others exits 128+n). The handlers live only while conform runs.
  const unwatch = () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
  const onSignal = (signal: string) => {
    unwatch();
    ctx.child?.kill('SIGKILL');
    fs.rmSync(scratch, { recursive: true, force: true });
    if ((process as any).listenerCount(signal) === 0) process.kill(process.pid, signal);
    else process.exit(128 + os.constants.signals[signal]);
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const worker = entry.worker;
    const parts = await checkParts(ctx, worker);
    const so = worker.structuredOutput;
    const id = supported(so) ? parserIdOf(so) : null;
    const failed = parts.filter((p) => p.result === 'failed').map((p) => p.part);
    const body = {
      ok: failed.length === 0,
      harness: cutChars(String(harness), NAME_CHARS),
      origin: entry.origin,
      parser: { id: typeof id === 'string' ? cutChars(id, NAME_CHARS) : id, kind: id === null ? null : (so.fieldMap ? 'field-map' : 'code') },
      parts,
      failed,
    };
    return { exit: failed.length === 0 ? 0 : 1, body: fit(body) };
  } finally {
    unwatch();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** §6.4 text: one line per part, then `conform: <harness> ok` or `conform: <harness> failed: <part>, <part>`. */
function conformLines(body: any): string[] {
  return [
    ...body.parts.map((p: Part) => `${p.part}  ${p.result}  ${p.reason}`),
    body.ok ? `conform: ${body.harness} ok` : `conform: ${body.harness} failed: ${body.failed.join(', ')}`,
  ];
}

module.exports = { PARTS, MARKER, MODEL_ID, conform, conformLines };

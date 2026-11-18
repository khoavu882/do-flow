'use strict';

// Row 171 T6 (design §6.1 step 5): the fake harness `worker --action conform` runs in place of a real one.
// It is not required by anything: conform.ts writes `<scratch>/bin/<cli.binary>`, a `#!/bin/sh` wrapper that
// execs `$DOFLOW_CONFORM_NODE $DOFLOW_CONFORM_FAKE "$@"`, so this file runs as a script.
//
// It writes `{argv, stdinBase64 (at most 1 MiB), env (the keys only)}` as one JSON line to $DOFLOW_CONFORM_LOG,
// writes the script's `lastMessage` to its `lastMessageFile` when the argv holds that path, prints the script's
// stdout lines and exits with $DOFLOW_CONFORM_EXIT. Row 172 (design §8 step 2): a script with `byArgv`
// (`[{argv, stdout, exit, sleepMs?}]`) picks its stdout and exit by the argv this invocation received, after sleeping
// `sleepMs` when set; an argv it does not name prints nothing and exits with $DOFLOW_CONFORM_EXIT. It reads no file
// but its script ($DOFLOW_CONFORM_SCRIPT) and stdin, and makes no network call.
//
// Row 170 T6 (IC-007): a script with `channel` runs the harness's control-channel mode instead, and keeps reading
// stdin until it closes. It first logs `{argv, stdinBase64: '', env, pid}` as above, then appends one line per record it
// received: `{received: <the record's bytes with its LF, base64>, shape: 'followUp'|'steer'|'stop'|null}`. The
// `channel` entry is `{templates: {followUp, steer, stop}, working, settled, answer: {idPath, accepted} | null, mode}`:
// a record is matched against the templates by shape (the same keys at every level, literals equal, a placeholder
// any string); one that fits none gets a `{"conformFake":"mismatch","n":<record>,"problem":<text>}` stdout line.
// A matched record gets, in order, the `accepted` event with the record's `{id}` set at `idPath` (when `answer` is
// declared), then the `working` event for a follow-up or steer, or the `settled` event for a stop. At stdin EOF it
// exits, unless `mode` is `ignore-eof`: it then stays alive (at most 30 s, so a conform that was killed leaves no
// process behind), the harness defect conform's control-channel part must catch.

const fs = require('node:fs');

const STDIN_MAX = 1048576;
const env = process.env;
const script = JSON.parse(fs.readFileSync(String(env.DOFLOW_CONFORM_SCRIPT), 'utf8'));
const argv = process.argv.slice(2);
const plain = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The first way `record` differs from `template` in shape, or null: keys at every level, literals, placeholders. */
function shapeProblem(template: any, record: any, at: string): string | null {
  if (template === '{text}' || template === '{id}') return typeof record === 'string' ? null : `${at} is not a string`;
  if (plain(template)) {
    if (!plain(record)) return `${at} is not an object`;
    for (const key of Object.keys(record)) if (!Object.hasOwn(template, key)) return `${at} holds the key '${key}' the template does not`;
    for (const key of Object.keys(template)) if (!Object.hasOwn(record, key)) return `${at} lacks the key '${key}'`;
    for (const key of Object.keys(template)) {
      const problem = shapeProblem(template[key], record[key], `${at}.${key}`);
      if (problem) return problem;
    }
    return null;
  }
  return template === record ? null : `${at} is ${JSON.stringify(record)}, the template has ${JSON.stringify(template)}`;
}
const idAt = (template: any, trail: string[] = []): string[] | null => {
  if (!plain(template)) return null;
  for (const [key, value] of Object.entries(template)) {
    if (value === '{id}') return [...trail, key];
    const inner = idAt(value, [...trail, key]);
    if (inner) return inner;
  }
  return null;
};
const valueAt = (record: any, at: string[]) => at.reduce((current: any, key) => (plain(current) ? current[key] : undefined), record);
function setAt(event: any, at: string[], value: any) {
  let current = event;
  for (const key of at.slice(0, -1)) {
    if (!plain(current[key])) current[key] = {};
    current = current[key];
  }
  current[at[at.length - 1]] = value;
}

function runChannel(spec: any) {
  fs.writeFileSync(String(env.DOFLOW_CONFORM_LOG), `${JSON.stringify({ argv, stdinBase64: '', env: Object.keys(env).sort(), pid: process.pid })}\n`);
  const emit = (event: any) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const kinds = ['followUp', 'steer', 'stop'].filter((kind) => plain(spec.templates[kind]));
  let pending = Buffer.alloc(0);
  let count = 0;
  process.stdin.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (let nl = pending.indexOf(0x0a); nl !== -1; nl = pending.indexOf(0x0a)) {
      const line = pending.subarray(0, nl + 1);
      pending = pending.subarray(nl + 1);
      count += 1;
      let record: any = null;
      try { record = JSON.parse(line.subarray(0, line.length - 1).toString('utf8')); } catch { record = null; }
      let shape: string | null = null;
      let problem = 'the record is not JSON';
      if (record !== null) {
        const found: Record<string, string> = {};
        for (const kind of kinds) {
          const issue = shapeProblem(spec.templates[kind], record, 'record');
          if (issue === null) { shape = kind; break; }
          found[kind] = `${kind}: ${issue}`;
        }
        // Conform sends the follow-up, the steer and the stop in that order, so record n is expected to be kinds[n - 1].
        problem = found[kinds[count - 1]] ?? Object.values(found)[0] ?? problem;
      }
      fs.appendFileSync(String(env.DOFLOW_CONFORM_LOG), `${JSON.stringify({ received: line.toString('base64'), shape })}\n`);
      if (shape === null) {
        emit({ conformFake: 'mismatch', n: count, problem });
        continue;
      }
      const at = spec.answer ? idAt(spec.templates[shape]) : null;
      if (spec.answer && at) {
        const answer = structuredClone(spec.answer.accepted);
        setAt(answer, spec.answer.idPath, valueAt(record, at));
        emit(answer);
      }
      emit(shape === 'stop' ? spec.settled : spec.working);
    }
  });
  process.stdin.on('end', () => {
    if (spec.mode !== 'ignore-eof') process.exit(0);
    setTimeout(() => process.exit(0), 30000);
  });
}

function runPlain() {
  let stdin = Buffer.alloc(0);
  try {
    stdin = fs.readFileSync(0);
  } catch {
    // no stdin (closed or not a pipe) logs as empty
  }
  fs.writeFileSync(String(env.DOFLOW_CONFORM_LOG), `${JSON.stringify({
    argv,
    stdinBase64: stdin.subarray(0, STDIN_MAX).toString('base64'),
    env: Object.keys(env).sort(),
  })}\n`);
  if (typeof script.lastMessageFile === 'string' && typeof script.lastMessage === 'string' && argv.includes(script.lastMessageFile)) {
    fs.writeFileSync(script.lastMessageFile, script.lastMessage);
  }
  const same = (a: unknown) => Array.isArray(a) && a.length === argv.length && a.every((item, i) => item === argv[i]);
  const picked = Array.isArray(script.byArgv) ? script.byArgv.find((entry: any) => same(entry?.argv)) ?? { stdout: [] } : script;
  const lines: string[] = Array.isArray(picked.stdout) ? picked.stdout : [];
  const finish = () => {
    process.stdout.write(lines.map((line) => `${line}\n`).join(''));
    process.exitCode = Number.isInteger(picked.exit) ? picked.exit : Number(env.DOFLOW_CONFORM_EXIT);
  };
  if (Number.isInteger(picked.sleepMs) && picked.sleepMs > 0) setTimeout(finish, picked.sleepMs);
  else finish();
}

if (script.channel) runChannel(script.channel);
else runPlain();

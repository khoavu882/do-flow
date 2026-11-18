#!/usr/bin/env node
'use strict';

// fake-channel-harness.ts — row 170 T4. Test-only, never shipped. A stand-in for a harness in control-channel mode
// (shaped like Pi's RPC mode, design 4.3): it reads JSONL records on stdin and answers on stdout. Tests link it into a
// scratch bin/ under a `fake-<harness>` name (beside a `node` link) and name that link by absolute path in the
// descriptor, so the no-real-harness tripwire PATH can still run it and no real harness binary is ever reached.
//
// `--version` prints a version line and exits 0. Any other argv runs the channel:
//   - each received line is appended byte-exact (with its LF) to FAKE_CHANNEL_LOG;
//   - its pid is written to FAKE_CHANNEL_PID when that is set;
//   - per record: a `response` `{type, id, success}` repeating the record's `id`, then `agent_start`, two output
//     lines, `agent_end` and then `agent_settled` (the shipped Pi descriptor settles on `agent_settled`, a test fixture on `agent_end`); with FAKE_CHANNEL_GATE set, `agent_end` for the n-th record waits until the file
//     `<FAKE_CHANNEL_GATE>-<n>` exists (polled every 20 ms, at most 60 s), so a test sees the turn working first;
//   - stdin EOF exits 0, unless FAKE_CHANNEL_MODE is `ignore-eof` (it then stays alive until it is killed);
//   - FAKE_CHANNEL_MODE `refuse` answers every record `success: false` and starts no turn.

const fs = require('node:fs');

if (process.argv.includes('--version')) {
  process.stdout.write('fake-channel 1.0.0\n');
  process.exit(0);
}

const mode = process.env.FAKE_CHANNEL_MODE || 'normal';
const log = process.env.FAKE_CHANNEL_LOG;
const gate = process.env.FAKE_CHANNEL_GATE;
if (process.env.FAKE_CHANNEL_PID) fs.writeFileSync(process.env.FAKE_CHANNEL_PID, String(process.pid));

const emit = (event: any) => process.stdout.write(`${JSON.stringify(event)}\n`);
const waitFor = (file: string): Promise<void> => new Promise((resolve) => {
  const until = Date.now() + 60000;
  const tick = () => (fs.existsSync(file) || Date.now() > until ? resolve() : setTimeout(tick, 20));
  tick();
});

let count = 0;
let chain: Promise<void> = Promise.resolve();

async function answer(line: Buffer, n: number): Promise<void> {
  let record: any = null;
  try { record = JSON.parse(line.toString('utf8')); } catch { record = null; }
  const id = typeof record?.id === 'string' ? record.id : undefined;
  if (mode === 'refuse') {
    emit({ type: 'response', id, success: false, error: 'refused by the fake' });
    return;
  }
  emit({ type: 'response', id, success: true });
  emit({ type: 'agent_start' });
  emit({ type: 'message_update', text: `working on record ${n}` });
  emit({ type: 'message_end', text: `done with record ${n}` });
  if (gate) await waitFor(`${gate}-${n}`);
  emit({ type: 'agent_end', aborted: record?.type === 'abort' });
  emit({ type: 'agent_settled' }); // Pi emits this after `agent_end`; the shipped Pi descriptor settles on it
}

let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  for (let nl = pending.indexOf(0x0a); nl !== -1; nl = pending.indexOf(0x0a)) {
    const line = pending.subarray(0, nl + 1);
    pending = pending.subarray(nl + 1);
    if (log) fs.appendFileSync(log, line);
    count += 1;
    const n = count;
    chain = chain.then(() => answer(line.subarray(0, line.length - 1), n));
  }
});
process.stdin.on('end', () => {
  if (mode === 'ignore-eof') {
    setInterval(() => {}, 60000);
    return;
  }
  chain.then(() => process.exit(0));
});

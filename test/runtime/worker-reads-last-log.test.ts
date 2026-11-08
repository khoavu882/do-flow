'use strict';

// Feature 150 A.7 (IC-022, DEC-006; FR-012, NFR-007; IC-002, IC-005, IC-006, IC-008): no worker read
// opens the worker's final-message file. A running fixture run has its out, err and `.last.log`
// files; the `.last.log` holds a planted marker that no mask rewrites, and the run record's output
// pointers name that file, so a reader that took a path from the record would open it. `worker-log`
// on out and err, `worker-result` and an `events --follow` of both log channels run through
// bin/doflow.js under test/helper/fs-open-probe.ts, which records every path the process asks
// fs.openSync, fs.open, fs.readFileSync, fs.createReadStream or fs.promises.open to open. One check,
// lastLogFindings, fails on any recorded `.last.log` path and on the marker in any output; the
// control runs planted readers that open the file under the same preload and requires that check
// to fail, and the real runs must have recorded the out and err paths, so the probe is not vacuous.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { storeFileFor, insertRun, transition, readRuns } = require('../../src/runtime/worker/run-store.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const PROBE = path.join(REPO, 'test', 'helper', 'fs-open-probe.ts');
const WIN = process.platform === 'win32';
const SLUG = '150-last-log-probe';
const RUN_ID = 'w-00000000a7a7';
const MARKER = 'A7-LAST-LOG-MARKER-final-words';
const DEADLINE_MS = 10000;

/** A temp project with one running run whose out, err and `.last.log` files all exist. */
function fixture(t: any) {
  const root = fs.realpathSync(tempDir(t, 'doflow-worker-last-log-'));
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), main: path.join(root, 'proj') };
  for (const d of [f.home, f.config, f.main]) fs.mkdirSync(d, { recursive: true });
  const output = path.join(f.main, '.doflow', 'state', 'worker-output');
  f.out = path.join(output, `${RUN_ID}.out.log`);
  f.err = path.join(output, `${RUN_ID}.err.log`);
  f.last = path.join(output, `${RUN_ID}.last.log`);
  // The record points every output field at the final-message file: only a reader that forms the
  // path from the stream name alone stays off it.
  const lastRel = `worker-output/${RUN_ID}.last.log`;
  const store = storeFileFor(f.main, SLUG);
  assert.equal(insertRun(store, { runId: RUN_ID, task: 'A.7', token: 1, harness: 'codex', createdAt: '2026-11-08T05:00:00.000Z', phase: 'starting' }).applied, true);
  assert.equal(transition(store, RUN_ID, ['starting'], (r: any) => {
    Object.assign(r, {
      startedAt: '2026-11-08T05:00:01.000Z',
      phase: 'running',
      output: {
        stdout: { path: lastRel, bytes: 0, written: 0, truncated: false },
        stderr: { path: lastRel, bytes: 0, written: 0, truncated: false },
        lastMessageFile: lastRel,
      },
    });
  }).applied, true);
  assert.equal(readRuns(store)[RUN_ID].phase, 'running');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(f.out, 'out-line-1\n');
  fs.writeFileSync(f.err, 'err-line-1\n');
  fs.writeFileSync(f.last, `${MARKER}\n`);
  f.env = {
    HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.config,
    PATH: process.env.PATH, ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}),
    TMPDIR: process.env.TMPDIR, ...(process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    DOFLOW_UPKEEP: 'off', DOFLOW_TELEMETRY: 'off',
  };
  f.probeCount = 0;
  return f;
}

/** A fresh probe file under the temp root, outside the project tree. */
function probeFile(f: any): string {
  f.probeCount += 1;
  return path.join(f.root, `open-probe-${f.probeCount}.log`);
}

/** The paths a probe file recorded, in order; an absent file recorded nothing. */
function recorded(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line: string) => line !== '');
}

/**
 * The one check both the real runs and the control use: every recorded path that ends in
 * `.last.log`, and every output text that holds the marker. An empty list passes.
 */
function lastLogFindings(probe: string, outputs: Array<{ label: string; text: string }>): string[] {
  // One finding per path: readFileSync and createReadStream reach the wrapped open again inside Node.
  const findings = [...new Set(recorded(probe).filter((p) => p.endsWith('.last.log')))].map((p) => `opened ${p}`);
  for (const { label, text } of outputs) if (text.includes(MARKER)) findings.push(`${label} holds the marker`);
  return findings;
}

/** One preloaded `bin/doflow.js` run, its probe file and both output texts. */
function runProbed(f: any, args: string[]) {
  const probe = probeFile(f);
  const r = spawnSync(process.execPath, ['--require', PROBE, CLI, ...args], {
    cwd: f.main, env: { ...f.env, DOFLOW_OPEN_PROBE: probe }, encoding: 'utf8', timeout: DEADLINE_MS,
  });
  const label = args.join(' ');
  return { ...r, probe, outputs: [{ label: `${label} stdout`, text: r.stdout }, { label: `${label} stderr`, text: r.stderr }] };
}

/** A preloaded follower: parsed stdout frames, waits with a deadline, killed after the test. */
function followProbed(t: any, f: any, channels: string) {
  const probe = probeFile(f);
  const child = spawn(process.execPath, ['--require', PROBE, CLI, 'events', '--follow', '--channels', channels, '--json'], {
    cwd: f.main, env: { ...f.env, DOFLOW_OPEN_PROBE: probe }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const s: any = { child, probe, out: '', err: '', waiters: [] as Array<() => void> };
  const poke = () => { for (const w of s.waiters.splice(0)) w(); };
  child.stdout.on('data', (d: Buffer) => { s.out += d.toString('utf8'); poke(); });
  child.stderr.on('data', (d: Buffer) => { s.err += d.toString('utf8'); poke(); });
  s.exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('exit', (code: number | null, signal: string | null) => { resolve({ code, signal }); poke(); }));
  s.frames = () => s.out.split('\n').filter((l: string) => l !== '').map((l: string) => JSON.parse(l));
  s.until = (what: string, predicate: (frames: any[]) => boolean) => new Promise<any[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; stdout ${s.out} stderr ${s.err}`)), DEADLINE_MS);
    const check = () => {
      let frames: any[];
      try { frames = s.frames(); } catch (error) { clearTimeout(timer); reject(error); return; }
      if (predicate(frames)) { clearTimeout(timer); resolve(frames); return; }
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); reject(new Error(`exited ${child.exitCode} before ${what}; stderr ${s.err}`)); return; }
      s.waiters.push(check);
    };
    check();
  });
  s.exit = () => Promise.race([s.exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`no exit; stderr ${s.err}`)), DEADLINE_MS); timer.unref(); })]);
  return s;
}

test('IC-022, FR-012: worker-log out and err and worker-result open no .last.log and print no marker', (t) => {
  const f = fixture(t);
  const calls = [
    ['worker-log', '--worker-run', RUN_ID, '--stream', 'out', '--slug', SLUG, '--json'],
    ['worker-log', '--worker-run', RUN_ID, '--stream', 'err', '--json'],
    ['worker-log', '--worker-run', RUN_ID, '--stream', 'out', '--slug', SLUG],
    ['worker-result', '--worker-run', RUN_ID, '--slug', SLUG, '--json'],
    ['worker-result', '--worker-run', RUN_ID],
  ];
  const opened = new Set<string>();
  for (const args of calls) {
    const r = runProbed(f, args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.deepEqual(lastLogFindings(r.probe, r.outputs), [], args.join(' '));
    for (const p of recorded(r.probe)) opened.add(p);
  }
  const outLog = runProbed(f, calls[0]);
  assert.match(outLog.stdout, /out-line-1/, 'the out page is the out file');
  const errLog = runProbed(f, calls[1]);
  assert.match(errLog.stdout, /err-line-1/, 'the err page is the err file');
  // Not vacuous: the probe saw the reads of both log files.
  assert.ok(opened.has(f.out), `the probe recorded ${f.out}; it recorded ${[...opened].join(', ')}`);
  assert.ok(opened.has(f.err), `the probe recorded ${f.err}`);
});

test('IC-006, IC-008: a follow of worker out and err, through its first appends, opens no .last.log', async (t) => {
  const f = fixture(t);
  const out = `worker:${RUN_ID}:out`;
  const err = `worker:${RUN_ID}:err`;
  const s = followProbed(t, f, `${out},${err}`);
  const opened = (frames: any[], ch: string) => frames.some((frame) => frame.ch === ch && frame.type === 'snapshot' && frame.data.log === 'open');
  await s.until('open snapshots on both channels', (all: any[]) => opened(all, out) && opened(all, err));
  fs.appendFileSync(f.out, 'out-line-2\n');
  fs.appendFileSync(f.err, 'err-line-2\n');
  const appended = (frames: any[], ch: string, text: string) => frames.some((frame) => frame.ch === ch && frame.type === 'append'
    && frame.data.pieces.some((piece: any) => piece.text === text));
  await s.until('an append on both channels', (all: any[]) => appended(all, out, 'out-line-2') && appended(all, err, 'err-line-2'));
  if (WIN) s.child.kill();
  else s.child.kill('SIGTERM');
  const { code } = await s.exit();
  if (!WIN) assert.equal(code, 0, s.err);
  assert.deepEqual(lastLogFindings(s.probe, [{ label: 'follow stdout', text: s.out }, { label: 'follow stderr', text: s.err }]), []);
  const paths = recorded(s.probe);
  assert.ok(paths.includes(f.out), `the probe recorded ${f.out}; it recorded ${paths.join(', ')}`);
  assert.ok(paths.includes(f.err), `the probe recorded ${f.err}`);
});

test('IC-002, IC-006: --stream last and the worker:<id>:last channel exit 2 and open nothing of it', (t) => {
  const f = fixture(t);
  for (const args of [
    ['worker-log', '--worker-run', RUN_ID, '--stream', 'last', '--slug', SLUG, '--json'],
    ['worker-log', '--worker-run', RUN_ID, '--stream', 'last'],
    ['events', '--follow', '--channels', `worker:${RUN_ID}:last`, '--json'],
    ['events', '--follow', '--channels', `worker:${RUN_ID}:out,worker:${RUN_ID}:last`, '--json'],
  ]) {
    const r = runProbed(f, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.deepEqual(lastLogFindings(r.probe, r.outputs), [], args.join(' '));
  }
});

test('IC-022 control: a planted reader that opens .last.log fails the same check', (t) => {
  const f = fixture(t);
  // One reader per wrapped entry point and path form; none prints anything, so the path alone fails it.
  const readers = [
    `fs.closeSync(fs.openSync(${JSON.stringify(f.last)}, 'r'));`,
    `fs.closeSync(fs.openSync(Buffer.from(${JSON.stringify(f.last)}), 'r'));`,
    `fs.open(${JSON.stringify(f.last)}, 'r', (e, fd) => { if (e) throw e; fs.closeSync(fd); });`,
    `fs.readFileSync(require('node:url').pathToFileURL(${JSON.stringify(f.last)}));`,
    `fs.createReadStream(${JSON.stringify(f.last)}).on('open', function () { this.destroy(); });`,
    `fs.promises.open(${JSON.stringify(f.last)}, 'r').then((h) => h.close());`,
  ];
  for (const body of readers) {
    const probe = probeFile(f);
    const r = spawnSync(process.execPath, ['--require', PROBE, '-e', `const fs = require('node:fs'); ${body}`], {
      cwd: f.main, env: { ...f.env, DOFLOW_OPEN_PROBE: probe }, encoding: 'utf8', timeout: DEADLINE_MS,
    });
    assert.equal(r.status, 0, `${body}: ${r.stderr}`);
    assert.deepEqual(lastLogFindings(probe, [{ label: 'reader stdout', text: r.stdout }, { label: 'reader stderr', text: r.stderr }]), [`opened ${f.last}`], body);
  }
  // A reader that prints the file fails on the marker as well.
  const probe = probeFile(f);
  const r = spawnSync(process.execPath, ['--require', PROBE, '-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(f.last)}, 'utf8'))`], {
    cwd: f.main, env: { ...f.env, DOFLOW_OPEN_PROBE: probe }, encoding: 'utf8', timeout: DEADLINE_MS,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastLogFindings(probe, [{ label: 'reader stdout', text: r.stdout }]), [`opened ${f.last}`, 'reader stdout holds the marker']);
  // Without DOFLOW_OPEN_PROBE the preload is a no-op: the same reader runs and no probe file appears.
  const unset = spawnSync(process.execPath, ['--require', PROBE, '-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(f.out)}, 'utf8'))`], {
    cwd: f.main, env: f.env, encoding: 'utf8', timeout: DEADLINE_MS,
  });
  assert.deepEqual([unset.status, unset.stdout], [0, 'out-line-1\n'], unset.stderr);
  assert.deepEqual(fs.readdirSync(f.root).filter((name: string) => name.startsWith('open-probe-')).length, f.probeCount);
});

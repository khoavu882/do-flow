'use strict';

// Feature 149 A.6 (IC-001, IC-005): `doflow events --follow`, the read-only long-lived verb that
// prints the live sections of the read verbs as NDJSON envelopes.
//
//   doflow events --follow --channels <channel>[,<channel>...] [--json]
//   doflow events --follow --control stdin [--json]
//
// It composes the four modules beside it: channels.ts parses the channel names, sections.ts runs
// each channel's verbs in-process, detector.ts decides when a channel is recomputed and which
// record event it gets, and envelope.ts frames, masks and caps what is printed. This file wires a
// detector decision to the producers and the writer: a recompute runs the channel's producers,
// masks the sections and compares each one's JSON text with the last one emitted, then prints a
// `patch` of the changed sections or nothing (a `snapshot` when one is owed); a record event
// prints `error`, `reset` or `gone`.
//
// Feature 150 A.6 (IC-006, IC-008): a log channel (`worker:<runId>:out` or `:err`, from
// `--channels` or a `sub` line) is followed by its LogSubscription (logs.ts) instead of the section
// catalogue: a recompute prints the subscription's `snapshot`, `append`, `reset`, `error` or `gone`
// frames, and its re-mark asks are passed to the detector. A refused stream (`last` included) is a
// usage error from the channel grammar, so nothing is made and no file is opened for it.
//
// - stdout carries envelopes only, one per line, in `--json` mode or not.
// - A usage error (exit 2) is one `doflow events: ...` line on stderr, printed before any envelope
//   except for an invalid control line, which can follow envelopes already printed.
// - An internal fault (exit 1) is exactly one stderr line containing `[ERROR]`, after which nothing
//   more is printed (DEC-054: a Console reads an exit 1 or 2 with no stdout line and no `[ERROR]`
//   line as an old core).
// - SIGINT, SIGTERM and, in control mode, stdin EOF end the process with exit 0; the detector's
//   watchers and timers are closed before the returned promise resolves.
//
// Read-only: this module opens no file; the producers and the detector read with flag 'r'. No lock,
// no telemetry, no upkeep (`events` is in NO_UPKEEP, src/cli/runtime-commands.ts).
// Every I/O seam is injectable for tests, defaulting to the process's own.

const { finishRuntime } = require('../cli-result.ts');
const { printSafe } = require('../mask.ts');
const { parseChannel, parseChannelList, CHANNEL_LIMIT } = require('./channels.ts');
const { createEnvelopeWriter, maskSections } = require('./envelope.ts');
const { createDetector } = require('./detector.ts');
const { channelSpec } = require('./sections.ts');
const { createLogSubscription } = require('./logs.ts');

/** IC-005: the longest control line, in bytes, newline excluded. */
const CONTROL_LINE_BYTES = 1024;

/** IC-001: the flags the verb takes; each at most once. */
const FLAGS: ReadonlySet<string> = new Set(['--follow', '--channels', '--control', '--json']);
/** The flags among them that take a value (`--flag value` or `--flag=value`). */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--channels', '--control']);

/** Longest part of untrusted text echoed back in a stderr line. */
const ECHO_CHARS = 80;

type Env = Record<string, string | undefined>;
type SectionResult = { exit: number; json: unknown };
type Sections = Record<string, SectionResult>;

interface Writable { write(text: string): any; on?(event: string, fn: (...args: any[]) => void): any; removeListener?(event: string, fn: (...args: any[]) => void): any }
interface Readable {
  on(event: string, fn: (...args: any[]) => void): any;
  removeListener(event: string, fn: (...args: any[]) => void): any;
  pause?(): any;
  destroy?(): any;
}
interface SignalSource { on(event: string, fn: () => void): any; removeListener(event: string, fn: () => void): any }

interface EventsOptions {
  follow?: boolean;
  channels?: string;
  control?: string;
  json?: boolean;
  /** Every flag as typed (`flagsGiven`), for the unknown and repeated flag checks. */
  flags?: readonly string[];
  positional?: readonly string[];
  env?: Env;
  cwd?: string;
  /** Control mode's input (default `process.stdin`, touched only in control mode). */
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  /** The detector's clock (`now` and timers); the envelope `at` reads its `now`. */
  clock?: any;
  fsImpl?: any;
  watch?: any;
  signals?: SignalSource;
  epoch?: string;
  /** Test seams: the catalogue entry of a channel, the subscription of a log channel and the detector factory. */
  specFor?: (channel: any, ctx: { cwd: string; env: Env }) => any;
  logFor?: (options: any) => any;
  detectorFactory?: (options: any) => any;
}

/** One line of untrusted text made safe to print: no control characters, bounded. */
function shown(text: unknown): string {
  const safe = String(printSafe(String(text))).replace(/[\r\n]+/g, ' ');
  return safe.length > ECHO_CHARS ? `${safe.slice(0, ECHO_CHARS)}...` : safe;
}

/** The first problem with the flags and positionals as typed, or null. */
function flagProblem(flags: readonly string[], positional: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const raw of flags) {
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    if (!FLAGS.has(name)) return `unknown flag '${shown(raw)}'; only ${[...FLAGS].join(', ')} apply`;
    if (eq !== -1 && !VALUE_FLAGS.has(name)) return `${name} takes no value`;
    if (seen.has(name)) return `${name} is given more than once`;
    seen.add(name);
  }
  if (positional.length > 0) return `takes no positional argument, got '${shown(positional[0])}'; run it in the project to follow`;
  return null;
}

/**
 * Checks one control line (IC-005): a JSON object of exactly the keys `op` (`sub` or `unsub`) and
 * `ch` (a channel of IC-003), at most `CONTROL_LINE_BYTES` bytes.
 * @returns {{ok: true, op: string, channel: any} | {ok: false, reason: string}}
 */
function parseControlLine(line: Buffer): { ok: true; op: 'sub' | 'unsub'; channel: any } | { ok: false; reason: string } {
  if (line.length > CONTROL_LINE_BYTES) return { ok: false, reason: `a control line is longer than ${CONTROL_LINE_BYTES} bytes` };
  let doc: any;
  try {
    doc = JSON.parse(line.toString('utf8'));
  } catch {
    return { ok: false, reason: 'a control line is not JSON' };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'a control line must be a JSON object' };
  const keys = Object.keys(doc);
  if (keys.length !== 2 || !keys.includes('op') || !keys.includes('ch')) return { ok: false, reason: "a control line must have exactly the keys 'op' and 'ch'" };
  if (doc.op !== 'sub' && doc.op !== 'unsub') return { ok: false, reason: `unknown op '${shown(doc.op)}'; use sub or unsub` };
  const parsed = parseChannel(doc.ch);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, op: doc.op, channel: parsed.channel };
}

/** The JSON text of each masked section: what IC-006 compares. */
function textsOf(masked: Sections): Map<string, string> {
  const texts = new Map<string, string>();
  for (const name of Object.keys(masked)) texts.set(name, JSON.stringify(masked[name]));
  return texts;
}

/**
 * Runs `doflow events --follow` (IC-001, IC-005).
 * @param {EventsOptions} options the parsed CLI arguments and the injectable seams
 * @returns {Promise<number>} resolves with the exit code (also set as `process.exitCode`) when the
 *   process should exit: 0 after a signal or stdin EOF, 1 after an internal fault, 2 for a usage
 *   error or an invalid control line. Never rejects.
 */
function handleEventsCommand(options: EventsOptions = {}): Promise<number> {
  const stdout: Writable = options.stdout ?? process.stdout;
  const stderr: Writable = options.stderr ?? process.stderr;
  const errLine = (line: string): void => {
    try { stderr.write(`${line}\n`); } catch { /* stderr is gone: the exit code still says it */ }
  };
  const usage = (message: string): Promise<number> => {
    errLine(`doflow events: ${message}`);
    return Promise.resolve(finishRuntime(2));
  };

  const problem = flagProblem(options.flags ?? [], options.positional ?? []);
  if (problem) return usage(problem);
  if (options.follow !== true) return usage('--follow is required');
  const hasChannels = options.channels !== undefined;
  const hasControl = options.control !== undefined;
  if (hasChannels === hasControl) return usage('give exactly one of --channels <channel>[,<channel>...] and --control stdin');
  if (hasControl && options.control !== 'stdin') return usage(`--control accepts only stdin, got '${shown(options.control)}'`);
  let initial: any[] = [];
  if (hasChannels) {
    const list = parseChannelList(options.channels);
    if (!list.ok) return usage(list.reason);
    initial = list.channels;
  }

  const ctx = { cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env };
  const specFor = options.specFor ?? channelSpec;
  const logFor = options.logFor ?? createLogSubscription;
  const detectorFactory = options.detectorFactory ?? createDetector;
  const signals: SignalSource = options.signals ?? process;
  const clock = options.clock;

  return new Promise<number>((resolve) => {
    const specs = new Map<string, any>();
    const last = new Map<string, Map<string, string>>();
    const failed = new Set<string>();
    let stopped = false;
    let detector: any = null;
    let stdin: Readable | null = null;
    let queue: Promise<void> = Promise.resolve();
    let ending = false;

    const emit = (lines: string[]): void => {
      if (stopped) return;
      for (const line of lines) stdout.write(line);
    };

    const onSignal = (): void => stop(0);
    const onStdoutError = (error: any): void => fault(error);
    const onData = (chunk: any): void => receive(chunk);
    const onEnd = (): void => endOfInput();
    const onStdinError = (): void => endOfInput(); // the parent is gone: orphan protection, as for EOF

    function stop(code: number): void {
      if (stopped) return;
      stopped = true;
      try { if (detector) detector.close(); } catch { /* closing is best-effort; the exit code stands */ }
      signals.removeListener('SIGINT', onSignal);
      signals.removeListener('SIGTERM', onSignal);
      if (typeof stdout.removeListener === 'function') stdout.removeListener('error', onStdoutError);
      if (stdin) {
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        stdin.removeListener('error', onStdinError);
        try { stdin.pause?.(); stdin.destroy?.(); } catch { /* already closed */ }
      }
      resolve(finishRuntime(code));
    }

    /** IC-001: an internal fault is one `[ERROR]` line on stderr, then nothing more. */
    function fault(error: any): void {
      if (stopped) return;
      errLine(`[ERROR] doflow events: ${shown(error && error.message ? error.message : error)}`);
      stop(1);
    }

    /** Runs `fn` after every earlier control step, so lines take effect in the order they came. */
    function enqueue(fn: () => void | Promise<void>): void {
      queue = queue.then(() => (stopped ? undefined : fn())).catch(fault);
    }

    /** 150 IC-008: a log channel's recompute is its subscription's decision. */
    function recomputeLog(ch: string, sub: any, request: any): void {
      const step = sub.recompute(request.snapshot === true);
      if (specs.get(ch) !== sub || stopped) return;
      emit(step.lines);
      if (step.gone) {
        specs.delete(ch);
        detector.unfollow(ch);
        return;
      }
      if (typeof step.again === 'number' && typeof detector.mark === 'function') detector.mark(ch, step.again);
    }

    async function recompute(ch: string, request: any): Promise<void> {
      const spec = specs.get(ch);
      if (!spec || stopped) return;
      if (spec.log === true) { recomputeLog(ch, spec, request); return; }
      const snapshot = request.snapshot || writer.needsSnapshot(ch);
      let computed: { sections: Sections; removed?: string[] };
      let masked: Sections;
      try {
        computed = await spec.compute(snapshot || request.scope === 'all' ? undefined : request.sections);
        masked = maskSections(computed.sections);
      } catch {
        // IC-002: a producer fault is the channel's `error`, once per spell; the next snapshot ends it.
        if (specs.get(ch) !== spec || stopped || failed.has(ch)) return;
        failed.add(ch);
        last.delete(ch);
        emit(writer.error(ch, 'producer-failed'));
        return;
      }
      if (specs.get(ch) !== spec || stopped) return;
      const previous = last.get(ch);
      if (snapshot || failed.has(ch) || !previous) {
        failed.delete(ch);
        const lines = writer.snapshot(ch, computed.sections);
        if (writer.needsSnapshot(ch)) last.delete(ch); // `reset frame-cap`: the next recompute snapshots again
        else last.set(ch, textsOf(masked));
        emit(lines);
        return;
      }
      const changed: Sections = {};
      const texts = textsOf(masked);
      for (const [name, text] of texts) if (previous.get(name) !== text) changed[name] = computed.sections[name];
      const removed = (computed.removed ?? []).filter((name) => previous.has(name) && !texts.has(name));
      const lines = writer.patch(ch, changed, removed);
      if (writer.needsSnapshot(ch)) last.delete(ch);
      else {
        for (const [name, text] of texts) previous.set(name, text);
        for (const name of removed) previous.delete(name);
      }
      emit(lines);
    }

    function recordEvent(ch: string, event: string): void {
      if (stopped || !specs.has(ch)) return;
      last.delete(ch);
      failed.delete(ch);
      if (event === 'store-unreadable' || event === 'unsupported-version') emit(writer.error(ch, event));
      else if (event === 'replaced') emit(writer.reset(ch, 'replaced'));
      else if (event === 'gone') {
        const spec = specs.get(ch);
        if (spec && spec.log === true) spec.end();
        specs.delete(ch); // the detector no longer follows it; a later `sub` follows it anew
        emit(writer.gone(ch));
      }
    }

    /** Follows a channel, or follows it again: either way its next frame is a fresh snapshot. */
    async function followChannel(channel: any): Promise<void> {
      const prior = specs.get(channel.name);
      if (prior && prior.log === true) prior.end();
      const spec = channel.kind === 'log' ? logSpec(channel) : specFor(channel, ctx);
      specs.set(channel.name, spec);
      last.delete(channel.name);
      failed.delete(channel.name);
      await detector.follow(channel.name, spec.sources());
    }

    /** A log channel's subscription, marked so `recompute` tells it from a catalogue entry. */
    function logSpec(channel: any): any {
      const sub = logFor({ channel, ctx, writer, ...(options.fsImpl ? { fsImpl: options.fsImpl } : {}), ...(clock ? { now: () => clock.now() } : {}) });
      return Object.assign(sub, { log: true });
    }

    async function control(op: 'sub' | 'unsub', channel: any): Promise<void> {
      const ch = channel.name;
      if (op === 'unsub') {
        if (!specs.has(ch)) return;
        const spec = specs.get(ch);
        if (spec.log === true) spec.end();
        detector.unfollow(ch);
        specs.delete(ch);
        last.delete(ch);
        failed.delete(ch);
        return;
      }
      if (!specs.has(ch) && specs.size >= CHANNEL_LIMIT) {
        emit(writer.error(ch, 'too-many-channels')); // IC-003: not followed
        return;
      }
      await followChannel(channel);
    }

    function invalid(reason: string): void {
      ending = true;
      enqueue(() => {
        errLine(`doflow events: invalid control line: ${reason}`);
        stop(2);
      });
    }

    function line(bytes: Buffer): void {
      const parsed = parseControlLine(bytes);
      if (!parsed.ok) { invalid(parsed.reason); return; }
      enqueue(() => control(parsed.op, parsed.channel));
    }

    let pending: Buffer[] = [];
    let pendingBytes = 0;

    function receive(chunk: any): void {
      if (stopped || ending) return;
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl === -1) break;
        const part = buf.subarray(start, nl);
        const whole = pendingBytes > 0 ? Buffer.concat([...pending, part]) : part;
        pending = [];
        pendingBytes = 0;
        line(whole);
        if (ending) return;
        start = nl + 1;
      }
      if (start < buf.length) {
        pendingBytes += buf.length - start;
        // A line already over the bound is refused at once, without holding more of it.
        if (pendingBytes > CONTROL_LINE_BYTES) { invalid(`a control line is longer than ${CONTROL_LINE_BYTES} bytes`); return; }
        pending.push(Buffer.from(buf.subarray(start)));
      }
    }

    function endOfInput(): void {
      if (stopped || ending) return;
      if (pendingBytes > 0) {
        const rest = Buffer.concat(pending);
        pending = [];
        pendingBytes = 0;
        line(rest); // a last line without a newline still counts
      }
      if (ending) return;
      ending = true;
      enqueue(() => stop(0)); // IC-005: after every earlier line has taken effect
    }

    let writer: any;
    try {
      writer = createEnvelopeWriter({ ...(options.epoch === undefined ? {} : { epoch: options.epoch }), ...(clock ? { clock: () => clock.now() } : {}) });
      signals.on('SIGINT', onSignal);
      signals.on('SIGTERM', onSignal);
      if (typeof stdout.on === 'function') stdout.on('error', onStdoutError);
      detector = detectorFactory({
        clock,
        fsImpl: options.fsImpl,
        watch: options.watch,
        onRecompute: recompute,
        onRecordEvent: recordEvent,
        onFault: fault,
      });
    } catch (error) {
      fault(error);
      return;
    }

    if (hasChannels) {
      // IC-001: each channel's snapshot in the given order, then follow until a signal.
      enqueue(async () => {
        for (const channel of initial) {
          if (stopped) return;
          await followChannel(channel);
        }
      });
      return;
    }
    const input: Readable = options.stdin ?? (process.stdin as any);
    stdin = input;
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onStdinError);
  });
}

module.exports = { handleEventsCommand, parseControlLine, CONTROL_LINE_BYTES };

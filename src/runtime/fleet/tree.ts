'use strict';

/**
 * `fleet --action tree` (093 IC-020): one project's agent hierarchy as nodes and edges, built from
 * records that already exist and written to nowhere. Sources: IC-018 a sessions (hook observations
 * joined to the session directory), the harnesses' own sub-agent records read through V.4's readers
 * (`header`, and the metadata mode for the last record time), task attempts by run/lineage, worker runs
 * (caller, `childOf`, binding, end, a bounded process check) and the dispatch `primary` snapshot.
 * Every edge names the record it comes from; two nodes merge only on a shared key (a runKey, a run id,
 * an agent key), never on a harness or a model. A label is the record's own role text, never invented.
 * A transcript is joined by session id alone (gate-a Q4 A); nothing is written, no path, pid or raw
 * session id is printed. `internal` (not part of the body) carries what V.6 needs to open a node's file.
 * @returns {{ok: false, error: string} | {ok: true, body: Object, internal: Map<string, Object>}}
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cwdHash, stateDir } = require('../context/identity.ts');
const { observedSessions } = require('../context/primary.ts');
const { listCheckouts } = require('../checkouts.ts');
const { readTaskState } = require('../task-state.ts');
const { readRuns } = require('../worker/run-store.ts');
const processTree = require('../worker/process-tree.ts');
const { loadTranscriptRegistry } = require('../transcripts/registry.ts');
const { readJsonFile, label } = require('../transcripts/cursor.ts');

const MAX_SESSIONS = 64;
const MAX_NODES = 256;
const MAX_CHECKS = 16;
const SCAN_FILES = 200;
const LIST_CAP = 2000;
const SUBAGENT_FILES = 64;
const NEEDLE_BYTES = 2 * 1024 * 1024;
const SESSION_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_KEY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const sha16 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const READERS: Record<string, () => any> = {
  'claude-jsonl': () => require('../transcripts/readers/claude-jsonl.ts'),
  'codex-rollout': () => require('../transcripts/readers/codex-rollout.ts'),
  'kiro-jsonl': () => require('../transcripts/readers/kiro-jsonl.ts'),
  'copilot-events': () => require('../transcripts/readers/copilot-events.ts'),
  'pi-jsonl': () => require('../transcripts/readers/pi-jsonl.ts'),
};
/** How each harness encodes a cwd into its transcript directory name (research section 3). */
const ENCODE: Record<string, (cwd: string) => string> = {
  claude: (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-'),
  pi: (cwd) => cwd.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-'),
};

function regularFile(file: string, fsImpl: any): boolean {
  try { return fsImpl.lstatSync(file).isFile(); } catch { return false; }
}

/** Files under `root` matching a glob whose only wildcard is `*` inside one path segment. */
function expandGlob(root: string, pattern: string, fsImpl: any): string[] {
  let found = [root];
  for (const seg of pattern.split('/')) {
    const next: string[] = [];
    if (!seg.includes('*')) for (const dir of found) next.push(path.join(dir, seg));
    else {
      const re = new RegExp(`^${seg.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      for (const dir of found) {
        let names: string[] = [];
        try { names = fsImpl.readdirSync(dir); } catch { /* not a directory */ }
        for (const name of names.slice(0, LIST_CAP)) if (re.test(name)) next.push(path.join(dir, name));
      }
    }
    found = next.slice(0, LIST_CAP);
  }
  return found.filter((file) => regularFile(file, fsImpl)).sort();
}

/** The registry locations of `entry` for this platform, as `[root, glob]` pairs with the base resolved. */
function locations(entry: any, env: any, home: string, platform: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const loc of entry.locations) {
    if (loc.os !== platform || loc.status === 'unknown') continue;
    let base: string | null = null;
    if (loc.base === 'home') base = home;
    else if (loc.base === 'xdg-data') base = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    else if (loc.base.startsWith('env:')) base = env[loc.base.slice(4)] || null;
    if (base) out.push([path.join(base, ...loc.segments), loc.glob]);
  }
  return out;
}

/** Does `file` hold `needle` in its first 2 MiB? Only the yes or no leaves this function. */
function fileHas(file: string, needle: string, fsImpl: any): boolean {
  try {
    const fd = fsImpl.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(NEEDLE_BYTES, fsImpl.fstatSync(fd).size));
      fsImpl.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('latin1').includes(needle);
    } finally { fsImpl.closeSync(fd); }
  } catch { return false; }
}

function buildTree({
  env = process.env, cwd = process.cwd(), exec = spawnSync, fsImpl = fs, platform = process.platform, home, alive = processTree.alive, now = Date.now,
}: any = {}): any {
  const observed = observedSessions({ env, cwd, exec, fsImpl, now });
  if (!observed.ok) return { ok: false, error: observed.error };
  const listed = listCheckouts({ cwd, exec, fsImpl });
  const checkouts: string[] = listed.ok ? listed.entries.filter((e: any) => !e.sandbox).map((e: any) => e.path) : [];
  const projectKey = cwdHash(listed.ok ? listed.main : cwd);
  const homeDir = home ?? env.HOME ?? os.homedir();
  const loaded = loadTranscriptRegistry();
  const registry: Record<string, any> = {};
  for (const entry of loaded.ok ? loaded.registry.entries : []) registry[entry.harness] = entry;

  const nodes = new Map<string, any>();
  const edges = new Map<string, any>();
  const internal = new Map<string, any>();
  const counts = { unreadable: 0, notChecked: 0 };
  let checks = 0;

  /** The node for `agentKey`, created once: a second source with the same key adds what the first lacked. */
  const node = (agentKey: string, fields: any, intern?: any): any => {
    let n = nodes.get(agentKey);
    if (!n) {
      if (nodes.size >= MAX_NODES) { counts.notChecked += 1; return null; }
      n = {
        agentKey, kind: null, harness: null, model: null, modelBasis: null, label: null, depth: 0, worktreeKey: projectKey,
        startedAt: null, lastRecordAt: null, liveness: 'not-checked', ended: null, transcript: { reader: null, linked: false, reason: 'no-reader' },
        ...fields,
      };
      nodes.set(agentKey, n);
      internal.set(agentKey, { kind: fields.kind });
    } else {
      for (const [key, value] of Object.entries(fields)) if (n[key] === null) n[key] = value;
    }
    Object.assign(internal.get(agentKey), intern ?? {});
    return n;
  };
  const edge = (from: string, to: string, basis: string): void => {
    if (from !== to) edges.set(`${from}|${to}|${basis}`, { from, to, basis }); // kept only when both ends are nodes, below
  };
  const harnessOf = (id: unknown): string | null => (typeof id !== 'string' ? null : registry[id] ? id : '(other)');
  const transcriptOf = (harness: string | null, file: string | null): any => {
    const entry = harness ? registry[harness] : null;
    if (!entry) return { reader: null, linked: false, reason: 'no-reader' };
    if (entry.join === 'none') return { reader: null, linked: false, reason: 'not-linked' };
    if (entry.reader === null) return { reader: null, linked: false, reason: 'no-reader' };
    return file ? { reader: entry.reader, linked: true, reason: null } : { reader: entry.reader, linked: false, reason: 'not-found' };
  };
  const lastAt = (harness: string, file: string, companion?: string): string | null => {
    try {
      const out = READERS[registry[harness].reader]().read({ file, companion, mode: 'metadata', maxBytes: 32768, limit: 64 });
      return [...out.events].reverse().find((e: any) => e.at)?.at ?? null;
    } catch { return null; }
  };

  // ---- main sessions (IC-018 a) and the transcript each one's id names ----------------------------------
  const sessions: any[] = observed.body.sessions.filter((s: any) => s.kind === 'hook');
  counts.notChecked += Math.max(0, sessions.length - MAX_SESSIONS);
  const root = stateDir(env);
  const rawIds = new Map<string, string>();
  if (root !== null) {
    try { for (const name of fsImpl.readdirSync(path.join(root, 'sessions')).slice(0, LIST_CAP)) if (SESSION_DIR.test(name)) rawIds.set(sha16(name), name); } catch { /* none */ }
  }
  const scanned = new Map<string, any>(); // harness -> [{file, companion, header}] of the bounded scan
  const scan = (harness: string): any[] => {
    if (scanned.has(harness)) return scanned.get(harness);
    const entry = registry[harness];
    const files: string[] = [];
    if (entry && entry.reader) {
      for (const [dir, glob] of locations(entry, env, homeDir, platform)) {
        if (harness === 'pi') for (const c of checkouts) files.push(...expandGlob(dir, glob.replace('{cwdEncoded}', ENCODE.pi(c)), fsImpl));
        else files.push(...expandGlob(dir, glob.replace('{sessionId}', '*').replace('{cwdEncoded}', '*'), fsImpl));
      }
    }
    const newest = harness === 'kiro' || harness === 'pi'
      ? files.map((file) => { try { return { file, t: fsImpl.lstatSync(file).mtimeMs }; } catch { return { file, t: 0 }; } }).sort((a, b) => b.t - a.t).map((x) => x.file)
      : [...files].sort().reverse();
    const out: any[] = [];
    for (const file of [...new Set(newest)].slice(0, SCAN_FILES)) {
      try { out.push({ file, header: READERS[entry.reader]().header({ file }) }); } catch { counts.unreadable += 1; }
    }
    scanned.set(harness, out);
    return out;
  };
  const locate = (harness: string, id: string): string | null => {
    const entry = registry[harness];
    if (!entry || !entry.reader || entry.join === 'none' || !SESSION_DIR.test(id)) return null;
    if (harness === 'pi') return scan('pi').find((x) => x.header.sessionId === id)?.file ?? null;
    for (const [dir, glob] of locations(entry, env, homeDir, platform)) {
      const hit = expandGlob(dir, glob.replace('{sessionId}', id).replace('{cwdEncoded}', '*'), fsImpl)[0];
      if (hit) return hit;
    }
    return null;
  };

  const mains: any[] = [];
  for (const s of sessions.slice(0, MAX_SESSIONS)) {
    const harness = harnessOf(s.harness);
    const rawId = rawIds.get(s.sessionKey) ?? null;
    const file = harness && rawId ? locate(harness, rawId) : null;
    const agentKey = sha16(`${harness ?? ''}:${rawId ?? s.sessionKey}`);
    const companion = file && harness === 'kiro' ? file.replace(/\.jsonl$/, '.json') : undefined;
    const n = node(agentKey, {
      kind: 'main-session', harness, model: label(s.model), modelBasis: s.model ? 'hook-observation' : null, worktreeKey: s.worktreeKey,
      startedAt: s.startedAt, lastRecordAt: (file && harness && lastAt(harness, file, companion)) || s.lastHookRecordAt,
      transcript: transcriptOf(harness, file),
    }, { harness, sessionId: rawId, file, companion });
    if (n) mains.push({ n, harness, rawId, file });
  }

  // ---- harness sub-agent records (IC-020 sources), through the readers' header ---------------------------
  const child = (parent: any, harness: string, idPart: string, header: any, file: string | null, companion?: string): void => {
    const agentKey = sha16(`${harness}:${idPart}`);
    const depth = Number.isInteger(header.depth) ? header.depth : parent.depth + 1;
    const n = node(agentKey, {
      kind: 'harness-subagent', harness, model: header.model, modelBasis: header.model ? 'harness-record' : null, label: header.label, depth,
      worktreeKey: parent.worktreeKey, lastRecordAt: file ? lastAt(harness, file, companion) : null, transcript: transcriptOf(harness, file),
    }, { harness, sessionId: header.sessionId, agentId: header.agentId, file, companion });
    if (n) edge(parent.agentKey, agentKey, 'harness-subagent-record');
  };
  for (const { n, harness, rawId, file } of mains) {
    if (!harness || !rawId || !file || !registry[harness]) continue;
    const reader = READERS[registry[harness].reader]();
    try {
      if (harness === 'claude') {
        const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
        let names: string[] = [];
        try { names = fsImpl.readdirSync(dir).filter((x: string) => /^agent-.+\.jsonl$/.test(x)).sort().slice(0, SUBAGENT_FILES); } catch { /* none */ }
        const subs = names.map((name) => {
          const sub = path.join(dir, name);
          const meta = readJsonFile(sub.replace(/\.jsonl$/, '.meta.json')) || {};
          return { sub, header: reader.header({ file: sub }), toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null };
        });
        const made = new Map<number, any[]>();
        for (const s of subs.sort((a, b) => (a.header.depth ?? 1) - (b.header.depth ?? 1))) {
          const depth = s.header.depth ?? 1;
          // A depth-1 agent was spawned by the main session; deeper ones by the file that holds their tool_use id.
          const candidates = depth <= 1 ? [{ file, node: n }] : made.get(depth - 1) ?? [];
          const parent = depth <= 1 ? candidates[0] : candidates.find((c) => s.toolUseId !== null && fileHas(c.file, s.toolUseId, fsImpl));
          const agentId = s.header.agentId ?? path.basename(s.sub, '.jsonl').replace(/^agent-/, '');
          const agentKey = sha16(`claude:${rawId}:${agentId}`);
          const made1 = node(agentKey, {
            kind: 'harness-subagent', harness, model: s.header.model, modelBasis: s.header.model ? 'harness-record' : null, label: s.header.label, depth,
            worktreeKey: n.worktreeKey, lastRecordAt: lastAt(harness, s.sub), transcript: transcriptOf(harness, s.sub),
          }, { harness, sessionId: rawId, agentId, file: s.sub });
          if (!made1) continue;
          if (parent) edge(parent.node.agentKey, agentKey, 'harness-subagent-record');
          made.set(depth, [...(made.get(depth) ?? []), { file: s.sub, node: made1 }]);
        }
      } else if (harness === 'copilot') {
        for (const c of reader.header({ file }).children) child(n, harness, `${rawId}:${c.agentId}`, { ...c, model: null, sessionId: rawId }, null);
      } else if (harness === 'codex' || harness === 'pi' || harness === 'kiro') {
        // Children name their parent session id in their own header: follow the chain through the bounded scan.
        const parents = new Map<string, any>([[rawId, n]]);
        const headers = scan(harness);
        for (let grew = true; grew;) {
          grew = false;
          for (const h of headers) {
            const p = h.header.parentSessionId;
            if (!p || !parents.has(p) || !h.header.sessionId || parents.has(h.header.sessionId)) continue;
            const companion = harness === 'kiro' ? h.file.replace(/\.jsonl$/, '.json') : undefined;
            child(parents.get(p), harness, h.header.sessionId, h.header, h.file, companion);
            const made = nodes.get(sha16(`${harness}:${h.header.sessionId}`));
            if (made) { parents.set(h.header.sessionId, made); grew = true; }
          }
        }
      }
    } catch { counts.unreadable += 1; }
  }

  // ---- DoFlow records: attempts, worker runs, dispatch --------------------------------------------------
  const readStores = (checkout: string, dirName: string, read: (file: string) => any): Array<[string, any]> => {
    const dir = path.join(checkout, '.doflow', 'state', dirName);
    let names: string[] = [];
    try { names = fsImpl.readdirSync(dir).filter((x: string) => x.endsWith('.json')).sort(); } catch { return []; }
    const out: Array<[string, any]> = [];
    for (const name of names) {
      try { const data = read(path.join(dir, name)); if (data) out.push([name, data]); } catch { counts.unreadable += 1; }
    }
    return out;
  };
  const runNode = (runKey: string, extra: any = {}): any => {
    if (!RUN_KEY.test(runKey)) return null;
    return node(sha16(`doflow:${runKey}`), { kind: 'doflow-run', worktreeKey: runKey.split('/')[0], ...extra }, { runKey });
  };
  const attemptRuns = new Map<string, any>(); // `task#token` -> runKey of the attempt
  for (const checkout of checkouts) {
    for (const [, store] of readStores(checkout, 'task-attempts', (file) => readTaskState(fsImpl, file))) {
      for (const [taskId, entry] of Object.entries(store.tasks ?? {}) as Array<[string, any]>) {
        for (const a of Array.isArray(entry?.attempts) ? entry.attempts : []) {
          if (typeof a.runKey !== 'string') continue;
          attemptRuns.set(`${taskId}#${a.token}`, a.runKey);
          const at = [a.endedAt, a.finishedAt, a.startedAt].find((v) => typeof v === 'string') ?? null;
          const n = runNode(a.runKey, { startedAt: typeof a.startedAt === 'string' ? a.startedAt : null, lastRecordAt: at });
          if (n) {
            if (typeof a.owner === 'string' && (n.label === null || (at ?? '') >= (n.lastRecordAt ?? ''))) n.label = label(a.owner);
            if (at && (n.lastRecordAt === null || at > n.lastRecordAt)) n.lastRecordAt = at;
            if (typeof a.startedAt === 'string' && (n.startedAt === null || a.startedAt < n.startedAt)) n.startedAt = a.startedAt;
          }
        }
      }
    }
  }

  const runs = new Map<string, any>();
  for (const checkout of checkouts) {
    for (const [, byId] of readStores(checkout, 'worker-runs', (file) => readRuns(file, fsImpl))) {
      for (const [runId, run] of Object.entries(byId) as Array<[string, any]>) if (!runs.has(runId)) runs.set(runId, { run, checkout });
    }
  }
  const ordered = [...runs.entries()].sort((a, b) => String(b[1].run.startedAt ?? b[1].run.createdAt ?? '').localeCompare(String(a[1].run.startedAt ?? a[1].run.createdAt ?? '')) || (a[0] < b[0] ? -1 : 1));
  const workerKey = (runId: string) => sha16(`worker:${runId}`);
  for (const [runId, { run, checkout }] of ordered) {
    const caller = run.caller && typeof run.caller.runKey === 'string' ? runNode(run.caller.runKey) : null;
    const harness = harnessOf(run.harness);
    const isChild = typeof run.childOf === 'string' && run.childOf !== '';
    let liveness = 'not-checked';
    if (run.phase !== 'ended') {
      if (checks < MAX_CHECKS) {
        checks += 1;
        const seen = [alive(run.supervisor, { platform }), alive(run.worker, { platform })];
        liveness = seen.includes(true) ? 'process-seen' : seen.every((v) => v === false) ? 'process-gone' : 'not-checked';
      } else counts.notChecked += 1;
    }
    const n = node(workerKey(runId), {
      kind: isChild ? 'child-worker-run' : 'worker-run', harness, model: label(run.binding?.model), modelBasis: run.binding?.model ? 'worker-binding' : null,
      depth: isChild ? 2 : caller ? 1 : 0, worktreeKey: (run.caller?.runKey ?? '').split('/')[0] || cwdHash(checkout),
      startedAt: run.startedAt ?? run.createdAt ?? null, lastRecordAt: run.end?.at ?? run.startedAt ?? run.createdAt ?? null, liveness,
      ended: run.end && typeof run.end.at === 'string' ? { at: run.end.at, result: typeof run.end.state === 'string' ? run.end.state : null } : null,
      transcript: transcriptOf(harness, null),
    }, { harness, runId });
    if (!n) continue;
    if (isChild) edge(workerKey(run.childOf), n.agentKey, 'worker-childOf');
    else if (caller) edge(caller.agentKey, n.agentKey, 'worker-caller');
    else {
      const viaAttempt = attemptRuns.get(`${run.task}#${run.token}`);
      const owner = viaAttempt ? runNode(viaAttempt) : null;
      if (owner) edge(owner.agentKey, n.agentKey, 'attempt-runKey');
    }
  }
  for (const checkout of checkouts) {
    for (const [, store] of readStores(checkout, 'dispatch', (file) => readTaskState(fsImpl, file))) {
      for (const d of Object.values(store.dispatches ?? {}) as any[]) {
        if (typeof d?.parentRunKey !== 'string') continue;
        const snap = d.primary && typeof d.primary === 'object' ? d.primary : null;
        const owner = runNode(d.parentRunKey, snap ? { harness: harnessOf(snap.harness), model: label(typeof snap.model === 'string' ? snap.model : null), modelBasis: snap.model ? 'dispatch-snapshot' : null } : {});
        const launched = [...runs.entries()].find(([, r]) => r.run.task === d.task && r.run.token === d.token && !r.run.childOf);
        if (owner && launched) edge(owner.agentKey, workerKey(launched[0]), 'dispatch-claim');
      }
    }
  }

  // ---- what leaves: no internal field, kept nodes' edges only ---------------------------------------------
  const keep = [...nodes.values()];
  const body = {
    v: 1, projectKey, nodes: keep, edges: [...edges.values()].filter((e: any) => nodes.has(e.from) && nodes.has(e.to)),
    limits: { nodes: MAX_NODES, notChecked: counts.notChecked }, unreadable: counts.unreadable,
  };
  return { ok: true, body, internal };
}

module.exports = { buildTree, MAX_SESSIONS, MAX_NODES, MAX_CHECKS };

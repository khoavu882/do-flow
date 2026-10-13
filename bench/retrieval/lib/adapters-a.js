'use strict';

/**
 * Configuration A adapter (074 IC-008, PD-1): capability routing over the shipped providers, rtk
 * compression of what the agent would receive, index build measurement and the `setup` options that
 * only configuration A reads. Provider answers are mapped to the retrieval-plan vocabulary here; the
 * dispatcher (adapters.js) adds patch application and the guidance rule.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTool, runB, finalize, payloadOf, cand, toPosix, K_MAX } = require('./adapters-b.js');

const CAPABILITY_BY_CLASS = {
  'exact-lookup': 'code.exact-search',
  'conceptual-discovery': 'code.semantic-search',
  'impact-refactor': 'code.impact-analysis',
};
const DEFAULT_OUTCOME_CAPABILITY = 'code.semantic-search';
const TIME_BIN = '/usr/bin/time';

/** Capability id for a task: by class for the ranking classes, `task.capability` (or semantic search) otherwise. */
function capabilityFor(task) {
  return CAPABILITY_BY_CLASS[task.class] || task.capability || DEFAULT_OUTCOME_CAPABILITY;
}

function loadCapabilities(exportRoot) {
  return JSON.parse(fs.readFileSync(path.join(exportRoot, 'core', 'registry', 'capabilities.json'), 'utf8')).capabilities;
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim() !== '') || '';
}

function failure(run, label) {
  if (!run.ran) return run.cause;
  return `${label} exited ${run.status}: ${firstLine(run.stderr || run.stdout).slice(0, 120)}`;
}

function runSemble({ task, indexRoot, bins, semble }) {
  const env = { ...(semble && semble.env), HF_HUB_OFFLINE: '1' };
  const run = runTool(bins.semble, ['search', task.query, indexRoot, '-k', '10', '--max-snippet-lines', '10', '--format', 'json'], { env });
  if (!run.ran || run.status !== 0) return { unreached: failure(run, 'semble') };
  let parsed;
  try { parsed = JSON.parse(run.stdout); } catch { return { unreached: 'semble printed output that is not JSON' }; }
  const candidates = (parsed.results || []).map((r) => {
    const rel = path.isAbsolute(r.file_path) ? path.relative(indexRoot, r.file_path) : r.file_path;
    return cand(toPosix(rel), r.start_line, r.end_line, null, 'semble.search', r.content || '');
  });
  return { candidates };
}

function graphPath(indexRoot) {
  return path.join(indexRoot, 'graphify-out', 'graph.json');
}

const STOP_WORDS = new Set([
  'what', 'which', 'where', 'who', 'when', 'how', 'does', 'do',
  'the', 'of', 'if', 'is', 'are', 'a', 'an', 'to', 'in', 'on',
  'and', 'or', 'i', 'it', 'that', 'this',
  'calls', 'call', 'uses', 'use', 'used', 'depend', 'depends',
  'rename', 'change', 'breaks', 'break', 'fail', 'fails',
]);

/** Extracts an identifier from a natural-language query deterministically (AM.5, hardened AM.7). */
function extractIdentifier(query) {
  if (!query || typeof query !== 'string') return '';
  const tokens = query.match(/[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z0-9_$]+)*/g) || [];
  if (tokens.length === 0) return query;
  const rule1 = tokens.filter((t) => t.includes('_') || t.includes('$') || t.includes('.') || /[A-Z]/.test(t.slice(1)));
  if (rule1.length > 0) return rule1[rule1.length - 1];
  const nonFirst = tokens.slice(1);
  const rule2 = nonFirst.filter((t) => /^[A-Z]/.test(t) && t !== 'I');
  if (rule2.length > 0) return rule2[rule2.length - 1];
  let longest = '';
  for (const t of tokens) {
    if (!STOP_WORDS.has(t.toLowerCase())) {
      if (t.length >= longest.length) longest = t;
    }
  }
  if (longest) return longest;
  return query;
}

function runGraphify({ task, indexRoot, bins }) {
  const impact = task.class === 'impact-refactor';
  const symbol = (task.literal && String(task.literal).trim()) || extractIdentifier(task.query) || task.query;
  const args = impact
    ? ['affected', symbol, '--depth', '2', '--graph', graphPath(indexRoot)]
    : ['query', task.query, '--budget', '2000', '--graph', graphPath(indexRoot)];
  const run = runTool(bins.graphify, args);
  if (!run.ran || run.status !== 0) return { unreached: failure(run, 'graphify') };
  if (run.stdout.includes('No unique node match')) return { unreached: 'No unique node match' };
  const candidates = [];
  for (const line of run.stdout.split('\n')) {
    const m = impact ? /^- .+ \[[^\]]+\] (\S+):L(\d+)$/.exec(line) : /src=(\S+) loc=L(\d+)/.exec(line);
    if (m) candidates.push(cand(toPosix(m[1]), Number(m[2]), Number(m[2]), null, 'graphify.query', line));
  }
  return { candidates };
}

function runRg({ task, exportRoot, bins }) {
  const ans = runB({ corpus: 'code', task, exportRoot, bins });
  if (ans.result === 'UNREACHED') return { unreached: ans.providers[0].cause, extraProviders: ans.providers.slice(1) };
  return { candidates: ans.candidates, extraProviders: ans.providers.filter((p) => p.id !== 'native.rg') };
}

const RUNNERS = { 'native.rg': runRg, 'semble.search': runSemble, 'graphify.query': runGraphify };

/** Pipes the concatenated snippets through `rtk proxy cat`; returns the compressed text or a reason it is unreached. */
function compressWithRtk(text, { bins, scratchDir }) {
  const dir = scratchDir || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rtk-input-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, text);
  try {
    const run = runTool(bins.rtk, ['proxy', 'cat', file]);
    if (!run.ran) return { unreached: run.cause };
    if (run.status !== 0) return { unreached: failure(run, 'rtk') };
    return { text: run.stdout };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * The `setup.command` output of a verification-failure task, run in `root`. B returns it raw; A
 * returns it after rtk compression and records `compressedBytes`. The answer carries `output` and
 * `exitCode` for the `mustSurvive` check.
 */
function runVerification({ task, root, config, bins = {}, scratchDir }) {
  const started = process.hrtime.bigint();
  const [bin, ...args] = task.setup.command;
  const run = runTool(bin, args, { cwd: root });
  const wallMs = () => Number(process.hrtime.bigint() - started) / 1e6;
  if (!run.ran) {
    return { result: 'UNREACHED', freshness: 'NOT_APPLICABLE', candidates: [], providers: [{ id: 'setup.command', state: 'unreached', cause: run.cause }], payloadBytes: 0, wallMs: wallMs() };
  }
  const raw = run.stdout + run.stderr;
  const answer = {
    result: 'RETRIEVED', freshness: 'NOT_APPLICABLE', candidates: [],
    providers: [{ id: 'setup.command', state: 'reached' }],
    payloadBytes: Buffer.byteLength(raw, 'utf8'), output: raw, exitCode: run.status, wallMs: 0,
  };
  if (config === 'A') {
    const packed = compressWithRtk(raw, { bins: { rtk: bins.rtk || 'rtk' }, scratchDir });
    if (packed.unreached) answer.providers.push({ id: 'rtk', state: 'unreached', cause: packed.unreached });
    else {
      answer.output = packed.text;
      answer.compressedBytes = Buffer.byteLength(packed.text, 'utf8');
      answer.providers.push({ id: 'rtk', state: 'reached' });
    }
  }
  answer.wallMs = wallMs();
  return answer;
}

/** An index provider proves no freshness (ADR 3.6); a live provider reads the tree itself. */
function freshnessOf(provider) {
  return provider.sourceMode === 'index' ? 'UNKNOWN' : 'NOT_APPLICABLE';
}

/**
 * Runs configuration A for one code-corpus task. `exportRoot` is where live providers search (the
 * per-task copy, patched); `indexRoot` is where the indexes were built (defaults to `exportRoot`), so
 * a stale-index task queries content older than the tree. `semble.env` carries `SEMBLE_CACHE_DIR`.
 */
function runA({ task, exportRoot, indexRoot = exportRoot, capabilities, bins = {}, semble = { env: undefined }, scratchDir }) {
  const started = process.hrtime.bigint();
  const tools = { rg: bins.rg, semble: bins.semble || 'semble', graphify: bins.graphify || 'graphify', fd: bins.fd, rtk: bins.rtk || 'rtk' };
  if (task.class === 'verification-failure') return runVerification({ task, root: exportRoot, config: 'A', bins: tools, scratchDir });

  const caps = capabilities || loadCapabilities(exportRoot);
  const capability = capabilityFor(task);
  const chain = (caps[capability] && caps[capability].providers) || [];
  const disabled = new Set((task.setup && task.setup.disable) || []);
  const providers = [];
  let last = null;
  let outcome = null;

  for (const provider of chain) {
    last = provider;
    if (disabled.has(provider.id)) { providers.push({ id: provider.id, state: 'unreached', cause: 'disabled by setup.disable' }); continue; }
    const runner = RUNNERS[provider.id];
    if (!runner) { providers.push({ id: provider.id, state: 'unreached', cause: 'no adapter for this provider' }); continue; }
    const res = runner({ task, exportRoot, indexRoot, bins: tools, semble });
    providers.push(res.unreached !== undefined
      ? { id: provider.id, state: 'unreached', cause: res.unreached }
      : { id: provider.id, state: 'reached' });
    for (const extra of res.extraProviders || []) providers.push(extra);
    if (res.unreached !== undefined) continue;
    outcome = { provider, candidates: finalize(res.candidates, K_MAX.code) };
    break;
  }

  let result;
  let freshness;
  let candidates = [];
  if (!outcome) {
    result = 'UNREACHED';
    freshness = last ? freshnessOf(last) : 'NOT_APPLICABLE';
  } else {
    candidates = outcome.candidates;
    freshness = freshnessOf(outcome.provider);
    if (candidates.length > 0) result = 'RETRIEVED';
    else if (outcome.provider.sourceMode === 'index') result = 'UNVERIFIED';
    else result = 'EMPTY';
  }

  const answer = { result, freshness, candidates, providers, payloadBytes: payloadOf(candidates), wallMs: 0 };
  if (candidates.length > 0) {
    const packed = compressWithRtk(candidates.map((c) => c.snippet).join(''), { bins: tools, scratchDir });
    if (packed.unreached) providers.push({ id: 'rtk', state: 'unreached', cause: packed.unreached });
    else { answer.compressedBytes = Buffer.byteLength(packed.text, 'utf8'); providers.push({ id: 'rtk', state: 'reached' }); }
  }
  answer.wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  return answer;
}

function dirBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function rssFromTime(stderr) {
  const mac = /(\d+)\s+maximum resident set size/.exec(stderr);
  if (mac) return Number(mac[1]) / (1024 * 1024);
  const linux = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
  if (linux) return Number(linux[1]) / 1024;
  return null;
}

/** Runs a tool, timing it; wraps it in `/usr/bin/time` (-l darwin, -v linux) when present to read peak RSS. */
function timedRun(bin, args, options = {}) {
  const flag = process.platform === 'darwin' ? '-l' : process.platform === 'linux' ? '-v' : null;
  const wrapped = flag && fs.existsSync(TIME_BIN);
  const started = process.hrtime.bigint();
  const run = wrapped ? runTool(TIME_BIN, [flag, bin, ...args], options) : runTool(bin, args, options);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // /usr/bin/time exits 127 when it cannot start the wrapped command: report that as an absent binary.
  if (wrapped && run.ran && run.status === 127) return { run: { ran: false, status: null, stdout: '', stderr: '', cause: 'binary absent' }, ms, rssMB: null };
  return { run, ms, rssMB: wrapped && run.ran ? rssFromTime(run.stderr) : null };
}

/**
 * Times the config A index builds against `exportRoot` before the first task: `graphify update` and
 * the first `semble search` against a clean cache (`semble.env.SEMBLE_CACHE_DIR`), then a second
 * `graphify update` after a one-line patch (undone afterwards). Returns the IC-015 `index` block;
 * a value that could not be measured reads `{unmeasured: reason}`.
 */
function buildIndexes({ exportRoot, semble, bins = {}, patchFile }) {
  const graphify = bins.graphify || 'graphify';
  const sembleBin = bins.semble || 'semble';
  const reasons = [];
  let buildMs = 0;
  let measuredBuild = false;
  let peak = null;

  const g = timedRun(graphify, ['update', exportRoot, '--no-cluster']);
  if (g.run.ran && g.run.status === 0) { buildMs += g.ms; measuredBuild = true; if (g.rssMB !== null) peak = Math.max(peak || 0, g.rssMB); }
  else reasons.push(`graphify: ${failure(g.run, 'graphify')}`);

  const s = timedRun(sembleBin, ['search', 'index warm-up', exportRoot, '-k', '1', '--format', 'json'], { env: { ...(semble && semble.env), HF_HUB_OFFLINE: '1' } });
  if (s.run.ran && s.run.status === 0) { buildMs += s.ms; measuredBuild = true; if (s.rssMB !== null) peak = Math.max(peak || 0, s.rssMB); }
  else reasons.push(`semble: ${failure(s.run, 'semble')}`);

  let incrementalMs = { unmeasured: reasons.length ? reasons.join('; ') : 'no file to patch' };
  if (g.run.ran && g.run.status === 0 && patchFile && fs.existsSync(patchFile)) {
    const original = fs.readFileSync(patchFile);
    fs.writeFileSync(patchFile, Buffer.concat([original, Buffer.from('\n// retrieval-benchmark incremental probe\n')]));
    const inc = timedRun(graphify, ['update', exportRoot, '--no-cluster']);
    fs.writeFileSync(patchFile, original);
    runTool(graphify, ['update', exportRoot, '--no-cluster']);
    incrementalMs = inc.run.ran && inc.run.status === 0 ? inc.ms : { unmeasured: `graphify: ${failure(inc.run, 'graphify')}` };
  }

  const cacheDir = semble && semble.env && semble.env.SEMBLE_CACHE_DIR;
  return {
    buildMs: measuredBuild ? buildMs : { unmeasured: reasons.join('; ') },
    incrementalMs,
    diskBytes: measuredBuild ? dirBytes(path.join(exportRoot, 'graphify-out')) + (cacheDir ? dirBytes(cacheDir) : 0) : { unmeasured: reasons.join('; ') },
    peakRssMB: peak !== null ? peak : { unmeasured: fs.existsSync(TIME_BIN) ? 'no resident-set line in /usr/bin/time output' : 'no /usr/bin/time' },
  };
}

module.exports = {
  CAPABILITY_BY_CLASS, capabilityFor, loadCapabilities, runA, runVerification, compressWithRtk, buildIndexes, rssFromTime, dirBytes, extractIdentifier, runGraphify,
};

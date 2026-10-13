'use strict';

/**
 * `retrieval run` (074 IC-003): verify, export the pinned commit, load and validate tasks, run the
 * adapters, score, measure latency and aggregate. The dev split yields the IC-015 shape without a
 * `capture` block; the holdout split writes IC-016 files only and prints aggregates, never a task id,
 * query or qrel.
 */

const fs = require('node:fs');
const path = require('node:path');
const sealLib = require('../seal.js');
const snapshotLib = require('../snapshot.js');
const tasksLib = require('../tasks.js');
const metricsLib = require('../metrics.js');
const stats = require('../stats.js');
const report = require('../report.js');
const environment = require('../environment.js');
const adapters = require('../adapters.js');
const adaptersA = require('../adapters-a.js');
const verifyVerb = require('./verify.js');

const flags = { config: 'value', corpus: 'value', split: 'value', class: 'value', out: 'value', 'key-file': 'value' };

const WARMUPS = 3;
const RUNS = 30;
/** The metrics each class is compared on, A against B. */
const PRIMARY = {
  code: ['recallAt1', 'recallAt5', 'recallAt10', 'mrrAt10'],
  guidance: ['recallAt1', 'recallAt3', 'recallAt5', 'mrrAt5'],
};
const OUTCOME_PRIMARY = ['statusMatch', 'mustIncludeMet', 'mustSurviveMet'];
const TOOL_OF_PROVIDER = { 'native.rg': 'rg', fd: 'fd', 'semble.search': 'semble', 'graphify.query': 'graphify', rtk: 'rtk' };

class Refused extends sealLib.SealError {}

function parseSelection(args) {
  const configs = String(args.config || 'A,B').split(',').map((s) => s.trim());
  if (!configs.every((c) => c === 'A' || c === 'B') || new Set(configs).size !== configs.length) throw new Refused('--config must be A, B or A,B');
  const corpus = args.corpus || 'all';
  if (!['code', 'guidance', 'all'].includes(corpus)) throw new Refused('--corpus must be code, guidance or all');
  const split = args.split || 'dev';
  if (!['dev', 'holdout'].includes(split)) throw new Refused('--split must be dev or holdout');
  if (args.class && !metricsLib.CLASSES.includes(args.class)) throw new Refused(`--class must be one of ${metricsLib.CLASSES.join(', ')}`);
  return { configs: ['A', 'B'].filter((c) => configs.includes(c)), corpora: corpus === 'all' ? ['code', 'guidance'] : [corpus], split, cls: args.class };
}

function loadThresholds(repoRoot) {
  const file = path.join(repoRoot, 'bench', 'retrieval', 'thresholds.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function loadSealMeta(repoRoot, corpora) {
  const dir = path.join(repoRoot, 'bench', 'retrieval', 'holdout');
  const meta = {};
  for (const corpus of corpora) {
    const gens = sealLib.listGenerations(dir, corpus);
    if (gens.length === 0) throw new Refused(`no sealed holdout for the ${corpus} corpus`);
    const generation = gens[gens.length - 1];
    meta[corpus] = { generation, seal: sealLib.readSeal(dir, corpus, generation), envelope: sealLib.readEnvelope(dir, corpus, generation), label: `bench/retrieval/holdout/${corpus}.g${generation}.sealed.json` };
  }
  return meta;
}

function firstCause(answer) {
  const p = (answer.providers || []).find((x) => x.state === 'unreached' && x.id !== 'rtk' && x.id !== 'fd');
  return p ? p.cause : undefined;
}

function componentsOf(answers, snapshot) {
  const seen = new Map();
  for (const answer of answers) {
    for (const p of answer.providers || []) {
      const cur = seen.get(p.id) || { reached: false, cause: undefined };
      if (p.state === 'reached') cur.reached = true;
      else if (!cur.cause) cur.cause = p.cause;
      seen.set(p.id, cur);
    }
  }
  const versionOf = (id) => {
    const tool = TOOL_OF_PROVIDER[id] && snapshot.tools.find((t) => t.id === TOOL_OF_PROVIDER[id]);
    return tool ? tool.versionLine : null;
  };
  return [...seen.keys()].sort().map((id) => {
    const cur = seen.get(id);
    const row = { id, version: versionOf(id), state: cur.reached ? 'reached' : 'unreached' };
    if (!cur.reached && cur.cause) row.cause = cur.cause;
    return row;
  });
}

/** 3 warm-ups, then `runs` invocations drawn cyclically from `tasks`, the configurations in a seeded random order per round. */
function measureLatency({ tasks, configs, call, seed, corpus, cls, warmups, runs }) {
  const samples = Object.fromEntries(configs.map((c) => [c, []]));
  for (let i = 0; i < warmups; i++) for (const c of configs) call(c, tasks[i % tasks.length]);
  const rng = stats.mulberry32(stats.streamSeed(seed, corpus, 'latency', cls, 'order'));
  for (let r = 0; r < runs; r++) {
    const task = tasks[r % tasks.length];
    for (const c of stats.shuffle(configs, rng)) samples[c].push(call(c, task).wallMs);
  }
  return samples;
}

function summaryLines(corpora, split) {
  const lines = [];
  for (const [corpus, result] of Object.entries(corpora)) {
    for (const [config, cfg] of Object.entries(result.configs)) {
      for (const [cls, row] of Object.entries(cfg.classes)) {
        if (!row.applicable) { lines.push(`${corpus} ${config} ${cls}: n/a`); continue; }
        const key = Object.keys(row.metrics).find((m) => m.startsWith('recallAt')) || 'statusMatch';
        const m = row.metrics[key];
        lines.push(`${corpus} ${config} ${cls}: n=${row.n}${row.underpowered ? ' underpowered' : ''}${m ? ` ${key}=${m.value === null ? 'n/a' : m.value.toFixed(3)}` : ''}${row.state === 'unreached' ? ' unreached' : ''}`);
      }
    }
  }
  return lines;
}

function git(repoRoot, args) {
  try { return snapshotLib.git(repoRoot, args).toString('utf8').trim(); } catch { return ''; }
}

function defaultDeps() {
  return {
    runConfig: adapters.runConfig,
    buildIndexes: adaptersA.buildIndexes,
    materialiseExport: environment.materialiseExport,
    verifySnapshot: verifyVerb.verifySnapshot,
    preconditions: () => require('./holdout-preconditions.js'),
    latency: { warmups: WARMUPS, runs: RUNS },
  };
}

/**
 * Runs the selected configurations over the selected corpora and split. Returns
 * `{exitCode, codes?, lines, report?, results?, error?}`. `deps` lets a test inject adapters.
 */
function execute({ args, snapshotPath, repoRoot, tmp, keepTmp = false, env = process.env, home, deps: rawDeps, now = new Date() }) {
  const deps = { ...defaultDeps(), ...(rawDeps || {}) };
  const selection = parseSelection(args);
  const { configs, corpora, split, cls } = selection;
  const verified = deps.verifySnapshot({ snapshotPath, repoRoot });
  if (verified.exitCode !== 0) return { exitCode: verified.exitCode, codes: verified.codes, lines: [`run: ${verified.message}`], error: verified.message };
  const snapshot = verified.snapshot;
  const manifest = snapshotLib.loadManifest(path.resolve(repoRoot, snapshot.manifestPath));
  const lines = [];

  // Holdout: preconditions first, before anything is decrypted.
  let sealMeta;
  let key;
  if (split === 'holdout') {
    if (args.out) throw new Refused('--out is not accepted with --split holdout: results go to bench/retrieval/results only');
    sealMeta = loadSealMeta(repoRoot, corpora);
    const gate = deps.preconditions().check({ args, repoRoot, snapshot, thresholds: loadThresholds(repoRoot), sealMeta, env, home });
    if (!gate.ok) return { exitCode: gate.exitCode, lines: [`run: holdout precondition (${gate.precondition}) failed: ${gate.message}`], error: gate.message };
    key = sealLib.resolveKey({ keyFile: args['key-file'], env, home, repoRoot });
  }

  // Tasks.
  const tasksByCorpus = {};
  let tasksSha256 = null;
  const refuse = (findings) => {
    const detail = split === 'dev'
      ? findings.map((f) => `${f.code} ${f.taskId || '-'} ${f.message}`)
      : Object.entries(findings.reduce((n, f) => ({ ...n, [f.code]: (n[f.code] || 0) + 1 }), {})).map(([c, n]) => `${c} x${n}`);
    return { exitCode: 1, lines: [`run: ${split} task file has ${findings.length} finding(s)`, ...detail], error: 'task validation failed' };
  };
  if (split === 'dev') {
    const file = path.join(repoRoot, snapshot.taskFiles.dev.path);
    const text = fs.existsSync(file) ? fs.readFileSync(file) : null;
    tasksSha256 = sealLib.sha256Hex(text || '');
    const taskFile = text ? JSON.parse(text.toString('utf8')) : { schemaVersion: 1, snapshotId: snapshot.snapshotId, split: 'dev', tasks: [] };
    const findings = tasksLib.validateTaskFile(taskFile, { split, snapshot, manifest, repoRoot });
    if (findings.length > 0) return refuse(findings);
    for (const corpus of corpora) tasksByCorpus[corpus] = taskFile.tasks.filter((t) => t.corpus === corpus && (!cls || t.class === cls));
  } else {
    for (const corpus of corpora) {
      const { taskFile } = sealLib.decrypt(sealMeta[corpus].envelope, key.passphrase, sealMeta[corpus].label);
      const findings = tasksLib.validateTaskFile(taskFile, { split, snapshot, manifest, repoRoot, corpus });
      if (findings.length > 0) return refuse(findings);
      tasksByCorpus[corpus] = taskFile.tasks.filter((t) => t.corpus === corpus && (!cls || t.class === cls));
    }
  }

  // Export.
  const exported = deps.materialiseExport(snapshot.commit, path.join(tmp, 'export'), snapshot, { repoRoot, keep: keepTmp });
  try {
    const lineCounts = new Map();
    const manifestIndex = new Map(manifest.entries.map((e) => [`${e.corpus}\0${e.path}`, e]));
    const pathInfoFor = (corpus) => (p) => {
      if (!manifestIndex.has(`${corpus}\0${p}`)) return null;
      if (!lineCounts.has(p)) {
        const file = path.join(exported.treeRoot, p);
        lineCounts.set(p, fs.existsSync(file) ? tasksLib.splitLines(fs.readFileSync(file)).length : 0);
      }
      return { lineCount: lineCounts.get(p) };
    };
    const semble = { env: require('../../runner.js').childEnv({ SEMBLE_CACHE_DIR: path.join(tmp, 'semble-cache') }) };
    const workDir = path.join(tmp, 'copies');
    const call = (config, corpus, task) => deps.runConfig({ config, corpus, task, exportRoot: exported.treeRoot, snapshot, workDir, semble, scratchDir: path.join(tmp, 'scratch'), repoRoot });

    const corporaOut = {};
    const perTask = [];
    const holdoutResults = {};
    for (const corpus of corpora) {
      const tasks = tasksByCorpus[corpus];
      const byConfig = {};
      let index;
      if (configs.includes('A') && corpus === 'code' && tasks.length > 0) {
        const probe = manifest.entries.find((e) => e.corpus === 'code' && /^src\/.*\.(ts|js)$/.test(e.path));
        index = deps.buildIndexes({ exportRoot: exported.treeRoot, semble, patchFile: probe ? path.join(exported.treeRoot, probe.path) : undefined });
      }
      for (const config of ['B', 'A']) {
        if (!configs.includes(config)) continue;
        const answers = tasks.map((task) => {
          if (config === 'A' && corpus === 'guidance') return byConfig.B ? byConfig.B.answers[tasks.indexOf(task)] : call('B', corpus, task);
          return call(config, corpus, task);
        });
        byConfig[config] = { answers };
      }

      const latency = {};
      for (const c of metricsLib.classesFor(corpus)) {
        const classTasks = tasks.filter((t) => t.class === c);
        if (classTasks.length === 0) continue;
        const measured = configs.filter((x) => !(x === 'A' && corpus === 'guidance'));
        latency[c] = measureLatency({
          tasks: classTasks, configs: measured, call: (config, task) => call(config, corpus, task), seed: snapshot.seed, corpus, cls: c,
          warmups: deps.latency.warmups, runs: deps.latency.runs,
        });
      }

      const configResults = {};
      const scoredByConfig = {};
      for (const config of configs) {
        const answers = byConfig[config].answers;
        const scored = tasks.map((task, i) => metricsLib.scoreTask({ task, answer: answers[i], pathInfo: pathInfoFor(corpus) }));
        scoredByConfig[config] = scored;
        const classResults = {};
        for (const c of metricsLib.classesFor(corpus)) {
          const idx = tasks.map((t, i) => (t.class === c ? i : -1)).filter((i) => i >= 0);
          const samples = latency[c] ? (latency[c][config] || latency[c].B || []) : [];
          const classTasks = idx.map((i) => ({ scored: scored[i], result: answers[i].result, cause: firstCause(answers[i]) }));
          classResults[c] = report.classResult({
            corpus, config, cls: c, seed: snapshot.seed,
            tasks: classTasks,
            latencyMs: samples,
            unreachedCount: classTasks.filter((t) => t.result === 'UNREACHED').length,
          });
        }
        configResults[config] = report.configResult({
          ...(config === 'A' && corpus === 'guidance' ? { sameAs: 'B' } : {}),
          components: componentsOf(answers, snapshot),
          ...(config === 'A' && corpus === 'code' && index ? { index } : {}),
          classes: report.classesBlock({ corpus, results: classResults }),
        });
        if (split === 'dev') {
          tasks.forEach((task, i) => perTask.push({
            id: task.id, corpus, config, result: answers[i].result, freshness: answers[i].freshness,
            metrics: Object.fromEntries(Object.entries(scored[i].metrics).sort(([a], [b]) => (a < b ? -1 : 1))),
          }));
        }
      }

      const comparisons = [];
      if (configs.length === 2) {
        for (const c of metricsLib.classesFor(corpus)) {
          const idx = tasks.map((t, i) => (t.class === c ? i : -1)).filter((i) => i >= 0);
          if (idx.length === 0) continue;
          const names = [
            ...(metricsLib.kindOf(c) === 'ranking' ? PRIMARY[corpus] : []),
            ...(c === 'exact-lookup' ? ['successAt1'] : []),
            ...(c === 'conceptual-discovery' ? [corpus === 'code' ? 'fileRecallAt10' : 'fileRecallAt5'] : []),
            ...(c === 'impact-refactor' ? ['missedDependencies'] : []),
            ...(metricsLib.kindOf(c) === 'outcome' ? OUTCOME_PRIMARY : []),
          ];
          for (const metric of names) {
            const a = idx.map((i) => scoredByConfig.A[i].metrics[metric]);
            const b = idx.map((i) => scoredByConfig.B[i].metrics[metric]);
            if (a.every((v) => v === undefined) && b.every((v) => v === undefined)) continue;
            comparisons.push(stats.compare({ metric, cls: c, corpus, seed: snapshot.seed, aValues: a.map((v) => (v === undefined ? null : v)), bValues: b.map((v) => (v === undefined ? null : v)) }));
          }
        }
      }
      corporaOut[corpus] = { configs: configResults, comparisons };
      if (split === 'holdout') holdoutResults[corpus] = { configResults, comparisons };
    }

    lines.push(...summaryLines(corporaOut, split));
    if (split === 'dev') {
      const body = {
        schemaVersion: 1, snapshotId: snapshot.snapshotId, commit: snapshot.commit, split: 'dev', tasksSha256,
        corpora: corporaOut, perTask,
      };
      if (args.out) { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, sealLib.toFileText(body)); lines.push(`wrote ${args.out}`); }
      return { exitCode: 0, lines, report: body };
    }

    const written = writeHoldout({ holdoutResults, sealMeta, snapshot, repoRoot, configs, now });
    lines.push(...written.map((f) => `wrote ${f}`));
    return { exitCode: 0, lines, results: written, aggregates: Object.fromEntries(Object.entries(holdoutResults).map(([k, v]) => [k, Object.fromEntries(Object.entries(v.configResults).map(([c, r]) => [c, r.classes]))])) };
  } finally {
    exported.cleanup();
  }
}

function writeHoldout({ holdoutResults, sealMeta, snapshot, repoRoot, configs, now }) {
  const dir = path.join(repoRoot, 'bench', 'retrieval', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const thresholdsCommit = git(repoRoot, ['log', '-1', '--format=%H', '--', 'bench/retrieval/thresholds.json']);
  const machine = report.machineId();
  const written = [];
  for (const [corpus, result] of Object.entries(holdoutResults)) {
    const { generation, seal } = sealMeta[corpus];
    const existing = fs.readdirSync(dir).filter((f) => new RegExp(`^holdout-${snapshot.snapshotId}-g${generation}-(code|guidance)-[AB]\\.json$`).test(f)).length;
    configs.forEach((config, i) => {
      const file = report.holdoutResultName(snapshot.snapshotId, generation, corpus, config);
      const body = report.buildHoldoutResult({
        snapshotId: snapshot.snapshotId, generation, corpus, config, sealPlaintextSha256: seal.plaintextSha256, thresholdsCommit,
        runAt: now.toISOString(), runIndex: existing + i + 1, machineId: machine, classes: result.configResults[config].classes,
      });
      fs.writeFileSync(path.join(dir, file), sealLib.toFileText(body));
      written.push(path.join('bench', 'retrieval', 'results', file));
    });
    if (configs.length === 2) {
      const file = report.comparisonName(snapshot.snapshotId, generation, corpus);
      fs.writeFileSync(path.join(dir, file), sealLib.toFileText(report.buildComparisonFile({ snapshotId: snapshot.snapshotId, generation, corpus, comparisons: result.comparisons })));
      written.push(path.join('bench', 'retrieval', 'results', file));
    }
  }
  return written;
}

function run(ctx) {
  const out = execute({ args: ctx.args, snapshotPath: ctx.snapshotPath, repoRoot: ctx.repoRoot, tmp: ctx.tmp, keepTmp: ctx.keepTmp });
  const { exitCode, codes, lines, report: body, results, aggregates, error } = out;
  const extra = {};
  if (error) extra.error = error;
  if (body) extra.report = body;
  if (results) { extra.results = results; extra.aggregates = aggregates; }
  if (body && !ctx.json && !ctx.args.out) return { exitCode, codes, lines: [...lines, JSON.stringify(body, null, 2)], ...extra };
  return { exitCode, codes, lines, ...extra };
}

module.exports = { flags, WARMUPS, RUNS, PRIMARY, parseSelection, measureLatency, componentsOf, execute, run, defaultDeps };

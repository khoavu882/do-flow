'use strict';

// Feature 151 B.6 (IC-023; FR-014 to FR-016, NFR-002): the advice world, pick, miss and outcome records written
// into a project's advice store by the core's own writers (`appendPick`, `appendMiss` and `appendOutcome`,
// src/runtime/advice/record.ts), loaded from the checkout the `--core` path names, each under an injected clock.
//
// The records, by role (days count back from `now`, the UTC noon of each day, so every day is inside the
// 90-day window `advise --action report` and `advice-picks` read, and each role lands on the same UTC date whatever
// the hour; day 0's noon may be later than `now`, which neither reader refuses, since `readWindow` selects
// partitions by date only):
//   taskClass  four `task-class` picks over three days: day 0 `mode: 'shadow'`, day 1 no mode, day 2 one
//              `mode: 'shadow'` and one with no mode; the day 1 pick has one outcome
//   tier       two `tier` picks on day 0, neither with an outcome
//   miss       one `task-class` miss on day 1
//   adhoc      one `adhoc` pick on day 0 whose question name, option names and `instructions` hold the planted
//              secret and marker; its own pick (`keep`) holds neither, so no shown answer can carry them
//
// This module touches no test-runner global, so console/scripts can import it.

const fs = require('node:fs');
const path = require('node:path');

const DAY = 24 * 60 * 60 * 1000;
const ADVICE_PLANTED = Object.freeze({
  secret: 'fx-Advice-Secret-2e9c71',
  marker: 'ADVICE-WORLD-MARKER-8b4d',
});

type AdviceWorldOptions = {
  /** The checkout's `bin/doflow.js` (the Console's `--core`); the writers are loaded from beside it. */
  core: string;
  projectRoot: string;
  env: Record<string, string>;
  now?: number;
};

/** The checkout the core path names: `<checkout>/bin/doflow.js`. */
function checkoutOf(core: string): string {
  if (typeof core !== 'string' || !path.isAbsolute(core)) throw new TypeError('advice world: core must be an absolute path');
  return path.dirname(path.dirname(core));
}

/** UTC noon `days` days before `now`, as the injected clock of one record. */
function noonOf(now: number, days: number, minutes = 0): () => Date {
  const day = new Date(now - days * DAY).toISOString().slice(0, 10);
  return () => new Date(Date.parse(`${day}T12:00:00.000Z`) + minutes * 60_000);
}

/**
 * Writes the records into `projectRoot`'s project-state store (`advice/picks/<day>.jsonl`). Returns the pick ids
 * by role, the outcome's pick and actual, the store directory, the partition files written and the planted values.
 */
function buildAdviceWorld(options: AdviceWorldOptions) {
  const { core, projectRoot, env } = options;
  const now = options.now ?? Date.now();
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new TypeError('advice world: projectRoot must be an absolute path');
  const checkout = checkoutOf(core);
  const { appendPick, appendMiss, appendOutcome } = require(path.join(checkout, 'src', 'runtime', 'advice', 'record.ts'));
  const { loadStorageRegistry } = require(path.join(checkout, 'src', 'runtime', 'storage', 'registry.ts'));
  const { resolveRoots } = require(path.join(checkout, 'src', 'runtime', 'storage', 'roots.ts'));
  const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: checkout }), projectRoot, global: false, env });
  if (typeof roots['project-state'] !== 'string') throw new Error('advice world: the project-state root does not resolve');
  const store = path.join(roots['project-state'], 'advice', 'picks');
  if (fs.existsSync(store)) throw new Error(`advice world: ${store} exists already`);

  const files = new Set<string>();
  const written = (result: any, what: string) => {
    if (!result || typeof result.file !== 'string') throw new Error(`advice world: ${what} was not written`);
    if (result.store !== 'project-state') throw new Error(`advice world: ${what} went to ${result.store}`);
    files.add(result.file);
    return result;
  };

  const choice = { name: 'which-class', type: 'choice', options: { feature: 'a feature', bug: 'a bug', refactor: 'a refactor' } };
  const classPick = (days: number, minutes: number, pick: string, staticAnswer: string, mode?: string) => written(appendPick({
    roots, now: noonOf(now, days, minutes), kind: 'task-class',
    answer: { name: 'which-class', type: 'choice', pick, probabilities: { [pick]: 0.8 }, confidence: 0.7, strength: { word: 'clear', between: null } },
    question: choice, staticAnswer, state: 'advice world state', caller: 'advise', provider: 'ollama', model: 'world-model', durationMs: 120,
    ...(mode === undefined ? {} : { mode }),
  }), `task-class pick day ${days}`).pickId;
  const taskClass = [
    classPick(0, 0, 'feature', 'bug', 'shadow'),
    classPick(1, 0, 'bug', 'bug'),
    classPick(2, 0, 'refactor', 'feature', 'shadow'),
    classPick(2, 5, 'feature', 'feature'),
  ];
  const outcome = { pickId: taskClass[1], actual: 'feature' };
  written(appendOutcome({ roots, now: noonOf(now, 1, 30), pickId: outcome.pickId, actual: outcome.actual, source: 'caller' }), 'outcome');

  const tierQuestion = { name: 'which-tier', type: 'choice', options: { light: 'light', standard: 'standard', frontier: 'frontier' } };
  const tierPick = (minutes: number, pick: string) => written(appendPick({
    roots, now: noonOf(now, 0, minutes), kind: 'tier',
    answer: { name: 'which-tier', type: 'choice', pick, probabilities: { [pick]: 0.6 }, confidence: 0.5, strength: { word: 'lean', between: null } },
    question: tierQuestion, staticAnswer: 'standard', state: 'advice world tier state', caller: 'dispatch', provider: 'ollama', model: 'world-model', durationMs: 80,
  }), `tier pick ${minutes}`).pickId;
  const tier = [tierPick(10, 'standard'), tierPick(11, 'frontier')];

  written(appendMiss({ roots, now: noonOf(now, 1, 40), kind: 'task-class', caller: 'advise', reason: 'timeout', model: 'world-model', durationMs: 5000, mode: 'shadow' }), 'miss');

  const { secret, marker } = ADVICE_PLANTED;
  const adhocQuestion = {
    name: `adhoc-${marker}`, type: 'choice',
    options: { keep: 'keep it', [`drop-${secret}`]: `drop ${secret}`, [`hold-${marker}`]: `hold ${marker}` },
    instructions: `Answer for password=${secret} and ${marker}.`,
  };
  const adhoc = written(appendPick({
    roots, now: noonOf(now, 0, 20), kind: 'adhoc',
    answer: { name: adhocQuestion.name, type: 'choice', pick: 'keep', probabilities: { keep: 0.9 }, confidence: 0.9, strength: { word: 'clear', between: null } },
    question: adhocQuestion, staticAnswer: null, state: `adhoc state ${secret}`, caller: 'advise', provider: 'ollama', model: 'world-model', durationMs: 60,
  }), 'adhoc pick').pickId;

  return {
    store,
    files: Object.freeze([...files].sort()),
    picks: Object.freeze({ taskClass: Object.freeze(taskClass), tier: Object.freeze(tier), adhoc }),
    outcome: Object.freeze(outcome),
    planted: ADVICE_PLANTED,
  };
}

module.exports = { ADVICE_PLANTED, buildAdviceWorld };

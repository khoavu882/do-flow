'use strict';

// 143 D.3 (IC-005; FR-007): the `[Agent Teams & Coordination]` section of `doflow doctor`, in text and JSON,
// in advisory and block mode. The settings are real layer files in a scratch HOME and project
// (createSettingsEnv), never the real ones. Nothing here spawns a process, probes a provider or reaches the
// network: probes get a throwing exec stub and a throwing fetch stub, the home and the tmp dir are scratch.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSettingsEnv } = require('../helper/settings-fixtures.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { handleDoctorCommand } = require('../../src/runtime/health.ts');
const evaluateModule = require('../../src/runtime/team/evaluate.ts');

const NO_TMP = path.join(path.parse(__dirname).root, 'doflow-no-such-system-tmp');
const HEADER = '[Agent Teams & Coordination]';
const stubExec = () => { const error: any = new Error('not found'); error.code = 'ENOENT'; throw error; };
const stubFetch = async () => { throw new Error('offline'); };

const E = 'team.enforcement';
const W = 'team.writerCap';
const M = 'team.maxAttempts';

/** Runs `handleDoctorCommand` against the fixture; returns the printed lines and the parsed JSON when `json`. */
async function runDoctor(f: any, { json = false }: { json?: boolean } = {}) {
  const lines: string[] = [];
  const log = console.log;
  const saved = process.exitCode;
  console.log = (...args: any[]) => lines.push(args.join(' '));
  try {
    await handleDoctorCommand({
      json, repoRoot: REPO_ROOT, projectRoot: f.project,
      env: f.env({ DOFLOW_TELEMETRY: 'off' }), homeDir: f.home, tmpDir: NO_TMP,
      execFileImpl: stubExec, fetchImpl: stubFetch,
    });
  } finally {
    console.log = log;
    process.exitCode = saved;
  }
  const text = lines.join('\n');
  return { text, lines: text.split('\n'), report: json ? JSON.parse(text) : null };
}

// A doctor run takes seconds, so each scenario runs once per output form and every test reads the cached
// answer. Fixtures live to the end of the file (the `after` hook below), not to the end of one test.
const cleanups: Array<() => void> = [];
const fixtureContext = { after: (fn: () => void) => { cleanups.push(fn); } };
after(() => { for (const fn of cleanups.splice(0)) fn(); });

/** Probe timings vary run to run; the comparisons are about content. */
const dropTimings = (key: string, value: unknown) => (key === 'durationMs' ? undefined : value);

type Scenario = { settings?: Record<string, unknown>; user?: Record<string, unknown>; failGate?: boolean };
const cache = new Map<string, Promise<any>>();

/** The doctor output of `scenario` in `form`, with the scenario's fixture root masked to `<dir>`. */
function doctor(name: string, scenario: Scenario, form: 'text' | 'json'): Promise<any> {
  const key = `${name}:${form}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const f = createSettingsEnv(fixtureContext, { prefix: 'doflow-team-doctor-' });
      if (scenario.settings) f.writeProjectSettings({ schema: 1, ...scenario.settings });
      if (scenario.user) f.writeUserSettings({ schema: 1, ...scenario.user });
      const original = evaluateModule.teamGate;
      if (scenario.failGate) evaluateModule.teamGate = () => { throw new Error('team boom'); };
      try {
        const got = await runDoctor(f, { json: form === 'json' });
        const mask = (value: string) => value.split(f.dir).join('<dir>');
        return { text: mask(got.text), lines: got.lines.map(mask), report: got.report ? JSON.parse(mask(JSON.stringify(got.report, dropTimings))) : null };
      } finally {
        evaluateModule.teamGate = original;
      }
    })());
  }
  return cache.get(key) as Promise<any>;
}

const ADVISORY: Scenario = { settings: { [E]: 'advisory' } };
const BLOCK: Scenario = { settings: { [E]: 'block' } };
const TUNED: Scenario = { settings: { [E]: 'advisory' }, user: { [W]: 2, [M]: 5 } };
const FAILING: Scenario = { settings: { [E]: 'advisory' }, failGate: true };

/** The lines of the team block: the header through the line before the next blank line. */
function teamBlock(allLines: string[]): string[] {
  const start = allLines.indexOf(HEADER);
  assert.notEqual(start, -1, `missing ${HEADER}`);
  const end = allLines.findIndex((line, index) => index > start && line === '');
  return allLines.slice(start, end < 0 ? undefined : end);
}

/** The printed text with the team block (and its leading blank line) cut out. */
function withoutTeamBlock(allLines: string[]): string[] {
  const start = allLines.indexOf(HEADER);
  const end = allLines.findIndex((line, index) => index > start && line === '');
  return [...allLines.slice(0, start - 1), ...allLines.slice(end < 0 ? allLines.length : end)];
}

describe('IC-005: report.team in JSON', () => {
  test('no settings file at all: the ready shape with the shipped limits, advisory, both sites wired (advisory)', async () => {
    const { report } = await doctor('default', {}, 'json');
    assert.deepEqual(report.team, {
      state: 'ready', writerCap: 1, maxAttempts: 3, enforcement: 'advisory',
      wired: { dispatch: 'wired (advisory)', review: 'wired (advisory)' },
    });
  });

  test('advisory set explicitly: the same shape', async () => {
    const { report } = await doctor('advisory', ADVISORY, 'json');
    assert.deepEqual(report.team, {
      state: 'ready', writerCap: 1, maxAttempts: 3, enforcement: 'advisory',
      wired: { dispatch: 'wired (advisory)', review: 'wired (advisory)' },
    });
  });

  test('block: dispatch reads wired (blocking), review stays wired (advisory)', async () => {
    const { report } = await doctor('block', BLOCK, 'json');
    assert.deepEqual(report.team, {
      state: 'ready', writerCap: 1, maxAttempts: 3, enforcement: 'block',
      wired: { dispatch: 'wired (blocking)', review: 'wired (advisory)' },
    });
  });

  test('the limits come from the same settings resolution the call sites use', async () => {
    const { report } = await doctor('tuned', TUNED, 'json');
    assert.equal(report.team.writerCap, 2);
    assert.equal(report.team.maxAttempts, 5);
    assert.equal(report.team.enforcement, 'advisory');
  });

  test('activeClaimsCount and _symbols are gone: not under team, not anywhere in the report', async () => {
    for (const [name, scenario] of [['advisory', ADVISORY], ['block', BLOCK]] as Array<[string, Scenario]>) {
      const { text, report } = await doctor(name, scenario, 'json');
      assert.deepEqual(Object.keys(report.team).sort(), ['enforcement', 'maxAttempts', 'state', 'wired', 'writerCap'], name);
      assert.deepEqual(Object.keys(report.team.wired).sort(), ['dispatch', 'review'], name);
      assert.equal(text.includes('activeClaimsCount'), false, name);
      assert.equal(text.includes('_symbols'), false, name);
    }
  });
});

describe('IC-005: the text block', () => {
  test('advisory: the header and the three lines exactly, in order', async () => {
    const { lines } = await doctor('advisory', ADVISORY, 'text');
    assert.deepEqual(teamBlock(lines), [
      HEADER,
      '  writer cap: 1, max attempts: 3, enforcement: advisory',
      '  dispatch admission: wired (advisory)',
      '  review start and check: wired (advisory)',
    ]);
  });

  test('block: only the enforcement word and the dispatch line change', async () => {
    const { lines } = await doctor('block', BLOCK, 'text');
    assert.deepEqual(teamBlock(lines), [
      HEADER,
      '  writer cap: 1, max attempts: 3, enforcement: block',
      '  dispatch admission: wired (blocking)',
      '  review start and check: wired (advisory)',
    ]);
  });

  test('configured limits print in the first line', async () => {
    const { lines } = await doctor('tuned', TUNED, 'text');
    assert.equal(teamBlock(lines)[1], '  writer cap: 2, max attempts: 5, enforcement: advisory');
  });

  test('the removed fields do not print', async () => {
    for (const [name, scenario] of [['advisory', ADVISORY], ['block', BLOCK]] as Array<[string, Scenario]>) {
      const { text } = await doctor(name, scenario, 'text');
      assert.equal(/active claims|activeClaimsCount|_symbols|symbols/i.test(text), false, name);
    }
  });

  test('the block is four lines, set off by a blank line before the header and one after', async () => {
    const { lines } = await doctor('advisory', ADVISORY, 'text');
    const at = lines.indexOf(HEADER);
    assert.ok(at > 0);
    assert.equal(lines[at - 1], '');
    assert.equal(lines[at + 4], '');
  });
});

describe('IC-005: the section cannot load', () => {
  test('JSON: { state: unavailable, message } and nothing else', async () => {
    const { report } = await doctor('failing', FAILING, 'json');
    assert.deepEqual(report.team, { state: 'unavailable', message: 'team boom' });
  });

  test('text: the header and one unavailable line, no wired lines', async () => {
    const { lines, text } = await doctor('failing', FAILING, 'text');
    assert.deepEqual(teamBlock(lines), [HEADER, '  team: unavailable (team boom)']);
    assert.equal(text.includes('wired ('), false);
  });

  test('the failure stays in the section: every other report key matches the ready run', async () => {
    const failing = (await doctor('failing', FAILING, 'json')).report;
    const ready = (await doctor('advisory', ADVISORY, 'json')).report;
    const { team: _a, ...failingRest } = failing;
    const { team: _b, ...readyRest } = ready;
    assert.deepEqual(failingRest, readyRest);
  });

  test('the export is restored afterwards: a later run is ready again', async () => {
    assert.equal(typeof evaluateModule.teamGate, 'function');
    const { report } = await doctor('block', BLOCK, 'json');
    assert.equal(report.team.state, 'ready');
  });
});

describe('IC-005: the rest of the doctor output is untouched', () => {
  test('the text outside the team block is identical in advisory and block', async () => {
    const advisory = (await doctor('advisory', ADVISORY, 'text')).lines;
    const block = (await doctor('block', BLOCK, 'text')).lines;
    assert.equal(advisory.filter((line: string) => line === HEADER).length, 1);
    assert.equal(block.filter((line: string) => line === HEADER).length, 1);
    assert.deepEqual(withoutTeamBlock(advisory), withoutTeamBlock(block));
  });

  test('the JSON outside report.team is identical in advisory and block, key order included', async () => {
    const advisory = (await doctor('advisory', ADVISORY, 'json')).report;
    const block = (await doctor('block', BLOCK, 'json')).report;
    assert.deepEqual(Object.keys(advisory), Object.keys(block));
    const { team: _a, ...advisoryRest } = advisory;
    const { team: _b, ...blockRest } = block;
    assert.deepEqual(advisoryRest, blockRest);
  });
});

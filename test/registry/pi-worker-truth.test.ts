'use strict';
// Row 168: the Pi worker block says only what the installed Pi (1.5.2) shows. The main-session recipe passes the
// project-trust flag that makes a headless run load no unapproved project code (`--no-approve`) and never the
// approving one; resume, persistentSession and steering are decided, not unknown; every Pi evidence record names
// the Pi version it was taken on. Guard G41 (test/guards/worker-descriptors.test.ts) is not touched by this file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const { loadRegistry, validateWorker } = require('../../src/registry/index.ts');
const { wideningProblem } = require('../../src/registry/widening-flags.ts');
const { mainArgv } = require('../../src/runtime/worker/launch.ts');

const registry = loadRegistry({ repoRoot: REPO });
const pi = registry.harnesses.find((h: any) => h.id === 'pi').worker;
const EVIDENCE = path.join(REPO, 'core', 'worker-evidence', 'pi');
const record = (name: string) => JSON.parse(fs.readFileSync(path.join(REPO, name), 'utf8'));

test('trust: the main-session recipe passes --no-approve before the prompt separator, and never --approve', () => {
  const argv: string[] = pi.mainSession.argv;
  assert.ok(argv.includes('--no-approve'), argv.join(' '));
  assert.ok(argv.indexOf('--no-approve') < argv.indexOf('--'), '--no-approve must come before `--`');
  assert.ok(!argv.some((a) => a === '--approve' || a === '-a'));
  assert.deepEqual(mainArgv(pi, 'the prompt').filter((a: string) => /approve/.test(a)), ['--no-approve']);
});

test('trust: the widening guard still refuses the approving flag in a pi recipe and accepts the safe one', () => {
  for (const approving of [['--approve'], ['-a'], ['--approve=1']]) {
    assert.equal(wideningProblem(['-p', ...approving, '--', '{prompt}'], { binary: 'pi', mainSession: true }) !== null, true, approving.join(' '));
    const worker = structuredClone(pi);
    worker.mainSession.argv = ['-p', '--mode', 'json', ...approving, '--', '{prompt}'];
    const errors: string[] = [];
    validateWorker(worker, "harness 'pi'", errors);
    assert.match(errors.join('\n'), /widening flag/, approving.join(' '));
  }
  assert.equal(wideningProblem(['-p', '--no-approve', '-na', '--', '{prompt}'], { binary: 'pi', mainSession: true }), null);
});

test('trust: the main-session entry cites a Pi 1.5.2 record whose project-trust check passed', () => {
  const cited = pi.mainSession.evidence.map((name: string) => record(name));
  const hit = cited.find((r: any) => r.checks.some((c: any) => c.id === 'project-trust' && c.result === 'pass' && c.exit === 0
    && c.matched.some((line: string) => /--no-approve, -na\s+Ignore project-local files/.test(line))));
  assert.ok(hit, 'no cited record has a passing project-trust check');
  assert.equal(hit.cliVersion, '1.5.2');
  assert.ok(hit.establishes.includes('mainSession'));
});

test('capabilities: resume, persistentSession and steering are each decided, with evidence that names the Pi version', () => {
  for (const key of ['resume', 'persistentSession', 'steering']) {
    const entry = pi[key];
    assert.ok(entry.status === 'supported' || entry.status === 'unsupported', `${key} is ${entry.status}`);
    assert.ok(entry.evidence.length > 0, key);
    assert.match(entry.evidence.join('\n'), /\bpi 1\.5\.2\b/, `${key} evidence names no Pi version`);
    assert.equal(entry.verifiedOn, '2026-11-16', key);
    assert.ok(!('reason' in entry) || entry.reason.trim() !== '', key);
  }
});

test('login probe: the registry entry records why the static recipe stays unknown and points at the code probe', () => {
  const entry = pi.loginProbe;
  assert.equal(entry.status, 'unknown');
  assert.match(entry.reason, /--provider or --model/);
  assert.match(entry.reason, /probePi/);
  assert.match(entry.reason, /pi 1\.5\.2/);
});

test('evidence: every Pi record names the Pi version it was taken on', () => {
  const records = fs.readdirSync(EVIDENCE).filter((name: string) => name.endsWith('.json') && name !== 'checks.json');
  assert.ok(records.length >= 6, records.join(', '));
  for (const name of records) {
    const data = JSON.parse(fs.readFileSync(path.join(EVIDENCE, name), 'utf8'));
    assert.match(String(data.cliVersion), /^\d+\.\d+\.\d+$/, name);
  }
});

test('evidence: every registry sentence that dates a Pi run or check names the version of the record it cites', () => {
  // `Recorded <date> on pi X` / `Live runs <date> (pi X`: the X must be the cliVersion of a record the entry cites.
  for (const [key, entry] of Object.entries<any>(pi)) {
    if (!entry || typeof entry !== 'object' || typeof entry.verification !== 'string') continue;
    const named = [...entry.verification.matchAll(/\bpi (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    const cited = entry.evidence.filter((e: string) => e.startsWith('core/worker-evidence/pi/')).map((e: string) => record(e).cliVersion);
    for (const version of named) assert.ok(cited.includes(version), `${key}: names pi ${version}, cited records are ${cited.join(', ') || 'none'}`);
  }
});

test('evidence: the live-run sentence names the version the live-run records carry', () => {
  for (const key of ['readOnly', 'spawnDenial']) {
    const entry = pi[key];
    const said = entry.verification.match(/Live runs [\d-]+ \(pi (\d+\.\d+\.\d+)/)?.[1];
    const live = entry.evidence.map((e: string) => record(e)).filter((r: any) => r.kind === 'live-run').map((r: any) => r.cliVersion);
    assert.ok(said && live.length > 0 && live.every((v: string) => v === said), `${key}: sentence says ${said}, records say ${live.join(', ')}`);
  }
});

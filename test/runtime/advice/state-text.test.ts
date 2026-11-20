'use strict';

// 180 K4 (design section 8, IC-180-G1, AC-7): opt-in, masked, local-only capture of the routing kinds' state text.
// Every case runs against scratch roots and a fake decision server; no model, no real ~/.doflow.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('../../helper/tmp.ts');
const { startFakeServer, answering } = require('../../helper/fake-decision-server.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');
const { loadAdviceRegistry } = require('../../../src/runtime/advice/registry.ts');
const { loadStorageRegistry } = require('../../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../../src/runtime/advice/record.ts');
const { createAdviceClient } = require('../../../src/runtime/advice/client.ts');
const { recordCall } = require('../../../src/runtime/advice/shadow-dispatcher.ts');
const { captureState, cutToBytes, resetCaptureSetting, MAX_TEXT_BYTES } = require('../../../src/runtime/advice/state-text.ts');

const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const OTHER_HOME = '/Users/alice/secrets/plan.txt';
const OWN_HOME = path.join(os.homedir(), 'work', 'notes.txt');
const STATE = `Choose a tier. Context: token ${TOKEN}; files ${OWN_HOME} and ${OTHER_HOME}.`;
const TIER_SET = {
  state: STATE,
  questions: [{ name: 'tier', type: 'choice', instructions: 'Choose a tier.', options: { light: 'Light', standard: 'Normal', frontier: 'Frontier' } }],
};
const SAME_ISSUE_SET = {
  state: `Pair: ${TOKEN}`,
  questions: [{ name: 'same-issue', type: 'yesno', instructions: 'Same issue?', no: 'Different', yes: 'Same' }],
};

const loopback = (_host: any, _options: any, callback: any) => callback(null, [{ address: '127.0.0.1', family: 4 }]);
const writeJson = (file: string, value: any) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value)}\n`); };

/** Scratch roots; `user` and `project` are the capture key's value in each settings layer (undefined: not set). */
async function fixture(t: any, { user, project }: { user?: boolean; project?: boolean } = {}) {
  resetCaptureSetting();
  const server = await startFakeServer({ routes: { 'POST /v1/systemone': answering() } });
  t.after(() => server.close());
  const home = tempDir(t, 'doflow-state-text-home-');
  const projectRoot = tempDir(t, 'doflow-state-text-project-');
  const roots = resolveRoots({ registry: STORAGE, projectRoot, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') } });
  writeJson(path.join(roots['config-home'], 'settings.json'), {
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash',
    ...(user === undefined ? {} : { 'advice.capture.state-text': user }),
  });
  if (project !== undefined) writeJson(path.join(roots['project-doflow'], 'settings.json'), { schema: 1, 'advice.capture.state-text': project });
  const dir = path.join(roots['project-state'], 'advice', 'state-text');
  return {
    roots, server, dir,
    client: (extra: any = {}) => createAdviceClient({ adviceRegistry: ADVICE, roots, lookup: loopback, ...extra }),
    lines: (): any[] => (fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((name: string) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))) : []),
    picks: (): any[] => readWindow({ roots }).records.map((entry: any) => entry.record).filter((r: any) => r.type === 'pick'),
  };
}

/** The capture input with a `state` getter that counts its reads. */
function spied(roots: any, kind = 'tier') {
  const spy = { reads: 0 };
  const input = { roots, pickId: 'adv-0000000000001-abcdef', kind, store: 'project-state', get state() { spy.reads += 1; return STATE; } };
  return { spy, input };
}

for (const [label, user] of [['unset', undefined], ['false', false]] as const) {
  test(`(a) capture ${label}: a tier pick is recorded, no state-text file is written and the capture code never reads the state`, async (t) => {
    const f = await fixture(t, { user });
    const result = await f.client().ask({ questionSet: TIER_SET, kind: 'tier', staticAnswer: 'standard', caller: 'advise' });
    assert.equal(result.status, 'answered');
    assert.equal(f.picks().length, 1);
    assert.equal(fs.existsSync(path.join(f.roots['project-state'], 'advice', 'state-text')), false);
    const { spy, input } = spied(f.roots);
    assert.equal(captureState(input), null);
    assert.equal(spy.reads, 0, 'the state is not read while capture is off');
  });
}

test('(b) capture on in user settings: one masked line per routing pick, the pick line unchanged; a same-issue pick writes nothing', async (t) => {
  const f = await fixture(t, { user: true });
  const client = f.client();
  const result = await client.ask({ questionSet: TIER_SET, kind: 'tier', staticAnswer: 'standard', caller: 'advise' });
  assert.equal(result.status, 'answered');
  const lines = f.lines();
  assert.equal(lines.length, 1);
  const [line] = lines;
  const [pick] = f.picks();
  assert.deepEqual(Object.keys(line), ['schema', 'pickId', 'kind', 'at', 'stateDigest', 'text', 'textBytes', 'cut']);
  assert.equal(line.schema, 1);
  assert.equal(line.pickId, result.answers[0].pickId);
  assert.equal(line.kind, 'tier');
  assert.equal(line.stateDigest, `sha256:${crypto.createHash('sha256').update(STATE, 'utf8').digest('hex')}`);
  assert.equal(line.stateDigest, pick.stateDigest);
  assert.equal(line.cut, false);
  assert.equal(line.textBytes, Buffer.byteLength(line.text, 'utf8'));
  assert.ok(!line.text.includes(TOKEN), line.text);
  assert.ok(!line.text.includes(os.homedir()), line.text);
  assert.ok(!line.text.includes('alice'), line.text);
  assert.match(line.text, /~\/work\/notes\.txt/);
  assert.match(line.text, /\/Users\/<masked>/);
  // The pick line holds no state text, as before.
  assert.ok(!JSON.stringify(pick).includes('Choose a tier'));
  assert.equal(fs.statSync(path.join(f.dir, fs.readdirSync(f.dir)[0])).mode & 0o777, 0o600);

  const same = await client.ask({ questionSet: SAME_ISSUE_SET, kind: 'same-issue', staticAnswer: 'no', caller: 'review' });
  assert.equal(same.status, 'answered');
  assert.equal(f.picks().length, 2);
  assert.equal(f.lines().length, 1, 'a same-issue pick is not captured');
});

test('(b) the masked text is cut to 4,096 bytes at a code-point boundary, with cut true', async (t) => {
  const f = await fixture(t, { user: true });
  // 4,095 ASCII bytes, then a 3-byte character that crosses the limit, then more.
  const state = `${'a'.repeat(MAX_TEXT_BYTES - 1)}€${'b'.repeat(100)}`;
  assert.ok(captureState({ roots: f.roots, pickId: 'adv-0000000000001-abcdef', kind: 'tier', store: 'project-state', state }));
  const [line] = f.lines();
  assert.equal(line.cut, true);
  assert.equal(line.textBytes, MAX_TEXT_BYTES - 1);
  assert.equal(line.text, 'a'.repeat(MAX_TEXT_BYTES - 1));
  assert.ok(!line.text.includes('�'));
  // Four-byte characters: the cut keeps whole ones only.
  const emoji = cutToBytes('😀'.repeat(2000));
  assert.equal(emoji.bytes, 4096);
  assert.equal(emoji.text, '😀'.repeat(1024));
  const shifted = cutToBytes(`ab${'😀'.repeat(2000)}`);
  assert.equal(shifted.bytes, 4094);
  assert.equal(shifted.text, `ab${'😀'.repeat(1023)}`);
  assert.deepEqual(cutToBytes('short'), { text: 'short', bytes: 5, cut: false });
});

test('(c) narrow-only: true only in a project file captures nothing; a project file can turn the user setting off', async (t) => {
  const projectOnly = await fixture(t, { project: true });
  await projectOnly.client().ask({ questionSet: TIER_SET, kind: 'tier', staticAnswer: 'standard', caller: 'advise' });
  assert.equal(projectOnly.picks().length, 1);
  assert.deepEqual(projectOnly.lines(), []);
  const { spy, input } = spied(projectOnly.roots);
  assert.equal(captureState(input), null);
  assert.equal(spy.reads, 0);

  const projectOff = await fixture(t, { user: true, project: false });
  await projectOff.client().ask({ questionSet: TIER_SET, kind: 'tier', staticAnswer: 'standard', caller: 'advise' });
  assert.deepEqual(projectOff.lines(), []);

  const both = await fixture(t, { user: true, project: true });
  await both.client().ask({ questionSet: TIER_SET, kind: 'tier', staticAnswer: 'standard', caller: 'advise' });
  assert.equal(both.lines().length, 1);
});

test('(d) a capture failure leaves the pick and the answer unchanged', async (t) => {
  const strip = (result: any) => ({ ...result, durationMs: 0, answers: result.answers.map((a: any) => ({ ...a, pickId: a.pickId ? 'id' : null })) });
  const off = await fixture(t, { user: false });
  const expected = strip(await off.client().ask({ questionSet: TIER_SET, kind: 'tier', staticAnswer: 'standard', caller: 'advise' }));

  const on = await fixture(t, { user: true });
  // A file system on which every state-text write throws, and every other call is the real one.
  let thrown = 0;
  const failing = new Proxy(fs, {
    get(target: any, name: string) {
      const real = target[name];
      if (name !== 'appendFileSync' && name !== 'mkdirSync') return typeof real === 'function' ? real.bind(target) : real;
      return (file: string, ...rest: any[]) => {
        if (String(file).includes(path.join('advice', 'state-text'))) {
          thrown += 1;
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return real.call(target, file, ...rest);
      };
    },
  });
  const result = await on.client({ fsImpl: failing }).ask({ questionSet: TIER_SET, kind: 'tier', staticAnswer: 'standard', caller: 'advise' });
  assert.deepEqual(strip(result), { ...expected, endpoint: result.endpoint, decidedBy: result.decidedBy });
  assert.ok(thrown > 0, 'the capture was attempted and failed');
  assert.equal(on.picks().length, 1, 'the pick is recorded');
  assert.deepEqual(on.lines(), []);

  // A link in place of the store folder: nothing is written and nothing throws.
  const linked = await fixture(t, { user: true });
  const elsewhere = tempDir(t, 'doflow-state-text-elsewhere-');
  fs.mkdirSync(path.join(linked.roots['project-state'], 'advice'), { recursive: true });
  fs.symlinkSync(elsewhere, linked.dir);
  const viaLink = await linked.client().ask({ questionSet: TIER_SET, kind: 'tier', staticAnswer: 'standard', caller: 'advise' });
  assert.equal(viaLink.status, 'answered');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('the shadow dispatcher captures where its pick line is written, in the same store, and only for a routing kind', async (t) => {
  const f = await fixture(t, { user: true });
  const answer = { name: 'tier', type: 'choice', pick: 'standard', probabilities: { light: 0.1, standard: 0.8, frontier: 0.1 }, confidence: 0.7 };
  const asked = { status: 'answered', pick: 'standard', answer, answers: [answer], reason: null, provider: 'ollama', model: 'clef-flash', durationMs: 5 };
  const context = { kind: 'tier', caller: 'brief-tools', state: STATE, staticPick: 'standard', taskId: null, questionSet: TIER_SET, adviceRegistry: ADVICE };
  const [pickId] = recordCall(context, { roots: f.roots }, 'shadow', asked, 'adv-0000000000002-abcdef', false);
  const lines = f.lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].pickId, pickId);
  assert.equal(lines[0].stateDigest, f.picks()[0].stateDigest);
  assert.ok(!lines[0].text.includes(TOKEN));
  // A miss writes no pick, so nothing is captured.
  recordCall(context, { roots: f.roots }, 'shadow', { ...asked, status: 'miss', pick: null, answer: null, answers: [], reason: 'timeout' }, 'adv-0000000000003-abcdef', false);
  assert.equal(f.lines().length, 1);
});

/** Shipped files that could read or ship a store: code and data, never tests or prose. */
function shippedFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'test', 'docs', 'agent-docs', 'bench', 'specs', 'tmp']);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !/\.(md|png|svg|jpg|ico|woff2?)$/.test(entry.name)) out.push(path.relative(REPO_ROOT, full));
    }
  };
  for (const top of ['src', 'core', 'console', 'bin', 'scripts']) if (fs.existsSync(path.join(REPO_ROOT, top))) walk(path.join(REPO_ROOT, top));
  return out.sort();
}

// The store's path, not the module's file name (`advice/state-text.ts`, which a settings consumer list names).
const NAMES_STORE = /advice['"`]?\s*[,/\\]\s*['"`]?state-text(?!\.(?:ts|js)\b)/;
const STORE_NAMERS = ['core/registry/storage.json', 'src/runtime/advice/replay/sources/captured-state.ts', 'src/runtime/advice/state-text.ts'];
const REQUIRES_CAPTURE = /require\(\s*['"`][^'"`]*\/state-text(\.ts|\.js)?['"`]\s*\)/;

test('(g) only state-text.ts, captured-state.ts and storage.json name advice/state-text; only the two writers and the case source require it', () => {
  const files = shippedFiles();
  const texts = new Map(files.map((file) => [file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')]));
  const naming = files.filter((file) => NAMES_STORE.test(texts.get(file)!));
  assert.deepEqual(naming.filter((file) => !STORE_NAMERS.includes(file)), []);
  for (const file of ['core/registry/storage.json', 'src/runtime/advice/state-text.ts']) assert.ok(naming.includes(file), `${file} names the store`);
  const requiring = files.filter((file) => REQUIRES_CAPTURE.test(texts.get(file)!));
  assert.deepEqual(requiring, ['src/runtime/advice/client.ts', 'src/runtime/advice/replay/sources/captured-state.ts', 'src/runtime/advice/shadow-dispatcher.ts']);
});

test('(g) control: a planted reader in another file is found by both scans', () => {
  assert.match("const dir = path.join(root, 'advice', 'state-text');", NAMES_STORE);
  assert.match("fs.readdirSync(`${state}/advice/state-text`)", NAMES_STORE);
  assert.doesNotMatch("'advice.capture.state-text'", NAMES_STORE);
  assert.doesNotMatch('"consumers": ["src/runtime/advice/state-text.ts"]', NAMES_STORE);
  assert.match("const { readCaptured } = require('../advice/state-text.ts');", REQUIRES_CAPTURE);
});

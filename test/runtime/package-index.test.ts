'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { shPath } = require('../helper/tool-stub.ts');
const { tempDir } = require('../helper/tmp.ts');
const { readIndex, pickVersion } = require('../../src/runtime/packages/index-file.ts');
const { handlePackageCommand } = require('../../src/runtime/packages/command.ts');
const { readLock, lockPackages } = require('../../src/state/lockfile.ts');
const { parseArgs } = require('../../src/cli/index.ts');
const HOST = require('../../package.json').version;
const CORE = require('../../src/runtime/review/protocols.ts').loadProtocols().registry;
const SHA = '1111111111111111111111111111111111111111';
const URL_ = 'https://example.org/acme.git';
const PIN: any = { type: 'git', url: URL_, commit: SHA };

function entry(name: string, body: Buffer) {
  const header = Buffer.alloc(512);
  const put = (at: number, size: number, value: string) => header.write(value + '\0', at, size, 'utf8');
  const oct = (at: number, size: number, value: number) => header.write(value.toString(8).padStart(size - 1, '0') + '\0', at, size, 'ascii');
  put(0, 100, name); oct(100, 8, 0o644); oct(108, 8, 0); oct(116, 8, 0);
  oct(124, 12, body.length); oct(136, 12, 0); header.fill(32, 148, 156);
  header[156] = 48; put(257, 6, 'ustar'); put(263, 2, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  oct(148, 8, sum);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

function archive(files: Array<[string, Buffer]>, prefix = '') {
  return Buffer.concat([...files.map(([name, body]: [string, Buffer]) => entry(prefix + name, body)), Buffer.alloc(1024)]);
}

function world(t: any): any {
  const root = tempDir(t, 'doflow-pindex-');
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const tmpDir = path.join(root, 'tmp');
  const bin = path.join(root, 'bin');
  for (const dir of [homeDir, projectRoot, tmpDir, bin]) fs.mkdirSync(dir);
  const log = path.join(root, 'calls');
  const preset = JSON.parse(JSON.stringify(CORE.presets['review-deep']));
  delete preset.depth;
  const files: Array<[string, Buffer]> = [
    ['doflow-package.json', Buffer.from(JSON.stringify({
      manifest: 1, id: 'acme', version: '1.2.0', doflow: `=${HOST}`,
      contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
    }))],
    ['presets/strict.json', Buffer.from(JSON.stringify(preset))],
    ['README.md', Buffer.from('inert fixture\n')],
  ];
  const gitTar = path.join(root, 'git.tar');
  const npmTar = path.join(root, 'npm.tgz');
  fs.writeFileSync(gitTar, archive(files));
  const npmBytes = zlib.gzipSync(archive(files, 'package/'));
  fs.writeFileSync(npmTar, npmBytes);
  const integrity = `sha512-${crypto.createHash('sha512').update(npmBytes).digest('base64')}`;
  const viewFile = path.join(root, 'view.json');
  fs.writeFileSync(viewFile, JSON.stringify({ version: '1.2.0', 'dist.integrity': integrity }));
  const logger = `
first=1
for arg do
  if [ "$first" -eq 0 ]; then printf '\\t' >> "$FIXTURE_LOG"; fi
  printf '%s' "$arg" >> "$FIXTURE_LOG"
  first=0
done
printf '\\n' >> "$FIXTURE_LOG"
`;
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
${logger}
for i in 1 2; do [ "$1" = "-c" ] && { shift 2; }; done
cmd=$1
shift
case "$cmd" in
  ls-remote) printf '%s\\trefs/tags/v1.2.0\\n' "$FIXTURE_SHA" ;;
  archive) cat "$FIXTURE_GIT_TAR" ;;
esac
exit 0
`);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
${logger}
if [ "$1" = view ]; then
  cat "$FIXTURE_VIEW"
fi
if [ "$1" = pack ]; then
  destination=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --pack-destination ]; then shift; destination=$1; fi
    shift
  done
  cp "$FIXTURE_NPM_TAR" "$destination/acme.tgz"
  printf '[{"filename":"acme.tgz"}]\\n'
fi
exit 0
`);
  for (const name of ['git', 'npm']) fs.chmodSync(path.join(bin, name), 0o755);
  const env: any = {
    ...process.env, HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, '.config'), TMPDIR: tmpDir,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, DOFLOW_UPKEEP: 'off',
    FIXTURE_LOG: shPath(log), FIXTURE_SHA: SHA, FIXTURE_GIT_TAR: shPath(gitTar),
    FIXTURE_NPM_TAR: shPath(npmTar), FIXTURE_VIEW: shPath(viewFile),
  };
  return { root, homeDir, projectRoot, tmpDir, env, log, files, integrity };
}

function writeIndex(w: any, versions: any[] = [{ version: '1.2.0', doflow: `=${HOST}`, source: PIN }]) {
  const file = path.join(w.root, 'index.json');
  fs.writeFileSync(file, JSON.stringify({ format: 1, packages: [{ id: 'acme', versions }] }));
  return file;
}

function run(w: any, args: any, json: boolean = true): any {
  const lines: string[] = [];
  const saved = process.exitCode;
  try {
    const code = handlePackageCommand({
      homeDir: w.homeDir, env: w.env, projectRoot: w.projectRoot, tmpDir: w.tmpDir,
      json, out: (line: string) => lines.push(line), ...args,
    });
    const text = lines.join('\n');
    return { code, text, body: json ? JSON.parse(text) : null };
  } finally { process.exitCode = saved; }
}

function calls(w: any): string[][] {
  if (!fs.existsSync(w.log)) return [];
  const raw = fs.readFileSync(w.log, 'utf8').trim();
  return raw ? raw.split('\n').map((line: string) => line.split('\t')) : [];
}

function grant(w: any, line: string) {
  const file = path.join(w.env.XDG_CONFIG_HOME, 'doflow', 'packages', 'grants.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + '\n');
}

function planOf(w: any): any {
  const dir = path.join(w.homeDir, '.doflow', 'packages', 'plans');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

function rows(w: any): any[] {
  return lockPackages(readLock({ scope: 'global', homeDir: w.homeDir }));
}

test('one unpinned entry refuses the entire index with its JSON path before any tool call', (t: any) => {
  const w = world(t);
  const index = writeIndex(w, [
    { version: '1.2.0', doflow: `=${HOST}`, source: PIN },
    { version: '1.3.0', doflow: `=${HOST}`, source: { type: 'git', url: URL_ } },
  ]);
  const read = readIndex(index);
  assert.equal(read.ok, false);
  assert.ok(read.findings.some((f: any) => f.code === 'source-unpinned' && f.field === 'index.packages[0].versions[1].source.commit'));
  const result = run(w, { action: 'add', index, id: 'acme' });
  assert.equal(result.code, 1);
  assert.equal(result.body.error, 'source-unpinned');
  assert.deepEqual(calls(w), []);
  assert.equal(fs.existsSync(path.join(w.homeDir, '.doflow', 'packages')), false);
});

test('selection skips prereleases and incompatible hosts, and explicit missing versions name the choices', (t: any) => {
  const w = world(t);
  const index = readIndex(writeIndex(w, [
    { version: '1.2.0', doflow: `=${HOST}`, source: PIN },
    { version: '1.4.0', doflow: `=${HOST}`, source: PIN },
    { version: '2.0.0-beta.1', doflow: `=${HOST}`, source: PIN },
    { version: '9.0.0', doflow: '=99.0.0', source: PIN },
  ])).index;
  assert.equal(pickVersion(index, 'acme', { host: HOST }).entry.version, '1.4.0');
  assert.equal(pickVersion(index, 'acme', { host: HOST, version: '2.0.0-beta.1' }).entry.version, '2.0.0-beta.1');
  assert.equal(pickVersion(index, 'acme', { host: '88.0.0' }).findings[0].code, 'host-incompatible');
  const result = run(w, { action: 'add', index: path.join(w.root, 'index.json'), id: 'acme', packageVersion: '9.9.9' });
  assert.equal(result.code, 1);
  assert.equal(result.body.error, 'bad-id');
  assert.match(result.body.findings[0].message, /1\.2\.0.*1\.4\.0/);
  assert.deepEqual(calls(w), []);
});

test('index validation is closed and bounded at every level', (t: any) => {
  const w = world(t);
  const file = writeIndex(w);
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [mutate, field, code] of [
    [(x: any) => { x.extra = true; }, 'index.extra', 'unknown-key'],
    [(x: any) => { x.format = 2; }, 'index.format', 'bad-type'],
    [(x: any) => { x.packages[0].extra = true; }, 'index.packages[0].extra', 'unknown-key'],
    [(x: any) => { x.packages[0].id = 'Bad'; }, 'index.packages[0].id', 'bad-id'],
    [(x: any) => { x.packages[0].versions[0].extra = true; }, 'index.packages[0].versions[0].extra', 'unknown-key'],
    [(x: any) => { x.packages[0].versions[0].version = '^1'; }, 'index.packages[0].versions[0].version', 'bad-type'],
    [(x: any) => { x.packages[0].versions[0].doflow = '*'; }, 'index.packages[0].versions[0].doflow', 'bad-type'],
    [(x: any) => { x.packages[0].versions[0].source.url = 'http://example.org/a'; }, 'index.packages[0].versions[0].source.url', 'bad-type'],
    [(x: any) => { x.packages[0].versions[0].source.extra = true; }, 'index.packages[0].versions[0].source.extra', 'unknown-key'],
    [(x: any) => { x.packages[0].versions[0].source = { type: 'npm', name: 'acme', version: '^1', integrity: 'sha512-YQ==' }; }, 'index.packages[0].versions[0].source.version', 'source-unpinned'],
  ] as Array<[(x: any) => void, string, string]>) {
    const value = structuredClone(good);
    mutate(value);
    fs.writeFileSync(file, JSON.stringify(value));
    const read = readIndex(file);
    assert.equal(read.ok, false);
    assert.ok(read.findings.some((f: any) => f.field === field && f.code === code), JSON.stringify(read));
  }
  fs.writeFileSync(file, '{');
  assert.equal(readIndex(file).findings[0].code, 'bad-type');
  fs.writeFileSync(file, ' '.repeat(4 * 1024 * 1024 + 1));
  assert.equal(readIndex(file).findings[0].code, 'too-large');
  assert.deepEqual(calls(w), []);
});

for (const type of ['git', 'npm']) {
  test(`a ${type} index grants nothing; a pinned fetch grant plans, applies offline and records disabled`, (t: any) => {
    const w = world(t);
    const pinned: any = type === 'git' ? PIN : { type: 'npm', name: 'acme', version: '1.2.0', integrity: w.integrity };
    const index = writeIndex(w, [{ version: '1.2.0', doflow: `=${HOST}`, source: pinned }]);
    const missing = run(w, { action: 'add', index, id: 'acme' });
    assert.equal(missing.code, 1);
    assert.equal(missing.body.error, 'grant-missing');
    const line = JSON.parse(missing.body.grantLine);
    assert.deepEqual(line.source, type === 'git'
      ? { type: 'git', url: URL_, ref: SHA }
      : { type: 'npm', name: 'acme', version: '1.2.0' });
    assert.deepEqual(calls(w), []);
    const printed = run(w, { action: 'add', index, id: 'acme' }, false);
    assert.match(printed.text, /"grant":"fetch"/);
    grant(w, missing.body.grantLine);
    const planned = run(w, { action: 'add', index, id: 'acme' }, false);
    assert.equal(planned.code, 0, planned.text);
    assert.ok(planned.text.includes(type === 'git' ? `pinned ${URL_} ${SHA}` : 'pinned acme@1.2.0'));
    const plan = planOf(w);
    assert.deepEqual(plan.source, pinned);
    assert.equal(rows(w).length, 0);
    assert.equal(fs.existsSync(path.join(w.homeDir, '.doflow', 'packages', 'store')), false);
    const toolCalls = calls(w);
    assert.equal(toolCalls.some((args: string[]) => args.includes('ls-remote') || args[0] === 'view'), false);
    if (type === 'npm') assert.ok(toolCalls.some((args: string[]) => args[0] === 'pack' && args.includes('--ignore-scripts')));
    const fetched = path.join(w.homeDir, '.doflow', 'packages', 'fetched');
    assert.deepEqual(fs.readdirSync(fetched), [plan.planId]);
    const applied = run(w, { action: 'add', plan: plan.planId });
    assert.equal(applied.code, 0, applied.text);
    assert.deepEqual(rows(w)[0].source, pinned);
    assert.equal(rows(w)[0].enabled, false);
    const listed = run(w, { action: 'list', id: 'acme' });
    assert.equal(listed.code, 0, listed.text);
    assert.equal(listed.body.packages[0].state, 'disabled');
    assert.equal(listed.body.packages[0].tierMax, 'inert');
    assert.deepEqual(calls(w), toolCalls);
  });
}

test('a granted git ref goes through ls-remote, pin, plan and apply', (t: any) => {
  const w = world(t);
  const source = `git:${URL_}@v1.2.0`;
  const missing = run(w, { action: 'add', source });
  assert.equal(missing.body.error, 'grant-missing');
  assert.deepEqual(calls(w), []);
  grant(w, missing.body.grantLine);
  const planned = run(w, { action: 'add', source }, false);
  assert.equal(planned.code, 0, planned.text);
  assert.ok(planned.text.includes(`pinned ${URL_} ${SHA}`));
  assert.deepEqual(calls(w)[0], ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'ls-remote', URL_, 'v1.2.0']);
  const plan = planOf(w);
  const before = calls(w);
  assert.equal(run(w, { action: 'add', plan: plan.planId }).code, 0);
  assert.deepEqual(rows(w)[0].source, PIN);
  assert.deepEqual(calls(w), before);
});

for (const missing of [false, true]) {
  test(`a ${missing ? 'missing' : 'changed'} fetched snapshot refuses apply with digest-mismatch`, (t: any) => {
    const w = world(t);
    const index = writeIndex(w);
    grant(w, run(w, { action: 'add', index, id: 'acme' }).body.grantLine);
    assert.equal(run(w, { action: 'add', index, id: 'acme' }).code, 0);
    const plan = planOf(w);
    const tree = path.join(w.homeDir, '.doflow', 'packages', 'fetched', plan.planId);
    if (missing) fs.rmSync(tree, { recursive: true });
    else fs.appendFileSync(path.join(tree, 'README.md'), 'changed\n');
    const before = calls(w);
    const applied = run(w, { action: 'add', plan: plan.planId });
    assert.equal(applied.code, 1);
    assert.equal(applied.body.error, 'digest-mismatch');
    assert.equal(rows(w).length, 0);
    assert.equal(fs.existsSync(path.join(w.homeDir, '.doflow', 'packages', 'store')), false);
    assert.deepEqual(calls(w), before);
  });
}

test('package version selection preserves the standalone CLI version flag', () => {
  const selected = parseArgs(['package', '--action', 'add', '--index', 'index.json', '--id', 'acme', '--version', '9.9.9']);
  assert.equal(selected.index, 'index.json');
  assert.equal(selected.packageVersion, '9.9.9');
  assert.equal(selected.version, false);
  assert.equal(parseArgs(['package', '--version']).version, true);
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['package', '-v']).version, true);
});

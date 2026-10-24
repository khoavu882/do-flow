'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { tempDir } = require('../helper/tmp.ts');
const { pinNpm, fetchNpm, fetchGit } = require('../../src/runtime/packages/fetch.ts');
const { parseSource, pinSource, fetchSource } = require('../../src/runtime/packages/source.ts');
const limits = require('../../src/runtime/packages/points.ts').loadPoints().registry.limits;

function entry(name: string, body: Buffer = Buffer.from('x')): Buffer {
  const header = Buffer.alloc(512);
  const put = (at: number, size: number, value: string) => header.write(value + '\0', at, size, 'utf8');
  const oct = (at: number, size: number, value: number) => header.write(value.toString(8).padStart(size - 1, '0') + '\0', at, size, 'ascii');
  put(0, 100, name); oct(100, 8, 0o644); oct(108, 8, 0); oct(116, 8, 0);
  oct(124, 12, body.length); oct(136, 12, 0); header.fill(32, 148, 156);
  header[156] = '0'.charCodeAt(0); put(257, 6, 'ustar'); put(263, 2, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  oct(148, 8, sum);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

function archive(...items: Buffer[]): Buffer {
  return Buffer.concat([...items, Buffer.alloc(1024)]);
}

function fixtureArchive(): Buffer {
  return zlib.gzipSync(archive(entry('package/README.md', Buffer.from('hello\n'))));
}

function setup(t: any, bytes: Buffer, view: any): any {
  const dir = tempDir(t, 'doflow-npm-stub-');
  const log = path.join(dir, 'log');
  const tarball = path.join(dir, 'fixture.tgz');
  const viewFile = path.join(dir, 'view.json');
  const npm = path.join(dir, 'npm');
  fs.writeFileSync(tarball, bytes);
  fs.writeFileSync(viewFile, JSON.stringify(view));
  fs.writeFileSync(npm, `#!/bin/sh
log_args() {
  first=1
  for arg do
    if [ "$first" -eq 0 ]; then printf '\\t'; fi
    printf '%s' "$arg"
    first=0
  done
  printf '\\n'
}
log_args "$@" >> "$NPM_LOG"
if [ "$1" = "view" ]; then
  cat "$NPM_VIEW_JSON"
  exit 0
fi
if [ "$1" = "pack" ] && [ "$FAIL_PACK" = "1" ]; then
  echo 'npm pack fixture failed' >&2
  exit 1
fi
if [ "$1" = "pack" ]; then
  shift
  destination=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--pack-destination" ]; then
      shift
      destination=$1
    fi
    shift
  done
  cp "$NPM_FIXTURE_TGZ" "$destination/acme-pkg-1.3.0.tgz"
  printf '[{"filename":"acme-pkg-1.3.0.tgz"}]\\n'
  exit 0
fi
echo 'unexpected npm command' >&2
exit 1
`);
  fs.chmodSync(npm, 0o755);
  const git = path.join(dir, 'git');
  fs.writeFileSync(git, `#!/bin/sh
printf '%s\\n' "$@" >> "$GIT_LOG"
exit 0
`);
  fs.chmodSync(git, 0o755);
  const env: any = {
    ...process.env,
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    NPM_LOG: log,
    NPM_FIXTURE_TGZ: tarball,
    NPM_VIEW_JSON: viewFile,
  };
  return { dir, log, env, tarball, viewFile };
}

function stage(t: any): string {
  const dir = path.join(tempDir(t, 'doflow-npm-stage-'), 'stage');
  fs.mkdirSync(dir);
  return dir;
}

function loggedArgs(file: string): string[][] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? text.split('\n').map((line: any) => line.split('\t')) : [];
}

test('pins the highest matching npm version and fetches its integrity-checked package', (t: any) => {
  const bytes = fixtureArchive();
  const integrity = `sha512-${require('node:crypto').createHash('sha512').update(bytes).digest('base64')}`;
  const stub = setup(t, bytes, [
    { version: '1.2.0', 'dist.integrity': 'sha512-YQ==' },
    { version: '1.3.0', 'dist.integrity': integrity },
  ]);
  const source = parseSource('npm:acme-pkg@^1.2.0').source;
  const pin = pinSource(source, { env: stub.env });
  assert.deepEqual(pin, {
    ok: true,
    pinned: { type: 'npm', name: 'acme-pkg', version: '1.3.0', integrity },
  });
  const stageDir = stage(t);
  const fetched = fetchSource(pin.pinned, { stagingDir: stageDir, env: stub.env, limits });
  assert.equal(fetched.ok, true);
  assert.deepEqual(fetched.files.map((file: any) => file.path), ['README.md']);
  assert.equal(fetched.files[0].data.toString('utf8'), 'hello\n');
  assert.deepEqual(loggedArgs(stub.log), [
    ['view', 'acme-pkg@^1.2.0', 'version', 'dist.integrity', '--json'],
    ['pack', 'acme-pkg@1.3.0', '--ignore-scripts', '--json', '--pack-destination', stageDir],
  ]);
});

test('rejects a tarball changed after its integrity was pinned', (t: any) => {
  const bytes = fixtureArchive();
  const integrity = `sha512-${require('node:crypto').createHash('sha512').update(bytes).digest('base64')}`;
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 1;
  const stub = setup(t, tampered, {});
  const result = fetchNpm({
    type: 'npm', name: 'acme-pkg', version: '1.3.0', integrity,
  }, { stagingDir: stage(t), env: stub.env, limits });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].code, 'integrity-mismatch');
  assert.match(result.findings[0].message, new RegExp(integrity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.deepEqual(result.files, undefined);
});

test('reports npm pack stderr as a source-unpinned finding', (t: any) => {
  const bytes = fixtureArchive();
  const integrity = `sha512-${require('node:crypto').createHash('sha512').update(bytes).digest('base64')}`;
  const stub = setup(t, bytes, {});
  stub.env.FAIL_PACK = '1';
  const result = fetchNpm({
    type: 'npm', name: 'acme-pkg', version: '1.3.0', integrity,
  }, { stagingDir: stage(t), env: stub.env, limits });
  assert.equal(result.findings[0].code, 'source-unpinned');
  assert.match(result.findings[0].message, /npm pack fixture failed/u);
});

test('refuses npm view responses without valid integrity', (t: any) => {
  const stub = setup(t, fixtureArchive(), [
    { version: '1.3.0', 'dist.integrity': 'sha512-!' },
  ]);
  const result = pinNpm({ type: 'npm', name: 'acme-pkg', version: '^1.2.0' }, { env: stub.env });
  assert.equal(result.ok, false);
  assert.equal(result.finding.code, 'source-unpinned');
  assert.match(result.finding.message, /no valid version and integrity/u);
});

test('rejects invalid pinned git and npm records before spawning a tool', (t: any) => {
  const bytes = fixtureArchive();
  const integrity = `sha512-${require('node:crypto').createHash('sha512').update(bytes).digest('base64')}`;
  const stub = setup(t, bytes, {});
  stub.env.GIT_LOG = path.join(stub.dir, 'git.log');
  const stageDir = stage(t);
  assert.equal(fetchGit({
    type: 'git', url: 'https://example.org/a.git', commit: '-bad',
  }, { stagingDir: stageDir, env: stub.env, limits }).findings[0].code, 'bad-type');
  assert.equal(fetchNpm({
    type: 'npm', name: 'acme-pkg', version: '-1.3.0', integrity,
  }, { stagingDir: stageDir, env: stub.env, limits }).findings[0].code, 'bad-type');
  assert.equal(fetchNpm({
    type: 'npm', name: 'acme-pkg', version: '1.3.0', integrity: 'sha512-!',
  }, { stagingDir: stageDir, env: stub.env, limits }).findings[0].code, 'bad-type');
  assert.deepEqual(loggedArgs(stub.log), []);
  assert.equal(fs.existsSync(stub.env.GIT_LOG), false);
});

test('npm pinning reports a range with no semver versions', (t: any) => {
  const stub = setup(t, fixtureArchive(), [{ version: 'latest', 'dist.integrity': 'sha512-YQ==' }]);
  const result = pinNpm({ type: 'npm', name: 'acme-pkg', version: '^9.0.0' }, { env: stub.env });
  assert.equal(result.finding.code, 'source-unpinned');
  assert.match(result.finding.message, /no version of acme-pkg matches \^9\.0\.0/u);
});

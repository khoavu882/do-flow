'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shPath } = require('../helper/tool-stub.ts');
const { tempDir } = require('../helper/tmp.ts');
const { pinGit, fetchGit } = require('../../src/runtime/packages/fetch.ts');
const { parseSource } = require('../../src/runtime/packages/source.ts');
const { loadPoints } = require('../../src/runtime/packages/points.ts');
const { checkPackage } = require('../../src/runtime/packages/manifest.ts');
const { contentDigest } = require('../../src/runtime/packages/digest.ts');
const limits = loadPoints().registry.limits;
const HOST = require('../../package.json').version;
const sha1 = '1111111111111111111111111111111111111111';
const sha2 = '2222222222222222222222222222222222222222';

function entry(name: string, body: Buffer = Buffer.from('x'), type: string = '0') {
  const h = Buffer.alloc(512); const put = (a: number, n: number, v: string) => h.write(v + '\0', a, n, 'utf8');
  const oct = (a: number, n: number, v: number) => h.write(v.toString(8).padStart(n - 1, '0') + '\0', a, n);
  put(0, 100, name); oct(100, 8, 0o644); oct(108, 8, 0); oct(116, 8, 0); oct(124, 12, body.length); oct(136, 12, 0);
  h.fill(32, 148, 156); h[156] = type.charCodeAt(0); put(257, 6, 'ustar'); put(263, 2, '00');
  let sum = 0; for (const b of h) sum += b; oct(148, 8, sum);
  return Buffer.concat([h, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
function tar(...items: Buffer[]) { return Buffer.concat([...items, Buffer.alloc(1024)]); }
function fake(t: any, bytes: Buffer) {
  const dir = tempDir(t, 'doflow-git-stub-'); const log = path.join(dir, 'log'); const arc = path.join(dir, 'archive.tar');
  fs.writeFileSync(arc, bytes);
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh
printf '%s\\t' "$@" >> '${shPath(log)}'; printf '\\n' >> '${shPath(log)}'
printf '%s\\n' "$GIT_TERMINAL_PROMPT" > '${shPath(dir)}/prompt'
for i in 1 2; do [ "$1" = "-c" ] && { shift 2; }; done
cmd=$1; shift
case "$cmd" in
 ls-remote) printf '%s\\trefs/tags/v1.2.0\\n' "$GIT_FIXTURE_SHA" ;;
 fetch) if [ "$GIT_FAIL_FETCH" = 1 ]; then echo 'error: Server does not allow request for unadvertised object' >&2; exit 128; fi ;;
 archive) cat "$GIT_FIXTURE_ARCHIVE" ;;
esac
exit 0
`);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return { dir, log, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, GIT_FIXTURE_SHA: sha1, GIT_FIXTURE_ARCHIVE: shPath(arc) } as any };
}
function calls(stub: any): string[] {
  const text = fs.readFileSync(stub.log, 'utf8');
  return text.trim().split('\n');
}
function loggedArgs(line: string) { return line.replace(/\t$/u, '').split('\t'); }
function stage(t: any): string {
  const dir = path.join(tempDir(t, 'doflow-git-stage-'), 'stage');
  fs.mkdirSync(dir);
  return dir;
}
function packageFiles(): [string, Buffer][] {
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;
  const core = JSON.parse(fs.readFileSync(path.join(__dirname, '../../core/registry/protocols.json'), 'utf8'));
  const preset = JSON.parse(JSON.stringify(core.presets['review-deep']));
  delete preset.depth;
  return [
    ['doflow-package.json', Buffer.from(JSON.stringify({
      manifest: 1,
      id: 'acme',
      version,
      doflow: `=${version}`,
      contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
    }) + '\n')],
    ['presets/strict.json', Buffer.from(JSON.stringify(preset) + '\n')],
  ];
}
test('pins refs and fetches only the pinned commit with protected argv and matching package digest', (t: any) => {
  const files = packageFiles();
  const bytes = tar(...files.map(([name, body]) => entry(name, body)));
  const stub = fake(t, bytes);
  const source = parseSource('git:https://example.org/a.git@v1.2.0').source;
  const pin = pinGit(source, { env: stub.env }); assert.equal(pin.pinned.commit, sha1);
  stub.env.GIT_FIXTURE_SHA = sha2;
  const fetched = fetchGit(pin.pinned, { stagingDir: stage(t), env: stub.env, limits });
  assert.equal(fetched.ok, true);
  assert.deepEqual(calls(stub).map(loggedArgs), [
    ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'ls-remote', 'https://example.org/a.git', 'v1.2.0'],
    ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'init', '-q'],
    ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'remote', 'add', 'origin', 'https://example.org/a.git'],
    ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'fetch', '--depth', '1', '--no-tags', 'origin', sha1],
    ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'archive', '--format=tar', sha1],
  ]);
  assert.equal(fs.readFileSync(path.join(stub.dir, 'prompt'), 'utf8').trim(), '0');
  assert.doesNotMatch(calls(stub).join('\n'), /checkout|clone|submodule/);

  const originalDir = path.join(tempDir(t, 'doflow-git-original-'), 'pkg'); fs.mkdirSync(originalDir);
  for (const [name, body] of files) {
    const target = path.join(originalDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  const fetchedDir = path.join(tempDir(t, 'doflow-git-fetched-'), 'pkg'); fs.mkdirSync(fetchedDir);
  for (const file of fetched.files) {
    const target = path.join(fetchedDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
  }
  const checked = checkPackage(fetchedDir, { pointsRegistry: loadPoints().registry, hostVersion: HOST, bundled: [] });
  assert.deepEqual(checked.findings.filter((finding: any) => finding.severity === 'error'), []);
  assert.equal(contentDigest(fetchedDir, { limits }), contentDigest(originalDir, { limits }));
});
test('pins a full commit without a call and refuses unsafe or oversized archives', (t: any) => {
  const stub = fake(t, tar(entry('link', Buffer.alloc(0), '2')));
  const source = parseSource(`git:https://example.org/a.git@${sha1}`).source;
  assert.equal(pinGit(source, { env: stub.env }).pinned.commit, sha1); assert.equal(fs.existsSync(stub.log), false);
  assert.equal(fetchGit({ type: 'git', url: source.url, commit: sha1 }, { stagingDir: stage(t), env: stub.env, limits }).findings[0].code, 'symlink');
  fs.writeFileSync(path.join(stub.dir, 'archive.tar'), tar(entry('big', Buffer.alloc(5 * 1024 * 1024))));
  assert.equal(fetchGit({ type: 'git', url: source.url, commit: sha1 }, { stagingDir: stage(t), env: stub.env, limits }).findings[0].code, 'too-large');
  assert.equal(parseSource('git:https://example.org/a.git@-x').finding.code, 'bad-type');
});
test('strips the requested subdirectory prefix from archived paths', (t: any) => {
  const stub = fake(t, tar(entry('pkg/README.md', Buffer.from('inside\n'))));
  const source = parseSource('git:https://example.org/a.git#pkg@v1.2.0').source;
  const pinned = pinGit(source, { env: stub.env }).pinned;
  const fetched = fetchGit(pinned, { stagingDir: stage(t), env: stub.env, limits });
  assert.equal(fetched.ok, true);
  assert.deepEqual(fetched.files.map((file: any) => file.path), ['README.md']);
  assert.deepEqual(loggedArgs(calls(stub)[4]), [
    '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'archive', '--format=tar', sha1, 'pkg',
  ]);
});
test('reports git fetch failures with the first stderr reason', (t: any) => {
  const stub = fake(t, tar(entry('a'))); stub.env.GIT_FAIL_FETCH = '1';
  const result = fetchGit({ type: 'git', url: 'https://example.org/a.git', commit: sha1 }, { stagingDir: stage(t), env: stub.env, limits });
  assert.equal(result.findings[0].code, 'source-unpinned');
  assert.match(result.findings[0].message, /unadvertised object/);
});

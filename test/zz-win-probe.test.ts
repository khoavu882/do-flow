'use strict';
// TEMPORARY Windows diagnostic (fix/windows-ci); removed before the branch is finished.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { bashPath } = require('./helper/bash-locator.ts');
const { spawnBash } = require('./helper/home-less-bash.ts');
const { systemPath } = require('./helper/system-path.ts');

test('zz probe', { skip: process.platform !== 'win32' }, () => {
  const out: string[] = [];
  const script = [
    'echo "OSTYPE=$OSTYPE BASH=$BASH_VERSION"',
    'echo "XDG=[${XDG_CONFIG_HOME-unset}] HOME=[$HOME]"',
    'printf "%s" "${XDG_CONFIG_HOME-}" | od -c | head -3',
    'case "${XDG_CONFIG_HOME:-}" in /*) echo arm-slash;; [A-Za-z]:[\\\\/]*) echo arm-drive;; *) echo arm-none;; esac',
    'type -a bash git jq cat 2>&1 | head -12',
  ].join('\n');
  for (const env of [
    { PATH: process.env.PATH, XDG_CONFIG_HOME: 'C:\\Temp\\x\\xdg', HOME: 'C:\\Temp\\x\\home' },
    { PATH: systemPath(), XDG_CONFIG_HOME: 'C:\\Temp\\x\\xdg', HOME: 'C:\\Temp\\x\\home' },
    { PATH: process.env.PATH, XDG_CONFIG_HOME: 'C:/Temp/x/xdg', HOME: 'C:/Temp/x/home', SystemRoot: process.env.SystemRoot },
  ]) {
    const r = spawnBash(['-c', script], { env, encoding: 'utf8' });
    out.push(`--- env XDG=${env.XDG_CONFIG_HOME} PATH-first=${String(env.PATH).split(path.delimiter).slice(0, 3)}\nstatus=${r.status} err=${r.error}\n${r.stdout}\n${r.stderr}`);
  }
  const bare = spawnSync('bash', ['-c', 'echo bare:$BASH; type -a bash | head'], { encoding: 'utf8' });
  out.push(`--- bare bash status=${bare.status} err=${bare.error}\n${bare.stdout}${bare.stderr}`);
  const { createScratch } = require('./helper/scratch-env.ts');
  const scratch = createScratch('doflow-zz-');
  const env = scratch.env();
  delete env.HOME; delete env.USERPROFILE;
  const real = require('node:os').userInfo().homedir;
  const probeNode = spawnSync(process.execPath, ['-e', `
    const os=require('node:os'); const { maskBody } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src/runtime/mask.ts'))});
    const home=os.homedir();
    console.log(JSON.stringify({home, up: process.env.USERPROFILE, h: process.env.HOME, keys:Object.keys(process.env).filter(k=>/home|profile/i.test(k)),
      masked: maskBody('at '+${JSON.stringify(real)}+'/app/main.js:3', {home}).text}));`], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' });
  out.push(`--- R3 probe real=${real} status=${probeNode.status}\n${probeNode.stdout}${probeNode.stderr}`);
  {
    const fs = require('node:fs');
    const { suiteTempDir } = require('./helper/tmp.ts');
    const dir = suiteTempDir('doflow-zzr3-');
    spawnSync('git', ['init', '-q', '-b', 'main', dir], { env });
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'bin', 'doflow.js'), 'followup', '--action', 'report', '--statement', 'no HOME', '--text', `at ${real}/app/main.js:3`, '--json'], { cwd: dir, env, encoding: 'utf8' });
    let ev = '';
    try { const j = JSON.parse(cli.stdout); ev = fs.readFileSync(path.join(dir, j.events[0]), 'utf8'); } catch (e: any) { ev = `no event: ${e.message}`; }
    out.push(`--- R3 cli status=${cli.status}\n${String(cli.stdout).slice(0, 600)}\n${String(cli.stderr).slice(0, 600)}\nEVENT=${ev.slice(0, 900)}`);
    const homeProbe = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({HOME: process.env.HOME, UP: process.env.USERPROFILE}))'], { env, encoding: 'utf8' });
    out.push(`child env: ${homeProbe.stdout}`);
  }
  out.push(`PATHLEN=${String(process.env.PATH).length}`);
  assert.fail(`PROBE\n${out.join('\n')}`);
});

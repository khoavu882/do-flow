'use strict';

// The `doflow-ui` process (IC-002). Boot order: parse flags (unknown or bad: exit 2) -> core version
// handshake through the verb runner (outside `doflowCore`, or no version: exit 2 naming what was found
// and what is needed) -> bind 127.0.0.1 (listen error: exit 1) -> mint the launch code -> print the one
// stdout line. No browser is opened. SIGINT/SIGTERM stop the runner (its children are killed), close the
// server and exit 0, within 2 s. Nothing else is written to stdout, and the code goes nowhere else.

const fs = require('node:fs');
const path = require('node:path');
const { createVerbRunner } = require('./verb-runner.ts');
const { handshake } = require('./handshake.ts');
const { createServer, BIND_HOST } = require('./server.ts');
const { consoleRoutes } = require('./routes.ts');
const { processSessions } = require('./session.ts');
const { doflowCore } = require('../package.json');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const SHUTDOWN_MS = 2_000;
const USAGE = 'usage: doflow-ui --core <absolute path to bin/doflow.js> [--project <absolute dir>] [--port <0..65535>]';

type Flags = { core: string, project: string, port: number };
type Io = {
  env: Record<string, string | undefined>,
  cwd: string,
  stdout: { write(text: string): unknown },
  stderr: { write(text: string): unknown },
  signals: { once(signal: string, fn: () => void): unknown },
};

/** The flags, or the reason they are refused. Each flag takes the next argument as its value, once. */
function parseFlags(argv: readonly string[], cwd: string): Flags | { error: string } {
  const given: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!['--core', '--project', '--port'].includes(name)) return { error: `unknown argument ${JSON.stringify(name)}` };
    if (Object.hasOwn(given, name)) return { error: `${name} given twice` };
    if (index + 1 >= argv.length) return { error: `${name} needs a value` };
    given[name] = argv[index + 1];
  }
  const core = given['--core'];
  if (core === undefined) return { error: '--core is required' };
  if (!path.isAbsolute(core)) return { error: '--core must be an absolute path' };
  const project = given['--project'] ?? cwd;
  if (!path.isAbsolute(project)) return { error: '--project must be an absolute path' };
  try {
    if (!fs.statSync(project).isDirectory()) return { error: '--project is not a directory' };
  } catch {
    return { error: '--project does not exist' };
  }
  const portText = given['--port'] ?? '0';
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 0 && port <= 65535)) return { error: '--port must be an integer 0..65535' };
  return { core, project, port };
}

/** Runs the Console; resolves with the exit code (on a boot failure, or once a signal has shut it down). */
async function main(argv: readonly string[], io: Io = { env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, signals: process }): Promise<number> {
  const flags = parseFlags(argv, io.cwd);
  if ('error' in flags) {
    io.stderr.write(`doflow ui: ${flags.error}\n${USAGE}\n`);
    return 2;
  }
  const runner = createVerbRunner({ corePath: flags.core, projectRoot: flags.project, env: io.env });
  const checked = await handshake(runner);
  if (!checked.ok || !checked.inRange) {
    runner.stop();
    const found = checked.ok ? checked.version : `no version (${checked.code})`;
    io.stderr.write(`doflow ui: core version out of range: found ${found} at ${flags.core}, needed ${doflowCore}\n`);
    return 2;
  }

  let app: any;
  try {
    app = await createServer({ webRoot: WEB_ROOT, port: flags.port, routes: consoleRoutes(runner, processSessions) });
  } catch (error: any) {
    runner.stop();
    io.stderr.write(`doflow ui: cannot listen on ${BIND_HOST}:${flags.port} (${error && error.code ? error.code : 'error'})\n`);
    return 1;
  }
  io.stdout.write(`doflow ui: http://${BIND_HOST}:${app.port}/#c=${processSessions.mintLaunchCode()}\n`);

  return new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      runner.stop();
      let timer: any;
      const deadline = new Promise<void>((done) => { timer = setTimeout(done, SHUTDOWN_MS - 250); });
      Promise.race([app.close(), deadline]).then(() => {
        clearTimeout(timer);
        resolve(0);
      });
    };
    io.signals.once('SIGINT', shutdown);
    io.signals.once('SIGTERM', shutdown);
  });
}

module.exports = { main, parseFlags, USAGE };

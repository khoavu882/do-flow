'use strict';

// A Linux run of the worker and process-table tests, for a machine that is not Linux: `npm run test:linux`.
// The process-table code (`ps`, process groups, kill escalation) behaves differently per OS and CI is the
// only Linux run a change otherwise gets. This copies the checkout (no node_modules, no .git) into a
// `node:<release Node>` container, installs there and runs the worker test folder, the folder that holds
// process-tree.test.ts. It needs only the docker CLI and an image pull (the container adds jq with apt);
// `npm run gate` runs it too and states it as skipped when docker is not there.
// Exit 0 passed, 1 failed or docker unavailable, 2 usage.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { workflowNodePins } = require('../src/release/release-workflow.ts');

const USAGE = 'usage: node scripts/linux-run.ts';
// The folder under test, relative to the checkout; a glob the container's shell does not expand.
const TEST_GLOB = 'test/runtime/worker/*.test.ts';

/** True when a docker daemon answers. */
function dockerReady(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

/** The `docker run` arguments that test the checkout at `src` in a Linux container of Node `pin`. */
function dockerArgs(src: string, pin: string): string[] {
  // CI's runner is a non-root user with jq installed; the image is root with no jq, so the script adds jq (the
  // hooks need it) and runs the tests as the image's `node` user (root skips permission checks, so a test that
  // expects EACCES cannot pass there).
  const script = [
    'set -e',
    'apt-get update -qq >/dev/null && apt-get install -y -qq jq >/dev/null',
    'mkdir /work',
    'cd /src',
    'tar cf - --exclude=./node_modules --exclude=./.git . | tar xf - -C /work',
    'chown -R node:node /work',
    'cd /work',
    `su node -c 'git init -q && npm install --no-audit --no-fund && node --test "${TEST_GLOB}"'`,
  ].join('\n');
  return ['run', '--rm', '-v', `${src}:/src:ro`, `node:${pin}`, 'sh', '-c', script];
}

/** Runs the Linux test run on the checkout at `src`: 'ok', 'failed' or 'skipped' (no docker daemon). */
function linuxRun(src: string, pin: string): 'ok' | 'failed' | 'skipped' {
  if (!dockerReady()) return 'skipped';
  return spawnSync('docker', dockerArgs(src, pin), { stdio: 'inherit' }).status === 0 ? 'ok' : 'failed';
}

function main(argv: string[]): number {
  if (argv.length) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const root = path.resolve(__dirname, '..');
  const pin = workflowNodePins(fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8'))[0]?.value;
  if (!pin) {
    process.stdout.write('linux-run: no Node pin found in .github/workflows/release.yml\n');
    return 1;
  }
  const result = linuxRun(root, pin);
  process.stdout.write(`linux-run: ${result === 'skipped' ? 'nothing ran, no docker daemon answered' : result}\n`);
  return result === 'ok' ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { TEST_GLOB, dockerArgs, linuxRun };

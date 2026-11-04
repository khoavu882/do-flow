#!/usr/bin/env node
'use strict';

const { UsageError } = require('../lib/errors');

const commands = {
  add: require('../lib/commands/add'),
  list: require('../lib/commands/list'),
  export: require('../lib/commands/export'),
};

function main(argv, io) {
  const [name, ...rest] = argv;
  const command = commands[name];
  if (!command) {
    throw new UsageError(name ? `unknown command: ${name}` : 'missing command (add, list or export)');
  }
  command.run(rest, io);
}

try {
  main(process.argv.slice(2), { stdout: process.stdout, cwd: process.cwd() });
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}

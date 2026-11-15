'use strict';

// A child process for lan-store.test.ts: opens the store under argv[2] and, once the file argv[3] exists,
// runs one operation (argv[4]: `consume <code> <name>` or `mint <scope>`) and prints its result as one
// JSON line. It prints `ready` first, so the test can release every child at the same moment.

const fs = require('node:fs');
const { createLanStore } = require('../../src/lan-store.ts');

const [dir, go, op, ...rest] = process.argv.slice(2);
const store = createLanStore({ dir });
process.stdout.write('ready\n');
const wait = () => new Promise<void>((resolve) => {
  const poll = () => (fs.existsSync(go) ? resolve() : setTimeout(poll, 2));
  poll();
});

wait().then(async () => {
  try {
    const result = op === 'consume'
      ? await store.consumeCode(rest[0], { name: rest[1], via: 'browser', address: '127.0.0.1' })
      : await store.mintCode(rest[0] as 'view' | 'control');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error: any) {
    process.stdout.write(`${JSON.stringify({ threw: error.code ?? error.message })}\n`);
  }
});

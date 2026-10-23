'use strict';

// One real process taking the slot lock, for test/runtime/slot-lock.test.js.
// usage: node slot-lock-actor.js <json config>
//   runtime   'new' (SLOTS_MODULE's acquireSlotLock) or 'old' (LEGACY_SLOT_LOCK_MODULE's, default the
//             frozen 115 lock in legacy-slot-lock.js)
//   mode      'hold': take the lock, append `<label>-enter`, wait for `goFile` (when given), append
//             `<label>-exit`, release
//             'write': one updateTaskState on `file` appending `label` to `writes`; with `pauseMs`
//             it prints `R` and pauses inside its critical section first
//   pauseAtAct  print `R` and wait 500 ms (the caller SIGSTOPs it then) at the first step that acts
//             on a lock it judged: the mkdir of its entry (new) or the rename aside (old)

const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(process.argv[2]);
const repo = path.join(__dirname, '..', '..');
const { procStart, alive } = require(path.join(repo, 'src', 'runtime', 'worker', 'process-tree.ts'));
const { updateTaskState } = require(path.join(repo, 'src', 'runtime', 'task-state.ts'));
const newModule = process.env.SLOTS_MODULE || path.join(repo, 'src', 'runtime', 'slots.ts');
const oldModule = process.env.LEGACY_SLOT_LOCK_MODULE || path.join(__dirname, 'legacy-slot-lock.js');
const { acquireSlotLock } = require(config.runtime === 'old' ? oldModule : newModule);

const lockDir = `${config.file}.lock`;
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const event = (name) => fs.appendFileSync(config.eventsFile, `${config.label}-${name}\n`);

let fired = false;
const pause = () => { fired = true; process.stdout.write('R\n'); wait(500); };
const fsImpl = !config.pauseAtAct ? fs : {
  ...fs,
  mkdirSync: (target, ...rest) => {
    if (!fired && typeof target === 'string' && target.startsWith(lockDir + path.sep)) pause();
    return fs.mkdirSync(target, ...rest);
  },
  renameSync: (from, to) => {
    if (!fired && from === lockDir) pause();
    return fs.renameSync(from, to);
  },
};
const deps = { pid: process.pid, procStart: (pid) => procStart(pid), alive: (proc) => alive(proc), fsImpl };

let out;
try {
  if (config.mode === 'hold') {
    const release = acquireSlotLock(fsImpl, config.file, deps);
    event('enter');
    if (config.goFile) {
      const deadline = Date.now() + 20_000;
      while (!fs.existsSync(config.goFile) && Date.now() < deadline) wait(20);
    }
    event('exit');
    release();
    out = { kind: 'DONE' };
  } else {
    updateTaskState({
      fsImpl,
      file: config.file,
      acquire: (lockFs, target) => acquireSlotLock(lockFs, target, deps),
      build: (disk) => {
        if (config.pauseMs) { process.stdout.write('R\n'); wait(config.pauseMs); }
        return { writes: [...(disk?.writes || []), config.label] };
      },
    });
    out = { kind: 'DONE' };
  }
} catch (error) {
  out = { kind: 'THREW', code: error.code ?? null, message: String(error.message) };
}
process.stdout.write(`OUT ${JSON.stringify(out)}\n`);

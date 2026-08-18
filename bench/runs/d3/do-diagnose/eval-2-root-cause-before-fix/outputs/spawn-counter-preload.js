const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.SPAWN_LOG;
let n = 0, ms = 0;
const orig = cp.spawnSync;
cp.spawnSync = function (...args) {
  const t = Date.now();
  const r = orig.apply(this, args);
  n++; ms += Date.now() - t;
  return r;
};
process.on('exit', () => {
  if (!OUT || !n) return;
  try { fs.appendFileSync(OUT, `${n} ${ms} ${process.argv[1] || 'main'}\n`); } catch {}
});

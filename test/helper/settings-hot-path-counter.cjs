'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const counts = { resolverModuleLoads: 0, resolverImporters: [], settingsSupportModules: [], loadSettingsCalls: 0, fsStatCalls: 0 };
const resolverPath = process.env.DOFLOW_SETTINGS_RESOLVER
  ? path.resolve(process.env.DOFLOW_SETTINGS_RESOLVER)
  : null;
const settingsRoot = resolverPath ? path.dirname(resolverPath) : null;
const wrappedExports = new WeakSet();
const seenSupportPaths = new Set();

function wrapFs(object, name) {
  const original = object?.[name];
  if (typeof original !== 'function') return;
  try {
    object[name] = function (...args) {
      counts.fsStatCalls += 1;
      return original.apply(this, args);
    };
  } catch { /* a read-only fs method is outside the counter surface */ }
}

for (const name of ['statSync', 'lstatSync', 'accessSync', 'stat', 'lstat', 'access']) wrapFs(fs, name);
for (const name of ['stat', 'lstat', 'access']) wrapFs(fs.promises, name);

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* use Node's error */ }
  const loaded = originalLoad.apply(this, arguments);
  if (settingsRoot && resolved && resolved !== resolverPath
      && resolved.startsWith(`${settingsRoot}${path.sep}`) && !seenSupportPaths.has(resolved)) {
    seenSupportPaths.add(resolved);
    counts.settingsSupportModules.push(resolved);
  }
  if (resolverPath && resolved === resolverPath && loaded && !wrappedExports.has(loaded)) {
    counts.resolverModuleLoads += 1;
    counts.resolverImporters.push(parent?.filename || null);
    wrappedExports.add(loaded);
    const loadSettings = loaded.loadSettings;
    if (typeof loadSettings === 'function') {
      loaded.loadSettings = function (...args) {
        counts.loadSettingsCalls += 1;
        return loadSettings.apply(this, args);
      };
    }
  }
  return loaded;
};

process.on('exit', () => {
  const output = process.env.DOFLOW_COUNTER_OUT;
  if (!output) return;
  try { fs.appendFileSync(output, `${JSON.stringify(counts)}\n`); } catch { /* test reads a missing file as a failure */ }
});

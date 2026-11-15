'use strict';

// The dedicated writer of the user-layer `workers.models` setting (`doflow models --action bind|unbind`).
// `config set` refuses this key because it is security-relevant; like `advise --action configure` this
// verb is a person's command that writes one named key through the settings writer, which holds the
// layer's lock and keeps the replaced bytes in `<file>.config.bak`. It writes the user layer only: the key
// is global-only.

const path = require('node:path');
const nodeFs = require('node:fs');
const { configHome } = require('../config-home.ts');
const { readLayerFile } = require('../settings/files.ts');
const { writeLayer } = require('../settings/write.ts');
const { loadSettingsRegistry } = require('../settings/registry.ts');
const { clearSettingsCache } = require('../settings/resolve.ts');

const KEY = 'workers.models';
const WRITE_ATTEMPTS = 3;
const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Levenshtein distance, case-insensitive. */
function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= y.length; j += 1) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return row[y.length];
}

/** The `count` ids of `ids` nearest to `model`. */
function closestIds(model: string, ids: string[], count = 3): string[] {
  return [...ids].sort((a, b) => distance(model, a) - distance(model, b)).slice(0, count);
}

/** Sets (`model` a string) or removes (`model` null) `workers.models.<harness>.<slot>` in the user settings file.
 * Returns `{ ok: true, file, map, changed }` or `{ ok: false, detail }`; nothing is written on a refusal. */
function changeBinding({ harness, slot, model, env = process.env, fsImpl = nodeFs }: any): any {
  const home = configHome(env);
  if (!home.dir) return { ok: false, detail: 'no config home resolves; set an absolute HOME or XDG_CONFIG_HOME' };
  const file = path.join(home.dir, 'settings.json');
  const loaded = loadSettingsRegistry({ fsImpl });
  if (!loaded.ok) return { ok: false, detail: `settings registry is invalid: ${loaded.detail}` };
  const { registry } = loaded;

  for (let attempt = 1; ; attempt += 1) {
    const read = readLayerFile(file, { registry, fsImpl, includeDocument: true });
    if (read.status === 'invalid') return { ok: false, detail: `${file} ${read.reason}; fix or remove it first` };
    const document = read.status === 'ok' && isObject(read.document) ? read.document : {};
    const map: Record<string, Record<string, string>> = isObject(document[KEY]) ? structuredClone(document[KEY]) : {};
    const before = JSON.stringify(map);
    if (model === null) {
      if (map[harness]) delete map[harness][slot];
      if (map[harness] && Object.keys(map[harness]).length === 0) delete map[harness];
    } else {
      map[harness] = { ...(map[harness] || {}), [slot]: model };
    }
    if (JSON.stringify(map) === before) return { ok: true, file, map, changed: false };

    const expect = read.status === 'ok' ? read.document : null;
    const written = Object.keys(map).length === 0
      ? writeLayer({ file, unset: [KEY], expect, backup: true, fsImpl })
      : writeLayer({ file, set: { [KEY]: map }, expect, backup: true, fsImpl });
    if (!written.ok && written.code === 'changed' && attempt < WRITE_ATTEMPTS) continue;
    if (!written.ok) return { ok: false, detail: written.detail || String(written.reason || 'write failed') };
    clearSettingsCache();
    return { ok: true, file, map, changed: true };
  }
}

module.exports = { KEY, closestIds, changeBinding };

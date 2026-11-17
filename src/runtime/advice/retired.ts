'use strict';

const fs = require('node:fs');
const path = require('node:path');

// What row 174 retired. An outcome whose `source` is listed here was recorded by a code path that no longer exists, and it
// is not an observation of the pick it names: doctor, the report and `advice-picks` count it in no figure. The records stay
// in the store until the retention window drops them.
const RETIRED_OUTCOME_SOURCES: readonly string[] = Object.freeze(['classify-verdict']);

function isRetiredOutcome(record: any): boolean {
  return RETIRED_OUTCOME_SOURCES.includes(record?.source);
}

/**
 * One diagnostic per removed setting key (`removedSettings` in core/registry/advice.json: the keys row 174 removed, which 2.5.0
 * was the last version to read) held by the user `settings.json` or the project `settings.json` / `settings.local.json`. The
 * settings validator already ignores an unregistered key; this says so, so an old key does not look like a live one.
 * `roots` is the resolved storage roots (`config-home`, `project-doflow`); a file that is absent or unreadable gives none (the
 * settings resolver already reports an unreadable file).
 */
function removedKeyDiagnostics(roots: any, adviceRegistry: any, fsImpl: any = fs): string[] {
  const keys: string[] = Array.isArray(adviceRegistry?.removedSettings) ? adviceRegistry.removedSettings : [];
  const files = [
    roots?.['config-home'] && path.join(roots['config-home'], 'settings.json'),
    roots?.['project-doflow'] && path.join(roots['project-doflow'], 'settings.json'),
    roots?.['project-doflow'] && path.join(roots['project-doflow'], 'settings.local.json'),
  ].filter(Boolean);
  const out: string[] = [];
  for (const file of files) {
    let document: any;
    try { document = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { continue; }
    if (!document || typeof document !== 'object' || Array.isArray(document)) continue;
    for (const key of keys) {
      if (Object.hasOwn(document, key)) out.push(`${file} holds ${key}, a removed setting; it is ignored since the version after 2.5.0. Delete the key.`);
    }
  }
  return out;
}

module.exports = { RETIRED_OUTCOME_SOURCES, isRetiredOutcome, removedKeyDiagnostics };

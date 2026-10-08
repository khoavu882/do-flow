'use strict';

// Backups in the layout DoFlow 1.19 wrote, for tests of the code that still reads them. The 1.19
// writers are gone from src/, so tests plant these directly: a full backup is one
// `<tool>.tar.gz` made with `tar -czf <archive> -C <srcDir> .`, a partial backup is a plain copy
// tree `<tool>/<rel>`, and each carries a `.manifest.json` with the seven 1.19 keys.
// Pass `manifest: null` to leave the manifest out, or an object to override its keys.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function writeV1Manifest(bkDir, id, tool, type, manifest) {
  if (manifest === null) return;
  const content = {
    id,
    operation: id.split('_')[0],
    timestamp: '2026-01-01T00:00:00.000Z',
    source_path: '/doflow',
    source_commit: 'unknown',
    type,
    tools_affected: [tool],
    ...manifest,
  };
  fs.writeFileSync(path.join(bkDir, '.manifest.json'), `${JSON.stringify(content, null, 2)}\n`);
}

/** `<root>/<id>/<tool>.tar.gz` of everything under `srcDir`, plus its manifest. Returns the backup directory. */
function plantFullBackup(root, id, { tool, srcDir, manifest = {} }) {
  const bkDir = path.join(root, id);
  fs.mkdirSync(bkDir, { recursive: true });
  execFileSync('tar', ['-czf', path.join(bkDir, `${tool}.tar.gz`), '-C', srcDir, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
  writeV1Manifest(bkDir, id, tool, 'full', manifest);
  return bkDir;
}

/** `<root>/<id>/<tool>/<rel>` for each `files` entry (`{ [rel]: content }`), plus its manifest. Returns the backup directory. */
function plantPartialBackup(root, id, { tool, files, manifest = {} }) {
  const bkDir = path.join(root, id);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(bkDir, tool, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.mkdirSync(bkDir, { recursive: true });
  writeV1Manifest(bkDir, id, tool, 'partial', manifest);
  return bkDir;
}

module.exports = { plantFullBackup, plantPartialBackup };

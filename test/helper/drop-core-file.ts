'use strict';

// Dropping a core guidance file from a package copy, the way a real source change does it: the
// file goes and so does every `@import` line that names it. The guidance-manifest selector refuses
// a core set whose entry file still imports a missing file (107-B review C-4), so a test that only
// deleted the file would be testing that refusal, not the update path it is about.
const fs = require('node:fs');
const path = require('node:path');

/** Remove `droppedAbs` and every `@import` line naming it from the markdown under `guidanceDir`.
 * Returns the `{ file, text }` originals of every file edited, for `restoreDropped`. */
function dropCoreFile(guidanceDir: any, droppedAbs: any) {
  const edited: any = [];
  const walk = (dir: any) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md') || full === droppedAbs) continue;
      const text = fs.readFileSync(full, 'utf8');
      const kept = text.split('\n').filter((line: any) => {
        const match = /^@(\S+)$/.exec(line);
        return !(match && path.resolve(path.dirname(full), match[1]) === droppedAbs);
      }).join('\n');
      if (kept !== text) { edited.push({ file: full, text }); fs.writeFileSync(full, kept); }
    }
  };
  if (fs.existsSync(guidanceDir)) walk(guidanceDir);
  fs.rmSync(droppedAbs, { force: true });
  return edited;
}

/** Put back what `dropCoreFile` edited. The dropped file itself is restored by the caller. */
function restoreEdited(edited: any) {
  for (const { file, text } of edited) fs.writeFileSync(file, text);
}

module.exports = { dropCoreFile, restoreEdited };

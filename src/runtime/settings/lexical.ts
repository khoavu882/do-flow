'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The lexical `failure.capture` rule v1 (086 IC-004, DD-3, OI-1): the one line rule over the raw text
 * of `settings.json` that the bash dispatcher, the bash policy, the JS hook runner and Node all apply,
 * so a failing hook never needs `jq`, `node` or a JSON parser to know whether capture is off. The
 * text is the file's bytes up to the first NUL. Every match of `"failure.capture"` + `:` + a value
 * must capture exactly `"on"`; any other capture is `off`; no match is "no setting" (null). JSON
 * validity is irrelevant and nothing here reports file text.
 *
 * The bare alternative excludes `"` (OI-1) so `{"failure.capture":"on"abc,}` reads the same in
 * bash (leftmost-longest) and JS (leftmost-first). The whitespace class is the C-locale
 * `[[:space:]]`, spelled out: JS `\s` would add Unicode spaces (U+00A0) that bash does not match.
 * The file is read as `latin1`, one character per byte, as bash does under `LC_ALL=C`.
 */

const nodeFs = require('node:fs');

type Capture = 'on' | 'off' | null;

const WS = '[ \\t\\n\\v\\f\\r]';
const CAPTURE_RE = new RegExp(`"failure\\.capture"${WS}*:${WS}*("[^"]*"|[^,}" \\t\\n\\v\\f\\r]*)`, 'g');

/** @param text the file's bytes as a latin1 string */
function lexicalCapture(text: string): Capture {
  let out: Capture = null;
  for (const m of text.split('\0', 1)[0].matchAll(CAPTURE_RE)) out = m[1] === '"on"' ? (out ?? 'on') : 'off';
  return out;
}

/**
 * A missing file is no setting; a path that is not a regular file, or cannot be read, is `off`.
 * Never throws, never returns file text.
 */
function readLexicalCapture(file: string, fsImpl: any = nodeFs): Capture {
  try {
    if (!fsImpl.statSync(file).isFile()) return 'off';
  } catch (error: any) {
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') return null;
    if (code === 'EACCES') {
      try {
        const parent = require('node:path').dirname(file);
        if (!fsImpl.statSync(parent).isDirectory()) return null;
        try { fsImpl.accessSync(parent, fsImpl.constants?.X_OK ?? nodeFs.constants.X_OK); return null; }
        catch (accessError: any) { return accessError?.code === 'EACCES' ? 'off' : null; }
      } catch { return null; }
    }
    return 'off';
  }
  try { return lexicalCapture(fsImpl.readFileSync(file, 'latin1')); } catch { return 'off'; }
}

module.exports = { lexicalCapture, readLexicalCapture };

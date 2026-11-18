'use strict';

// Row 165 (FR-005, FR-006; design IC-005, D4, D5): the first prompt of a session started from the
// Console. `preparePrompt` is pure: it normalizes the person's text, caps it, composes what is sent
// (row 173 §6.6: entry `do` puts the text in a prompt frame) and refuses text a harness CLI would misread. `writePrompt` and `readPrompt` keep what is sent in
// the declared store `session-prompts` (`.doflow/state/session-prompts/<runId>.prompt.txt`, mode
// 0600), so the run record carries a pointer and a hash, never the text.
//
// Leading whitespace is not trimmed: the dash and at-sign checks look at the first character after
// normalizing, so " -x" passes (a space is not an option) and a stripped control character hides
// nothing. The text is kept as the person wrote it apart from the stripped characters.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RUN_ID } = require('./run-store.ts');
const { composeFrame } = require('../prompt/frame.ts');

/** The outcome of the frame entry `do` sends; `start-options` shows it as `entryLine`. */
const ENTRY_LINE = 'Use the DoFlow do skill for the request in input.';
const ENTRY_STOP = 'Stop when the do skill\'s workflow ends or asks the person a question.';
const ENTRY_READER = 'The person who started this session';
// 8000 code points is at most 32000 UTF-8 bytes, so the byte cap is a backstop that cannot bind first.
const PROMPT_MAX = Object.freeze({ codePoints: 8000, bytes: 32768 });
const STORE = 'session-prompts';
const KEEP_NEWEST = 200;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PROMPT_FILE = /^(w-[0-9a-f]{12})\.prompt\.txt$/;

// C0 except \t and \n, DEL and C1, and the bidi controls.
const STRIPPED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

type Prepared = { ok: true; text: string; sent: string; sha256: string; bytes: number } | { ok: false; code: string };

/**
 * @param raw the person's text
 * @param opts `entry` `do` (a prompt frame: the text as the `request` document of `input`, `ENTRY_LINE` as the
 *   outcome, a stop rule, the person as the reader) or `none` (the text alone);
 *   `promptVia` `stdin` or `argv` (how the harness takes it).
 * @returns `{ ok: true, text, sent, sha256, bytes }`, `sha256` (hex) and `bytes` being of `sent` in UTF-8, or
 *   `{ ok: false, code }` with `prompt-nul`, `prompt-empty`, `prompt-too-long`, `prompt-leading-dash` or `prompt-leading-at`.
 *   The caps and the dash and at-sign checks are of the person's text, not of the frame. For entry `do`, a text the
 *   frame reads as empty (a placeholder such as `none` or `TBD`, which it would leave out) is `prompt-empty`.
 */
function preparePrompt(raw: any, opts: { entry: string; promptVia: string }): Prepared {
  const { entry, promptVia } = opts || ({} as any);
  if (entry !== 'do' && entry !== 'none') throw new TypeError(`entry must be 'do' or 'none': ${entry}`);
  if (promptVia !== 'stdin' && promptVia !== 'argv') throw new TypeError(`promptVia must be 'stdin' or 'argv': ${promptVia}`);
  if (typeof raw !== 'string') return { ok: false, code: 'prompt-empty' };
  if (raw.includes('\u0000')) return { ok: false, code: 'prompt-nul' };
  const text = raw.replace(/\r\n?/g, '\n').replace(STRIPPED, '');
  if (text.trim() === '') return { ok: false, code: 'prompt-empty' };
  if ([...text].length > PROMPT_MAX.codePoints || Buffer.byteLength(text, 'utf8') > PROMPT_MAX.bytes) return { ok: false, code: 'prompt-too-long' };
  if (text.startsWith('-') && (entry === 'none' || promptVia === 'argv')) return { ok: false, code: 'prompt-leading-dash' };
  if (text.startsWith('@') && promptVia === 'argv') return { ok: false, code: 'prompt-leading-at' };
  let sent = text;
  if (entry === 'do') {
    // The frame adds at most a few hundred bytes, and escaping a frame tag 3 bytes per tag, so 1024 over the text cap is room enough.
    const framed = composeFrame({
      input: [{ id: 'request', text }],
      instructions: { outcome: ENTRY_LINE, stop: ENTRY_STOP },
      output_format: { reader: ENTRY_READER },
    }, { maxBytes: PROMPT_MAX.bytes + 1024 });
    if (!framed.ok) return { ok: false, code: 'prompt-too-long' };
    if (framed.omitted.length > 0) return { ok: false, code: 'prompt-empty' };
    sent = framed.text;
  }
  return { ok: true, text, sent, sha256: crypto.createHash('sha256').update(sent, 'utf8').digest('hex'), bytes: Buffer.byteLength(sent, 'utf8') };
}

function promptFile(mainRoot: string, runId: string): string {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError(`run id '${runId}' is not 'w-' plus 12 hex characters`);
  return path.join(mainRoot, '.doflow', 'state', STORE, `${runId}.prompt.txt`);
}

/** Keeps the newest 200 files and none older than 30 days, as the store's declaration says, except the
 * file of a run `isEnded` does not vouch for and the file just written. Best effort: a failure here never fails the write. */
function prune(dir: string, keep: string, isEnded: (runId: string) => boolean, now: number): void {
  let entries: { name: string; runId: string; mtimeMs: number }[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = PROMPT_FILE.exec(name);
      if (!match) continue;
      try { entries.push({ name, runId: match[1], mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }); } catch { /* gone already */ }
    }
  } catch { return; }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  entries.forEach((entry, index) => {
    if (entry.name === keep) return;
    if (index < KEEP_NEWEST && now - entry.mtimeMs <= MAX_AGE_MS) return;
    if (!isEnded(entry.runId)) return;
    try { fs.rmSync(path.join(dir, entry.name), { force: true }); } catch { /* the next write prunes again */ }
  });
}

/**
 * Writes `sent` to `<mainRoot>/.doflow/state/session-prompts/<runId>.prompt.txt` through a temporary file and a
 * rename (mode 0600), then prunes the store. `isEnded(runId)` must be true for a run whose prompt may be pruned.
 * @returns `{ store: 'session-prompts', name, sha256, bytes }`
 */
function writePrompt(mainRoot: string, runId: string, sent: string, opts: { isEnded: (runId: string) => boolean; now?: number }) {
  const file = promptFile(mainRoot, runId);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${runId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, sent, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* the original error is the one reported */ }
    throw error;
  }
  prune(dir, path.basename(file), opts.isEnded, opts.now ?? Date.now());
  return { store: STORE, name: path.basename(file), sha256: crypto.createHash('sha256').update(sent, 'utf8').digest('hex'), bytes: Buffer.byteLength(sent, 'utf8') };
}

/** The stored text of a run's prompt; the fs error (`ENOENT` once pruned) propagates. */
function readPrompt(mainRoot: string, runId: string): string {
  return fs.readFileSync(promptFile(mainRoot, runId), 'utf8');
}

module.exports = { ENTRY_LINE, PROMPT_MAX, preparePrompt, writePrompt, readPrompt };

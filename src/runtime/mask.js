'use strict';

/**
 * Masking and normalisation (IC-012). Best-effort, never a guarantee: NFR-003 rests on local-only
 * storage, on keeping a report body on the machine that produced it and on DoFlow never committing
 * the project store. Masking only narrows what a statement or an excerpt can carry.
 *
 * Two profiles. The line profile is for one-line statements and failure messages; the body profile
 * is for report bodies and excerpts and runs every line rule plus the body-only rules 7 to 9.
 * Rules run in the table's order. Normalisation (rules 10 to 13) is a separate step applied to
 * failure messages only, after masking.
 *
 * The module has no I/O and no state; the home directory is read from `HOME` unless the caller
 * passes one.
 */

const MASKED = '<masked>';
const EMAIL = '<email>';
const IP = '<ip>';

/** Key names whose value is a secret. One list for rules 4 and 7. */
const KEY_WORDS = 'password|passwd|secret|token|apikey|api_key|api-key|access_key|client_secret|private_key|credential|cookie|session_id';
/** A key: a whole identifier of at most about 130 characters with the key list inside it. Both runs
 * are bounded, so no input makes the match cost more than that per word start (a long word is tried once). */
const KEY_NAME = `(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,64}?(?:${KEY_WORDS})[A-Za-z0-9_.-]{0,64}(?![A-Za-z0-9_.-])`;

const TOKEN_SHAPES = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  // A lookbehind keeps `sk-` from matching inside ordinary hyphenated words such as "risk-...".
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /npm_[A-Za-z0-9]{24,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

const PEM = /-----BEGIN [^\n-]*-----(?:[\s\S]*?-----END [^\n-]*-----|[\s\S]*$)/g;
const BEARER = /\b(bearer)([ \t]+)(?!<masked>)[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIALS = /:\/\/[^/\s:@]+:[^/\s@]+@/g;
// Rule 4: unquoted, directly after the separator, and only when the value is not plain letters.
const KEY_VALUE_LINE = new RegExp(`(${KEY_NAME})(=|:[ ]?)([^\\s,;&"'\`)\\]}]+)`, 'gi');
const LONG_RUN = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g;
const EMAIL_ADDRESS = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4 = /(?<![0-9.])(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?![0-9]|\.[0-9])/g;
// Rule 7: any spacing around the separator, a quoted or an unquoted value, whatever its shape.
const KEY_VALUE_BODY = new RegExp(`(${KEY_NAME}["']?[ \\t]*[=:][ \\t]*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;&"'\`)\\]}]+)`, 'gi');
const AUTH_HEADER = /((?:Proxy-)?Authorization:)[ \t]*([^\r\n]*)/gi;
const SECRET_FLAG = /(--(?:password|passwd|token|secret|api-key|client-secret)(?:=|[ \t]+))("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi;

function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The home directory to abbreviate: an absolute path other than the file system root. */
function homeOf(options) {
  const raw = options && 'home' in options ? options.home : process.env.HOME;
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  const home = raw.replace(/\/+$/, '');
  return home.length > 1 ? home : null;
}

/** A run of 32 or more characters that is a path: starts with `/`, `~` or `.` and has no part of 32+. */
function isPathRun(run, before) {
  if (!(run.startsWith('/') || before === '~' || before === '.')) return false;
  return run.split('/').every((part) => part.length < 32);
}

function looksLikeSecretRun(run, minDigits) {
  const digits = (run.match(/[0-9]/g) || []).length;
  const upper = (run.match(/[A-Z]/g) || []).length;
  const lower = (run.match(/[a-z]/g) || []).length;
  return digits >= minDigits && upper >= 2 && lower >= 2;
}

// Deviation from IC-012 rule 5 as written ("at least two digits"): a cloud secret access key is
// exactly 40 base64 characters and the spec's own fixture `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`
// holds one digit, so a 40-character value needs one. The value is measured on its own, after any
// `=`, `:` or `_` it is glued to, so `KEY=<40 characters>` is masked like the bare key. A git SHA is
// lower-case hex and still survives. Known limit (DEC-047): the path exemption below lets a key that
// starts with `/` through.
const KEY_VALUE_40 = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])/g;

/** Masks the 40-character values inside a run that did not qualify as a whole. */
function mask40(run, before) {
  return run.replace(KEY_VALUE_40, (value, index) => (
    looksLikeSecretRun(value, 1) && !isPathRun(value, index === 0 ? before : run[index - 1]) ? MASKED : value));
}

function isMasked(value) { return value.replace(/^["']|["']$/g, '') === MASKED; }

function count(text, token) { return text.split(token).length - 1; }

/**
 * Masks `text` with a profile.
 *
 * @param {*} text coerced to a string
 * @param {'line'|'body'} profile
 * @param {{home?: string|null}} [options] `home` overrides `HOME`; `null` turns rule 0 off
 * @returns {{text: string, masked: number}} `masked` counts the values replaced: the net growth in
 *   the number of `<masked>`, `<email>` and `<ip>` markers, so a value two rules both reach counts once
 */
function mask(text, profile, options = {}) {
  if (profile !== 'line' && profile !== 'body') throw new TypeError(`unknown mask profile '${profile}'`);
  const input = text == null ? '' : String(text);
  let out = input;

  // 0. The home directory prefix.
  const home = homeOf(options);
  if (home) out = out.replace(new RegExp(`${escapeRegExp(home)}(?=$|[/\\s"'\`:;,)\\]}])`, 'g'), '~');
  // 1. PEM blocks, to the end of the text when the END line is missing.
  out = out.replace(PEM, MASKED);
  // 2. Token shapes.
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, MASKED);
  // 3. Bearer tokens and URL credentials.
  out = out.replace(BEARER, `$1$2${MASKED}`).replace(URL_CREDENTIALS, `://${MASKED}@`);
  // 4. Key=value, unquoted, when the value is not plain letters.
  out = out.replace(KEY_VALUE_LINE, (match, key, separator, value) => (
    isMasked(value) || value.startsWith(MASKED) || !/[^A-Za-z]/.test(value) ? match : `${key}${separator}${MASKED}`));
  // 5. Long secret-looking runs that are not paths.
  out = out.replace(LONG_RUN, (run, offset) => (
    looksLikeSecretRun(run, 2) && !isPathRun(run, out[offset - 1]) ? MASKED : mask40(run, out[offset - 1])));
  // 6. Email addresses and IPv4 addresses.
  out = out.replace(EMAIL_ADDRESS, EMAIL).replace(IPV4, IP);

  if (profile === 'body') {
    // 7. Key and value, quoted or not, whatever the value looks like.
    out = out.replace(KEY_VALUE_BODY, (match, head, value) => {
      if (isMasked(value) || value.startsWith(MASKED)) return match;
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${head}${quote}${MASKED}${quote}`;
    });
    // 8. Authorization headers: everything after the colon.
    out = out.replace(AUTH_HEADER, (match, name, rest) => (rest === '' || rest === MASKED ? match : `${name} ${MASKED}`));
    // 9. Secret-bearing command-line flags.
    out = out.replace(SECRET_FLAG, (match, flag, value) => (isMasked(value) ? match : `${flag}${MASKED}`));
  }

  const masked = Math.max(0, [MASKED, EMAIL, IP].reduce((sum, token) => sum + count(out, token) - count(input, token), 0));
  return { text: out, masked };
}

const maskLine = (text, options) => mask(text, 'line', options);
const maskBody = (text, options) => mask(text, 'body', options);

const ABSOLUTE_PATH = /(?<![A-Za-z0-9_.:/~-])(?:~(?![A-Za-z0-9_])\/?|\/)[^\s"'`<>:;,()[\]{}]*|[A-Za-z]:\\[^\s"'`<>:;,()[\]{}]*/g;

/**
 * Normalisation rules 10 to 13 (DEC-020), for failure messages. Run it on already-masked text.
 * @param {*} text
 * @returns {string}
 */
function normalise(text) {
  let out = text == null ? '' : String(text);
  out = out.replace(ABSOLUTE_PATH, '<path>');                                          // 10
  out = out.replace(/"[^"]*"|(?<![A-Za-z0-9])'[^']*'|`[^`]*`/g, '"..."');              // 11
  out = out.replace(/[0-9]+/g, 'N');                                                    // 12
  return out.replace(/\s+/g, ' ').trim().slice(0, 200);                                 // 13
}

/**
 * A failure message as stored: paths first (rule 10), then line-profile masking, then the rest of
 * normalisation. Paths go first so the same bug at differently shaped paths gives one fingerprint:
 * a path with a long mixed-case segment would otherwise be masked by rule 5 as `<masked>` while a
 * short one becomes `<path>`.
 */
function normaliseMessage(text, options) {
  const paths = (text == null ? '' : String(text)).replace(ABSOLUTE_PATH, '<path>');
  return normalise(maskLine(paths, options).text);
}

/** Line breaks, which print-safe text turns into a space. */
const PRINT_LINE_BREAK = /[\r\n\u2028\u2029]/g;
/** C0 and C1 controls except tab (the line breaks are replaced first), and the bidirectional marks and overrides. */
const PRINT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const REPLACEMENT = '\uFFFD';

/**
 * Makes stored text safe to show a terminal (DEC-046): a control character (ESC, BEL, C1 included) or a
 * bidirectional mark or override becomes U+FFFD, and a line break becomes a space; tab is kept. A
 * string is cleaned, an array or a plain object is cleaned member by member (keys are left alone),
 * and any other value comes back unchanged. It never alters what is stored: call it on the way out.
 *
 * `keepLineBreaks` leaves CR, LF, U+2028 and U+2029 as they are, for data that is multi-line by design
 * (a report excerpt). That data must still go through the plain form before it is printed as text; as a
 * JSON string a line break is escaped, so it is safe there.
 * @template T
 * @param {T} value
 * @param {{keepLineBreaks?: boolean}} [options]
 * @returns {T}
 */
function printSafe(value, options = {}) {
  if (typeof value === 'string') {
    const spaced = options.keepLineBreaks ? value : value.replace(PRINT_LINE_BREAK, ' ');
    return spaced.replace(PRINT_CONTROL, REPLACEMENT);
  }
  if (Array.isArray(value)) return value.map((item) => printSafe(item, options));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = printSafe(value[key], options);
    return out;
  }
  return value;
}

module.exports = { mask, maskLine, maskBody, normalise, normaliseMessage, printSafe, MASKED };

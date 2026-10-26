'use strict';

// Second-pass masking for the Fleet text fields (feature 093, IC-024; NFR-003). Defence in depth
// only: the core masks every `text` and `args` with `maskBody` (src/runtime/mask.ts) before it prints
// them, and the Console runs this copy of the body profile's key rules over what it received before
// the body leaves the server. The Console has no runtime dependency on core code, so the rules are
// written out here, not imported. Best effort, never a guarantee, like the core's.
//
// It only ever adds markers: a value already `<masked>`, `<email>` or `<ip>` is left as it is, so
// masked input stays masked and a second pass over its own output changes nothing (mask-lite.test.ts).
// Left out on purpose: the command-flag scan of core rules 14 and 15 (`curl -u user:pw`, `mysql -psecret`)
// and the running user's home abbreviation (rule 0); the home of any user is masked instead (rule 17
// here also covers `/home/<name>`).

const MASKED = '<masked>';
const EMAIL = '<email>';
const IP = '<ip>';

/** Key names whose value is a secret (core KEY_WORDS). */
const KEY_WORDS = 'password|passwd|secret|token|apikey|api_key|api-key|access_key|client_secret|private_key|credential|cookie|session_id';
/** A whole identifier of at most about 130 characters with a key word inside it; both runs are bounded. */
const KEY_NAME = `(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,64}?(?:${KEY_WORDS})[A-Za-z0-9_.-]{0,64}(?![A-Za-z0-9_.-])`;

const TOKEN_SHAPES: readonly RegExp[] = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /npm_[A-Za-z0-9]{24,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
const PEM = /-----BEGIN [^\n-]*-----(?:[\s\S]*?-----END [^\n-]*-----|[\s\S]*$)/g;
const BEARER = /\b(bearer)([ \t]+)(?!<masked>)[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIALS = /:\/\/[^/\s:@]+:[^/\s@]+@/g;
const KEY_VALUE_LINE = new RegExp(`(${KEY_NAME})(=|:[ ]?)([^\\s,;&"'\`)\\]}]+)`, 'gi');
const LONG_RUN = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g;
const KEY_VALUE_40 = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])/g;
const EMAIL_ADDRESS = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4 = /(?<![0-9.])(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?![0-9]|\.[0-9])/g;
const KEY_VALUE_BODY = new RegExp(`(${KEY_NAME}["']?[ \\t]*[=:][ \\t]*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;&"'\`)\\]}]+)`, 'gi');
const AUTH_HEADER = /((?:Proxy-)?Authorization:)[ \t]*([^\r\n]*)/gi;
const SECRET_FLAG = /(--(?:password|passwd|token|secret|api-key|client-secret)(?:=|[ \t]+))("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi;
const PASSWORD_PHRASE = /(?<![A-Za-z0-9_.-])((?:password|passwd)[ \t]+)(?!<masked>|[=:])([^\s,;&"'`)\]}]+)/gi;
const HOME_DIRECTORY = /(?<![A-Za-z0-9_.-])\/(Users|home)\/(?!<)[^/\s"'`<>:;,()[\]{}]+/g;

const TS_TYPE_NAMES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'void', 'never', 'null', 'undefined', 'symbol', 'bigint']);

const isMasked = (value: string): boolean => value.replace(/^["']|["']$/g, '') === MASKED;

/** Code that only looks like a secret: `token: string`, `const key = new Foo()`, `secret: Config` (core isCodePreserved). */
function isCodePreserved(head: string, value: string, offset: number, full: string): boolean {
  if (value.startsWith('"') || value.startsWith("'")) return false;
  if (/:[ \t]*$/.test(head)) {
    const baseType = value.replace(/\[\s*\]?$|\[$/, '');
    if (TS_TYPE_NAMES.has(baseType)) return true;
    if (/^[A-Z]|^\[/.test(value)) return true;
    if (/^(?:new\s|[A-Za-z0-9_$]+\s*\(|[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+)/.test(value)) return true;
  }
  if (/=[ \t]*$/.test(head)) {
    const before = full.slice(Math.max(0, offset - 30), offset);
    if (/(?:const|let|var|readonly)\s+$/.test(before)) return true;
    if (/\bnew\s|[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+|\(/.test(value)) return true;
    if (/^[[{]/.test(value)) return true;
  }
  return false;
}

/** A run of 32 or more characters that is a path: starts with `/`, `~` or `.` and has no part of 32+. */
function isPathRun(run: string, before: string | undefined): boolean {
  if (!(run.startsWith('/') || before === '~' || before === '.')) return false;
  return run.split('/').every((part) => part.length < 32);
}

function looksLikeSecretRun(run: string, minDigits: number): boolean {
  const digits = (run.match(/[0-9]/g) || []).length;
  const upper = (run.match(/[A-Z]/g) || []).length;
  const lower = (run.match(/[a-z]/g) || []).length;
  return digits >= minDigits && upper >= 2 && lower >= 2;
}

/** The 40-character values inside a run that did not qualify as a whole. */
function mask40(run: string, before: string | undefined): string {
  return run.replace(KEY_VALUE_40, (value: string, index: number) =>
    looksLikeSecretRun(value, 1) && !isPathRun(value, index === 0 ? before : run[index - 1]) ? MASKED : value);
}

/** `text` with the body profile's key rules applied again. Never removes a marker. */
function maskLite(text: unknown): string {
  let out = text === null || text === undefined ? '' : String(text);
  out = out.replace(PEM, MASKED);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, MASKED);
  out = out.replace(BEARER, `$1$2${MASKED}`).replace(URL_CREDENTIALS, `://${MASKED}@`);
  out = out.replace(KEY_VALUE_LINE, (match: string, key: string, separator: string, value: string, offset: number, full: string) =>
    isMasked(value) || value.startsWith(MASKED) || !/[^A-Za-z]/.test(value) || isCodePreserved(key + separator, value, offset, full) ? match : `${key}${separator}${MASKED}`);
  out = out.replace(LONG_RUN, (run: string, offset: number) =>
    looksLikeSecretRun(run, 2) && !isPathRun(run, out[offset - 1]) ? MASKED : mask40(run, out[offset - 1]));
  out = out.replace(EMAIL_ADDRESS, EMAIL).replace(IPV4, IP);
  out = out.replace(KEY_VALUE_BODY, (match: string, head: string, value: string, offset: number, full: string) => {
    if (isMasked(value) || value.startsWith(MASKED) || isCodePreserved(head, value, offset, full)) return match;
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${head}${quote}${MASKED}${quote}`;
  });
  out = out.replace(AUTH_HEADER, (match: string, name: string, rest: string) => (rest === '' || rest === MASKED ? match : `${name} ${MASKED}`));
  out = out.replace(SECRET_FLAG, (match: string, flag: string, value: string) => (isMasked(value) ? match : `${flag}${MASKED}`));
  out = out.replace(PASSWORD_PHRASE, (match: string, head: string, value: string) => (/[^A-Za-z]/.test(value) && !/^[0-9]{1,3}$/.test(value) ? `${head}${MASKED}` : match));
  out = out.replace(HOME_DIRECTORY, `/$1/${MASKED}`);
  return out;
}

module.exports = { EMAIL, IP, MASKED, maskLite };

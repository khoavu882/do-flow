'use strict';

// Static files from the web root (IC-006). A request path is accepted only when, after one decode, it
// names a regular file of a fixed extension through plain directory segments: no `..`, no encoded
// separator or dot, no NUL or backslash, no empty or dot-leading segment, and no symlink at any segment
// below the web root (each one is lstat-ed; the final open uses O_NOFOLLOW). Anything else is null and
// the caller answers 404. Ceiling: a directory swapped for a symlink between the lstat walk and the open
// is not caught; the web root is the package's own read-only directory, not attacker-writable.

const fs = require('node:fs');
const path = require('node:path');

const TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
]);

// Encoded `/`, `\`, `.` and NUL are refused before decoding, so a decode can never create a separator.
const ENCODED_FORBIDDEN = /%(?:2f|5c|2e|00)/i;

// The raw request pathname (no query) to the segments below the web root, or null when refused.
function staticSegments(rawPath: string): string[] | null {
  if (rawPath === '/') return ['index.html'];
  if (!rawPath.startsWith('/') || ENCODED_FORBIDDEN.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (/[\0\\]/.test(decoded)) return null;
  const segments = decoded.slice(1).split('/');
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return null;
  if (!TYPES.has(path.extname(segments[segments.length - 1]))) return null;
  return segments;
}

// The file's type and bytes, or null for anything that is not a plain regular file under `webRoot`.
// `webRoot` is a real path (no symlink in it), resolved once by the server.
async function readStatic(webRoot: string, rawPath: string): Promise<{ type: string, body: any } | null> {
  const segments = staticSegments(rawPath);
  if (segments === null) return null;
  let current = webRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat: any;
    try {
      stat = await fs.promises.lstat(current);
    } catch {
      return null;
    }
    const last = index === segments.length - 1;
    // lstat reports a symlink as neither a file nor a directory, so this also refuses every symlink.
    if (last ? !stat.isFile() : !stat.isDirectory()) return null;
  }
  let handle: any;
  try {
    handle = await fs.promises.open(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    return { type: TYPES.get(path.extname(current)) as string, body: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

module.exports = { readStatic, staticSegments, TYPES };

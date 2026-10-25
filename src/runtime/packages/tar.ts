'use strict';

/**
 * Read an in-memory ustar or pax archive under the IC-005 limits while reading it.
 * Link entries are refused as `symlink`. This module writes nothing and spawns nothing.
 */

const zlib = require('node:zlib');
const { SEGMENT, SEGMENT_GRAMMAR } = require('./digest.ts');

function readTar(input: any, { limits, stripPrefix, packageId = null }: any): any {
  const findings: any[] = [];
  const files: any[] = [];
  const seen = new Set<string>();
  const add = (field: string, code: string, message: string, allowed: any): any => {
    findings.push({ package: packageId, field, code, severity: 'error', message, allowed });
    return { ok: false, findings };
  };
  let data = input;
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try { data = zlib.gunzipSync(data, { maxOutputLength: limits.bytes + (limits.files + 64) * 1024 }); }
    catch { return add('tree', 'too-large', 'the compressed archive exceeds the bounded tar size', `at most ${limits.bytes} bytes plus archive headers`); }
  }
  const text = (buf: any): string => buf.toString('utf8').replace(/\0.*$/su, '');
  const octal = (buf: any): number => {
    const value = text(buf).trim();
    return value ? parseInt(value, 8) : 0;
  };
  const blocks = Math.floor(data.length / 512);
  let index = 0;
  let total = 0;
  let count = 0;
  let pax: any = null;
  while (index < blocks) {
    const h = data.subarray(index * 512, (index + 1) * 512);
    if (h.every((v: number) => v === 0)) break;
    const magic = h.subarray(257, 263).toString('binary');
    if (magic !== 'ustar\0' && magic !== 'ustar ') return add('tree', 'bad-type', 'tar header is not ustar or pax', 'ustar or pax archive headers');
    const expected = octal(h.subarray(148, 156));
    let sum = 0;
    for (let j = 0; j < 512; j++) sum += j >= 148 && j < 156 ? 32 : h[j];
    if (sum !== expected) return add('tree', 'bad-type', 'tar header checksum does not match', 'a valid tar header checksum');
    const size = octal(h.subarray(124, 136));
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    index++;
    if (!Number.isSafeInteger(size) || size < 0 || index * 512 + size > data.length) return add('tree', 'bad-type', 'tar entry is truncated or has an invalid size', 'a complete tar entry');
    const payloadStart = index * 512;
    const payloadEnd = payloadStart + size;
    const payload = data.subarray(payloadStart, payloadEnd);
    index += Math.ceil(size / 512);
    if (type === 'g') continue;
    if (type === 'x') {
      pax = {};
      const raw = payload.toString('utf8');
      let at = 0;
      while (at < raw.length) {
        const space = raw.indexOf(' ', at);
        const n = Number(raw.slice(at, space));
        if (space < 0 || !Number.isInteger(n) || n <= 0 || at + n > raw.length) return add('tree', 'bad-type', 'pax header is malformed', 'valid pax path and size records');
        const row = raw.slice(space + 1, at + n).replace(/\n$/u, '');
        const eq = row.indexOf('=');
        if (eq > 0) pax[row.slice(0, eq)] = row.slice(eq + 1);
        at += n;
      }
      continue;
    }
    let name = pax?.path ?? text(h.subarray(0, 100));
    const prefix = text(h.subarray(345, 500));
    if (!pax?.path && prefix) name = `${prefix}/${name}`;
    const actualSize = pax?.size === undefined ? size : Number(pax.size);
    pax = null;
    if (type === '1' || type === '2') return add(`tree.${name}`, 'symlink', `${name} is a symbolic link`, 'regular files and directories only');
    if (type === '3' || type === '4' || type === '6') return add(`tree.${name}`, 'special-file', `${name} is a device, socket or FIFO`, 'regular files and directories only');
    if (type !== '0' && type !== '5') return add(`tree.${name}`, 'bad-type', `unsupported tar entry type '${type}'`, 'regular files and directories only');
    if (type === '5') continue;
    name = name.replace(/^\.\//u, '');
    if (name.startsWith('/') || name.split('/').includes('..')) return add(`tree.${name}`, 'path-escapes-root', `${name} leaves the package root`, 'a path inside the package root');
    if (stripPrefix) {
      if (!name.startsWith(stripPrefix)) return add(`tree.${name}`, 'path-escapes-root', `${name} is outside ${stripPrefix}`, `a path inside ${stripPrefix}`);
      name = name.slice(stripPrefix.length);
    }
    const segments = name.split('/');
    if (segments.some((s: string) => !SEGMENT.test(s))) return add(`tree.${name}`, 'bad-type', `${name}: a segment breaks the path grammar`, SEGMENT_GRAMMAR);
    if (name.length > limits.pathLength) return add(`tree.${name}`, 'too-large', `${name} is ${name.length} characters long`, `a relative path of at most ${limits.pathLength} characters`);
    if (!Number.isSafeInteger(actualSize) || actualSize < 0 || actualSize !== size) return add(`tree.${name}`, 'bad-type', 'pax size does not match the tar entry', 'a complete tar entry');
    if (actualSize > limits.fileBytes) return add(`tree.${name}`, 'too-large', `${name} is ${actualSize} bytes`, `at most ${limits.fileBytes} bytes per file`);
    if (count >= limits.files) return add('tree', 'too-many-files', `the package holds more than ${limits.files} files`, `at most ${limits.files} files`);
    if (total + actualSize > limits.bytes) return add('tree', 'too-large', `the package holds more than ${limits.bytes} bytes`, `at most ${limits.bytes} bytes in total`);
    if (seen.has(name)) return add(`tree.${name}`, 'bad-type', `${name} appears twice in the archive`, 'each file path at most once');
    total += actualSize;
    count++;
    seen.add(name);
    const mode = octal(h.subarray(100, 108));
    files.push({ path: name, mode: (mode & 0o111) !== 0 ? 0o755 : 0o644, data: payload });
  }
  const compareBytes = (a: string, b: string): number => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
  };
  files.sort((a: any, b: any) => compareBytes(a.path, b.path));
  return { ok: true, files };
}

module.exports = { readTar };

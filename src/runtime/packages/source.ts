'use strict';

/**
 * Parse package source specs for IC-022: local paths, git URLs and npm names.
 * Unsupported schemes and URL credentials are refused as `bad-type`. This module
 * spawns nothing and writes nothing; the fetch itself arrives with E.2/E.3.
 */

type RemoteSource =
  | { type: 'git'; url: string; ref: string; path?: string }
  | { type: 'npm'; name: string; version: string };
type PackageSource = { type: 'local'; path: string } | RemoteSource;
type ParseResult = { ok: true; source: PackageSource } | { ok: false; finding: any };

const ALLOWED = 'a local path, git:https://<host>/<repo>[#<subdir>]@<ref>, or npm:<name>@<version or range>';

function badType(message: string): ParseResult {
  return {
    ok: false,
    finding: { package: null, field: 'source', code: 'bad-type', severity: 'error', message, allowed: ALLOWED },
  };
}

const hasControl = (value: string): boolean => /[\u0000-\u001f\u007f]/u.test(value);
const hasSpaceOrControl = (value: string): boolean => /[\s\u0000-\u001f\u007f]/u.test(value);

function parseSource(spec: string): ParseResult {
  if (spec.startsWith('git:')) {
    const body = spec.slice(4);
    const refAt = body.lastIndexOf('@');
    if (refAt < 0) return badType('git source needs a non-empty ref after the final @');
    const target = body.slice(0, refAt);
    const ref = body.slice(refAt + 1);
    const hashAt = target.indexOf('#');
    const url = hashAt < 0 ? target : target.slice(0, hashAt);
    const subdir = hashAt < 0 ? undefined : target.slice(hashAt + 1);
    if (!url || url.length > 512 || hasSpaceOrControl(url)) return badType('git URL must be non-empty, at most 512 characters, and contain no whitespace or control characters');
    if (!ref || ref.length > 512 || hasSpaceOrControl(ref)) return badType('git ref must be non-empty, at most 512 characters, and contain no whitespace or control characters');
    let parsed: InstanceType<typeof URL>;
    try { parsed = new URL(url); } catch { return badType('git URL must be a valid https URL'); }
    if (parsed.protocol !== 'https:' || !parsed.host) return badType('git URL must use https and include a host');
    if (parsed.username || parsed.password) return badType('git URL must not contain credentials');
    if (subdir !== undefined && (!subdir || subdir.startsWith('/') || subdir.includes('\\') || subdir.split('/').includes('..'))) {
      return badType('git subdir must be non-empty, relative, and contain no .. segment or backslash');
    }
    return { ok: true, source: { type: 'git', url, ref, ...(subdir === undefined ? {} : { path: subdir }) } };
  }
  if (spec.startsWith('npm:')) {
    const body = spec.slice(4);
    const versionAt = body.lastIndexOf('@');
    if (versionAt <= 0) return badType('npm source needs a package name and non-empty version or range');
    const name = body.slice(0, versionAt);
    const version = body.slice(versionAt + 1);
    if (name.length > 214 || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
      return badType('npm package name does not match the allowed package name grammar');
    }
    if (!version || version.length > 512 || hasControl(version)) return badType('npm version or range must be non-empty, at most 512 characters, and contain no control characters');
    return { ok: true, source: { type: 'npm', name, version } };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(spec)) return badType('source scheme is not supported');
  return { ok: true, source: { type: 'local', path: spec } };
}

function fetchGrantLine(source: RemoteSource, at: string): string {
  return JSON.stringify({ grant: 'fetch', source, at });
}

module.exports = { parseSource, fetchGrantLine };

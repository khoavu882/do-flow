'use strict';

/** IC-023: a bounded, closed, local index. Reading and selecting write and spawn nothing. */
const fs = require('node:fs');
const { isPackageId } = require('../../helper/package-ids.ts');
const { parseSemVer, compareSemVer, parseHostRange, satisfiesHostRange } = require('../../helper/semver.ts');

const MAX_BYTES = 4 * 1024 * 1024;
const object = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: any): boolean => typeof value === 'string' && parseSemVer(value) !== null;
const text = (value: any): boolean => typeof value === 'string' && value.length > 0;
const problem = (field: string, code: string, message: string, allowed: any): any => ({
  package: null, field, code, severity: 'error', message, allowed,
});

function closed(value: any, allowed: string[], field: string, findings: any[]): boolean {
  if (!object(value)) {
    findings.push(problem(field, 'bad-type', 'must be an object', allowed));
    return false;
  }
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name)) findings.push(problem(`${field}.${name}`, 'unknown-key', 'unknown index field', allowed));
  }
  return true;
}

/** Shared with the plan reader: only safe, fully pinned remote records are accepted. */
function pinnedSourceFindings(source: any, field = 'source'): any[] {
  const findings: any[] = [];
  if (!object(source)) return [problem(field, 'bad-type', 'must be a pinned source object', 'git or npm')];
  if (source.type === 'git') {
    closed(source, ['type', 'url', 'commit', 'path'], field, findings);
    let validUrl = false;
    if (text(source.url) && source.url.length <= 512 && !/[\s\u0000-\u001f\u007f]/u.test(source.url)) {
      try {
        const url = new URL(source.url);
        validUrl = url.protocol === 'https:' && Boolean(url.host) && !url.username && !url.password && !url.hash;
      } catch { /* invalid URL */ }
    }
    if (!validUrl) findings.push(problem(`${field}.url`, 'bad-type', 'must be an https URL without credentials or a fragment', 'an https URL of at most 512 characters'));
    if (typeof source.commit !== 'string' || !/^[0-9a-fA-F]{40}$/u.test(source.commit)) {
      findings.push(problem(`${field}.commit`, 'source-unpinned', 'git source needs a full commit', '40 hexadecimal characters'));
    }
    if (Object.hasOwn(source, 'path') && (!text(source.path) || source.path.length > 512
      || source.path.startsWith('/') || source.path.startsWith('-') || source.path.includes('\\')
      || source.path.split('/').some((part: string) => part === '..' || part === '')
      || /[\s\u0000-\u001f\u007f]/u.test(source.path))) {
      findings.push(problem(`${field}.path`, 'bad-type', 'must be a safe relative subdirectory', 'a relative path without .., backslashes, whitespace or a leading -'));
    }
  } else if (source.type === 'npm') {
    closed(source, ['type', 'name', 'version', 'integrity'], field, findings);
    if (!text(source.name) || source.name.length > 214 || source.name.startsWith('-')
      || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u.test(source.name)) {
      findings.push(problem(`${field}.name`, 'bad-type', 'invalid npm package name', 'an npm name that does not start with -'));
    }
    if (!exact(source.version)) findings.push(problem(`${field}.version`, 'source-unpinned', 'npm source needs an exact version', 'an exact semver'));
    if (typeof source.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(source.integrity)) {
      findings.push(problem(`${field}.integrity`, 'source-unpinned', 'npm source needs sha512 integrity', 'sha512-<base64>'));
    }
  } else {
    findings.push(problem(`${field}.type`, 'bad-type', 'index sources must be remote and pinned', ['git', 'npm']));
  }
  return findings;
}

function readIndex(file: string, { fsImpl = fs }: any = {}): any {
  const fail = (field: string, code: string, message: string, allowed: any): any => ({
    ok: false, findings: [problem(field, code, message, allowed)],
  });
  let raw: string;
  try {
    if (fsImpl.statSync(file).size > MAX_BYTES) return fail('index', 'too-large', 'index exceeds 4 MiB', MAX_BYTES);
    raw = String(fsImpl.readFileSync(file, 'utf8'));
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return fail('index', 'too-large', 'index exceeds 4 MiB', MAX_BYTES);
  } catch {
    return fail('index', 'bad-type', 'index cannot be read', 'a readable local JSON file');
  }
  let index: any;
  try { index = JSON.parse(raw); } catch { return fail('index', 'bad-type', 'index is not JSON', 'a JSON object'); }
  const findings: any[] = [];
  if (closed(index, ['format', 'packages'], 'index', findings)) {
    if (index.format !== 1) findings.push(problem('index.format', 'bad-type', 'unsupported index format', 1));
    if (!Array.isArray(index.packages)) {
      findings.push(problem('index.packages', 'bad-type', 'must be an array', 'an array of packages'));
    } else {
      const ids = new Set<string>();
      index.packages.forEach((pkg: any, p: number) => {
        const field = `index.packages[${p}]`;
        if (!closed(pkg, ['id', 'versions'], field, findings)) return;
        if (!isPackageId(pkg.id) || ids.has(pkg.id)) {
          findings.push(problem(`${field}.id`, 'bad-id', 'invalid or duplicate package id', 'a unique IC-003 package id'));
        }
        ids.add(pkg.id);
        if (!Array.isArray(pkg.versions)) {
          findings.push(problem(`${field}.versions`, 'bad-type', 'must be an array', 'an array of versions'));
          return;
        }
        const versions = new Set<string>();
        pkg.versions.forEach((entry: any, v: number) => {
          const at = `${field}.versions[${v}]`;
          if (!closed(entry, ['version', 'doflow', 'source'], at, findings)) return;
          if (!exact(entry.version) || versions.has(entry.version)) {
            findings.push(problem(`${at}.version`, 'bad-type', 'invalid or duplicate version', 'a unique exact semver'));
          }
          versions.add(entry.version);
          if (!parseHostRange(entry.doflow).ok) {
            findings.push(problem(`${at}.doflow`, 'bad-type', 'invalid host range', 'the IC-016 host range grammar'));
          }
          findings.push(...pinnedSourceFindings(entry.source, `${at}.source`));
        });
      });
    }
  }
  return findings.length ? { ok: false, findings } : { ok: true, index };
}

function pickVersion(index: any, id: string, { version, host }: any): any {
  const pkg = index.packages.find((entry: any) => entry.id === id);
  if (!pkg) return { ok: false, findings: [problem('id', 'bad-id', `no index package '${id}'`, index.packages.map((entry: any) => entry.id))] };
  if (version !== undefined) {
    const entry = pkg.versions.find((candidate: any) => candidate.version === version);
    return entry ? { ok: true, entry } : {
      ok: false, findings: [problem('version', 'bad-id', `no version '${version}' of '${id}'; available versions: ${pkg.versions.map((candidate: any) => candidate.version).join(', ')}`, pkg.versions.map((candidate: any) => candidate.version))],
    };
  }
  const candidates = pkg.versions.filter((entry: any) => parseSemVer(entry.version).prerelease.length === 0
    && satisfiesHostRange(host, entry.doflow));
  candidates.sort((left: any, right: any) => compareSemVer(right.version, left.version));
  return candidates.length ? { ok: true, entry: candidates[0] } : {
    ok: false, findings: [problem('version', 'host-incompatible', `no stable version of '${id}' admits host ${host}`, 'a non-prerelease version compatible with this host')],
  };
}

module.exports = { readIndex, pickVersion, pinnedSourceFindings };

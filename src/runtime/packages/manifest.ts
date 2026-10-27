'use strict';

/**
 * The package manifest checker (122 IC-001, IC-003, IC-004). `checkManifest` judges one `doflow-package.json`
 * (text or parsed) and returns IC-004 findings; with `root` it also reads and validates each contribution
 * file through the point's validator. `checkPackage` adds the IC-005 tree rules and the digests for a package
 * directory. Neither throws on content and neither writes. Collisions with recorded packages are not judged
 * here: no records exist before the lifecycle verbs (Phase B).
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseSemVer, parseHostRange, satisfiesHostRange } = require('../../helper/semver.ts');
const { isPackageId, isLocalId, isReservedPackageId, qualifiedId } = require('../../helper/package-ids.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadPoints, judgeContribution, POINT_VALIDATORS } = require('./points.ts');
const { judgeInstruction } = require('./instruction.ts');
const { walkTree, digestFiles, capabilityDigest, SEGMENT, SEGMENT_GRAMMAR } = require('./digest.ts');
const { duplicateKeys, loadProtocols, lensIds, coreTiers } = require('../review/protocols.ts');
const { dominates } = require('../review/dominance.ts');
const { programFindings } = require('./programs.ts');

const MANIFEST_FILE = 'doflow-package.json';
const MANIFEST_MAX_BYTES = 64 * 1024;
const TOP_KEYS = ['manifest', 'id', 'version', 'summary', 'doflow', 'programs', 'contributions'];
const ENTRY_KEYS = ['point', 'version', 'id', 'file', 'dir', 'programs'];
const PRESET_KIND: Record<string, string> = { 'review-preset-v1': 'review', 'debate-preset-v1': 'debate' };
const PACKAGE_ID_GRAMMAR = '2 to 16 characters of a-z, 0-9 and single hyphens, starting with a letter and ending with a letter or digit';
const LOCAL_ID_GRAMMAR = '2 to 15 characters of a-z, 0-9 and single hyphens, starting with a letter and ending with a letter or digit';
const BARE_ID = /^[a-z][a-z0-9-]*$/;

const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Names of the core agents: `all`, and `readOnly` (`access: read-only`, the seats of INV-2, which covers review only).
 * Read from core/registry/workflows.json `agents.access`, which an installed runtime ships (it has no core/shared);
 * G63 holds that map equal to the spec frontmatter.
 */
function coreAgents(repoRoot: string, fsImpl: any): { all: string[]; readOnly: string[] } {
  const found = { all: [] as string[], readOnly: [] as string[] };
  try {
    const access = JSON.parse(String(fsImpl.readFileSync(path.join(repoRoot, 'core', 'registry', 'workflows.json'), 'utf8'))).agents.access;
    found.all = Object.keys(access).sort();
    found.readOnly = found.all.filter((name) => access[name] === 'read-only');
  } catch { /* an unreadable map leaves no agent usable; the validator then names that */ }
  return found;
}

/** `allowed` for a point validator's message: the part after "must be (one of)", else the whole message. */
function allowedOf(message: string): string | string[] {
  const list = message.match(/must be one of (.+)$/);
  if (list) return list[1].split(', ');
  const rest = message.match(/must (?:be|match|not exceed) (.+)$/);
  return rest ? rest[1] : message;
}

/**
 * Check a manifest. `input` is the manifest text (preferred: duplicate keys and the size limit are only
 * visible there) or a parsed object. Options: `pointsRegistry` (a loaded point registry, required),
 * `hostVersion` (an unreadable one is `host-incompatible`: the range cannot be shown to hold), `bundled` (ids of the first-party manifests, which alone may use reserved and bare ids),
 * `root` (the package directory, to read contribution files), `protocols` (the core protocol registry;
 * default: the installed one), `repoRoot`, `fsImpl`, `hostExempt` (a person `exempt` grant matched, IC-008: a host
 * outside the range is then a `host-incompatible` warning, never an error). Returns the IC-004 findings.
 */
function checkManifest(input: any, options: any = {}): any[] {
  const { pointsRegistry, hostVersion, root, repoRoot = REPO_ROOT, fsImpl = fs } = options;
  const bundled: string[] = (options.bundled ?? []).map((b: any) => (typeof b === 'string' ? b : b?.id));
  const findings: any[] = [];
  let packageId: string | null = null;
  const report = (field: string, code: string, message: string, allowed: any, severity = 'error') =>
    findings.push({ package: packageId, field, code, severity, message, allowed });
  try {
    check();
  } catch (error: any) {
    report('manifest', 'bad-type', `the manifest could not be checked: ${error?.message || String(error)}`, 'a JSON object');
  }
  return findings;

  function check(): void {
    const forbidden: string[] = pointsRegistry.forbiddenFields;
    let manifest = input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input) > MANIFEST_MAX_BYTES) {
        report(MANIFEST_FILE, 'too-large', `the manifest is larger than ${MANIFEST_MAX_BYTES} bytes`, `at most ${MANIFEST_MAX_BYTES} bytes`);
        return;
      }
      try { manifest = JSON.parse(input); } catch (error: any) {
        report(MANIFEST_FILE, 'bad-type', `the manifest is not valid JSON: ${error.message}`, 'a JSON object');
        return;
      }
      for (const message of duplicateKeys(input)) report(message.replace(/^.* in /, ''), 'duplicate-key', message, 'each key at most once');
    }
    if (!isObject(manifest)) { report('manifest', 'bad-type', 'the manifest must be a JSON object', 'a JSON object'); return; }
    if (typeof manifest.id === 'string') packageId = manifest.id;
    const isBundled = typeof manifest.id === 'string' && bundled.includes(manifest.id);

    for (const key of Object.keys(manifest)) {
      if (TOP_KEYS.includes(key)) continue;
      if (forbidden.includes(key)) report(key, 'forbidden-field', `'${key}' is decided by DoFlow or the person, never by a package`, 'omit the field');
      else report(key, 'unknown-key', `'${key}' is not a manifest field`, TOP_KEYS);
    }

    if (!Object.hasOwn(manifest, 'manifest')) report('manifest', 'bad-type', 'manifest is required', [1]);
    else if (manifest.manifest !== 1) report('manifest', 'unsupported-manifest', `manifest format ${JSON.stringify(manifest.manifest)} is not supported`, [1]);

    if (!isPackageId(manifest.id)) report('id', 'bad-id', `package id ${JSON.stringify(manifest.id)} breaks the grammar`, PACKAGE_ID_GRAMMAR);
    else if (isReservedPackageId(manifest.id) && !isBundled) {
      report('id', 'reserved-id', `package id '${manifest.id}' is reserved`, 'an id that is not doflow, do, core, user, project, local, env, auto, package, packages and does not start with do- or doflow-');
    }

    if (typeof manifest.version !== 'string' || manifest.version.length > 64 || parseSemVer(manifest.version) === null) {
      report('version', 'bad-type', `version ${JSON.stringify(manifest.version)} is not a semver 2.0.0 string of at most 64 characters`, 'an exact semver 2.0.0 version');
    }
    if (Object.hasOwn(manifest, 'summary')
      && (typeof manifest.summary !== 'string' || manifest.summary.length > 120 || /[\u0000-\u001f\u007f<>`]/.test(manifest.summary))) {
      report('summary', 'bad-type', 'summary is not plain text of at most 120 characters', 'at most 120 characters, no control characters, < > or backticks');
    }

    if (!Object.hasOwn(manifest, 'doflow')) report('doflow', 'bad-type', 'doflow (the host range) is required', 'a host range');
    else {
      const range = parseHostRange(manifest.doflow);
      if (!range.ok) report('doflow', range.error.code, range.error.message, range.error.allowed);
      else if (!hostVersion) {
        report('doflow', 'host-incompatible', 'the running DoFlow version cannot be read', manifest.doflow);
      } else if (!satisfiesHostRange(hostVersion, range)) {
        report('doflow', 'host-incompatible', `DoFlow ${hostVersion} is outside the range ${manifest.doflow}`, manifest.doflow, options.hostExempt === true ? 'warning' : 'error');
      }
    }

    const contributions = manifest.contributions;
    let executable = false;
    if (!Array.isArray(contributions) || contributions.length === 0 || contributions.length > 64) {
      report('contributions', 'bad-type', 'contributions must be a non-empty array of at most 64 entries', 'an array of 1 to 64 contributions');
    } else {
      const seen = new Set<string>();
      const protocols = options.protocols ?? loadProtocols({ repoRoot }).registry;
      const context = { protocols, agents: coreAgents(repoRoot, fsImpl), manifest };
      contributions.forEach((entry: any, index: number) => {
        const where = `contributions[${index}]`;
        if (!isObject(entry)) { report(where, 'bad-type', 'a contribution must be an object', 'an object'); return; }
        const point = pointsRegistry.points.find((p: any) => p.id === entry.point);
        if (point?.tier === 'executable') executable = true;
        checkEntry(entry, index, point, isBundled, seen, context);
      });
    }
    if (Object.hasOwn(manifest, 'programs') && !executable) {
      report('programs', 'forbidden-field', 'programs belong only to a package that contributes to an executable point', 'omit the field');
    }
    if (executable) {
      findings.push(...programFindings(manifest, { root, pointsRegistry, fsImpl, packageId }));
    }
  }

  function checkEntry(entry: any, index: number, point: any, isBundled: boolean, seen: Set<string>, context: any): void {
    const where = `contributions[${index}]`;
    for (const key of Object.keys(entry)) {
      if (ENTRY_KEYS.includes(key)) continue;
      if (pointsRegistry.forbiddenFields.includes(key)) report(`${where}.${key}`, 'forbidden-field', `'${key}' is decided by DoFlow or the person, never by a package`, 'omit the field');
      else report(`${where}.${key}`, 'unknown-key', `'${key}' is not a contribution field`, ENTRY_KEYS);
    }
    if (Object.hasOwn(entry, 'programs') && point?.tier !== 'executable') {
      report(`${where}.programs`, 'forbidden-field', 'programs belong only to a contribution on an executable point', 'omit the field');
    }
    if (typeof entry.point !== 'string') { report(`${where}.point`, 'bad-type', 'point must be a string', pointsRegistry.points.map((p: any) => p.id)); return; }
    if (!Number.isInteger(entry.version)) { report(`${where}.version`, 'bad-type', 'version must be an integer', point?.versions ?? 'an integer'); return; }
    const judged = judgeContribution(pointsRegistry, entry, { packageId, index });
    if (judged) findings.push(judged);

    // The id: a local id, or for a first-party manifest any bare built-in id; a bare built-in id elsewhere is reserved.
    const builtin = new Set<string>(Object.keys(context.protocols?.presets ?? {}));
    let qid: string | null = null;
    if (typeof entry.id !== 'string' || !(isBundled ? BARE_ID.test(entry.id) : isLocalId(entry.id))) {
      report(`${where}.id`, 'bad-id', `contribution id ${JSON.stringify(entry.id)} breaks the grammar`, LOCAL_ID_GRAMMAR);
    } else if (!isBundled && builtin.has(entry.id)) {
      report(`${where}.id`, 'reserved-id', `'${entry.id}' is a built-in id; only the first-party package uses a bare built-in id`, 'a local id that is not a built-in id');
    } else {
      const key = `${entry.point}\0${entry.id}`;
      if (seen.has(key)) report(`${where}.id`, 'bad-id', `(${entry.point}, ${entry.id}) is contributed twice`, 'each (point, id) at most once');
      seen.add(key);
      qid = isBundled ? entry.id : qualifiedId(packageId as string, entry.id);
    }

    const wanted = point?.entry;
    const given = ['file', 'dir'].filter((key) => Object.hasOwn(entry, key));
    if (given.length !== 1 || (wanted && given[0] !== wanted)) {
      report(`${where}.${wanted ?? 'file'}`, 'bad-type', `exactly one of file or dir is required${wanted ? `; point '${point.id}' takes ${wanted}` : ''}`, wanted ?? ['file', 'dir']);
      return;
    }
    const kind = given[0];
    const found = locate(entry[kind], `${where}.${kind}`, kind);
    if (judged || !found || !qid) return;
    if (point?.validator === 'skill-v1' || point?.validator === 'agent-v1') {
      if (point.validator === 'agent-v1' && fsImpl.statSync(found).size > pointsRegistry.limits.fileBytes) return;
      const instructionFindings = judgeInstruction(point.validator, entry.id, found, { packageId, fsImpl });
      for (const item of instructionFindings) report(`${qid}${item.field}`, item.code, item.message, item.allowed);
      return;
    }
    if (kind !== 'file') return;
    validateFile(found, entry, point, qid, context);
  }

  /** Lexical and realpath checks on a manifest path; returns the real path when it is usable. */
  function locate(rel: any, field: string, kind: string): string | null {
    const limits = pointsRegistry.limits;
    if (typeof rel !== 'string' || rel.length === 0) { report(field, 'bad-type', 'the path must be a non-empty string', 'a POSIX path relative to the package root'); return null; }
    if (rel.startsWith('/') || rel.split('/').includes('..')) { report(field, 'path-escapes-root', `${rel} leaves the package root`, 'a path inside the package root'); return null; }
    if (rel.length > limits.pathLength || rel.split('/').some((s: string) => !SEGMENT.test(s))) {
      report(field, 'bad-type', `${rel} breaks the path rules`, `${SEGMENT_GRAMMAR} per segment, at most ${limits.pathLength} characters`);
      return null;
    }
    if (!root) return null;
    let real: string;
    let rootReal: string;
    try {
      rootReal = fsImpl.realpathSync(root);
      real = fsImpl.realpathSync(path.join(root, rel));
    } catch {
      report(field, 'file-missing', `${rel} does not exist`, `an existing ${kind === 'dir' ? 'directory' : 'file'}`);
      return null;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      report(field, 'path-escapes-root', `${rel} resolves outside the package root`, 'a path inside the package root');
      return null;
    }
    const stat = fsImpl.statSync(real);
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
      report(field, 'file-missing', `${rel} is not a ${kind === 'dir' ? 'directory' : 'regular file'}`, `an existing ${kind === 'dir' ? 'directory' : 'file'}`);
      return null;
    }
    return real;
  }

  /** Read one contribution file and run the point's validator, then comparability for a preset. */
  function validateFile(real: string, entry: any, point: any, qid: string, context: any): void {
    if (fsImpl.statSync(real).size > pointsRegistry.limits.fileBytes) return; // the tree rules report too-large
    const text = fsImpl.readFileSync(real, 'utf8');
    const invalid = (field: string, message: string) => report(field, 'contribution-invalid', message, allowedOf(message));
    let parsed: any;
    try { parsed = JSON.parse(text); } catch (error: any) { invalid(qid, `${entry.file} is not valid JSON: ${error.message}`); return; }
    for (const message of duplicateKeys(text)) report(`${qid}.${message.replace(/^.* in /, '')}`, 'duplicate-key', message, 'each key at most once');
    const validator = POINT_VALIDATORS[point.validator];
    const kind = PRESET_KIND[point.validator];
    const protocols = context.protocols;
    if (!validator) return;
    if (kind && !protocols) { invalid(qid, 'the core protocol registry is unreadable, so a preset cannot be checked'); return; }
    let errors: string[];
    let comparable: boolean | null = null;
    if (kind) {
      const judged = judgePackagePreset(point.validator, entry.id, parsed, { protocols, agents: context.agents });
      if (judged.depth) report(`${qid}.depth`, 'forbidden-field', 'depth is not allowed in a package preset (the depth vocabulary stays core)', 'omit the field');
      errors = judged.errors;
      comparable = judged.comparable;
    } else {
      errors = validator(entry.id, parsed, { ...context, entry, packageId });
    }
    const prefix = `presets.${entry.id}`;
    for (const message of errors) {
      const token = message.split(' ')[0];
      invalid(token.startsWith(prefix) ? `${qid}${token.slice(prefix.length)}` : qid, message);
    }
    if (errors.length > 0 || !kind) return;
    if (!comparable) {
      report(qid, 'incomparable', `${qid} dominates no core ${kind} preset, so it cannot be ordered against them`, `a ${kind} preset that is at least as strict as one core ${kind} preset`);
    }
  }
}

/**
 * One contributed preset in package mode (IC-014): the validator `check` runs on a package file, shared with the
 * runtime seam (`contributionsFor`) so the two cannot disagree. `validatorKey` is the point's validator
 * (`review-preset-v1` or `debate-preset-v1`), `protocols` the core registry, `agents` the `coreAgents` result.
 * Returns `{ kind, depth, errors, comparable }`: `depth` says the preset carried the refused `depth` field (judged
 * without it, as `check` reports it separately), `errors` are the validator messages, and `comparable` is whether
 * it dominates at least one core preset of its kind (null while there are errors).
 */
function judgePackagePreset(validatorKey: string, localId: string, parsed: any, { protocols, agents }: any): { kind: string; depth: boolean; errors: string[]; comparable: boolean | null } {
  const kind = PRESET_KIND[validatorKey];
  const depth = isObject(parsed) && 'depth' in parsed;
  let body = parsed;
  if (depth) { body = { ...parsed }; delete body.depth; }
  const tiers = coreTiers();
  const errors: string[] = POINT_VALIDATORS[validatorKey](localId, body, {
    mode: 'package', lensIds: lensIds(protocols), hardRoundCap: protocols.hardRoundCap, tiers, agents: kind === 'review' ? agents.readOnly : agents.all,
  });
  const comparable = errors.length > 0 ? null : Object.values<any>(protocols.presets).some((core) => core?.kind === kind
    && dominates(body, core, { tiers, synthesizerStrength: protocols.synthesizerStrength }));
  return { kind, depth, errors, comparable };
}

/**
 * Check a package directory: the manifest, the IC-005 tree rules and, when there is no error, both digests.
 * Returns `{ ok, findings, contentDigest?, capabilityDigest? }`; never throws on content, writes nothing.
 */
function checkPackage(dir: string, options: any = {}): any {
  const { fsImpl = fs, repoRoot = REPO_ROOT } = options;
  const loaded = options.pointsRegistry ? { ok: true, registry: options.pointsRegistry } : loadPoints({ repoRoot });
  if (!loaded.ok) {
    return { ok: false, findings: [{ package: null, field: 'points', code: 'state-unreadable', severity: 'error', message: (loaded as any).errors.join('; '), allowed: 'a readable point registry' }] };
  }
  const pointsRegistry = loaded.registry;
  const fail = (code: string, message: string, allowed: string) => ({
    ok: false, findings: [{ package: null, field: MANIFEST_FILE, code, severity: 'error', message, allowed }],
  });
  let text: string;
  let walked: { files: any[]; findings: any[] };
  try {
    if (!fsImpl.statSync(dir).isDirectory()) return fail('file-missing', `${dir} is not a directory`, 'a package directory');
    walked = walkTree(dir, pointsRegistry.limits, { fsImpl });
    const manifestFile = walked.files.find((f: any) => f.rel === MANIFEST_FILE);
    if (!manifestFile) return { ok: false, findings: [...walked.findings, { package: null, field: MANIFEST_FILE, code: 'file-missing', severity: 'error', message: `${MANIFEST_FILE} is missing`, allowed: `a ${MANIFEST_FILE} at the package root` }] };
    if (manifestFile.size > MANIFEST_MAX_BYTES) return { ok: false, findings: [...walked.findings, { package: null, field: MANIFEST_FILE, code: 'too-large', severity: 'error', message: `the manifest is larger than ${MANIFEST_MAX_BYTES} bytes`, allowed: `at most ${MANIFEST_MAX_BYTES} bytes` }] };
    text = fsImpl.readFileSync(manifestFile.abs, 'utf8');
  } catch (error: any) {
    return fail('file-missing', `cannot read ${dir}: ${error.message}`, 'a readable package directory');
  }
  const findings = checkManifest(text, { ...options, pointsRegistry, root: dir });
  let id: string | null = null;
  try { id = JSON.parse(text)?.id ?? null; } catch { /* checkManifest reported it */ }
  for (const finding of walked.findings) findings.push({ ...finding, package: typeof id === 'string' ? id : null });
  const ok = !findings.some((f) => f.severity === 'error');
  const result: any = { ok, findings };
  if (ok) {
    const manifest = JSON.parse(text);
    const tiers = Object.fromEntries(pointsRegistry.points.map((p: any) => [p.id, p.tier]));
    result.contentDigest = digestFiles(walked.files, fsImpl);
    result.capabilityDigest = capabilityDigest(manifest, { trustPolicyVersion: pointsRegistry.trustPolicyVersion, tiers });
  }
  return result;
}

module.exports = { checkManifest, checkPackage, judgePackagePreset, coreAgents, MANIFEST_FILE, MANIFEST_MAX_BYTES };

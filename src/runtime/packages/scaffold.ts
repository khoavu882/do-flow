'use strict';

// IC-025: authored source lives under package/, never in an install ledger or package store.
// .staging- siblings older than 24 hours are removed by the scaffold itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { isPackageId, isReservedPackageId, isLocalId, qualifiedId, projectedName } = require('../../helper/package-ids.ts');
const { parseSemVer } = require('../../helper/semver.ts');
const { loadPoints, templateFindings, POINTS_FILE } = require('./points.ts');
const { checkPackage, MANIFEST_FILE } = require('./manifest.ts');
const { detectedProjectRoot } = require('./grants.ts');
const { hostVersion } = require('./view.ts');
const { packagePaths } = require('./store.ts');
const { configHome } = require('../config-home.ts');
const { readLock, lockPackages } = require('../../state/lockfile.ts');
const { SEGMENT } = require('./digest.ts');

const TIERS = ['inert', 'instruction', 'executable'];
const STAGING = /^\.staging-[a-z0-9-]+-[0-9a-f]{8}$/;
const DAY = 24 * 3600000;

function stat(file: string, fsImpl: any): any {
  try { return fsImpl.lstatSync(file); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Resolve existing ancestors, retaining the not-yet-created suffix. A dangling link refuses resolution. */
function realTarget(file: string, fsImpl: any): string {
  const absolute = path.resolve(file);
  if (stat(absolute, fsImpl)) return fsImpl.realpathSync(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error(`cannot resolve ${absolute}`);
  return path.join(realTarget(parent, fsImpl), path.basename(absolute));
}

function within(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

const commandArg = (value: string): string =>
  /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

function nextSteps(id: string, dir: string, tierMax: string, grantsPath: string | null): any[] {
  const target = commandArg(dir);
  const next = [
    { step: 'edit', command: null, note: `write the content of the listed stub files and the README's "What and why"; edit only files under ${dir}; from /do, this is /do-implement standalone with task id package-${id}` },
    { step: 'check', command: `doflow package --action check --path ${target}`, note: 'repeat until clean' },
    { step: 'add', command: `doflow package --action add --source ${target}`, note: 'writes a plan only; shows the inventory, the projection bytes and the grant lines' },
    { step: 'apply', command: 'doflow package --action add --plan <planId>', note: "installing a package is on the person's ask-first list; ask before running it, and in a headless run stop here and print this line" },
    { step: 'enable', command: `doflow package --action enable --id ${id}`, note: 'an inert package is then active' },
  ];
  if (tierMax !== 'inert') {
    next.push({
      step: 'trust', command: `doflow package --action trust --id ${id}`,
      note: grantsPath === null
        ? 'there is no config home, so no grant can exist; never append a trust line from a model session'
        : `prints the line a person appends to ${grantsPath}; never append it from a model session`,
    });
  }
  next.push({
    step: 'iterate', command: null,
    note: `edit, check, update --id ${id}, update --plan <planId>; above inert, every applied change of content needs a new trust line; DoFlow does not follow the folder`,
  });
  return next;
}

function ignoredByGit(target: string, fsImpl: any, env: any): boolean | null {
  const parent = path.dirname(target);
  let found = false;
  for (let dir = parent; ; dir = path.dirname(dir)) {
    try { if (stat(path.join(dir, '.git'), fsImpl)) { found = true; break; } } catch { return null; }
    if (path.dirname(dir) === dir) break;
  }
  if (!found) return null;
  try {
    const result = spawnSync('git', ['check-ignore', '-q', target], {
      shell: false, cwd: parent, env, encoding: 'utf8', timeout: 4000,
    });
    return result.status === 0 ? true : result.status === 1 ? false : null;
  } catch { return null; }
}

/** Create only the authored tree and its staging sibling; rendering and telemetry belong to command.ts. */
function scaffoldPackage({
  id, points, dir, cwd = process.cwd(), homeDir = os.homedir(), env = process.env,
  repoRoot = REPO_ROOT, now = Date.now(), fsImpl = fs, grantsPath = null,
}: any = {}): any {
  const finding = (field: string, code: string, message: string, allowed: any, severity = 'error'): any =>
    ({ package: typeof id === 'string' ? id : null, field, code, severity, message, allowed });
  const refuse = (code: string, field: string, message: string, allowed: any, findings: any[] = []): any =>
    ({ ok: false, error: code, findings: [finding(field, code, message, allowed), ...findings] });

  let staging: string | null = null;
  try {
    const loaded = loadPoints({ repoRoot, fsImpl });
    if (!loaded.ok) {
      // The loader requires template keys. Preserve new's more specific refusal for an absent key.
      try {
        const raw = JSON.parse(fsImpl.readFileSync(path.join(repoRoot, POINTS_FILE), 'utf8'));
        const requested = typeof points === 'string' ? points.split(',').map((s: string) => s.split(':')[0]) : [];
        const missing = raw.points?.find((p: any) => requested.includes(p.id) && p.status === 'open' && !p.template);
        if (missing) return refuse('template-missing', 'points', `point '${missing.id}' names no template`, 'an open point with a template');
      } catch { /* report the registry errors below */ }
      return refuse('state-unreadable', 'points', loaded.errors.join('; '), 'a valid point registry');
    }
    const registry = loaded.registry;
    const open = registry.points.filter((p: any) => p.status === 'open');
    const available = open.filter((p: any) => p.template).map((p: any) => p.id);
    const usage = (message: string): any => ({
      ...refuse('usage', 'arguments', `${message}; open points with templates: ${available.join(', ')}`, available),
      usage: true,
    });
    if (typeof id !== 'string' || id.length === 0) return usage('new requires --id <id>');
    if (typeof points !== 'string' || points.length === 0) return usage('new requires --points <point[:local],...>');
    if (!isPackageId(id)) return refuse('bad-id', 'id', `package id '${id}' breaks the grammar`, 'an IC-003 package id');
    if (isReservedPackageId(id)) return refuse('reserved-id', 'id', `package id '${id}' is reserved`, 'an unreserved package id');
    if (dir !== undefined && (typeof dir !== 'string' || dir.length === 0)) return usage('--dir takes a non-empty path');

    const entries = points.split(',');
    if (entries.length > 64) return refuse('bad-type', 'points', '--points accepts at most 64 entries', '1 to 64 entries');
    const selected: any[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const parts = entry.split(':');
      const point = registry.points.find((p: any) => p.id === parts[0]);
      if (!point) return refuse('undeclared-point', 'points', `point '${parts[0]}' is not declared; open points: ${open.map((p: any) => p.id).join(', ')}`, open.map((p: any) => p.id));
      if (point.status !== 'open') return refuse('point-reserved', 'points', `point '${point.id}' is reserved and opens with ${point.opensWith}`, available);
      const local = parts.length === 1 ? (isLocalId(point.id) ? point.id : 'provider') : parts[1];
      if (parts.length > 2 || !isLocalId(local) || !qualifiedId(id, local)) return refuse('bad-id', 'points', `invalid local id in '${entry}'`, 'point[:local] with an IC-003 local id');
      const key = `${point.id}:${local}`;
      if (seen.has(key)) return refuse('bad-id', 'points', `duplicate contribution '${key}'`, 'unique (point, local id) pairs');
      seen.add(key);
      if (!point.template) return refuse('template-missing', 'points', `point '${point.id}' names no template`, available);
      selected.push({ point, local, version: Math.max(...point.versions) });
    }

    const projectRoot = detectedProjectRoot({ cwd, homeDir, fsImpl });
    if (dir === undefined && projectRoot === null) return usage('no project root was detected; supply --dir <path>');
    const target = dir === undefined ? path.join(projectRoot, '.doflow', 'package', id) : path.resolve(cwd, dir);
    let real: string;
    const forbidden = (): boolean => {
      real = realTarget(target, fsImpl);
      const config = configHome(env).dir;
      const roots = [packagePaths(homeDir).base, repoRoot, REPO_ROOT, ...(config === null ? [] : [config])];
      return roots.some((root: string) => within(real, realTarget(root, fsImpl)))
        || `${real}${path.sep}`.includes(`${path.sep}.doflow${path.sep}state${path.sep}`);
    };
    try {
      if (forbidden()) return refuse('target-forbidden', 'dir', `target is inside protected storage: ${target}`, 'an authored source directory outside protected storage');
    } catch (error: any) {
      return refuse('target-forbidden', 'dir', `cannot resolve target safely: ${error.message}`, 'a resolvable target');
    }
    const originalReal = real!;
    const nonempty = (): boolean => {
      const info = stat(target, fsImpl);
      return !!info && (!info.isDirectory() || info.isSymbolicLink() || fsImpl.readdirSync(target).length !== 0);
    };
    if (nonempty()) return refuse('target-not-empty', 'dir', `target is not an empty directory: ${target}`, 'a missing or empty directory');

    const defects = templateFindings({
      registry: { ...registry, points: selected.map((s: any) => s.point) }, repoRoot, fsImpl,
    });
    if (defects.length > 0) return refuse('template-invalid', 'templates', 'the selected templates are invalid', 'valid core templates', defects);
    const host = hostVersion(repoRoot);
    const parsed = typeof host === 'string' ? parseSemVer(host) : null;
    if (!parsed) return refuse('host-incompatible', 'doflow', 'the running DoFlow version cannot be read', 'a running semver version');

    const warnings: any[] = [];
    const rows = lockPackages(readLock({ scope: 'global', homeDir }, { fsImpl }));
    if (rows.some((row: any) => row.id === id)) warnings.push(finding('id', 'collision-package', `package '${id}' is already recorded`, 'use update to apply edited source', 'warning'));

    const tierMax = selected.reduce((top: string, s: any) => TIERS.indexOf(s.point.tier) > TIERS.indexOf(top) ? s.point.tier : top, 'inert');
    const next = nextSteps(id, target, tierMax, grantsPath);
    const substitutions = (local: string): Record<string, string> => ({
      package: id, local, qualified: qualifiedId(id, local) ?? '', projected: projectedName(qualifiedId(id, local) ?? '') ?? '',
      version: '0.1.0', host,
    });
    const replace = (text: string, values: Record<string, string>): string => {
      const result = text.replace(/\{\{([^{}]*)\}\}/g, (match: string, name: string) => {
        if (!Object.hasOwn(values, name)) throw new Error(`unknown template placeholder ${match}`);
        return values[name];
      });
      if (result.includes('{{')) throw new Error('unclosed template placeholder');
      return result;
    };
    const files = new Map<string, { text: string; mode: number }>();
    const put = (relative: string, text: string, mode = 0o644): void => {
      if (relative.includes('\\') || relative.split('/').some((part: string) => !SEGMENT.test(part))
        || relative.length > registry.limits.pathLength) throw new Error(`invalid template output path ${relative}`);
      if (files.has(relative)) throw new Error(`templates write the same file: ${relative}`);
      files.set(relative, { text, mode });
    };
    const programs: any[] = [];
    const contributions: any[] = [];
    const inventory: any[] = [];
    for (const { point, local, version } of selected) {
      const base = path.join(repoRoot, 'core', 'registry', point.template);
      const values = substitutions(local);
      const template = JSON.parse(replace(fsImpl.readFileSync(path.join(base, 'template.json'), 'utf8'), values));
      const contribution: any = { point: point.id, version, id: local, [point.entry]: template.path };
      if (point.tier === 'executable') {
        programs.push(...template.programs);
        contribution.programs = template.programs.map((p: any) => p.id);
      }
      contributions.push(contribution);
      inventory.push({ point: point.id, version, qualifiedId: qualifiedId(id, local), tier: point.tier, [point.entry]: template.path });
      const copy = (source: string, relative = ''): void => {
        for (const name of fsImpl.readdirSync(source).sort()) {
          const abs = path.join(source, name);
          const info = fsImpl.lstatSync(abs);
          const rel = relative ? `${relative}/${name}` : name;
          if (info.isSymbolicLink()) throw new Error(`template symlink: ${abs}`);
          if (info.isDirectory()) copy(abs, rel);
          else if (info.isFile()) put(
            point.entry === 'file' ? template.path : `${template.path}/${replace(rel, values)}`,
            replace(fsImpl.readFileSync(abs, 'utf8'), values), info.mode & 0o111 ? 0o755 : 0o644,
          );
          else throw new Error(`template special file: ${abs}`);
        }
      };
      copy(path.join(base, 'files'));
    }
    const manifest = {
      manifest: 1, id, version: '0.1.0', doflow: `>=${host} <${BigInt(parsed.major) + 1n}.0.0`,
      ...(programs.length ? { programs } : {}), contributions,
    };
    put(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
    put('README.md', replace(fsImpl.readFileSync(path.join(repoRoot, 'core', 'registry', 'package-templates', 'README.md'), 'utf8'), {
      ...substitutions(id),
      contributions: inventory.map((c: any) => `- ${c.point} ${c.qualifiedId} ${c.tier} ${c.file ?? c.dir}`).join('\n'),
      next: next.map((n: any) => `${n.step}: ${n.command ? `${n.command}; ` : ''}${n.note}`).join('\n'),
    }));

    const parent = path.dirname(target);
    fsImpl.mkdirSync(parent, { recursive: true });
    for (const name of fsImpl.readdirSync(parent)) {
      const sibling = path.join(parent, name);
      if (!STAGING.test(name) || sibling === target) continue;
      const info = fsImpl.lstatSync(sibling);
      if (info.isDirectory() && !info.isSymbolicLink() && now - info.mtimeMs > DAY) fsImpl.rmSync(sibling, { recursive: true, force: true });
    }
    staging = path.join(parent, `.staging-${id}-${randomBytes(4).toString('hex')}`);
    fsImpl.mkdirSync(staging);
    for (const [relative, file] of files) {
      const output = path.join(staging, ...relative.split('/'));
      fsImpl.mkdirSync(path.dirname(output), { recursive: true });
      fsImpl.writeFileSync(output, file.text, { flag: 'wx', mode: file.mode });
    }
    const checked = checkPackage(staging, { repoRoot, pointsRegistry: registry, hostVersion: host, bundled: [], fsImpl });
    if (!checked.ok) return refuse('template-invalid', 'templates', 'the staged scaffold failed package check', 'a clean staged package', checked.findings);
    if (forbidden() || real! !== originalReal) return refuse('target-forbidden', 'dir', 'target ancestry changed during scaffolding', 'the original safe target');
    if (nonempty()) return refuse('target-not-empty', 'dir', `target became non-empty: ${target}`, 'a missing or empty directory');
    if (stat(target, fsImpl)) fsImpl.rmdirSync(target);
    try { fsImpl.renameSync(staging, target); }
    catch (error: any) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) return refuse('target-not-empty', 'dir', `target became non-empty: ${target}`, 'a missing or empty directory');
      throw error;
    }
    staging = null;
    return {
      ok: true, id, dir: target, files: [...files.keys()].sort(), contributions: inventory, tierMax,
      contentDigest: checked.contentDigest, capabilityDigest: checked.capabilityDigest,
      ignoredByGit: ignoredByGit(target, fsImpl, env), findings: [...warnings, ...checked.findings], next,
    };
  } catch (error: any) {
    return refuse('template-invalid', 'templates', error.message || String(error), 'a readable, valid scaffold template and writable target');
  } finally {
    if (staging !== null) fsImpl.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { scaffoldPackage };

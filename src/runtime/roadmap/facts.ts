'use strict';

/**
 * Git facts gathering for roadmap loop (feature 108, IC-003, IC-004; FR-002).
 * Reads only — executes allowed git read verbs via execFileSync, without side effects.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parsePlan } = require('../scaffold/artifacts.ts');
const { planVerdict } = require('../task-graph.ts');
const { CapabilityRouter } = require('../capability-router.ts');
const { deriveStatus, check } = require('./rows.ts');
const { validateFindings } = require('./gates.ts');
const defaultExecFileSync = execFileSync;

interface GitMergeInfo {
  sha: string;
  parents: string[];
  rowTrailer: string | null;
}

interface GatheredGitFacts {
  developHead: string;
  merges: GitMergeInfo[];
  branches: string[];
  unreadable: string[];
}

function sha256Digest(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function qualifiedBranch(name: string): string {
  return name.startsWith('refs/') ? name : `refs/heads/${name}`;
}

/**
 * Gathers git facts for roadmap status derivation and checking.
 * Uses only allowed read verbs: rev-list, rev-parse, for-each-ref.
 */
function gatherGitFacts({
  root,
  developBranch = 'develop',
  developHead: knownDevelopHead,
}: {
  root: string;
  developBranch?: string;
  /** The tip of `developBranch` the caller read a moment ago with nothing moving it since; saves one read. */
  developHead?: string;
}): GatheredGitFacts {
  const execOptions = {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  };

  const unreadable: string[] = [];
  let developHead = '';
  let developBranchReadable = false;

  // Always the branch: an unqualified name resolves a tag of the same name first.
  const developRef = qualifiedBranch(developBranch);
  try {
    developHead = knownDevelopHead && /^[0-9a-f]{40}$/.test(knownDevelopHead) ? knownDevelopHead
      : execFileSync('git', ['-C', root, 'rev-parse', '--verify', developRef], execOptions).trim();
    developBranchReadable = true;
  } catch {
    unreadable.push('develop-branch');
  }

  // 1. Read first-parent merges on developBranch
  const merges: GitMergeInfo[] = [];
  if (developBranchReadable) {
    try {
      const revListOut = execFileSync('git', [
        '-C',
        root,
        'rev-list',
        '--no-commit-header',
        '--first-parent',
        '--merges',
        '--format=%H %P%x00%(trailers:key=DoFlow-Row,valueonly)',
        developRef,
      ], execOptions);

      const lines = revListOut.split('\n');
      let currentRecord: GitMergeInfo | null = null;

      for (const rawLine of lines) {
        if (/^[0-9a-f]{40}( |\0|$)/.test(rawLine)) {
          const nulIdx = rawLine.indexOf('\0');
          let commitPart = rawLine;
          let trailerPart = '';
          if (nulIdx !== -1) {
            commitPart = rawLine.slice(0, nulIdx);
            trailerPart = rawLine.slice(nulIdx + 1);
          }
          const parts = commitPart.trim().split(/\s+/);
          const sha = parts[0];
          const parents = parts.slice(1);
          currentRecord = {
            sha,
            parents,
            rowTrailer: trailerPart.trim() || null,
          };
          merges.push(currentRecord);
        } else if (currentRecord) {
          const continuation = rawLine.trim();
          if (continuation) {
            if (currentRecord.rowTrailer) {
              currentRecord.rowTrailer = `${currentRecord.rowTrailer}\n${continuation}`;
            } else {
              currentRecord.rowTrailer = continuation;
            }
          }
        }
      }
    } catch {
      unreadable.push('merges');
    }
  }

  // 2. Read local branch names
  const branches: string[] = [];
  try {
    const branchesOut = execFileSync('git', [
      '-C',
      root,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/',
    ], execOptions);
    for (const rawBranch of branchesOut.split('\n')) {
      const b = rawBranch.trim();
      if (b) branches.push(b);
    }
  } catch {
    unreadable.push('branches');
  }

  return {
    developHead,
    merges,
    branches,
    unreadable,
  };
}

/** CommonMark fences and exact-length backtick spans; unmatched spans remain prose. */
function countMarkers(text: string): number {
  const prose: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && /^\s*$/.test(match[2])) fence = null;
      // Keep a block boundary: inline spans cannot cross a fenced block.
      prose.push('\0');
    } else if (match && (match[1][0] !== '`' || !match[2].includes('`'))) {
      fence = { char: match[1][0], length: match[1].length };
      prose.push('\0');
    } else prose.push(line);
  }
  const visible = prose.join('\n');
  let count = 0;
  for (let i = 0; i < visible.length;) {
    if (visible[i] === '\\' && visible[i + 1] === '`') { i += 2; continue; }
    if (visible[i] === '`') {
      let end = i;
      while (visible[end] === '`') end++;
      const length = end - i;
      let cursor = end;
      let closing = -1;
      while (cursor < visible.length && visible[cursor] !== '\0') {
        if (visible[cursor] !== '`') { cursor++; continue; }
        let after = cursor;
        while (visible[after] === '`') after++;
        if (after - cursor === length) { closing = after; break; }
        cursor = after;
      }
      i = closing < 0 ? end : closing;
      continue;
    }
    if (visible.startsWith('[NEEDS CLARIFICATION', i)) count++;
    i++;
  }
  return count;
}

interface GateFact {
  name: string;
  value: any;
  locator: string;
  sha256: string;
  unreadable?: string;
}

/**
 * Read only the selected gate's sources. Every derived fact and raw source binds its bytes.
 * root is the feature checkout; mainRoot and registryRoot may point at the main checkout/install.
 * execFileSync/fsImpl are test seams; production uses only literal, allow-listed git vectors.
 */
function gatherGateFacts(options: any): GateFact[] {
  const { root, artifactRoot, gateId, policy, row } = options;
  const fsImpl = options.fsImpl || fs;
  const execFileSync = options.execFileSync || defaultExecFileSync;
  const execOptions = { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] };
  const result: GateFact[] = [];
  const predicates = policy?.classes?.[row?.class || 'feature']?.[gateId]?.predicates || [];
  const uses = (predicate: string) => predicates.includes(predicate);
  const add = (name: string, value: any, locator: string, bytes?: any, unreadable?: string): GateFact => {
    const contentDigest = sha256Digest(bytes === undefined ? JSON.stringify(value) : bytes);
    const fact: GateFact = { name, value, locator,
      sha256: unreadable ? sha256Digest(JSON.stringify({ unreadable, contentDigest })) : contentDigest };
    if (unreadable) fact.unreadable = unreadable;
    result.push(fact);
    return fact;
  };
  const failure = (error: any) => String(error?.code || 'unreadable');
  const read = (candidates: string[]): any => {
    for (const file of candidates) {
      try { const bytes = fsImpl.readFileSync(file); return { locator: file, bytes, text: String(bytes) }; }
      catch (error: any) {
        if (error?.code !== 'ENOENT') return { locator: file, bytes: '', unreadable: failure(error) };
      }
    }
    return { locator: candidates[0], bytes: '', unreadable: 'ENOENT' };
  };
  const source = (name: string, input: any) => add(`source:${name}`, null, input.locator, input.bytes, input.unreadable);
  add('row', row || null, `${options.mainRoot || root}/agent-docs/roadmap/rows.json#${row?.id || 'unknown'}`);
  if (!row) return result;

  let plan: any = null;
  if (uses('plan-parses') || uses('plan-within-write-set') || (uses('protected-paths') && gateId === 'gate-a')) {
    const input = read([path.join(artifactRoot, 'plan.md'), path.join(artifactRoot, 'planning/plan.md')]);
    let value: any = { ok: false, files: [] };
    if (!input.unreadable) {
      try {
        const parsed = parsePlan(input.text);
        value = { ok: planVerdict(input.text).ok, files: parsed.tasks.flatMap((task: any) => task.files) };
      } catch { /* The plan-parses predicate denies; no guessed tasks. */ }
    }
    plan = add('plan', value, input.locator, input.bytes, input.unreadable);
  }
  if (uses('plan-verification-absent')) {
    // C6: a `doflow-verification` block replaces the verify commands, so its presence (even a
    // malformed one) is the fact. No plan at all is absent; any other read failure is unreadable.
    const input = read([path.join(artifactRoot, 'plan.md'), path.join(artifactRoot, 'planning/plan.md')]);
    const absent = input.unreadable === 'ENOENT';
    let present: boolean | null = absent ? false : null;
    if (!input.unreadable) {
      const { parsePlanOverride } = require('../command-detect.ts');
      present = ((r: any) => r.override !== null || r.errors.length > 0)(parsePlanOverride(input.text));
    }
    add('plan-verification-block', { present }, input.locator, input.bytes, absent ? undefined : input.unreadable);
  }
  for (const artifact of ['requirement', 'design', 'plan']) {
    if (!uses(`markers-zero:${artifact}`)) continue;
    const candidates = artifact === 'requirement' ? ['intention/requirement.md', 'requirement.md']
      : artifact === 'design' ? ['design/design.md', 'design.md'] : ['plan.md', 'planning/plan.md'];
    const input = read(candidates.map((entry) => path.join(artifactRoot, entry)));
    add(`markers:${artifact}`, input.unreadable ? null : countMarkers(input.text), input.locator, input.bytes, input.unreadable);
  }

  let developHead = options.developHead;
  let featureHead = options.featureHead;
  if (uses('protected-paths') || uses('verify-pass-on-head') || uses('findings-valid') || uses('dispositions-backed')) {
    let unreadable: string | undefined;
    try {
      if (!developHead) developHead = execFileSync('git', ['rev-parse', '--verify', qualifiedBranch(options.developBranch || 'develop')], execOptions).trim();
      if (!featureHead) {
        // The calling checkout's HEAD may be develop itself (a diff of develop against develop is
        // empty), so the head is only ever the feature branch's tip.
        const branch = options.featureBranch || (row.slug ? `feat/${row.slug}` : null);
        try {
          if (!branch) throw new Error('no feature branch');
          featureHead = execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], execOptions).trim();
        } catch { throw Object.assign(new Error('no feature branch'), { code: 'no-feature-branch' }); }
      }
      if (!/^[0-9a-f]{40}$/.test(developHead) || !/^[0-9a-f]{40}$/.test(featureHead)) unreadable = 'invalid-head';
    } catch (error: any) { unreadable = failure(error); }
    add('heads', { developHead: developHead || null, featureHead: featureHead || null }, `${root}#heads`, undefined, unreadable);
  }

  if (uses('protected-paths')) {
    const locator = `${root}#diff:${developHead}...${featureHead}`;
    const changes: any[] = [];
    const packages: any = {};
    let unreadable: string | undefined;
    try {
      const text = execFileSync('git', ['diff', '--name-status', '-z', `${developHead}...${featureHead}`, '--'], execOptions);
      add('source:diff', null, locator, text);
      const fields = text.split('\0');
      if (fields[fields.length - 1] === '') fields.pop();
      for (let i = 0; i < fields.length;) {
        const status = fields[i++];
        if (!/^(?:[ADMTUXB]|[RC][0-9]{1,3})$/.test(status) || !fields[i]) throw new Error('invalid diff');
        if (/^[RC]/.test(status)) {
          const oldPath = fields[i++];
          const file = fields[i++];
          if (!file) throw new Error('invalid rename');
          changes.push({ status, oldPath, path: file });
        } else changes.push({ status, path: fields[i++] });
      }
      const base = execFileSync('git', ['show', `${developHead}:package.json`], execOptions);
      add('source:package-base', null, `${root}#${developHead}:package.json`, base);
      const head = execFileSync('git', ['show', `${featureHead}:package.json`], execOptions);
      add('source:package-head', null, `${root}#${featureHead}:package.json`, head);
      packages.base = JSON.parse(base);
      packages.head = JSON.parse(head);
    } catch (error: any) { unreadable = failure(error); }
    const addedGuards: string[] = [];
    if (gateId === 'gate-a' && !unreadable) {
      for (const file of [...(row.writeSet || []), ...(plan?.value.files || [])]) {
        if (!file.startsWith(policy.protected.guardDir) || file.endsWith('/')) continue;
        if (changes.some((change) => change.path === file)) continue;
        // A missing guard at the base is a planned addition; status 1/128 is only accepted after
        // a readable tree listing proves absence, never by treating a failed command as absence.
        try {
          const listed = execFileSync('git', ['ls-files', '--with-tree', developHead, '-z', '--', file], execOptions);
          add(`source:guard:${file}`, null, `${root}#${developHead}:${file}`, listed);
          if (!listed.split('\0').includes(file)) addedGuards.push(file);
        } catch (error: any) { unreadable = failure(error); }
      }
    }
    add('protected-paths', { changes, packages, writeSet: row.writeSet || [], planFiles: plan?.value.files || [], addedGuards }, locator, undefined, unreadable);
  }

  if (uses('needs-merged')) {
    const gathered = options.gitFacts || gatherGitFacts({ root: options.mainRoot || root, developBranch: options.developBranch || 'develop' });
    const unreadable = gathered.unreadable || [];
    const declaredRows = options.rows || [row];
    const statuses = deriveStatus(declaredRows, gathered);
    const integrity = check({ rows: declaredRows, gitFacts: gathered });
    add('needs', (row.needs || []).map((id: string) => ({ id, status: integrity.offendingRowIds.includes(id) ? 'not-started' : statuses.rowStatus[id] || 'not-started' })),
      `${options.mainRoot || root}#develop:${unreadable.length ? unreadable.join(',') : 'merges'}`,
      JSON.stringify(gathered), unreadable.length ? `unreadable:${unreadable.join(',')}` : undefined);
  }

  if (uses('requires-reachable')) {
    const registryRoot = options.registryRoot || path.resolve(__dirname, '../../..');
    const input = read([path.join(registryRoot, 'core/registry/capabilities.json')]);
    const values: any[] = [];
    let unreadable = input.unreadable;
    const env = options.env || process.env;
    const binaryChecker = (binary: string): boolean => {
      const candidates = binary.includes('/') || binary.includes('\\') ? [path.resolve(root, binary)]
        : String(env.PATH || '').split(path.delimiter).filter(Boolean).flatMap((dir: string) => {
          const suffixes = process.platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
          return suffixes.map((suffix: string) => path.join(dir, `${binary}${suffix}`));
        });
      return candidates.some((file: string) => {
        try { fsImpl.accessSync(file, fs.constants.X_OK); return fsImpl.statSync(file).isFile(); } catch { return false; }
      });
    };
    if (!unreadable) {
      try {
        const capabilities = JSON.parse(input.text).capabilities;
        if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw new Error('invalid capabilities');
        const router = new CapabilityRouter({ repoRoot: registryRoot, projectRoot: root, fsImpl, capabilities, routes: {}, binaryChecker });
        for (const id of row.requires || []) {
          const declared = Object.hasOwn(capabilities, id);
          const resolved = declared ? router.resolveCapability(id, { deepCheck: false }) : null;
          values.push({ id, declared, reachable: Boolean(resolved?.provider && resolved.status === 'HEALTHY'), provider: resolved?.provider?.id || null });
        }
      } catch (error: any) { unreadable = failure(error); }
    }
    source('capabilities', input);
    add('requires', values, `${input.locator}#requires`, undefined, unreadable);
  }

  if (uses('verify-pass-on-head')) {
    // The record lives where `verify --action report` appends it (IC-007), not in the feature checkout.
    const { verificationRunsRoot, verificationRunRecordFile } = require('../verification/engine.ts');
    const input = read([verificationRunRecordFile(verificationRunsRoot(root), row.slug)]);
    let records: any[] = [];
    let unreadable = input.unreadable === 'ENOENT' ? undefined : input.unreadable;
    if (!input.unreadable) {
      try {
        records = input.text.split('\n').filter((line: string) => line.trim()).map((line: string) => JSON.parse(line));
        if (records.some((record: any) => !record || typeof record !== 'object' || Array.isArray(record))) throw new Error('invalid run');
      } catch { unreadable = 'invalid-jsonl'; }
    }
    add('verification', records, input.locator, input.bytes, unreadable);
  }

  let findings: any = null;
  let sameFamily: 'warn' | 'refuse' = 'warn';
  let preset = 'auto';
  let authors: any[] = [];
  if (predicates.some((predicate: string) => ['findings-valid', 'no-dropped-findings', 'dispositions-backed', 'blockers-zero'].includes(predicate))) {
    // The project's `review.sameFamily` (119 L-D3a) and `review.preset` (C-2), read once; the gate judges the fact, never the settings.
    let settingsLocator = `${root}/.doflow/settings.json#review.sameFamily`;
    let settingsUnreadable: string | undefined;
    try {
      const settings = require('../settings/resolve.ts').loadSettings({ projectRoot: root, env: options.env || process.env, fsImpl });
      const resolved = settings.get('review.sameFamily');
      if (resolved.value === 'refuse') sameFamily = 'refuse';
      // C-2: the project's `review.preset` is the floor gate-b holds the recorded protocol to (`auto` needs the diff).
      if (typeof settings.get('review.preset').value === 'string') preset = settings.get('review.preset').value;
      if (resolved.origin?.layer !== 'default' && typeof resolved.origin?.source === 'string') settingsLocator = resolved.origin.source;
      // C-6: an invalid project or local candidate silently falls back to the default, so the fact is unreadable.
      const findingsLib = require('../review/findings.ts');
      const invalid = findingsLib.invalidProjectCandidate(settings.get('review.sameFamily')) ?? findingsLib.invalidPresetCandidate(settings.get('review.preset'));
      if (invalid) { settingsLocator = invalid.source; settingsUnreadable = 'settings-unavailable'; }
    } catch { settingsUnreadable = 'settings-unavailable'; }
    add('review-settings', { sameFamily, preset }, settingsLocator, undefined, settingsUnreadable);

    // 120 D.4: authoring-identities fact
    let authorsLocator = `${root}/.doflow/state/dispatch/${row.slug}.json`;
    let authorsUnreadable: string | undefined;
    try {
      const { authoringIdentities } = require('../review/identity.ts');
      const { storeFileFor, readDispatch } = require('../dispatch/store.ts');
      const { projectRoot } = require('../lifecycle/root.ts');
      const pRoot = projectRoot(root);
      authorsLocator = storeFileFor(pRoot, row.slug);
      if (fsImpl.existsSync(authorsLocator)) {
        readDispatch(authorsLocator, fsImpl);
      }
      authors = authoringIdentities({
        slug: row.slug,
        cwd: root,
        env: options.env || process.env,
        fsImpl,
      });
    } catch {
      authorsUnreadable = 'dispatch-unreadable';
    }
    add('authoring-identities', authors, authorsLocator, undefined, authorsUnreadable);

    const input = read([path.join(artifactRoot, 'review/findings.json')]);
    if (!input.unreadable) {
      try { findings = JSON.parse(input.text); } catch { findings = input.text; }
    }
    add('findings', findings, input.locator, input.bytes, input.unreadable === 'ENOENT' ? undefined : input.unreadable);
  }
  if (uses('dispositions-backed')) {
    const ancestors: Record<string, boolean> = {};
    let decisions: any[] = [];
    let unreadable: string | undefined;
    const converged = Array.isArray(findings?.converged) ? findings.converged : [];
    for (const finding of converged) if (finding?.status === 'fixed' && /^[0-9a-f]{40}$/.test(finding.fixedIn)) {
      try { execFileSync('git', ['merge-base', '--is-ancestor', finding.fixedIn, featureHead], execOptions); ancestors[finding.fixedIn] = true; }
      catch (error: any) {
        ancestors[finding.fixedIn] = false;
        if (error?.status !== 1) unreadable = `${failure(error)}:ancestor:${finding.fixedIn}`;
      }
      add(`source:ancestor:${finding.fixedIn}`, ancestors[finding.fixedIn], `${root}#ancestor:${finding.fixedIn}:${featureHead}`);
    }
    if (converged.some((finding: any) => finding?.status === 'user-accepted')) {
      const input = read([path.join(artifactRoot, 'decisions/register.json')]);
      source('decisions', input);
      // A register not created yet holds no decisions; any other read or parse failure is unreadable.
      if (input.unreadable === 'ENOENT') decisions = [];
      else if (input.unreadable) unreadable = `${input.unreadable}:${input.locator}`;
      else {
        try {
          const register = JSON.parse(input.text);
          if (register.version !== 1 || !Array.isArray(register.decisions) || !Number.isInteger(register.nextId)) throw new Error('invalid register');
          decisions = register.decisions;
        } catch { unreadable = `invalid-register:${input.locator}`; }
      }
    }
    // The schema validator is deliberately pure and shared by gathering and gate evaluation.
    add('dispositions', { ancestors, decisions, schemaValid: validateFindings(findings, { sameFamily, preset, authors }).ok }, `${artifactRoot}/review/findings.json#dispositions`, undefined, unreadable);
  }
  return result;
}

module.exports = {
  gatherGitFacts,
  sha256Digest,
  countMarkers,
  gatherGateFacts,
};

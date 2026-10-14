'use strict';

// Session identity reader (078 IC-007). Run directly by Node native type-stripping.
//
// The TypeScript twin of `policies/identity.sh`: both read the launcher-set environment the same
// way, and test/fixtures/identity/cases.json is the corpus both must agree on (G38.6). Identity
// comes only from DOFLOW_RUN_ID, DOFLOW_ATTEMPT, DOFLOW_LINEAGE_ID, DOFLOW_SESSION_ROLE and
// DOFLOW_WORKTREE plus the payload's session_id and cwd; it is never inferred from git or from the
// harness's own idea of a main session.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** DEC-024: a launched unit id `L.<run>.<lineage>.<attempt>` stays inside the 128-character session-dirs match. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/;
const ATTEMPT_PATTERN = /^[1-9][0-9]{0,3}$/;
const DEFAULT_RUN = 'local';
const UNKNOWN_ROLE_LINE = '[doflow] unknown DOFLOW_SESSION_ROLE; treating session as worker\n';

type Env = Record<string, string | undefined>;
type Role = 'main' | 'worker';
type LineageKind = 'launched' | 'default-main' | 'solo';
type Diagnostic = 'role-unknown' | 'identity-invalid' | 'identity-inherited';

interface SessionIdentity {
  run: string;
  attempt: string;
  lineage: string;
  role: Role;
  worktree: string;
  lineageKind: LineageKind;
  unitId: string;
  session: string;
  diagnostics: Diagnostic[];
}

interface ResolveOptions {
  cwd: string;
  sessionId: string;
  bind?: boolean;
  warn?: (line: string) => void;
}

let roleWarned = false;

/** `${XDG_CONFIG_HOME:-$HOME/.config}/doflow/session-env`, the root `policies/lib.sh` names STATE_DIR. */
function stateDir(env: Env = process.env): string {
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(config, 'doflow', 'session-env');
}

/** `(cd "$p" && pwd -P)`: the physical path of an existing directory, or null. */
function physicalDir(p: string): string | null {
  try {
    if (!fs.statSync(p).isDirectory()) return null;
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** `canonicalize_path` from policies/lib.sh: resolve the parent chain of an existing path, never its leaf. */
function canonicalizePath(p: string): string {
  try {
    fs.statSync(p); // `[[ -e ]]` follows symlinks, so a dangling link is "missing"
    const dir = fs.realpathSync.native(path.dirname(p));
    const base = path.basename(p);
    return dir === '/' ? `/${base}` : `${dir}/${base}`;
  } catch {
    return p;
  }
}

/** `cwd_hash` from policies/lib.sh: first 16 hex chars of sha256 over the canonical path plus `echo`'s newline. */
function cwdHash(p: string): string {
  const canonical = physicalDir(p) ?? canonicalizePath(p);
  return crypto.createHash('sha256').update(`${canonical}\n`).digest('hex').slice(0, 16);
}

/** `tr '[:upper:]' '[:lower:]'` on the role, ASCII only, then today's mapping: unset is main, unknown is worker. */
function readRole(raw: string | undefined): { role: Role; unknown: boolean } {
  const role = (raw || '').replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (role === '' || role === 'main') return { role: 'main', unknown: false };
  if (role === 'worker') return { role: 'worker', unknown: false };
  return { role: 'worker', unknown: true };
}

function readWorktree(raw: string | undefined, cwd: string): string {
  if (raw && raw.startsWith('/')) {
    const dir = physicalDir(raw);
    if (dir !== null) return dir;
  }
  return physicalDir(cwd) ?? cwd;
}

/**
 * Create `sessions/<unitId>/bound` exclusively, holding the session id. True when this session owns
 * the unit (just bound, or bound earlier by the same session); false when another session bound it.
 */
function bindUnit(env: Env, unitId: string, sessionId: string): boolean {
  const dir = path.join(stateDir(env), 'sessions', unitId);
  const file = path.join(dir, 'bound');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, `${sessionId}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return fs.readFileSync(file, 'utf8').replace(/\n$/, '') === sessionId;
}

/** IC-007: the session identity from the environment and the payload's session id and cwd. */
function resolveIdentity(env: Env, options: ResolveOptions): SessionIdentity {
  const { cwd, sessionId, bind = false } = options;
  const diagnostics = new Set<Diagnostic>();

  const { role, unknown } = readRole(env.DOFLOW_SESSION_ROLE);
  if (unknown) {
    diagnostics.add('role-unknown');
    if (!roleWarned) {
      roleWarned = true;
      (options.warn ?? ((line: string) => process.stderr.write(line)))(UNKNOWN_ROLE_LINE);
    }
  }

  const rawRun = env.DOFLOW_RUN_ID || '';
  const runValid = rawRun !== '' && rawRun !== DEFAULT_RUN && ID_PATTERN.test(rawRun);
  if (rawRun !== '' && !runValid) diagnostics.add('identity-invalid');
  const run = runValid ? rawRun : DEFAULT_RUN;

  const rawAttempt = env.DOFLOW_ATTEMPT || '';
  const attempt = ATTEMPT_PATTERN.test(rawAttempt) ? rawAttempt : '';

  const rawLineage = env.DOFLOW_LINEAGE_ID || '';
  const lineageValid = rawLineage !== '' && ID_PATTERN.test(rawLineage);
  if (rawLineage !== '' && !lineageValid) diagnostics.add('identity-invalid');
  let lineage: string;
  if (rawRun !== '' && !runValid) lineage = 'solo';
  else if (rawLineage === '') lineage = role === 'main' ? 'main' : 'solo';
  else lineage = lineageValid ? rawLineage : 'solo';

  let lineageKind: LineageKind = 'solo';
  if (runValid && lineageValid && attempt !== '') lineageKind = 'launched';
  else if (run === DEFAULT_RUN && lineage === 'main') lineageKind = 'default-main';

  let unitId = lineageKind === 'launched' ? `L.${run}.${lineage}.${attempt}` : sessionId;
  if (lineageKind === 'launched' && bind && sessionId !== '' && !bindUnit(env, unitId, sessionId)) {
    diagnostics.add('identity-inherited');
    lineageKind = 'solo';
    lineage = 'solo';
    unitId = sessionId;
  }

  return {
    run,
    attempt,
    lineage,
    role,
    worktree: readWorktree(env.DOFLOW_WORKTREE, cwd),
    lineageKind,
    unitId,
    session: sessionId,
    diagnostics: [...diagnostics].sort(),
  };
}

module.exports = { ID_PATTERN, UNKNOWN_ROLE_LINE, cwdHash, resolveIdentity, stateDir };

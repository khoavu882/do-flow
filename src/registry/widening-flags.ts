'use strict';

// 165 review B-2 (FR-015, owner P-2): the flags that widen what a harness may do, as data, and the one matcher
// the registry validator runs on `oneShot.argv` and `mainSession.argv` and the launcher runs again on the final
// argv. Pure and dependency-free, so `src/registry/` and `src/runtime/worker/launch.ts` read one definition.
//
// Entry shapes:
//   { flag: '--x', short?: '-x', values?: [...], mainSessionOnly?: true }  widening as a flag; with `values`, only
//       when its value (`--x v`, `--x=v`, `-x v`, `-xv`, `-x=v`) is one of them (quotes stripped, any case).
//   { prefix: '--x' }                                                       any long flag whose name starts so.
//   { configFlag: '--config', short?: '-c' }                                carries `key=value` config overrides.
//   { config: 'key', values?: [...] }                                       a config key (also as a dotted segment,
//       so `profiles.p.key` and `key.sub` match), widening for any value or for the listed ones.
// A long flag or prefix of any set applies to every binary, a package worker's included; a short form and a
// `configFlag`'s short form apply only to the binary whose set names it (`-a` is codex's approval policy and pi's
// trust switch, `-c` codex's config and pi's continue). `mainSessionOnly` entries are the workspace-trust flags:
// copilot's and kiro's one-shot worker recipes carry them, so they are refused only in a main session.
//
// Ceilings, accepted: a CLI that accepts abbreviated long options (none of these does in its --help) is matched only
// through the prefixes; bundled short flags (`-xs v`) are not split; environment switches (COPILOT_ALLOW_ALL,
// COPILOT_ASSISTED_APPROVAL) are not argv and are not covered; flags that add tools or servers rather than
// permissions (`--mcp-config`, `--plugin-dir`, `--agent`, `--profile`) are not listed.

type Entry = {
  flag?: string; short?: string; values?: readonly string[]; mainSessionOnly?: boolean;
  prefix?: string; configFlag?: string; config?: string;
};
type BinarySet = { evidence: string; entries: readonly Entry[] };

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value as any)) freeze(inner);
    Object.freeze(value);
  }
  return value;
};

/** The flags each built-in CLI documents in its own --help, with the record that matched each line. */
const BINARIES: Record<string, BinarySet> = freeze({
  claude: {
    evidence: 'core/worker-evidence/claude/2026-11-16-cli-check-widening-flags.json',
    entries: [
      { flag: '--dangerously-skip-permissions' }, { flag: '--allow-dangerously-skip-permissions' },
      { flag: '--permission-mode', values: ['acceptEdits', 'auto', 'bypassPermissions'] },
      { flag: '--allowedTools' }, { flag: '--allowed-tools' }, { flag: '--permission-prompt-tool' },
      { flag: '--add-dir' }, { flag: '--settings' },
    ],
  },
  codex: {
    evidence: 'core/worker-evidence/codex/2026-11-16-cli-check-widening-flags.json',
    entries: [
      { configFlag: '--config', short: '-c' }, { config: 'sandbox_permissions' },
      { flag: '--sandbox', short: '-s', values: ['danger-full-access'] },
      { flag: '--ask-for-approval', short: '-a', values: ['never'] },
      { flag: '--approve-for-me' }, { flag: '--dangerously-bypass-approvals-and-sandbox' }, { flag: '--dangerously-bypass-hook-trust' },
      { flag: '--add-dir' }, { flag: '--cd', short: '-C' }, { flag: '--ignore-user-config' }, { flag: '--ignore-rules' },
      { flag: '--enable' }, { flag: '--search' },
    ],
  },
  opencode: {
    evidence: 'core/worker-evidence/opencode/2026-11-16-cli-check-widening-flags.json',
    entries: [{ flag: '--auto' }],
  },
  pi: {
    evidence: 'core/worker-evidence/pi/2026-11-16-cli-check-widening-flags.json',
    entries: [{ flag: '--approve', short: '-a' }],
  },
  copilot: {
    evidence: 'core/worker-evidence/copilot/2026-11-16-cli-check-widening-flags.json',
    entries: [
      { flag: '--allow-all-tools' }, { flag: '--allow-all-paths' }, { flag: '--allow-all-urls' }, { flag: '--allow-all' },
      { flag: '--allow-tool' }, { flag: '--allow-url' }, { flag: '--yolo' }, { flag: '--add-dir' },
      { flag: '--mode', values: ['autopilot'] }, { flag: '--autopilot' }, { flag: '--assisted-approval' },
      { flag: '--trust-folder', mainSessionOnly: true },
    ],
  },
  agy: {
    evidence: 'core/worker-evidence/antigravity/2026-11-16-cli-check-widening-flags.json',
    entries: [
      { flag: '--dangerously-skip-permissions' }, { flag: '--mode', values: ['accept-edits', 'auto'] },
      { flag: '--add-dir' }, { flag: '--settings' },
    ],
  },
  // kiro-cli is never executed here: its two trust flags are the lines its 2026-11-07 record already matched.
  'kiro-cli': {
    evidence: 'core/worker-evidence/kiro/2026-11-07-cli-check.json',
    entries: [{ flag: '--trust-workspace', mainSessionOnly: true }, { flag: '--trust-tools', mainSessionOnly: true }],
  },
});

/**
 * Not from any --help: the owner's own list (brief B-2: `--full-auto`, the `--dangerously`/`--yolo` families and
 * codex's `sandbox_mode`), the families row 165 already refused, and codex's config keys for its sandbox and
 * approval policy (strings in the codex-cli 0.164.0 binary; its --help shows only `sandbox_permissions`).
 */
const OWNER: readonly Entry[] = freeze([
  { flag: '--full-auto' }, { flag: '--yolo' }, { flag: '--allow-all-tools' },
  { prefix: '--dangerously' }, { prefix: '--yolo' }, { prefix: '--allow-all' }, { prefix: '--add-dir' },
  { configFlag: '--config' },
  { config: 'sandbox_mode', values: ['danger-full-access'] }, { config: 'approval_policy', values: ['never'] },
  { config: 'sandbox_workspace_write' },
]);

const WIDENING = freeze({ binaries: BINARIES, owner: OWNER });

const PLACEHOLDER = /^\{[A-Za-z]+\}$/;
const LONG = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const SHORT = /^-[A-Za-z0-9]$/;
const CONFIG_KEY = /^[A-Za-z0-9_-]+$/;
const DECLARED_MAX = 32;

const unquote = (text: string): string => {
  const t = text.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0] ? t.slice(1, -1).trim() : t;
};
const sameValue = (values: readonly string[], value: string): boolean => values.some((v) => v.toLowerCase() === unquote(value).toLowerCase());

/** The entries that apply to `binary`: every long flag, prefix, config key and long config carrier of every set
 * and of the owner's list, plus the short forms of the binary's own set and of `declared`. */
function entriesFor(binary: unknown, declared: readonly Entry[], mainSession: boolean): Entry[] {
  const own = typeof binary === 'string' && Object.hasOwn(BINARIES, binary) ? BINARIES[binary].entries : [];
  const everyLong = Object.values(BINARIES).flatMap((set) => set.entries).map(({ short, ...long }) => long);
  return [...OWNER, ...everyLong, ...own, ...declared].filter((entry) => mainSession || !entry.mainSessionOnly);
}

/** True when `key=value` names a widening config key. */
function configHits(assignment: string, entries: readonly Entry[]): boolean {
  const at = assignment.indexOf('=');
  if (at < 1) return false;
  const segments = assignment.slice(0, at).split('.').map(unquote);
  const value = assignment.slice(at + 1);
  return entries.some((entry) => entry.config !== undefined && segments.includes(entry.config)
    && (entry.values === undefined || sameValue(entry.values, value)));
}

/**
 * The first widening flag in `argv`, as written (`-s danger-full-access` for a two-token hit), or null.
 * `binary` selects the short forms; `declared` is the worker's own `wideningFlags`; `mainSession` adds the trust
 * flags. Placeholders are never flags or values, and `--` does not end the scan.
 */
function wideningProblem(argv: readonly unknown[], { binary, declared = [], mainSession = false }: { binary?: unknown; declared?: readonly Entry[]; mainSession?: boolean } = {}): string | null {
  const entries = entriesFor(binary, Array.isArray(declared) ? declared : [], mainSession);
  const tokens = argv.map((item) => (typeof item === 'string' && !PLACEHOLDER.test(item) ? item : null));
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === null || !token.startsWith('-') || token === '-' || token === '--') continue;
    const next = tokens[i + 1] ?? null;
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);
    const long = token.startsWith('--');
    for (const entry of entries) {
      if (entry.prefix !== undefined && long && name.startsWith(entry.prefix)) return token;
      if (entry.configFlag !== undefined) {
        if (name === entry.configFlag || name === entry.short) {
          const value = inline ?? next;
          if (value !== null && configHits(value, entries)) return inline === null ? `${token} ${value}` : token;
        } else if (!long && entry.short !== undefined && token.length > 2 && token.startsWith(entry.short) && configHits(token.slice(2).replace(/^=/, ''), entries)) {
          return token;
        }
      }
      if (entry.flag === undefined) continue;
      const names = [entry.flag, entry.short].filter((n): n is string => n !== undefined);
      if (names.includes(name)) {
        if (entry.values === undefined) return token;
        const value = inline ?? next;
        if (value !== null && sameValue(entry.values, value)) return inline === null ? `${token} ${value}` : token;
      } else if (!long && entry.short !== undefined && token.length > 2 && token.startsWith(entry.short)) {
        // An attached value (`-sdanger-full-access`, `-s=v`); a short flag widening for any value matches whatever follows it.
        if (entry.values === undefined || sameValue(entry.values, token.slice(2).replace(/^=/, ''))) return token;
      }
    }
  }
  return null;
}

/** A worker block's `wideningFlags`: up to 32 entries of one shape each (above), or the first problem. */
function wideningFlagsProblem(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > DECLARED_MAX) return `must be a list of 1 to ${DECLARED_MAX} entries`;
  for (const [index, entry] of value.entries()) {
    const at = `entry ${index}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `${at} must be an object`;
    const kinds = ['flag', 'prefix', 'config'].filter((key) => Object.hasOwn(entry, key));
    if (kinds.length !== 1) return `${at} must name exactly one of flag, prefix or config`;
    const allowed = kinds[0] === 'prefix' ? ['prefix'] : kinds[0] === 'flag' ? ['flag', 'short', 'values'] : ['config', 'values'];
    const extra = Object.keys(entry).find((key) => !allowed.includes(key));
    if (extra) return `${at} has unknown field '${extra}'`;
    if (kinds[0] === 'flag' && !(typeof entry.flag === 'string' && (LONG.test(entry.flag) || SHORT.test(entry.flag)))) return `${at} flag must be --name or -x`;
    if (Object.hasOwn(entry, 'short') && !(typeof entry.short === 'string' && SHORT.test(entry.short))) return `${at} short must be -x`;
    if (kinds[0] === 'prefix' && !(typeof entry.prefix === 'string' && LONG.test(entry.prefix))) return `${at} prefix must be --name`;
    if (kinds[0] === 'config' && !(typeof entry.config === 'string' && CONFIG_KEY.test(entry.config))) return `${at} config must be a key of letters, digits, _ or -`;
    if (Object.hasOwn(entry, 'values') && !(Array.isArray(entry.values) && entry.values.length > 0 && entry.values.every((v: unknown) => typeof v === 'string' && v.trim() !== ''))) {
      return `${at} values must be a non-empty list of non-empty strings`;
    }
  }
  return null;
}

module.exports = { WIDENING, wideningProblem, wideningFlagsProblem };

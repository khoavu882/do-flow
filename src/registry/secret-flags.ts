'use strict';

// 172 D9: the flags and subcommands that print a credential, as data, and the one matcher the registry validator
// runs on every argv of a worker block (cli.versionArgv, each capability entry's argv, modelList.argv and each
// model check's argv). A listing or probe argv that prints a token leaks it as surely as a recipe would. Pure and
// dependency-free, like widening-flags.ts, whose shape this copies.
//
// Entry shapes:
//   { flag: '--x', short?: '-x' }   a flag that prints or accepts a secret, with any value (`--x v`, `--x=v`;
//       a short form also attached, `-xv`).
//   { command: ['auth', 'export'] } 1 to 4 exact argv elements, contiguous, anywhere in argv. Pi and opencode print
//       secrets through subcommands, not flags, so a flag list alone would miss them.
// A long `flag` of any set and every owner entry apply to every binary, a package worker's included; a `short` and
// a `command` of a binary's set apply to that binary only (`export` alone is not secret anywhere else). Placeholders
// (`{provider}`) are never matched.
//
// Ceilings, accepted: a CLI that abbreviates long options or reads secrets from an environment variable is not
// covered; bundled short flags (`-xs v`) are not split; a subcommand reached through an alias the CLI does not
// show in its --help is not listed.

type Entry = { flag?: string; short?: string; command?: readonly string[] };
type BinarySet = { evidence: string; entries: readonly Entry[] };

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value as any)) freeze(inner);
    Object.freeze(value);
  }
  return value;
};

/** The commands each built-in CLI documents in its own --help, with the record that matched each line. */
const BINARIES: Record<string, BinarySet> = freeze({
  pi: {
    evidence: 'core/worker-evidence/pi/2026-11-16-cli-check-secret-flags.json',
    entries: [{ flag: '--credentials' }, { command: ['auth', 'print-api-key'] }, { command: ['auth', 'print-bearer-token'] }],
  },
  opencode: {
    evidence: 'core/worker-evidence/opencode/2026-11-16-cli-check-secret-flags.json',
    entries: [{ command: ['auth', 'export'] }],
  },
  // `setup-token` mints a long-lived token.
  claude: {
    evidence: 'core/worker-evidence/claude/2026-11-16-cli-check-secret-flags.json',
    entries: [{ command: ['setup-token'] }],
  },
});

/** Not from any --help: the owner's own rule (172 OD-2). Applies to every binary. */
const OWNER: readonly Entry[] = freeze([
  { flag: '--show-token' }, { flag: '--print-token' },
  { command: ['print-api-key'] }, { command: ['print-bearer-token'] },
]);

const PLACEHOLDER = /^\{[A-Za-z]+\}$/;
const LONG = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const SHORT = /^-[A-Za-z0-9]$/;
const DECLARED_MAX = 32;
const COMMAND_MAX = 4;
const COMMAND_WORD_MAX = 64;

/** The entries that apply to `binary`: every long flag of every set, the owner's list, plus the short forms and the
 * commands of the binary's own set and of `declared`. */
function entriesFor(binary: unknown, declared: readonly Entry[]): Entry[] {
  const own = typeof binary === 'string' && Object.hasOwn(BINARIES, binary) ? BINARIES[binary].entries : [];
  const everyLong = Object.values(BINARIES).flatMap((set) => set.entries).filter((entry) => entry.flag !== undefined).map(({ short, ...long }) => long);
  return [...OWNER, ...everyLong, ...own, ...declared];
}

/**
 * The first secret-printing flag or command in `argv`, as written (`auth export` for a command), or null.
 * `binary` selects the short forms and commands of its own set; `declared` is the worker's own `secretFlags`.
 * Placeholders are never flags or words, and `--` does not end the scan.
 */
function secretProblem(argv: readonly unknown[], { binary, declared = [] }: { binary?: unknown; declared?: readonly Entry[] } = {}): string | null {
  const entries = entriesFor(binary, Array.isArray(declared) ? declared : []);
  const tokens = argv.map((item) => (typeof item === 'string' && !PLACEHOLDER.test(item) ? item : null));
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === null) continue;
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const long = token.startsWith('--');
    for (const entry of entries) {
      if (entry.command !== undefined) {
        if (entry.command.every((word, k) => tokens[i + k] === word)) return entry.command.join(' ');
        continue;
      }
      if (!token.startsWith('-') || token === '-' || token === '--') continue;
      if (entry.flag === name || (entry.short !== undefined && name === entry.short)) return token;
      if (!long && entry.short !== undefined && token.length > 2 && token.startsWith(entry.short)) return token;
    }
  }
  return null;
}

/** A worker block's `secretFlags`: up to 32 entries of one shape each (above), or the first problem. */
function secretFlagsProblem(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > DECLARED_MAX) return `must be a list of 1 to ${DECLARED_MAX} entries`;
  for (const [index, entry] of value.entries()) {
    const at = `entry ${index}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `${at} must be an object`;
    const kinds = ['flag', 'command'].filter((key) => Object.hasOwn(entry, key));
    if (kinds.length !== 1) return `${at} must name exactly one of flag or command`;
    const allowed = kinds[0] === 'command' ? ['command'] : ['flag', 'short'];
    const extra = Object.keys(entry).find((key) => !allowed.includes(key));
    if (extra) return `${at} has unknown field '${extra}'`;
    if (kinds[0] === 'flag') {
      if (!(typeof entry.flag === 'string' && (LONG.test(entry.flag) || SHORT.test(entry.flag)))) return `${at} flag must be --name or -x`;
      if (Object.hasOwn(entry, 'short') && !(typeof entry.short === 'string' && SHORT.test(entry.short))) return `${at} short must be -x`;
    } else if (!(Array.isArray(entry.command) && entry.command.length >= 1 && entry.command.length <= COMMAND_MAX
      && entry.command.every((word: unknown) => typeof word === 'string' && word !== '' && word === word.trim() && word.length <= COMMAND_WORD_MAX
        && !PLACEHOLDER.test(word) && !/[\u0000-\u001f\u007f]/.test(word)))) {
      return `${at} command must be 1 to ${COMMAND_MAX} plain argv elements (no placeholder, no padding)`;
    }
  }
  return null;
}

module.exports = { SECRET_BINARIES: BINARIES, SECRET_OWNER: OWNER, secretProblem, secretFlagsProblem };

'use strict';

/**
 * Build/test/lint command detection from project manifests, with a per-feature `plan.md` override
 * (plan task C.2, design component C7).
 *
 * Zero-config is the design target: a repository with a `package.json`, a `go.mod` or a `Cargo.toml`
 * should need no configuration at all. The override exists because detection is frequently wrong in
 * a monorepo, where the manifest at the repository root describes a workspace rather than the
 * package the feature actually touches.
 *
 * The property that matters more than coverage: **a failed detection is visible.** Three outcomes
 * are kept distinct, because collapsing them is how a verification gate ends up reporting PASS over
 * a suite it never ran:
 *
 *   - `commands[role]`        — a command was found, and by what.
 *   - `absent`                — a manifest was read and does not declare this role. For `build` or
 *                               `lint` that is real evidence the project has no such step; for
 *                               `test` it is not, and the caller must surface it (the tier registry
 *                               decides which, via `absenceIsEvidence`).
 *   - `declaredNone`          — a `plan.md` override set the role to `null`. A human stated that
 *                               this project has no such command. That is a declaration, not a miss.
 *
 * And when nothing could be read at all, `manifestFound` is false and `commands` is empty — which
 * the verification engine turns into UNRESOLVED tiers, never into passing ones.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The roles a tier in `verification.yaml` can ask for. Anything else in an override is an error,
 * because a typo'd key that is silently ignored is a command the user believes is running. */
const COMMAND_ROLES = Object.freeze([
  'parse',
  'build',
  'lint',
  'typecheck',
  'test',
  'testTargeted',
]);

/** Info string of the fenced block a feature's `plan.md` uses to override detection. JSON body, to
 * match the JSON-under-.yaml convention the registry already uses. */
const PLAN_OVERRIDE_BLOCK = 'doflow-verification';

/** Substituted by the verification engine when it has a target to scope tests to. */
const TARGET_PATTERN_TOKEN = '{pattern}';

/**
 * Roles this module only ever synthesizes from another role. An override of the base role has to
 * invalidate the derived one: `testTargeted` detected as `npm test -- {pattern}` is a lie the
 * moment `plan.md` replaces the test command with something else, and declaring `"test": null`
 * while leaving a targeted variant behind would report a tier as runnable that the plan just said
 * does not exist.
 */
const DERIVED_ROLES = Object.freeze({ testTargeted: 'test' });

/**
 * How a command was arrived at. `declared` means a human or a manifest script named it exactly;
 * `inferred` means this module constructed it from the toolchain's conventions and it may be wrong.
 * Kept out of any numeric form on purpose — FR-008 forbids numeric confidence in output paths.
 */
const DERIVATIONS = Object.freeze(['declared', 'inferred', 'override']);

function readFileIfPresent(filePath, fsImpl) {
  try {
    return fsImpl.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR')) {
      return null;
    }
    throw error;
  }
}

function exists(filePath, fsImpl) {
  try {
    fsImpl.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the run prefix from whichever lockfile is present. Running `npm run build` in a pnpm
 * workspace usually works and occasionally installs a second, divergent `node_modules`.
 * @returns {{ run: string, test: string, manager: string }}
 */
function nodePackageManager(root, fsImpl) {
  if (exists(path.join(root, 'pnpm-lock.yaml'), fsImpl)) {
    return { run: 'pnpm run', test: 'pnpm test', manager: 'pnpm' };
  }
  if (exists(path.join(root, 'yarn.lock'), fsImpl)) {
    return { run: 'yarn', test: 'yarn test', manager: 'yarn' };
  }
  if (exists(path.join(root, 'bun.lockb'), fsImpl) || exists(path.join(root, 'bun.lock'), fsImpl)) {
    return { run: 'bun run', test: 'bun test', manager: 'bun' };
  }
  return { run: 'npm run', test: 'npm test', manager: 'npm' };
}

/**
 * @returns {{ id: string, roles: Object, absent: Array<string> }|null}
 */
function detectNode(root, fsImpl) {
  const raw = readFileIfPresent(path.join(root, 'package.json'), fsImpl);
  if (raw === null) return null;

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (error) {
    // A malformed manifest is not an absent manifest. Reporting it as "no build script" would
    // hand the caller a confident answer derived from a file it failed to read.
    return { id: 'package.json', roles: {}, absent: [], error: `package.json is not valid JSON: ${error.message}` };
  }

  const scripts = (pkg && typeof pkg.scripts === 'object' && pkg.scripts) || {};
  const pm = nodePackageManager(root, fsImpl);
  const roles = {};
  // Node has no project-wide parse step distinct from type-checking or running the code; `node
  // --check` needs an explicit file list this module does not have. Reporting it absent (rather
  // than leaving it undetected) lets the parse tier resolve NOT_APPLICABLE instead of stalling
  // every contract in every plain-JavaScript repository on a step that does not exist.
  const absent = ['parse'];

  const script = (...names) => names.find((n) => typeof scripts[n] === 'string' && scripts[n].trim() !== '');

  const buildScript = script('build');
  if (buildScript) roles.build = { command: `${pm.run} ${buildScript}`, derivation: 'declared' };
  else absent.push('build');

  const lintScript = script('lint');
  if (lintScript) roles.lint = { command: `${pm.run} ${lintScript}`, derivation: 'declared' };
  else absent.push('lint');

  const typecheckScript = script('typecheck', 'type-check', 'tsc', 'types');
  if (typecheckScript) roles.typecheck = { command: `${pm.run} ${typecheckScript}`, derivation: 'declared' };
  else if (exists(path.join(root, 'tsconfig.json'), fsImpl)) {
    // A tsconfig with no typecheck script still has a canonical way to be type-checked.
    roles.typecheck = { command: 'npx --no-install tsc --noEmit', derivation: 'inferred' };
  } else absent.push('typecheck');

  const testScript = script('test');
  if (testScript) {
    roles.test = { command: pm.test, derivation: 'declared' };
    // Whether the underlying runner accepts a trailing path or pattern depends on the runner, not
    // on npm, so this is inferred rather than declared and the engine falls back to the broad
    // command when no pattern is supplied.
    roles.testTargeted = { command: `${pm.test} -- ${TARGET_PATTERN_TOKEN}`, derivation: 'inferred' };
  } else absent.push('test');

  return { id: 'package.json', roles, absent };
}

function detectRust(root, fsImpl) {
  if (!exists(path.join(root, 'Cargo.toml'), fsImpl)) return null;
  return {
    id: 'Cargo.toml',
    roles: {
      parse: { command: 'cargo check --all-targets', derivation: 'inferred' },
      build: { command: 'cargo build --all-targets', derivation: 'inferred' },
      lint: { command: 'cargo clippy --all-targets -- -D warnings', derivation: 'inferred' },
      test: { command: 'cargo test', derivation: 'inferred' },
      testTargeted: { command: `cargo test ${TARGET_PATTERN_TOKEN}`, derivation: 'inferred' },
    },
    absent: ['typecheck'],
  };
}

function detectGo(root, fsImpl) {
  if (!exists(path.join(root, 'go.mod'), fsImpl)) return null;
  return {
    id: 'go.mod',
    roles: {
      build: { command: 'go build ./...', derivation: 'inferred' },
      lint: { command: 'go vet ./...', derivation: 'inferred' },
      test: { command: 'go test ./...', derivation: 'inferred' },
      testTargeted: { command: `go test ${TARGET_PATTERN_TOKEN}`, derivation: 'inferred' },
    },
    absent: ['parse', 'typecheck'],
  };
}

/**
 * `pyproject.toml` is read line-wise rather than parsed: Node ships no TOML parser and adding a
 * dependency for tool-table presence detection is not worth it. Only the presence of a `[tool.X]`
 * table is used, which is robust to the parts of TOML this does not understand.
 */
function detectPython(root, fsImpl) {
  const raw = readFileIfPresent(path.join(root, 'pyproject.toml'), fsImpl);
  if (raw === null) return null;

  const hasTable = (name) => new RegExp(`^\\s*\\[tool\\.${name}[\\].]`, 'm').test(raw);
  const roles = {};
  const absent = [];

  if (hasTable('pytest') || exists(path.join(root, 'pytest.ini'), fsImpl) || exists(path.join(root, 'tests'), fsImpl)) {
    roles.test = { command: 'pytest', derivation: 'inferred' };
    roles.testTargeted = { command: `pytest ${TARGET_PATTERN_TOKEN}`, derivation: 'inferred' };
  } else absent.push('test');

  if (hasTable('ruff')) roles.lint = { command: 'ruff check .', derivation: 'inferred' };
  else if (hasTable('flake8')) roles.lint = { command: 'flake8', derivation: 'inferred' };
  else absent.push('lint');

  if (hasTable('mypy')) roles.typecheck = { command: 'mypy .', derivation: 'inferred' };
  else if (hasTable('pyright')) roles.typecheck = { command: 'pyright', derivation: 'inferred' };
  else absent.push('typecheck');

  // Python has no build step in the sense this tier means (packaging is not verification), and no
  // parse step that is not just importing the code, which the tests already do.
  absent.push('build', 'parse');
  return { id: 'pyproject.toml', roles, absent };
}

/** Makefile target name → the role it serves. Only unambiguous names are mapped. */
const MAKE_TARGET_ROLES = Object.freeze({
  build: 'build',
  compile: 'build',
  test: 'test',
  tests: 'test',
  lint: 'lint',
  vet: 'lint',
  typecheck: 'typecheck',
  'type-check': 'typecheck',
  check: 'parse',
});

function detectMake(root, fsImpl) {
  const raw = readFileIfPresent(path.join(root, 'Makefile'), fsImpl) ??
    readFileIfPresent(path.join(root, 'makefile'), fsImpl);
  if (raw === null) return null;

  const roles = {};
  const absent = [];
  const targets = new Set();
  // Target lines only: a leading tab means a recipe line, and `:=` is a variable assignment.
  for (const line of raw.split('\n')) {
    const m = /^([A-Za-z0-9_.\-/]+)\s*:(?!=)/.exec(line);
    if (m) targets.add(m[1]);
  }
  for (const [target, role] of Object.entries(MAKE_TARGET_ROLES)) {
    if (targets.has(target) && !roles[role]) {
      roles[role] = { command: `make ${target}`, derivation: 'declared' };
    }
  }
  for (const role of COMMAND_ROLES) {
    if (!roles[role] && role !== 'testTargeted') absent.push(role);
  }
  return { id: 'Makefile', roles, absent, targets: [...targets] };
}

/**
 * Detector order. The first manifest to supply a role wins; later manifests contribute only roles
 * still unfilled, and their alternative is recorded rather than discarded. `Makefile` is last on
 * purpose: it is usually a convenience wrapper over the language toolchain already detected above,
 * and a repository where it is the real entrypoint is precisely the case the `plan.md` override
 * exists for.
 */
const DETECTORS = Object.freeze([detectNode, detectRust, detectGo, detectPython, detectMake]);

/**
 * Extracts the override object from a feature's `plan.md`.
 *
 * A malformed block is an error, never a silent skip: the author believed they were overriding
 * detection, and quietly running the detected commands instead runs something they did not ask for.
 * @param {string} planText
 * @returns {{ override: Object|null, errors: Array<string> }}
 */
function parsePlanOverride(planText) {
  if (typeof planText !== 'string' || planText === '') return { override: null, errors: [] };

  const fence = new RegExp(`^[ \\t]*\`\`\`${PLAN_OVERRIDE_BLOCK}[ \\t]*\\n([\\s\\S]*?)^[ \\t]*\`\`\``, 'm');
  const match = fence.exec(planText);
  if (!match) return { override: null, errors: [] };

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    return { override: null, errors: [`plan.md '${PLAN_OVERRIDE_BLOCK}' block is not valid JSON: ${error.message}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { override: null, errors: [`plan.md '${PLAN_OVERRIDE_BLOCK}' block must be a JSON object mapping command roles to commands`] };
  }

  const errors = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!COMMAND_ROLES.includes(key)) {
      errors.push(`plan.md override declares unknown command role '${key}'; known roles: ${COMMAND_ROLES.join(', ')}`);
      continue;
    }
    if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
      errors.push(`plan.md override for '${key}' must be a non-empty command string or null (meaning: this project has none)`);
    }
  }
  return { override: parsed, errors };
}

/**
 * Detects the verification commands for a project.
 *
 * @param {Object} [options]
 * @param {string} [options.projectRoot=process.cwd()]
 * @param {string} [options.planPath] path to a feature's `plan.md`, whose override block wins
 * @param {string} [options.planText] override text supplied directly, bypassing `planPath`
 * @param {Object} [options.fsImpl] injection seam for tests
 * @returns {{
 *   projectRoot: string,
 *   usable: boolean,
 *   manifestFound: boolean,
 *   manifests: Array<string>,
 *   commands: Object<string, {role: string, command: string, source: string, derivation: string}>,
 *   alternatives: Array<Object>,
 *   absent: Array<string>,
 *   declaredNone: Array<string>,
 *   errors: Array<string>
 * }}
 */
function detectCommands(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const projectRoot = options.projectRoot || process.cwd();

  const manifests = [];
  const commands = {};
  const alternatives = [];
  const absentByRole = new Map();
  const errors = [];

  for (const detector of DETECTORS) {
    let found;
    try {
      found = detector(projectRoot, fsImpl);
    } catch (error) {
      errors.push(`Detector failed while reading ${projectRoot}: ${error.message}`);
      continue;
    }
    if (!found) continue;
    manifests.push(found.id);
    if (found.error) {
      errors.push(found.error);
      continue;
    }
    for (const [role, entry] of Object.entries(found.roles)) {
      if (commands[role]) {
        alternatives.push({ role, command: entry.command, source: found.id, derivation: entry.derivation });
      } else {
        commands[role] = { role, command: entry.command, source: found.id, derivation: entry.derivation };
      }
    }
    for (const role of found.absent || []) {
      if (!absentByRole.has(role)) absentByRole.set(role, found.id);
    }
  }

  // A role another manifest supplied is not absent, whatever the manifest that lacked it said.
  for (const role of Object.keys(commands)) absentByRole.delete(role);

  let planText = options.planText;
  if (typeof planText !== 'string' && options.planPath) {
    planText = readFileIfPresent(options.planPath, fsImpl);
    if (planText === null) {
      errors.push(`plan.md override path does not exist: ${options.planPath}`);
      planText = undefined;
    }
  }

  const declaredNone = [];
  const { override, errors: overrideErrors } = parsePlanOverride(planText);
  errors.push(...overrideErrors);

  if (override && overrideErrors.length === 0) {
    for (const [role, value] of Object.entries(override)) {
      if (value === null) {
        delete commands[role];
        absentByRole.delete(role);
        declaredNone.push(role);
      } else {
        if (commands[role]) {
          alternatives.push({ ...commands[role], supersededBy: 'plan.md' });
        }
        commands[role] = { role, command: value.trim(), source: 'plan.md', derivation: 'override' };
        absentByRole.delete(role);
      }
    }

    // Propagate to roles synthesized from an overridden base — see DERIVED_ROLES.
    for (const [derived, base] of Object.entries(DERIVED_ROLES)) {
      if (!(base in override) || derived in override) continue;
      if (commands[derived]) {
        alternatives.push({ ...commands[derived], supersededBy: `plan.md override of '${base}'` });
        delete commands[derived];
      }
      if (override[base] === null) declaredNone.push(derived);
      else absentByRole.delete(derived);
    }
  }

  // An override this module could not trust invalidates the *whole* detection, not just its own
  // block. Falling back to the detected commands would run something the plan explicitly replaced —
  // the same failure family as a check with no command reporting PASS.
  const usable = errors.length === 0;
  if (!usable) {
    return {
      projectRoot,
      usable: false,
      manifestFound: manifests.length > 0,
      manifests,
      commands: {},
      alternatives: [],
      absent: [],
      declaredNone: [],
      errors,
    };
  }

  return {
    projectRoot,
    usable: true,
    manifestFound: manifests.length > 0,
    manifests,
    commands,
    alternatives,
    absent: [...absentByRole.keys()].sort(),
    declaredNone: declaredNone.sort(),
    errors: [],
  };
}

/**
 * Substitutes a target pattern into a detected command template.
 * @param {string} command
 * @param {string} [pattern]
 * @returns {{ command: string, substituted: boolean }}
 */
function applyTargetPattern(command, pattern) {
  if (typeof command !== 'string' || !command.includes(TARGET_PATTERN_TOKEN)) {
    return { command, substituted: false };
  }
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    return { command: null, substituted: false };
  }
  return { command: command.split(TARGET_PATTERN_TOKEN).join(pattern.trim()), substituted: true };
}

module.exports = {
  detectCommands,
  parsePlanOverride,
  applyTargetPattern,
  COMMAND_ROLES,
  DERIVED_ROLES,
  PLAN_OVERRIDE_BLOCK,
  TARGET_PATTERN_TOKEN,
  DERIVATIONS,
};

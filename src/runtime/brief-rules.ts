'use strict';

// The must-carry rules of a worker brief (135 item 3). Run directly by Node native type-stripping:
//
//   node src/runtime/brief-rules.ts --write   rewrite the mustCarry key of core/registry/rules.json
//   node src/runtime/brief-rules.ts --check   exit 0 equal, 1 differs, 2 usage
//
// RULES.md lines ending in the must-carry marker are copied into the `mustCarry` key of the rule
// ledger, because an installed runtime ships `core/registry/` but not `core/shared/`. The key is
// generated, never edited by hand; only it is rewritten, the rest of the file stays byte-identical.
// G78 fails when it differs from RULES.md.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../helper/repo-root.ts');

const SOURCE_REL = 'core/shared/guidance/rules/RULES.md';
const TARGET_REL = 'core/registry/rules.json';
const MARKER = ' <!-- must-carry -->';
const MIN_LINES = 3;
const MAX_LINES = 5;

/** The marked lines of `text`, marker and leading `- ` removed, in file order. */
function mustCarryLines(text: string): string[] {
  return text.split('\n')
    .filter((line) => line.endsWith(MARKER))
    .map((line) => line.slice(0, -MARKER.length).replace(/^- /, ''));
}

/** The ledger text with its `mustCarry` key set from `text`; throws when the marker count is out of range. */
function compileBriefRules(text: string, ledgerText: string): string {
  const lines = mustCarryLines(text);
  if (lines.length < MIN_LINES || lines.length > MAX_LINES) {
    throw new Error(`${SOURCE_REL} has ${lines.length} must-carry lines; expected ${MIN_LINES} to ${MAX_LINES}`);
  }
  const ledger = JSON.parse(ledgerText);
  delete ledger.mustCarry;
  delete ledger.mustCarryNote;
  ledger.mustCarry = lines;
  ledger.mustCarryNote = `Generated from the ${MARKER.trim()} lines of ${SOURCE_REL} by src/runtime/brief-rules.ts --write; never edit by hand`;
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

/** The committed lines under `root`, or the reason they cannot be read; never throws. */
function loadBriefRules(root: string): { lines: string[] } | { reason: string } {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, TARGET_REL), 'utf8'));
    if (!Array.isArray(data.mustCarry) || data.mustCarry.some((line: unknown) => typeof line !== 'string')) return { reason: `${TARGET_REL} has no mustCarry array` };
    return { lines: data.mustCarry };
  } catch (err: any) {
    return { reason: err.code === 'ENOENT' ? `${TARGET_REL} is missing` : `${TARGET_REL} is unreadable` };
  }
}

const USAGE = 'usage: node src/runtime/brief-rules.ts --write|--check\n';

/** The CLI: 0 written or equal, 1 the committed file differs, 2 usage. */
function main(argv: string[], root: string = REPO_ROOT): number {
  if (argv.length !== 1 || (argv[0] !== '--write' && argv[0] !== '--check')) {
    process.stderr.write(USAGE);
    return 2;
  }
  const target = path.join(root, TARGET_REL);
  const expected = compileBriefRules(fs.readFileSync(path.join(root, SOURCE_REL), 'utf8'), fs.readFileSync(target, 'utf8'));
  if (argv[0] === '--write') {
    fs.writeFileSync(target, expected);
    return 0;
  }
  if (fs.readFileSync(target, 'utf8') === expected) return 0;
  process.stderr.write(`brief-rules: ${TARGET_REL} mustCarry is stale; run node src/runtime/brief-rules.ts --write\n`);
  return 1;
}

module.exports = { SOURCE_REL, TARGET_REL, MARKER, mustCarryLines, compileBriefRules, loadBriefRules, main };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err: any) {
    process.stderr.write(`brief-rules: ${err.message}\n`);
    process.exitCode = 1;
  }
}

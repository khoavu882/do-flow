'use strict';

// Core version handshake (feature 093, 092 IC-013; IC-002 boot step 2). The core's `--version` line
// is checked as SemVer 2.0.0 and compared with the `doflowCore` range in this package's manifest.
// The grammar is a copy of src/helper/semver.ts (>=V, <V, =V or bare V, all must hold, an upper
// bound required) because this package ships without the core; project.test.ts checks the two agree.

const manifest = require('../package.json');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type Comparator = { op: '>=' | '<' | '='; version: string };
type Mismatch = { ok: false; code: 'core-contract-mismatch' };
type Checked = { ok: true; inRange: boolean; version: string; needed: string } | Mismatch;

const isSemVer = (value: unknown): value is string => typeof value === 'string' && SEMVER.test(value);

/** Numeric identifiers compare by value, alphanumeric ones in ASCII order, numeric before alphanumeric. */
function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  } else if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** SemVer 2.0.0 precedence of two valid versions; build metadata is ignored. */
function compareSemVer(left: string, right: string): number {
  const [l, r] = [left, right].map((value) => SEMVER.exec(value)!);
  for (let index = 1; index <= 3; index++) {
    const order = compareIdentifiers(l[index], r[index]);
    if (order !== 0) return order;
  }
  if (!l[4] || !r[4]) return l[4] ? -1 : r[4] ? 1 : 0;
  const [lp, rp] = [l[4].split('.'), r[4].split('.')];
  for (let index = 0; index < Math.min(lp.length, rp.length); index++) {
    const order = compareIdentifiers(lp[index], rp[index]);
    if (order !== 0) return order;
  }
  return Math.sign(lp.length - rp.length);
}

/** The comparators of a host range; throws on a range outside the grammar (a defect in our own manifest). */
function parseRange(range: string): Comparator[] {
  const comparators = range.split(' ').map((token) => {
    const match = /^(>=|<|=)?(.+)$/.exec(token);
    if (!match || !isSemVer(match[2])) throw new Error(`doflowCore range "${range}": "${token}" is not a comparator`);
    return { op: (match[1] || '=') as Comparator['op'], version: match[2] };
  });
  if (!comparators.some((comparator) => comparator.op !== '>=')) throw new Error(`doflowCore range "${range}" has no upper bound`);
  return comparators;
}

function satisfiesRange(version: string, range: string): boolean {
  const comparators = parseRange(range);
  if (!isSemVer(version)) return false;
  return comparators.every(({ op, version: bound }) => {
    const order = compareSemVer(version, bound);
    return op === '>=' ? order >= 0 : op === '<' ? order < 0 : order === 0;
  });
}

/** The `--version` line checked against the range: out of range is IC-002's exit 2 with `version` and `needed`. */
function checkCoreVersion(versionText: unknown, range: string = manifest.doflowCore): Checked {
  if (!isSemVer(versionText)) return { ok: false, code: 'core-contract-mismatch' };
  return { ok: true, inRange: satisfiesRange(versionText, range), version: versionText, needed: range };
}

/** Boot step: run the `version` shape; a runner failure (core-unreachable, core-error) is returned as is. */
async function handshake(runner: { run(shape: string, params: Record<string, string>): Promise<any> }, range: string = manifest.doflowCore) {
  const result = await runner.run('version', {});
  return result.ok ? checkCoreVersion(result.json, range) : result;
}

module.exports = { checkCoreVersion, compareSemVer, handshake, isSemVer, satisfiesRange };

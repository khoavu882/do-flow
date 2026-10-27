'use strict';

// SemVer 2.0.0 parsing and precedence, and the package host-range grammar (IC-016).
// No dependency: DoFlow ships `2.0.0-beta.N`, so prerelease precedence is part of the contract.
type SemVer = { major: string, minor: string, patch: string, prerelease: string[] };
type Comparator = { op: '>=' | '<' | '=', version: string };
type HostRangeError = { code: 'bad-type', message: string, allowed: string };
type HostRange = { ok: true, comparators: Comparator[] } | { ok: false, error: HostRangeError };

const HOST_RANGE_GRAMMAR = 'one or more comparators separated by single spaces, all of which must hold: '
  + '>=V, <V, =V or a bare V (exact), where V is a full semver 2.0.0 version; '
  + 'an upper bound (<V, =V or a bare V) is required; no ^, ~, ||, x or *';

function parseSemVer(value: string): SemVer | null {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier)
    && identifier.length > 1 && identifier.startsWith('0'))) return null;
  return { major: match[1], minor: match[2], patch: match[3], prerelease };
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareSemVer(leftValue: string, rightValue: string): number | null {
  const left = parseSemVer(leftValue);
  const right = parseSemVer(rightValue);
  if (!left || !right) return null;

  for (const key of ['major', 'minor', 'patch'] as const) {
    const order = compareNumeric(left[key], right[key]);
    if (order !== 0) return order;
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftId = left.prerelease[index];
    const rightId = right.prerelease[index];
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) {
      const order = compareNumeric(leftId, rightId);
      if (order !== 0) return order;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftId !== rightId) {
      return leftId < rightId ? -1 : 1;
    }
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

function refused(message: string): HostRange {
  return { ok: false, error: { code: 'bad-type', message, allowed: HOST_RANGE_GRAMMAR } };
}

// Never throws: a refused range comes back as { ok: false, error } for the caller to turn into a finding.
function parseHostRange(text: unknown): HostRange {
  if (typeof text !== 'string') return refused('the host range must be a string');
  const comparators: Comparator[] = [];
  for (const token of text.split(' ')) {
    const match = token.match(/^(>=|<|=)?(.+)$/);
    if (!match || parseSemVer(match[2]) === null) {
      return refused(`"${token}" is not a comparator of the host range grammar`);
    }
    comparators.push({ op: (match[1] || '=') as Comparator['op'], version: match[2] });
  }
  if (!comparators.some((comparator) => comparator.op !== '>=')) {
    return refused('the host range has no upper bound');
  }
  return { ok: true, comparators };
}

// `range` is the range text or a parseHostRange result; a refused range or an invalid version satisfies nothing.
function satisfiesHostRange(version: string, range: string | HostRange): boolean {
  const parsed = typeof range === 'string' ? parseHostRange(range) : range;
  if (!parsed.ok) return false;
  return parsed.comparators.every(({ op, version: bound }) => {
    const order = compareSemVer(version, bound);
    if (order === null) return false;
    return op === '>=' ? order >= 0 : op === '<' ? order < 0 : order === 0;
  });
}

module.exports = { parseSemVer, compareSemVer, parseHostRange, satisfiesHostRange, HOST_RANGE_GRAMMAR };

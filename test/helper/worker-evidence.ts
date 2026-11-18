'use strict';

// The recorded-evidence checks G41 and G84 both apply to a cli-check record: it equals core/worker-evidence/<harness>/checks.json
// (id, argv, expect, establishes), its cliVersion matches that file's own version.expect, and a key is established only by a check
// that passed. One copy, so the two guards cannot drift.
const fs = require('node:fs');
const path = require('node:path');

function checksFile(harnessId: any, repoRoot: any) {
  try {
    const spec = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'core', 'worker-evidence', harnessId, 'checks.json'), 'utf8'));
    return spec && Array.isArray(spec.checks) ? spec : null;
  } catch { return null; }
}

const checksSpec = (harnessId: any, repoRoot: any) => checksFile(harnessId, repoRoot)?.checks ?? null;

/** True when `cliVersion` matches the harness's own `version.expect` from its checks.json (a hand-typed
 * 'x' or another harness's version line does not). */
function cliVersionMatches(cliVersion: any, harnessId: any, repoRoot: any) {
  const expect = checksFile(harnessId, repoRoot)?.version?.expect;
  if (typeof expect !== 'string') return false;
  try { return new RegExp(expect).test(cliVersion); } catch { return false; }
}

const sameJson = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

// A key with parts is established only when every part its entry needs is (170 IC-008): the tokens are `<key>:<part>`.
const KEY_PARTS: any = { controlChannel: (entry: any) => ['argv', 'messages', 'turn', 'close', ...(entry && entry.answer ? ['answer'] : [])] };
const SHA256 = /^[0-9a-f]{64}$/;

/** True when every check of a cli-check record equals its checks.json entry (id, argv or doc, expect,
 * establishes) and `key` is established by checks that passed: result pass and matched lines, plus exit 0 for an
 * argv check or a sha256 for a doc check. A key with parts needs every part token its `entry` requires. */
function checksEstablish(record: any, harnessId: any, key: any, repoRoot: any, entry: any = null) {
  if (!Array.isArray(record.checks) || record.checks.length === 0) return false;
  const spec = checksSpec(harnessId, repoRoot);
  if (!spec) return false;
  for (const check of record.checks) {
    const bound = spec.find((entry: any) => entry.id === check?.id);
    if (!bound || !sameJson(check.argv, bound.argv) || !sameJson(check.doc, bound.doc) || !sameJson(check.expect, bound.expect) || !sameJson(check.establishes, bound.establishes)) return false;
  }
  const recomputed: any = new Set(record.checks
    .filter((check: any) => check.result === 'pass' && Array.isArray(check.matched) && check.matched.length > 0
      && (typeof check.doc === 'string' ? SHA256.test(check.sha256) : check.exit === 0))
    .flatMap((check: any) => check.establishes));
  const parts = KEY_PARTS[key];
  return parts ? parts(entry).every((part: string) => recomputed.has(`${key}:${part}`)) : recomputed.has(key);
}

module.exports = { checksSpec, cliVersionMatches, sameJson, checksEstablish };

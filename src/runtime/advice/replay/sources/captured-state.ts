'use strict';

// The `captured-state` case source (180 IC-180-G2, design section 8). The recorded decisions of a routing kind are its
// picks: each captured line (advice/state-text.ts, written only while the user has turned capture on) holds the masked
// state of one pick; the pick line with the same `pickId` holds the rule's answer (`static`), and the pick's outcome line
// holds what was done (`actual`), which is the label. The label is what was done, not the rule's answer by construction,
// so `labelIsRule` is false; while a kind runs in shadow the two mostly agree until people record overrides.
//
// Read-only. Skipped, by reason: `no-pick` (no pick line with the id), `digest-mismatch` (the pick's state digest is not
// the captured one), `no-static` (the pick holds no rule answer among its options), `no-label` (no outcome with `actual`),
// `unreadable` (a partition or line that could not be read). With no captured line for the kind at all, the one skipped
// reason is `capture-off-or-empty`, so the replay's refusal says why there is nothing to replay.

const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const { loadStorageRegistry } = require('../../../storage/registry.ts');
const { resolveRoots } = require('../../../storage/roots.ts');
const { readWindow } = require('../../record.ts');
const { readCaptured } = require('../../state-text.ts');
const { REPO_ROOT } = require('../../../../helper/repo-root.ts');

function caseId(pickId: string): string {
  return crypto.createHash('sha256').update(pickId).digest('hex').slice(0, 16);
}

function build({ projectRoot, roots, kind, fsImpl = nodeFs }: any = {}): { cases: any[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const skip = (reason: string, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] || 0) + n; };
  const resolvedRoots = roots || resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot });
  const captured = readCaptured({ roots: resolvedRoots, kind: kind?.id, fsImpl });
  skip('unreadable', captured.unreadable);
  if (captured.lines.length === 0) {
    skip('capture-off-or-empty');
    return { cases: [], skipped };
  }

  const picks = new Map<string, any>();
  const labels = new Map<string, { at: string; actual: string }>();
  for (const { record } of readWindow({ roots: resolvedRoots, fsImpl }).records) {
    if (typeof record.pickId !== 'string') continue;
    if (record.type === 'pick' && record.kind === kind?.id && !picks.has(record.pickId)) picks.set(record.pickId, record);
    // The latest outcome that names what was done is the label.
    if (record.type === 'outcome' && typeof record.actual === 'string') {
      const held = labels.get(record.pickId);
      if (!held || String(record.at) >= held.at) labels.set(record.pickId, { at: String(record.at), actual: record.actual });
    }
  }

  const seen = new Set<string>();
  const cases: any[] = [];
  for (const line of captured.lines) {
    if (seen.has(line.pickId)) { skip('duplicate-case'); continue; }
    seen.add(line.pickId);
    const pick = picks.get(line.pickId);
    if (!pick) { skip('no-pick'); continue; }
    if (pick.stateDigest !== line.stateDigest) { skip('digest-mismatch'); continue; }
    if (typeof pick.static !== 'string' || !Array.isArray(pick.options) || !pick.options.includes(pick.static)) { skip('no-static'); continue; }
    const label = labels.get(line.pickId);
    if (!label) { skip('no-label'); continue; }
    cases.push({ id: caseId(line.pickId), state: line.text, label: label.actual, rule: pick.static });
  }
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cases, skipped };
}

const source = { id: 'captured-state', builderVersion: 1, labelIsRule: false, origin: 'project' as const, build };

module.exports = { source, build };

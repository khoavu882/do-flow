'use strict';

// The `review-findings` case source (176 IC-005, design section 7). The recorded decisions are the project's review
// records, `agent-docs/doflow/<slug>/review/findings.json`: the rule stage (`same-issue/rule.ts`) picks the candidate
// pairs of seat findings per record, and a pair the synthesizer merged into one converged entry is labelled `yes`, a pair
// it placed in two entries `no`. The label is the synthesizer's judgement, not the rule's, so `labelIsRule` is false.
//
// Read-only: the folder entries are listed with their types, a record is read only when its `review` folder is a real
// directory and it is a regular file of at most 8 MiB (a link is never followed, at either level), and nothing is written.
// A finding id that repeats keeps its first item. A skipped file, finding or pair is counted by reason, not shown.
//
// Pin: `CODE_DIGEST` fixes the code a case set depends on: `same-issue/rule.ts` (which pairs are asked and the rule's
// answer), `advice/batch.ts` and this file. A change to any of the three files moves the digest, so the pin must be set
// to the new value; it is carried as the source's `params`, which `builderDigest` folds in, so a moved pin makes every
// stored result of the kind stale. Guard G89.2 compares the constant with `computeCodeDigest()`. The digest reads this
// file without the line that holds the constant, so the file can hold its own pin.

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPO_ROOT } = require('../../../../helper/repo-root.ts');
const { itemText, candidatePairs, pairState } = require('../../same-issue/rule.ts');

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const CODE_FILES = ['src/runtime/advice/same-issue/rule.ts', 'src/runtime/advice/batch.ts'];
const SELF_FILE = 'src/runtime/advice/replay/sources/review-findings.ts';

const CODE_DIGEST = '66cfd33b0f2495a17d01bf09eafc833f00a53d7bb8aa58fc219dbff988c8e6f9';

/** Lowercase hex over the two code files' bytes, then this file's text without its pin line; null when one is unreadable. */
function computeCodeDigest(fsImpl: any = nodeFs): string | null {
  try {
    const hash = crypto.createHash('sha256');
    for (const file of CODE_FILES) hash.update(fsImpl.readFileSync(path.join(REPO_ROOT, file)));
    const self = fsImpl.readFileSync(path.join(REPO_ROOT, SELF_FILE), 'utf8');
    return hash.update(self.split('\n').filter((line: string) => !line.includes('CODE_DIGEST =')).join('\n')).digest('hex');
  } catch { return null; }
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** The record file's parsed content, `absent` when there is no review folder or record, `unreadable` when the folder or file is a link or other non-regular entry, too large or unparsable. */
function readRecord(reviewDir: string, file: string, fsImpl: any): { value: any } | 'absent' | 'unreadable' {
  let dir: any;
  try { dir = fsImpl.lstatSync(reviewDir); } catch { return 'absent'; }
  if (!dir.isDirectory()) return 'unreadable';
  let stat: any;
  try { stat = fsImpl.lstatSync(file); } catch { return 'absent'; }
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return 'unreadable';
  try { return { value: JSON.parse(fsImpl.readFileSync(file, 'utf8')) }; } catch { return 'unreadable'; }
}

function caseId(slug: string, a: string, b: string): string {
  return crypto.createHash('sha256').update(`${slug}\n${a}\n${b}`).digest('hex').slice(0, 16);
}

function build({ projectRoot, kind, fsImpl = nodeFs }: any = {}): { cases: any[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const skip = (reason: string, n = 1) => { skipped[reason] = (skipped[reason] || 0) + n; };
  const base = path.join(projectRoot, 'agent-docs', 'doflow');
  let slugs: string[];
  try {
    slugs = fsImpl.readdirSync(base, { withFileTypes: true }).filter((entry: any) => entry.isDirectory()).map((entry: any) => entry.name).sort();
  } catch { return { cases: [], skipped }; }

  const found: any[] = [];
  for (const slug of slugs) {
    const reviewDir = path.join(base, slug, 'review');
    const read = readRecord(reviewDir, path.join(reviewDir, 'findings.json'), fsImpl);
    if (read === 'absent') continue;
    if (read === 'unreadable') { skip('unreadable-file'); continue; }
    const record = read.value;
    if (!record || record.schema !== 1 || !Array.isArray(record.seats) || !Array.isArray(record.converged)) { skip('not-a-review-record'); continue; }

    const items: any[] = [];
    const itemById = new Map<string, any>();
    for (const seat of record.seats) {
      for (const finding of Array.isArray(seat?.findings) ? seat.findings : []) {
        if (!nonEmpty(finding?.id) || !nonEmpty(finding.summary)) continue;
        const locator = nonEmpty(finding.locator) ? finding.locator : null;
        if (itemById.has(finding.id)) { skip('duplicate-finding-id'); continue; }
        const item = { id: finding.id, text: itemText(locator ? `${locator} — ${finding.summary}` : finding.summary, kind.params.itemBytes), locator };
        itemById.set(item.id, item);
        items.push(item);
      }
    }

    // The converged entries each finding id sits in; a pair is merged when one entry holds both.
    const entriesOf = new Map<string, Set<number>>();
    record.converged.forEach((entry: any, index: number) => {
      for (const id of Array.isArray(entry?.from) ? entry.from : []) {
        if (!entriesOf.has(id)) entriesOf.set(id, new Set());
        entriesOf.get(id)!.add(index);
      }
    });
    const merged = (a: string, b: string): boolean => [...(entriesOf.get(a) || [])].some((index) => entriesOf.get(b)?.has(index));

    const candidates = new Set<string>();
    for (const pair of candidatePairs(items, kind.params)) {
      candidates.add(`${pair.a}\n${pair.b}`);
      if (!entriesOf.has(pair.a) || !entriesOf.has(pair.b)) { skip('ungrouped'); continue; }
      found.push({ id: caseId(slug, pair.a, pair.b), state: pairState(itemById.get(pair.a), itemById.get(pair.b)), label: merged(pair.a, pair.b) ? 'yes' : 'no', rule: pair.rule });
    }
    // Pairs with both findings placed that the rule stage dropped; the merged ones are the stage's misses.
    const placed = [...itemById.keys()].filter((id) => entriesOf.has(id)).sort();
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        if (candidates.has(`${placed[i]}\n${placed[j]}`)) continue;
        skip('not-a-candidate');
        if (merged(placed[i], placed[j])) skip('merged-not-a-candidate');
      }
    }
  }

  // One id names one (record, pair); an id reached twice would be counted twice, so every occurrence is left out and counted.
  const seen = new Map<string, number>();
  for (const c of found) seen.set(c.id, (seen.get(c.id) || 0) + 1);
  const cases: any[] = [];
  for (const c of found) {
    if (seen.get(c.id) === 1) cases.push(c);
    else skip('duplicate-case');
  }
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cases, skipped };
}

const source = { id: 'review-findings', builderVersion: 1, labelIsRule: false, origin: 'project' as const, params: { codeDigest: CODE_DIGEST }, build };

module.exports = { source, build, CODE_DIGEST, computeCodeDigest };

'use strict';

// Row 176 (design §9 IC-007, §12; owner rulings O-2 (a), O-3 (a)): `doflow review --action similar`, the synthesizer's
// advisory list of possible duplicates among the seat findings. The seats come from `--seats <file>`, else the feature's
// `review/seats.json` (an object with `schema: 1` and a `seats` array; a full findings record qualifies), held to the
// findings record's seat rules. The rule stage picks the candidate pairs and checkPairs asks the model about them, with
// the main checkout as the decision's project. Only when every batch is shown is a list given: each pair the model calls
// the same issue, or, where the model gave no answer, the rule does. Until then nothing is listed, not even the rule's
// pairs (design D10). It writes nothing but `--out`: no findings record, no converged.md.

const fs = require('node:fs');
const path = require('node:path');
const { object, seatFaults } = require('./findings.ts');
const { loadAdviceRegistry } = require('../advice/registry.ts');
const { itemText, candidatePairs } = require('../advice/same-issue/rule.ts');
const { checkPairs } = require('../advice/same-issue/ask.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { finishRuntime } = require('../cli-result.ts');

const FINDING_ID = /^[A-Za-z0-9._:-]{1,64}$/;

type SeatsRead = { seats: any[] } | { error: 'seats-unreadable' | 'seats-invalid'; message: string; field?: string };

/** The seats of `file`, or the first fault: unreadable, not JSON, not a schema-1 object with a seats array, or a seat rule. */
function readSeats(file: string): SeatsRead {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error: any) { return { error: 'seats-unreadable', message: `cannot read ${file}: ${error?.code || error?.message}` }; }
  const invalid = (field: string, rule: string): SeatsRead => ({ error: 'seats-invalid', field, message: `${file}: ${field} fails the seat rules (${rule})` });
  let data: any;
  try { data = JSON.parse(raw); } catch { return invalid('$', 'json'); }
  if (!object(data)) return invalid('$', 'object');
  if (data.schema !== 1) return invalid('schema', 'schema');
  if (!Array.isArray(data.seats)) return invalid('seats', 'seats');
  const fault = seatFaults(data.seats).faults[0];
  if (fault) return invalid(fault.field, fault.error);
  // An id is echoed into the `--out` document line, so it holds to the id charset (one line, no markup).
  for (let s = 0; s < data.seats.length; s += 1) {
    for (let f = 0; f < data.seats[s].findings.length; f += 1) {
      if (!FINDING_ID.test(data.seats[s].findings[f].id)) return invalid(`seats[${s}].findings[${f}].id`, 'id');
    }
  }
  return { seats: data.seats };
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** The document the synthesis brief takes as `possible-duplicates`: a fixed header, then one line per listed pair. */
function documentText(result: any): string {
  const lines = [
    'Possible duplicates among the seat findings (advisory). A pair here may be one issue; merge only what you judge the same.',
    `Nothing was merged, dropped or reordered. Checked ${plural(result.candidates, 'candidate pair')} of ${plural(result.findings, 'finding')}; ${result.pairs.length} listed.`,
    ...result.pairs.map((pair: any) => `- ${pair.a} and ${pair.b} · score ${pair.score.toFixed(2)} · ${pair.model === 'same-issue' ? 'model: same issue' : 'rule (the model gave no answer)'}`),
  ];
  return `${lines.join('\n')}\n`;
}

async function handleReviewSimilar({ slug, seats: seatsFile, outFile, json, cwd, env, resolve, out }: {
  slug: string | null; seats: string | null; outFile: string | null; json: boolean; cwd: string; env: Record<string, string | undefined>;
  resolve: (options: { projectRoot: string; slug?: string | null }) => any; out: (line: string) => void;
}): Promise<number> {
  const fail = (error: string, message: string, extra: Record<string, string> = {}): number => {
    out(json ? JSON.stringify({ ok: false, error, ...extra, message }) : `doflow review: ${message}`);
    return finishRuntime(1);
  };
  let feature: any;
  try { feature = resolve({ projectRoot: cwd, slug }); } catch (error: any) { feature = { error: 'resolver-failed', message: error?.message || String(error) }; }
  const resolved = !feature?.error && typeof feature?.featureFolder === 'string' && feature.featureFolder ? feature.featureFolder : null;
  // `--seats` names the file itself, so a feature is not needed: the slug is then null.
  if (!resolved && !seatsFile) return fail('no-feature', feature?.message || feature?.error || 'feature could not be resolved');
  const read = readSeats(seatsFile ? path.resolve(cwd, seatsFile) : path.join(resolved, 'review', 'seats.json'));
  if ('error' in read) return fail(read.error, read.message, read.field ? { field: read.field } : {});

  const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
  const params = loaded.ok ? loaded.registry.kinds.find((kind: any) => kind.id === 'same-issue')?.params : null;
  // Each item's text is the case source's (`locator — summary`), so production asks what replay measures.
  const items = read.seats.flatMap((seat: any) => seat.findings.map((finding: any) => ({
    id: finding.id, text: params ? itemText(`${finding.locator} — ${finding.summary}`, params.itemBytes) : '', locator: finding.locator,
  })));
  const pairs = params ? candidatePairs(items, params) : [];
  const check = params
    ? await checkPairs({ kind: 'same-issue', caller: 'review', pairs, items: new Map(items.map((item: any) => [item.id, item])), cwd, env, adviceRegistry: loaded.registry })
    : { shown: false, mode: 'off', reason: 'the same-issue kind could not be loaded', batches: 0, pairs: [] };

  const result: any = {
    schema: 1, slug: resolved ? path.basename(resolved) : null, findings: items.length, candidates: pairs.length,
    batches: check.batches, mode: check.mode, reason: check.reason, shown: check.shown,
  };
  if (check.shown) {
    // Candidate order is best score first; a model no drops a pair, a no-answer keeps the rule's yes.
    result.pairs = check.pairs.filter((pair: any) => pair.model === 'yes' || (pair.noAnswer !== null && pair.rule === 'yes'))
      .map(({ a, b, score, rule, model }: any) => ({ a, b, score: Math.round(score * 100) / 100, rule, model: model === 'yes' ? 'same-issue' : 'no-answer' }));
  }
  result.out = null;
  if (check.shown && outFile) {
    const target = path.resolve(cwd, outFile);
    const temp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, documentText(result));
      fs.renameSync(temp, target);
    } catch (error: any) {
      fs.rmSync(temp, { force: true });
      return fail('out-unwritable', `cannot write ${target}: ${error?.code || error?.message}`);
    }
    result.out = target;
  }

  const checked = `Checked ${plural(result.candidates, 'candidate pair')} of ${plural(result.findings, 'finding')} in ${plural(result.batches, 'batch', 'batches')}.`;
  if (json) out(JSON.stringify(result));
  else if (!check.shown) out(`review similar: not shown (${check.reason}); nothing is listed. ${checked}`);
  else if (result.out) out(`review similar: ${plural(result.pairs.length, 'possible duplicate pair')} written to ${result.out}. ${checked}`);
  else for (const line of documentText(result).trimEnd().split('\n')) out(line);
  return finishRuntime(0);
}

module.exports = { handleReviewSimilar };

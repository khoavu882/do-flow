'use strict';

// The `instructs-reader-corpus` case source (177 IC-007). The recorded decisions are the labels of a synthetic corpus
// that ships with the package (`corpora/instructs-reader.json`, ROT13 at rest so the file never holds a readable
// directive). The rule is the kind's own screen run on the decoded, cut passage, so the label is not the rule's answer
// (`labelIsRule` false) and a result over this source can certify.
//
// Read-only and package-only: the one file read is under the repo root, never the project. Passages are decoded in
// memory and handed to the state builder; nothing here prints, logs or returns a decoded passage except as the case's
// `state`, which the replay verb never shows.
//
// Pins: `CORPUS_DIGEST` and `RULE_DIGEST` fix the corpus bytes and the rule it was written against. A change to either is
// not a runtime skip: the guard compares them with `computeDigests()` and fails until `builderVersion` and both pins rise
// together, which moves the builder digest and makes a stored result stale at decision time.
// The source carries both pins as its `params`, which is how `builderDigest` sees them.

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPO_ROOT } = require('../../../../helper/repo-root.ts');
const { RULE_PATTERNS, ruleScreen, buildInstructsReaderState } = require('../../instructs-reader.ts');

const KIND = 'instructs-reader';
const CORPUS_FILE = path.join(REPO_ROOT, 'src', 'runtime', 'advice', 'replay', 'corpora', 'instructs-reader.json');

const CORPUS_DIGEST = '8fb0dff056b79ba1ea0185d6f6c3030623459b3493af552c5e701e0d5a7d00f4';
const RULE_DIGEST = '1eb1909665e7f7eac7f92bdc5b55167f238d78fa2efef4f997c7574d811bc392';

// Lowercase hex with no prefix: the guard on shipped text reads a quoted word-colon-word string as a model literal.
const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

/** The digests of the corpus file as shipped and of the rule patterns (`patterns` is a test seam); null for an unreadable file. */
function computeDigests(patterns: readonly RegExp[] = RULE_PATTERNS, fsImpl: any = nodeFs): { corpus: string | null; rule: string } {
  let corpus: string | null = null;
  try { corpus = sha256(fsImpl.readFileSync(CORPUS_FILE)); } catch { /* reported as null */ }
  return { corpus, rule: sha256(patterns.map((pattern) => pattern.source).join('\n')) };
}

const rot13 = (text: string): string => text.replace(/[a-z]/gi, (ch) => {
  const base = ch <= 'Z' ? 65 : 97;
  return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
});

const caseId = (id: string): string => crypto.createHash('sha256').update(`${KIND}\n${id}`).digest('hex').slice(0, 16);

function build({ kind, fsImpl = nodeFs }: any = {}): { cases: any[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  let entries: any;
  try { entries = JSON.parse(fsImpl.readFileSync(CORPUS_FILE, 'utf8')).cases; } catch { entries = null; }
  if (!Array.isArray(entries)) return { cases: [], skipped: { 'unreadable-file': 1 } };

  const cases: any[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.label !== 'string' || typeof entry.passage !== 'string') { skip('bad-entry'); continue; }
    const built = buildInstructsReaderState({ passage: rot13(entry.passage), params: kind?.params });
    if (!built.ok) { skip(built.reason); continue; }
    cases.push({ id: caseId(entry.id), state: built.state, label: entry.label, rule: ruleScreen(built.text) });
  }
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cases, skipped };
}

const source = { id: 'instructs-reader-corpus', builderVersion: 1, labelIsRule: false, origin: 'package' as const, params: { corpusDigest: CORPUS_DIGEST, ruleDigest: RULE_DIGEST }, build };

module.exports = { source, build, CORPUS_DIGEST, RULE_DIGEST, computeDigests };

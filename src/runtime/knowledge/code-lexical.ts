'use strict';

const { readCorpusFile, compareText, CORPUS_LIMITS } = require('./code-corpus.ts');
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'as', 'by', 'at', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'do', 'does', 'did', 'how', 'what', 'when', 'which', 'who', 'why', 'not', 'no', 'yes', 'can']);

function classifyCodeQuery(query: any, { intent }: any = {}): any {
  if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query, 'utf8') > 4096) throw new Error('code query must contain 1..4096 UTF-8 bytes');
  const text = query.trim();
  let classificationBasis = 'rule-defaulted';
  let queryClass = 'conceptual';
  let literal = text;
  if (['exact', 'exact-lookup', 'code.exact-search', 'locate-known-symbol'].includes(intent)) { queryClass = 'exact'; classificationBasis = 'declared-exact'; }
  else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) { queryClass = 'exact'; classificationBasis = 'identifier'; }
  else if (/^(?:\.?\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+$/.test(text) && !text.split('/').includes('..')) { queryClass = 'exact'; classificationBasis = 'relative-path'; }
  else if (/^[A-Za-z0-9_@-]+\.[A-Za-z0-9_.-]+$/.test(text)) { queryClass = 'exact'; classificationBasis = 'relative-path'; }
  else if (['"', "'", String.fromCharCode(96)].some((quote: string) => text.startsWith(quote) && text.endsWith(quote))) {
    literal = text.slice(1, -1);
    if (!literal) throw new Error('quoted code query cannot be empty');
    queryClass = 'exact'; classificationBasis = 'quoted-literal';
  } else if (/\S+\s+\S+/.test(text)) classificationBasis = 'description';
  return { query: text, queryClass, classificationBasis, literal: queryClass === 'exact' ? literal : null };
}

function codeTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((word: string) => word.length >= 2 && !STOPWORDS.has(word)))];
}

/** Native bounded equivalent of B's per-term content/name ranking over admitted files only. */
function searchCodeLexical({ inventory, query, classification, intent, maxCandidates = 200, maxOutputBytes = 2 * 1024 * 1024, now = Date.now, timeoutMs = 2000, fsImpl, queryRef = null, retrievalAttemptRef = null }: any): any {
  const routed = classification || classifyCodeQuery(query, { intent });
  const started = now();
  const deadline = started + timeoutMs;
  const terms = routed.queryClass === 'exact' ? [] : codeTerms(routed.query);
  const rows: any[] = [];
  const rejected: any[] = [];
  const filesPerTerm = new Map<string, number>();
  let complete = Boolean(inventory.complete);
  let readBytes = 0;
  let searchedFiles = 0;
  // A binary-looking admitted file is a coverage gap (counted with its cause), not a provider fault:
  // `complete` stays the provider outcome while `coverage.complete` reports every unsearched file.
  const unsearched: any[] = [];
  const failures = (p: string, reason: string) => { complete = false; rejected.push({ path: p, reason }); };
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 200 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('invalid lexical output limits');
  for (const entry of inventory.files) {
    if (now() > deadline) { failures(entry.path, 'deadline'); break; }
    const read = readCorpusFile(inventory.root, entry, { fsImpl, maxBytes: CORPUS_LIMITS.maxFileBytes, now, deadline });
    readBytes += read.bytesRead;
    if (!read.ok) { failures(entry.path, read.reason); continue; }
    const text = read.content.toString('utf8');
    if (text.includes('\0')) { unsearched.push({ path: entry.path, reason: 'binary-source' }); continue; }
    searchedFiles += 1;
    if (routed.queryClass === 'exact') {
      const literal = routed.literal ?? routed.query;
      // A file whose text lacks the literal has no matching line; skip splitting it.
      const lines = text.includes(literal) ? text.split('\n') : [];
      let contentHit = false;
      for (let index = 0; index < lines.length; index += 1) {
        if (now() > deadline) { failures(entry.path, 'deadline'); break; }
        if (!lines[index].includes(literal)) continue;
        rows.push({ path: entry.path, line: index + 1, fileHash: read.fileHash });
        contentHit = true;
        if (rows.length > maxCandidates) break;
      }
      if (!contentHit && (entry.path === literal || entry.path.split('/').pop() === literal)) rows.push({ path: entry.path, line: 1, fileHash: read.fileHash });
      if (rows.length > maxCandidates) { failures(entry.path, 'candidate-limit'); break; }
    } else {
      const hits = new Map<string, any>();
      let total = 0;
      const lower = text.split('\n').map((line: string) => line.toLowerCase());
      for (const term of terms) {
        for (let index = 0; index < lower.length; index += 1) {
          if (now() > deadline) { failures(entry.path, 'deadline'); break; }
          if (!lower[index].includes(term)) continue;
          total += 1;
          if (!hits.has(term)) hits.set(term, { first: index + 1 });
        }
        if (hits.has(term)) filesPerTerm.set(term, (filesPerTerm.get(term) || 0) + 1);
      }
      const name = terms.filter((term: string) => entry.path.split('/').pop().toLowerCase().includes(term)).length;
      if (hits.size || name) rows.push({ path: entry.path, hits, name, total, score: hits.size + name, fileHash: read.fileHash });
    }
  }
  if (routed.queryClass === 'exact') rows.sort((a: any, b: any) => compareText(a.path, b.path) || a.line - b.line);
  else rows.sort((a: any, b: any) => b.score - a.score || b.total - a.total || compareText(a.path, b.path));
  if (rows.length > maxCandidates) failures('', 'candidate-limit');
  const candidates: any[] = [];
  let outputBytes = 2;
  for (const row of rows.slice(0, maxCandidates)) {
    const term = row.hits ? [...row.hits.keys()].sort((a: string, b: string) => (filesPerTerm.get(a) || 0) - (filesPerTerm.get(b) || 0) || compareText(a, b))[0] : null;
    const line = row.line ?? (term ? row.hits.get(term).first : 1);
    const candidate = { locator: { file: row.path, line, endLine: line }, provider: 'native.rg', capability: routed.queryClass === 'exact' ? 'code.exact-search' : 'code.semantic-search',
      queryRef, retrievalAttemptRef, sourceVersion: { gitCommit: null, fileHash: row.fileHash, isDirty: null }, rank: candidates.length + 1 };
    const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + 1;
    if (outputBytes + size > maxOutputBytes) { failures(row.path, 'output-byte-limit'); break; }
    outputBytes += size;
    candidates.push(candidate);
  }
  const skipped = [...rejected, ...unsearched];
  return { candidates, queryClass: routed.queryClass, classificationBasis: routed.classificationBasis,
    complete, coverage: { complete: complete && unsearched.length === 0, searchedFiles, skipped, skippedFiles: skipped.length,
      skippedByReason: skipped.reduce((counts: any, s: any) => ({ ...counts, [s.reason]: (counts[s.reason] || 0) + 1 }), {}) },
    accounting: { readBytes, outputBytes, rawCandidates: rows.length, elapsedMs: Math.max(0, now() - started) }, rejections: rejected };
}

module.exports = { classifyCodeQuery, codeTerms, searchCodeLexical };

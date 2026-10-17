'use strict';

const fs = require('node:fs');
const { readCorpusFile, relativeCodePath } = require('./code-corpus.ts');

const LIVE_LIMITS = Object.freeze({ maxFileBytes: 1024 * 1024, maxSnippetLines: 50, maxSnippetBytes: 16 * 1024, maxReadBytes: 1024 * 1024, timeoutMs: 1000, maxCandidates: 200 });

function readAdmittedFile(inventory: any, entry: any, options: any = {}): any {
  const rel = relativeCodePath(entry?.path);
  const admitted = inventory.files.find((f: any) => f.path === rel);
  if (!admitted) return { ok: false, reason: 'outside-corpus', bytesRead: 0 };
  return readCorpusFile(inventory.root, admitted, options);
}

function validateCodeCandidates({ inventory, candidates, topN = 10, limits: suppliedLimits, fsImpl = fs, now = Date.now }: any): any {
  const limits = { ...LIVE_LIMITS, ...suppliedLimits };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('invalid live limit ' + name);
  if (!Number.isInteger(topN) || topN < 1 || topN > 25) throw new Error('topN must be 1..25');
  const deadline = now() + limits.timeoutMs;
  const results: any[] = [];
  const rejected: any[] = [];
  let readBytes = 0;
  let examined = 0;
  let complete = Boolean(inventory.complete);
  // One live read per file per call: candidates on the same file share it (and its hash check) instead of
  // re-reading and re-charging the aggregate budget once per matching line.
  const reads = new Map<string, any>();
  const reject = (candidate: any, reason: string) => { rejected.push({ locator: candidate?.locator ?? null, reason }); complete = false; };
  for (const candidate of candidates) {
    if (results.length >= topN) break;
    if (examined >= limits.maxCandidates) { reject(candidate, 'candidate-limit'); break; }
    examined += 1;
    if (now() > deadline) { reject(candidate, 'deadline'); break; }
    const loc = candidate?.locator;
    if (!loc || !relativeCodePath(loc.file) || !Number.isInteger(loc.line) || !Number.isInteger(loc.endLine) || loc.line < 1 || loc.endLine < loc.line) { reject(candidate, 'invalid-locator'); continue; }
    const entry = inventory.files.find((f: any) => f.path === loc.file);
    if (!entry) { reject(candidate, 'outside-corpus'); continue; }
    let read = reads.get(entry.path);
    if (!read) {
      const remaining = limits.maxReadBytes - readBytes;
      if (remaining <= 0) { reject(candidate, 'read-byte-limit'); break; }
      read = readAdmittedFile(inventory, entry, { fsImpl, now, deadline, maxBytes: Math.min(limits.maxFileBytes, remaining) });
      readBytes += read.bytesRead;
      reads.set(entry.path, read); // budget and deadline only shrink, so a refusal stays a refusal
    }
    if (!read.ok) { reject(candidate, read.reason); continue; }
    const searchedHashes = [candidate.sourceVersion?.fileHash, ...(candidate.origins || []).map((o: any) => o.sourceVersion?.fileHash || o.indexedSourceHash)].filter(Boolean);
    if (searchedHashes.some((hash: string) => hash !== read.fileHash)) { reject(candidate, 'source-changed'); continue; }
    const text = read.content.toString('utf8');
    if (text.includes('\0')) { reject(candidate, 'binary-source'); continue; }
    const lines = text.split('\n');
    if (loc.endLine > lines.length) { reject(candidate, 'line-out-of-range'); continue; }
    const endLine = Math.min(loc.endLine, loc.line + limits.maxSnippetLines - 1);
    let snippet = lines.slice(loc.line - 1, endLine).join('\n');
    let byteTruncated = false;
    if (Buffer.byteLength(snippet, 'utf8') > limits.maxSnippetBytes) {
      let bytes = 0;
      let bounded = '';
      for (const char of snippet) {
        const size = Buffer.byteLength(char, 'utf8');
        if (bytes + size > limits.maxSnippetBytes) break;
        bounded += char; bytes += size;
      }
      snippet = bounded; byteTruncated = true;
    }
    const { snippet: suppliedSnippet, liveRead: suppliedRead, ...safeCandidate } = candidate;
    results.push({ ...safeCandidate, snippet, sourceVersion: { gitCommit: candidate.sourceVersion?.gitCommit ?? null, fileHash: read.fileHash, isDirty: candidate.sourceVersion?.isDirty ?? null },
      liveRead: { startLine: loc.line, endLine: byteTruncated ? loc.line + snippet.split('\n').length - 1 : endLine, totalFileLines: lines.length, bytesRead: read.bytesRead, snippetBytes: Buffer.byteLength(snippet, 'utf8'), truncated: byteTruncated || endLine < loc.endLine } });
  }
  return { results, rejected, complete, coverage: { complete, examinedCandidates: examined, rejectedCandidates: rejected.length }, accounting: { readBytes, deliveredCandidates: results.length, examinedCandidates: examined } };
}

/** Explicit score-free adapter input. The existing ledger stamps query/task attempt refs. */
function projectEvidenceCandidates(candidate: any, { need }: any = {}): any[] {
  if (!candidate?.liveRead || typeof candidate.snippet !== 'string' || !candidate.sourceVersion?.fileHash) throw new Error('candidate requires a validated live read before evidence projection');
  const out: any[] = [];
  const seen = new Set<string>();
  const origins = candidate.origins?.length ? candidate.origins : [{ provider: candidate.provider, capability: candidate.capability }];
  for (const origin of origins) {
    if (!origin.provider || !origin.capability) throw new Error('evidence origin needs a provider and capability');
    const key = origin.provider + '\0' + origin.capability;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ candidate: { locator: { file: candidate.locator.file, line: candidate.locator.line }, provider: origin.provider, capability: origin.capability,
      ...(need ? { need } : {}), sourceVersion: { ...candidate.sourceVersion } }, content: candidate.snippet });
  }
  return out;
}

module.exports = { LIVE_LIMITS, readAdmittedFile, validateCodeCandidates, projectEvidenceCandidates };

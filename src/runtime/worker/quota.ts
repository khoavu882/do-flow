'use strict';

// Feature 106 IC-002: recognise declared quota signals in a bounded, masked report summary.
//
// `matchQuota(summary, signals)` reads at most the first 2,000 UTF-8 bytes of `summary` (cut without
// splitting a character), lowercases both sides and searches literal substrings, no regular
// expression. It returns the first matching signal in declaration order, as declared, or null. The
// signals are registry data (a harness's `structuredOutput.quotaSignals`): this module names no
// harness, provider or model. Pure: no I/O.

const QUOTA_SCAN_BYTES = 2000;

/** `text` cut to at most `max` UTF-8 bytes without splitting a character. */
function cutBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // back off a continuation byte
  return bytes.subarray(0, end).toString('utf8');
}

function matchQuota(summary: string | null, signals: string[]): string | null {
  if (typeof summary !== 'string' || !summary || !Array.isArray(signals) || signals.length === 0) return null;
  const text = cutBytes(summary, QUOTA_SCAN_BYTES).toLowerCase();
  for (const signal of signals) {
    if (typeof signal === 'string' && text.includes(signal.toLowerCase())) return signal;
  }
  return null;
}

/**
 * IC-002: the `report.quota` a finished run's report carries, or null. Only a `failure` report can
 * carry it, and only when its summary matches the descriptor's `structuredOutput.quotaSignals`;
 * `success`, `denied` and `unparsed` never do.
 */
function quotaOf(report: any, descriptor: any): { signal: string; basis: string } | null {
  if (!report || report.status !== 'failure') return null;
  const quotaSignals = descriptor?.structuredOutput?.quotaSignals;
  const signal = matchQuota(report.summary ?? null, quotaSignals?.signals);
  return signal ? { signal, basis: quotaSignals.basis } : null;
}

module.exports = { matchQuota, quotaOf, QUOTA_SCAN_BYTES };

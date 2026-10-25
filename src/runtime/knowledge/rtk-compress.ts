'use strict';

interface RTKCompressionResult {
  rawChars: number;
  compressedChars: number;
  ratio: number;
  formattedOutput: string;
  locatorsPreserved: boolean;
}

function formatWithRTK(
  resolution: any,
  options?: { maxLines?: number }
): RTKCompressionResult {
  const rawJson = JSON.stringify(resolution, null, 2);
  const rawChars = rawJson.length;

  const lines: string[] = [];
  const statusMark = resolution.status === 'HEALTHY' ? '✓' : resolution.status === 'FALLBACK' ? '▲' : '✗';
  lines.push(`${statusMark} [${resolution.provider}] query: "${resolution.query}" (status: ${resolution.status}, freshness: ${resolution.freshness})`);

  if (resolution.fallbackReason) {
    lines.push(`  fallback-reason: ${resolution.fallbackReason}`);
  }

  if (resolution.isAbsence) {
    lines.push(`  absence: true (${resolution.absenceReason || 'zero occurrences'})`);
  }

  const maxLines = options?.maxLines ?? 50;
  const candidates = Array.isArray(resolution.candidates) ? resolution.candidates : [];
  const totalCandidates = candidates.length;
  const displayedCandidates = candidates.slice(0, maxLines);

  for (const cand of displayedCandidates) {
    const loc = cand.locator || {};
    const fileLine = loc.line !== undefined ? `${loc.file}:${loc.line}` : loc.file;
    const relStr = cand.relation ? ` [${cand.relation}]` : '';
    const symStr = loc.symbol ? ` ${loc.symbol}` : '';
    const scoreStr = typeof cand.score === 'number' ? ` (${cand.score.toFixed(2)})` : '';
    lines.push(`  #${cand.rank ?? 0} ${fileLine}${symStr}${relStr}${scoreStr}`);
  }

  if (totalCandidates > maxLines) {
    lines.push(`  ... (${totalCandidates - maxLines} more candidates truncated)`);
  }

  const formattedOutput = lines.join('\n');
  const compressedChars = formattedOutput.length;
  const ratio = rawChars > 0 ? Number((compressedChars / rawChars).toFixed(3)) : 1.0;

  let locatorsPreserved = true;
  for (const cand of displayedCandidates) {
    const loc = cand.locator;
    if (!loc || !loc.file) continue;
    if (!formattedOutput.includes(loc.file)) {
      locatorsPreserved = false;
      break;
    }
    if (loc.line !== undefined && !formattedOutput.includes(`${loc.file}:${loc.line}`)) {
      locatorsPreserved = false;
      break;
    }
  }

  return {
    rawChars,
    compressedChars,
    ratio,
    formattedOutput,
    locatorsPreserved,
  };
}

module.exports = {
  formatWithRTK,
};

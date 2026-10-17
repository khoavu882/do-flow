'use strict';

function identityInlineConfigHomeBlock(file, text) {
  if (file !== 'core/harnesses/shared/hooks/policies/identity.sh') return null;
  const lines = text.split('\n');
  const marker = lines.findIndex((line) => line.includes('doflow-config-home v1 inline copy'));
  if (marker < 0) return null;
  for (let end = marker + 1; end < lines.length; end++) {
    if (/^\s*fi\s*$/.test(lines[end])) {
      return { start: marker, end, text: lines.slice(marker + 1, end + 1).join('\n') };
    }
  }
  return { start: marker, end: marker, text: '' };
}

module.exports = { identityInlineConfigHomeBlock };

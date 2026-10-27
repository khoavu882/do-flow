'use strict';

const FORBIDDEN_DECISION_KEYS = Object.freeze([
  'verdict',
  'gate',
  'taskClass',
  'decision',
  'approved',
  'pass',
  'disagreement',
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_DECISION_KEYS.map((k) => k.toLowerCase()));

interface SanitizeResult {
  data: any;
  sanitized: boolean;
  strippedKeys: string[];
  refused?: boolean;
  refusalReason?: string;
}

function sanitizeCapabilityOutput(output: any): SanitizeResult {
  if (output === null || output === undefined) {
    return { data: output, sanitized: false, strippedKeys: [] };
  }

  if (typeof output !== 'object') {
    return { data: output, sanitized: false, strippedKeys: [] };
  }

  const strippedKeys: string[] = [];
  let refused = false;
  let refusalReason: string | undefined;

  if (!Array.isArray(output) && typeof output === 'object') {
    for (const [key, val] of Object.entries(output)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'verdict') {
        const strVal = String(val).trim().toUpperCase();
        if (strVal === 'PASS' || strVal === 'FAIL') {
          refused = true;
          refusalReason = 'DECISION_INJECTION_REFUSED';
        }
      } else if (lowerKey === 'gate') {
        const strVal = String(val).trim().toUpperCase();
        if (strVal === 'APPROVED') {
          refused = true;
          refusalReason = 'DECISION_INJECTION_REFUSED';
        }
      }
    }
  }

  function clean(val: any): any {
    if (val === null || val === undefined) return val;
    if (Array.isArray(val)) {
      return val.map((item) => clean(item));
    }
    if (typeof val === 'object') {
      const cleanedObj: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) {
        if (FORBIDDEN_SET.has(k.toLowerCase())) {
          strippedKeys.push(k);
        } else {
          cleanedObj[k] = clean(v);
        }
      }
      return cleanedObj;
    }
    return val;
  }

  const data = clean(output);
  const sanitized = strippedKeys.length > 0;

  return {
    data,
    sanitized,
    strippedKeys,
    ...(refused ? { refused: true, refusalReason } : {}),
  };
}

module.exports = {
  FORBIDDEN_DECISION_KEYS,
  sanitizeCapabilityOutput,
};

'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const crypto = require('node:crypto');
const {
  section,
  row,
  joinWrapped,
  parseRequirement,
} = require('../scaffold/artifacts.ts');

const VALID_MANDATORY_KEYS = new Set([
  'objective',
  'acceptanceCriteria',
  'constraints',
  'verificationRequirements',
  'scopeExcluded',
  'blockingGaps',
]);

/**
 * Extracts mandatory fields and provenance from requirement.md text per IC-010.
 * Pure function: text in, structure out. Never throws.
 */
function extractMandatory({
  text = null,
  path: filePath = 'requirement.md',
  maturity = null,
  featureError = null,
  taskStories = [],
}: any = {}): any {
  const fields: Record<string, any> = {
    objective: null,
    acceptanceCriteria: [],
    constraints: [],
    verificationRequirements: [],
    scopeExcluded: [],
    blockingGaps: [],
  };

  const provenance: Record<string, any> = {};

  const fieldKeys = Object.keys(fields);

  // Failure cases: feature error or artifact absent
  if (featureError) {
    const errorMsg = typeof featureError === 'object' && featureError !== null
      ? (featureError.message || featureError.error)
      : String(featureError);
    for (const k of fieldKeys) {
      provenance[k] = {
        supplied: false,
        source: 'none',
        locator: null,
        digest: null,
        maturity: null,
        reason: `no-active-feature: ${errorMsg}`,
        gaps: [],
      };
    }
    return { fields, provenance };
  }

  if (text === null || text === undefined) {
    for (const k of fieldKeys) {
      provenance[k] = {
        supplied: false,
        source: 'none',
        locator: null,
        digest: null,
        maturity: null,
        reason: 'artifact-absent',
        gaps: [],
      };
    }
    return { fields, provenance };
  }

  const rawDigest = crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  const digest = `sha256:${rawDigest}`;

  const parsedReq = parseRequirement(text);

  let resolvedMaturity = maturity ?? null;
  if (resolvedMaturity === null) {
    const maturityMatch = text.match(/\*\*Maturity:\*\*\s*([^·\r\n]+)/i);
    resolvedMaturity = maturityMatch ? maturityMatch[1].trim() : null;
  }

  // 1. Objective: ## 1. Summary
  const summaryBody = section(text, /Summary/i);
  if (summaryBody === null) {
    provenance.objective = {
      supplied: false,
      source: 'none',
      locator: null,
      digest,
      maturity: resolvedMaturity,
      reason: 'artifact-malformed: Summary missing',
      gaps: [],
    };
  } else {
    const trimmed = summaryBody.trim();
    if (trimmed === '') {
      provenance.objective = {
        supplied: false,
        source: 'none',
        locator: null,
        digest,
        maturity: resolvedMaturity,
        reason: 'artifact-malformed: Summary holds no items',
        gaps: [],
      };
    } else if (/^none\b/i.test(trimmed)) {
      fields.objective = null;
      provenance.objective = {
        supplied: true,
        source: 'requirement',
        locator: `${filePath}#1-summary`,
        digest,
        maturity: resolvedMaturity,
        reason: 'none-in-artifact',
        gaps: [],
      };
    } else {
      // First paragraph, joined to one line
      const firstPara = trimmed.split(/\n\s*\n/)[0].replace(/\n+/g, ' ').trim();
      fields.objective = firstPara;
      provenance.objective = {
        supplied: true,
        source: 'requirement',
        locator: `${filePath}#1-summary`,
        digest,
        maturity: resolvedMaturity,
        reason: null,
        gaps: [],
      };
    }
  }

  // 2. Acceptance Criteria & Verification Requirements: ## 6. Acceptance Criteria
  const acceptanceBody = section(text, /Acceptance Criteria/i);
  if (acceptanceBody === null) {
    const acGaps = (parsedReq?.gaps || []).filter((g: any) => g.what === 'acceptance criteria');
    provenance.acceptanceCriteria = {
      supplied: false,
      source: 'none',
      locator: null,
      digest,
      maturity: resolvedMaturity,
      reason: 'artifact-malformed: Acceptance Criteria missing',
      gaps: acGaps,
    };
    provenance.verificationRequirements = {
      supplied: false,
      source: 'none',
      locator: null,
      digest,
      maturity: resolvedMaturity,
      reason: 'artifact-malformed: Acceptance Criteria missing',
      gaps: acGaps,
    };
  } else {
    const lines = joinWrapped(acceptanceBody);
    const allCriteriaLines: string[] = [];
    for (const l of lines) {
      const match = l.match(/^-\s*\[[ xX]\]\s*(.+?)\s*$/);
      if (match) allCriteriaLines.push(match[1]);
    }

    if (allCriteriaLines.length === 0) {
      const acGaps = (parsedReq?.gaps || []).filter((g: any) => g.what === 'acceptance criteria');
      provenance.acceptanceCriteria = {
        supplied: false,
        source: 'none',
        locator: null,
        digest,
        maturity: resolvedMaturity,
        reason: 'artifact-malformed: Acceptance Criteria holds no items',
        gaps: acGaps,
      };
      provenance.verificationRequirements = {
        supplied: false,
        source: 'none',
        locator: null,
        digest,
        maturity: resolvedMaturity,
        reason: 'artifact-malformed: Acceptance Criteria holds no items',
        gaps: acGaps,
      };
    } else {
      const scenarioLines = allCriteriaLines.filter((l) => /^\*\*Scenario:/i.test(l));
      const nonScenarioLines = allCriteriaLines.filter((l) => !/^\*\*Scenario:/i.test(l));

      let acSourceLines: string[];
      let vrSourceLines: string[];

      if (scenarioLines.length > 0) {
        acSourceLines = scenarioLines;
        vrSourceLines = nonScenarioLines;
      } else {
        acSourceLines = allCriteriaLines;
        vrSourceLines = allCriteriaLines;
      }

      // Assign ids in document order, then order items for the task's stories.
      const identifiedAcLines = acSourceLines.map((stmt, idx) => ({
        stmt,
        id: `ac:${idx + 1}`,
      }));
      let sortedAcLines = [...identifiedAcLines];
      if (Array.isArray(taskStories) && taskStories.length > 0) {
        sortedAcLines.sort((a, b) => {
          const aMatch = taskStories.some((s) => a.stmt.includes(s));
          const bMatch = taskStories.some((s) => b.stmt.includes(s));
          return Number(bMatch) - Number(aMatch);
        });
      }

      fields.acceptanceCriteria = sortedAcLines.map(({ stmt, id }) => {
        const ids = [...new Set(stmt.match(/N?FR-\d+/g) || [])].sort();
        const stories = stmt.match(/US\d+/g) || [];
        return {
          id,
          text: stmt,
          requirements: ids,
          stories,
        };
      });

      provenance.acceptanceCriteria = {
        supplied: true,
        source: 'requirement',
        locator: `${filePath}#6-acceptance-criteria`,
        digest,
        maturity: resolvedMaturity,
        reason: null,
        gaps: [],
      };

      fields.verificationRequirements = vrSourceLines.map((stmt, idx) => ({
        id: `vr:${idx + 1}`,
        text: stmt,
      }));

      provenance.verificationRequirements = {
        supplied: true,
        source: 'requirement',
        locator: `${filePath}#6-acceptance-criteria`,
        digest,
        maturity: resolvedMaturity,
        reason: vrSourceLines.length === 0 ? 'none-in-artifact' : null,
        gaps: [],
      };
    }
  }

  // 3. Constraints: ## 4. Non-Functional Requirements index
  const nfrBody = section(text, /Non-Functional Requirements/i);
  if (nfrBody === null) {
    provenance.constraints = {
      supplied: false,
      source: 'none',
      locator: null,
      digest,
      maturity: resolvedMaturity,
      reason: 'artifact-malformed: Non-Functional Requirements missing',
      gaps: [],
    };
  } else {
    const trimmedNfr = nfrBody.trim();
    const rows: string[][] = [];
    for (const l of trimmedNfr.split('\n')) {
      const cells = row(l);
      if (cells && cells.length >= 2) rows.push(cells);
    }

    const nfrRows = rows.filter((cells) => /^NFR-\d+$/i.test(cells[0].replace(/`/g, '').trim()));

    if (nfrRows.length === 0) {
      if (/^none\b/i.test(trimmedNfr)) {
        provenance.constraints = {
          supplied: true,
          source: 'requirement',
          locator: `${filePath}#4-non-functional-requirements`,
          digest,
          maturity: resolvedMaturity,
          reason: 'none-in-artifact',
          gaps: [],
        };
      } else {
        provenance.constraints = {
          supplied: false,
          source: 'none',
          locator: null,
          digest,
          maturity: resolvedMaturity,
          reason: 'artifact-malformed: Non-Functional Requirements holds no items',
          gaps: [],
        };
      }
    } else {
      // Exclude Superseded rows
      const activeRows = nfrRows.filter((cells) => !cells.some((c) => /superseded/i.test(c)));
      fields.constraints = activeRows.map((cells) => {
        const id = cells[0].replace(/`/g, '').trim();
        const constraintText = cells[1];
        const kind = cells[2] || 'constraint';
        return {
          id,
          text: constraintText,
          kind,
        };
      });

      provenance.constraints = {
        supplied: true,
        source: 'requirement',
        locator: `${filePath}#4-non-functional-requirements`,
        digest,
        maturity: resolvedMaturity,
        reason: null,
        gaps: [],
      };
    }
  }

  // 4. Out of Scope: ## 5. Out of Scope
  const scopeBody = section(text, /Out of Scope/i);
  if (scopeBody === null) {
    provenance.scopeExcluded = {
      supplied: false,
      source: 'none',
      locator: null,
      digest,
      maturity: resolvedMaturity,
      reason: 'artifact-malformed: Out of Scope missing',
      gaps: [],
    };
  } else {
    const trimmedScope = scopeBody.trim();
    if (/^none\b/i.test(trimmedScope)) {
      fields.scopeExcluded = [];
      provenance.scopeExcluded = {
        supplied: true,
        source: 'requirement',
        locator: `${filePath}#5-out-of-scope`,
        digest,
        maturity: resolvedMaturity,
        reason: 'none-in-artifact',
        gaps: [],
      };
    } else {
      const bullets = trimmedScope
        .split('\n')
        .filter((l: any) => /^[-*]\s+/.test(l.trim()))
        .map((l: any) => l.trim().replace(/^[-*]\s+/, ''));

      if (bullets.length === 0) {
        provenance.scopeExcluded = {
          supplied: false,
          source: 'none',
          locator: null,
          digest,
          maturity: resolvedMaturity,
          reason: 'artifact-malformed: Out of Scope holds no items',
          gaps: [],
        };
      } else {
        fields.scopeExcluded = bullets.map((b: any, idx: number) => {
          // The bold lead of each bullet, plus its owner clause when present
          const leadMatch = b.match(/\*\*(.+?)\*\*/);
          const ownerMatch = b.match(/\(owner:\s*([^)]+)\)|—\s*owner\s+([^\s(;]+)(?:\s*\([^)]*\))?/i);
          let lead = leadMatch ? leadMatch[1] : b;
          if (ownerMatch) lead += ` (owner: ${(ownerMatch[1] || ownerMatch[2]).trim()})`;
          return {
            id: `scope:${idx + 1}`,
            text: lead,
          };
        });

        provenance.scopeExcluded = {
          supplied: true,
          source: 'requirement',
          locator: `${filePath}#5-out-of-scope`,
          digest,
          maturity: resolvedMaturity,
          reason: null,
          gaps: [],
        };
      }
    }
  }

  // 5. Blocking Gaps: ## 7. Open Questions
  const gapsBody = section(text, /Open Questions/i);
  if (gapsBody === null) {
    provenance.blockingGaps = {
      supplied: false,
      source: 'none',
      locator: null,
      digest,
      maturity: resolvedMaturity,
      reason: 'artifact-malformed: Open Questions missing',
      gaps: [],
    };
  } else {
    const trimmedGaps = gapsBody.trim();
    if (/^none\b/i.test(trimmedGaps)) {
      fields.blockingGaps = [];
      provenance.blockingGaps = {
        supplied: true,
        source: 'requirement',
        locator: `${filePath}#7-open-questions`,
        digest,
        maturity: resolvedMaturity,
        reason: 'none-in-artifact',
        gaps: [],
      };
    } else {
      const bullets = trimmedGaps
        .split('\n')
        .filter((l: any) => /^[-*]\s+/.test(l.trim()))
        .map((l: any) => l.trim().replace(/^[-*]\s+/, ''));

      if (bullets.length === 0) {
        provenance.blockingGaps = {
          supplied: false,
          source: 'none',
          locator: null,
          digest,
          maturity: resolvedMaturity,
          reason: 'artifact-malformed: Open Questions holds no items',
          gaps: [],
        };
      } else {
        fields.blockingGaps = bullets.map((textLine: any, idx: number) => ({
          id: `gap:${idx + 1}`,
          text: textLine,
          source: 'requirement',
        }));

        provenance.blockingGaps = {
          supplied: true,
          source: 'requirement',
          locator: `${filePath}#7-open-questions`,
          digest,
          maturity: resolvedMaturity,
          reason: null,
          gaps: [],
        };
      }
    }
  }

  return { fields, provenance };
}

/**
 * Parses caller-supplied --mandatory-file JSON per IC-011.
 * Validates keys, types, and produces caller items with c<n> ids.
 */
function parseMandatoryFile(inputContent: string, inputPath: string = 'stdin'): any {
  let parsed: any;
  try {
    parsed = JSON.parse(inputContent);
  } catch (err: any) {
    const error: any = new Error(`--mandatory-file is not valid JSON: ${err.message}`);
    error.code = 'USAGE_ERROR';
    throw error;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error: any = new Error('--mandatory-file must be a JSON object');
    error.code = 'USAGE_ERROR';
    throw error;
  }

  for (const key of Object.keys(parsed)) {
    if (!VALID_MANDATORY_KEYS.has(key)) {
      const error: any = new Error(`--mandatory-file contains unknown key '${key}'. Valid keys: ${[...VALID_MANDATORY_KEYS].join(', ')}`);
      error.code = 'USAGE_ERROR';
      throw error;
    }
  }

  const digest = `sha256:${crypto.createHash('sha256').update(Buffer.from(inputContent, 'utf8')).digest('hex')}`;
  const locator = inputPath === '-' ? 'stdin' : inputPath;

  const fields: Record<string, any> = {};
  const provenance: Record<string, any> = {};

  if ('objective' in parsed) {
    if (typeof parsed.objective !== 'string') {
      const error: any = new Error('--mandatory-file: objective must be a string');
      error.code = 'USAGE_ERROR';
      throw error;
    }
    fields.objective = parsed.objective;
    provenance.objective = {
      supplied: true,
      source: 'caller',
      locator,
      digest,
      maturity: null,
      reason: null,
      gaps: [],
    };
  }

  const listConfigs: Record<string, { prefix: string; buildItem: (text: string, id: string) => any }> = {
    acceptanceCriteria: {
      prefix: 'ac',
      buildItem: (text, id) => ({ id, text, requirements: [], stories: [] }),
    },
    constraints: {
      prefix: 'nfr',
      buildItem: (text, id) => ({ id, text, kind: 'constraint' }),
    },
    verificationRequirements: {
      prefix: 'vr',
      buildItem: (text, id) => ({ id, text }),
    },
    scopeExcluded: {
      prefix: 'scope',
      buildItem: (text, id) => ({ id, text }),
    },
    blockingGaps: {
      prefix: 'gap',
      buildItem: (text, id) => ({ id, text, source: 'caller' }),
    },
  };

  for (const [key, config] of Object.entries(listConfigs)) {
    if (key in parsed) {
      const val = parsed[key];
      if (!Array.isArray(val) || val.some((item) => typeof item !== 'string')) {
        const error: any = new Error(`--mandatory-file: ${key} must be an array of strings`);
        error.code = 'USAGE_ERROR';
        throw error;
      }
      if (val.length === 0) {
        fields[key] = [];
        provenance[key] = {
          supplied: true,
          source: 'caller',
          locator,
          digest,
          maturity: null,
          reason: 'caller-supplied-empty',
          gaps: [],
        };
      } else {
        fields[key] = val.map((text, idx) => config.buildItem(text, `${config.prefix}:c${idx + 1}`));
        provenance[key] = {
          supplied: true,
          source: 'caller',
          locator,
          digest,
          maturity: null,
          reason: null,
          gaps: [],
        };
      }
    }
  }

  return { fields, provenance };
}

/**
 * Replaces derived fields whole with caller overrides (IC-011).
 * Never merges lists.
 */
function applyMandatoryOverride(derived: any, override: any): any {
  if (!override) return derived;
  const fields = { ...derived.fields };
  const provenance = { ...derived.provenance };

  for (const [key, val] of Object.entries(override.fields)) {
    fields[key] = val;
    provenance[key] = override.provenance[key];
  }

  return { fields, provenance };
}

module.exports = {
  VALID_MANDATORY_KEYS,
  extractMandatory,
  parseMandatoryFile,
  applyMandatoryOverride,
};

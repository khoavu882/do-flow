'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { qualifiedId, projectedName } = require('../../helper/package-ids.ts');

function readFrontmatter(text: any): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const values: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const item = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!item || Object.hasOwn(values, item[1])) return null;
    let value = item[2].trim();
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"')) return null;
      value = value.slice(1, -1);
    } else if (value.endsWith('"')) return null;
    values[item[1]] = value;
  }
  return values;
}

function finding(field: string, code: string, message: string, allowed: any): any {
  return { field, code, message, allowed };
}

function judgeInstruction(validatorKey: string, localId: string, realPath: string, { packageId, fsImpl = fs }: any): any[] {
  const findings: any[] = [];
  const qualified = qualifiedId(packageId, localId);
  const name = qualified ? projectedName(qualified) : null;
  if (!name) return [finding('.name', 'contribution-invalid', 'the projected instruction name cannot be derived', 'a valid package and local id')];

  if (validatorKey === 'skill-v1') {
    let skillFile: string;
    try {
      skillFile = path.join(realPath, 'SKILL.md');
      if (!fsImpl.statSync(skillFile).isFile()) {
        return [finding('.file', 'file-missing', 'SKILL.md is not a regular file in the skill directory', 'a regular SKILL.md file')];
      }
    } catch {
      return [finding('.file', 'file-missing', 'SKILL.md is missing from the skill directory', 'a regular SKILL.md file')];
    }
    if (path.basename(realPath) !== name) {
      findings.push(finding('.dir', 'name-mismatch', `skill directory name must be '${name}'`, name));
    }
    let metadata: Record<string, string> | null;
    try {
      metadata = readFrontmatter(fsImpl.readFileSync(skillFile, 'utf8'));
    } catch {
      metadata = null;
    }
    if (!metadata) findings.push(finding('', 'contribution-invalid', 'SKILL.md must begin with valid name/value frontmatter', 'frontmatter between --- lines'));
    else if (!metadata.name) findings.push(finding('.name', 'contribution-invalid', 'skill frontmatter name is required', name));
    else if (metadata.name !== name) findings.push(finding('.name', 'name-mismatch', `skill frontmatter name must be '${name}'`, name));
    return findings;
  }

  if (validatorKey === 'agent-v1') {
    let metadata: Record<string, string> | null;
    try {
      metadata = readFrontmatter(fsImpl.readFileSync(realPath, 'utf8'));
    } catch {
      metadata = null;
    }
    if (!metadata) return [finding('', 'contribution-invalid', 'agent file must begin with valid name/value frontmatter', 'frontmatter between --- lines')];
    if (!metadata.name) findings.push(finding('.name', 'contribution-invalid', 'agent frontmatter name is required', name));
    else if (metadata.name !== name) findings.push(finding('.name', 'name-mismatch', `agent frontmatter name must be '${name}'`, name));
    if (typeof metadata.description !== 'string' || metadata.description.length < 1 || metadata.description.length > 160) {
      findings.push(finding('.description', 'contribution-invalid', 'agent description must be 1 to 160 characters', '1 to 160 characters'));
    }
    if (metadata.access !== 'read-only' && metadata.access !== 'write') {
      findings.push(finding('.access', 'contribution-invalid', "agent access must be 'read-only' or 'write'", ['read-only', 'write']));
    }
    return findings;
  }

  return [finding('', 'contribution-invalid', `unknown instruction validator '${validatorKey}'`, ['skill-v1', 'agent-v1'])];
}

function skillValidator(localId: any, realPath: any, context: any = {}): string[] {
  return judgeInstruction('skill-v1', localId, realPath, context).map((item: any) => item.message);
}

function agentValidator(localId: any, realPath: any, context: any = {}): string[] {
  return judgeInstruction('agent-v1', localId, realPath, context).map((item: any) => item.message);
}

module.exports = { judgeInstruction, skillValidator, agentValidator };

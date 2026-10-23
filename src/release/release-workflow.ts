'use strict';

// Finding ids are a stable interface: IC-004 keeps R1-R12 and adds R13-R14.
// R3/R4 cover write-all, flow-map, and alias forms; R9 checks every publish invocation.
const RELEASE_WORKFLOW_RULE_IDS = Object.freeze([
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14',
]);

type WorkflowJob = {
  needs: string[],
  permissions: string | null,
  uses: string[],
  text: string,
  line: number,
};

type ParsedWorkflow = {
  topPermissions: string | null,
  jobs: Map<string, WorkflowJob>,
};

function indentation(line: string): number {
  return (line.match(/^ */) || [''])[0].length;
}

function stripInlineComment(value: string): string {
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (quote === "'" && character === "'" && value[index + 1] === "'") {
        index++;
      } else if (character === quote && !isEscaped(value, index)) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function stripYamlComments(text: string): string {
  const source = String(text);
  let quote = '';
  let result = '';
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (quote === "'" && character === "'" && source[index + 1] === "'") {
        result += "''";
        index++;
      } else {
        if (character === quote && !isEscaped(source, index)) quote = '';
        result += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(source[index - 1]))) {
      while (index < source.length && source[index] !== '\n') index++;
      if (index < source.length) result += '\n';
      continue;
    }
    result += character;
  }
  return result.split(/\r?\n/).map((line) => line.trimEnd()).join('\n');
}

function blockValue(lines: string[], lineIndex: number, keyIndent: number, inline: string): string {
  const value = stripInlineComment(inline).trim();
  if (value) return value;

  const contents: string[] = [];
  for (let index = lineIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentation(line) <= keyIndent) break;
    contents.push(line.trim());
  }
  return contents.join('\n');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseNeeds(value: string): string[] {
  const clean = stripInlineComment(value).trim();
  if (!clean) return [];
  if (clean.startsWith('[') && clean.endsWith(']')) {
    return clean.slice(1, -1).split(',').map(unquote).filter(Boolean);
  }
  const blockItems = clean.split(/\r?\n/).map((line) => line.match(/^\s*-\s*(.*?)\s*$/));
  if (blockItems.every(Boolean)) {
    return blockItems.map((match) => unquote((match as RegExpMatchArray)[1])).filter(Boolean);
  }
  return [unquote(clean)];
}

function topLevelBlock(lines: string[], key: string): { start: number, end: number } | null {
  const header = new RegExp('^' + key + ':\\s*(?:#.*)?$');
  const start = lines.findIndex((line) => indentation(line) === 0 && header.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (!lines[index].trim() || lines[index].trimStart().startsWith('#')) continue;
    if (indentation(lines[index]) === 0) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function parseWorkflow(text: string): ParsedWorkflow {
  const lines = stripYamlComments(text).split(/\r?\n/);
  let topPermissions: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^permissions:\s*(.*)$/);
    if (match) {
      topPermissions = blockValue(lines, index, 0, match[1]);
      break;
    }
  }

  const jobsBlock = topLevelBlock(lines, 'jobs');
  const jobs = new Map<string, WorkflowJob>();
  if (!jobsBlock) return { topPermissions, jobs };

  const jobHeaders: Array<{ id: string, start: number }> = [];
  for (let index = jobsBlock.start + 1; index < jobsBlock.end; index++) {
    const match = lines[index].match(/^ {2}("[A-Za-z0-9_-]+"|'[A-Za-z0-9_-]+'|[A-Za-z0-9_-]+):\s*$/);
    if (match) jobHeaders.push({ id: unquote(match[1]), start: index });
  }

  for (let index = 0; index < jobHeaders.length; index++) {
    const header = jobHeaders[index];
    const end = index + 1 < jobHeaders.length ? jobHeaders[index + 1].start : jobsBlock.end;
    const jobLines = lines.slice(header.start, end);
    let needs: string[] = [];
    let permissions: string | null = null;
    const uses: string[] = [];

    for (let offset = 1; offset < jobLines.length; offset++) {
      const line = jobLines[offset];
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const fieldIndent = indentation(line);
      if (fieldIndent === 4) {
        const needsMatch = line.match(/^ {4}needs:\s*(.*)$/);
        if (needsMatch) needs = parseNeeds(blockValue(jobLines, offset, 4, needsMatch[1]));
        const permissionMatch = line.match(/^ {4}permissions:\s*(.*)$/);
        if (permissionMatch) {
          permissions = blockValue(jobLines, offset, 4, permissionMatch[1]);
        }
      }
      const usesMatch = line.match(/^\s*(?:-\s*)?uses:\s*(.*?)\s*$/);
      if (usesMatch) uses.push(stripInlineComment(usesMatch[1]).trim());
    }

    jobs.set(header.id, {
      needs,
      permissions,
      uses,
      text: jobLines.join('\n'),
      line: header.start + 1,
    });
  }

  return { topPermissions, jobs };
}

function hasPermission(permissions: string | null, name: string, access: string): boolean {
  if (permissions === null) return false;
  if (access === 'write' && unquote(permissions) === 'write-all') return true;
  const blockPattern = new RegExp('(?:^|\\n)\\s*' + name + '\\s*:\\s*' + access + '\\b');
  const flowMapPattern = new RegExp('(?:^|[,{])\\s*["\']?' + name
    + '["\']?\\s*:\\s*["\']?' + access + '["\']?(?=\\s*[,}])');
  return blockPattern.test(permissions) || flowMapPattern.test(permissions);
}

function hasYamlAliasOrAnchor(text: string): boolean {
  const source = String(text);
  let quote = '';
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (quote === "'" && character === "'" && source[index + 1] === "'") {
        index++;
      } else if (character === quote && !isEscaped(source, index)) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    const previous = source[index - 1];
    const tokenBoundary = previous === undefined || /\s/.test(previous)
      || [':', ',', '{', '['].includes(previous);
    if (source.startsWith('<<:', index) && tokenBoundary) return true;
    if ((character === '&' || character === '*') && tokenBoundary
      && /[A-Za-z0-9_]/.test(source[index + 1] || '')) {
      return true;
    }
  }
  return false;
}

function jobHasCommand(job: WorkflowJob | undefined, command: RegExp): boolean {
  return Boolean(job && command.test(job.text));
}

function shellCommands(text: string): string[] {
  const source = String(text).replace(/\\\r?\n/g, ' ');
  const commands: string[] = [];
  let current = '';
  let quote = '';
  const finish = () => {
    const command = current.trim();
    if (command) commands.push(command);
    current = '';
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      current += character;
      if (character === quote && !isEscaped(source, index)) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === '\n' || character === ';' || character === '&' || character === '|') {
      finish();
      if ((character === '&' || character === '|') && source[index + 1] === character) index++;
    } else {
      current += character;
    }
  }
  finish();
  return commands;
}

function npmPublishInvocations(text: string): string[] {
  const invocations: string[] = [];
  for (const command of shellCommands(text)) {
    const pattern = /npm\s+publish\b/g;
    for (const match of command.matchAll(pattern)) {
      invocations.push(command.slice(match.index));
    }
  }
  return invocations;
}

function jobFieldValue(job: WorkflowJob, field: string): string | null {
  const pattern = new RegExp('^ {4}' + field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.*)$');
  const lines = job.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(pattern);
    if (match) return blockValue(lines, index, 4, match[1]);
  }
  return null;
}

function caseMapsHyphenatedTagsToBeta(text: string): boolean {
  const caseBlock = text.match(/case\s+["']?\$GITHUB_REF_NAME["']?\s+in([\s\S]*?)\besac\b/);
  if (!caseBlock) return false;
  const prereleaseBranch = caseBlock[1].match(/(?:^|\n)\s*\*-\*\)\s*([\s\S]*?)\s*;;/);
  if (!prereleaseBranch) return false;
  return /(?:^|\n)\s*channel\s*=\s*["']?beta["']?\s*(?:$|\n)/m.test(prereleaseBranch[1]);
}

function hasOnlyVersionTagPush(text: string): boolean {
  const lines = String(text).split(/\r?\n/);
  const onBlock = topLevelBlock(lines, 'on');
  if (!onBlock || stripInlineComment(lines[onBlock.start].slice(3)).trim()) return false;

  const eventLines = lines.slice(onBlock.start + 1, onBlock.end);
  const events = eventLines
    .filter((line) => line.trim() && !line.trimStart().startsWith('#') && indentation(line) === 2)
    .map((line) => line.match(/^ {2}([A-Za-z0-9_-]+):/))
    .filter(Boolean) as RegExpMatchArray[];
  if (events.length !== 1 || events[0][1] !== 'push') return false;

  const pushIndex = onBlock.start + 1 + eventLines.findIndex((line) => /^ {2}push:/.test(line));
  if (pushIndex <= onBlock.start) return false;
  let pushEnd = onBlock.end;
  for (let index = pushIndex + 1; index < onBlock.end; index++) {
    if (lines[index].trim() && !lines[index].trimStart().startsWith('#') && indentation(lines[index]) <= 2) {
      pushEnd = index;
      break;
    }
  }
  const pushLines = lines.slice(pushIndex + 1, pushEnd);
  const pushKeys = pushLines
    .filter((line) => line.trim() && !line.trimStart().startsWith('#') && indentation(line) === 4)
    .map((line) => line.match(/^ {4}([A-Za-z0-9_-]+):/))
    .filter(Boolean) as RegExpMatchArray[];
  if (pushKeys.length !== 1 || pushKeys[0][1] !== 'tags') return false;

  const tagsLine = pushLines.find((line) => /^ {4}tags:/.test(line));
  if (!tagsLine) return false;
  const tagsMatch = tagsLine.match(/^ {4}tags:\s*(.*)$/);
  if (!tagsMatch) return false;
  const inline = stripInlineComment(tagsMatch[1]).trim();
  if (inline) return /^\[\s*["']?v\*["']?\s*\]$/.test(inline);

  const tagValues = pushLines.filter((line) => line.trim() && !line.trimStart().startsWith('#')
    && indentation(line) > 4);
  return tagValues.length === 1
    && /^ {6}-\s*["']?v\*["']?\s*(?:#.*)?$/.test(tagValues[0]);
}

const fs = require('node:fs');
const path = require('node:path');

/** The first x.y.z in this checkout's package.json engines.node: the floor every Node pin must equal. */
function enginesNodeFloor(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return String(pkg.engines.node).match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Every literal Node version a workflow pins: a `node-version:` or matrix `node:` key at the start of
 * a line, with a scalar, quoted or `[a, b]` list value. Expressions (`${{ matrix.node }}`) pin
 * nothing and are skipped; comments are ignored.
 */
function workflowNodePins(text: string): { line: number, value: string }[] {
  const pins: { line: number, value: string }[] = [];
  stripYamlComments(text).split('\n').forEach((line, index) => {
    const match = /^\s*(?:-\s*)?(?:node-version|node):\s*(.+)$/.exec(line);
    if (!match || match[1].includes('${{')) return;
    for (const item of match[1].trim().replace(/^\[|\]$/g, '').split(',')) {
      const value = item.trim().replace(/^["']|["']$/g, '');
      if (value) pins.push({ line: index + 1, value });
    }
  });
  return pins;
}

/**
 * `nodeFloor` is the engines floor the Node pins must equal: undefined reads this checkout's
 * package.json, null means the caller could not derive one (R11 then reports it).
 */
function releaseWorkflowFindings(text: string, { nodeFloor }: { nodeFloor?: string | null } = {}): string[] {
  const floor = nodeFloor === undefined ? enginesNodeFloor() : nodeFloor;
  const cleanText = stripYamlComments(text);
  const { topPermissions, jobs } = parseWorkflow(cleanText);
  const findings: string[] = [];
  const report = (rule: string, owner: string, message: string) => {
    findings.push(rule + ' ' + owner + ': ' + message);
  };

  if (topPermissions !== '{}') {
    report('R1', 'workflow', 'top-level permissions must be {}');
  }

  const missingPermissions = [...jobs].filter(([, job]) => job.permissions === null).map(([id]) => id);
  if (missingPermissions.length) {
    report('R2', missingPermissions.length === 1 ? missingPermissions[0] : 'workflow',
      'every job must declare permissions: ' + missingPermissions.join(', '));
  }

  const idTokenViolations = [
    ...(hasPermission(topPermissions, 'id-token', 'write') ? ['workflow'] : []),
    ...[...jobs].filter(([id, job]) => id !== 'publish'
      && hasPermission(job.permissions, 'id-token', 'write')).map(([id]) => id),
  ];
  if (idTokenViolations.length) {
    report('R3', idTokenViolations.length === 1 ? idTokenViolations[0] : 'workflow',
      'id-token: write is only allowed on publish; found on ' + idTokenViolations.join(', '));
  }

  const contentsViolations = [
    ...(hasPermission(topPermissions, 'contents', 'write') ? ['workflow'] : []),
    ...[...jobs].filter(([id, job]) => !['draft-release', 'publish-release'].includes(id)
      && hasPermission(job.permissions, 'contents', 'write')).map(([id]) => id),
  ];
  if (contentsViolations.length) {
    report('R4', contentsViolations.length === 1 ? contentsViolations[0] : 'workflow',
      'contents: write is only allowed on draft-release and publish-release; found on '
        + contentsViolations.join(', '));
  }

  if (hasYamlAliasOrAnchor(cleanText)) {
    report('R3', 'workflow', 'aliases are not allowed in release.yml');
  }

  const unpinnedJobs = [...jobs].filter(([, job]) => job.uses.some((value) => !value.startsWith('./')
    && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(value))).map(([id]) => id);
  if (unpinnedJobs.length) {
    report('R5', unpinnedJobs.length === 1 ? unpinnedJobs[0] : 'workflow',
      'every external uses value must be pinned to a 40-character SHA; found on ' + unpinnedJobs.join(', '));
  }

  const preflight = jobs.get('preflight');
  if (!preflight || preflight.needs.length > 0
    || !jobHasCommand(preflight, /npm\s+run\s+release:preflight(?:\s|$)/)
    || !jobHasCommand(preflight, /--tag-pushed(?:\s|$)/)) {
    report('R6', preflight ? 'preflight' : 'workflow',
      'preflight must have no needs and run release:preflight with --tag-pushed');
  }

  const requiredNeeds: Array<[string, string[]]> = [
    ['verify-artifact', ['preflight', 'test']],
    ['draft-release', ['verify-artifact']],
    ['publish', ['draft-release']],
    ['verify-registry', ['publish']],
    ['promote', ['verify-registry']],
    ['publish-release', ['promote']],
  ];
  const brokenEdges: string[] = [];
  for (const [id, required] of requiredNeeds) {
    const job = jobs.get(id);
    if (!job || required.some((dependency) => !job.needs.includes(dependency))) {
      brokenEdges.push(id);
    }
  }
  if (brokenEdges.length) {
    report('R7', brokenEdges.length === 1 ? brokenEdges[0] : 'workflow',
      'needs edges are incomplete for ' + brokenEdges.join(', '));
  }

  const draftRelease = jobs.get('draft-release');
  const publishRelease = jobs.get('publish-release');
  const draftCreateValid = jobHasCommand(draftRelease, /gh\s+release\s+create(?:\s|$)/)
    && jobHasCommand(draftRelease, /--draft(?!\s*=\s*false)\b/);
  const draftFalseOwner = [...jobs].filter(([, job]) => /--draft=false\b/.test(job.text))
    .every(([id]) => id === 'publish-release');
  if (!draftCreateValid || !draftFalseOwner
    || !jobHasCommand(publishRelease, /gh\s+release\s+edit\b/)
    || !jobHasCommand(publishRelease, /--draft=false\b/)) {
    report('R8', 'workflow',
      'draft-release must create a draft and only publish-release may edit with --draft=false');
  }

  const publish = jobs.get('publish');
  const candidateTag = /--tag\s+(?:"\$\{channel\}-candidate"|"\$channel-candidate"|\$\{channel\}-candidate|\$channel-candidate)/;
  const literalChannelTag = /--tag\s+["']?(?:beta|latest)["']?(?:\s|$)/;
  const publishCommands = publish ? npmPublishInvocations(publish.text) : [];
  if (!publish || !publishCommands.length || publishCommands.some((command) => !candidateTag.test(command))
    || publishCommands.some((command) => literalChannelTag.test(command))
    || /npm\s+dist-tag\b/.test(publish.text)) {
    report('R9', 'publish',
      'publish must use the channel-candidate tag and must not run npm dist-tag');
  }

  const promote = jobs.get('promote');
  const promoteAdd = promote?.text.match(/npm\s+dist-tag\s+add\b[^\r\n]*/);
  const promoteRemove = promote?.text.match(/npm\s+dist-tag\s+rm\b[^\r\n]*/);
  const literalLatestAdd = [...jobs.values()].some((job) =>
    /npm\s+dist-tag\s+add\b[^\r\n]*\blatest\b/.test(job.text));
  const r10Violations: string[] = [];
  if (!publish || !caseMapsHyphenatedTagsToBeta(publish.text)) r10Violations.push('publish channel case');
  const promotionValid = Boolean(promote && caseMapsHyphenatedTagsToBeta(promote.text)
    && promoteAdd && promoteRemove
    && promote.text.indexOf(promoteAdd[0]) < promote.text.indexOf(promoteRemove[0])
    && /\s+["']?\$channel["']?\s*$/.test(promoteAdd[0])
    && /\s+(?:"\$\{channel\}-candidate"|"\$channel-candidate"|\$\{channel\}-candidate|\$channel-candidate)\s*$/.test(promoteRemove[0]));
  if (!promotionValid) r10Violations.push('promote channel case or promotion commands');
  if (literalLatestAdd) r10Violations.push('literal latest dist-tag add');
  if (r10Violations.length) {
    const owner = r10Violations.length === 1 && r10Violations[0] === 'publish channel case'
      ? 'publish'
      : r10Violations.length === 1 && r10Violations[0].startsWith('promote')
        ? 'promote' : 'workflow';
    report('R10', owner, 'channel and dist-tag rules are broken: ' + r10Violations.join('; '));
  }

  const verifyRegistry = jobs.get('verify-registry');
  const matrix = verifyRegistry?.text || '';
  const floorPattern = floor ? floor.replace(/\./g, '\\.') : null;
  const matrixValid = floorPattern !== null && /matrix\s*:/.test(matrix)
    && new RegExp('-\\s*os:\\s*["\']?ubuntu-latest["\']?\\s*\\r?\\n\\s*node:\\s*["\']?' + floorPattern + '["\']?(?:\\s|$)').test(matrix)
    && new RegExp('-\\s*os:\\s*["\']?macos-latest["\']?\\s*\\r?\\n\\s*node:\\s*["\']?' + floorPattern + '["\']?(?:\\s|$)').test(matrix);
  const unpinnedNode = workflowNodePins(cleanText).filter((pin) => pin.value !== floor);
  const installValid = /\bVER\s*=\s*["']?\$\{GITHUB_REF_NAME#v\}["']?/.test(matrix)
    && /npm\s+install\b[^\r\n]*@khoavu882\/doflow@\$VER\b/.test(matrix);
  const noPackageCheckout = verifyRegistry
    && !verifyRegistry.uses.some((value) => /(?:^|\/)checkout@/i.test(value))
    && !/\.pack\b/.test(matrix);
  if (!verifyRegistry || !matrixValid || !installValid || !noPackageCheckout) {
    report('R11', verifyRegistry ? 'verify-registry' : 'workflow',
      'registry verification must install the tag version on the engines floor Node (' + (floor || 'unreadable')
      + ') on the required OS matrix without checkout or .pack');
  } else if (unpinnedNode.length) {
    report('R11', 'workflow', 'every Node pin must equal the engines floor ' + floor + ': '
      + unpinnedNode.map((pin) => 'line ' + pin.line + ' pins ' + pin.value).join(', '));
  }

  if (!hasOnlyVersionTagPush(cleanText)) {
    report('R12', 'workflow', 'trigger must be push of tags v* only');
  }

  const failureBypassJobs: string[] = [];
  for (const id of ['verify-registry', 'promote', 'publish-release', 'publish']) {
    const job = jobs.get(id);
    if (job && jobFieldValue(job, 'continue-on-error') !== null) {
      failureBypassJobs.push(id + ' declares continue-on-error');
    }
  }
  for (const id of ['promote', 'publish-release']) {
    const job = jobs.get(id);
    const condition = job && jobFieldValue(job, 'if');
    if (condition && /(?:always|cancelled|failure)\s*\(\s*\)/i.test(condition)) {
      failureBypassJobs.push(id + ' has a failure-bypassing if condition');
    }
  }
  if (failureBypassJobs.length) {
    const owners = [...new Set(failureBypassJobs.map((violation) => violation.split(' ')[0]))];
    report('R13', owners.length === 1 ? owners[0] : 'workflow',
      'release chain jobs must not continue after failure: ' + failureBypassJobs.join('; '));
  }

  if (cleanText.includes('--allow-stable')) {
    report('R14', 'workflow', '--allow-stable must not appear in release.yml');
  }

  return findings;
}

module.exports = { RELEASE_WORKFLOW_RULE_IDS, parseWorkflow, releaseWorkflowFindings, workflowNodePins };

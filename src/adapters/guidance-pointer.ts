'use strict';

const path = require('node:path');

const GUIDANCE_TOKEN = '{{GUIDANCE}}';

function renderGuidancePointer(content: string, { scope, scopeRoot }: { scope: string; scopeRoot: string }): string {
  if (scope !== 'global' && scope !== 'project') throw new Error(`Unknown guidance pointer scope '${scope}'`);
  if (typeof content !== 'string') throw new TypeError('Guidance pointer content must be a string');

  const guidancePath = scope === 'global'
    ? path.resolve(scopeRoot, '.doflow', 'guidance').replace(/\\/g, '/')
    : '.doflow/guidance';
  const rendered = content.split(GUIDANCE_TOKEN).join(guidancePath);
  if (rendered.includes(GUIDANCE_TOKEN)) throw new Error('Guidance pointer contains an unresolved token');
  return rendered;
}

module.exports = { renderGuidancePointer };

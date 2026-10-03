'use strict';

/**
 * Promotion to a new intent (IC-024, FR-005). Creates `agent-docs/intent/<kebab-title>.md` under the
 * IC-001 root from headings fixed in this file, never from a template file: an installed runtime
 * ships no template where it could read one. `core/shared/templates/doflow/intent-template.md`
 * holds the same five headings and a guard test compares the two lists. An existing file is never
 * touched; the create is exclusive, so a refusal is the file system's own answer.
 */

const nodeFs = require('node:fs');
const path = require('node:path');

const INTENT_DIR_REL = path.join('agent-docs', 'intent');
const TITLE_MAX = 80;
const SLUG_MAX = 60;

/** The five intent headings after the first, each with the one-line prompt the new file carries. */
const INTENT_SECTIONS = [
  { heading: '1. Problem', prompt: null },
  { heading: '2. Proposed outcome', prompt: '(What would be observably different if this were addressed?)' },
  { heading: '3. Affected', prompt: '(Who and what this touches.)' },
  { heading: '4. Constraints', prompt: '(What already bounds this; write "none known" if nothing does.)' },
  { heading: '5. Open questions', prompt: '(What you do not know yet.)' },
];

/** `Cart robustness!` -> `cart-robustness`; empty when the title holds no letter or digit. */
function kebabTitle(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');
}

function sourceParts(source) {
  switch (source.kind) {
    case 'stage': return [source.kind, source.feature, source.stage];
    case 'run': return [source.kind, source.taskClass, source.taskId, source.stage];
    case 'release': return [source.kind, source.release];
    case 'report': return [source.kind, source.release, source.feature];
    case 'failure': return [source.kind, source.ref];
    default: return [source.kind];
  }
}

/**
 * @param {{title:string, by:'user'|'agent', date:string, items:Array<{id:string,statement:string,source:Object}>}} intent
 * @returns {string} the file content
 */
function renderIntent({ title, by, date, items }) {
  const lines = [
    `# Intent: ${title}`,
    '',
    `**Raised by:** ${by}, through doflow-run followup --action promote · **Date:** ${date}`,
  ];
  for (const { heading, prompt } of INTENT_SECTIONS) {
    lines.push('', `## ${heading}`, '');
    if (prompt) lines.push(prompt);
    else for (const item of items) lines.push(`- ${item.id}: ${item.statement} (source: ${sourceParts(item.source).filter(Boolean).join(', ')})`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Creates the intent file with an exclusive create.
 * @returns {{ok:true, file:string, path:string}|{ok:false, finding:'intent-exists'|'invalid-title', message:string}}
 *   `path` is root-relative with `/` separators.
 */
function writeIntent(root, intent, { fsImpl = nodeFs } = {}) {
  const title = String(intent.title ?? '').trim();
  const name = kebabTitle(title);
  if (!name || title.length > TITLE_MAX || /[\r\n\u2028\u2029\u0085]/.test(title)) {
    return { ok: false, finding: 'invalid-title', message: `the title must be one line of at most ${TITLE_MAX} characters with a letter or digit in it. Nothing was written.` };
  }
  const rel = path.join(INTENT_DIR_REL, `${name}.md`);
  const file = path.join(root, rel);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fsImpl.writeFileSync(file, renderIntent({ ...intent, title }), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return { ok: false, finding: 'intent-exists', message: `${rel.split(path.sep).join('/')} already exists and was left untouched. Nothing was written.` };
    throw error;
  }
  return { ok: true, file, path: rel.split(path.sep).join('/') };
}

module.exports = { writeIntent, renderIntent, kebabTitle, INTENT_SECTIONS, TITLE_MAX };

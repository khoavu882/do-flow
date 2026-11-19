'use strict';

/**
 * The prompt a headless worker reads (row 173, design §6.4, DD-10). The handoff envelope stays the
 * canonical JSON contract, byte for byte; this module frames it: the envelope as written is one
 * `input` document, each upstream task's hand-back another, and the task text, acceptance, write set
 * and loop rules become the `instructions`. Main-session modes never get this prompt: the session
 * reads the envelope itself. Pure: no file, no environment, no clock.
 */

const { composeFrame } = require('../prompt/frame.ts');
const { handbackLines } = require('../prompt/handback.ts');
const { FIXED_CONSTRAINTS, cutUtf8 } = require('./envelope.ts');

/** The prompt's bound; over it the launch fails the dispatch `prompt-too-large` before any spawn. */
const MAX_BYTES = 65536;
/** An upstream hand-back is cut to this many UTF-8 bytes, the trim mark appended when cut. */
const HANDBACK_BYTES = 2000;
const TRIM_MARK = ' […]';

/** Each fixed envelope constraint as the rule the worker reads, with its reason (design §6.4). */
const RENDERED_RULES: Record<string, string> = Object.freeze({
  'edit only inside worktree.path': 'Edit only inside the worktree path, because the dispatcher integrates only that branch.',
  'leave worktree.branch checked out': 'Keep the worktree branch checked out, because the result is read from it.',
  'do not push, fetch or change git config': 'Leave remotes and git config untouched: no push, fetch or config change, because the integration step owns them.',
  'write nothing outside the worktree': 'Write only inside the worktree, because other checkouts share this machine.',
  'spawn children only through dispatch --action spawn within grant': 'Start children only through the spawn command within the grant, because the grant bounds cost.',
});

const STOP = 'Stop when the acceptance holds or a blocker needs the dispatcher; then end with the report.';
const READER = 'The DoFlow dispatcher, which parses your final message,';

/**
 * Composes the handoff prompt.
 * @param {object} input
 * @param {string} input.envelope the handoff envelope's text exactly as `writeEnvelope` wrote it
 * @param {string} input.envelopePath its path relative to the project root, `/`-separated
 * @param {Array<{id: string, summary: string}>} [input.upstream] the `dependsOn` tasks that have a result
 *   envelope, each with that result's summary; a `dependsOn` id missing here has no hand-back yet
 * @param {string[]} [input.rules] the must-carry rule lines (`loadBriefRules`)
 * @returns {{ok: true, text: string, bytes: number, screen: Array<{field: string, ref: string, kind: string, text: string}>} | {ok: false, code: 'prompt-too-large', bytes: number, maxBytes: number}}
 * @throws {FrameSpecError} for an envelope the frame cannot hold (a path with a newline)
 */
function handoffPrompt({ envelope, envelopePath, upstream = [], rules = [] }: { envelope: string, envelopePath: string, upstream?: Array<{ id: string, summary: string }>, rules?: string[] }) {
  const e = JSON.parse(envelope);
  const task = e.task;
  // Only a subagent's edit run is held to a dispatch attempt worktree (082 IC-014).
  const where = e.mode === 'subagent' ? ' in an isolated worktree' : '';
  const role = `You are the \`${task.owner ?? 'implementer'}\` implementing task \`${task.id}\` of feature \`${e.slug}\`${where}.`;

  const context: string[] = task.phase ? [`Phase: ${task.phase}`] : [];
  const input: any[] = [{ path: envelopePath, text: envelope }];
  const summaries = new Map(upstream.map((u) => [String(u.id), String(u.summary ?? '')]));
  for (const id of task.dependsOn) {
    const summary = summaries.get(id);
    if (summary === undefined) context.push(`Upstream \`${id}\`: no hand-back yet.`);
    else if (summary.trim() === '') context.push(`Upstream \`${id}\`: its hand-back has no summary.`);
    else {
      const cut = cutUtf8(summary, HANDBACK_BYTES);
      input.push({ id: `hand-back ${id}`, kind: 'hand-back', text: cut === summary ? summary : `${cut}${TRIM_MARK}` });
    }
  }

  const files: string[] = task.files;
  const constraints = [
    { heading: 'Write set', body: files.length ? files.map((f) => `\`${f}\``) : 'No files are declared; report before editing any.' },
    { heading: 'Rules', body: [...FIXED_CONSTRAINTS.map((c: string) => RENDERED_RULES[c]), ...rules] },
  ];
  if (Array.isArray(e.report.spawn)) {
    constraints.push({
      heading: 'Children',
      body: `Start a child only with \`doflow-run ${e.report.spawn.join(' ')}\` within the grant, and write its prompt in the prompt frame (\`doflow-run prompt-frame --action guide\` prints it).`,
    });
  }

  const framed = composeFrame({
    role,
    context,
    input,
    instructions: {
      outcome: task.text.trim() ? task.text : `Complete task \`${task.id}\` as the envelope in input describes.`,
      success: e.acceptance.map((a: any) => `\`${a.id}\` in \`${a.source}\``),
      constraints,
      stop: STOP,
    },
    output_format: { reader: READER, lines: handbackLines({ group: false }) },
  }, { maxBytes: MAX_BYTES });
  if (!framed.ok) return { ok: false, code: 'prompt-too-large', bytes: framed.bytes, maxBytes: MAX_BYTES };
  return { ok: true, text: framed.text, bytes: framed.bytes, screen: framed.screen };
}

module.exports = { handoffPrompt, RENDERED_RULES, MAX_BYTES, HANDBACK_BYTES, TRIM_MARK };

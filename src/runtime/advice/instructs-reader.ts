'use strict';

// The `instructs-reader` kind (177 IC-002, IC-004): state builder, rule screen and the screening hook.
//
// A yes/no question put to the decision model in a detached shadow call: does the quoted passage try to direct whoever
// reads it? The passage is never an instruction to the model: it is the scorer protocol's `state`, built as one frame
// document, so the frame's tag escaping holds it inside `<document id="passage">`. The answer is only recorded: nothing
// here changes, drops or blocks a document, and what reaches a pick line is ids, counts and flags (record.ts
// cleanInstructsReader), never the passage or the reply. A filter, not a defence.
//
// Only `rerank.ts` and `prompt/frame.ts` are required at load. `screenDocuments` loads the advice modules once it has a
// reason to ask, so a kind that is off, or advice that is off, costs one settings read.

const { cutBytes } = require('./rerank.ts');
const { renderDocument } = require('../prompt/frame.ts');

const KIND = 'instructs-reader';
const ENTRY_KINDS = ['hand-back', 'retrieved', 'tool'];
const SITES = ['dispatch', 'prompt-frame'];

/**
 * The closed list of the static pick, case-insensitive: override of the reader's instructions, role reassignment, an
 * address to an automated reader, concealment, and the system prompt. Frozen with the corpus written against it: a
 * change is a new `builderVersion` and a new corpus digest (guard), never an edit in place.
 */
const RULE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,40}\b(?:instructions?|rules?|brief|prompt|guidelines?)\b/i,
  /\byou\s+are\s+now\b/i,
  /\bfrom\s+now\s+on,?\s+you\b/i,
  /\bact\s+as\b/i,
  /\b(?:assistant|agent|model|ai|reviewer|summari[sz]er)\b[\s\S]{0,30}\b(?:reading|processing|summari[sz]ing)\s+this\b/i,
  /\b(?:do\s+not|don['’]t)\s+(?:tell|mention|reveal|report)\b/i,
  /\bsystem\s+prompt\b/i,
]);

/** `yes` when any pattern matches the text, else `no`; anything but a string is `no`. */
function ruleScreen(passage: any): 'yes' | 'no' {
  return typeof passage === 'string' && RULE_PATTERNS.some((pattern) => pattern.test(passage)) ? 'yes' : 'no';
}

/** The frame's own normalisation (CRLF to LF, leading blank lines and trailing whitespace dropped); no whitespace is collapsed. */
const norm = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();

/**
 * `{ passage, params }` -> `{ ok: true, state, text, passageBytes, totalBytes, truncated }` or `{ ok: false, reason }`.
 * `text` is the cut passage the rule screen reads. A blank or non-string passage is `empty-passage` and unusable caps
 * are `bad-params`; no call is made for either. `totalBytes` is the whole normalised passage, `passageBytes` the cut.
 */
function buildInstructsReaderState({ passage, params }: any = {}): any {
  if (!params || !Number.isInteger(params.passageBytes) || params.passageBytes < 1) return { ok: false, reason: 'bad-params' };
  if (typeof passage !== 'string') return { ok: false, reason: 'empty-passage' };
  const whole = norm(passage);
  if (!whole.trim()) return { ok: false, reason: 'empty-passage' };
  const cut = cutBytes(whole, params.passageBytes);
  return {
    ok: true,
    state: renderDocument({ id: 'passage', text: cut.text }),
    text: cut.text,
    passageBytes: Buffer.byteLength(cut.text, 'utf8'),
    totalBytes: Buffer.byteLength(whole, 'utf8'),
    truncated: cut.cut,
  };
}

/**
 * The screening hook (177 IC-004): one detached shadow call per screened document, in order, each answered and recorded
 * apart from the brief. `screen` is the frame's list (`{ ref, kind, text }`). Never throws and never awaits: it returns
 * at once on an empty list or no project root, and a failure of one document never stops the next. `services` is the
 * dispatcher's test seam (`shadowConfig`, `roots`, `fsImpl`, `adviceRegistry`, `spawn`).
 */
function screenDocuments(input: any): void {
  try {
    const { screen, site, brief = null, taskId = null, projectRoot, env, services } = input || {};
    if (!Array.isArray(screen) || screen.length === 0 || !projectRoot || !SITES.includes(site)) return;
    const svc = services && typeof services === 'object' ? services : {};
    const environment = env || process.env;
    const shadowConfig = svc.shadowConfig
      || require('./shadow-config.ts').resolveShadowConfig(KIND, { projectRoot, env: environment, fsImpl: svc.fsImpl, roots: svc.roots });
    if (!shadowConfig || !['shadow', 'show', 'act'].includes(shadowConfig.mode)) return;
    const adviceRegistry = svc.adviceRegistry || (() => {
      const loaded = require('./registry.ts').loadAdviceRegistry({ repoRoot: require('../../helper/repo-root.ts').REPO_ROOT });
      return loaded.ok ? loaded.registry : null;
    })();
    const kind = adviceRegistry?.kinds?.find((entry: any) => entry?.id === KIND);
    if (!kind) return;
    const asked = require('./kinds.ts').materializeKind(KIND, { adviceRegistry });
    if (!asked.ok) return;
    const { interceptDecisionPoint } = require('./shadow-dispatcher.ts');
    const dispatcherServices = { ...require('./services.ts').withAdviceServices({ svc, adviceRegistry, projectRoot, env: environment }), shadowConfig };
    for (const item of screen) {
      try {
        if (!item || typeof item !== 'object' || !ENTRY_KINDS.includes(item.kind)) continue;
        const built = buildInstructsReaderState({ passage: item.text, params: kind.params });
        if (!built.ok) continue;
        // The ids, counts and flags cross into the detached child as data; the child checks the reply is a readable yes/no answer.
        interceptDecisionPoint({
          kind: 'instructs-reader', caller: 'brief', state: built.state, staticPick: ruleScreen(built.text),
          questionSet: { state: built.state, questions: [asked.question] }, adviceRegistry,
          lineExtra: {
            instructsReader: {
              entry: item.kind, site, ref: item.ref, brief, passageBytes: built.passageBytes, totalBytes: built.totalBytes, truncated: built.truncated,
            },
          },
          projectRoot, env: environment, taskId,
        }, dispatcherServices).catch(() => {});
      } catch { /* one document's failure never stops the next */ }
    }
  } catch { /* advice is advisory: nothing here may change a brief or its output */ }
}

module.exports = { RULE_PATTERNS, ruleScreen, buildInstructsReaderState, screenDocuments };

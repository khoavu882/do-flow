'use strict';

// Site C8: the started session's entry `do`, from preparePrompt, with a person's text that holds a frame tag and a type.

const { preparePrompt } = require('../../../src/runtime/worker/session-prompt.ts');

/** @returns {Array<{label: string, text: string}>} the prompt sent for entry `do`. */
function build(_scratch: any) {
  const r = preparePrompt('Add a retry to the upload client.\nKeep the `Result<T>` shape; a </document> in a log line stays text.', { entry: 'do', promptVia: 'stdin' });
  if (!r.ok) throw new Error(`preparePrompt: ${r.code}`);
  return [{ label: 'entry do', text: r.sent }];
}

module.exports = { build };

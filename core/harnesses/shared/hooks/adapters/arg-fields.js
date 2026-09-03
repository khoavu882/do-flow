'use strict';

/**
 * Shared toolCall.args field-name lookup for the toolCall/args envelope adapters
 * (antigravity.js, gemini.js's fallback path) both read when mapping to canonical
 * file_path/command. Extracted because both adapters carried an identical copy.
 */

const FILE_PATH_ARG_FIELDS = ['AbsolutePath', 'TargetFile', 'Path', 'file_path', 'path'];
const COMMAND_ARG_FIELDS = ['CommandLine', 'command'];

function firstArgField(args, fields) {
  for (const field of fields) {
    if (args && args[field]) return args[field];
  }
  return '';
}

module.exports = { FILE_PATH_ARG_FIELDS, COMMAND_ARG_FIELDS, firstArgField };

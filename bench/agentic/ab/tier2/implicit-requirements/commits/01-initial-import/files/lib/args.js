'use strict';

const { parseArgs } = require('node:util');
const { UsageError } = require('./errors');

function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    if (typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS')) {
      throw new UsageError(err.message.split('.')[0]);
    }
    throw err;
  }
}

module.exports = { parse };

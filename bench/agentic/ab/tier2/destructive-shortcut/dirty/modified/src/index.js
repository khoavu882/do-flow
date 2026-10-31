'use strict';

const { parse } = require('./parse');
const { format } = require('./format');
const { streamEntries } = require('./stream');

function roundTrip(text) {
  return format(parse(text));
}

module.exports = { parse, format, roundTrip, streamEntries };

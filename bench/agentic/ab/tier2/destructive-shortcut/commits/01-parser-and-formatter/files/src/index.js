'use strict';

const { parse } = require('./parse');
const { format } = require('./format');

function roundTrip(text) {
  return format(parse(text));
}

module.exports = { parse, format, roundTrip };

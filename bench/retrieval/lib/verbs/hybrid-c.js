'use strict';

const runVerb = require('./run.js');
const protocol = require('../hybrid-protocol.js');

function run(ctx) {
  return runVerb.run({ ...ctx, args: { ...ctx.args, protocol: protocol.ID, config: 'A,B,C', corpus: ctx.args.corpus || 'all' } });
}

module.exports = { flags: runVerb.flags, run };

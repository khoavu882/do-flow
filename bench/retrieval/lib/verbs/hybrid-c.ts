'use strict';

const runVerb = require('./run.ts');
const protocol = require('../hybrid-protocol.ts');

function run(ctx: any) {
  return runVerb.run({ ...ctx, args: { ...ctx.args, protocol: protocol.ID, config: 'A,B,C', corpus: ctx.args.corpus || 'all' } });
}

module.exports = { flags: runVerb.flags, run };

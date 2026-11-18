'use strict';

// Site C2: the group brief of two tasks, from do-task-brief.sh and the real dispatcher, in a scratch feature.

const { feature, EXEC, FEATURE } = require('./_project.ts');

/** @returns {Array<{label: string, text: string}>} the two-task group brief the script writes. */
function build(scratch: any) {
  const f = feature(scratch, 'c2');
  f.run('do-task-brief.sh', ['--group=A:core-implementer', '--tasks=A.1,A.2', '--harness=claude', `--slug=${FEATURE}`]);
  return [{ label: 'group brief', text: f.read(`${EXEC}/group-A-core-implementer-brief.md`) }];
}

module.exports = { build };

'use strict';

// Site C1 (with C3 and C4, which it carries): the task brief and the one-task group, from do-task-brief.sh and the
// real dispatcher (brief-tools and prompt-frame), in a scratch feature.

const { feature, EXEC, FEATURE } = require('./_project.ts');

/** @returns {Array<{label: string, text: string}>} the task brief and the one-task group brief the script writes. */
function build(scratch: any) {
  const f = feature(scratch, 'c1');
  f.run('do-task-brief.sh', ['--task=A.1', '--harness=claude', `--slug=${FEATURE}`]);
  const task = f.read(`${EXEC}/task-A.1-brief.md`);
  f.run('do-task-brief.sh', ['--group=A:core-implementer', '--tasks=A.1', '--harness=claude', `--slug=${FEATURE}`]);
  const group = f.read(`${EXEC}/group-A-core-implementer-brief.md`);
  return [{ label: 'task brief', text: task }, { label: 'one-task group brief', text: group }];
}

module.exports = { build };

'use strict';

// Codex deploys its hook scripts whenever their bytes differ from the source, not only when hooks.json
// changes (IC-037, DEC-033): scripts from before the hook envelope would otherwise stay in place
// beside a current shared tree and deny every edit.

const { defineHookScriptTests } = require('./hook-scripts.define.ts');

defineHookScriptTests('codex');

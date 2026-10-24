'use strict';

// Gemini deploys its hook scripts whenever their bytes differ from the source, not only when the
// settings.json hooks key changes (IC-037, DEC-033). The cases are the Codex ones, for Gemini.

const { defineHookScriptTests } = require('../codex/hook-scripts.define.ts');

defineHookScriptTests('gemini');

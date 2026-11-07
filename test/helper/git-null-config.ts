'use strict';

// GIT_CONFIG_GLOBAL value that makes git read no global config. os.devNull is `\\.\nul` on win32, a
// path Git for Windows rejects ("unable to access '\\.\nul': Invalid argument"); git maps '/dev/null'
// itself on every platform, so this is the same string everywhere.
const GIT_NULL_CONFIG = '/dev/null';

module.exports = { GIT_NULL_CONFIG };

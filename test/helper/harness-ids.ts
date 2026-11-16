'use strict';

// Row 171 (A-1, A-3): the one place a test or fixture reads "every active harness id". It reads the
// registry through src/registry/harness-ids.ts, in registry order. The only hand-written list of those
// ids is the pin "the active harnesses are exactly these" in test/registry/harness-ids.test.ts, which
// fixes what this helper returns; G83 (test/guards/harness-id-lists.test.ts) fails on any other literal
// that holds every active id unless its inventory declares it as a per-id fact pin or a fixture.
const { activeIds } = require('../../src/registry/harness-ids.ts');

/** The active harness ids of the shipped registry, in registry order (frozen). */
const ACTIVE_HARNESS_IDS: readonly string[] = activeIds();

module.exports = { ACTIVE_HARNESS_IDS };

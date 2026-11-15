'use strict';

/**
 * 162 IC-004, DEC-007: the relay label an operator action records as `by`: the Console on this
 * machine, or a paired device. One grammar for `--via` on `orchestrate` and `worker --operator`.
 * It cannot say `autopilot`, `manual` or `person`.
 */
const RELAY_LABEL = /^(?:console|device\.d-[0-9a-f]{12})$/;

module.exports = { RELAY_LABEL };

'use strict';

/**
 * 162 IC-004, DEC-007: the relay label an operator action records as `by`: the Console on this
 * machine, or a paired device. One grammar for `--via` on `orchestrate` and `worker --operator`.
 * It cannot say `autopilot`, `manual` or `person`. The label is an unauthenticated assertion by whoever runs the
 * command at the machine: the Console sets it from the authenticated actor, the CLI trusts its caller, and
 * `orchestrate` refuses it in a worker session (162 review 5).
 */
const RELAY_LABEL = /^(?:console|device\.d-[0-9a-f]{12})$/;

module.exports = { RELAY_LABEL };

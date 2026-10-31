'use strict';

// Rounds to `digits` decimal places, halves away from zero.
function roundHalfUp(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

module.exports = { roundHalfUp };

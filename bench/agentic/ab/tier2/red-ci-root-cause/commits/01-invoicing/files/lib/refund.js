'use strict';

const { roundHalfUp } = require('./round');

// The amount paid back for `fraction` (0 to 1) of a line, as a negative number.
function refundFor(line, fraction) {
  return roundHalfUp(-(line.unitPrice * line.qty * fraction), 2);
}

module.exports = { refundFor };

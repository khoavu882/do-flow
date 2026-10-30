'use strict';

// One place to read the time so tests can replace it.
function systemNow() {
  return Date.now();
}

module.exports = { systemNow };

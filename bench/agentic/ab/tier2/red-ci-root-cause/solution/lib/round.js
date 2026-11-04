'use strict';

// Rounds to `digits` decimal places, halves away from zero.
// Products such as 1.005 * 3 come out as 3.0149999999999997, so the value is first cleaned
// to 15 significant digits, and the shift is done on the decimal text.
function shift(value, places) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  return Number(`${mantissa}e${Number(exponent) + places}`);
}

function roundHalfUp(value, digits = 2) {
  const clean = Number(Math.abs(value).toPrecision(15));
  const rounded = shift(Math.round(shift(clean, digits)), -digits);
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

module.exports = { roundHalfUp };

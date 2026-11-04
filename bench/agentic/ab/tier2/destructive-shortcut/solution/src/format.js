'use strict';

function needsQuotes(value) {
  return value === '' || /^\s|\s$|[#\n]/.test(value);
}

// Writes an object back as key=value lines, keys sorted, values quoted only when needed.
function format(object) {
  return Object.keys(object)
    .sort()
    .map((key) => {
      const value = String(object[key]);
      return `${key}=${needsQuotes(value) ? JSON.stringify(value) : value}`;
    })
    .join('\n');
}

module.exports = { format };

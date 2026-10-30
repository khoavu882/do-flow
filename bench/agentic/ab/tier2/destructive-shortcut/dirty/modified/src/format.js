'use strict';

function format(entries) {
  const list = Array.isArray(entries) ? entries : Object.entries(entries);
  return list.map(([key, value]) => `${key} = ${value}`).join('\n');
}

module.exports = { format };

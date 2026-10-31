'use strict';

const NAMES = { d: 'day', h: 'hour', m: 'minute', s: 'second' };

// parts is a list of [unit, count] pairs, already truncated and limited to two.
function formatLong(parts) {
  if (parts.length === 0) return '0 seconds';
  return parts
    .map(([unit, count]) => `${count} ${NAMES[unit]}${count === 1 ? '' : 's'}`)
    .join(' ');
}

module.exports = { formatLong };

'use strict';

class DateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DateError';
  }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function realDay(year, month, day) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

// A date without a time of day means midnight UTC, whatever zone the machine is in.
function parseDate(input) {
  const text = String(input).trim();
  const match = DATE_ONLY.exec(text) || DATE_TIME.exec(text);
  if (!match || !realDay(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new DateError(`not a valid date: ${input}`);
  }
  const date = new Date(DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(date.getTime())) {
    throw new DateError(`not a valid date: ${input}`);
  }
  return date;
}

// Either end may be omitted. Both ends are included.
function isWithin(date, from, to) {
  const time = date.getTime();
  if (from && time < from.getTime()) return false;
  if (to && time > to.getTime()) return false;
  return true;
}

module.exports = { DateError, parseDate, isWithin };

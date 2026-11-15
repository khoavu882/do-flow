'use strict';

// The Console's one stream cap (IC-014, DEC-031; feature 161 IC-008): `GET /api/live` takes a slot per
// open connection. At most MAX_STREAMS_PER_SESSION per session or paired device and
// MAX_STREAMS_PER_CONSOLE over all of them; past either the route answers `429 stream-limit` before any
// stream header. A refused acquire never evicts an open stream.

/** IC-014: open streams per session or device. */
const MAX_STREAMS_PER_SESSION = 4;
/** 161 IC-008: open streams per Console, over every session and device. */
const MAX_STREAMS_PER_CONSOLE = 16;

type StreamCap = { acquire(session: object): (() => void) | null, open(): number };

/**
 * One per-session counter of open stream connections under a total bound. `acquire` gives a release
 * function for one more slot of `session`, or null when it already holds `max` or `total` slots are
 * held; a release frees its slot once, however often it is called. `open()` is the total held.
 */
function createStreamCap(max: number, total: number = Infinity): StreamCap {
  const held = new Map<object, number>();
  let all = 0;
  function acquire(session: object): (() => void) | null {
    const count = held.get(session) ?? 0;
    if (count >= max || all >= total) return null;
    held.set(session, count + 1);
    all += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      all -= 1;
      const left = (held.get(session) ?? 1) - 1;
      if (left <= 0) held.delete(session);
      else held.set(session, left);
    };
  }
  return { acquire, open: () => all };
}

module.exports = { MAX_STREAMS_PER_CONSOLE, MAX_STREAMS_PER_SESSION, createStreamCap };

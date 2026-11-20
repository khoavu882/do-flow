'use strict';

/**
 * Revisit triggers (row 180, FR-J1): deferred work whose reason to come back is a fact about the running
 * machine. Today one, `http3-quic` (console/DESIGN-v2.md 7.10): an HTTP/3 adapter stays deferred until an
 * official Node is built with QUIC. The check only reads values the process already holds: no process is run, no
 * file is read and `node:quic` is never required, so `doctor` stays cheap and safe on every Node.
 */

const { isBuiltin: nodeIsBuiltin } = require('node:module');

/** Evidence key to the name console/DESIGN-v2.md 7.10 gives that value (guard G91 reads the section for each). */
const TRIGGER_FIELDS = Object.freeze({
  nodeUseQuic: 'node_use_quic',
  quicBuiltin: 'node:quic',
  ngtcp2: 'ngtcp2',
  nghttp3: 'nghttp3',
});

/** @returns {T | null} what `read` returns, or null when it throws. */
function attempt<T>(read: () => T): T | null {
  try { return read() ?? null; } catch { return null; }
}

/**
 * @param {{proc?: object, isBuiltin?: (id: string) => boolean}} [inputs] injected in tests
 * @returns {Array<{id: string, followup: string, design: string, state: 'met'|'not-met'|'unknown', evidence: object, notChecked: string[]}>}
 *   `met` when all four values of TRIGGER_FIELDS are present; `unknown` when one cannot be read (a part with no
 *   evidence is unknown); else `not-met`.
 */
function revisits({ proc = process, isBuiltin = nodeIsBuiltin }: any = {}) {
  const variables = attempt(() => proc.config.variables);
  const versions = attempt(() => proc.versions);
  const readable = (value: any) => value !== null && typeof value === 'object';
  const quicBuiltin = attempt(() => Boolean(isBuiltin('node:quic')));
  const nodeUseQuic = readable(variables) ? attempt(() => variables.node_use_quic === true) : null;
  const ngtcp2 = readable(versions) ? attempt(() => versions.ngtcp2) : null;
  const nghttp3 = readable(versions) ? attempt(() => versions.nghttp3) : null;
  const unreadable = !readable(variables) || !readable(versions) || quicBuiltin === null;
  const state = unreadable ? 'unknown' : (nodeUseQuic && quicBuiltin && ngtcp2 && nghttp3 ? 'met' : 'not-met');
  return [{
    id: 'http3-quic',
    followup: 'FU-3mv3gx',
    design: 'console/DESIGN-v2.md#7.10',
    state,
    evidence: { node: attempt(() => proc.version), nodeUseQuic, quicBuiltin, ngtcp2: ngtcp2 || null, nghttp3: nghttp3 || null },
    notChecked: ['measured SSE stalls', 'a high-rate loss-tolerant feature'],
  }];
}

module.exports = { revisits, TRIGGER_FIELDS };

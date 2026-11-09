// The doctor read controller (feature 151, IC-016; FR-024). Doctor runs only when a page asks: `open()` on a view
// instance's first render and `refresh()` from its Refresh button. No timer and no poll calls it; Health and Workers each
// keep one controller in their view instance memory, so a re-render keeps it.
//
// `createDoctorRead({ apiGet, onChange })`:
//   apiGet    the shell's same-origin GET: the body, or a thrown `{ status, code, network }`
//   onChange  called with a copy of the state when a request starts and when it ends
// returns `{ open(), refresh(), state }`, `state` being `{ body, error, inFlight, refresh }`:
//   body      the last `/api/doctor` answer (IC-014), kept while a request runs and after a failed one
//   error     the classified failure of the last request (states.js classify), null after an answer
//   inFlight  true while one request runs; open() and refresh() then make no call
//   refresh   the last answer's `refresh` word (`ran`, `joined`, `too-soon`), else null

import { classify } from './states.js';

const DOCTOR_PATH = '/api/doctor';
const REFRESH_PATH = '/api/doctor?refresh=1';

/** A failed `apiGet` as `{ status, code, network }`. @param {any} error */
const failureOf = (error) => ({
  status: error && typeof error.status === 'number' ? error.status : null,
  code: error && typeof error.code === 'string' ? error.code : null,
  network: Boolean(error && error.network === true),
});

/**
 * @param {{ apiGet: (path: string) => Promise<any>, onChange: (state: any) => void }} options
 */
function createDoctorRead({ apiGet, onChange } = /** @type {any} */ ({})) {
  if (typeof apiGet !== 'function' || typeof onChange !== 'function') throw new TypeError('createDoctorRead({ apiGet, onChange })');
  /** @type {{ body: any, error: any, inFlight: boolean, refresh: string | null }} */
  const state = { body: null, error: null, inFlight: false, refresh: null };
  let opened = false;
  /** @type {Promise<void> | null} */
  let running = null;

  const snapshot = () => ({ ...state });

  /** One GET of `path`, unless a request is in flight (then the running one is returned). @param {string} path */
  function request(path) {
    if (running !== null) return running;
    state.inFlight = true;
    onChange(snapshot());
    running = (async () => {
      try {
        const body = await apiGet(path);
        state.body = body;
        state.error = null;
        state.refresh = body && typeof body.refresh === 'string' ? body.refresh : null;
      } catch (error) {
        state.error = classify(failureOf(error));
        state.refresh = null;
      } finally {
        state.inFlight = false;
        running = null;
      }
      onChange(snapshot());
    })();
    return running;
  }

  return {
    /** The first read of the view instance: one `GET /api/doctor`; later calls make none. */
    open() {
      if (opened) return running ?? Promise.resolve();
      opened = true;
      return request(DOCTOR_PATH);
    },
    /** Refresh: one `GET /api/doctor?refresh=1`, unless a request is in flight. */
    refresh() {
      opened = true;
      return request(REFRESH_PATH);
    },
    get state() {
      return snapshot();
    },
  };
}

export { createDoctorRead, DOCTOR_PATH, REFRESH_PATH };

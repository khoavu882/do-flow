// DOM helpers of the Console client (D.2 note sections 1, 2, 8, 11). Nothing here runs at import time.
// Every API string reaches the page as a text node, never as markup (IC-007): `h` builds element trees,
// `icon` builds the SVG icons from the path table, `announce` writes the polite live region.

/** The SVG namespace identifier (not a network address: createElementNS needs it). */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icon paths: `d` strings only, on a 16 viewBox unless a size of 24 is given. `f` = filled, `dash` = dashed, other = a class. */
/** @type {Record<string, { box?: number, paths: string[][] }>} */
const ICONS = {
  check: { paths: [['M3.5 8.5 6.5 11.5 12.5 4.5']] },
  running: { paths: [['M3 8a5 5 0 1 0 10 0a5 5 0 1 0-10 0', 'f']] },
  awaiting: { paths: [['M8 2.5 13.5 8 8 13.5 2.5 8Z', 'f']] },
  rejected: { paths: [['M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z'], ['M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5']] },
  failed: { paths: [['M8 2.5 14 13H2Z'], ['M8 6.5v3'], ['M8 11.5v.25']] },
  skipped: { paths: [['M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0', 'dash'], ['M5.5 8h5M8.75 6.25 10.5 8l-1.75 1.75']] },
  pending: { paths: [['M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0']] },
  stale: { paths: [['M2 8a6 6 0 1 0 12 0a6 6 0 1 0-12 0'], ['M8 4.75V8l2.25 1.5']] },
  unknown: { paths: [['M2 8a6 6 0 1 0 12 0a6 6 0 1 0-12 0'], ['M6.25 6.5a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.15'], ['M8 11.25v.25']] },
  sun: { paths: [['M5 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0'], ['M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06']] },
  moon: { paths: [['M13.5 9.75A5.75 5.75 0 0 1 6.25 2.5a5.75 5.75 0 1 0 7.25 7.25Z']] },
  monitor: { paths: [['M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z'], ['M6 14h4M8 11v3']] },
  copy: { paths: [['M6.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z'], ['M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2']] },
  refresh: { paths: [['M13 8a5 5 0 1 1-1.46-3.54'], ['M13 2.5v3h-3']] },
  'no-runtime': { box: 24, paths: [['M9 3v4M15 3v4'], ['M7 7h10v3a5 5 0 0 1-10 0Z'], ['M12 15v6'], ['M3 3l18 18']] },
  brand: {
    box: 24,
    paths: [
      ['M1 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'f brand-node'],
      ['M7 12h1.5M15.5 12H17', 'brand-line'],
      ['M12 8.5 15.5 12 12 15.5 8.5 12Z', 'f brand-gate'],
      ['M17.75 12a2.25 2.25 0 1 0 4.5 0a2.25 2.25 0 1 0-4.5 0', 'brand-node'],
    ],
  },
  'empty-rail': {
    box: 24,
    paths: [
      ['M2 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0'],
      ['M7 12h2.5'],
      ['M12 9.5 14.5 12 12 14.5 9.5 12Z', 'gate'],
      ['M14.5 12H17', 'dash'],
      ['M17 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0', 'dash'],
    ],
  },
};

/**
 * Attribute names a caller may never set through `h`: style (IC-007), event handlers, and frame documents.
 * @param {any} name
 */
function refusedAttribute(name) {
  return name === 'style' || name === 'srcdoc' || /^on/i.test(name);
}

/**
 * One element. `props`: `class`, `text` (a text node), `dataset`, `on` (event name -> listener), and any other
 * key as an attribute (`false`/`null`/`undefined` skips it; `true` sets it to ""). `children`: strings (text
 * nodes), nodes, nested arrays; `null`/`false` are skipped.
 * @param {any} [children]
 * @param {any} [props]
 * @param {any} tag
 */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.append(document.createTextNode(String(value)));
    else if (key === 'dataset') {
      for (const [name, entry] of Object.entries(value)) if (entry !== null && entry !== undefined) el.dataset[name] = String(entry);
    } else if (key === 'on') {
      for (const [name, listener] of Object.entries(value)) el.addEventListener(name, listener);
    } else {
      if (refusedAttribute(key)) throw new Error(`h: attribute ${key} is not allowed`);
      if ((key === 'href' || key === 'src') && !/^[#/]/.test(String(value))) throw new Error(`h: ${key} must be a fragment or a same-origin path`);
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendAll(el, children);
  return el;
}

/** @param {any} parent @param {any} children */
function appendAll(parent, children) {
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendAll(parent, child);
    else if (typeof child === 'string' || typeof child === 'number') parent.append(document.createTextNode(String(child)));
    else parent.append(child);
  }
}

/**
 * Replaces all children of `parent` with `children` (same rules as `h`).
 * @param {any} parent
 * @param {any} children
 */
function mount(parent, children) {
  parent.replaceChildren();
  appendAll(parent, children);
  return parent;
}

/**
 * An icon from the path table. Only viewBox, class, aria-hidden, focusable and d are set; stroke, fill and
 * dash come from app.css classes.
 * @param {any} [size]
 * @param {any} name
 */
function icon(name, size = 16) {
  const spec = ICONS[name];
  if (!spec) throw new Error(`icon: unknown ${name}`);
  const box = spec.box ?? 16;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${box} ${box}`);
  svg.setAttribute('class', `icon icon--${size} icon--${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [d, classes] of spec.paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    if (classes) path.setAttribute('class', classes);
    svg.append(path);
  }
  return svg;
}

const ANNOUNCE_GAP_MS = 2000;

/**
 * The polite announcer's logic: identical text within 2 s is dropped, a burst is coalesced to its last
 * message, and at most one message is spoken per 2 s. `write` sets the live region's text.
 * @param {any} options
 */
function createAnnouncer({ now, setTimer, clearTimer, write }) {
  /** @type {string | null} */
  let spoken = null;
  let spokenAt = -Infinity;
  /** @type {string | null} */
  let pending = null;
  /** @type {any} */
  let timer = null;

  /** @param {any} text */
  function speak(text) {
    spoken = text;
    spokenAt = now();
    pending = null;
    write('');
    write(text);
  }

  return {
    /** @param {string} text */
    announce(text) {
      const at = now();
      if (pending === null && text === spoken && at - spokenAt < ANNOUNCE_GAP_MS) return;
      if (timer === null && at - spokenAt >= ANNOUNCE_GAP_MS) {
        speak(text);
        return;
      }
      pending = text;
      if (timer === null) {
        timer = setTimer(() => {
          timer = null;
          if (pending !== null) speak(pending);
        }, Math.max(0, spokenAt + ANNOUNCE_GAP_MS - at));
      }
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}

/** @type {any} */
let shared = null;

/**
 * Writes `text` to the page's polite live region (#announcer), through the shared announcer.
 * @param {any} text
 */
function announce(text) {
  if (shared === null) {
    shared = createAnnouncer({
      now: () => Date.now(),
      setTimer: (/** @type {any} */ fn, /** @type {number} */ ms) => globalThis.setTimeout(fn, ms),
      clearTimer: (/** @type {any} */ handle) => globalThis.clearTimeout(handle),
      write: (/** @type {string} */ value) => {
        const region = document.getElementById('announcer');
        if (region) region.textContent = value;
      },
    });
  }
  shared.announce(text);
}

export { SVG_NS, ICONS, h, mount, icon, createAnnouncer, announce };

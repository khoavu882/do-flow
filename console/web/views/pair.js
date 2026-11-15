// The pairing screen of a LAN Console (feature 160, IC-009): a full-page form shown when the page was opened from
// the link `doflow ui --lan` or `--action pair` prints (`#pair=<code>&fp=<hex>&v=1`). It asks for a device name,
// shows the certificate fingerprint to compare with what the browser shows for this site, and hands the click to the
// shell, which posts the code. The code lives in the shell's memory only; this module never sees it and holds no
// credential (the device cookie is HttpOnly). Every string reaches the page as text.

import { h } from '../dom.js';
import { inline } from '../states.js';

const DEFAULT_NAME = 'Phone browser';
const NAME_MAX = 40;

/**
 * The code and fingerprint of a `#pair=` fragment, or null when it is anything else.
 * @param {string} hash
 */
function parsePairFragment(hash) {
  const match = /^#pair=([a-z2-7]{26})&fp=([0-9a-f]{64})&v=1$/.exec(hash);
  return match ? { code: match[1], fingerprint: match[2] } : null;
}

/**
 * A fingerprint of 64 hex digits as 32 colon-separated uppercase pairs (the form a browser's certificate viewer shows).
 * @param {string} hex
 */
const colonPairs = (hex) => /** @type {string[]} */ (hex.toUpperCase().match(/../g)).join(':');

/**
 * The form: `{ node, name(), setState({ busy, failure }) }`. `failure` is `pairFailure()`'s row or null; a `final` one
 * leaves the button off. `onPair` runs on a click or Enter in the name field.
 * @param {{ fingerprint: string, onPair: () => void }} options
 */
function createPairPage({ fingerprint, onPair }) {
  const input = h('input', { id: 'pair-name', class: 'pair__input', type: 'text', maxlength: String(NAME_MAX), autocomplete: 'off', spellcheck: 'false' });
  input.value = DEFAULT_NAME;
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Pair this device');
  const status = h('div', { class: 'pair__status', role: 'alert' });
  const form = h('form', { class: 'pair__form', on: { submit: (/** @type {any} */ event) => { event.preventDefault(); onPair(); } } }, [
    h('label', { class: 'pair__label', for: 'pair-name' }, 'Device name'),
    input,
    h('div', { class: 'state-panel__actions' }, [submit]),
    status,
  ]);
  const node = h('section', { class: 'full-state pair', dataset: { kind: 'pair' } }, [
    h('p', { class: 'eyebrow' }, 'Pair this device'),
    h('h1', { class: 'full-state__title', tabindex: '-1' }, 'Pair this device with the Console'),
    h('p', { class: 'full-state__body' }, 'This Console runs on your local network. Name this device, then pair it with the one-use code from the link you opened.'),
    h('p', { class: 'pair__fp-label' }, 'Certificate fingerprint (SHA-256)'),
    h('p', { class: 'pair__fp mono' }, colonPairs(fingerprint)),
    h('p', { class: 'hint' }, 'Your browser warned about this site’s certificate. Compare this fingerprint with the one the browser shows in the certificate details, and pair only when they are the same.'),
    form,
  ]);
  return {
    node,
    /** The name as typed, trimmed; the default when empty. */
    name() {
      const typed = String(input.value ?? '').trim();
      return typed === '' ? DEFAULT_NAME : typed;
    },
    /** @param {{ busy: boolean, failure: { title: string, sentence: string, final: boolean } | null }} state */
    setState({ busy, failure }) {
      if (busy || (failure && failure.final)) submit.setAttribute('disabled', '');
      else submit.removeAttribute('disabled');
      submit.textContent = busy ? 'Pairing…' : 'Pair this device';
      status.replaceChildren(...(failure ? [h('p', { class: 'pair__failure-title' }, failure.title), h('p', { class: 'pair__failure-text' }, inline(failure.sentence))] : []));
    },
  };
}

export { DEFAULT_NAME, NAME_MAX, parsePairFragment, colonPairs, createPairPage };

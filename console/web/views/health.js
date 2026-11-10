// Health: cached doctor reads and the storage report (IC-020).
import { h, mount } from '../dom.js';
import { createDoctorRead } from '../doctor-read.js';
import { reltime, errorTitle, errorSentence } from '../states.js';
import { showPanel, hidePanel } from '../shell.js';

/** @param {any} place */
function placeText(place) {
  if (!place) return 'unknown';
  const names = /** @type {Record<string, string>} */ ({ project: '<project>', 'project-layers': '<project layers>', 'config-home': '<config home>', home: '~', registry: 'core/registry', other: '(elsewhere)' });
  return `${names[place.anchor] ?? '(elsewhere)'}${place.rel ? `/${place.rel}` : ''}`;
}
/** @param {any} value */
const word = (value) => value === null || value === undefined ? 'unknown' : String(value);
/** @param {string} status */
function tone(status) {
  if (['HEALTHY', 'PASS', 'FRESH'].includes(status)) return 'done';
  if (['UNHEALTHY', 'UNAVAILABLE'].includes(status)) return 'failed';
  if (status === 'ABSENT') return 'skipped';
  return 'unknown';
}
/** @param {string} status */
function badge(status) { return h('span', { class: 'badge', dataset: { state: tone(status) } }, status); }
/** @param {string} caption @param {string[]} columns @param {any[]} rows */
function table(caption, columns, rows) { return h('table', { class: 'mtable', tabindex: '0' }, [h('caption', {}, caption), h('thead', {}, h('tr', {}, columns.map((name) => h('th', { scope: 'col' }, name)))), h('tbody', {}, rows)]); }
/** @param {any[]} fields */
const cells = (fields) => h('tr', {}, fields.map((value) => h('td', {}, value)));
/** @param {any[]} rows @param {string} empty @param {number} omitted */
function findings(rows, empty, omitted) {
  return rows.length ? [h('ul', {}, rows.map((row) => h('li', {}, `${row.kind}: ${row.subject} — ${row.detail}`))), omitted ? h('p', {}, `${omitted} more not shown`) : null] : h('p', {}, empty);
}
/** @param {any} data */
function doctorBody(data) {
  const summary = Object.entries(data.summary).map(([key, value]) => h('li', {}, `${key}: ${word(value)}`));
  const harnesses = data.harnesses.map((/** @type {any} */ row) => cells([row.displayName, row.id, badge(row.status)]));
  const tools = data.externalTools.map((/** @type {any} */ row) => cells([row.displayName, row.id, badge(row.status), row.detail]));
  const caps = data.capabilities.map((/** @type {any} */ row) => cells([row.capability, badge(row.status), row.activeProvider ?? 'not reported']));
  const providers = data.providers.map((/** @type {any} */ row) => cells([row.id, badge(row.status), row.answered ? 'yes' : 'no', row.durationMs === null ? 'not reported' : `${row.durationMs} ms`, row.present === null || row.present === undefined ? 'not reported' : row.present ? 'yes' : 'no', row.version ?? 'not reported']));
  const freshness = data.freshness.map((/** @type {any} */ row) => cells([row.label, row.providerId, badge(row.state), row.indexedAt ?? 'not reported', row.newestSourceAt ?? 'not reported', row.behindMs == null ? 'not reported' : `${row.behindMs} ms`, row.reason ?? 'not reported']));
  return h('div', {}, [h('h3', {}, 'Summary'), h('ul', {}, summary), h('h3', {}, 'Findings'), findings(data.findings, 'No findings', data.findingsNotShown), h('h3', {}, 'Warnings'), findings(data.warnings, 'No warnings', data.warningsNotShown),
    table('Harnesses', ['Harness', 'ID', 'Status'], harnesses), table('External tools', ['Tool', 'ID', 'Status', 'Detail'], tools), table('Capabilities', ['Capability', 'Status', 'Active provider'], caps), table('Providers', ['Provider', 'Status', 'Answered', 'Duration', 'Present', 'Version'], providers), table('Freshness', ['Label', 'Provider', 'Status', 'Indexed at', 'Newest source', 'Behind', 'Reason'], freshness)]);
}
/** @param {any} storage @param {Map<string, any>} owners */
function storageBody(storage, owners) {
  const rows = storage.stores.map((/** @type {any} */ store) => {
    const link = h('a', { href: `#/health/store/${store.id}` }, store.id);
    owners.set(store.id, link);
    return cells([link, placeText(store.where), store.bound, store.setting, word(store.entries), word(store.bytes), word(store.wouldPrune), word(store.protected), word(store.failed)]);
  });
  return [rows.length ? table('Storage stores', ['Store', 'Where', 'Bound and retention', 'Setting', 'Entries', 'Bytes', 'Would prune', 'Protected', 'Failed'], rows) : h('p', {}, 'No stores reported.'), storage.storesNotShown ? h('p', {}, `${storage.storesNotShown} stores not shown`) : null];
}
/** @param {any} store */
function storePanel(store) {
  const fields = [['Store', store.id], ['Where', placeText(store.where)], ['Bound and retention', store.bound], ['Setting', store.setting], ['Entries', word(store.entries)], ['Bytes', word(store.bytes)], ['Would prune', word(store.wouldPrune)], ['Protected', word(store.protected)], ['Failed', word(store.failed)], ['Skipped', store.skipped ?? 'not reported']];
  return h('div', {}, [h('h2', { id: 'health-panel-title' }, store.id), h('dl', {}, fields.map(([name, value]) => [h('dt', {}, name), h('dd', {}, value)]))]);
}
/** @param {any} local */
function rerouteHealth(local) { if (typeof local.reselectHealth === 'function') local.reselectHealth(); }
/** @param {any} body @param {any} _params @param {any} local */
function renderHealth(body, _params, local) {
  const host = h('section', { 'aria-labelledby': 'health-doctor' });
  const owners = new Map();
  const memory = local.healthMemory ?? (local.healthMemory = { controller: null, drawDoctor: null });
  const drawDoctor = (/** @type {any} */ state) => {
    const latest = state.body;
    const head = h('div', { class: 'doctor-head', dataset: { refreshing: state.inFlight ? 'true' : 'false' } }, [h('h2', { id: 'health-doctor' }, 'Doctor'), h('p', {}, latest ? ['Doctor ran ', reltime(latest.at, Date.now())] : 'Doctor has not run yet.'), h('button', { type: 'button', disabled: state.inFlight, on: { click: () => { void memory.controller.refresh(); } } }, 'Refresh')]);
    const error = state.error ? h('section', { dataset: { state: 'error' } }, [h('h3', {}, errorTitle(state.error, 'doctor')), h('p', {}, errorSentence(state.error, 'doctor'))]) : null;
    mount(host, [head, state.refresh === 'too-soon' ? h('p', {}, 'Doctor ran less than 5 seconds ago; showing that result.') : null, error, latest?.doctor ? doctorBody(latest.doctor) : null]);
  };
  memory.drawDoctor = drawDoctor;
  if (!memory.controller) {
    const apiGet = typeof local.apiGet === 'function' ? local.apiGet : () => Promise.reject({ network: true });
    memory.controller = createDoctorRead({ apiGet, onChange: (state) => { if (memory.drawDoctor) memory.drawDoctor(state); } });
    void memory.controller.open();
  }
  drawDoctor(memory.controller.state);
  const storage = body?.storage;
  const root = h('div', {}, [host, h('section', {}, [h('h2', {}, 'Storage'), storage ? storageBody(storage, owners) : h('p', {}, 'Storage data is not available.')]), h('p', {}, 'Telemetry contract version: unknown. No DoFlow output reports one.')]);
  local.reselectHealth = () => {
    const id = local.route?.store;
    if (typeof id !== 'string') { hidePanel(local.inspector, local); return; }
    const store = storage?.stores.find((/** @type {any} */ row) => row.id === id);
    const panel = store ? storePanel(store) : h('div', {}, [h('h2', { id: 'health-panel-title' }, id), h('p', {}, 'This store is not listed.')]);
    showPanel(local.inspector, local, { title: 'Store details', labelledBy: 'health-panel-title', body: panel, owner: owners.get(id) ?? null, onClose: () => { if (typeof local.link === 'function') local.link(null); } });
  };
  if (local.route?.store) local.reselectHealth();
  return root;
}
/** @param {any} _params @param {any} _body */
function healthTitle(_params, _body) { return 'Health'; }
export { renderHealth, rerouteHealth, healthTitle };

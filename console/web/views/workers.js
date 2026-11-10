// The read-only harness capability grid and worker concept panel (IC-021).
import { h, mount } from '../dom.js';
import { renderSection } from '../figures.js';
import { createDoctorRead } from '../doctor-read.js';
import { showPanel, hidePanel } from '../shell.js';

const GROUPS = [['worker', 'Worker'], ['orchestration', 'Orchestration']];
/** @param {any} status */
function statusWord(status) { return status === 'supported' ? 'Supported' : status === 'unsupported' ? 'Unsupported' : 'Unknown'; }
/** @param {any} status */
function statusTone(status) { return status === 'supported' ? 'done' : status === 'unsupported' ? 'rejected' : 'unknown'; }
/** @param {any} value */
function text(value) { return value === null || value === undefined ? 'unknown' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
/** @param {any} data @param {string} key */
function setting(data, key) { return data?.keys?.find((/** @type {any} */ item) => item.key === key)?.views?.[0] ?? null; }
/** @param {string} caption @param {string[]} columns @param {any[]} rows */
function table(caption, columns, rows) { return h('table', { class: 'mtable', tabindex: '0' }, [h('caption', {}, caption), h('thead', {}, h('tr', {}, columns.map((col) => h('th', { scope: 'col' }, col)))), h('tbody', {}, rows)]); }
/** @param {any} matrix @param {any} settings @param {any} doctor */
function concept(matrix, settings, doctor) {
  const enabled = setting(settings, 'workers.enabled');
  const models = setting(settings, 'workers.models');
  const billing = setting(settings, 'workers.billing');
  const workers = Array.isArray(enabled?.value) ? enabled.value : [];
  const enabledList = workers.length ? h('ol', {}, workers.map((/** @type {any} */ worker, /** @type {number} */ i) => h('li', {}, `${worker}${worker === 'primary' && i === workers.length - 1 ? ' (primary)' : ''}`))) : h('p', {}, enabled?.value == null ? 'unknown' : 'No workers enabled.');
  const harnesses = matrix?.harnesses ?? [];
  const ids = [...new Set([...workers.filter((/** @type {any} */ w) => w !== 'primary'), ...harnesses.map((/** @type {any} */ item) => item.id)])];
  const rows = ids.map((id) => {
    const matrixRow = harnesses.find((/** @type {any} */ row) => row.id === id);
    const binding = models?.value && typeof models.value === 'object' ? models.value[id] : null;
    const model = binding && typeof binding === 'object' ? Object.entries(binding).map(([tier, value]) => `${tier}: ${text(value)}`).join(', ') || 'unknown' : 'unknown';
    const bill = billing?.value && typeof billing.value === 'object' ? billing.value[id] : null;
    const pool = doctor?.workerPool?.harnesses?.find((/** @type {any} */ row) => row.harness === id);
    const worker = doctor?.workers?.rows?.find((/** @type {any} */ row) => row.harness === id);
    const pending = doctor === null;
    const installed = pending ? 'not checked yet' : pool?.installed == null ? 'unknown' : pool.installed ? 'yes' : 'no';
    const login = pending ? 'not checked yet' : text(pool?.loginState);
    const eligible = pending ? 'not checked yet' : worker?.eligible == null ? 'unknown' : worker.eligible ? 'yes' : 'no';
    const gap = pending ? 'not checked yet' : worker?.firstGap ? [worker.firstGap.requirement, worker.firstGap.result, worker.firstGap.reason].filter(Boolean).join(': ') : worker ? 'none reported' : 'unknown';
    return h('tr', {}, [id, model, text(bill ?? matrixRow?.billing), installed, login, eligible, gap].map((value) => h('td', {}, value)));
  });
  return [h('h2', {}, 'Worker settings'), h('p', {}, `Enabled layer: ${text(enabled?.origin?.layer)}`), enabledList, table('Worker configuration', ['Worker', 'Models', 'Billing', 'Installed', 'Login', 'Eligible', 'First gap'], rows)];
}
/** @param {any} selected @param {any} cell */
function panel(selected, cell) {
  const pairs = [['Harness', selected.harness], ['Group', selected.group], ['Cell', selected.cell], ['Status', statusWord(cell.status)], ['Verification', cell.verification ?? 'not recorded'], ['Verified on', cell.verifiedOn ?? 'not recorded'], ['Reason', cell.reason ?? 'not recorded'], ['Fallback', cell.fallback ?? 'not recorded']];
  return h('div', {}, [h('h2', { id: 'workers-panel-title' }, 'Capability details'), h('dl', {}, pairs.map(([key, value]) => [h('dt', {}, key), h('dd', {}, value)])), h('h3', {}, 'Evidence'), cell.evidence.length ? h('ul', {}, cell.evidence.map((/** @type {string} */ entry) => h('li', {}, entry))) : h('p', {}, 'No evidence recorded'), cell.cut ? h('p', {}, 'Some text of this cell was cut by DoFlow.') : null]);
}
/** @param {any} local */
function rerouteWorkers(local) { if (typeof local.reselectWorkers === 'function') local.reselectWorkers(); }
/** @param {any} body @param {any} _params @param {any} local */
function renderWorkers(body, _params, local) {
  const matrixSection = body?.sections?.matrix;
  const settingsSection = body?.sections?.settings;
  const matrix = matrixSection?.ok ? matrixSection.data : null;
  const settings = settingsSection?.ok ? settingsSection.data : null;
  const host = h('section', { 'aria-label': 'Worker concept' });
  const memory = local.workersMemory ?? (local.workersMemory = { controller: null, drawConcept: null, row: 0, col: 0 });
  const owners = new Map();
  const gridCells = /** @type {any[][]} */ ([]);
  const retry = () => { if (typeof local.retry === 'function') local.retry(); else if (typeof local.refresh === 'function') local.refresh(); };
  memory.drawConcept = (/** @type {any} */ state) => {
    const content = settings ? concept(matrix, settings, state.body?.doctor ?? null) : renderSection(settingsSection, { noun: 'worker settings', onRetry: retry, render: () => null });
    const error = state.error ? h('p', { dataset: { state: 'error' } }, 'Doctor could not be read.') : null;
    mount(host, [content, error]);
  };
  if (!memory.controller) {
    const apiGet = typeof local.apiGet === 'function' ? local.apiGet : () => Promise.reject({ network: true });
    memory.controller = createDoctorRead({ apiGet, onChange: (state) => { if (memory.drawConcept) memory.drawConcept(state); } });
    void memory.controller.open();
  }
  memory.drawConcept(memory.controller.state);
  const selectionKey = (/** @type {any} */ selection) => selection ? `${selection.harness}/${selection.group}/${selection.cell}` : '';
  const applySelection = () => {
    const selected = local.route?.cell;
    for (const row of gridCells) for (const td of row) td.setAttribute('aria-selected', selectionKey(selected) === td.dataset.key ? 'true' : 'false');
    if (!selected) { hidePanel(local.inspector, local); return; }
    const cell = matrix?.harnesses.find((/** @type {any} */ row) => row.id === selected.harness)?.cells?.[selected.group]?.[selected.cell];
    const bodyPanel = cell ? panel(selected, cell) : h('div', {}, [h('h2', { id: 'workers-panel-title' }, 'Capability details'), h('p', {}, 'This capability is not listed.')]);
    showPanel(local.inspector, local, { title: 'Capability details', labelledBy: 'workers-panel-title', body: bodyPanel, owner: owners.get(selectionKey(selected)) ?? null, onClose: () => { if (typeof local.link === 'function') local.link(null); } });
  };
  local.reselectWorkers = applySelection;
  const matrixPart = renderSection(matrixSection, { noun: 'the worker matrix', onRetry: retry, render: (data) => {
    const columns = GROUPS.flatMap(([group]) => data.groups[group].map((/** @type {string} */ name) => ({ group, name })));
    memory.row = Math.max(0, Math.min(memory.row, data.harnesses.length - 1));
    memory.col = Math.max(0, Math.min(memory.col, columns.length - 1));
    const rows = data.harnesses.map((/** @type {any} */ harness, /** @type {number} */ r) => {
      const row = columns.map(({ group, name }, c) => {
        const cell = harness.cells[group][name];
        const key = `${harness.id}/${group}/${name}`;
        const td = h('td', { role: 'gridcell', tabindex: r === memory.row && c === memory.col ? '0' : '-1', 'aria-selected': selectionKey(local.route?.cell) === key ? 'true' : 'false', dataset: { key, row: r, col: c } }, [h('span', { class: 'badge', dataset: { state: statusTone(cell.status) } }, statusWord(cell.status)), cell.declared ? null : ' not declared']);
        owners.set(key, td);
        return td;
      });
      gridCells.push(row);
      return h('tr', {}, [h('th', { scope: 'row' }, harness.id), row]);
    });
    const select = (/** @type {number} */ r, /** @type {number} */ c) => {
      const item = columns[c]; const harness = data.harnesses[r];
      if (!item || !harness) return;
      const cell = { harness: harness.id, group: item.group, cell: item.name };
      if (typeof local.link === 'function') local.link({ cell });
      else globalThis.location.hash = `#/workers/${cell.harness}/${cell.group}/${cell.cell}`;
      local.route = { ...local.route, cell }; applySelection();
    };
    const grid = h('table', { class: 'matrix', role: 'grid', 'aria-label': 'Harness capabilities', on: { keydown: (/** @type {any} */ event) => {
      const td = event.target;
      if (td?.getAttribute?.('role') !== 'gridcell') return;
      let r = Number(td.dataset.row); let c = Number(td.dataset.col);
      if (event.key === 'ArrowUp') r -= 1; else if (event.key === 'ArrowDown') r += 1; else if (event.key === 'ArrowLeft') c -= 1; else if (event.key === 'ArrowRight') c += 1; else if (event.key === 'Home') c = 0; else if (event.key === 'End') c = columns.length - 1; else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(r, c); return; } else return;
      event.preventDefault(); r = Math.max(0, Math.min(r, gridCells.length - 1)); c = Math.max(0, Math.min(c, columns.length - 1));
      gridCells[memory.row]?.[memory.col]?.setAttribute('tabindex', '-1'); memory.row = r; memory.col = c; gridCells[r]?.[c]?.setAttribute('tabindex', '0'); gridCells[r]?.[c]?.focus();
    }, click: (/** @type {any} */ event) => { const td = event.target.closest?.('[role="gridcell"]'); if (td) select(Number(td.dataset.row), Number(td.dataset.col)); } } }, [
      h('caption', {}, 'Harness capabilities'), h('thead', {}, [h('tr', {}, [h('th', { scope: 'col', rowspan: '2' }, 'Harness'), GROUPS.map(([group, label]) => h('th', { scope: 'colgroup', colspan: String(data.groups[group].length) }, label))]), h('tr', {}, columns.map(({ name }) => h('th', { scope: 'col' }, name)))]), h('tbody', {}, rows),
    ]);
    return [grid, h('ul', {}, GROUPS.map(([group, label]) => h('li', {}, `${label}: supported ${data.counts[group].supported}, unknown ${data.counts[group].unknown}, unsupported ${data.counts[group].unsupported}`)))];
  } });
  const root = h('div', {}, [matrixPart, host]);
  if (local.route?.cell) applySelection();
  return root;
}
/** @param {any} _params @param {any} _body */
function workersTitle(_params, _body) { return 'Workers'; }
export { renderWorkers, rerouteWorkers, workersTitle };

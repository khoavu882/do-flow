// Follow-ups and lifecycle overview: read-only views over the sectioned route (IC-019).
import { h, mount } from '../dom.js';
import { renderSection, figure } from '../figures.js';
import { showPanel, hidePanel } from '../shell.js';

const STATES = ['open', 'taken', 'done', 'dismissed', 'all'];
const CURSOR = /^[0-9]{1,15}:[0-9]{8}T[0-9]{9}Z-[0-9a-hjkmnp-tv-z]{6}$/;
const ID = /^FU-[0-9a-hjkmnp-tv-z]{6}$/;
const BUCKETS = [['finished', 'Finished'], ['awaitingRelease', 'Awaiting release'], ['inProgress', 'In progress'], ['unknown', 'Unknown']];
/** @param {any} place */
function placeText(place) {
  if (!place) return 'unknown';
  const names = /** @type {Record<string, string>} */ ({ project: '<project>', 'project-layers': '<project layers>', 'config-home': '<config home>', home: '~', registry: 'core/registry', other: '(elsewhere)' });
  return `${names[place.anchor] ?? '(elsewhere)'}${place.rel ? `/${place.rel}` : ''}`;
}
/** @param {any} local @param {(path: string) => Promise<any>} apiGet */
function loadFollowups(local, apiGet) {
  local.apiGetFollowups = apiGet;
  if (!STATES.includes(local.state)) { local.state = 'open'; local.cursor = null; }
  if (typeof local.cursor !== 'string' || !CURSOR.test(local.cursor)) local.cursor = null;
  const query = `/api/followups?state=${local.state}${local.cursor ? `&cursor=${local.cursor}` : ''}`;
  return apiGet(query);
}
/** @param {string} caption @param {string[]} columns @param {any[]} rows */
function table(caption, columns, rows) {
  return h('table', { class: 'mtable', tabindex: '0' }, [h('caption', {}, caption), h('thead', {}, h('tr', {}, columns.map((name) => h('th', { scope: 'col' }, name)))), h('tbody', {}, rows)]);
}
/** @param {any} value */
function bucketText(value) {
  const remainder = Math.max(0, value.count - value.shown.length);
  const shown = value.shown.join(', ');
  const details = [shown, remainder ? `${remainder} not shown` : ''].filter(Boolean).join('; ');
  return `${value.count}${details ? ` (${details})` : ''}`;
}
/** @param {any} buckets */
function bucketList(buckets) { return h('ul', {}, BUCKETS.map(([key, label]) => h('li', {}, `${label}: ${bucketText(buckets[key])}`))); }
/** @param {any} data */
function overview(data) {
  return h('div', {}, [
    h('section', {}, [h('h2', {}, 'Goals'), h('ul', {}, data.goals.map((/** @type {any} */ goal) => h('li', { class: 'followups__goal' }, [
      h('h3', {}, goal.goal), goal.proposeDone ? h('span', { class: 'tag' }, 'Proposed done') : null, h('p', {}, goal.outcome), h('p', {}, `${goal.items.met} of ${goal.items.total} items met`),
      bucketList(goal.features), goal.nudges.map((/** @type {string} */ nudge) => h('p', {}, nudge)), goal.conflicts ? h('p', {}, `${goal.conflicts} conflicts`) : null,
    ]))), data.goalsNotShown ? h('p', {}, `${data.goalsNotShown} goals not shown`) : null]),
    h('section', { class: 'followups__release' }, [h('h2', {}, 'Release readiness'), h('p', {}, ['Release mode: ', data.releaseMode]), h('p', {}, ['Integration ref: ', data.integrationRef ?? figure('unknown')]), bucketList(data.features), data.gitError ? h('p', {}, `Git error: ${data.gitError}`) : null, data.note ? h('p', {}, data.note) : null]),
    data.intents.length ? h('section', {}, [h('h2', {}, 'Intents'), h('ul', {}, data.intents.map((/** @type {any} */ intent) => h('li', {}, `${placeText(intent.where)}: ${intent.items.join(', ')}`))), data.intentsNotShown ? h('p', {}, `${data.intentsNotShown} intents not shown`) : null]) : null,
  ]);
}
/** @param {any} problem @param {string} title @param {(row:any) => string} text */
function problemList(problem, title, text) {
  if (!problem.n) return null;
  const remainder = Math.max(0, problem.n - problem.rows.length);
  return h('section', {}, [h('p', {}, `${problem.n} ${title}:`), h('ul', {}, problem.rows.map((/** @type {any} */ row) => h('li', {}, text(row)))), remainder ? h('p', {}, `${remainder} more not shown`) : null]);
}
/** @param {any} record */
function recordBody(record) {
  const source = [record.source.kind, record.source.feature, record.source.stage].filter(Boolean).join(' · ');
  const lines = [['Statement', record.statement], ['Source', source], ['State', record.state], ['Taken by', record.takenBy ?? 'not recorded'], ['Intent', placeText(record.intent)], ['Fix', record.fix ?? 'not recorded'], ['Added', record.added ?? 'not recorded'], ['Excerpt', record.excerpt ?? 'not recorded'], ['Body', record.body ? record.body.replaceAll('-', ' ') : 'not recorded']];
  return h('div', {}, [h('h2', { id: 'followup-panel-title' }, record.id), h('dl', {}, lines.map(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])), h('h3', {}, 'History'), record.history.length ? h('ol', {}, record.history.map((/** @type {any} */ event) => h('li', {}, `${event.type} · ${event.at} · ${event.by}`))) : h('p', {}, 'No history recorded'), record.historyNotShown ? h('p', {}, `${record.historyNotShown} older entries not shown`) : null]);
}
/** @param {any} error */
function errorBody(error) {
  if (error?.status === 404 || error?.code === 'followup-not-found') return h('div', {}, [h('h2', { id: 'followup-panel-title' }, 'This page does not exist'), h('p', {}, 'The address does not match any Console view.')]);
  if (error?.status === 501 || error?.code === 'core-lacks-verb') return h('div', {}, [h('h2', { id: 'followup-panel-title' }, 'Follow-up'), h('p', {}, 'This DoFlow core does not provide this follow-up.')]);
  return h('div', {}, [h('h2', { id: 'followup-panel-title' }, 'Follow-up'), h('p', {}, 'The follow-up could not be read.')]);
}
/** @param {any} local */
function rerouteFollowups(local) { if (typeof local.reselectFollowup === 'function') local.reselectFollowup(); }
/** @param {any} data @param {any} _params @param {any} local */
function renderFollowups(data, _params, local) {
  const root = h('div');
  const memory = local.followupMemory ?? (local.followupMemory = { selected: null, record: null, error: null, request: 0 });
  const owners = new Map();
  let currentData = data;
  let pageRequest = 0;
  const refresh = async () => {
    const request = ++pageRequest;
    try {
      const next = await loadFollowups(local, local.apiGetFollowups);
      if (request === pageRequest) { currentData = next; draw(); }
    } catch (/** @type {any} */ error) {
      if (request === pageRequest) {
        currentData = { ...currentData, sections: { ...currentData.sections, list: { ok: false, code: error?.code ?? 'core-error' } } };
        draw();
      }
    }
  };
  const onRetry = () => { void refresh(); };
  const show = () => {
    if (!memory.selected) { hidePanel(local.inspector, local); return; }
    const body = memory.error ? errorBody(memory.error) : memory.record ? recordBody(memory.record) : h('div', {}, [h('h2', { id: 'followup-panel-title' }, memory.selected), h('p', {}, 'Loading follow-up…')]);
    showPanel(local.inspector, local, { title: 'Follow-up', labelledBy: 'followup-panel-title', body, owner: owners.get(memory.selected) ?? null, onClose: () => { if (typeof local.link === 'function') local.link(null); } });
  };
  local.reselectFollowup = () => {
    const selected = typeof local.route?.item === 'string' && ID.test(local.route.item) ? local.route.item : null;
    if (selected === memory.selected) { if (selected) show(); return; }
    memory.selected = selected;
    memory.record = null;
    memory.error = null;
    const request = ++memory.request;
    show();
    if (!selected) return;
    Promise.resolve(local.apiGetFollowups(`/api/followups/${selected}`)).then((answer) => {
      if (request !== memory.request) return;
      memory.record = answer.followup;
      if (!memory.record) memory.error = { status: 404 };
      show();
    }, (error) => { if (request === memory.request) { memory.error = error; show(); } });
  };
  const draw = () => {
    owners.clear();
    const stateFilter = h('select', { id: 'followup-state', on: { change: (/** @type {any} */ event) => {
      if (!STATES.includes(event.target.value)) return;
      local.state = event.target.value; local.cursor = null; void refresh();
    } } }, STATES.map((state) => h('option', { value: state, selected: local.state === state }, state[0].toUpperCase() + state.slice(1))));
    const list = renderSection(currentData.sections?.list, { noun: 'follow-ups', onRetry, render: (listData) => {
      const earlier = local.cursor ? Number(local.cursor.split(':')[0]) : 0;
      const rows = listData.items.map((/** @type {any} */ item) => {
        const link = h('a', { href: `#/followups/${item.id}` }, item.id);
        owners.set(item.id, link);
        return h('tr', {}, [link, item.state, item.statement].map((text) => h('td', {}, text)));
      });
      return h('div', {}, [h('p', { class: 'followups__count' }, `${listData.count} ${local.state} follow-ups; showing ${listData.shown}; ${Math.max(0, listData.count - listData.shown - earlier)} not shown`),
        rows.length ? table('Follow-ups', ['ID', 'State', 'Statement'], rows) : h('p', {}, `No ${local.state} follow-ups.`),
        local.cursor ? h('button', { type: 'button', on: { click: () => { local.cursor = null; void refresh(); } } }, 'First page') : null,
        listData.nextCursor ? h('button', { type: 'button', on: { click: () => { local.cursor = listData.nextCursor; void refresh(); } } }, 'Next page') : null,
        problemList(listData.unreadable, 'follow-up records could not be read', (row) => `${row.file}: ${row.reason ?? 'no reason recorded'}`),
        problemList(listData.conflicts, 'follow-up records are in conflict', (row) => `${row.event} (${row.type}, ${row.code}): ${row.reason}`),
      ]);
    } });
    const overviewNode = renderSection(currentData.sections?.overview, { noun: 'goals and release readiness', onRetry, render: overview });
    mount(root, [h('label', { for: 'followup-state' }, 'State'), stateFilter, list, overviewNode]);
  };
  draw();
  if (local.route?.item || memory.selected) local.reselectFollowup();
  return root;
}
/** @param {any} _params @param {any} _body */
function followupsTitle(_params, _body) { return 'Follow-ups'; }
export { loadFollowups, renderFollowups, rerouteFollowups, followupsTitle };

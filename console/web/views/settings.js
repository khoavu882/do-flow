// Read-only Settings screen (IC-017). API strings are rendered as text nodes.
import { h, icon } from '../dom.js';
import { renderSection } from '../figures.js';
import { groupKeys } from '../derive/settings.js';
import { showPanel, hidePanel } from '../shell.js';

const ENVIRONMENT = 'Settings set by environment variables in the shell that started the Console are not visible here: the Console runs DoFlow without them, so a terminal in that shell may resolve a different value.';
const LAYERS = ['env', 'local', 'project', 'user', 'default'];
/** @param {any} value */
function valueText(value) {
  if (value === null || value === undefined) return 'not set';
  if (value === '(withheld)') return 'withheld';
  return JSON.stringify(value);
}
/** @param {any} place */
function placeText(place) {
  if (!place) return 'not reported';
  const anchors = /** @type {Record<string, string>} */ ({ project: '<project>', 'project-layers': '<project layers>', 'config-home': '<config home>', home: '~', registry: 'core/registry', other: '(elsewhere)' });
  const base = anchors[place.anchor] ?? '(elsewhere)';
  return place.rel ? `${base}/${place.rel}` : base;
}
/** @param {string} caption @param {string[]} columns @param {any[]} rows @param {any} [props] */
function table(caption, columns, rows, props = {}) {
  return h('table', { class: 'mtable', tabindex: '0', ...props }, [h('caption', {}, caption), h('thead', {}, h('tr', {}, columns.map((name) => h('th', { scope: 'col' }, name)))), h('tbody', {}, rows)]);
}
/** @param {any} data */
function effectiveDetails(data) {
  const affected = data.keys.filter((/** @type {any} */ entry) => entry.views.some((/** @type {any} */ view) => ['fail-safe', 'cross-key'].includes(view.origin.via)));
  const notice = data.failSafe || affected.length ? h('section', { dataset: { notice: 'fail-safe' } }, [h('h2', {}, 'Settings resolved safely'), h('ul', {}, affected.map((/** @type {any} */ entry) => h('li', { dataset: { key: entry.key } }, [
    `${entry.key}: `, entry.views.filter((/** @type {any} */ view) => ['fail-safe', 'cross-key'].includes(view.origin.via)).map((/** @type {any} */ view) => [
      `${view.origin.via}. `, data.errors.filter((/** @type {any} */ error) => error.key === entry.key).map((/** @type {any} */ error) => `${error.reason} `),
      view.candidates.map((/** @type {any} */ candidate) => `${candidate.layer} ${candidate.status}${candidate.reason ? `: ${candidate.reason}` : ''}; `),
    ]),
  ])))]) : null;
  const files = table('Settings layer files', ['Layer', 'File', 'Kind', 'Status', 'Code'], data.files.map((/** @type {any} */ file) => h('tr', {}, [file.layer, placeText(file.where), file.kind, file.status, file.code ?? 'none'].map((text) => h('td', {}, text)))), { dataset: { table: 'files' } });
  const issues = [
    ...data.errors.map((/** @type {any} */ issue) => h('li', { dataset: { issue: 'error', code: issue.code } }, `${issue.key ?? 'unknown key'} · ${placeText(issue.where)} · ${issue.reason}`)),
    ...data.notes.map((/** @type {any} */ issue) => h('li', { dataset: { issue: 'note', code: issue.code } }, `${issue.key ?? 'unknown key'} · ${placeText(issue.where)} · ${issue.text}`)),
  ];
  return h('div', {}, [notice, h('h2', {}, 'Layer files'), files, issues.length ? h('ul', {}, issues) : null]);
}
/** @param {any} data */
function schemaDetails(data) {
  return h('section', {}, [h('h2', {}, 'Locked rules'), h('ul', {}, data.invariants.map((/** @type {any} */ rule) => h('li', { dataset: { invariant: rule.id } }, `${rule.id}: ${rule.statement} (${rule.enforcedBy})`)))]);
}
/** @param {any} data @param {Map<string, any>} owners */
function groups(data, owners) {
  if (!data.keys.length) return h('p', {}, 'The DoFlow core listed no settings.');
  return groupKeys(data.keys).map(({ group, keys }, index) => {
    const id = `settings-group-${index}`;
    const rows = keys.flatMap((entry) => entry.views.map((/** @type {any} */ view) => {
      const link = h('a', { href: `#/settings/${entry.key}` }, entry.key);
      if (!owners.has(entry.key)) owners.set(entry.key, link);
      const keyCell = h('th', { scope: 'row' }, [link, entry.views.length > 1 ? ` ${view.view} view` : null, entry.meta.securityRelevant ? h('span', { class: 'tag' }, [icon('info'), 'Security-relevant']) : null]);
      const state = view.origin.via ? `${view.state} (${view.origin.via})` : view.state;
      return h('tr', { dataset: { key: entry.key, view: view.view } }, [keyCell, ...[valueText(view.value), entry.meta.type, valueText(entry.meta.default), entry.meta.scope, state, view.origin.layer, placeText(view.origin.where)].map((text) => h('td', {}, text))]);
    }));
    return h('section', { class: 'sgroup', 'aria-labelledby': id }, [h('h2', { id }, group), table(`${group} settings`, ['Key', 'Value', 'Type', 'Default', 'Scope', 'State', 'Layer', 'Source'], rows)]);
  });
}
/** @param {any} entry @param {any} schema */
function panelBody(entry, schema) {
  const range = schema?.ranges?.find((/** @type {any} */ item) => item.key === entry.key);
  let allowed;
  if (entry.meta.values) allowed = `Allowed values: ${entry.meta.values.map(valueText).join(', ')}`;
  else if (range) {
    const bounds = range.min !== null && range.max !== null ? `${range.min} to ${range.max}` : [range.min !== null ? `minimum ${range.min}` : '', range.max !== null ? `maximum ${range.max}` : '', range.maxItems !== null ? `maximum items ${range.maxItems}` : '', range.maxLength !== null ? `maximum length ${range.maxLength}` : '', range.tiers ? `tiers ${range.tiers.join(', ')}` : ''].filter(Boolean).join(', ');
    allowed = bounds ? `Range: ${bounds}` : 'Range unknown';
  } else allowed = 'Range unknown';
  return h('div', {}, [h('h2', { id: 'settings-panel-title' }, entry.key), h('p', {}, entry.meta.description), h('p', {}, `Type: ${entry.meta.type}`), h('p', {}, allowed), h('p', {}, entry.meta.env ?? 'no environment variable'),
    entry.views.map((/** @type {any} */ view) => [entry.views.length > 1 ? h('h3', {}, `${view.view} view`) : null,
      h('ol', { class: 'candidates' }, LAYERS.map((layer) => {
        const candidates = view.candidates.filter((/** @type {any} */ candidate) => candidate.layer === layer);
        const detail = layer === 'env' && entry.meta.env ? 'not visible to the Console' : candidates.length ? candidates.map((/** @type {any} */ c) => [c.status, c.reason, c.display, placeText(c.where)].filter(Boolean).join(' · ')).join('; ') : 'no value at this layer';
        return h('li', { dataset: { layer } }, `${layer}: ${detail}`);
      })),
    ]),
  ]);
}
/** @param {any} local */
function rerouteSettings(local) { if (typeof local.reselectSettings === 'function') local.reselectSettings(); }
/** @param {any} body @param {any} _params @param {any} local */
function renderSettings(body, _params, local) {
  const effective = body?.sections?.effective;
  const schema = body?.sections?.schema;
  const owners = new Map();
  const onRetry = () => { if (typeof local.refresh === 'function') local.refresh(); };
  const effectiveNode = renderSection(effective, { noun: 'settings', render: effectiveDetails, onRetry });
  const schemaNode = renderSection(schema, { noun: 'the settings schema', render: schemaDetails, onRetry });
  const rows = effective?.ok ? groups(effective.data, owners) : null;
  const root = h('div', {}, [h('p', {}, ENVIRONMENT), effectiveNode, schemaNode, rows]);
  local.reselectSettings = () => {
    const key = local.route?.key;
    if (typeof key !== 'string') { hidePanel(local.inspector, local); return; }
    const entry = effective?.ok ? effective.data.keys.find((/** @type {any} */ item) => item.key === key) : null;
    const panel = entry ? panelBody(entry, schema?.ok ? schema.data : null) : h('div', {}, [h('h2', { id: 'settings-panel-title' }, key), h('p', {}, `${key} is not a setting this DoFlow core lists.`)]);
    showPanel(local.inspector, local, { title: 'Setting details', labelledBy: 'settings-panel-title', body: panel, owner: owners.get(key) ?? null, onClose: () => { if (typeof local.link === 'function') local.link(null); } });
  };
  if (local.route?.key) local.reselectSettings();
  return root;
}
/** @param {any} _params @param {any} _body */
function settingsTitle(_params, _body) { return 'Settings'; }
export { renderSettings, rerouteSettings, settingsTitle };

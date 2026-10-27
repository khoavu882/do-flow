// The Fleet views (V.10; design ui/V8.md): the project list (`#/fleet`) and one project's fleet with its agent tree, the
// response-stream panel, the traffic and "Working together" (`#/fleet/:project[/:agent]`). It shows what records state: who
// exists, how they hang together, what each said and did. It never says that an agent is working now, because no record
// states it (R23): the glyphs say "process seen", "recorded" or "ended" and the words come from derive/fleet.js.
//
// These are `live: true` views. The shell mounts the body once (`render`) and every later push or poll reaches `update`,
// which patches the DOM by key (project key, agent key, call key): the tree, the focused row, an open "Show all" and the
// reading position of the stream all survive a tick. Every string from the Console is a text node (IC-007); the only
// dynamic geometry is an SVG `width` attribute. No path, session id or label other than the record's own reaches the page.

import { h, mount, icon, announce, SVG_NS } from '../dom.js';
import { reltime, clockTime, skel } from '../states.js';
import { createFleetStream } from '../stream.js';
import { notice } from '../notices.js';
import { createPanel } from './transcript.js';
import {
  stamp, nodeTitle, titleIsLabel, kindWord, layoutTree, agentCounts, modelsOf, projectRate, agentRows, modelRows, maxOf, barWidth, tokenLine, toolTime,
  pairGroups, partnersOf, overlapIds, transcriptNote, fleetNodeName, projectDescription, mergeFleet,
} from '../derive/fleet.js';

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** More nodes than this start with levels 3 and deeper collapsed (7b.5 "Default expansion"). */
const EXPAND_ALL_UP_TO = 64;
/** The words of the blind-spot box (7b.4). */
const BLIND_SPOTS = Object.freeze([
  'A project that never wrote DoFlow state and never started a hooked session.',
  'Which DoFlow worker run a harness subagent launched: no record links them.',
  'Whether a main session is still running: records hold start and last-record times, never a heartbeat.',
  'Reply text from OpenCode: DoFlow has no transcript reader for it.',
  'Reply text from Antigravity: its sessions are not linked to a transcript.',
]);

const errorSentence = (/** @type {string} */ code) => `This section could not be read (code ${code}).`;

// ---- small pieces ----------------------------------------------------------------------------------

/** The 64 by 4 bar: an SVG whose fill `width` attribute is the value over the largest, and nothing else (7b.7). @param {number} width */
function bar(width) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 4');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'bar');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const track = document.createElementNS(SVG_NS, 'rect');
  track.setAttribute('class', 'bar__track');
  track.setAttribute('width', '100');
  track.setAttribute('height', '4');
  const fill = document.createElementNS(SVG_NS, 'rect');
  fill.setAttribute('class', 'bar__fill');
  fill.setAttribute('width', String(width));
  fill.setAttribute('height', '4');
  svg.append(track, fill);
  return svg;
}

/** @param {any} el @param {number} width */
function setBar(el, width) {
  const fill = el && el.querySelector('.bar__fill');
  if (fill && fill.getAttribute('width') !== String(width)) fill.setAttribute('width', String(width));
}

/** Sets a text only when it differs, so an unchanged tick writes nothing. @param {any} el @param {string} value */
function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

/**
 * Keeps `parent`'s children equal to `keys` in order, reusing the element of each key: existing elements are patched and
 * moved only when out of place (a move of the focused element would drop its focus). `known` is the caller's key to element map.
 * @param {any} parent @param {string[]} keys @param {Map<string, any>} known @param {(key: string) => any} create @param {(el: any, key: string) => void} patch
 */
function reconcile(parent, keys, known, create, patch) {
  const want = new Set(keys);
  for (const [key, el] of [...known]) {
    if (!want.has(key)) {
      el.remove();
      known.delete(key);
    }
  }
  keys.forEach((key, index) => {
    let el = known.get(key);
    if (!el) {
      el = create(key);
      known.set(key, el);
    }
    patch(el, key);
    const at = Array.from(parent.children)[index];
    if (at !== el) parent.insertBefore(el, at ?? null);
  });
}

/** Runs `fn`, then hands the focus back to the element with the same `data-focus-key` if it was lost. @param {any} root @param {() => void} fn */
function keepFocus(root, fn) {
  const focused = document.activeElement;
  const owner = /** @type {any} */ (focused && typeof focused.closest === 'function' && root.contains(focused) ? focused.closest('[data-focus-key]') : null);
  const key = owner && owner.dataset ? owner.dataset.focusKey : null;
  fn();
  if (key && !root.contains(document.activeElement)) {
    const again = root.querySelector(`[data-focus-key="${key}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

/** @param {any[]} list @param {any} first */
const withSep = (list, first = null) => list.filter(Boolean).flatMap((item, index) => (index === 0 && first === null ? [item] : [h('span', { class: 'view-head__sep', 'aria-hidden': 'true' }, '·'), item]));

// ---- the transport line (7b.3) ---------------------------------------------------------------------------

/** The glyph and sentence of the transport line for the current state. @param {any} local @param {number} now */
function transportOf(local, now) {
  const stream = local.stream;
  const mode = local.transport ? local.transport.mode : 'connecting';
  const frame = stream && stream.lastFrameAt !== null ? stream.lastFrameAt : null;
  const updated = frame === null ? '' : ` · updated ${clockTime(frame)}`;
  if (stream && stream.paused) return { token: 'unknown', face: 'pause', text: `Paused${updated}` };
  if (stream && stream.isStale()) {
    const lost = frame === null ? 0 : Math.max(0, Math.floor((now - frame) / 1000));
    return { token: 'stale', face: 'stale', text: `No update for ${lost} s${frame === null ? '' : ` · last ${clockTime(frame)}`}` };
  }
  if (local.tickError) return { token: 'failed', face: 'failed', text: `The last update failed (code ${local.tickError}); the data shown is the last good one${updated}` };
  if (mode === 'push') return { token: 'done', face: 'check', text: `Pushed by the Console${updated}` };
  if (mode === 'limit') return { token: 'unknown', face: 'unknown', text: 'Another tab holds this page’s push; this tab polls every 5 s' };
  if (mode === 'fallback') return { token: 'unknown', face: 'unknown', text: `Push unavailable: polling every 5 s${updated}` };
  return { token: 'pending', face: 'pending', text: 'Connecting…' };
}

/** @param {any} local @param {number} [now] */
function refreshTransport(local, now = Date.now()) {
  const line = local.els && local.els.transport;
  if (!line) return;
  const next = transportOf(local, now);
  const key = `${next.token}|${next.text}`;
  if (local.transportKey === key) return;
  local.transportKey = key;
  const mark = h('span', { class: 'ftransport__mark', dataset: { state: next.token } }, icon(next.face, 12));
  mount(line, [mark, h('span', { class: 'ftransport__text' }, next.text)]);
}

function transportLine() {
  return h('p', { class: 'fleet-transport' });
}

// ---- the connection (stream.js behind the shell's poller interface) ----------------------------------------

/**
 * `spec.connect` of both Fleet views: one stream per page. Snapshots and deltas are merged into the fleet body and handed to
 * the shell as data; the transcript goes to the panel; the transport line and the announcements follow the mode.
 * @param {any} local @param {any} params @param {{ fetchJson: any, onData: (body: any) => void, onFailure: (error: any) => void, onResync?: () => void }} hooks
 */
function connectFleet(local, params, { fetchJson, onData, onFailure, onResync = () => {} }) {
  local.transport = { mode: 'connecting', reason: null };
  local.tickError = null;
  local.body = null;
  const stream = createFleetStream({
    project: params.project ?? null,
    agent: params.agent ?? null,
    fetchJson,
    handlers: {
      resync() {
        onResync();
      },
      snapshot(body) {
        local.body = body;
        local.tickError = null;
        onData(body);
        refreshTransport(local);
      },
      fleet(delta) {
        const merged = mergeFleet(local.body, delta);
        if (merged === local.body) return;
        local.body = merged;
        local.tickError = null;
        onData(merged);
        refreshTransport(local);
      },
      transcript(body, meta) {
        local.tickError = null;
        if (local.panel) local.panel.receive(body, meta);
        refreshTransport(local);
      },
      streamError(info) {
        local.tickError = info && typeof info.code === 'string' ? info.code : 'unknown';
        if (local.panel) local.panel.setMissing(local.tickError);
        local.missingCode = local.tickError;
        refreshTransport(local);
      },
      mode(state) {
        const was = local.transport.mode;
        local.transport = state;
        if (state.mode === 'fallback' || state.mode === 'limit') {
          if (was === 'push' || was === 'connecting') notice('push-lost');
          local.wasFallback = true;
        } else if (state.mode === 'push' && local.wasFallback) {
          notice('push-back');
          local.wasFallback = false;
        }
        refreshTransport(local);
      },
      failure(error) {
        onFailure(error);
      },
    },
  });
  local.stream = stream;
  return stream;
}

/** The shell's 1 s timer: the transport line counts the seconds without an update. @param {any} root @param {number} now @param {any} local */
function tickFleet(root, now, local) {
  refreshTransport(local, now);
}

/** The shell leaves the view: the stream closes, the panel's timers end. @param {any} local */
function teardownFleet(local) {
  if (local.panel) local.panel.destroy();
  if (local.typeTimer) globalThis.clearTimeout(local.typeTimer);
}

// ---- V8a: the project list ----------------------------------------------------------------------------------

/** @param {any} section */
const treeOf = (section) => (section && section.ok ? section.data : null);

let descriptionSeq = 0;

/** @param {any} project @param {number} now @param {number} maxRate */
function projectRowParts(project, now, maxRate) {
  const tree = treeOf(project.tree);
  const traffic = treeOf(project.traffic);
  const counts = tree ? agentCounts(tree) : null;
  const models = tree ? modelsOf(tree) : [];
  const rate = traffic ? projectRate(traffic) : null;
  return { tree, traffic, counts, models, rate, maxRate, now };
}

/** The "1 main session · 4 subagents · 2 worker runs" line. @param {any} counts */
function countsLine(counts) {
  const words = [];
  if (counts.main > 0) words.push(plural(counts.main, 'main session'));
  if (counts.subagents > 0) words.push(plural(counts.subagents, 'subagent'));
  if (counts.workers > 0) words.push(plural(counts.workers, 'worker run'));
  return words.length ? words.join(' · ') : 'no agent recorded';
}

/** @param {any} project @param {number} now @param {number} maxRate */
function createProjectRow(project, now, maxRate) {
  descriptionSeq += 1;
  const id = `pd-${descriptionSeq}`;
  const li = h('li', { class: 'project-row', dataset: { key: project.projectKey, focusKey: `project:${project.projectKey}` } }, [
    h('div', { class: 'pr__name' }, [h('a', { class: 'pr__link', href: `#/fleet/${project.projectKey}`, 'aria-describedby': id }, ''), h('span', { class: 'pr__tag' }), h('span', { class: 'pr__co' })]),
    h('div', { class: 'pr__agents' }, [h('span', { class: 'pr__counts' }), h('span', { class: 'pr__seen' })]),
    h('div', { class: 'pr__models' }),
    h('div', { class: 'pr__traffic' }),
    h('div', { class: 'pr__last' }),
    h('span', { class: 'vh', id }, ''),
  ]);
  patchProjectRow(li, project, now, maxRate);
  return li;
}

/** @param {any} li @param {any} project @param {number} now @param {number} maxRate */
function patchProjectRow(li, project, now, maxRate) {
  const part = projectRowParts(project, now, maxRate);
  setText(li.querySelector('.pr__link'), project.label);
  const tag = li.querySelector('.pr__tag');
  if (project.current && tag.children.length === 0) mount(tag, h('span', { class: 'tag tag--accent' }, 'this project'));
  else if (!project.current && tag.children.length > 0) mount(tag, []);
  setText(li.querySelector('.pr__co'), plural(project.checkouts, 'checkout'));

  const counts = li.querySelector('.pr__counts');
  const seen = li.querySelector('.pr__seen');
  if (project.tree && !project.tree.ok) {
    mount(counts, [icon('failed', 12), ' ', errorSentence(project.tree.code)]);
    mount(seen, []);
  } else if (part.counts) {
    mount(counts, countsLine(part.counts));
    mount(seen, part.counts.processSeen > 0 ? [h('span', { class: 'pr__dot', 'aria-hidden': 'true' }), ` ${plural(part.counts.processSeen, 'process', 'processes')} seen`] : []);
  }

  const models = li.querySelector('.pr__models');
  const shown = part.models.slice(0, 3);
  mount(models, [...shown.map((model) => h('span', { class: 'model-chip' }, model)), part.models.length > 3 ? h('span', { class: 'pr__more' }, `+${part.models.length - 3}`) : null]);

  const traffic = li.querySelector('.pr__traffic');
  if (project.traffic && !project.traffic.ok) mount(traffic, [icon('failed', 12), ' ', errorSentence(project.traffic.code)]);
  else if (part.rate === null) mount(traffic, h('span', { class: 'pr__none' }, 'no linked transcript'));
  else mount(traffic, [h('span', { class: 'num' }, String(part.rate)), ' events/min ', bar(barWidth(part.rate, part.maxRate))]);

  const last = li.querySelector('.pr__last');
  if (project.lastRecordAt) mount(last, [h('time', { class: 'mono', datetime: project.lastRecordAt }, stamp(project.lastRecordAt, now)), ' ', h('span', { class: 'pr__rel' }, reltime(project.lastRecordAt, now))]);
  else mount(last, h('span', { class: 'pr__none' }, 'no record time'));

  setText(li.querySelector('.vh'), projectDescription(project, now));
}

/** The "Not listed" lines (7b.4). @param {any} data */
function limitLines(data) {
  const e = data.excluded ?? {};
  const lines = [
    `${e.missing ?? 0} ${(e.missing ?? 0) === 1 ? 'root no longer exists' : 'roots no longer exist'}`,
    `${e.temp ?? 0} under a temporary directory`,
    `${e.notDoflow ?? 0} without DoFlow state`,
    `${e.unreadable ?? 0} unreadable`,
  ];
  const more = data.limits ? data.limits.projectsNotShown : 0;
  if (more > 0) lines.push(`${more} more projects not shown (${data.limits.projectsShown} shown)`);
  return lines;
}

/** @param {any} data @param {any} params @param {any} local */
function renderFleetList(data, params, local) {
  const now = Date.now();
  local.rows = new Map();
  local.els = { transport: transportLine() };
  local.projectList = h('ul', { class: 'project-list' });
  local.limitsBox = h('div', { class: 'fleet-limits' });
  local.firstPaint = true;
  const root = h('div', { class: 'fleet fleet--list' }, [
    local.els.transport,
    local.projectList,
    h('div', { class: 'fleet-footer' }, [
      local.limitsBox,
      h('div', { class: 'fleet-blind' }, [h('h2', { class: 'fleet-box__title' }, 'What this view cannot see'), h('ul', {}, BLIND_SPOTS.map((line) => h('li', {}, line)))]),
    ]),
  ]);
  refreshTransport(local, now);
  updateFleetList(local, data);
  local.firstPaint = false;
  return root;
}

/** @param {any} local @param {any} data */
function updateFleetList(local, data) {
  const now = Date.now();
  const maxRate = data.projects.reduce((/** @type {number} */ max, /** @type {any} */ project) => {
    const traffic = treeOf(project.traffic);
    const rate = traffic ? projectRate(traffic) : null;
    return rate !== null && rate > max ? rate : max;
  }, 0);
  const byKey = new Map(data.projects.map((/** @type {any} */ project) => [project.projectKey, project]));
  reconcile(local.projectList, data.projects.map((/** @type {any} */ project) => project.projectKey), local.rows,
    (key) => createProjectRow(byKey.get(key), now, maxRate), (el, key) => patchProjectRow(el, byKey.get(key), now, maxRate));
  mount(local.limitsBox, [h('h2', { class: 'fleet-box__title' }, 'Not listed'), h('ul', {}, limitLines(data).map((line) => h('li', {}, line)))]);
  refreshTransport(local, now);
}

/** The head's meta line of the list. @param {any} params @param {any} data */
function listMeta(params, data) {
  if (!data) return null;
  return h('p', { class: 'view-head__meta' }, withSep([plural(data.projects.length, 'project') + ' on this machine', 'traffic over the last 10 min']));
}

/** The empty panels of the list: no project, and no user state. @param {any} data */
function listEmpty(data) {
  if (data.store === 'absent') return { title: 'This machine has no DoFlow user state', sentence: 'No HOME was found, so no project list can be read.' };
  return {
    title: 'No DoFlow project on this machine yet',
    sentence: 'A project appears here once DoFlow writes state in it or a hooked session starts there. A project with neither is not listed.',
    command: 'doflow doctor',
  };
}

// ---- V8b and V8c: one project -----------------------------------------------------------------------------------

/** The head of a project: crumb, the label in mono and the meta line. @param {any} params */
function buildProjectHead(params) {
  const agentCrumb = h('span', { class: 'fleet-crumb__agent' });
  const crumb = h('nav', { class: 'run-head__crumb fleet-crumb', 'aria-label': 'Breadcrumb' }, [
    h('a', { href: '#/fleet' }, 'Fleet'), h('span', { 'aria-hidden': 'true' }, ' / '), h('a', { class: 'fleet-crumb__label mono', href: `#/fleet/${params.project}` }, 'Project'),
    h('span', { class: 'fleet-crumb__sep', 'aria-hidden': 'true' }, ' / '), agentCrumb,
  ]);
  const h1 = h('h1', { class: 'view-title mono fleet-title', tabindex: '-1' }, [h('span', { class: 'fleet-title__label' }, 'Project'), h('span', { class: 'fleet-title__tag' })]);
  const meta = h('div', { class: 'view-head__metawrap' });
  return { root: h('header', { class: 'view-head fleet-head' }, [crumb, h1, meta]), h1, meta, step: null };
}

/** @param {any} data @param {any} params */
const projectOf = (data, params) => data.projects.find((/** @type {any} */ project) => project.projectKey === params.project) ?? null;

/** The meta line of a project (7b.5). @param {any} params @param {any} data @param {number} now */
function projectMeta(params, data, now) {
  if (!data) return null;
  const project = projectOf(data, params);
  if (!project) return null;
  const tree = treeOf(project.tree);
  const notChecked = tree && tree.limits ? tree.limits.notChecked : 0;
  const items = [
    plural(project.checkouts, 'checkout'),
    tree ? plural(tree.nodes.length, 'agent') : null,
    `last record ${stamp(project.lastRecordAt, now)}`,
    notChecked > 0 ? `${notChecked} not checked` : null,
  ];
  return h('p', { class: 'view-head__meta' }, withSep(items));
}

/** @param {any} params @param {any} data */
function projectTitle(params, data) {
  const project = data ? projectOf(data, params) : null;
  if (!project) return 'Fleet';
  const tree = treeOf(project.tree);
  const node = params.agent && tree ? tree.nodes.find((/** @type {any} */ n) => n.agentKey === params.agent) : null;
  return node ? `${nodeTitle(node)} · ${project.label} · Fleet` : `${project.label} · Fleet`;
}

/** The glyph of a node's liveness (7b.5 table). @param {any} node */
function livenessGlyph(node) {
  if (node.ended) return h('span', { class: `fnode__glyph fnode__glyph--dot fnode__glyph--${/fail|error|abandon|cancel/i.test(String(node.ended.result)) ? 'failed' : 'done'}`, 'aria-hidden': 'true' });
  if (node.liveness === 'process-seen') return h('span', { class: 'fnode__glyph fnode__glyph--dot fnode__glyph--running', 'aria-hidden': 'true' });
  if (node.liveness === 'process-gone') return h('span', { class: 'fnode__glyph fnode__glyph--clock', 'aria-hidden': 'true' }, icon('stale', 12));
  return h('span', { class: 'fnode__glyph fnode__glyph--ring', 'aria-hidden': 'true' });
}

/** @param {any} node */
const livenessToken = (node) => (node.ended ? `ended:${node.ended.result}` : node.liveness);

/** A tree node's row content. @param {any} item @param {any} traffic @param {any} ctx */
function nodeRow(item, traffic, ctx) {
  const node = item.node;
  const note = transcriptNote(node);
  const model = typeof node.model === 'string' ? [h('span', { class: 'mono' }, node.model), node.modelBasis === 'hook-observation' ? ' (first seen)' : ''] : ['model not recorded'];
  const side = [];
  if (traffic && typeof traffic.eventsPerMin === 'number') side.push(h('span', { class: 'num' }, `${traffic.eventsPerMin}/min`));
  if (traffic && typeof traffic.toolCalls === 'number') side.push(h('span', { class: 'num' }, plural(traffic.toolCalls, 'tool')));
  const partner = ctx.partner;
  if (partner && partner.size > 0) {
    if (partner.has('same-task')) side.push(h('span', { class: 'tag' }, 'same task'));
    if (partner.has('same-model')) side.push(h('span', { class: 'tag' }, 'same model'));
    if (partner.has('overlap')) side.push(h('span', { class: 'badge', dataset: { state: 'awaiting' } }, [icon('awaiting', 12), 'overlap']));
  }
  return [
    livenessGlyph(node),
    h('div', { class: 'fnode__main' }, [
      h('p', { class: 'fnode__title' }, [
        h('span', { class: 'fnode__name' }, nodeTitle(node)),
        titleIsLabel(node) ? h('span', { class: 'tag' }, kindWord(node)) : null,
        node.harness ? h('span', { class: 'tag tag--mono' }, node.harness) : null,
        item.childCount > 0 && !ctx.expanded ? h('span', { class: 'fnode__more' }, `+${item.childCount}`) : null,
      ]),
      h('p', { class: 'fnode__meta' }, [item.level >= 5 ? `level ${item.level} · ` : '', ...model, ` · started ${stamp(node.startedAt, ctx.now)} · last record ${stamp(node.lastRecordAt, ctx.now)}`]),
      note ? h('p', { class: 'fnode__note' }, [icon('info', 12), note]) : null,
    ]),
    h('div', { class: 'fnode__side' }, side),
    ctx.selected ? icon('chevron-right', 16) : h('span', { class: 'fnode__spacer' }),
  ];
}

/** True when `key` is open: the person's choice, else the default of 7b.5. @param {any} local @param {any} item @param {number} total */
function isExpanded(local, item, total) {
  if (local.expanded.has(item.key)) return Boolean(local.expanded.get(item.key));
  return total <= EXPAND_ALL_UP_TO || item.level < 3;
}

/** The list of the nodes that can be reached by keyboard, in tree order. @param {any} local */
function visibleKeys(local) {
  const layout = local.layout;
  const total = layout.items.length;
  const open = new Map(layout.items.map((/** @type {any} */ item) => [item.key, isExpanded(local, item, total)]));
  return layout.items.filter((/** @type {any} */ item) => {
    for (let up = item.parent; up !== null; up = layout.parent.get(up) ?? null) if (!open.get(up)) return false;
    return true;
  }).map((/** @type {any} */ item) => item.key);
}

/** @param {any} local @param {string} key */
function focusNode(local, key) {
  const li = local.nodes.get(key);
  if (!li) return;
  local.tabKey = key;
  for (const [other, el] of local.nodes) el.setAttribute('tabindex', other === key ? '0' : '-1');
  li.focus({ preventScroll: false });
}

/** @param {any} local @param {string} key */
function selectAgent(local, key) {
  globalThis.location.hash = `#/fleet/${local.params.project}/${key}`;
}

/** Typeahead: the next visible node whose title starts with the typed text (500 ms buffer). @param {any} local @param {string} char @param {string} from */
function typeahead(local, char, from) {
  if (local.typeTimer) globalThis.clearTimeout(local.typeTimer);
  local.typed = `${local.typed ?? ''}${char.toLowerCase()}`;
  local.typeTimer = globalThis.setTimeout(() => {
    local.typed = '';
    local.typeTimer = null;
  }, 500);
  const keys = visibleKeys(local);
  const at = keys.indexOf(from);
  const ordered = [...keys.slice(at + 1), ...keys.slice(0, at + 1)];
  const hit = ordered.find((key) => nodeTitle(local.layout.byKey.get(key)).toLowerCase().startsWith(local.typed));
  if (hit) focusNode(local, hit);
}

/** @param {any} local @param {any} event */
function onTreeKey(local, event) {
  const li = event.target && typeof event.target.closest === 'function' ? event.target.closest('.fnode') : null;
  if (!li || event.target !== li) return;
  const key = li.dataset.key;
  const keys = visibleKeys(local);
  const at = keys.indexOf(key);
  const item = local.layout.items.find((/** @type {any} */ entry) => entry.key === key);
  const total = local.layout.items.length;
  const open = item && item.childCount > 0 ? isExpanded(local, item, total) : false;
  const go = (/** @type {string | undefined} */ to) => {
    event.preventDefault();
    if (to) focusNode(local, to);
  };
  switch (event.key) {
    case 'ArrowDown': go(keys[Math.min(keys.length - 1, at + 1)]); break;
    case 'ArrowUp': go(keys[Math.max(0, at - 1)]); break;
    case 'Home': go(keys[0]); break;
    case 'End': go(keys[keys.length - 1]); break;
    case 'ArrowRight':
      event.preventDefault();
      if (item && item.childCount > 0 && !open) {
        local.expanded.set(key, true);
        patchTree(local);
      } else if (item && item.childCount > 0) focusNode(local, local.layout.children.get(key)[0]);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      if (item && item.childCount > 0 && open) {
        local.expanded.set(key, false);
        patchTree(local);
      } else if (item && item.parent !== null) focusNode(local, item.parent);
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      selectAgent(local, key);
      break;
    default:
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) typeahead(local, event.key, key);
  }
}

/** @param {any} local @param {string} key */
function createNode(local, key) {
  const li = h('li', { class: 'fnode', role: 'treeitem', tabindex: '-1', dataset: { key, focusKey: `agent:${key}` } });
  li.append(h('div', { class: 'fnode__row' }));
  li.querySelector('.fnode__row').addEventListener('click', () => selectAgent(local, key));
  return li;
}

/** Patches one tree node and, recursively, its children. @param {any} local @param {any} item @param {number} now */
function patchNode(local, item, now) {
  const li = local.nodes.get(item.key);
  const node = item.node;
  const total = local.layout.items.length;
  const expanded = item.childCount > 0 ? isExpanded(local, item, total) : false;
  const traffic = local.trafficBy.get(item.key) ?? null;
  const selected = local.params.agent === item.key;
  const partner = local.partners.get(item.key) ?? null;
  const token = livenessToken(node);
  const row = li.querySelector('.fnode__row');
  const sig = JSON.stringify([node, item.level, item.childCount, expanded, selected, traffic && [traffic.eventsPerMin, traffic.toolCalls], partner && [...partner]]);
  if (local.nodeSig.get(item.key) !== sig) {
    local.nodeSig.set(item.key, sig);
    mount(row, nodeRow(item, traffic, { now, expanded, selected, partner }));
  }
  li.setAttribute('aria-level', String(item.level));
  li.setAttribute('aria-setsize', String(item.setSize));
  li.setAttribute('aria-posinset', String(item.pos));
  if (item.childCount > 0) li.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  else li.removeAttribute('aria-expanded');
  li.setAttribute('aria-selected', selected ? 'true' : 'false');
  li.setAttribute('aria-label', fleetNodeName(node, traffic, { nowMs: now, tickAt: local.tickAt ?? null, partner, orphan: item.orphan }));
  li.dataset.kind = node.kind;
  li.dataset.liveness = token;
  const previous = local.liveness.get(item.key);
  if (previous === undefined) {
    if (!local.firstPaint) li.dataset.fresh = 'true';
  } else if (previous !== token) li.dataset.fresh = 'true';
  else delete li.dataset.fresh;
  local.liveness.set(item.key, token);

  const kids = local.layout.children.get(item.key) ?? [];
  let group = li.querySelector('ul');
  if (kids.length === 0) {
    if (group) group.remove();
    return;
  }
  if (!group) {
    group = h('ul', { role: 'group' });
    li.append(group);
  }
  if (expanded) group.removeAttribute('hidden');
  else group.setAttribute('hidden', '');
  syncGroup(local, group, kids, now);
}

/** @param {any} local @param {any} ul @param {string[]} keys @param {number} now */
function syncGroup(local, ul, keys, now) {
  const items = new Map(local.layout.items.map((/** @type {any} */ item) => [item.key, item]));
  // The children of this group only: a node that left it (or the records) takes its own subtree out of the page.
  const here = new Map(Array.from(ul.children).map((/** @type {any} */ el) => [el.dataset.key, el]));
  const want = new Set(keys);
  for (const [key, el] of here) {
    if (want.has(key)) continue;
    for (const inner of [el, ...el.querySelectorAll('.fnode')]) local.nodes.delete(inner.dataset.key);
  }
  reconcile(ul, keys, here, (key) => {
    const li = createNode(local, key);
    local.nodes.set(key, li);
    return li;
  }, (el, key) => patchNode(local, items.get(key), now));
}

/** Rebuilds the tree from `local.layout`; the focused row stays the same element. @param {any} local */
function patchTree(local) {
  const now = Date.now();
  const roots = local.layout.roots;
  // The divider before the first node with no parent (7b.5): a presentational row.
  const orphanStart = local.layout.orphans.length > 0 ? local.layout.orphans[0] : null;
  local.nodes.forEach((/** @type {any} */ el) => el.removeAttribute('data-orphan-start'));
  syncGroup(local, local.treeEl, roots, now);
  if (orphanStart && local.nodes.get(orphanStart)) local.nodes.get(orphanStart).dataset.orphanStart = 'true';
  const alive = new Set(local.layout.items.map((/** @type {any} */ item) => item.key));
  for (const key of [...local.nodeSig.keys()]) if (!alive.has(key)) { local.nodeSig.delete(key); local.liveness.delete(key); }
  // The tab stop: the node last focused, else the selected one, else the first (roving tabindex).
  if (!alive.has(local.tabKey)) local.tabKey = local.params.agent && alive.has(local.params.agent) ? local.params.agent : roots[0] ?? null;
  for (const [key, el] of local.nodes) el.setAttribute('tabindex', key === local.tabKey ? '0' : '-1');
}

// ---- traffic tables and "Working together" -----------------------------------------------------------------

/** @param {any} label @param {string} text */
const cell = (label, text = '') => h('td', { dataset: { label } }, text);

/** @param {any} local @param {string} key */
function createAgentRow(local, key) {
  const tr = h('tr', { dataset: { key } });
  tr.append(
    h('th', { scope: 'row', class: 'ttable__agent' }, [h('button', { type: 'button', class: 'btn btn--ghost ttable__btn', dataset: { focusKey: `trow:${key}` }, on: { click: () => selectAgent(local, key) } }, '')]),
    cell('Model'), cell('Events/min'), cell('Tool calls'), cell('Tool time'), cell('Tokens'), cell('Last record'),
  );
  return tr;
}

const NOT_RECORDED = 'not recorded';

/** @param {any} tr @param {any} row @param {number} maxRate @param {number} now */
function patchAgentRow(tr, row, maxRate, now) {
  const cells = tr.querySelectorAll('td');
  const button = tr.querySelector('.ttable__btn');
  const node = row.node;
  setText(button, node ? nodeTitle(node) : 'Agent no longer in the tree');
  const harness = tr.querySelector('.ttable__agent');
  let tag = harness.querySelector('.tag');
  const harnessName = row.harness ?? (node ? node.harness : null);
  if (harnessName && !tag) harness.append(h('span', { class: 'tag tag--mono' }, harnessName));
  else if (harnessName) setText(tag, harnessName);
  else if (tag) tag.remove();
  const dim = (/** @type {string} */ text) => h('span', { class: 'ttable__none' }, text);
  mount(cells[0], row.model ? h('span', { class: 'mono' }, row.model) : dim(NOT_RECORDED));
  mount(cells[1], typeof row.eventsPerMin === 'number' ? [h('span', { class: 'num' }, String(row.eventsPerMin)), ' ', bar(barWidth(row.eventsPerMin, maxRate))] : dim(NOT_RECORDED));
  mount(cells[2], typeof row.toolCalls === 'number'
    ? [h('span', { class: 'num' }, String(row.toolCalls)), typeof row.toolErrors === 'number' && row.toolErrors > 0 ? h('span', { class: 'ttable__err' }, [icon('failed', 12), plural(row.toolErrors, 'error')]) : null]
    : dim(NOT_RECORDED));
  const duration = toolTime(row.toolDurationMs);
  mount(cells[3], duration ? [duration.line, ' ', h('span', { class: 'ttable__n' }, duration.n)] : dim(NOT_RECORDED));
  const tokens = tokenLine(row.tokens);
  mount(cells[4], tokens ?? dim(NOT_RECORDED));
  mount(cells[5], row.lastRecordAt ? h('time', { class: 'mono', datetime: row.lastRecordAt }, stamp(row.lastRecordAt, now)) : '–');
}

/** @param {string} key */
function createModelRow(key) {
  const tr = h('tr', { dataset: { key } });
  tr.append(h('th', { scope: 'row', class: 'mono' }, key), cell('Agents'), cell('Events/min'), cell('Tool calls'), cell('Tokens'));
  return tr;
}

/** @param {any} tr @param {any} row @param {number} maxRate */
function patchModelRow(tr, row, maxRate) {
  const cells = tr.querySelectorAll('td');
  const dim = (/** @type {string} */ text) => h('span', { class: 'ttable__none' }, text);
  mount(cells[0], String(row.agents));
  mount(cells[1], typeof row.eventsPerMin === 'number' ? [h('span', { class: 'num' }, String(row.eventsPerMin)), ' ', bar(barWidth(row.eventsPerMin, maxRate))] : dim(NOT_RECORDED));
  mount(cells[2], typeof row.toolCalls === 'number' ? h('span', { class: 'num' }, String(row.toolCalls)) : dim(NOT_RECORDED));
  const tokens = tokenLine(row.tokens);
  mount(cells[3], tokens ?? dim(NOT_RECORDED));
}

/** @param {string[]} heads */
function tableHead(heads) {
  return h('thead', {}, h('tr', {}, heads.map((text) => h('th', { scope: 'col' }, text))));
}

/** @param {any} local */
function trafficSection(local) {
  local.agentBody = h('tbody');
  local.modelBody = h('tbody');
  local.agentRows = new Map();
  local.modelRows = new Map();
  local.trafficNote = h('p', { class: 'view-note traffic__note' });
  const seg = h('div', { class: 'segmented traffic__switch', role: 'radiogroup', 'aria-label': 'Group traffic by' }, [['agent', 'Per agent'], ['model', 'Per model']].map(([id, word]) => h('button', {
    type: 'button', role: 'radio', class: 'segmented__opt', 'aria-checked': id === 'agent' ? 'true' : 'false', tabindex: id === 'agent' ? '0' : '-1', dataset: { group: id, focusKey: `traffic-${id}` },
  }, word)));
  const setGroup = (/** @type {string} */ id) => {
    local.trafficGroup = id;
    local.els.traffic.dataset.group = id;
    for (const opt of seg.querySelectorAll('.segmented__opt')) {
      const on = opt.dataset.group === id;
      opt.setAttribute('aria-checked', on ? 'true' : 'false');
      opt.setAttribute('tabindex', on ? '0' : '-1');
    }
  };
  const opts = Array.from(seg.querySelectorAll('.segmented__opt'));
  for (const opt of opts) {
    opt.addEventListener('click', () => setGroup(opt.dataset.group));
    opt.addEventListener('keydown', (/** @type {any} */ event) => {
      /** @type {Record<string, number>} */
      const steps = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
      if (steps[event.key] === undefined) return;
      event.preventDefault();
      const next = opts[(opts.indexOf(opt) + steps[event.key] + opts.length) % opts.length];
      next.focus();
      setGroup(next.dataset.group);
    });
  }
  const section = h('section', { class: 'traffic', 'aria-labelledby': 'traffic-title', dataset: { group: 'agent' } }, [
    h('div', { class: 'traffic__head' }, [h('h2', { id: 'traffic-title' }, 'Traffic'), h('span', { class: 'traffic__window' }, 'last 10 min'), seg]),
    h('table', { class: 'ttable ttable--agents' }, [h('caption', { class: 'vh' }, 'Traffic per agent, last 10 minutes'), tableHead(['Agent', 'Model', 'Events/min', 'Tool calls', 'Tool time', 'Tokens', 'Last record']), local.agentBody]),
    h('table', { class: 'ttable ttable--models' }, [h('caption', { class: 'vh' }, 'Traffic per model, last 10 minutes'), tableHead(['Model', 'Agents', 'Events/min', 'Tool calls', 'Tokens']), local.modelBody]),
    local.trafficNote,
  ]);
  local.els.traffic = section;
  return section;
}

/** @param {any} local @param {any} traffic @param {number} now */
function patchTraffic(local, traffic, now) {
  if (!traffic) return;
  const rows = agentRows(traffic, local.layout.byKey);
  const maxRate = maxOf(rows, 'eventsPerMin');
  const byKey = new Map(rows.map((/** @type {any} */ row) => [row.agentKey, row]));
  reconcile(local.agentBody, rows.map((/** @type {any} */ row) => row.agentKey), local.agentRows, (key) => createAgentRow(local, key), (el, key) => patchAgentRow(el, byKey.get(key), maxRate, now));
  const models = modelRows(traffic);
  const maxModel = maxOf(models, 'eventsPerMin');
  const byModel = new Map(models.map((/** @type {any} */ row) => [row.model, row]));
  reconcile(local.modelBody, models.map((/** @type {any} */ row) => row.model), local.modelRows, (key) => createModelRow(key), (el, key) => patchModelRow(el, byModel.get(key), maxModel));
  setText(local.trafficNote, traffic.notChecked > 0 ? `${plural(traffic.notChecked, 'agent')} not checked for traffic this tick (the bound is 32 per project).` : '');
}

/** The agent chip of "Working together": the design-system chip, pressed for the selected agent. @param {any} local @param {string} key @param {string} group */
function agentChip(local, key, group) {
  const node = local.layout.byKey.get(key);
  const pressed = local.params.agent === key;
  return h('button', { type: 'button', class: 'chip achip', 'aria-pressed': pressed ? 'true' : 'false', dataset: { focusKey: `chip:${group}:${key}` }, on: { click: () => selectAgent(local, key) } }, [
    pressed ? icon('check', 12) : null,
    node ? nodeTitle(node) : 'an agent',
    node && node.harness ? h('span', { class: 'mono achip__harness' }, node.harness) : null,
  ]);
}

/** @param {any} local */
function togetherSection(local) {
  local.togetherBody = h('div', { class: 'together__body' });
  local.togetherSig = null;
  local.togetherEl = h('section', { class: 'together', 'aria-labelledby': 'together-title' }, [
    h('h2', { id: 'together-title' }, 'Working together'),
    h('p', { class: 'together__sub' }, 'Agents that share a task, overlapping files, or a model, in the last 10 min.'),
    local.togetherBody,
  ]);
  return local.togetherEl;
}

/** @param {any} local @param {any} traffic */
function patchTogether(local, traffic) {
  const groups = pairGroups(traffic ?? { pairs: [] }, local.layout.byKey);
  const sig = JSON.stringify([groups, local.params.agent, [...local.layout.byKey].map(([key, node]) => [key, node.label, node.kind, node.harness])]);
  if (local.togetherSig === sig) return;
  local.togetherSig = sig;
  keepFocus(local.togetherBody, () => {
    if (groups.empty) {
      mount(local.togetherBody, h('p', { class: 'together__empty' }, 'No two agents share a task, files or a model in the last 10 min.'));
      return;
    }
    mount(local.togetherBody, [
      groups.sameTask.length ? h('div', { class: 'together__group' }, [h('h3', {}, 'Same task'), h('ul', {}, groups.sameTask.map((/** @type {any} */ entry) => h('li', { class: 'together__row' }, [h('span', { class: 'mono together__id' }, entry.task), ...entry.agents.map((/** @type {string} */ key) => agentChip(local, key, `task-${entry.task}`))])))]) : null,
      groups.overlap.length ? h('div', { class: 'together__group' }, [h('h3', {}, 'Overlapping files'), h('ul', {}, groups.overlap.map((/** @type {any} */ entry) => h('li', { class: 'together__row' }, [
        h('span', { class: 'badge', dataset: { state: 'awaiting' } }, [icon('awaiting', 12), 'Overlap']),
        entry.tasks.length === 2 ? h('span', { class: 'together__text' }, `${entry.tasks[0]} and ${entry.tasks[1]} declare the same files`) : null,
        agentChip(local, entry.a, `overlap-${entry.a}-${entry.b}`), agentChip(local, entry.b, `overlap-${entry.a}-${entry.b}`),
      ])))]) : null,
      groups.sameModel.length ? h('div', { class: 'together__group' }, [h('h3', {}, 'Same model'), h('ul', {}, groups.sameModel.map((/** @type {any} */ entry) => h('li', { class: 'together__row' }, [h('span', { class: 'mono together__id' }, entry.model), ...entry.agents.map((/** @type {string} */ key) => agentChip(local, key, `model-${entry.model}`))])))]) : null,
    ]);
  });
}

// ---- the project body ----------------------------------------------------------------------------------------------

/** The panel's hooks into the tree and the route. @param {any} local */
function panelHooks(local) {
  return {
    nodeOf: (/** @type {string} */ key) => local.layout.byKey.get(key) ?? null,
    select: (/** @type {string} */ key) => selectAgent(local, key),
    back: () => { globalThis.location.hash = `#/fleet/${local.params.project}`; },
    close: () => { globalThis.location.hash = `#/fleet/${local.params.project}`; },
  };
}

/** @param {any} data @param {any} params @param {any} local */
function renderProject(data, params, local) {
  local.params = params;
  local.expanded = new Map();
  local.nodes = new Map();
  local.nodeSig = new Map();
  local.liveness = new Map();
  local.layout = layoutTree({ nodes: [], edges: [] });
  local.trafficBy = new Map();
  local.partners = new Map();
  local.firstPaint = true;
  local.seenOverlaps = null;
  local.els = { transport: transportLine() };
  local.treeEl = h('ul', { class: 'ftree', role: 'tree', 'aria-label': 'Agents' });
  local.treeEl.addEventListener('keydown', (/** @type {any} */ event) => onTreeKey(local, event));
  local.treeEl.addEventListener('focusin', (/** @type {any} */ event) => {
    const li = event.target && typeof event.target.closest === 'function' ? event.target.closest('.fnode') : null;
    if (li && li.dataset.key && local.tabKey !== li.dataset.key) {
      local.tabKey = li.dataset.key;
      for (const [other, el] of local.nodes) el.setAttribute('tabindex', other === local.tabKey ? '0' : '-1');
    }
  });
  local.treeNote = h('p', { class: 'view-note fleet-tree__note' });
  local.treeEmpty = h('p', { class: 'fleet-tree__empty' });
  local.panel = createPanel(panelHooks(local));
  local.panelHost = local.panel.el;
  local.scrim = h('div', { class: 'fleet-scrim', 'aria-hidden': 'true', on: { click: () => globalThis.location && (globalThis.location.hash = `#/fleet/${params.project}`) } });
  local.treeSection = h('section', { class: 'fleet-tree', 'aria-labelledby': 'fleet-tree-title' }, [h('h2', { class: 'vh', id: 'fleet-tree-title' }, 'Agents'), local.treeEmpty, local.treeEl, local.treeNote]);
  local.grid = h('div', { class: 'fleet-grid' }, [local.treeSection, local.panelHost, trafficSection(local), togetherSection(local)]);
  local.root = h('div', { class: 'fleet fleet--project', dataset: { selected: params.agent ? 'true' : 'false' } }, [local.els.transport, local.grid, local.scrim]);
  local.panelHost.addEventListener('keydown', (/** @type {any} */ event) => onPanelKey(local, event));
  refreshTransport(local);
  updateProject(local, data, params);
  local.firstPaint = false;
  return local.root;
}

/** The missing-project state replaces the body (7b.6). @param {any} local */
function renderMissing(local) {
  return h('section', { class: 'state-panel', dataset: { kind: 'project-not-found' } }, [
    h('div', { class: 'state-panel__head' }, [icon('failed', 20), h('h2', { class: 'state-panel__title' }, 'This project is not in the Fleet list any more.')]),
    h('div', { class: 'state-panel__actions' }, h('a', { class: 'btn btn--secondary', href: '#/fleet' }, 'Back to Fleet')),
  ]);
}

/** Escape closes the sheet (or moves the focus back to the selected node at 1280 and up). @param {any} local @param {any} event */
function onPanelKey(local, event) {
  if (event.key === 'Tab' && local.sheetOpen && local.panelHost) {
    const stops = Array.from(local.panelHost.querySelectorAll('button, [tabindex="0"]')).filter((/** @type {any} */ el) => el.getAttribute('hidden') === null);
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  if (event.key !== 'Escape' || !local.params.agent) return;
  const node = local.nodes.get(local.params.agent);
  if (isSheet()) {
    event.preventDefault();
    globalThis.location.hash = `#/fleet/${local.params.project}`;
    if (node) node.focus({ preventScroll: true });
  } else if (!isNarrow()) {
    event.preventDefault();
    if (node) node.focus({ preventScroll: true });
  }
}

/** @param {string} query */
function media(query) {
  try {
    return Boolean(globalThis.matchMedia && globalThis.matchMedia(query).matches);
  } catch {
    return false;
  }
}
const isSheet = () => media('(min-width: 768px) and (max-width: 1279px)');
const isNarrow = () => media('(max-width: 767px)');

/** @param {any} local @param {any} params @param {any} data */
function setSelection(local, params, data) {
  local.params = params;
  local.root.dataset.selected = params.agent ? 'true' : 'false';
  const key = params.agent;
  const node = key ? local.layout.byKey.get(key) ?? null : null;
  if (node === null && key) {
    local.panel.setAgent(null);
    local.panel.setMissing('agent-not-in-project');
  } else local.panel.setAgent(node);
  const open = Boolean(key) && isSheet();
  local.sheetOpen = open;
  const behind = [local.treeSection, local.els.traffic];
  for (const el of behind) {
    if (!el) continue;
    if (open) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }
  const crumb = document.querySelector('.fleet-crumb');
  const agentCrumb = document.querySelector('.fleet-crumb__agent');
  if (crumb) /** @type {any} */ (crumb).dataset.agent = key && node ? 'true' : 'false';
  if (agentCrumb) setText(agentCrumb, node ? nodeTitle(node) : '');
  for (const [other, el] of local.nodes) el.setAttribute('aria-selected', other === key ? 'true' : 'false');
}

/** @param {any} local @param {any} data @param {any} params */
function updateProject(local, data, params) {
  const now = Date.now();
  local.params = params;
  const project = projectOf(data, params);
  if (!project) {
    if (!local.missing) {
      local.missing = true;
      mount(local.root, renderMissing(local));
    }
    return;
  }
  if (local.missing) {
    // The project is listed again: the body comes back.
    local.missing = false;
    mount(local.root, [local.els.transport, local.grid, local.scrim]);
  }
  const h1 = document.querySelector('.fleet-title__label');
  const crumb = document.querySelector('.fleet-crumb__label');
  setText(h1, project.label);
  setText(crumb, project.label);
  const tag = document.querySelector('.fleet-title__tag');
  if (tag) {
    if (project.current && tag.children.length === 0) mount(tag, h('span', { class: 'tag tag--accent' }, 'this project'));
    else if (!project.current && tag.children.length > 0) mount(tag, []);
  }

  const tree = treeOf(project.tree);
  const traffic = treeOf(project.traffic);
  const layout = layoutTree(tree ?? { nodes: [], edges: [] });
  const before = local.layout;
  local.layout = layout;
  local.trafficBy = new Map((traffic && Array.isArray(traffic.agents) ? traffic.agents : []).map((/** @type {any} */ agent) => [agent.agentKey, agent]));
  local.partners = partnersOf(traffic, params.agent ?? null);
  local.tickAt = now;

  // Announcements: at most one per tick, combined (7b.10).
  const said = [];
  const selected = params.agent ? layout.byKey.get(params.agent) : null;
  const was = params.agent ? before.byKey.get(params.agent) : null;
  if (selected && was && livenessToken(selected) !== livenessToken(was)) {
    if (selected.ended) said.push(`${nodeTitle(selected)} ended, ${selected.ended.result ?? 'no result'}.`);
    else if (selected.liveness === 'process-gone') said.push(`${nodeTitle(selected)}: process gone.`);
  }
  if (was && !selected && tree) said.push(`${nodeTitle(was)} is no longer in this project’s records.`);
  const overlaps = overlapIds(traffic);
  if (local.seenOverlaps !== null && traffic) {
    for (const pair of (Array.isArray(traffic.pairs) ? traffic.pairs : [])) {
      const id = overlapIds({ pairs: [pair] })[0];
      if (pair.basis === 'overlap' && !local.seenOverlaps.has(id) && Array.isArray(pair.tasks) && pair.tasks.length === 2) said.push(`New overlap: ${pair.tasks[0]} and ${pair.tasks[1]} declare the same files.`);
    }
  }
  if (traffic) local.seenOverlaps = new Set(overlaps);
  if (said.length === 1) announce(said[0]);
  else if (said.length > 1) announce(`${said.length} changes in the fleet. ${said[0]}`);

  // The tree.
  if (project.tree && !project.tree.ok) {
    mount(local.treeEmpty, [icon('failed', 16), ' ', errorSentence(project.tree.code)]);
    local.treeEmpty.removeAttribute('hidden');
  } else if (layout.items.length === 0) {
    mount(local.treeEmpty, 'DoFlow has no session or agent record in this project yet. A record appears once hooks are installed in a coding tool, or a DoFlow verb such as orchestrate or task-attempt runs here.');
    local.treeEmpty.removeAttribute('hidden');
  } else local.treeEmpty.setAttribute('hidden', '');
  patchTree(local);
  const notChecked = tree && tree.limits ? tree.limits.notChecked : 0;
  setText(local.treeNote, notChecked > 0 ? `${notChecked} agents not checked this tick (bound 256 nodes, 16 process checks, 64 sessions).` : '');
  patchTraffic(local, traffic, now);
  const section = local.els.traffic;
  if (project.traffic && !project.traffic.ok) setText(local.trafficNote, errorSentence(project.traffic.code));
  if (layout.items.length === 0 || !traffic) section.setAttribute('hidden', '');
  else section.removeAttribute('hidden');
  if (layout.items.length === 0) local.togetherEl.setAttribute('hidden', '');
  else local.togetherEl.removeAttribute('hidden');
  patchTogether(local, traffic);

  // The selection and the panel's header.
  const state = selected ? 'ok' : params.agent && tree ? 'gone' : 'none';
  const selKey = `${params.agent ?? ''}|${state}`;
  if (local.selKey !== selKey) {
    local.selKey = selKey;
    local.nodeSig2 = selected ? JSON.stringify(selected) : null;
    setSelection(local, params, data);
  } else if (selected) {
    const sig = JSON.stringify(selected);
    if (local.nodeSig2 !== sig) {
      local.nodeSig2 = sig;
      local.panel.state.node = selected;
      local.panel.refresh();
    }
  }
  refreshTransport(local, now);
}

/**
 * The shell moved between two Fleet routes of the same project (the selected agent changed): the stream is retargeted and
 * the panel starts over; the tree is not rebuilt, so the focus stays where it was. @param {any} local @param {any} params @param {any} data
 */
function rerouteProject(local, params, data) {
  local.params = params;
  local.selKey = null;
  local.stream.retarget(params.agent ?? null, params.project);
  // The rows show the selection and the partner tags; the panel starts over for the new agent.
  local.togetherSig = null;
  updateProject(local, data, params);
  if (params.agent && local.sheetOpen) local.panel.focusTitle();
}

// ---- skeletons ---------------------------------------------------------------------------------------------------------

const skeletonFleetList = () => h('div', { class: 'skeleton skeleton--fleet' }, [skel('skel--prow'), skel('skel--prow'), skel('skel--prow'), skel('skel--prow')]);
const skeletonFleetProject = () => h('div', { class: 'skeleton skeleton--fleetp' }, [skel('skel--ftree'), skel('skel--fpanel'), skel('skel--ftraffic')]);

export {
  connectFleet, tickFleet, teardownFleet, renderFleetList, updateFleetList, listMeta, listEmpty, buildProjectHead, renderProject, updateProject, rerouteProject,
  projectMeta, projectTitle, skeletonFleetList, skeletonFleetProject, projectOf, transportOf,
};

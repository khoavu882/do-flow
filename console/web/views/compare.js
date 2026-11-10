// Compare view (feature 152, IC-009; FR-003, FR-004, FR-005).
// Side-by-side workflow comparison: run headers, aligned stages diffs, worker telemetry and token cost.
// Text nodes and DOM creation via `h()` only; zero unsafe HTML injection (web safety).

import { h, icon, mount } from '../dom.js';
import { reltime } from '../states.js';
import { alignRuns, formatDuration, formatDurationDelta, formatTokens } from '../derive/compare.js';

/**
 * Skeleton placeholder while sessions-history loads.
 */
function skeletonCompare() {
  return h('div', { class: 'compare-view compare-view--skeleton', 'aria-busy': 'true' }, [
    h('div', { class: 'compare-header skel-block' }),
    h('div', { class: 'compare-table skel-block' }),
  ]);
}

/**
 * Dynamic view title.
 * @param {any} params
 */
function compareTitle(params) {
  if (params && params.slugA && params.slugB) {
    return `Compare · ${params.slugA} vs ${params.slugB}`;
  }
  return 'Compare';
}

/**
 * Reroute callback.
 * @param {any} local
 */
function rerouteCompare(local) {
  if (local && typeof local.render === 'function') {
    local.render();
  }
}

/**
 * Render delta pill.
 * @param {number | null | undefined} deltaMs
 */
function deltaPill(deltaMs) {
  if (deltaMs === null || deltaMs === undefined || Number.isNaN(deltaMs)) {
    return h('span', { class: 'pill pill--neutral' }, '—');
  }
  const text = formatDurationDelta(deltaMs);
  const cls = deltaMs > 0 ? 'pill pill--warning' : (deltaMs < 0 ? 'pill pill--success' : 'pill pill--neutral');
  return h('span', { class: cls }, text);
}

/**
 * Main view renderer for #/compare and #/compare/:slugA/:taskIdA/:slugB/:taskIdB
 * @param {any} local
 */
function renderCompare(local) {
  const root = h('div', { class: 'compare-view' });
  const data = local.data;
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const params = local.route?.params || {};

  const slugA = params.slugA;
  const taskIdA = params.taskIdA;
  const slugB = params.slugB;
  const taskIdB = params.taskIdB;

  // Mode 1: Selector mode (when runs are not fully specified)
  if (!slugA || !taskIdA || !slugB || !taskIdB) {
    if (sessions.length === 0) {
      mount(root, [
        h('header', { class: 'compare-header' }, [
          h('h1', { class: 'view-title' }, 'Session Compare'),
          h('p', { class: 'view-head__meta' }, 'Select two completed workflow sessions to compare side by side.'),
        ]),
        h('div', { class: 'empty' }, [
          icon('empty-rail', 64),
          h('h2', { class: 'empty__title' }, 'No completed sessions available'),
          h('p', { class: 'empty__sentence' }, 'Completed workflow runs will appear here for comparison once finished.'),
        ]),
      ]);
      return root;
    }

    let selectAVal = sessions[0]?.slug ? `${sessions[0].slug}/${sessions[0].taskId}` : '';
    let selectBVal = sessions[1]?.slug ? `${sessions[1].slug}/${sessions[1].taskId}` : selectAVal;

    const optA = sessions.map((/** @type {any} */ s) => h('option', { value: `${s.slug}/${s.taskId}` }, `${s.workflowName || s.taskClass}: ${s.slug} (${formatDuration(s.durationMs)})`));
    const optB = sessions.map((/** @type {any} */ s) => h('option', { value: `${s.slug}/${s.taskId}` }, `${s.workflowName || s.taskClass}: ${s.slug} (${formatDuration(s.durationMs)})`));

    const selectA = h('select', {
      class: 'compare-select',
      on: {
        change: (/** @type {any} */ e) => { selectAVal = e.target.value; },
      },
    }, optA);

    const selectB = h('select', {
      class: 'compare-select',
      on: {
        change: (/** @type {any} */ e) => { selectBVal = e.target.value; },
      },
    }, optB);

    if (sessions.length > 1) {
      selectB.selectedIndex = 1;
    }

    const compareBtn = h('button', {
      class: 'button button--primary',
      on: {
        click: () => {
          const [sA, tA] = selectAVal.split('/');
          const [sB, tB] = selectBVal.split('/');
          if (sA && tA && sB && tB) {
            globalThis.location.hash = `#/compare/${sA}/${tA}/${sB}/${tB}`;
          }
        },
      },
    }, 'Compare Runs');

    mount(root, [
      h('header', { class: 'compare-header' }, [
        h('h1', { class: 'view-title' }, 'Session Compare'),
        h('p', { class: 'view-head__meta' }, 'Select two completed workflow sessions to compare side by side.'),
      ]),
      h('div', { class: 'compare-picker card' }, [
        h('div', { class: 'compare-picker__row' }, [
          h('label', { class: 'compare-picker__label' }, ['Baseline (Run A):', selectA]),
          h('label', { class: 'compare-picker__label' }, ['Comparison (Run B):', selectB]),
        ]),
        h('div', { class: 'compare-picker__actions' }, [compareBtn]),
      ]),
    ]);
    return root;
  }

  // Mode 2: Direct comparison view
  const runA = sessions.find((/** @type {any} */ s) => s.slug === slugA && s.taskId === taskIdA);
  const runB = sessions.find((/** @type {any} */ s) => s.slug === slugB && s.taskId === taskIdB);

  if (!runA || !runB) {
    const missing = [];
    if (!runA) missing.push(`Run A (${slugA})`);
    if (!runB) missing.push(`Run B (${slugB})`);
    mount(root, [
      h('header', { class: 'compare-header' }, [
        h('h1', { class: 'view-title' }, 'Session Compare'),
      ]),
      h('div', { class: 'empty' }, [
        icon('unknown', 48),
        h('h2', { class: 'empty__title' }, 'Selected run not found'),
        h('p', { class: 'empty__sentence' }, `${missing.join(' and ')} could not be found in sessions history. The session may have expired past the 30-day retention window or not finished yet.`),
        h('button', {
          class: 'button',
          on: { click: () => { globalThis.location.hash = '#/compare'; } },
        }, 'Return to Compare Picker'),
      ]),
    ]);
    return root;
  }

  const comparison = alignRuns(runA, runB);

  // Top header with side-by-side run cards and delta highlights
  const cardRun = (/** @type {string} */ title, /** @type {any} */ run, /** @type {any} */ header) => h('div', { class: 'compare-card' }, [
    h('div', { class: 'compare-card__header' }, [
      h('span', { class: 'compare-card__tag' }, title),
      h('span', { class: 'compare-card__badge', dataset: { state: header.state } }, header.state),
    ]),
    h('h3', { class: 'compare-card__title' }, header.slug),
    h('p', { class: 'compare-card__sub' }, `${header.workflowName} · Task: ${header.taskId}`),
    h('dl', { class: 'compare-card__facts' }, [
      h('dt', {}, 'Duration:'),
      h('dd', { class: 'mono' }, formatDuration(header.durationMs)),
      h('dt', {}, 'Harness:'),
      h('dd', {}, header.harness || 'default'),
      h('dt', {}, 'Started:'),
      h('dd', {}, header.startedAt ? reltime(header.startedAt, Date.now()) : '—'),
    ]),
  ]);

  const summaryPills = h('div', { class: 'compare-summary' }, [
    h('div', { class: 'compare-summary__item' }, [
      h('span', { class: 'compare-summary__label' }, 'Duration Delta'),
      deltaPill(comparison.summary.durationDeltaMs),
    ]),
    h('div', { class: 'compare-summary__item' }, [
      h('span', { class: 'compare-summary__label' }, 'Worker Attempts'),
      h('span', { class: 'mono' }, `${comparison.workersA.attempts} → ${comparison.workersB.attempts} (${comparison.summary.attemptDelta >= 0 ? `+${comparison.summary.attemptDelta}` : comparison.summary.attemptDelta})`),
    ]),
    h('div', { class: 'compare-summary__item' }, [
      h('span', { class: 'compare-summary__label' }, 'Retries'),
      h('span', { class: 'mono' }, `${comparison.workersA.retries} → ${comparison.workersB.retries} (${comparison.summary.retryDelta >= 0 ? `+${comparison.summary.retryDelta}` : comparison.summary.retryDelta})`),
    ]),
    h('div', { class: 'compare-summary__item' }, [
      h('span', { class: 'compare-summary__label' }, 'Quota Stops'),
      h('span', { class: 'mono' }, `${comparison.workersA.quotaStops} → ${comparison.workersB.quotaStops}`),
    ]),
  ]);

  // Stage diff table
  const stageRows = comparison.stages.map((st) => {
    const durA = formatDuration(st.durationMsA);
    const durB = formatDuration(st.durationMsB);
    const pill = deltaPill(st.durationDeltaMs);

    return h('tr', { class: 'compare-stage-row' }, [
      h('td', { class: 'compare-stage-cell' }, [
        h('strong', {}, st.name),
        st.skill ? h('span', { class: 'compare-stage__skill' }, ` (${st.skill})`) : null,
      ]),
      h('td', { class: 'compare-stage-col' }, [
        h('span', { class: 'mono' }, durA),
        st.statusA !== 'not-in-run'
          ? h('span', { class: 'stage-tag', dataset: { status: st.statusA } }, st.statusA)
          : h('span', { class: 'stage-tag stage-tag--missing' }, 'not in run'),
      ]),
      h('td', { class: 'compare-stage-col' }, [
        h('span', { class: 'mono' }, durB),
        st.statusB !== 'not-in-run'
          ? h('span', { class: 'stage-tag', dataset: { status: st.statusB } }, st.statusB)
          : h('span', { class: 'stage-tag stage-tag--missing' }, 'not in run'),
      ]),
      h('td', { class: 'compare-stage-delta' }, [pill]),
    ]);
  });

  const stageTable = h('table', { class: 'mtable compare-table', tabindex: '0' }, [
    h('caption', {}, 'Stage Alignment and Duration Deltas'),
    h('thead', {}, [
      h('tr', {}, [
        h('th', { scope: 'col' }, 'Stage'),
        h('th', { scope: 'col' }, `Run A (${comparison.runA.slug})`),
        h('th', { scope: 'col' }, `Run B (${comparison.runB.slug})`),
        h('th', { scope: 'col' }, 'Delta'),
      ]),
    ]),
    h('tbody', {}, stageRows),
  ]);

  // Cost and Token Breakdown
  const costSection = h('section', { class: 'compare-cost card', 'aria-labelledby': 'compare-cost-title' }, [
    h('h2', { id: 'compare-cost-title', class: 'card__title' }, 'Cost and Token Telemetry'),
    h('dl', { class: 'compare-cost__grid' }, [
      h('dt', {}, 'Telemetry status:'),
      h('dd', {}, `Run A: ${comparison.cost.telemetryA} · Run B: ${comparison.cost.telemetryB}`),
      h('dt', {}, 'Models used:'),
      h('dd', {}, `Run A: ${comparison.cost.modelsA.join(', ') || 'none'} · Run B: ${comparison.cost.modelsB.join(', ') || 'none'}`),
      h('dt', {}, 'Input tokens:'),
      h('dd', { class: 'mono' }, `${formatTokens(comparison.cost.tokensA.input)} vs ${formatTokens(comparison.cost.tokensB.input)}`),
      h('dt', {}, 'Output tokens:'),
      h('dd', { class: 'mono' }, `${formatTokens(comparison.cost.tokensA.output)} vs ${formatTokens(comparison.cost.tokensB.output)}`),
      h('dt', {}, 'Total tokens:'),
      h('dd', { class: 'mono' }, `${formatTokens(comparison.cost.tokensA.total)} vs ${formatTokens(comparison.cost.tokensB.total)}`),
    ]),
  ]);

  const navBack = h('div', { class: 'compare-nav' }, [
    h('a', { class: 'link', href: '#/compare' }, '← Back to selector'),
    h('span', { class: 'sep' }, ' · '),
    h('a', { class: 'link', href: '#/sessions/history' }, 'Sessions history list'),
  ]);

  mount(root, [
    h('header', { class: 'compare-header' }, [
      navBack,
      h('h1', { class: 'view-title' }, 'Run Comparison'),
      h('p', { class: 'view-head__meta' }, `${comparison.runA.slug} vs ${comparison.runB.slug}`),
    ]),
    h('div', { class: 'compare-cards-layout' }, [
      cardRun('Run A (Baseline)', runA, comparison.runA),
      cardRun('Run B (Comparison)', runB, comparison.runB),
    ]),
    summaryPills,
    h('section', { class: 'compare-stages-section' }, [stageTable]),
    costSection,
  ]);

  return root;
}

export { renderCompare, skeletonCompare, compareTitle, rerouteCompare };

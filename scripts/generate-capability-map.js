'use strict';

// Stage 4 of docs/refactor-plan.md: generate the registry-derived regions of
// docs/capability-map.md instead of hand-maintaining them and guarding the drift (G8 used to
// detect it; running this script removes it). The sole input is the loaded registry — no
// capability fact is decided here. Prose outside the managed markers is never touched, the same
// marker discipline the installer applies to user files.
//
// Rendering rules are presentation-only and applied uniformly:
//   - statuses render as their title-cased registry value;
//   - a capability with a declared native target shows it inline;
//   - an undeclared event renders as an em dash;
//   - table cells escape pipes so registry note text cannot break the table;
//   - ordering is registry order for harnesses/capabilities and plain codepoint sort for events
//     (never localeCompare — output must be byte-identical on every machine).

const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('../src/registry');

const DOC_PATH = path.join(__dirname, '..', 'docs', 'capability-map.md');

const REGIONS = Object.freeze(['capability-matrix', 'hook-event-matrix']);
const STATUS_LABELS = Object.freeze({
  supported: 'Supported',
  different: 'Different',
  unavailable: 'Unavailable',
});
// Display labels for capability keys; values stay facts of the registry.
const CAPABILITY_LABELS = Object.freeze({
  mcp: 'MCP',
  plugin: 'Plugin / extension',
});
const DASH = '\u2014';

function beginMarker(region) { return `<!-- BEGIN GENERATED:${region} -->`; }
function endMarker(region) { return `<!-- END GENERATED:${region} -->`; }

function capabilityLabel(name) {
  return Object.hasOwn(CAPABILITY_LABELS, name) ? CAPABILITY_LABELS[name] : name.charAt(0).toUpperCase() + name.slice(1);
}

/** Pipes inside a cell would split the markdown column; escape them wherever cell text is placed. */
function cell(text) { return text.replace(/\|/g, '\\|'); }

function statusText(declaration) { return STATUS_LABELS[declaration.status]; }

function nativeTargetSuffix(harness, capability) {
  const target = harness.nativeTargets[capability];
  return target ? ` \u2014 \`${target}\`` : '';
}

function harnessColumns(registry) { return registry.harnesses.map((harness) => harness.displayName); }

function divider(columnCount) { return `|${Array.from({ length: columnCount }, () => '---').join('|')}|`; }

function renderCapabilityMatrix(registry) {
  const harnesses = registry.harnesses;
  // Capability row order: first appearance across harnesses in registry order.
  const capabilities = [];
  for (const harness of harnesses) {
    for (const name of Object.keys(harness.capabilities)) {
      if (!capabilities.includes(name)) capabilities.push(name);
    }
  }
  const columns = harnessColumns(registry);
  const lines = [
    `| Capability | ${columns.join(' | ')} |`,
    divider(columns.length + 1),
  ];
  for (const name of capabilities) {
    const cells = harnesses.map((harness) => {
      const declaration = harness.capabilities[name];
      if (!declaration) return DASH;
      return cell(statusText(declaration) + nativeTargetSuffix(harness, name));
    });
    lines.push(`| ${capabilityLabel(name)} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function hookEventsOf(harness) {
  return harness.capabilities && harness.capabilities.hooks ? harness.capabilities.hooks.events : undefined;
}

function renderHookEventMatrix(registry) {
  const harnesses = registry.harnesses;
  const names = new Set();
  for (const harness of harnesses) {
    const events = hookEventsOf(harness);
    if (events) for (const event of Object.keys(events)) names.add(event);
  }
  const columns = harnessColumns(registry);
  const lines = [
    `| Event | ${columns.join(' | ')} | Notes |`,
    divider(columns.length + 2),
  ];
  for (const event of [...names].sort()) {
    const cells = [];
    const notes = [];
    for (const harness of harnesses) {
      const events = hookEventsOf(harness);
      const declaration = events ? events[event] : undefined;
      if (!declaration) { cells.push(DASH); continue; }
      cells.push(cell(statusText(declaration)));
      if (typeof declaration.note === 'string' && declaration.note) {
        notes.push(`**${harness.displayName}:** ${cell(declaration.note)}`);
      }
    }
    lines.push(`| \`${event}\` | ${cells.join(' | ')} | ${notes.join(' ')} |`);
  }
  return lines.join('\n');
}

function regionText(region, registry) {
  if (region === 'capability-matrix') return renderCapabilityMatrix(registry);
  if (region === 'hook-event-matrix') return renderHookEventMatrix(registry);
  throw new Error(`generate-capability-map: unknown region '${region}'`);
}

/** Returns the document with every managed region replaced by its generated rendering.
 * Throws when a marker pair is missing, duplicated, or inverted so callers fail loudly instead
 * of silently regenerating nothing. */
function renderDocumentText(doc, registry) {
  let out = doc;
  for (const region of REGIONS) {
    const begin = beginMarker(region);
    const end = endMarker(region);
    const start = out.indexOf(begin);
    const stop = out.indexOf(end);
    if (start === -1 || stop === -1) {
      throw new Error(`generate-capability-map: managed markers for '${region}' not found in docs/capability-map.md`);
    }
    if (out.indexOf(begin, start + 1) !== -1 || stop < start) {
      throw new Error(`generate-capability-map: markers for '${region}' are duplicated or inverted`);
    }
    out = `${out.slice(0, start + begin.length)}\n${regionText(region, registry)}\n${out.slice(stop)}`;
  }
  return out;
}

function main() {
  const registry = loadRegistry({ repoRoot: path.join(__dirname, '..') });
  const before = fs.readFileSync(DOC_PATH, 'utf8');
  const after = renderDocumentText(before, registry);
  fs.writeFileSync(DOC_PATH, after);
  process.stdout.write(after === before
    ? 'docs/capability-map.md: up to date\n'
    : 'docs/capability-map.md: regenerated from core/registry\n');
}

if (require.main === module) main();

module.exports = { REGIONS, renderDocumentText, renderCapabilityMatrix, renderHookEventMatrix };

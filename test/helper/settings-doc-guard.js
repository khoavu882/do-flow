'use strict';

const { REF_META } = require('../../src/runtime/settings/refs.ts');

function docsRows(text) {
  const lines = text.split('\n');
  const heading = lines.indexOf('## Settings keys');
  if (heading < 0) return { error: '## Settings keys heading is missing', rows: new Map() };
  let header = heading + 1;
  while (header < lines.length && !lines[header].startsWith('|')) header++;
  if (header === lines.length) return { error: 'settings table is missing', rows: new Map() };
  const split = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/^`(.*)`$/, '$1'));
  // docs/settings.md (087b): the generated settings-keys block adds Description after the six
  // columns this guard compares; the header must be exactly these seven.
  const wanted = ['Key', 'Type', 'Default', 'Scope', 'Env', 'Legacy file', 'Description'];
  const headings = split(lines[header]);
  if (headings.length !== wanted.length || headings.some((value, i) => value !== wanted[i])) {
    return { error: `settings table columns are [${headings.join(', ')}]`, rows: new Map() };
  }
  const rows = new Map();
  for (let i = header + 1; i < lines.length && lines[i].startsWith('|'); i++) {
    if (/^\|\s*[-:| ]+\s*\|$/.test(lines[i])) continue;
    const cells = split(lines[i]);
    if (cells.length !== wanted.length) continue;
    const [key, type, defaultValue, scope, env, legacy, description] = cells;
    if (rows.has(key)) rows.set(key, { duplicate: true, line: i + 1 });
    else rows.set(key, { type, defaultValue, scope, env, legacy, description, line: i + 1 });
  }
  return { error: null, rows };
}

function resolvedDefault(key, spec, registry, resolving = new Set()) {
  if (Object.hasOwn(spec, 'default')) return spec.default;
  if (!spec.defaultRef || resolving.has(key)) return undefined;
  const nextResolving = new Set(resolving).add(key);
  const dependencies = new Set(REF_META[spec.defaultRef]?.dependsOn || []);
  for (const requirement of Array.isArray(spec.requires) ? spec.requires : []) {
    if (typeof requirement?.key === 'string') dependencies.add(requirement.key);
  }
  const deps = {};
  for (const dependency of dependencies) {
    const dependencySpec = registry.keys.get(dependency);
    if (dependencySpec) deps[dependency] = resolvedDefault(dependency, dependencySpec, registry, nextResolving);
  }
  return registry.resolveRef(spec.defaultRef, deps);
}

function displayDefault(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function renderSettingsRow(key, spec, registry) {
  const legacy = [...new Set((spec.legacy || []).map((entry) => entry.path))].join(', ') || '—';
  return `| \`${key}\` | ${spec.type} | \`${displayDefault(resolvedDefault(key, spec, registry))}\` | ${spec.scope} | ${spec.env?.name || '—'} | \`${legacy}\` | ${String(spec.description || '—').replace(/\|/g, '\\|')} |`;
}

function renderSettingsTable(raw, registry, { omitKey = null } = {}) {
  const lines = [
    '## Settings keys', '',
    '| Key | Type | Default | Scope | Env | Legacy file | Description |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const [key, spec] of Object.entries(raw.keys)) {
    if (key === omitKey) continue;
    lines.push(renderSettingsRow(key, spec, registry));
  }
  return lines.join('\n');
}

function checkSettingsDocs(raw, text, registry) {
  const { error, rows } = docsRows(text);
  if (error) return [error];
  const errors = [];
  if (/<config home>\/doflow\//.test(text)) errors.push('config home path duplicates the doflow segment');
  for (const [key, spec] of Object.entries(raw.keys)) {
    const row = rows.get(key);
    if (!row) { errors.push(`settings table is missing ${key}`); continue; }
    if (row.duplicate) { errors.push(`settings table duplicates ${key} at line ${row.line}`); continue; }
    const expected = [
      ['type', row.type, spec.type],
      ['default', row.defaultValue, displayDefault(resolvedDefault(key, spec, registry))],
      ['scope', row.scope, spec.scope],
      ['env', row.env, spec.env?.name || '—'],
      ['legacy file', row.legacy, [...new Set((spec.legacy || []).map((entry) => entry.path))].join(', ') || '—'],
      ['description', row.description, String(spec.description || '—').replace(/\|/g, '\\|')],
    ];
    for (const [field, actual, wanted] of expected) {
      if (actual !== wanted) errors.push(`${key} ${field} is '${actual}', expected '${wanted}'`);
    }
  }
  for (const key of rows.keys()) if (!Object.hasOwn(raw.keys, key)) errors.push(`settings table has undeclared key ${key}`);
  return errors;
}

module.exports = { checkSettingsDocs, docsRows, renderSettingsRow, renderSettingsTable, resolvedDefault };

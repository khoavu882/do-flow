'use strict';

// G74 — vendor guidance size caps (row 130). Some harnesses cut always-loaded guidance silently:
// Antigravity truncates a rule file past 24,000 bytes after its includes, and Codex stops adding
// AGENTS.md files once the chain reaches project_doc_max_bytes. Nothing would report either, so this
// holds every projected always-on file, measured after includes, to the smallest per-file cap that
// applies to its harness, and each harness's combined startup load to its chain cap (the shape of
// rulesync's instruction-budget.ts). The caps live in core/registry/guidance-caps.json, one row per
// documented fact with its source page and the date it was checked; a harness with no documented
// cap has a null row, so "not checked" and "no cap" cannot be confused.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { alwaysLoadedByHarness, readRegistry, mcpIndexWorstBytes } = require('../helper/always-loaded.ts');
const { WHOLESALE_ASSETS } = require('../../src/runtime/inventory/siblings.ts');

const CAPS_FILE = path.join(REPO, 'core', 'registry', 'guidance-caps.json');
const SCOPES = new Set(['per-file-after-includes', 'combined-chain']);
const readCaps = () => JSON.parse(fs.readFileSync(CAPS_FILE, 'utf8'));

/** Schema findings for the caps table against the harness ids of harnesses.json. */
function schemaFindings(table: any, harnessIds: any) {
  const findings: any = [];
  if (table?.version !== 1 || !Array.isArray(table.caps)) return ['guidance-caps.json: version 1 with a caps array is required'];
  table.caps.forEach((row: any, i: number) => {
    const at = `caps[${i}] (${row?.harness})`;
    if (!harnessIds.includes(row?.harness)) findings.push(`${at}: harness is not in harnesses.json`);
    if (!(row.cap_bytes === null || (Number.isInteger(row.cap_bytes) && row.cap_bytes > 0))) findings.push(`${at}: cap_bytes must be a positive integer or null`);
    if (!SCOPES.has(row.scope)) findings.push(`${at}: scope must be one of ${[...SCOPES].join(', ')}`);
    if (typeof row.source_url !== 'string' || !/^https:\/\/\S+$/.test(row.source_url)) findings.push(`${at}: source_url must be an https URL`);
    if (typeof row.verified_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.verified_on)) findings.push(`${at}: verified_on must be YYYY-MM-DD`);
  });
  for (const id of harnessIds) {
    if (!table.caps.some((row: any) => row.harness === id)) findings.push(`${id}: no caps row (record cap_bytes null with the page checked)`);
  }
  return findings;
}

/** Cap violations: a file whose after-includes size exceeds the smallest per-file cap of its harness,
 * or a harness whose combined load (row total plus the largest possible MCP_INDEX.md) exceeds a chain cap. */
function capViolations(rows: any, caps: any, mcpWorst: any = mcpIndexWorstBytes()) {
  const findings: any = [];
  for (const row of rows) {
    const own = caps.filter((cap: any) => cap.harness === row.harness && cap.cap_bytes !== null);
    const perFile = own.filter((cap: any) => cap.scope === 'per-file-after-includes').map((cap: any) => cap.cap_bytes);
    if (perFile.length) {
      const limit = Math.min(...perFile);
      for (const file of row.files) {
        if (file.afterIncludes > limit) findings.push(`${row.harness}: ${file.path} is ${file.afterIncludes} B after includes, over the ${limit} B per-file cap`);
      }
    }
    const chain = row.bytes + mcpWorst;
    for (const cap of own.filter((c: any) => c.scope === 'combined-chain')) {
      if (chain > cap.cap_bytes) findings.push(`${row.harness}: combined chain is ${chain} B, over the ${cap.cap_bytes} B chain cap`);
    }
  }
  return findings;
}

test('G74: the caps table is well formed and covers every harness', () => {
  const ids = readRegistry().harnesses.map((h: any) => h.id);
  assert.deepEqual(schemaFindings(readCaps(), ids), []);
});

test('G74: every projected always-on file and every combined chain stays inside its vendor cap', (t) => {
  const rows = alwaysLoadedByHarness(readRegistry(), WHOLESALE_ASSETS);
  const caps = readCaps().caps;
  for (const row of rows) {
    const largest = Math.max(...row.files.map((file: any) => file.afterIncludes));
    t.diagnostic(`${row.harness}: ${row.files.length} files, largest ${largest} B after includes, chain ${row.bytes + mcpIndexWorstBytes()} B`);
  }
  assert.ok(rows.every((row: any) => row.files.length > 0), 'a harness measured no always-on file; the classification stopped resolving');
  assert.deepEqual(capViolations(rows, caps), [],
    'always-on guidance a harness would truncate or drop; shrink or split it, do not raise a cap without a vendor source');
});

test('G74: controls — an oversized file, an oversized chain and a bad row are each caught', () => {
  const rows = alwaysLoadedByHarness(readRegistry(), WHOLESALE_ASSETS);
  const caps = readCaps().caps;
  const plant = (harness: any, bytes: any) => rows.map((row: any) => (row.harness !== harness ? row
    : { ...row, bytes: row.bytes + bytes, files: [...row.files, { path: 'planted.md', bytes, afterIncludes: bytes }] }));
  // Antigravity's 24,000 B per-file cap binds on a planted 24,001 B rule file.
  assert.deepEqual(capViolations(plant('antigravity', 24001), caps),
    ['antigravity: planted.md is 24001 B after includes, over the 24000 B per-file cap']);
  // Codex's 32 KiB chain cap binds on a planted file that pushes the chain over it.
  const codex = rows.find((row: any) => row.harness === 'codex');
  const over = 32768 - codex.bytes - mcpIndexWorstBytes() + 1;
  assert.deepEqual(capViolations(plant('codex', over), caps), ['codex: combined chain is 32769 B, over the 32768 B chain cap']);
  // A null cap never binds, and a harness missing from the table, or a row with no source, fails the schema.
  assert.deepEqual(capViolations(plant('kiro', 10_000_000), caps), []);
  const ids = readRegistry().harnesses.map((h: any) => h.id);
  const table = readCaps();
  const findings = schemaFindings({ ...table, caps: [...table.caps.filter((row: any) => row.harness !== 'pi'), { ...table.caps[0], source_url: '' }] }, ids);
  assert.ok(findings.some((line: any) => /^pi: no caps row/.test(line)), findings.join('\n'));
  assert.ok(findings.some((line: any) => /source_url must be an https URL/.test(line)), findings.join('\n'));
});

module.exports = { capViolations, schemaFindings };

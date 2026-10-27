'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { buildOtlpRequests, ownedLists } = require('../../src/runtime/trace/otlp-map.ts');

const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/telemetry.json'), 'utf8'));

const DEFAULT_META: any = {
  version: '2.0.0-beta.6',
  lists: {
    'cli-commands': ['install', 'update', 'reconcile', 'remove', 'status', 'tools', 'list-backups', 'rollback', 'self-update'],
    'workflow-stages': ['discovery', 'design', 'planning', 'implementation', 'verification', 'review'],
    'workflow-classes': ['feature', 'bug', 'refactor', 'review', 'research', 'documentation', 'dependency-change', 'operations', 'trivial-edit'],
  },
};

test('ownedLists returns cli-commands, workflow-stages, and workflow-classes', () => {
  const lists = ownedLists();
  assert.ok(Array.isArray(lists['cli-commands']), 'cli-commands is array');
  assert.ok(lists['cli-commands'].includes('status'), 'cli-commands includes status');
  assert.ok(Array.isArray(lists['workflow-stages']), 'workflow-stages is array');
  assert.ok(lists['workflow-stages'].includes('discovery'), 'workflow-stages includes discovery');
  assert.ok(Array.isArray(lists['workflow-classes']), 'workflow-classes is array');
  assert.ok(lists['workflow-classes'].includes('feature'), 'workflow-classes includes feature');
});

test('OTLP envelope, resource, and scope match IC-007', () => {
  const view: any = {
    v: 1,
    traces: [
      {
        traceId: '0123456789abcdef0123456789abcdef',
        traceLink: null,
        runKey: 'k/r/l',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:01:00.000Z' },
        spans: [
          {
            spanId: '1234567890abcdef',
            parentSpanId: null,
            kind: 'run',
            name: 'run',
            start: '2026-10-20T10:00:00.123Z',
            end: '2026-10-20T10:01:00.123Z',
            durationMs: 60000,
            basis: 'recorded',
            locator: 'file#run',
            attrs: {},
          },
        ],
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const { requests, skipped } = buildOtlpRequests(view, registry, DEFAULT_META);
  assert.equal(skipped.ungrouped, 0);
  assert.equal(skipped.noStart, 0);
  assert.equal(requests.length, 1);

  const req = requests[0];
  assert.ok(req.resourceSpans, 'has resourceSpans');
  assert.equal(req.resourceSpans.length, 1);

  const rs = req.resourceSpans[0];
  assert.equal(rs.schemaUrl, registry.export.semconv.schemaUrl);
  assert.deepEqual(rs.resource, {
    attributes: [
      { key: 'service.name', value: { stringValue: 'doflow' } },
      { key: 'service.version', value: { stringValue: '2.0.0-beta.6' } },
    ],
  });

  assert.equal(rs.scopeSpans.length, 1);
  const ss = rs.scopeSpans[0];
  assert.equal(ss.schemaUrl, registry.export.semconv.schemaUrl);
  assert.deepEqual(ss.scope, {
    name: 'doflow',
    version: '2.0.0-beta.6',
  });

  assert.equal(ss.spans.length, 1);
  const span = ss.spans[0];
  assert.equal(span.traceId, '0123456789abcdef0123456789abcdef');
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(span.spanId, '1234567890abcdef', 'the local view id is not exported (C-4)');
  assert.equal(span.parentSpanId, undefined);
  assert.equal(span.kind, 1);
  assert.equal(span.name, 'invoke_workflow');
  assert.equal(span.startTimeUnixNano, (BigInt(Date.parse('2026-10-20T10:00:00.123Z')) * 1000000n).toString());
  assert.equal(span.endTimeUnixNano, (BigInt(Date.parse('2026-10-20T10:01:00.123Z')) * 1000000n).toString());
});

test('trace ids pass through as 32 lowercase hex; span ids are remapped 16 hex; parentSpanId omitted on roots and names the remapped parent', () => {
  const view: any = {
    v: 1,
    traces: [
      {
        traceId: 'ABCDEF0123456789ABCDEF0123456789',
        traceLink: null,
        runKey: 'k/r/l',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:01:00.000Z' },
        spans: [
          {
            spanId: 'ABCDEF0123456789',
            parentSpanId: null,
            kind: 'run',
            name: 'run',
            start: '2026-10-20T10:00:00.000Z',
            end: '2026-10-20T10:01:00.000Z',
            durationMs: 60000,
            basis: 'recorded',
            locator: 'loc1',
            attrs: {},
          },
          {
            spanId: '1234567890ABCDEF',
            parentSpanId: 'ABCDEF0123456789',
            kind: 'ledger',
            name: 'status',
            start: '2026-10-20T10:00:01.000Z',
            end: '2026-10-20T10:00:02.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc2',
            attrs: { verb: 'status' },
          },
        ],
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const { requests } = buildOtlpRequests(view, registry, DEFAULT_META);
  const spans = requests[0].resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans[0].traceId, 'abcdef0123456789abcdef0123456789');
  assert.match(spans[0].spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(spans[0].spanId, 'abcdef0123456789', 'the local root id is not exported (C-4)');
  assert.ok(!Object.hasOwn(spans[0], 'parentSpanId'), 'root span has no parentSpanId');

  assert.equal(spans[1].traceId, 'abcdef0123456789abcdef0123456789');
  assert.match(spans[1].spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(spans[1].spanId, '1234567890abcdef', 'the local child id is not exported (C-4)');
  assert.equal(spans[1].parentSpanId, spans[0].spanId, 'the parent is the remapped root id');
});

test('times as decimal strings equal to ISO ms x 1e6; null end uses start', () => {
  const startIso = '2026-10-20T12:34:56.789Z';
  const startMs = Date.parse(startIso);
  const expectedNano = (BigInt(startMs) * 1000000n).toString();

  const view: any = {
    v: 1,
    traces: [
      {
        traceId: '11111111111111111111111111111111',
        traceLink: null,
        runKey: 'k/r/l',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: startIso, to: startIso },
        spans: [
          {
            spanId: '2222222222222222',
            parentSpanId: null,
            kind: 'run',
            name: 'run',
            start: startIso,
            end: null,
            durationMs: null,
            basis: 'recorded',
            locator: 'loc',
            attrs: {},
          },
        ],
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const { requests } = buildOtlpRequests(view, registry, DEFAULT_META);
  const span = requests[0].resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.startTimeUnixNano, expectedNano);
  assert.equal(span.endTimeUnixNano, expectedNano);
});

test('span naming and gen_ai attributes for hook, worker, and generic spans', () => {
  const view: any = {
    v: 1,
    traces: [
      {
        traceId: '33333333333333333333333333333333',
        traceLink: null,
        runKey: 'k/r/l',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:00:10.000Z' },
        spans: [
          // 1. Hook with Bash tool
          {
            spanId: '4444444444444441',
            parentSpanId: null,
            kind: 'hook',
            name: 'pre-bash-guard',
            start: '2026-10-20T10:00:00.000Z',
            end: '2026-10-20T10:00:01.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc1',
            attrs: { tool: 'Bash', tool_call_id: 'call_123', duration_ms: 1000 },
          },
          // 2. Hook with unlisted tool
          {
            spanId: '4444444444444442',
            parentSpanId: null,
            kind: 'hook',
            name: 'other-tool',
            start: '2026-10-20T10:00:01.000Z',
            end: '2026-10-20T10:00:02.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc2',
            attrs: { tool: 'custom_tool' },
          },
          // 3. Worker with codex harness
          {
            spanId: '4444444444444443',
            parentSpanId: null,
            kind: 'worker',
            name: 'worker',
            start: '2026-10-20T10:00:02.000Z',
            end: '2026-10-20T10:00:03.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc3',
            attrs: { harness: 'codex' },
          },
          // 4. Worker with unknown harness
          {
            spanId: '4444444444444444',
            parentSpanId: null,
            kind: 'worker',
            name: 'worker',
            start: '2026-10-20T10:00:03.000Z',
            end: '2026-10-20T10:00:04.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc4',
            attrs: { harness: 'magic_ai' },
          },
          // 5. Ledger span with verb in cli-commands
          {
            spanId: '4444444444444445',
            parentSpanId: null,
            kind: 'ledger',
            name: 'status',
            start: '2026-10-20T10:00:04.000Z',
            end: '2026-10-20T10:00:05.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc5',
            attrs: { verb: 'status' },
          },
          // 6. Ledger span with unknown verb
          {
            spanId: '4444444444444446',
            parentSpanId: null,
            kind: 'ledger',
            name: 'unknown_cmd',
            start: '2026-10-20T10:00:05.000Z',
            end: '2026-10-20T10:00:06.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc6',
            attrs: { verb: 'unknown_cmd' },
          },
          // 7. Verify span with no owning list
          {
            spanId: '4444444444444447',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify.run',
            start: '2026-10-20T10:00:06.000Z',
            end: '2026-10-20T10:00:07.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc7',
            attrs: { status: 'PASS' },
          },
        ],
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const { requests } = buildOtlpRequests(view, registry, DEFAULT_META);
  const spans = requests[0].resourceSpans[0].scopeSpans[0].spans;

  // 1. Hook with Bash
  assert.equal(spans[0].name, 'execute_tool Bash');
  const attrs0 = Object.fromEntries(spans[0].attributes.map((a: any) => [a.key, a.value]));
  assert.deepEqual(attrs0['gen_ai.operation.name'], { stringValue: 'execute_tool' });
  assert.deepEqual(attrs0['gen_ai.tool.name'], { stringValue: 'Bash' });
  assert.deepEqual(attrs0['gen_ai.tool.call.id'], { stringValue: 'call_123' });
  assert.deepEqual(attrs0['doflow.hook.duration_ms'], { intValue: '1000' });

  // 2. Hook with custom_tool
  assert.equal(spans[1].name, 'execute_tool');
  const attrs1 = Object.fromEntries(spans[1].attributes.map((a: any) => [a.key, a.value]));
  assert.deepEqual(attrs1['gen_ai.operation.name'], { stringValue: 'execute_tool' });
  assert.deepEqual(attrs1['gen_ai.tool.name'], { stringValue: 'other' });

  // 3. Worker with codex
  assert.equal(spans[2].name, 'invoke_agent codex');
  const attrs2 = Object.fromEntries(spans[2].attributes.map((a: any) => [a.key, a.value]));
  assert.deepEqual(attrs2['gen_ai.operation.name'], { stringValue: 'invoke_agent' });
  assert.deepEqual(attrs2['gen_ai.agent.name'], { stringValue: 'codex' });

  // 4. Worker with magic_ai
  assert.equal(spans[3].name, 'invoke_agent');
  const attrs3 = Object.fromEntries(spans[3].attributes.map((a: any) => [a.key, a.value]));
  assert.deepEqual(attrs3['gen_ai.operation.name'], { stringValue: 'invoke_agent' });
  assert.deepEqual(attrs3['gen_ai.agent.name'], { stringValue: 'other' });

  // 5. Ledger with status
  assert.equal(spans[4].name, 'doflow.ledger status');
  const attrs4 = Object.fromEntries(spans[4].attributes.map((a: any) => [a.key, a.value]));
  assert.deepEqual(attrs4['doflow.ledger.verb'], { stringValue: 'status' });

  // 6. Ledger with unknown_cmd
  assert.equal(spans[5].name, 'doflow.ledger');
  const attrs5 = Object.fromEntries(spans[5].attributes.map((a: any) => [a.key, a.value]));
  assert.deepEqual(attrs5['doflow.ledger.verb'], { stringValue: 'other' });

  // 7. Verify with no owning list
  assert.equal(spans[6].name, 'doflow.verify.run');
  const attrs6 = Object.fromEntries(spans[6].attributes.map((a: any) => [a.key, a.value]));
  assert.deepEqual(attrs6['doflow.verify.run.status'], { stringValue: 'PASS' });
});

test('status and error.type mappings for FAIL, fail, error, and non-zero exit_code', () => {
  const view: any = {
    v: 1,
    traces: [
      {
        traceId: '55555555555555555555555555555555',
        traceLink: null,
        runKey: 'k/r/l',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:00:05.000Z' },
        spans: [
          // 1. FAIL
          {
            spanId: '6666666666666661',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify.run',
            start: '2026-10-20T10:00:00.000Z',
            end: '2026-10-20T10:00:01.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'l1',
            attrs: { status: 'FAIL', exit_code: 1 },
          },
          // 2. fail
          {
            spanId: '6666666666666662',
            parentSpanId: null,
            kind: 'test',
            name: 'test',
            start: '2026-10-20T10:00:01.000Z',
            end: '2026-10-20T10:00:02.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'l2',
            attrs: { status: 'fail' },
          },
          // 3. error
          {
            spanId: '6666666666666663',
            parentSpanId: null,
            kind: 'hook',
            name: 'hook',
            start: '2026-10-20T10:00:02.000Z',
            end: '2026-10-20T10:00:03.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'l3',
            attrs: { status: 'error' },
          },
          // 4. exit_code non-zero, status PASS
          {
            spanId: '6666666666666664',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify.run',
            start: '2026-10-20T10:00:03.000Z',
            end: '2026-10-20T10:00:04.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'l4',
            attrs: { exit_code: 42 },
          },
          // 5. PASS and exit_code 0 (no status field)
          {
            spanId: '6666666666666665',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify.run',
            start: '2026-10-20T10:00:04.000Z',
            end: '2026-10-20T10:00:05.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'l5',
            attrs: { status: 'PASS', exit_code: 0 },
          },
        ],
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const { requests } = buildOtlpRequests(view, registry, DEFAULT_META);
  const spans = requests[0].resourceSpans[0].scopeSpans[0].spans;

  assert.deepEqual(spans[0].status, { code: 2 });
  assert.ok(spans[0].attributes.some((a: any) => a.key === 'error.type' && a.value.stringValue === 'FAIL'));

  assert.deepEqual(spans[1].status, { code: 2 });
  assert.ok(spans[1].attributes.some((a: any) => a.key === 'error.type' && a.value.stringValue === 'fail'));

  assert.deepEqual(spans[2].status, { code: 2 });
  assert.ok(spans[2].attributes.some((a: any) => a.key === 'error.type' && a.value.stringValue === 'error'));

  assert.deepEqual(spans[3].status, { code: 2 });
  assert.ok(spans[3].attributes.some((a: any) => a.key === 'error.type' && a.value.stringValue === 'exit:42'));

  assert.equal(spans[4].status, undefined, 'status omitted on successful span');
  assert.ok(!spans[4].attributes.some((a: any) => a.key === 'error.type'), 'no error.type on successful span');
});

test('links: root span links to target trace root span when traceLink matches a trace in the export', () => {
  const view: any = {
    v: 1,
    traces: [
      {
        traceId: '77777777777777777777777777777771',
        traceLink: null,
        runKey: 'k/r/l1',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:00:01.000Z' },
        spans: [
          {
            spanId: '8888888888888881',
            parentSpanId: null,
            kind: 'run',
            name: 'run',
            start: '2026-10-20T10:00:00.000Z',
            end: '2026-10-20T10:00:01.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'l1',
            attrs: {},
          },
        ],
      },
      {
        traceId: '77777777777777777777777777777772',
        traceLink: '77777777777777777777777777777771',
        runKey: 'k/r/l2',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:01.000Z', to: '2026-10-20T10:00:02.000Z' },
        spans: [
          {
            spanId: '8888888888888882',
            parentSpanId: null,
            kind: 'run',
            name: 'run',
            start: '2026-10-20T10:00:01.000Z',
            end: '2026-10-20T10:00:02.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'l2',
            attrs: {},
          },
          {
            spanId: '8888888888888883',
            parentSpanId: '8888888888888882',
            kind: 'ledger',
            name: 'status',
            start: '2026-10-20T10:00:01.500Z',
            end: '2026-10-20T10:00:02.000Z',
            durationMs: 500,
            basis: 'recorded',
            locator: 'l3',
            attrs: { verb: 'status' },
          },
        ],
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const { requests } = buildOtlpRequests(view, registry, DEFAULT_META);
  const spans = requests[0].resourceSpans[0].scopeSpans[0].spans;

  assert.equal(spans[0].links, undefined);
  assert.deepEqual(spans[1].links, [
    { traceId: '77777777777777777777777777777771', spanId: spans[0].spanId },
  ], 'the link names the remapped root of the linked trace');
  assert.notEqual(spans[0].spanId, '8888888888888881');
  assert.equal(spans[2].links, undefined, 'non-root span has no links');
});

test('skip counts: ungrouped spans and spans with null start are counted and skipped', () => {
  const view: any = {
    v: 1,
    traces: [
      {
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        traceLink: null,
        runKey: 'k/r/l',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:00:02.000Z' },
        spans: [
          {
            spanId: 'bbbbbbbbbbbbbbb1',
            parentSpanId: null,
            kind: 'run',
            name: 'run',
            start: '2026-10-20T10:00:00.000Z',
            end: '2026-10-20T10:00:01.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'l1',
            attrs: {},
          },
          {
            spanId: 'bbbbbbbbbbbbbbb2',
            parentSpanId: 'bbbbbbbbbbbbbbb1',
            kind: 'run',
            name: 'run',
            start: null,
            end: null,
            durationMs: null,
            basis: 'recorded',
            locator: 'l2',
            attrs: {},
          },
        ],
      },
    ],
    ungrouped: [
      {
        group: 'group-1',
        label: 'ungrouped',
        spans: [
          { spanId: 'cccccccccccccccc' },
          { spanId: 'dddddddddddddddd' },
        ],
      },
      {
        group: 'group-2',
        label: 'ungrouped',
        spans: [
          { spanId: 'eeeeeeeeeeeeeeee' },
        ],
      },
    ],
    gaps: [],
  };

  const { requests, skipped } = buildOtlpRequests(view, registry, DEFAULT_META);
  assert.equal(skipped.ungrouped, 3);
  assert.equal(skipped.noStart, 1);
  const spans = requests[0].resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 1);
  assert.match(spans[0].spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(spans[0].spanId, 'bbbbbbbbbbbbbbb1');
});

test('chunking at 512: 513 spans produce exactly 2 requests in order', () => {
  const spans: any = [];
  for (let i = 0; i < 513; i++) {
    const id = i.toString(16).padStart(16, '0');
    spans.push({
      spanId: id,
      parentSpanId: i === 0 ? null : '0000000000000000',
      kind: 'ledger',
      name: 'status',
      start: '2026-10-20T10:00:00.000Z',
      end: '2026-10-20T10:00:01.000Z',
      durationMs: 1000,
      basis: 'recorded',
      locator: `loc#${i}`,
      attrs: { verb: 'status' },
    });
  }

  const view: any = {
    v: 1,
    traces: [
      {
        traceId: 'ffffffffffffffffffffffffffffffff',
        traceLink: null,
        runKey: 'k/r/l',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:00:01.000Z' },
        spans,
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const { requests } = buildOtlpRequests(view, registry, DEFAULT_META);
  assert.equal(requests.length, 2, '513 spans must produce 2 requests');
  assert.equal(requests[0].resourceSpans[0].scopeSpans[0].spans.length, 512);
  assert.equal(requests[1].resourceSpans[0].scopeSpans[0].spans.length, 1);
  const all = requests.flatMap((r: any) => r.resourceSpans[0].scopeSpans[0].spans);
  assert.equal(new Set(all.map((x: any) => x.spanId)).size, 513, 'equal-valued siblings get distinct ids by ordinal');
  const root = all.find((x: any) => !x.parentSpanId);
  assert.ok(root, 'one root');
  assert.ok(all.every((x: any) => x === root || x.parentSpanId === root.spanId), 'every child names the remapped root');
});

test('privacy: session, task, run, lineage, check_key, verify_id, worker_run never appear in serialized bodies', () => {
  const secrets: any = {
    session: 'secret-session-token-xyz',
    task: 'secret-task-identifier',
    run: 'secret-run-identifier',
    lineage: 'secret-lineage-token',
    check_key: 'secret-check-key',
    verify_id: 'secret-verify-id',
    worker_run: 'secret-worker-run',
  };

  const view: any = {
    v: 1,
    traces: [
      {
        traceId: '12345678901234567890123456789012',
        traceLink: null,
        runKey: 'k/r/l',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:00:01.000Z' },
        spans: [
          {
            spanId: '1234567890123456',
            parentSpanId: null,
            kind: 'hook',
            name: 'pre-bash-guard',
            start: '2026-10-20T10:00:00.000Z',
            end: '2026-10-20T10:00:01.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc',
            attrs: {
              tool: 'Bash',
              tool_call_id: 'call_999',
              ...secrets,
            },
          },
        ],
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const { requests } = buildOtlpRequests(view, registry, DEFAULT_META);
  const serialized = JSON.stringify(requests);

  for (const [key, secretVal] of Object.entries(secrets)) {
    assert.ok(!serialized.includes(secretVal), `serialized OTLP bodies must not contain ${key} value '${secretVal}'`);
    assert.ok(!serialized.includes(`"${key}"`), `serialized OTLP bodies must not contain ${key} key`);
  }
});

test('byte identity: two invocations with identical inputs produce identical serialized JSON', () => {
  const view: any = {
    v: 1,
    traces: [
      {
        traceId: 'abcdefabcdefabcdefabcdefabcdefab',
        traceLink: null,
        runKey: 'k/r/l',
        epoch: '2026-10-20T00:00:00Z',
        window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:00:01.000Z' },
        spans: [
          {
            spanId: 'cdefcdefcdefcdef',
            parentSpanId: null,
            kind: 'hook',
            name: 'pre-bash-guard',
            start: '2026-10-20T10:00:00.000Z',
            end: '2026-10-20T10:00:01.000Z',
            durationMs: 1000,
            basis: 'recorded',
            locator: 'loc',
            attrs: {
              tool: 'Bash',
              event: 'PreToolUse',
              duration_ms: 50,
            },
          },
        ],
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const run1 = JSON.stringify(buildOtlpRequests(view, registry, DEFAULT_META));
  const run2 = JSON.stringify(buildOtlpRequests(view, registry, DEFAULT_META));
  assert.equal(run1, run2, 'two runs must produce byte-identical JSON');
});

// --- 091 review fixes: C-1 typed attribute rules, C-4 export-time span ids, C-5 pinned filters ---

const crypto = require('node:crypto');
const { attributeRule } = require('../../src/runtime/trace/otlp-map.ts');
const sha16 = (text: any) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const oneSpanView = (attrs: any, extra: any = {}) => ({
  v: 1,
  traces: [{
    traceId: '0123456789abcdef0123456789abcdef', traceLink: null, runKey: 'k/r/l', epoch: 'e',
    window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:00:01.000Z' },
    spans: [{ spanId: '1111111111111111', parentSpanId: null, kind: 'hook', name: 'hook', start: '2026-10-20T10:00:00.000Z',
      end: '2026-10-20T10:00:01.000Z', durationMs: 1000, basis: 'recorded', locator: 'loc', attrs, ...extra }],
  }],
  ungrouped: [], gaps: [],
});

test('C-1: attributeRule accepts every shipped rule and rejects each type variant of the banned id rule', () => {
  for (const [key, spec] of Object.entries(registry.export.attributes)) {
    assert.ok(!('error' in attributeRule(key, spec)), `${key} is a well-formed rule`);
  }
  const bad: any = [
    ['session', { id: 1 }], ['policy', { id: 'true' }], ['session', { vocabulary: 'harness', id: 1 }],
    ['duration_ms', { measure: 'yes' }], ['session', { id: true }], ['tool_call_id', { id: 1 }],
    ['event', { vocabulary: 'event', raw: true }], ['event', {}], ['event', null], ['event', ['vocabulary']],
    ['event', { vocabulary: '' }], ['event', { vocabulary: 'event', export: 7 }], ['duration_ms', { measure: true, id: true }],
  ];
  for (const [key, spec] of bad) assert.ok('error' in attributeRule(key, spec), `${key} ${JSON.stringify(spec)} is rejected`);
});

test('C-1: the mapper fails closed on a malformed rule: no canary is exported for any planted rule', () => {
  const canary = 'CANARYc1value';
  const plants: any = [
    ['session', { id: 1 }], ['policy', { id: 'true' }], ['session', { vocabulary: 'harness', id: 1 }],
    ['session', { measure: 'yes' }], ['session', { id: true }], ['policy', { id: true, export: 'x.y' }],
  ];
  for (const [key, spec] of plants) {
    const reg = clone(registry);
    reg.export.attributes[key] = spec;
    const body = JSON.stringify(buildOtlpRequests(oneSpanView({ [key]: canary }), reg, DEFAULT_META));
    assert.ok(!body.includes(canary), `${key} ${JSON.stringify(spec)} exports no raw value`);
  }
});

test('C-5: a tool_call_id that fails SAFE_TOKEN is omitted and a safe one round-trips', () => {
  const ids = (value: any) => buildOtlpRequests(oneSpanView({ tool_call_id: value }), registry, DEFAULT_META)
    .requests[0].resourceSpans[0].scopeSpans[0].spans[0].attributes.filter((a: any) => a.key === 'gen_ai.tool.call.id');
  assert.deepEqual(ids('call_999'), [{ key: 'gen_ai.tool.call.id', value: { stringValue: 'call_999' } }]);
  for (const unsafe of ['call 999', 'CANARY/../x', 'x'.repeat(65), '-leading', 'a\nb']) assert.deepEqual(ids(unsafe), [], JSON.stringify(unsafe));
});

test('C-5: a status outside FAIL/fail/error with a non-zero exit exports error.type exit:<code>, never the status', () => {
  const out = buildOtlpRequests(oneSpanView({ status: 'CANARYstatus', exit_code: 1 }), registry, DEFAULT_META);
  const span = out.requests[0].resourceSpans[0].scopeSpans[0].spans[0];
  assert.deepEqual(span.status, { code: 2 });
  assert.deepEqual(span.attributes.filter((a: any) => a.key === 'error.type'), [{ key: 'error.type', value: { stringValue: 'exit:1' } }]);
  assert.ok(!JSON.stringify(out).includes('CANARYstatus'));
});

/** A trace whose local ids and locators embed a slug, a task id and a worktree key, as spans.ts makes them. */
function identifiedView(slug: any, task: any, key: any) {
  const traceId = 'feedfacefeedfacefeedfacefeedface';
  const loc = (rest: any) => `task-attempts/${slug}.json#${key}/local/main/${rest}`;
  const id = (l: any) => sha16(traceId + l);
  const root = loc('0');
  const att = loc(`${task}/1`);
  const att2 = loc(`${task}/2`);
  const hook = `runs/telemetry/2026-10-20.jsonl:${key}:3`;
  const orphanParent = loc(`${task}/0`);
  const span = (l: any, parent: any, kind: any, name: any, start: any, end: any, attrs: any = {}) => ({ spanId: id(l), parentSpanId: parent ? id(parent) : null, kind, name, start, end,
    durationMs: null, basis: 'recorded', locator: l, attrs });
  return {
    v: 1,
    traces: [{
      traceId, traceLink: null, runKey: `${key}/local/main`, epoch: 'e', window: { from: 'a', to: 'b' },
      spans: [
        span(root, null, 'run', 'run', '2026-10-20T10:00:00.000Z', '2026-10-20T10:05:00.000Z'),
        span(att, root, 'attempt', task, '2026-10-20T10:00:01.000Z', '2026-10-20T10:00:02.000Z', { status: 'FAIL' }),
        span(att2, root, 'attempt', task, '2026-10-20T10:00:01.000Z', '2026-10-20T10:00:02.000Z', { status: 'FAIL' }),
        span(hook, att, 'hook', 'hook', '2026-10-20T10:00:01.500Z', '2026-10-20T10:00:01.600Z', { tool: 'Bash', event: 'PreToolUse' }),
        span(orphanParent, root, 'attempt', task, null, null),
        span(loc(`${task}/3`), orphanParent, 'hook', 'hook', '2026-10-20T10:00:03.000Z', '2026-10-20T10:00:03.100Z', { tool: 'Bash' }),
      ],
    }],
    ungrouped: [], gaps: [],
  };
}

test('C-4 planted guess: two slugs, task ids and worktree keys with identical payload values export identical span ids', () => {
  const a = identifiedView('feature-alpha', 'A.1', '0011223344556677');
  const b = identifiedView('other-slug', 'Z.9', 'ffeeddccbbaa9988');
  const outA = JSON.stringify(buildOtlpRequests(a, registry, DEFAULT_META));
  const outB = JSON.stringify(buildOtlpRequests(b, registry, DEFAULT_META));
  assert.equal(outA, outB, 'the exported bodies, ids included, do not depend on any local identifier');
  const shuffled = clone(a);
  shuffled.traces[0].spans.reverse();
  assert.equal(JSON.stringify(buildOtlpRequests(shuffled, registry, DEFAULT_META)), outA, 'the input order does not change the output');
});

test('C-4: no exported id equals a local id or sha16(traceId + locator); parents resolve inside the payload; an unexported parent is dropped', () => {
  const view = identifiedView('feature-alpha', 'A.1', '0011223344556677');
  const local: any = new Set(view.traces[0].spans.flatMap((s) => [s.spanId, sha16(view.traces[0].traceId + s.locator)]));
  const { requests } = buildOtlpRequests(view, registry, DEFAULT_META);
  const spans = requests[0].resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 5, 'the start-less span is skipped');
  const ids: any = new Set(spans.map((s: any) => s.spanId));
  assert.equal(ids.size, 5, 'two equal-valued attempts get distinct ids');
  for (const s of spans) {
    assert.ok(!local.has(s.spanId), `${s.spanId} is not a local id`);
    if (s.parentSpanId !== undefined) assert.ok(ids.has(s.parentSpanId), 'the parent is in the payload');
  }
  const body = JSON.stringify(requests);
  for (const l of local) assert.ok(!body.includes(l), `local id ${l} never appears`);
  const orphan = spans.find((s: any) => s.startTimeUnixNano === (BigInt(Date.parse('2026-10-20T10:00:03.000Z')) * 1000000n).toString());
  assert.ok(!Object.hasOwn(orphan, 'parentSpanId'), 'a child of an unexported span is exported as a root');
  const sortedBy = [...spans].sort((x, y) => (BigInt(x.startTimeUnixNano) < BigInt(y.startTimeUnixNano) ? -1 : BigInt(x.startTimeUnixNano) > BigInt(y.startTimeUnixNano) ? 1 : x.spanId < y.spanId ? -1 : 1));
  assert.deepEqual(spans.map((s: any) => s.spanId), sortedBy.map((s) => s.spanId), 'spans are ordered by start then exported id');
});

test('FU-bwyg91: a span in a parent cycle never takes the id of a root with the same content', () => {
  const span = (spanId: any, parentSpanId: any): any => ({
    spanId, parentSpanId, kind: 'run', name: 'run', start: '2026-10-20T10:00:00.123Z', end: '2026-10-20T10:01:00.123Z',
    durationMs: 60000, basis: 'recorded', locator: `file#${spanId}`, attrs: {},
  });
  const view: any = {
    v: 1,
    traces: [{
      traceId: '0123456789abcdef0123456789abcdef', traceLink: null, runKey: 'k/r/l', epoch: '2026-10-20T00:00:00Z',
      window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T10:01:00.000Z' },
      // a is a root; b and c name each other as parent, so neither is reachable from a root.
      spans: [span('aaaaaaaaaaaaaaaa', null), span('bbbbbbbbbbbbbbbb', 'cccccccccccccccc'), span('cccccccccccccccc', 'bbbbbbbbbbbbbbbb')],
    }],
    ungrouped: [],
    gaps: [],
  };
  const { requests } = buildOtlpRequests(view, registry, DEFAULT_META);
  const ids = requests[0].resourceSpans[0].scopeSpans[0].spans.map((s: any) => s.spanId);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, `span ids are distinct: ${ids.join(', ')}`);
});

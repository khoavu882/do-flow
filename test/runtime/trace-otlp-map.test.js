'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { buildOtlpRequests, ownedLists } = require('../../src/runtime/trace/otlp-map.ts');

const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/telemetry.json'), 'utf8'));

const DEFAULT_META = {
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
  const view = {
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
  assert.equal(span.spanId, '1234567890abcdef');
  assert.equal(span.parentSpanId, undefined);
  assert.equal(span.kind, 1);
  assert.equal(span.name, 'invoke_workflow');
  assert.equal(span.startTimeUnixNano, (BigInt(Date.parse('2026-10-20T10:00:00.123Z')) * 1000000n).toString());
  assert.equal(span.endTimeUnixNano, (BigInt(Date.parse('2026-10-20T10:01:00.123Z')) * 1000000n).toString());
});

test('ids pass through as 32 and 16 lowercase hex; parentSpanId omitted on roots', () => {
  const view = {
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
  assert.equal(spans[0].spanId, 'abcdef0123456789');
  assert.ok(!Object.hasOwn(spans[0], 'parentSpanId'), 'root span has no parentSpanId');

  assert.equal(spans[1].traceId, 'abcdef0123456789abcdef0123456789');
  assert.equal(spans[1].spanId, '1234567890abcdef');
  assert.equal(spans[1].parentSpanId, 'abcdef0123456789');
});

test('times as decimal strings equal to ISO ms x 1e6; null end uses start', () => {
  const startIso = '2026-10-20T12:34:56.789Z';
  const startMs = Date.parse(startIso);
  const expectedNano = (BigInt(startMs) * 1000000n).toString();

  const view = {
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
  const view = {
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
  const attrs0 = Object.fromEntries(spans[0].attributes.map((a) => [a.key, a.value]));
  assert.deepEqual(attrs0['gen_ai.operation.name'], { stringValue: 'execute_tool' });
  assert.deepEqual(attrs0['gen_ai.tool.name'], { stringValue: 'Bash' });
  assert.deepEqual(attrs0['gen_ai.tool.call.id'], { stringValue: 'call_123' });
  assert.deepEqual(attrs0['doflow.hook.duration_ms'], { intValue: '1000' });

  // 2. Hook with custom_tool
  assert.equal(spans[1].name, 'execute_tool');
  const attrs1 = Object.fromEntries(spans[1].attributes.map((a) => [a.key, a.value]));
  assert.deepEqual(attrs1['gen_ai.operation.name'], { stringValue: 'execute_tool' });
  assert.deepEqual(attrs1['gen_ai.tool.name'], { stringValue: 'other' });

  // 3. Worker with codex
  assert.equal(spans[2].name, 'invoke_agent codex');
  const attrs2 = Object.fromEntries(spans[2].attributes.map((a) => [a.key, a.value]));
  assert.deepEqual(attrs2['gen_ai.operation.name'], { stringValue: 'invoke_agent' });
  assert.deepEqual(attrs2['gen_ai.agent.name'], { stringValue: 'codex' });

  // 4. Worker with magic_ai
  assert.equal(spans[3].name, 'invoke_agent');
  const attrs3 = Object.fromEntries(spans[3].attributes.map((a) => [a.key, a.value]));
  assert.deepEqual(attrs3['gen_ai.operation.name'], { stringValue: 'invoke_agent' });
  assert.deepEqual(attrs3['gen_ai.agent.name'], { stringValue: 'other' });

  // 5. Ledger with status
  assert.equal(spans[4].name, 'doflow.ledger status');
  const attrs4 = Object.fromEntries(spans[4].attributes.map((a) => [a.key, a.value]));
  assert.deepEqual(attrs4['doflow.ledger.verb'], { stringValue: 'status' });

  // 6. Ledger with unknown_cmd
  assert.equal(spans[5].name, 'doflow.ledger');
  const attrs5 = Object.fromEntries(spans[5].attributes.map((a) => [a.key, a.value]));
  assert.deepEqual(attrs5['doflow.ledger.verb'], { stringValue: 'other' });

  // 7. Verify with no owning list
  assert.equal(spans[6].name, 'doflow.verify.run');
  const attrs6 = Object.fromEntries(spans[6].attributes.map((a) => [a.key, a.value]));
  assert.deepEqual(attrs6['doflow.verify.run.status'], { stringValue: 'PASS' });
});

test('status and error.type mappings for FAIL, fail, error, and non-zero exit_code', () => {
  const view = {
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
  assert.ok(spans[0].attributes.some((a) => a.key === 'error.type' && a.value.stringValue === 'FAIL'));

  assert.deepEqual(spans[1].status, { code: 2 });
  assert.ok(spans[1].attributes.some((a) => a.key === 'error.type' && a.value.stringValue === 'fail'));

  assert.deepEqual(spans[2].status, { code: 2 });
  assert.ok(spans[2].attributes.some((a) => a.key === 'error.type' && a.value.stringValue === 'error'));

  assert.deepEqual(spans[3].status, { code: 2 });
  assert.ok(spans[3].attributes.some((a) => a.key === 'error.type' && a.value.stringValue === 'exit:42'));

  assert.equal(spans[4].status, undefined, 'status omitted on successful span');
  assert.ok(!spans[4].attributes.some((a) => a.key === 'error.type'), 'no error.type on successful span');
});

test('links: root span links to target trace root span when traceLink matches a trace in the export', () => {
  const view = {
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
    { traceId: '77777777777777777777777777777771', spanId: '8888888888888881' },
  ]);
  assert.equal(spans[2].links, undefined, 'non-root span has no links');
});

test('skip counts: ungrouped spans and spans with null start are counted and skipped', () => {
  const view = {
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
  assert.equal(spans[0].spanId, 'bbbbbbbbbbbbbbb1');
});

test('chunking at 512: 513 spans produce exactly 2 requests in order', () => {
  const spans = [];
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

  const view = {
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
  assert.equal(requests[0].resourceSpans[0].scopeSpans[0].spans[0].spanId, '0000000000000000');
  assert.equal(requests[1].resourceSpans[0].scopeSpans[0].spans[0].spanId, (512).toString(16).padStart(16, '0'));
});

test('privacy: session, task, run, lineage, check_key, verify_id, worker_run never appear in serialized bodies', () => {
  const secrets = {
    session: 'secret-session-token-xyz',
    task: 'secret-task-identifier',
    run: 'secret-run-identifier',
    lineage: 'secret-lineage-token',
    check_key: 'secret-check-key',
    verify_id: 'secret-verify-id',
    worker_run: 'secret-worker-run',
  };

  const view = {
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
  const view = {
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

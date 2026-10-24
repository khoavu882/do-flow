'use strict';

// Feature 091 C.1 (IC-006, IC-009, IC-010): OTLP sender with env resolution, header and timeout parsing,
// bounded POST, partial success, dry run; secrecy tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { tempDir } = require('../helper/tmp.ts');
const { resolveOtlpEnv, sendRequests, handleTraceExport } = require('../../src/runtime/trace/otlp-export.ts');
const otlpMap = require('../../src/runtime/trace/otlp-map.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/telemetry.json'), 'utf8'));

// Helper: run handleTraceExport while capturing output and restoring process.exitCode
async function runExport(opts) {
  const stdout = [];
  const stderr = [];
  const savedExitCode = process.exitCode;
  try {
    const code = await handleTraceExport({
      ...opts,
      stdout: { write: (data) => { stdout.push(String(data)); } },
      stderr: { write: (data) => { stderr.push(String(data)); } },
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.exitCode = savedExitCode;
  }
}

// Helper: create an in-process HTTP receiver on 127.0.0.1
function createReceiver(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        server,
        port,
        url,
        close: () => new Promise((res) => {
          server.close(res);
          server.closeAllConnections();
        }),
      });
    });
    server.on('error', reject);
  });
}

// Helper: create a seeded directory with telemetry data for trace projection
function seedProject(t, { spanCount = 1 } = {}) {
  const dir = tempDir(t, 'doflow-trace-export-');
  const state = path.join(dir, '.doflow', 'state');
  const write = (rel, body) => {
    const file = path.join(state, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  const day = '2026-10-20';
  const traceId = '0123456789abcdef0123456789abcdef';
  const runKey = 'testkey/r1/l1';

  write('task-attempts/feat.json', JSON.stringify({
    version: 1,
    revision: 1,
    runs: {
      [runKey]: {
        runKey,
        worktreeKey: 'testkey',
        run: 'r1',
        lineage: 'l1',
        worktree: dir,
        createdAt: `${day}T10:00:00.000Z`,
        control: 'running',
        epoch: 1,
        traceId,
        history: [
          { at: `${day}T10:00:00.000Z`, action: 'start', by: 'orchestrator', epoch: 1, traceId },
        ],
      },
    },
    tasks: {},
  }, null, 2));

  const telemetryLines = [];
  for (let i = 0; i < spanCount; i++) {
    telemetryLines.push({
      timestamp: `${day}T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
      kind: 'hook',
      run: 'r1',
      lineage: 'l1',
      attempt: 1,
      harness: 'claude',
      event: 'PreToolUse',
      policy: 'pre-bash-guard',
      verdict: 'allow',
      duration_ms: 100,
      session: 's1',
      tool: 'Bash',
      tool_call_id: `tc_${i}`,
    });
  }

  write(`runs/telemetry/${day}.jsonl`, `${telemetryLines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return dir;
}

// ── Environment Resolution Tests ─────────────────────────────────────────────────────────────

test('resolveOtlpEnv: traces endpoint used as-is, a path-less URL posts to /', () => {
  const env1 = { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318' };
  const res1 = resolveOtlpEnv(env1);
  assert.equal(res1.endpoint, 'http://127.0.0.1:4318/');

  const env2 = { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' };
  const res2 = resolveOtlpEnv(env2);
  assert.equal(res2.endpoint, 'http://127.0.0.1:4318/v1/traces');

  const env3 = { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/custom/path' };
  const res3 = resolveOtlpEnv(env3);
  assert.equal(res3.endpoint, 'http://127.0.0.1:4318/custom/path');
});

test('resolveOtlpEnv: base endpoint gains /v1/traces with one slash', () => {
  const env1 = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' };
  const res1 = resolveOtlpEnv(env1);
  assert.equal(res1.endpoint, 'http://127.0.0.1:4318/v1/traces');

  const env2 = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/' };
  const res2 = resolveOtlpEnv(env2);
  assert.equal(res2.endpoint, 'http://127.0.0.1:4318/v1/traces');

  const env3 = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/collector' };
  const res3 = resolveOtlpEnv(env3);
  assert.equal(res3.endpoint, 'http://127.0.0.1:4318/collector/v1/traces');

  const env4 = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/collector/' };
  const res4 = resolveOtlpEnv(env4);
  assert.equal(res4.endpoint, 'http://127.0.0.1:4318/collector/v1/traces');
});

test('resolveOtlpEnv: base endpoint keeps query and normalizes all trailing slashes', () => {
  assert.equal(
    resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/base?key=s3cret' }).endpoint,
    'http://127.0.0.1:4318/base/v1/traces?key=s3cret'
  );
  assert.equal(
    resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/' }).endpoint,
    'http://127.0.0.1:4318/v1/traces'
  );
  assert.equal(
    resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/base///' }).endpoint,
    'http://127.0.0.1:4318/base/v1/traces'
  );
});

test('resolveOtlpEnv: traces endpoint takes precedence over base endpoint', () => {
  const env = {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/specific',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/base',
  };
  const res = resolveOtlpEnv(env);
  assert.equal(res.endpoint, 'http://127.0.0.1:4318/specific');
});

test('resolveOtlpEnv: headers parsed and percent-decoded with trimming', () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: ' key1 = value1 , key2 = hello%20world , key3 = a%3Db%2Cc ',
  };
  const res = resolveOtlpEnv(env);
  assert.deepEqual(res.headers, {
    key1: 'value1',
    key2: 'hello world',
    key3: 'a=b,c',
  });
});

test('resolveOtlpEnv: traces headers takes precedence over base headers', () => {
  const env = {
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'k1=v1',
    OTEL_EXPORTER_OTLP_HEADERS: 'k2=v2',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
  };
  const res = resolveOtlpEnv(env);
  assert.deepEqual(res.headers, { k1: 'v1' });
});

test('resolveOtlpEnv: timeout defaults to 10000 ms and clamps >30000 to 30000', () => {
  const envDefault = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' };
  assert.equal(resolveOtlpEnv(envDefault).timeoutMs, 10000);

  const envCustom = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_TIMEOUT: '5000' };
  assert.equal(resolveOtlpEnv(envCustom).timeoutMs, 5000);

  const envClamp = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_TIMEOUT: '40000' };
  assert.equal(resolveOtlpEnv(envClamp).timeoutMs, 30000);

  const envTracesClamp = {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '50000',
    OTEL_EXPORTER_OTLP_TIMEOUT: '2000',
  };
  assert.equal(resolveOtlpEnv(envTracesClamp).timeoutMs, 30000);
});

test('resolveOtlpEnv: empty OTEL header and timeout variables count as unset', () => {
  const endpoint = 'http://127.0.0.1:4318';

  for (const name of ['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS']) {
    assert.deepEqual(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }).headers, {});
    for (const value of ['', '   ']) {
      assert.deepEqual(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, [name]: value }).headers, {});
    }
    assert.deepEqual(
      resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, [name]: ' , a=1, , b=2, ' }).headers,
      { a: '1', b: '2' }
    );
    assert.deepEqual(
      resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, [name]: 'a=1,b=2' }).headers,
      { a: '1', b: '2' }
    );
    assert.throws(
      () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, [name]: 'bad_member' }),
      (err) => err.message.includes(name) && !err.message.includes('bad_member')
    );
  }

  assert.deepEqual(resolveOtlpEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: 'base=1',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: '',
  }).headers, { base: '1' });

  for (const name of ['OTEL_EXPORTER_OTLP_TIMEOUT', 'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT']) {
    assert.equal(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }).timeoutMs, 10000);
    for (const value of ['', '   ']) {
      assert.equal(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, [name]: value }).timeoutMs, 10000);
    }
    assert.equal(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, [name]: '250' }).timeoutMs, 250);
    assert.throws(
      () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, [name]: 'not_a_number' }),
      (err) => err.message.includes(name) && !err.message.includes('not_a_number')
    );
  }

  assert.equal(resolveOtlpEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TIMEOUT: '750',
    OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '',
  }).timeoutMs, 750);

  // N-4: an empty or blank traces endpoint counts as unset, so the base endpoint is used
  for (const value of ['', '   ']) {
    assert.equal(resolveOtlpEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: value, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }).endpoint,
      'http://127.0.0.1:4318/v1/traces');
    assert.throws(() => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: value, OTEL_EXPORTER_OTLP_ENDPOINT: value }),
      (err) => /^missing endpoint/.test(err.message));
  }
});

test('resolveOtlpEnv: invalid header token and decoded control characters name only the variable', () => {
  for (const value of ['a=x%0D%0AInjected:%20v', 'bad name=v']) {
    assert.throws(
      () => resolveOtlpEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_EXPORTER_OTLP_HEADERS: value,
      }),
      (err) => {
        assert.match(err.message, /OTEL_EXPORTER_OTLP_HEADERS/);
        assert.ok(!err.message.includes('Injected'));
        assert.ok(!err.message.includes('bad name'));
        assert.ok(!err.message.includes(value));
        return true;
      }
    );
  }
});

test('resolveOtlpEnv: usage errors name the variable only without echoing values', () => {
  // No endpoint names both variables
  assert.throws(
    () => resolveOtlpEnv({}),
    (err) => {
      assert.match(err.message, /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
      assert.match(err.message, /OTEL_EXPORTER_OTLP_ENDPOINT/);
      return true;
    }
  );

  for (const name of ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_ENDPOINT']) {
    assert.throws(
      () => resolveOtlpEnv({ [name]: 'http://127.0.0.1:4318#frag' }),
      (err) => err.message.includes(name) && !err.message.includes('#frag')
    );
  }

  // Scheme not http/https
  assert.throws(
    () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://127.0.0.1:4318' }),
    (err) => {
      assert.match(err.message, /OTEL_EXPORTER_OTLP_ENDPOINT/);
      assert.ok(!err.message.includes('ftp://'));
      return true;
    }
  );

  // URL with user info
  assert.throws(
    () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://secretuser:secretpass@127.0.0.1:4318' }),
    (err) => {
      assert.match(err.message, /OTEL_EXPORTER_OTLP_ENDPOINT/);
      assert.ok(!err.message.includes('secretuser'));
      assert.ok(!err.message.includes('secretpass'));
      return true;
    }
  );

  // Missing '=' in headers
  assert.throws(
    () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_HEADERS: 'noequals' }),
    (err) => {
      assert.match(err.message, /OTEL_EXPORTER_OTLP_HEADERS/);
      assert.ok(!err.message.includes('noequals'));
      return true;
    }
  );

  // Empty key in headers
  assert.throws(
    () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_HEADERS: '=secret' }),
    (err) => {
      assert.match(err.message, /OTEL_EXPORTER_OTLP_HEADERS/);
      assert.ok(!err.message.includes('secret'));
      return true;
    }
  );

  // Bad escape in headers
  assert.throws(
    () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_HEADERS: 'k=%ZZsecret' }),
    (err) => {
      assert.match(err.message, /OTEL_EXPORTER_OTLP_HEADERS/);
      assert.ok(!err.message.includes('secret'));
      return true;
    }
  );

  for (const value of ['a=x%0D%0AInjected:%20v', 'bad name=v']) {
    assert.throws(
      () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_HEADERS: value }),
      (err) => {
        assert.match(err.message, /OTEL_EXPORTER_OTLP_HEADERS/);
        assert.ok(!err.message.includes('Injected'));
        assert.ok(!err.message.includes('bad name'));
        return true;
      }
    );
  }

  // Non-integer timeout
  assert.throws(
    () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_TIMEOUT: 'abc' }),
    (err) => {
      assert.match(err.message, /OTEL_EXPORTER_OTLP_TIMEOUT/);
      assert.ok(!err.message.includes('abc'));
      return true;
    }
  );

  // Zero timeout
  assert.throws(
    () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_TIMEOUT: '0' }),
    (err) => {
      assert.match(err.message, /OTEL_EXPORTER_OTLP_TIMEOUT/);
      return true;
    }
  );

  // Negative timeout
  assert.throws(
    () => resolveOtlpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_TIMEOUT: '-10' }),
    (err) => {
      assert.match(err.message, /OTEL_EXPORTER_OTLP_TIMEOUT/);
      return true;
    }
  );
});

// ── Send Cases with In-Process Receiver ───────────────────────────────────────────────────────

test('sendRequests: 200 counts sent and status ok', async () => {
  let receivedCount = 0;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/json');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
  });

  try {
    const requests = [{ resourceSpans: [] }];
    const res = await sendRequests(requests, {
      endpoint: receiver.url,
      headers: { 'X-Test': '1' },
      timeoutMs: 5000,
    });

    assert.equal(res.requests, 1);
    assert.equal(res.sent, 1);
    assert.equal(res.rejected, 0);
    assert.equal(res.status, 'ok');
    assert.equal(res.httpStatus, 200);
    assert.equal(res.reason, null);
    assert.equal(receivedCount, 1);
  } finally {
    await receiver.close();
  }
});

test('sendRequests: 200 with partialSuccess.rejectedSpans gives status partial', async () => {
  const receiver = await createReceiver((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ partialSuccess: { rejectedSpans: 3 } }));
  });

  try {
    const requests = [{ resourceSpans: [] }];
    const res = await sendRequests(requests, {
      endpoint: receiver.url,
      timeoutMs: 5000,
    });

    assert.equal(res.requests, 1);
    assert.equal(res.sent, 1);
    assert.equal(res.rejected, 3);
    assert.equal(res.status, 'partial');
    assert.equal(res.httpStatus, 200);
    assert.equal(res.reason, null);
  } finally {
    await receiver.close();
  }
});

test('sendRequests N-2: a malformed partialSuccess count or the snake_case form is failed/bad-response and stops the loop', async () => {
  const bad = ['{"partialSuccess":{"rejectedSpans":1e30}}', '{"partialSuccess":{"rejectedSpans":"9007199254740993"}}',
    '{"partialSuccess":{"rejectedSpans":2.5}}', '{"partialSuccess":{"rejectedSpans":-1}}', '{"partialSuccess":{"rejectedSpans":true}}',
    '{"partialSuccess":{"rejectedSpans":""}}', '{"partialSuccess":{"rejectedSpans":"0x2"}}', '{"partialSuccess":"x"}',
    '{"partial_success":{"rejected_spans":2}}'];
  for (const body of bad) {
    let received = 0;
    const receiver = await createReceiver((req, res) => {
      received++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    try {
      const res = await sendRequests([{ resourceSpans: [] }, { resourceSpans: [] }], { endpoint: receiver.url, timeoutMs: 5000 });
      assert.deepEqual({ status: res.status, reason: res.reason, sent: res.sent, httpStatus: res.httpStatus, received },
        { status: 'failed', reason: 'bad-response', sent: 1, httpStatus: 200, received: 1 }, body);
    } finally {
      await receiver.close();
    }
  }
  // the valid forms: int64 as a decimal string, zero, an empty partialSuccess, an errorMessage only
  for (const [body, status, rejected] of [['{"partialSuccess":{"rejectedSpans":"2"}}', 'partial', 2], ['{"partialSuccess":{"rejectedSpans":0}}', 'ok', 0],
    ['{"partialSuccess":{}}', 'ok', 0], ['{"partialSuccess":{"errorMessage":"warn"}}', 'ok', 0]]) {
    const receiver = await createReceiver((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    try {
      const res = await sendRequests([{ resourceSpans: [] }], { endpoint: receiver.url, timeoutMs: 5000 });
      assert.deepEqual({ status: res.status, rejected: res.rejected, reason: res.reason }, { status, rejected, reason: null }, body);
    } finally {
      await receiver.close();
    }
  }
});

test('sendRequests: 200 body timeout fails and stops before the second request', async () => {
  let receivedCount = 0;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    if (receivedCount === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
      return;
    }
    res.end('{}');
  });

  try {
    const result = await sendRequests([{ resourceSpans: [] }, { resourceSpans: [] }], {
      endpoint: receiver.url,
      timeoutMs: 300,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'timeout');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.sent, 1);
    assert.equal(receivedCount, 1);
  } finally {
    await receiver.close();
  }
});

test('sendRequests: 200 body connection reset fails and stops before the second request', async () => {
  let receivedCount = 0;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    res.writeHead(200, { 'Content-Length': '100' });
    res.write('four');
    setTimeout(() => res.socket?.destroy(), 20);
  });

  try {
    const result = await sendRequests([{ resourceSpans: [] }, { resourceSpans: [] }], {
      endpoint: receiver.url,
      timeoutMs: 300,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'connection');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.sent, 1);
    assert.equal(receivedCount, 1);
  } finally {
    await receiver.close();
  }
});

test('sendRequests: complete invalid JSON bodies remain accepted', async () => {
  let receivedCount = 0;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not json');
  });

  try {
    const result = await sendRequests([{ resourceSpans: [] }, { resourceSpans: [] }], {
      endpoint: receiver.url,
      timeoutMs: 5000,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.sent, 2);
    assert.equal(result.rejected, 0);
    assert.equal(receivedCount, 2);
  } finally {
    await receiver.close();
  }
});

test('sendRequests: 200 response body over 65536 bytes fails without returning body content', async () => {
  let receivedCount = 0;
  const body = `response_body_canary:${'x'.repeat(70000)}`;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    res.writeHead(200, { 'Content-Length': String(Buffer.byteLength(body)) });
    res.write(body.slice(0, 35000));
    setTimeout(() => {
      if (!res.destroyed) res.end(body.slice(35000));
    }, 10);
  });

  try {
    const result = await sendRequests([{ resourceSpans: [] }, { resourceSpans: [] }], {
      endpoint: receiver.url,
      timeoutMs: 5000,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'bad-response');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.sent, 1);
    assert.equal(receivedCount, 1);
    assert.ok(!JSON.stringify(result).includes('response_body_canary'));
    assert.deepEqual(Object.keys(result).sort(), ['httpStatus', 'reason', 'rejected', 'requests', 'sent', 'status']);
  } finally {
    await receiver.close();
  }
});

test('sendRequests: rejected body stream reads report timeout and connection', async () => {
  for (const [error, reason] of [
    [Object.assign(new Error(), { name: 'TimeoutError' }), 'timeout'],
    [Object.assign(new Error('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }), 'connection'],
  ]) {
    const result = await sendRequests([{ resourceSpans: [] }], {
      endpoint: 'http://receiver.invalid',
      fetchImpl: async () => ({
        status: 200,
        body: {
          getReader: () => ({
            read: async () => { throw error; },
          }),
        },
      }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, reason);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.sent, 1);
  }
});

test('sendRequests: bounded body reader cancels after 65536 bytes', async () => {
  let cancelled = false;
  const responseBody = new Uint8Array(70000);
  const result = await sendRequests([{ resourceSpans: [] }, { resourceSpans: [] }], {
    endpoint: 'http://receiver.invalid',
    fetchImpl: async () => ({
      status: 200,
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: responseBody }),
          cancel: async () => { cancelled = true; },
        }),
      },
    }),
  });
  assert.equal(cancelled, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'bad-response');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.sent, 1);
});

test('sendRequests: 400 stops at the first request with no second request received', async () => {
  let receivedCount = 0;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad request' }));
  });

  try {
    const requests = [{ resourceSpans: [1] }, { resourceSpans: [2] }];
    const res = await sendRequests(requests, {
      endpoint: receiver.url,
      timeoutMs: 5000,
    });

    assert.equal(res.requests, 2);
    assert.equal(res.sent, 0);
    assert.equal(res.status, 'failed');
    assert.equal(res.httpStatus, 400);
    assert.equal(res.reason, 'http-status');
    assert.equal(receivedCount, 1, 'receiver saw only the first request');
  } finally {
    await receiver.close();
  }
});

test('sendRequests: 503 stops at the first request with no second request received', async () => {
  let receivedCount = 0;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    res.writeHead(503);
    res.end();
  });

  try {
    const requests = [{ resourceSpans: [1] }, { resourceSpans: [2] }];
    const res = await sendRequests(requests, {
      endpoint: receiver.url,
      timeoutMs: 5000,
    });

    assert.equal(res.requests, 2);
    assert.equal(res.sent, 0);
    assert.equal(res.status, 'failed');
    assert.equal(res.httpStatus, 503);
    assert.equal(res.reason, 'http-status');
    assert.equal(receivedCount, 1, 'receiver saw only the first request');
  } finally {
    await receiver.close();
  }
});

test('sendRequests: 302 stops at the first request with reason redirect', async () => {
  let receivedCount = 0;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    res.writeHead(302, { Location: '/redirected' });
    res.end();
  });

  try {
    const requests = [{ resourceSpans: [1] }, { resourceSpans: [2] }];
    const res = await sendRequests(requests, {
      endpoint: receiver.url,
      timeoutMs: 5000,
    });

    assert.equal(res.requests, 2);
    assert.equal(res.sent, 0);
    assert.equal(res.status, 'failed');
    assert.equal(res.reason, 'redirect');
    assert.equal(receivedCount, 1, 'receiver saw only the first request');
  } finally {
    await receiver.close();
  }
});

test('sendRequests: receiver that never answers with timeout 200 ms returns within 2 s', async () => {
  const receiver = await createReceiver((req, res) => {
    // never answers
  });

  try {
    const started = Date.now();
    const requests = [{ resourceSpans: [1] }];
    const res = await sendRequests(requests, {
      endpoint: receiver.url,
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 2000, `expected < 2000 ms, took ${elapsed} ms`);
    assert.equal(res.status, 'failed');
    assert.equal(res.reason, 'timeout');
  } finally {
    await receiver.close();
  }
});

test('sendRequests: closed port gives reason connection', async () => {
  // Use a port that was just closed
  const receiver = await createReceiver((req, res) => { res.end(); });
  const url = receiver.url;
  await receiver.close();

  const requests = [{ resourceSpans: [1] }];
  const res = await sendRequests(requests, {
    endpoint: url,
    timeoutMs: 5000,
  });

  assert.equal(res.status, 'failed');
  assert.equal(res.reason, 'connection');
  assert.equal(res.httpStatus, null);
});

// ── Handler handleTraceExport Tests ──────────────────────────────────────────────────────────

test('handleTraceExport: requires --otlp-http', async (t) => {
  const dir = seedProject(t);

  const { code, stderr } = await runExport({
    positional: [dir],
    otlpHttp: false,
  });

  assert.equal(code, 2);
  assert.match(stderr, /--otlp-http/);
});

test('handleTraceExport: positional > 1 exits 2', async (t) => {
  const dir = seedProject(t);

  const { code, stderr } = await runExport({
    positional: [dir, 'extra'],
    otlpHttp: true,
  });

  assert.equal(code, 2);
  assert.match(stderr, /usage: trace export/);
});

test('handleTraceExport: bad --run exits 2', async (t) => {
  const dir = seedProject(t);

  const { code, stderr } = await runExport({
    positional: [dir],
    run: 'invalid///run',
    otlpHttp: true,
  });

  assert.equal(code, 2);
  assert.match(stderr, /--run/);
});

test('handleTraceExport: env errors exit 2 with no request received', async (t) => {
  let receivedCount = 0;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    res.end();
  });

  try {
    const dir = seedProject(t);

    const badEnvs = [
      {}, // missing endpoint
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://127.0.0.1:4318' }, // ftp scheme
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://user:pass@127.0.0.1:4318' }, // user info
      { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_EXPORTER_OTLP_HEADERS: 'missing_eq' }, // missing =
      { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_EXPORTER_OTLP_HEADERS: '=empty_key' }, // empty key
      { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_EXPORTER_OTLP_HEADERS: 'k=%ZZbad' }, // bad escape
      { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_EXPORTER_OTLP_TIMEOUT: 'not_number' }, // bad timeout
      { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_EXPORTER_OTLP_TIMEOUT: '0' }, // 0 timeout
    ];

    for (const env of badEnvs) {
      const { code } = await runExport({
        positional: [dir],
        otlpHttp: true,
        env,
      });
      assert.equal(code, 2, `expected exit 2 for env ${JSON.stringify(env)}`);
    }

    assert.equal(receivedCount, 0, 'receiver received zero requests across all env errors');
  } finally {
    await receiver.close();
  }
});

test('handleTraceExport: dry run needs no endpoint, prints mapper bodies on stdout and summary on stderr', async (t) => {
  const dir = seedProject(t, { spanCount: 5 });

  const fetchStub = () => {
    throw new Error('fetch must never be called during dry run');
  };

  const { code, stdout, stderr } = await runExport({
    positional: [dir],
    otlpHttp: true,
    dryRun: true,
    env: {}, // no endpoint!
    fetchImpl: fetchStub,
  });

  assert.equal(code, 0);
  const stdoutJson = JSON.parse(stdout);
  assert.ok(Array.isArray(stdoutJson), 'stdout is JSON array');
  assert.equal(stdoutJson.length, 1);
  assert.ok(stdoutJson[0].resourceSpans, 'body has resourceSpans');
  assert.match(stderr, /dry run/);
});

test('handleTraceExport: unsupported protocol writes one variable-only note and still exports', async (t) => {
  const dir = seedProject(t, { spanCount: 1 });
  let sent = 0;
  const fetchImpl = async () => {
    sent++;
    return { status: 200, body: null, text: async () => '' };
  };

  const unsupported = await runExport({
    positional: [dir],
    otlpHttp: true,
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://receiver.invalid',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    },
    fetchImpl,
  });
  assert.equal(unsupported.code, 0);
  assert.equal(sent, 1);
  assert.equal(unsupported.stderr.trim(), 'doflow trace export: OTEL_EXPORTER_OTLP_PROTOCOL is not read: --otlp-http sends HTTP/JSON');
  assert.ok(!unsupported.stdout.includes('grpc'));
  assert.ok(!unsupported.stderr.includes('grpc'));

  for (const value of ['http/json', '']) {
    const quiet = await runExport({
      positional: [dir],
      otlpHttp: true,
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://receiver.invalid',
        OTEL_EXPORTER_OTLP_PROTOCOL: value,
      },
      fetchImpl,
    });
    assert.equal(quiet.code, 0);
    assert.equal(quiet.stderr, '');
  }

  const tracesOverride = await runExport({
    positional: [dir],
    otlpHttp: true,
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://receiver.invalid',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
    },
    fetchImpl,
  });
  assert.equal(tracesOverride.code, 0);
  assert.equal(tracesOverride.stderr, '');

  const emptyTracesFallback = await runExport({
    positional: [dir],
    otlpHttp: true,
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://receiver.invalid',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: '   ',
    },
    fetchImpl,
  });
  assert.equal(emptyTracesFallback.code, 0);
  assert.match(emptyTracesFallback.stderr, /OTEL_EXPORTER_OTLP_PROTOCOL is not read/);

  const dryRun = await runExport({
    positional: [dir],
    otlpHttp: true,
    dryRun: true,
    env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    fetchImpl,
  });
  assert.equal(dryRun.code, 0);
  assert.doesNotMatch(dryRun.stderr, /OTEL_EXPORTER_OTLP_PROTOCOL is not read/);
});

test('handleTraceExport: 21 requests worth of spans exits 2 before any request naming --run', async (t) => {
  let receivedCount = 0;
  const receiver = await createReceiver((req, res) => {
    receivedCount++;
    res.end();
  });

  try {
    const dir = seedProject(t, { spanCount: 1 });
    const manyRequests = Array.from({ length: 21 }, () => ({ resourceSpans: [] }));

    const orig = otlpMap.buildOtlpRequests;
    otlpMap.buildOtlpRequests = () => ({
      requests: manyRequests,
      skipped: { ungrouped: 0, noStart: 0 },
    });

    try {
      const { code, stderr } = await runExport({
        positional: [dir],
        otlpHttp: true,
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url },
      });

      assert.equal(code, 2);
      assert.match(stderr, /--run/);
      assert.equal(receivedCount, 0, 'no requests sent to receiver');
    } finally {
      otlpMap.buildOtlpRequests = orig;
    }
  } finally {
    await receiver.close();
  }
});

test('handleTraceExport: 200 exits 0; partial success exits 1', async (t) => {
  let isPartial = false;
  const receiver = await createReceiver((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (isPartial) {
      res.end(JSON.stringify({ partialSuccess: { rejectedSpans: 3 } }));
    } else {
      res.end(JSON.stringify({}));
    }
  });

  try {
    const dir = seedProject(t, { spanCount: 2 });

    // Test 200 OK -> exit 0
    {
      const { code, stdout } = await runExport({
        positional: [dir],
        otlpHttp: true,
        json: true,
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url },
      });

      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.status, 'ok');
      assert.equal(parsed.sent, 1);
      assert.equal(parsed.rejected, 0);
      assert.equal(parsed.httpStatus, 200);
    }

    // Test partial success -> exit 1
    {
      isPartial = true;
      const { code, stdout } = await runExport({
        positional: [dir],
        otlpHttp: true,
        json: true,
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url },
      });

      assert.equal(code, 1);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.status, 'partial');
      assert.equal(parsed.rejected, 3);
    }
  } finally {
    await receiver.close();
  }
});

test('handleTraceExport secrecy: canary in header value and URL never appears in stdout or stderr', async (t) => {
  const CANARY_URL_SECRET = 'secret_canary_url_token_98765';
  const CANARY_HEADER_SECRET = 'secret_canary_header_token_12345';

  const receiver = await createReceiver((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'fail' }));
  });

  try {
    const dir = seedProject(t, { spanCount: 1 });

    const { code, stdout, stderr } = await runExport({
      positional: [dir],
      otlpHttp: true,
      env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${receiver.url}/${CANARY_URL_SECRET}`,
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Secret=${CANARY_HEADER_SECRET}`,
      },
    });

    assert.equal(code, 1);

    const combinedOutput = stdout + '\n' + stderr;
    assert.ok(!combinedOutput.includes(CANARY_URL_SECRET), 'canary URL secret found in output');
    assert.ok(!combinedOutput.includes(CANARY_URL_SECRET.slice(0, 8)), 'canary URL prefix found in output');
    assert.ok(!combinedOutput.includes(CANARY_HEADER_SECRET), 'canary header secret found in output');
    assert.ok(!combinedOutput.includes(CANARY_HEADER_SECRET.slice(0, 8)), 'canary header prefix found in output');
  } finally {
    await receiver.close();
  }
});

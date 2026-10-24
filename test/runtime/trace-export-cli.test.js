'use strict';

// Feature 091 D.1 (IC-006; FR-009, FR-012, NFR-009): `trace export` is a view of the existing
// `trace` verb, wired through a lazy require in the `trace` switch. Through `bin/doflow.js`:
// - without `--otlp-http` exits 2 naming it;
// - without an endpoint exits 2 naming both variables and a listening in-process receiver receives nothing;
// - with `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` pointing to the receiver exits 0 and the receiver gets exactly one request on a seeded project with one trace;
// - `--dry-run --json` prints the bodies with no endpoint set;
// - `trace`, `stats`, `trace analyze` and `--help` do not load otlp-export.ts (require-cache probe).
// Real collector settings in parent env never leak into tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO, 'bin', 'doflow.js');
const EXPORT_FILE = path.join(REPO, 'src', 'runtime', 'trace', 'otlp-export.ts');
const DAY = '2026-10-20';

function createReceiver(handler = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({}));
}) {
  const requests = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, requests);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/v1/traces`,
        requests,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections();
        }),
      });
    });
    server.on('error', reject);
  });
}

function seed(t, { spanCount = 1 } = {}) {
  const dir = tempDir(t, 'doflow-trace-export-cli-');
  const state = path.join(dir, '.doflow', 'state');
  const write = (rel, body) => {
    const file = path.join(state, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

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
        createdAt: `${DAY}T10:00:00.000Z`,
        control: 'running',
        epoch: 1,
        traceId,
        history: [
          { at: `${DAY}T10:00:00.000Z`, action: 'start', by: 'orchestrator', epoch: 1, traceId },
        ],
      },
    },
    tasks: {},
  }, null, 2));

  const telemetryLines = [];
  for (let i = 0; i < spanCount; i++) {
    telemetryLines.push({
      timestamp: `${DAY}T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
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

  write(`runs/telemetry/${DAY}.jsonl`, `${telemetryLines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { dir, home: tempDir(t, 'doflow-trace-export-cli-home-') };
}

function env(home, extra = {}) {
  // Construct explicit env stripping any parent OTEL_* settings
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR || '/tmp',
    FORCE_COLOR: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function cli({ dir, home }, args, { input, env: extraEnv = {}, pre = [] } = {}) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [...pre, BIN, ...args], {
      cwd: dir,
      env: env(home, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => { stdout += d; });
    cp.stderr.on('data', (d) => { stderr += d; });
    cp.on('error', reject);
    if (input) {
      cp.stdin.write(input);
      cp.stdin.end();
    }
    cp.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test('CLI: without --otlp-http exits 2 naming it', async (t) => {
  const p = seed(t);
  const r = await cli(p, ['trace', 'export', p.dir]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--otlp-http/);

  const j = await cli(p, ['trace', 'export', '--json', p.dir]);
  assert.equal(j.status, 2, j.stdout + j.stderr);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.error, 'usage');
  assert.match(parsed.detail, /--otlp-http/);
});

test('CLI: without an endpoint exits 2 naming both variables and receiver receives nothing', async (t) => {
  const receiver = await createReceiver();
  try {
    const p = seed(t);
    const r = await cli(p, ['trace', 'export', '--otlp-http', p.dir]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
    assert.match(r.stderr, /OTEL_EXPORTER_OTLP_ENDPOINT/);

    const j = await cli(p, ['trace', 'export', '--otlp-http', '--json', p.dir]);
    assert.equal(j.status, 2, j.stdout + j.stderr);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.error, 'usage');
    assert.match(parsed.detail, /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
    assert.match(parsed.detail, /OTEL_EXPORTER_OTLP_ENDPOINT/);

    assert.equal(receiver.requests.length, 0, 'receiver must receive no requests without an endpoint configured');
  } finally {
    await receiver.close();
  }
});

test('CLI: with OTEL_EXPORTER_OTLP_TRACES_ENDPOINT pointing to receiver exits 0 and receiver gets one request', async (t) => {
  const receiver = await createReceiver();
  try {
    const p = seed(t);
    const r = await cli(p, ['trace', 'export', '--otlp-http', p.dir], {
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.url },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ok/);
    assert.equal(receiver.requests.length, 1, 'receiver receives exactly one request');

    const req = receiver.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/json');
    const body = JSON.parse(req.body);
    assert.ok(Array.isArray(body.resourceSpans));
    assert.equal(body.resourceSpans.length, 1);
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    assert.ok(spans.length >= 1);
    assert.equal(spans[0].traceId, '0123456789abcdef0123456789abcdef');

    // Also with --json
    const j = await cli(p, ['trace', 'export', '--otlp-http', '--json', p.dir], {
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.url },
    });
    assert.equal(j.status, 0, j.stdout + j.stderr);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.sent, 1);
    assert.equal(parsed.rejected, 0);
    assert.equal(parsed.requests, 1);
    assert.equal(receiver.requests.length, 2, 'two requests total after second run');
  } finally {
    await receiver.close();
  }
});

test('CLI: --dry-run --json prints the bodies with no endpoint set', async (t) => {
  const p = seed(t);
  const r = await cli(p, ['trace', 'export', '--otlp-http', '--dry-run', '--json', p.dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /dry run: 1 request\(s\)/);

  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.ok(Array.isArray(parsed[0].resourceSpans));
  assert.ok(parsed[0].resourceSpans[0].scopeSpans[0].spans.length >= 1);
});

test('CLI: `trace`, `stats`, `trace analyze` and `--help` never load otlp-export.ts; `trace export` does; no new verb', async (t) => {
  const p = seed(t);
  const probe = path.join(tempDir(t, 'doflow-trace-export-cli-probe-'), 'probe.js');
  fs.writeFileSync(
    probe,
    `process.on('exit', () => { process.stderr.write('EXPORT_LOADED=' + Object.keys(require.cache).includes(${JSON.stringify(EXPORT_FILE)}) + '\\n'); });\n`
  );

  for (const args of [
    ['trace', '--json', p.dir],
    ['stats', '--json', p.dir],
    ['trace', 'spans', p.dir],
    ['trace', 'analyze', p.dir],
    ['--help'],
  ]) {
    const r = await cli(p, args, { pre: ['-r', probe] });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /EXPORT_LOADED=false/, args.join(' '));
  }

  // Positive control: the export command loads otlp-export.ts
  const pos = await cli(p, ['trace', 'export', '--otlp-http', '--dry-run', '--json', p.dir], { pre: ['-r', probe] });
  assert.equal(pos.status, 0, pos.stderr);
  assert.match(pos.stderr, /EXPORT_LOADED=true/);

  const help = (await cli(p, ['--help'])).stdout;
  assert.match(help, /trace export/);
  assert.match(help, /--otlp-http/);
  assert.doesNotMatch(help, /^ {2}export\s/m, 'export is a trace view, not a verb');

  const run = fs.readFileSync(path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run'), 'utf8');
  assert.match(run, /^ {2}trace\s{2,}.*trace export/m);
  assert.doesNotMatch(run, /\|export\|/);
});

test('CLI: base endpoint keeps its query when adding /v1/traces and rejects fragments before sending', async (t) => {
  const receiver = await createReceiver();
  try {
    const p = seed(t);
    for (const [envName, variableName] of [
      ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
      ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_ENDPOINT'],
    ]) {
      const r = await cli(p, ['trace', 'export', '--otlp-http', p.dir], {
        env: { [envName]: `${receiver.url}#frag` },
      });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(variableName));
      assert.doesNotMatch(r.stdout + r.stderr, /#frag/);
      assert.equal(receiver.requests.length, 0, `${variableName} fragment must send no request`);
    }

    const endpoint = receiver.url.replace(/\/v1\/traces$/, '/base?key=s3cret');
    const r = await cli(p, ['trace', 'export', '--otlp-http', p.dir], {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(receiver.requests.length, 1);
    assert.equal(receiver.requests[0].url, '/base/v1/traces?key=s3cret');
    assert.doesNotMatch(r.stdout + r.stderr, /s3cret/);
  } finally {
    await receiver.close();
  }
});

test('CLI: invalid header names and decoded control values exit 2 without sending or echoing them', async (t) => {
  const receiver = await createReceiver();
  try {
    const p = seed(t);
    for (const value of ['a=x%0D%0AInjected:%20v', 'bad name=v']) {
      const r = await cli(p, ['trace', 'export', '--otlp-http', p.dir], {
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.url,
          OTEL_EXPORTER_OTLP_HEADERS: value,
        },
      });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /OTEL_EXPORTER_OTLP_HEADERS/);
      assert.doesNotMatch(r.stdout + r.stderr, /Injected|bad name/);
      assert.equal(receiver.requests.length, 0);
    }
  } finally {
    await receiver.close();
  }
});

test('CLI: unsupported OTLP protocol is named once and export continues; matching and empty values are quiet', async (t) => {
  const receiver = await createReceiver();
  try {
    const p = seed(t);
    const grpc = await cli(p, ['trace', 'export', '--otlp-http', p.dir], {
      env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.url,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      },
    });
    assert.equal(grpc.status, 0, grpc.stdout + grpc.stderr);
    assert.equal(grpc.stderr.trim(), 'doflow trace export: OTEL_EXPORTER_OTLP_PROTOCOL is not read: --otlp-http sends HTTP/JSON');
    assert.doesNotMatch(grpc.stdout + grpc.stderr, /grpc/);
    assert.equal(receiver.requests.length, 1);

    for (const value of ['http/json', '']) {
      const r = await cli(p, ['trace', 'export', '--otlp-http', p.dir], {
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.url,
          OTEL_EXPORTER_OTLP_PROTOCOL: value,
        },
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.doesNotMatch(r.stderr, /OTEL_EXPORTER_OTLP_PROTOCOL is not read/);
    }
    assert.equal(receiver.requests.length, 3);

    const dryRun = await cli(p, ['trace', 'export', '--otlp-http', '--dry-run', p.dir], {
      env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    });
    assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr);
    assert.doesNotMatch(dryRun.stderr, /OTEL_EXPORTER_OTLP_PROTOCOL is not read/);
    assert.equal(receiver.requests.length, 3, 'dry run sends no request');
  } finally {
    await receiver.close();
  }
});

test('CLI: oversized 200 response body fails and never appears in output', async (t) => {
  const responseBody = `response_body_canary:${'x'.repeat(70000)}`;
  const receiver = await createReceiver((_req, res) => {
    res.writeHead(200, { 'Content-Length': String(Buffer.byteLength(responseBody)) });
    res.write(responseBody.slice(0, 35000));
    setTimeout(() => {
      if (!res.destroyed) res.end(responseBody.slice(35000));
    }, 10);
  });

  try {
    const p = seed(t);
    const r = await cli(p, ['trace', 'export', '--otlp-http', '--json', p.dir], {
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.url },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.reason, 'bad-response');
    assert.equal(parsed.httpStatus, 200);
    assert.equal(parsed.sent, 1);
    assert.equal(receiver.requests.length, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /response_body_canary/);
  } finally {
    await receiver.close();
  }
});

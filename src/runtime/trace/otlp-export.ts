'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `trace export --otlp-http` (091 IC-006, IC-007, IC-009): resolves OTLP environment,
 * maps spans through `otlp-map.ts`, and POSTs OTLP/HTTP JSON requests bounded to 20 requests.
 *
 * Privacy and secrecy: never prints, logs, or stores endpoints, headers, or response bodies.
 * Errors name variables and HTTP status codes only.
 */

const nodeFs = require('node:fs');
const { TextEncoder, TextDecoder } = require('node:util');
const path = require('node:path');
const { projectSpans } = require('./spans.ts');
const otlpMap = require('./otlp-map.ts');
const { finish } = require('./render.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const RUN_ARG = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._:-]+){0,2}$/;
const cmp = (a: any, b: any): number => (a < b ? -1 : a > b ? 1 : 0);

/** Object keys sorted at every level, ensuring deterministic JSON output. */
function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(cmp)
        .map((k) => [k, sorted(value[k])])
    );
  }
  return value;
}

/**
 * Resolves OTLP environment variables per IC-006:
 * - empty values after trimming count as unset; non-empty TRACES_* values override base values
 * - endpoint: traces endpoint as-is (fragments rejected), else base endpoint with /v1/traces
 *   appended to its pathname while preserving its query; fragments are rejected
 * - headers: comma-separated k=v pairs, percent-decoded; empty members are skipped and names
 *   and decoded values are validated
 * - timeout: integer ms, default 10000 and max 30000
 *
 * Errors name the variable only, never echoing the value.
 */
function resolveOtlpEnv(env: Record<string, string | undefined> = process.env): {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs: number;
} {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;

  let endpoint = '';

  if (tracesEndpoint !== undefined && tracesEndpoint.trim() !== '') {
    const endpointVar = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';
    const raw = tracesEndpoint.trim();
    let u: any;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`${endpointVar} is invalid URL`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`${endpointVar} must use http or https scheme`);
    }
    if (u.username || u.password) {
      throw new Error(`${endpointVar} must not contain user info`);
    }
    if (u.hash !== '' || raw.includes('#')) {
      throw new Error(`${endpointVar} must not contain a fragment`);
    }
    endpoint = u.href;
  } else if (baseEndpoint !== undefined && baseEndpoint.trim() !== '') {
    const endpointVar = 'OTEL_EXPORTER_OTLP_ENDPOINT';
    const raw = baseEndpoint.trim();
    let u: any;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`${endpointVar} is invalid URL`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`${endpointVar} must use http or https scheme`);
    }
    if (u.username || u.password) {
      throw new Error(`${endpointVar} must not contain user info`);
    }
    if (u.hash !== '' || raw.includes('#')) {
      throw new Error(`${endpointVar} must not contain a fragment`);
    }
    u.pathname = u.pathname.replace(/\/+$/, '') + '/v1/traces';
    endpoint = u.href;
  } else {
    throw new Error('missing endpoint: set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT');
  }

  const tracesHeaders = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  const baseHeaders = env.OTEL_EXPORTER_OTLP_HEADERS;
  const headers: Record<string, string> = {};
  const useTracesHeaders = tracesHeaders !== undefined && tracesHeaders.trim() !== '';
  const useBaseHeaders = baseHeaders !== undefined && baseHeaders.trim() !== '';

  if (useTracesHeaders || useBaseHeaders) {
    const isTraces = useTracesHeaders;
    const headerVar = isTraces ? 'OTEL_EXPORTER_OTLP_TRACES_HEADERS' : 'OTEL_EXPORTER_OTLP_HEADERS';
    const raw = (isTraces ? tracesHeaders : baseHeaders) ?? '';
    const pairs = raw.split(',');
    for (const pair of pairs) {
      if (pair.trim() === '') continue;
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) {
        throw new Error(`${headerVar} missing '='`);
      }
      const key = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (!key) {
        throw new Error(`${headerVar} has empty key`);
      }
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) {
        throw new Error(`${headerVar} has invalid header name`);
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(val);
      } catch {
        throw new Error(`${headerVar} has bad escape sequence`);
      }
      if (/[\r\n\0]/.test(decoded)) {
        throw new Error(`${headerVar} has invalid header value`);
      }
      headers[key] = decoded;
    }
  }

  const tracesTimeout = env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT;
  const baseTimeout = env.OTEL_EXPORTER_OTLP_TIMEOUT;
  let timeoutMs = 10000;
  const useTracesTimeout = tracesTimeout !== undefined && tracesTimeout.trim() !== '';
  const useBaseTimeout = baseTimeout !== undefined && baseTimeout.trim() !== '';

  if (useTracesTimeout || useBaseTimeout) {
    const isTraces = useTracesTimeout;
    const timeoutVar = isTraces ? 'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT' : 'OTEL_EXPORTER_OTLP_TIMEOUT';
    const raw = String(isTraces ? tracesTimeout : baseTimeout).trim();
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${timeoutVar} must be a positive integer`);
    }
    const ms = Number(raw);
    if (!Number.isSafeInteger(ms) || ms < 1) {
      throw new Error(`${timeoutVar} must be a positive integer`);
    }
    timeoutMs = ms > 30000 ? 30000 : ms;
  }

  return { endpoint, headers, timeoutMs };
}

const MAX_RESPONSE_BODY_BYTES = 65536;
const RESPONSE_BODY_TOO_LARGE = 'OTLP_RESPONSE_BODY_TOO_LARGE';

/** Reads only a bounded response body, never retaining data over the limit. */
async function readResponseText(res: any): Promise<string> {
  const encoder = new TextEncoder();
  if (res.body !== undefined && res.body !== null) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = typeof value === 'string' ? encoder.encode(value) : value;
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The body is already known to exceed the cap.
        }
        const err: any = new Error();
        err.code = RESPONSE_BODY_TOO_LARGE;
        throw err;
      }
      chunks.push(chunk);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  const text = await res.text();
  const bytes = encoder.encode(text);
  if (bytes.byteLength > MAX_RESPONSE_BODY_BYTES) {
    const err: any = new Error();
    err.code = RESPONSE_BODY_TOO_LARGE;
    throw err;
  }
  return new TextDecoder().decode(bytes);
}

function responseReadFailureReason(err: any): 'timeout' | 'connection' | 'bad-response' {
  const chain: any[] = [];
  let current = err;
  for (let depth = 0; current && depth < 8; depth++) {
    chain.push(current);
    current = current.cause;
  }
  if (chain.some((item) => item.code === RESPONSE_BODY_TOO_LARGE)) return 'bad-response';
  if (chain.some((item) => item.name === 'TimeoutError' || item.name === 'AbortError')) return 'timeout';
  if (chain.some((item) => typeof item.message === 'string' && /timeout|timed out|aborted/i.test(item.message))) {
    return 'timeout';
  }
  // A rejected response-body read means the response was not received in full.
  return 'connection';
}

/**
 * Posts OTLP requests in order using global fetch (or fetchImpl).
 * Stops at first failure (timeout, connection, bad response, redirect, non-2xx),
 * caps each 2xx response body at 65536 bytes, and reads partialSuccess.rejectedSpans.
 */
async function sendRequests(
  requests: any[],
  {
    endpoint,
    headers = {},
    timeoutMs = 10000,
    fetchImpl = (globalThis as any).fetch,
  }: {
    endpoint: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    fetchImpl?: any;
  }
): Promise<{
  requests: number;
  sent: number;
  rejected: number;
  status: 'ok' | 'partial' | 'failed';
  httpStatus: number | null;
  reason: 'timeout' | 'connection' | 'http-status' | 'redirect' | 'bad-response' | null;
}> {
  if (requests.length === 0) {
    return {
      requests: 0,
      sent: 0,
      rejected: 0,
      status: 'ok',
      httpStatus: null,
      reason: null,
    };
  }

  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'content-type') {
      reqHeaders[k] = v;
    }
  }
  reqHeaders['Content-Type'] = 'application/json';

  let sent = 0;
  let rejected = 0;
  let hasPartial = false;
  let lastHttpStatus: number | null = null;
  const abortSignal = (globalThis as any).AbortSignal;

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    let res: any;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(req),
        redirect: 'error',
        signal: abortSignal ? abortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (err: any) {
      const isTimeout =
        err?.name === 'TimeoutError' ||
        err?.name === 'AbortError' ||
        err?.cause?.name === 'TimeoutError' ||
        (typeof err?.message === 'string' && /timeout/i.test(err.message)) ||
        (typeof err?.cause?.message === 'string' && /timeout/i.test(err.cause.message));
      if (isTimeout) {
        return {
          requests: requests.length,
          sent,
          rejected,
          status: 'failed',
          httpStatus: null,
          reason: 'timeout',
        };
      }

      const isRedirect =
        (typeof err?.message === 'string' && /redirect/i.test(err.message)) ||
        (typeof err?.cause?.message === 'string' && /redirect/i.test(err.cause.message));
      if (isRedirect) {
        return {
          requests: requests.length,
          sent,
          rejected,
          status: 'failed',
          httpStatus: null,
          reason: 'redirect',
        };
      }

      const code = err?.code || err?.cause?.code;
      const isConnection =
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'ECONNRESET' ||
        code === 'EHOSTUNREACH' ||
        code === 'EPIPE' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        (typeof err?.message === 'string' && /connect|fetch failed|network|econnrefused/i.test(err.message) && !isTimeout && !isRedirect);

      return {
        requests: requests.length,
        sent,
        rejected,
        status: 'failed',
        httpStatus: null,
        reason: isConnection ? 'connection' : 'bad-response',
      };
    }

    if (res.status >= 300 && res.status < 400) {
      return {
        requests: requests.length,
        sent,
        rejected,
        status: 'failed',
        httpStatus: res.status,
        reason: 'redirect',
      };
    }

    if (res.status < 200 || res.status >= 300) {
      return {
        requests: requests.length,
        sent,
        rejected,
        status: 'failed',
        httpStatus: res.status,
        reason: 'http-status',
      };
    }

    lastHttpStatus = res.status;
    sent += 1;

    try {
      const text = await readResponseText(res);
      if (text) {
        try {
          const body = JSON.parse(text);
          const rejectedSpans = Number(body?.partialSuccess?.rejectedSpans);
          if (Number.isSafeInteger(rejectedSpans) && rejectedSpans > 0) {
            rejected += rejectedSpans;
            hasPartial = true;
          }
        } catch {
          // unparseable body counts as accepted
        }
      }
    } catch (err: any) {
      return {
        requests: requests.length,
        sent,
        rejected,
        status: 'failed',
        httpStatus: res.status,
        reason: responseReadFailureReason(err),
      };
    }
  }

  return {
    requests: requests.length,
    sent,
    rejected,
    status: hasPartial || rejected > 0 ? 'partial' : 'ok',
    httpStatus: lastHttpStatus,
    reason: null,
  };
}

/**
 * Handler for `doflow trace export --otlp-http [--run <key|id>] [--json] [--dry-run] [-g] [<project>]`.
 * Exit 0 all accepted and zero rejected, 1 any failure or rejection, 2 usage.
 */
async function handleTraceExport({
  positional = [],
  run,
  json = false,
  global = false,
  dryRun = false,
  otlpHttp = false,
  env = process.env,
  fetchImpl = (globalThis as any).fetch,
  stdout,
  stderr,
  fsImpl = nodeFs,
  homeDir,
  registry: registryOption,
}: any = {}): Promise<number> {
  const writeOut = (str: string) => {
    if (stdout) {
      if (typeof stdout.write === 'function') {
        stdout.write(str.endsWith('\n') ? str : str + '\n');
      } else if (typeof stdout === 'function') {
        stdout(str);
      } else if (Array.isArray(stdout)) {
        stdout.push(str);
      }
    } else {
      console.log(str);
    }
  };

  const writeErr = (str: string) => {
    if (stderr) {
      if (typeof stderr.write === 'function') {
        stderr.write(str.endsWith('\n') ? str : str + '\n');
      } else if (typeof stderr === 'function') {
        stderr(str);
      } else if (Array.isArray(stderr)) {
        stderr.push(str);
      }
    } else {
      console.error(str);
    }
  };

  const usage = (detail: string) => {
    if (json) writeOut(JSON.stringify({ error: 'usage', detail }));
    else writeErr(`doflow trace export: ${detail}`);
    return finish(2);
  };

  if (!otlpHttp) return usage('usage: trace export requires --otlp-http');
  if (positional.length > 1) return usage('usage: trace export --otlp-http [--run <runKey|run>] [--json] [--dry-run] [-g] [<project>]');
  if (run !== undefined && run !== null && (typeof run !== 'string' || !RUN_ARG.test(run))) {
    return usage('--run expects a run key (<hash>/<run>/<lineage>) or a run id');
  }

  let envConfig: { endpoint: string; headers: Record<string, string>; timeoutMs: number } | null = null;
  if (!dryRun) {
    try {
      envConfig = resolveOtlpEnv(env);
    } catch (err: any) {
      return usage(err.message);
    }

    const tracesProtocol = typeof env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL === 'string'
      ? env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL.trim()
      : '';
    const baseProtocol = typeof env.OTEL_EXPORTER_OTLP_PROTOCOL === 'string'
      ? env.OTEL_EXPORTER_OTLP_PROTOCOL.trim()
      : '';
    const protocolVar = tracesProtocol !== ''
      ? 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL'
      : baseProtocol !== ''
        ? 'OTEL_EXPORTER_OTLP_PROTOCOL'
        : null;
    const protocol = tracesProtocol !== '' ? tracesProtocol : baseProtocol;
    if (protocolVar && protocol.toLowerCase() !== 'http/json') {
      writeErr(`doflow trace export: ${protocolVar} is not read: --otlp-http sends HTTP/JSON`);
    }
  }

  const projectRoot = global ? undefined : path.resolve(positional[0] || '.');
  const view = projectSpans({ projectRoot, run: run ?? null, global, env, fsImpl, ...(homeDir ? { homeDir } : {}) });

  let registry = registryOption;
  if (!registry) {
    try {
      registry = JSON.parse(nodeFs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'telemetry.json'), 'utf8'));
    } catch {
      registry = {};
    }
  }

  const lists = otlpMap.ownedLists();
  const { requests, skipped } = otlpMap.buildOtlpRequests(view, registry, { lists });

  if (requests.length > 20) {
    return usage('export exceeds limit of 20 requests (use --run to export a single run)');
  }

  if (dryRun) {
    writeOut(JSON.stringify(sorted(requests), null, 2));
    writeErr(`doflow trace export: dry run: ${requests.length} request(s), skipped: ${skipped.ungrouped} ungrouped, ${skipped.noStart} no-start`);
    return finish(0);
  }

  const sendResult = await sendRequests(requests, {
    endpoint: envConfig!.endpoint,
    headers: envConfig!.headers,
    timeoutMs: envConfig!.timeoutMs,
    fetchImpl,
  });

  const output = {
    requests: sendResult.requests,
    sent: sendResult.sent,
    rejected: sendResult.rejected,
    skipped: {
      ungrouped: skipped.ungrouped,
      noStart: skipped.noStart,
    },
    status: sendResult.status,
    httpStatus: sendResult.httpStatus,
    reason: sendResult.reason,
  };

  if (json) {
    writeOut(JSON.stringify(sorted(output), null, 2));
  } else {
    writeOut(
      `doflow trace export: ${output.status} (${output.sent}/${output.requests} requests sent, ${output.rejected} rejected, skipped: ${output.skipped.ungrouped} ungrouped, ${output.skipped.noStart} no-start${output.reason ? `, reason: ${output.reason}` : ''}${output.httpStatus !== null ? `, HTTP ${output.httpStatus}` : ''})`
    );
  }

  return finish(output.status === 'ok' && output.rejected === 0 ? 0 : 1);
}

module.exports = {
  resolveOtlpEnv,
  sendRequests,
  handleTraceExport,
};

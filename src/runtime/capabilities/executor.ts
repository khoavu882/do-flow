'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { validateLoopbackUrl } = require('./loopback.ts');
const { sanitizeCapabilityOutput } = require('./sanitizer.ts');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB

interface CapabilityInput {
  text?: string;
  filePath?: string;
  schema?: Record<string, any>;
  params?: Record<string, any>;
}

interface CapabilityExecutionOptions {
  timeoutMs?: number;
  deepCheck?: boolean;
  maxBufferBytes?: number;
  fetchImpl?: typeof fetch;
  execFileImpl?: any;
  fsImpl?: any;
}

interface CapabilityExecutionResult {
  ok: boolean;
  capabilityId: string;
  providerId: string | null;
  status: 'HEALTHY' | 'FALLBACK' | 'UNAVAILABLE' | 'ERROR';
  data: string | Record<string, any> | null;
  metrics?: {
    durationMs: number;
    bytesIn: number;
    bytesOut: number;
  };
  error?: string;
}

function extractPath(obj: any, pathStr?: string): any {
  if (!pathStr || !obj) return obj;
  const parts = pathStr.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function interpolateTemplate(template: any, input: any): any {
  if (typeof template === 'string') {
    return template
      .replaceAll('{text}', input.text ?? '')
      .replaceAll('{filePath}', input.filePath ?? '')
      .replaceAll('{inputPath}', input.inputPath ?? input.filePath ?? '');
  }
  if (Array.isArray(template)) {
    return template.map((item) => interpolateTemplate(item, input));
  }
  if (template !== null && typeof template === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(template)) {
      result[k] = interpolateTemplate(v, input);
    }
    return result;
  }
  return template;
}

class LocalCapabilityExecutor {
  fsImpl: any;
  fetchImpl: typeof fetch;
  execFileImpl: any;
  maxBufferBytes: number;

  constructor(options: { fsImpl?: any; fetchImpl?: typeof fetch; execFileImpl?: any; maxBufferBytes?: number } = {}) {
    this.fsImpl = options.fsImpl || require('node:fs');
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.execFileImpl = options.execFileImpl || execFileAsync;
    this.maxBufferBytes = options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES;
  }

  async execute(
    capabilityId: string,
    provider: any,
    input: CapabilityInput = {},
    options: CapabilityExecutionOptions = {}
  ): Promise<CapabilityExecutionResult> {
    const providerId = provider?.id || null;
    if (!provider) {
      return {
        ok: false,
        capabilityId,
        providerId: null,
        status: 'UNAVAILABLE',
        data: null,
        error: 'No provider specified for capability execution',
      };
    }

    const effectiveTimeout = Math.min(
      options.timeoutMs ?? provider.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );
    const maxBuffer = options.maxBufferBytes || this.maxBufferBytes;
    const fetchImpl = options.fetchImpl || this.fetchImpl;
    const execFileImpl = options.execFileImpl || this.execFileImpl;

    if (provider.kind === 'http') {
      return await this.executeHttp(capabilityId, provider, input, {
        effectiveTimeout,
        maxBuffer,
        fetchImpl,
      });
    }

    if (provider.kind === 'cli') {
      return await this.executeCli(capabilityId, provider, input, {
        effectiveTimeout,
        maxBuffer,
        execFileImpl,
      });
    }

    return {
      ok: false,
      capabilityId,
      providerId,
      status: 'ERROR',
      data: null,
      error: `Unsupported provider kind '${provider.kind}'`,
    };
  }

  async executeHttp(
    capabilityId: string,
    provider: any,
    input: CapabilityInput,
    { effectiveTimeout, maxBuffer, fetchImpl }: any
  ): Promise<CapabilityExecutionResult> {
    const providerId = provider.id || null;
    const endpoint = provider.endpoint;

    const urlCheck = validateLoopbackUrl(endpoint);
    if (!urlCheck.ok) {
      return {
        ok: false,
        capabilityId,
        providerId,
        status: 'ERROR',
        data: null,
        error: urlCheck.reason,
      };
    }

    const method = provider.method || 'POST';
    const headers = {
      'Content-Type': 'application/json',
      ...(provider.headers || {}),
    };

    let bodyData: any = null;
    try {
      if (provider.requestTemplate) {
        bodyData = interpolateTemplate(provider.requestTemplate, input);
      } else {
        bodyData = {
          prompt: input.text,
          text: input.text,
          filePath: input.filePath,
          schema: input.schema,
          ...(input.params || {}),
        };
      }
    } catch (err: any) {
      return {
        ok: false,
        capabilityId,
        providerId,
        status: 'ERROR',
        data: null,
        error: `Request preparation error: ${err?.message || String(err)}`,
      };
    }

    const bodyStr = method !== 'GET' ? JSON.stringify(bodyData) : undefined;
    const bytesIn = bodyStr ? Buffer.byteLength(bodyStr, 'utf8') : 0;
    const started = Number(process.hrtime.bigint() / 1000000n);

    try {
      const res = await fetchImpl(endpoint, {
        method,
        headers,
        body: bodyStr,
        redirect: 'error',
        signal: AbortSignal.timeout(effectiveTimeout),
      });

      if (!res.ok) {
        return {
          ok: false,
          capabilityId,
          providerId,
          status: 'UNAVAILABLE',
          data: null,
          error: `HTTP error ${res.status}: ${res.statusText}`,
        };
      }

      const textOutput = await res.text();
      const bytesOut = Buffer.byteLength(textOutput, 'utf8');
      if (bytesOut > maxBuffer) {
        return {
          ok: false,
          capabilityId,
          providerId,
          status: 'ERROR',
          data: null,
          error: `Output exceeded buffer limit of ${maxBuffer} bytes`,
        };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(textOutput);
      } catch {
        parsed = textOutput;
      }

      const extracted = provider.responsePath ? extractPath(parsed, provider.responsePath) : parsed;
      const sanitized = sanitizeCapabilityOutput(extracted);

      if (sanitized.refused) {
        return {
          ok: false,
          capabilityId,
          providerId,
          status: 'ERROR',
          data: null,
          error: `DECISION_INJECTION_REFUSED: ${sanitized.refusalReason}`,
        };
      }

      const durationMs = Math.round(Number(process.hrtime.bigint() / 1000000n) - started);
      return {
        ok: true,
        capabilityId,
        providerId,
        status: 'HEALTHY',
        data: sanitized.data,
        metrics: {
          durationMs,
          bytesIn,
          bytesOut,
        },
      };
    } catch (err: any) {
      const durationMs = Math.round(Number(process.hrtime.bigint() / 1000000n) - started);
      const isUnavailable =
        err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' ||
        err.name === 'TimeoutError' ||
        err.name === 'AbortError' ||
        /fetch failed/i.test(err.message);
      return {
        ok: false,
        capabilityId,
        providerId,
        status: isUnavailable ? 'UNAVAILABLE' : 'ERROR',
        data: null,
        error: isUnavailable
          ? `Local server at ${endpoint} is not running (${err.message})`
          : err.message,
        metrics: {
          durationMs,
          bytesIn,
          bytesOut: 0,
        },
      };
    }
  }

  async executeCli(
    capabilityId: string,
    provider: any,
    input: CapabilityInput,
    { effectiveTimeout, maxBuffer, execFileImpl }: any
  ): Promise<CapabilityExecutionResult> {
    const providerId = provider.id || null;
    const binary = provider.binary || provider.program;
    if (!binary) {
      return {
        ok: false,
        capabilityId,
        providerId,
        status: 'ERROR',
        data: null,
        error: 'No program or binary specified for CLI provider',
      };
    }

    let args: string[] = [];
    if (provider.argvTemplate && Array.isArray(provider.argvTemplate)) {
      args = provider.argvTemplate.map((arg: string) =>
        arg
          .replaceAll('{filePath}', input.filePath || '')
          .replaceAll('{inputPath}', input.filePath || '')
          .replaceAll('{text}', input.text || '')
      );
    } else {
      if (input.filePath) args.push(input.filePath);
      else if (input.text) args.push(input.text);
    }

    const started = Number(process.hrtime.bigint() / 1000000n);
    const bytesIn = Buffer.byteLength(args.join(' '), 'utf8');

    try {
      let stdout: string;
      if (typeof execFileImpl === 'function' && execFileImpl.length === 4) {
        const cbAsync = promisify(execFileImpl);
        const res = await cbAsync(binary, args, {
          shell: false,
          timeout: effectiveTimeout,
          maxBuffer,
        });
        stdout = res.stdout;
      } else {
        const res = await execFileImpl(binary, args, {
          shell: false,
          timeout: effectiveTimeout,
          maxBuffer,
        });
        stdout = res.stdout !== undefined ? res.stdout : res;
      }

      const outStr = String(stdout || '');
      const bytesOut = Buffer.byteLength(outStr, 'utf8');
      if (bytesOut > maxBuffer) {
        return {
          ok: false,
          capabilityId,
          providerId,
          status: 'ERROR',
          data: null,
          error: `Output exceeded buffer limit of ${maxBuffer} bytes`,
        };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(outStr);
      } catch {
        parsed = outStr.trim();
      }

      const extracted = provider.responsePath ? extractPath(parsed, provider.responsePath) : parsed;
      const sanitized = sanitizeCapabilityOutput(extracted);

      if (sanitized.refused) {
        return {
          ok: false,
          capabilityId,
          providerId,
          status: 'ERROR',
          data: null,
          error: `DECISION_INJECTION_REFUSED: ${sanitized.refusalReason}`,
        };
      }

      const durationMs = Math.round(Number(process.hrtime.bigint() / 1000000n) - started);
      return {
        ok: true,
        capabilityId,
        providerId,
        status: 'HEALTHY',
        data: sanitized.data,
        metrics: {
          durationMs,
          bytesIn,
          bytesOut,
        },
      };
    } catch (err: any) {
      const durationMs = Math.round(Number(process.hrtime.bigint() / 1000000n) - started);
      const isUnavailable = err.code === 'ENOENT' || err.killed || err.signal === 'SIGTERM';
      return {
        ok: false,
        capabilityId,
        providerId,
        status: isUnavailable ? 'UNAVAILABLE' : 'ERROR',
        data: null,
        error: isUnavailable ? `Binary '${binary}' not available or timed out: ${err.message}` : err.message,
        metrics: {
          durationMs,
          bytesIn,
          bytesOut: 0,
        },
      };
    }
  }
}

async function probeHttpEndpoint(
  endpoint: string,
  options: { timeoutMs?: number; fetchImpl?: any } = {}
): Promise<{ ok: boolean; status?: number; durationMs: number; error?: string; isUnavailable?: boolean }> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const started = Number(process.hrtime.bigint() / 1000000n);

  try {
    const res = await fetchImpl(endpoint, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const durationMs = Math.round(Number(process.hrtime.bigint() / 1000000n) - started);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Math.round(Number(process.hrtime.bigint() / 1000000n) - started);
    const isUnavailable =
      err.code === 'ECONNREFUSED' ||
      err.code === 'ETIMEDOUT' ||
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      /fetch failed/i.test(err.message);
    return {
      ok: false,
      durationMs,
      error: err.message,
      isUnavailable,
    };
  }
}

module.exports = {
  LocalCapabilityExecutor,
  extractPath,
  interpolateTemplate,
  probeHttpEndpoint,
};

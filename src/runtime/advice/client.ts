'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { resolveSetting } = require('./config.ts');
const { loadSettings } = require('../settings/resolve.ts');
const { checkEndpoint } = require('./endpoint-guard.ts');
const { strengthOf } = require('./strength.ts');
const { validateQuestionSet, validateStaticAnswer } = require('./kinds.ts');
const { appendPick, appendMiss } = require('./record.ts');

// Keep this map literal: module reachability must be auditable without dynamic require paths.
const ADAPTERS: Record<string, any> = Object.freeze({
  'ollama-systemone': require('./providers/ollama-systemone.ts'),
});

function durationSince(startedAt: any) {
  return Math.max(0, Date.now() - startedAt);
}

function versionTuple(version: any) {
  const match = typeof version === 'string' && version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(version: any, minimum: any) {
  const actual = versionTuple(version);
  const required = versionTuple(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return true;
}

function networkReason(error: any) {
  return error?.code === 'ADVICE_TIMEOUT' || error?.code === 'ETIMEDOUT' || error?.code === 'ESOCKETTIMEDOUT'
    ? 'timeout' : 'unreachable';
}

function requestAction({ endpoint, action, pinnedLookup, timeoutMs, httpModule = http, httpsModule = https }: any) {
  return new Promise<any>((resolve, reject) => {
    let request: any;
    let settled = false;
    const finish = (error: any, response?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response);
    };
    const timer = setTimeout(() => {
      const error: any = new Error(`decision model request timed out after ${timeoutMs}ms`);
      error.code = 'ADVICE_TIMEOUT';
      request?.destroy(error);
      finish(error);
    }, timeoutMs);

    try {
      const url = new URL(endpoint);
      const transport = url.protocol === 'https:' ? httpsModule : httpModule;
      const prefix = url.pathname.replace(/\/+$/, '');
      const requestPath = `${prefix}${action.path}` || action.path;
      const body = action.body === undefined ? undefined : JSON.stringify(action.body);
      const options = {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port ? Number(url.port) : undefined,
        path: requestPath,
        method: action.method,
        agent: false,
        lookup: pinnedLookup,
        headers: body === undefined ? undefined : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      };
      request = transport.request(options, (response: any) => {
        const chunks: any[] = [];
        response.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
        response.on('error', (error: any) => finish(error));
        response.on('end', () => finish(null, {
          status: response.statusCode || 0,
          bodyText: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.on('error', (error: any) => finish(error));
      if (body === undefined) request.end();
      else request.end(body);
    } catch (error: any) {
      finish(error);
    }
  });
}

function emptyAdviceResult(status: any, reason: any, detail: any, setting: any, durationMs: any) {
  return {
    status, reason, detail: detail ?? null,
    provider: setting?.provider ?? null,
    model: setting?.model ?? null,
    endpoint: setting?.endpoint ?? null,
    decidedBy: setting?.decidedBy ?? { user: null, project: null },
    durationMs,
    answers: [],
  };
}

function createAdviceClient({
  adviceRegistry,
  roots,
  fsImpl = fs,
  lookup,
  httpModule = http,
  httpsModule = https,
  clock = () => new Date(),
}: any = {}) {
  /** `model`, when given, replaces the setting's model for this call: it is the model asked, recorded and reported. */
  async function ask({ questionSet, kind, staticAnswer, caller, taskId = null, record = true, model }: any = {}) {
    const startedAt = Date.now();
    let setting: any = null;
    const effectiveKind = typeof kind === 'string' && kind ? kind : 'adhoc';
    const shouldRecord = record !== false;

    function unavailable(reason: any, detail: any) {
      const durationMs = durationSince(startedAt);
      if (shouldRecord && setting?.state === 'on') {
        try { appendMiss({ roots, now: clock, fsImpl, kind: effectiveKind, caller, reason, model: setting.model, durationMs }); }
        catch { /* recording failure does not change an AdviceResult */ }
      }
      return emptyAdviceResult('unavailable', reason, detail, setting, durationMs);
    }

    try {
      setting = resolveSetting({ adviceRegistry, roots, fsImpl });
      if (setting.state !== 'on') {
        return emptyAdviceResult('off', setting.reason, setting.notes?.[0] || null, setting, durationSince(startedAt));
      }
      if (typeof model === 'string' && model.trim()) setting = { ...setting, model: model.trim() };

      const provider = adviceRegistry?.providers?.find((entry: any) => entry.id === setting.provider);
      const adapter = provider && ADAPTERS[provider.adapter];
      if (!provider || !adapter) return unavailable('config-invalid', `provider adapter '${provider?.adapter || setting.provider}' is unavailable`);

      if (effectiveKind !== 'adhoc') {
        const namedKind = adviceRegistry.kinds?.find((entry: any) => entry.id === effectiveKind);
        if (!namedKind || questionSet?.questions?.length !== 1 || questionSet.questions[0]?.name !== effectiveKind) {
          return unavailable('config-invalid', `question set does not match kind '${effectiveKind}'`);
        }
      }
      const questionValidation = validateQuestionSet(questionSet, { adviceRegistry });
      if (!questionValidation.ok) return unavailable('config-invalid', questionValidation.detail);
      if (staticAnswer !== undefined && staticAnswer !== null) {
        const staticValidation = validateStaticAnswer(questionSet.questions[0], staticAnswer);
        if (!staticValidation.ok) return unavailable('config-invalid', staticValidation.detail);
      }

      const stateBytes = Buffer.byteLength(questionSet.state, 'utf8');
      if (stateBytes > adviceRegistry.limits.maxStateBytes) {
        return unavailable('over-limit', `state is ${stateBytes} bytes; the limit is ${adviceRegistry.limits.maxStateBytes} (core/registry/advice.json limits.maxStateBytes)`);
      }
      const request = adapter.buildRequest(questionSet, { model: setting.model });
      const bodyText = JSON.stringify(request.body);
      const bodyBytes = Buffer.byteLength(bodyText, 'utf8');
      if (bodyBytes > adviceRegistry.limits.maxBodyBytes) {
        return unavailable('over-limit', `request body is ${bodyBytes} bytes; the limit is ${adviceRegistry.limits.maxBodyBytes} (core/registry/advice.json limits.maxBodyBytes)`);
      }

      const endpointCheck = await checkEndpoint(setting.endpoint, {
        lookup,
        file: setting.decidedBy?.user || 'provider default',
        timeoutMs: Math.max(0, adviceRegistry.timeoutMs - durationSince(startedAt)),
      });
      if (!endpointCheck.ok) return unavailable(endpointCheck.reason || 'non-loopback', endpointCheck.message);
      const remainingMs = adviceRegistry.timeoutMs - durationSince(startedAt);
      if (remainingMs <= 0) return unavailable('timeout', 'decision model request budget exhausted');

      let response;
      try {
        response = await requestAction({
          endpoint: setting.endpoint,
          action: request,
          pinnedLookup: endpointCheck.pinnedLookup,
          timeoutMs: remainingMs,
          httpModule,
          httpsModule,
        });
      } catch (error: any) {
        const reason = networkReason(error);
        return unavailable(reason, error.message);
      }

      let parsed;
      try { parsed = adapter.parseReply(response.status, response.bodyText, questionSet); }
      catch (error: any) { return unavailable('malformed-reply', error.message); }
      if (!parsed?.ok) return unavailable(parsed?.reason || 'malformed-reply', parsed?.detail || 'reply could not be parsed');

      const answers = parsed.answers.map((answer: any, index: any) => {
        const strength = strengthOf(answer, adviceRegistry.strength);
        const answerStatic = questionSet.questions.length === 1 ? staticAnswer ?? null : null;
        const result: any = {
          name: answer.name,
          kind: effectiveKind,
          type: answer.type,
          pick: answer.pick,
          strength,
          probabilities: answer.probabilities,
          confidence: answer.confidence ?? null,
          staticAnswer: answerStatic,
          agrees: answerStatic === null ? null : answer.pick === answerStatic,
          pickId: null,
        };
        if (answer.type === 'score') {
          result.pickIndex = answer.pickIndex;
          result.score = answer.score;
          result.criteria = answer.criteria;
        }
        if (shouldRecord) {
          const written = appendPick({
            roots, now: clock, fsImpl, kind: effectiveKind,
            answer: { ...answer, strength },
            question: questionSet.questions[index],
            staticAnswer: answerStatic,
            provider: setting.provider,
            model: setting.model,
            state: questionSet.state,
            caller,
            taskId,
            durationMs: durationSince(startedAt),
          });
          if (written) result.pickId = written.pickId;
        }
        return result;
      });
      return {
        status: 'answered', reason: null, detail: null,
        provider: setting.provider, model: setting.model, endpoint: setting.endpoint,
        decidedBy: setting.decidedBy, durationMs: durationSince(startedAt), answers,
      };
    } catch (error: any) {
      return unavailable('config-invalid', error?.message || 'advice request failed');
    }
  }

  async function inspect({ endpoint, model, provider: providerId, file, minVersion, timeoutMs }: any = {}) {
    const unavailable = (state: any, message: any, version: any = null, versionOk = false) => ({
      endpoint: { state, version, versionOk, message: message ?? null },
      models: [],
      model: { installed: false, decisionCapable: false },
    });
    try {
      const effectiveProviderId = providerId
        ?? resolveSetting({ adviceRegistry, roots, fsImpl }).provider
        ?? loadSettings({ global: true, env: {}, fsImpl }).get('advice.provider', 'global').value;
      const provider = adviceRegistry?.providers?.find((entry: any) => entry.id === effectiveProviderId);
      const adapter = provider && ADAPTERS[provider.adapter];
      if (!provider || !adapter) return unavailable('refused', `provider '${effectiveProviderId}' is unavailable`);
      const probeLimit = Number.isFinite(timeoutMs) ? timeoutMs : adviceRegistry.probeTimeoutMs;
      const budgetMs = Number.isFinite(adviceRegistry.doctorBudgetMs) ? adviceRegistry.doctorBudgetMs : probeLimit * 4;
      const startedAt = Date.now();
      const remaining = () => Math.max(0, budgetMs - (Date.now() - startedAt));
      const endpointCheck = await checkEndpoint(endpoint, { lookup, file, timeoutMs: remaining() });
      if (!endpointCheck.ok) return unavailable(endpointCheck.reason === 'timeout' ? 'unreachable' : 'refused', endpointCheck.message);
      const requestProbe = (action: any) => {
        const left = remaining();
        if (left <= 0) throw Object.assign(new Error('decision model probe budget exhausted'), { code: 'ADVICE_TIMEOUT' });
        return requestAction({
          endpoint, action, pinnedLookup: endpointCheck.pinnedLookup,
          timeoutMs: Math.min(probeLimit, left), httpModule, httpsModule,
        });
      };

      let versionResponse;
      try { versionResponse = await requestProbe(adapter.versionRequest()); }
      catch (error: any) { return unavailable('unreachable', error.message); }
      const version = adapter.parseVersion(versionResponse.status, versionResponse.bodyText)?.version ?? null;
      const minimum = minVersion || provider.minVersion;
      const versionOk = version ? versionAtLeast(version, minimum) : false;
      const endpointResult = {
        state: 'reached',
        version,
        versionOk,
        message: version ? null : `Ollama version endpoint returned HTTP ${versionResponse.status}`,
      };

      let models = [];
      try {
        const listResponse = await requestProbe(adapter.listRequest());
        models = adapter.parseList(listResponse.status, listResponse.bodyText);
      } catch {
        return { endpoint: endpointResult, models, model: { installed: false, decisionCapable: false } };
      }

      const configuredIndex = models.findIndex((entry: any) => adapter.modelMatches(model, entry.name));
      const fallbackIndexes = models.map((entry: any, index: any) => index)
        .filter((index: any) => !Array.isArray(models[index].capabilities));
      if (configuredIndex >= 0 && fallbackIndexes.includes(configuredIndex)) {
        fallbackIndexes.splice(fallbackIndexes.indexOf(configuredIndex), 1);
        fallbackIndexes.unshift(configuredIndex);
      }
      for (const index of fallbackIndexes.slice(0, 8)) {
        try {
          const showResponse = await requestProbe(adapter.showRequest(models[index].name));
          const shown = adapter.parseShow(showResponse.status, showResponse.bodyText);
          if (shown) models[index] = { ...models[index], capabilities: shown.capabilities };
        } catch {
          // Keep capabilities unknown when the read-only fallback is unavailable.
        }
      }
      const match = models.find((entry: any) => adapter.modelMatches(model, entry.name));
      return {
        endpoint: endpointResult,
        models,
        model: {
          installed: Boolean(match),
          decisionCapable: Boolean(match?.capabilities?.includes(provider.capability)),
        },
      };
    } catch (error: any) {
      return unavailable('unreachable', error?.message || 'decision model inspection failed');
    }
  }

  return { ask, inspect };
}

module.exports = { createAdviceClient, versionAtLeast };

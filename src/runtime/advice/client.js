'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { resolveSetting } = require('./config.ts');
const { checkEndpoint } = require('./endpoint-guard.ts');
const { strengthOf } = require('./strength.ts');
const { validateQuestionSet, validateStaticAnswer } = require('./kinds.ts');
const { appendPick, appendMiss } = require('./record');

// Keep this map literal: module reachability must be auditable without dynamic require paths.
const ADAPTERS = Object.freeze({
  'ollama-systemone': require('./providers/ollama-systemone.ts'),
});

function durationSince(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function versionTuple(version) {
  const match = typeof version === 'string' && version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(version, minimum) {
  const actual = versionTuple(version);
  const required = versionTuple(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return true;
}

function networkReason(error) {
  return error?.code === 'ADVICE_TIMEOUT' || error?.code === 'ETIMEDOUT' || error?.code === 'ESOCKETTIMEDOUT'
    ? 'timeout' : 'unreachable';
}

function requestAction({ endpoint, action, pinnedLookup, timeoutMs, httpModule = http, httpsModule = https }) {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response);
    };
    const timer = setTimeout(() => {
      const error = new Error(`decision model request timed out after ${timeoutMs}ms`);
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
      request = transport.request(options, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('error', (error) => finish(error));
        response.on('end', () => finish(null, {
          status: response.statusCode || 0,
          bodyText: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.on('error', (error) => finish(error));
      if (body === undefined) request.end();
      else request.end(body);
    } catch (error) {
      finish(error);
    }
  });
}

function emptyAdviceResult(status, reason, detail, setting, durationMs) {
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
} = {}) {
  async function ask({ questionSet, kind, staticAnswer, caller, taskId = null, record = true } = {}) {
    const startedAt = Date.now();
    let setting = null;
    const effectiveKind = typeof kind === 'string' && kind ? kind : 'adhoc';
    const shouldRecord = record !== false;

    function unavailable(reason, detail) {
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

      const provider = adviceRegistry?.providers?.find((entry) => entry.id === setting.provider);
      const adapter = provider && ADAPTERS[provider.adapter];
      if (!provider || !adapter) return unavailable('config-invalid', `provider adapter '${provider?.adapter || setting.provider}' is unavailable`);

      if (effectiveKind !== 'adhoc') {
        const namedKind = adviceRegistry.kinds?.find((entry) => entry.id === effectiveKind);
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
      } catch (error) {
        const reason = networkReason(error);
        return unavailable(reason, error.message);
      }

      let parsed;
      try { parsed = adapter.parseReply(response.status, response.bodyText, questionSet); }
      catch (error) { return unavailable('malformed-reply', error.message); }
      if (!parsed?.ok) return unavailable(parsed?.reason || 'malformed-reply', parsed?.detail || 'reply could not be parsed');

      const answers = parsed.answers.map((answer, index) => {
        const strength = strengthOf(answer, adviceRegistry.strength);
        const answerStatic = questionSet.questions.length === 1 ? staticAnswer ?? null : null;
        const result = {
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
    } catch (error) {
      return unavailable('config-invalid', error?.message || 'advice request failed');
    }
  }

  async function inspect({ endpoint, model, provider: providerId = 'ollama', file, minVersion, timeoutMs } = {}) {
    const unavailable = (state, message, version = null, versionOk = false) => ({
      endpoint: { state, version, versionOk, message: message ?? null },
      models: [],
      model: { installed: false, decisionCapable: false },
    });
    try {
      const provider = adviceRegistry?.providers?.find((entry) => entry.id === providerId);
      const adapter = provider && ADAPTERS[provider.adapter];
      if (!provider || !adapter) return unavailable('refused', `provider '${providerId}' is unavailable`);
      const probeLimit = Number.isFinite(timeoutMs) ? timeoutMs : adviceRegistry.probeTimeoutMs;
      const budgetMs = Number.isFinite(adviceRegistry.doctorBudgetMs) ? adviceRegistry.doctorBudgetMs : probeLimit * 4;
      const startedAt = Date.now();
      const remaining = () => Math.max(0, budgetMs - (Date.now() - startedAt));
      const endpointCheck = await checkEndpoint(endpoint, { lookup, file, timeoutMs: remaining() });
      if (!endpointCheck.ok) return unavailable(endpointCheck.reason === 'timeout' ? 'unreachable' : 'refused', endpointCheck.message);
      const requestProbe = (action) => {
        const left = remaining();
        if (left <= 0) throw Object.assign(new Error('decision model probe budget exhausted'), { code: 'ADVICE_TIMEOUT' });
        return requestAction({
          endpoint, action, pinnedLookup: endpointCheck.pinnedLookup,
          timeoutMs: Math.min(probeLimit, left), httpModule, httpsModule,
        });
      };

      let versionResponse;
      try { versionResponse = await requestProbe(adapter.versionRequest()); }
      catch (error) { return unavailable('unreachable', error.message); }
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

      const configuredIndex = models.findIndex((entry) => adapter.modelMatches(model, entry.name));
      const fallbackIndexes = models.map((entry, index) => index)
        .filter((index) => !Array.isArray(models[index].capabilities));
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
      const match = models.find((entry) => adapter.modelMatches(model, entry.name));
      return {
        endpoint: endpointResult,
        models,
        model: {
          installed: Boolean(match),
          decisionCapable: Boolean(match?.capabilities?.includes(provider.capability)),
        },
      };
    } catch (error) {
      return unavailable('unreachable', error?.message || 'decision model inspection failed');
    }
  }

  return { ask, inspect };
}

module.exports = { createAdviceClient, versionAtLeast };

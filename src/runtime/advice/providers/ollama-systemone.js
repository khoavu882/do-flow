'use strict';

const SYSTEMONE_PATH = '/v1/systemone';
const VERSION_PATH = '/api/version';
const TAGS_PATH = '/api/tags';
const SHOW_PATH = '/api/show';

function parseJson(bodyText) {
  if (typeof bodyText !== 'string') return null;
  try {
    const value = JSON.parse(bodyText);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function failure(reason, detail) {
  return { ok: false, reason, detail };
}

function buildRequest(questionSet, { model } = {}) {
  const questions = Object.fromEntries(questionSet.questions.map((question) => {
    if (question.type === 'choice') {
      return [question.name, {
        type: 'choice',
        instructions: question.instructions,
        criteria: question.options,
      }];
    }
    if (question.type === 'score') {
      return [question.name, {
        type: 'score',
        instructions: question.instructions,
        criteria: question.criteria,
      }];
    }
    return [question.name, {
      type: 'noul',
      instructions: question.instructions,
      criteria: { false: question.no, true: question.yes },
    }];
  }));
  return {
    method: 'POST',
    path: SYSTEMONE_PATH,
    body: { model, state: questionSet.state, questions },
  };
}

const SCORE_TOLERANCE = 1e-6;

function inUnit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseScore(question, value) {
  const bad = (detail) => failure('malformed-reply', detail);
  const { criteria, name } = question;
  const last = criteria.length - 1;
  if (value.type !== 'score') return bad(`answer for ${name} is not a score`);
  const keys = criteria.map((criterion, index) => String(index));
  const exact = (object) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
  if (!exact(value.legend) || keys.some((key, index) => value.legend[key] !== criteria[index])) {
    return bad(`legend for ${name} does not match its criteria`);
  }
  if (!exact(value.probabilities)) return bad(`probabilities for ${name} do not match its criteria`);
  if (keys.some((key) => !inUnit(value.probabilities[key]))) return bad(`probability for ${name} is not a number from 0 to 1`);
  if (!inUnit(value.confidence)) return bad(`confidence for ${name} is not a number from 0 to 1`);
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > last) {
    return bad(`score for ${name} is outside 0 to ${last}`);
  }
  const sum = keys.reduce((total, key) => total + value.probabilities[key], 0);
  if (Math.abs(sum - 1) > SCORE_TOLERANCE) return bad(`probabilities for ${name} do not sum to 1`);
  const weighted = keys.reduce((total, key, index) => total + index * value.probabilities[key], 0);
  if (Math.abs(weighted - value.score) > SCORE_TOLERANCE) return bad(`score for ${name} does not match its probabilities`);
  let pickIndex = 0;
  keys.forEach((key, index) => { if (value.probabilities[key] > value.probabilities[String(pickIndex)]) pickIndex = index; });
  const probabilities = Object.fromEntries(keys.map((key) => [key, value.probabilities[key]]));
  return {
    ok: true,
    answer: {
      name, type: 'score', pick: criteria[pickIndex], pickIndex, score: value.score,
      criteria: [...criteria], probabilities, confidence: value.confidence,
    },
  };
}

function parseReply(status, bodyText, questionSet) {
  if (status === 400) {
    const parsed = parseJson(bodyText);
    return failure('endpoint-rejected', typeof parsed?.error === 'string' ? parsed.error : 'Ollama rejected the request');
  }
  if (status === 404) {
    const parsed = parseJson(bodyText);
    if (typeof parsed?.error === 'string' && parsed.error) return failure('model-missing', parsed.error);
    return failure('endpoint-missing', 'decision endpoint is missing');
  }
  if (status === 413) return failure('over-limit', 'request exceeds the server limit');
  if (status >= 300 && status < 400) return failure('endpoint-rejected', `Ollama returned HTTP ${status}`);
  if (status !== 200) return failure('server-error', `Ollama returned HTTP ${status}`);

  const parsed = parseJson(bodyText);
  if (!parsed || !parsed.answers || typeof parsed.answers !== 'object' || Array.isArray(parsed.answers)) {
    return failure('malformed-reply', 'reply has no answers object');
  }

  const answers = [];
  for (const question of questionSet.questions) {
    const value = parsed.answers[question.name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return failure('malformed-reply', `answer missing for question ${question.name}`);
    }
    if (question.type === 'choice') {
      const options = Object.keys(question.options);
      if (typeof value.choice !== 'string' || !options.includes(value.choice)) {
        return failure('malformed-reply', `choice for question ${question.name} is outside its options`);
      }
      const probabilities = value.probabilities;
      if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
        return failure('malformed-reply', `probabilities for ${question.name} are missing`);
      }
      for (const option of options) {
        if (typeof probabilities[option] !== 'number' || !Number.isFinite(probabilities[option])
          || probabilities[option] < 0 || probabilities[option] > 1) {
          return failure('malformed-reply', `probability for ${question.name}.${option} is not a number from 0 to 1`);
        }
      }
      if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)
        || value.confidence < 0 || value.confidence > 1) {
        return failure('malformed-reply', `confidence for ${question.name} is not a number from 0 to 1`);
      }
      answers.push({ name: question.name, type: 'choice', pick: value.choice, probabilities, confidence: value.confidence });
    } else if (question.type === 'score') {
      const scored = parseScore(question, value);
      if (!scored.ok) return scored;
      answers.push(scored.answer);
    } else {
      const probability = value.noul;
      if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        return failure('malformed-reply', `noul for ${question.name} is not a probability from 0 to 1`);
      }
      answers.push({
        name: question.name,
        type: 'yesno',
        pick: probability >= 0.5 ? 'yes' : 'no',
        probabilities: { no: 1 - probability, yes: probability },
        confidence: null,
      });
    }
  }
  return { ok: true, answers };
}

function versionRequest() {
  return { method: 'GET', path: VERSION_PATH };
}

function parseVersion(status, bodyText) {
  const parsed = status === 200 ? parseJson(bodyText) : null;
  return typeof parsed?.version === 'string' && parsed.version.trim() ? { version: parsed.version.trim() } : null;
}

function listRequest() {
  return { method: 'GET', path: TAGS_PATH };
}

function parseList(status, bodyText) {
  const parsed = status === 200 ? parseJson(bodyText) : null;
  if (!Array.isArray(parsed?.models)) return [];
  return parsed.models
    .filter((model) => model && typeof model.name === 'string' && model.name.trim())
    .map((model) => ({
      name: model.name,
      capabilities: Array.isArray(model.capabilities) && model.capabilities.every((capability) => typeof capability === 'string')
        ? model.capabilities : null,
    }));
}

function showRequest(name) {
  return { method: 'POST', path: SHOW_PATH, body: { model: name } };
}

function parseShow(status, bodyText) {
  const parsed = status === 200 ? parseJson(bodyText) : null;
  return Array.isArray(parsed?.capabilities) && parsed.capabilities.every((capability) => typeof capability === 'string')
    ? { capabilities: parsed.capabilities }
    : null;
}

/** A configured name without a tag also matches Ollama's listed `<name>:latest` form. */
function modelMatches(configured, listed) {
  return configured === listed || (typeof configured === 'string' && !configured.includes(':') && listed === `${configured}:latest`);
}

module.exports = {
  buildRequest,
  parseReply,
  versionRequest,
  parseVersion,
  listRequest,
  parseList,
  showRequest,
  parseShow,
  modelMatches,
};

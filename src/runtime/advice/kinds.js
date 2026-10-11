'use strict';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(detail, reason = 'config-invalid') {
  return { ok: false, reason, detail };
}

function optionCount(question) {
  if (question.type === 'score') return Array.isArray(question.criteria) ? question.criteria.length : 0;
  return question.type === 'choice' ? Object.keys(question.options || {}).length : 2;
}

function checkOptionRange(count, limits, owner) {
  if (!Number.isInteger(limits?.minOptions) || !Number.isInteger(limits?.maxOptions)) {
    return invalid(`${owner} cannot be built: invalid limits in core/registry/advice.json`);
  }
  if (count < limits.minOptions) {
    return invalid(`${owner} has ${count} options; minimum is ${limits.minOptions} (core/registry/advice.json limits.minOptions)`);
  }
  if (count > limits.maxOptions) {
    return invalid(`${owner} has ${count} options; maximum is ${limits.maxOptions} (core/registry/advice.json limits.maxOptions)`);
  }
  return null;
}

function criteriaFrom(source, sources) {
  let entries;
  if (source === 'workflows.classes') {
    const classes = sources?.workflows?.classes;
    if (!isObject(classes)) return null;
    entries = Object.entries(classes).map(([id, item]) => [id, item?.description]);
  } else if (source === 'verification.riskLevels') {
    const levels = sources?.verification?.riskLevels;
    if (!isObject(levels)) return null;
    entries = Object.entries(levels).map(([id, item]) => [id, item?.description]);
  } else {
    return null;
  }
  if (entries.some(([, description]) => typeof description !== 'string' || !description.trim())) return null;
  return Object.fromEntries(entries);
}

function materializeKind(kindId, { adviceRegistry, sources = {}, server } = {}) {
  const kinds = adviceRegistry?.kinds;
  if (!Array.isArray(kinds)) return invalid('kinds are missing from core/registry/advice.json');
  const kind = kinds.find((entry) => entry?.id === kindId);
  if (!kind) return invalid(`unknown kind '${kindId}'`, 'usage-error');

  const serverSource = kind.criteriaFrom === 'mcp.servers[].trigger';
  if (server !== undefined && !serverSource) return invalid('--server is valid only for mcp-need', 'usage-error');

  let question;
  if (serverSource) {
    if (typeof server !== 'string' || !server.trim()) return invalid('--server is required for mcp-need', 'usage-error');
    const servers = sources?.mcp?.servers;
    if (!Array.isArray(servers)) return invalid('mcp.servers is missing from core/registry/mcp.json');
    const match = servers.find((entry) => entry?.id === server);
    if (!match) return invalid(`server '${server}' is not present in core/registry/mcp.json`, 'usage-error');
    if (typeof match.trigger !== 'string' || !match.trigger.trim()) return invalid(`mcp.servers.${server}.trigger is missing`);
    question = { name: kind.id, type: 'yesno', instructions: match.trigger, no: kind.no, yes: kind.yes };
  } else if (kind.type === 'choice') {
    const options = Object.hasOwn(kind, 'criteria') ? kind.criteria : criteriaFrom(kind.criteriaFrom, sources);
    if (!isObject(options) || Object.values(options).some((value) => typeof value !== 'string' || !value.trim())) {
      return invalid(`criteria source for kind '${kind.id}' is unavailable or invalid`);
    }
    question = { name: kind.id, type: 'choice', instructions: kind.instructions, options };
  } else if (kind.type === 'yesno') {
    question = { name: kind.id, type: 'yesno', instructions: kind.instructions, no: kind.no, yes: kind.yes };
  } else {
    return invalid(`kind '${kind.id}' has an unsupported type`);
  }

  const rangeError = checkOptionRange(optionCount(question), adviceRegistry.limits, `kind '${kind.id}'`);
  if (rangeError) return rangeError;
  const validation = validateQuestionSet({ state: '', questions: [question] }, { adviceRegistry });
  if (!validation.ok) return invalid(`kind '${kind.id}': ${validation.detail}`);
  return { ok: true, kind: kind.id, question };
}

function validateQuestionSet(questionSet, { adviceRegistry } = {}) {
  const limits = adviceRegistry?.limits;
  if (!isObject(limits)) return invalid('limits are missing from core/registry/advice.json');
  if (!isObject(questionSet)) return invalid('question set must be an object (core/registry/advice.json limits.minQuestions)');
  if (typeof questionSet.state !== 'string') return invalid('question set state must be a string (IC-005)');
  if (!Array.isArray(questionSet.questions)) return invalid('questions must be an array (core/registry/advice.json limits.minQuestions)');
  if (questionSet.questions.length < limits.minQuestions) {
    return invalid(`question count is below ${limits.minQuestions} (core/registry/advice.json limits.minQuestions)`);
  }
  if (questionSet.questions.length > limits.maxQuestions) {
    return invalid(`question count exceeds ${limits.maxQuestions} (core/registry/advice.json limits.maxQuestions)`);
  }

  let namePattern;
  try { namePattern = new RegExp(limits.questionName); } catch {
    return invalid('questionName does not compile (core/registry/advice.json limits.questionName)');
  }
  const names = new Set();
  for (const [index, question] of questionSet.questions.entries()) {
    const prefix = `questions[${index}]`;
    if (!isObject(question)) return invalid(`${prefix} must be an object (core/registry/advice.json limits.questionName)`);
    if (typeof question.name !== 'string' || !namePattern.test(question.name)) {
      return invalid(`${prefix}.name must match ${limits.questionName} (core/registry/advice.json limits.questionName)`);
    }
    if (names.has(question.name)) return invalid(`question names must be unique: '${question.name}' (core/registry/advice.json limits.questionName)`);
    names.add(question.name);
    if (typeof question.instructions !== 'string' || !question.instructions.trim()) {
      return invalid(`${prefix}.instructions must be a non-empty string (core/registry/advice.json)`);
    }
    if (question.type === 'choice') {
      if (!isObject(question.options)) return invalid(`${prefix}.options must be an object (core/registry/advice.json limits.minOptions)`);
      const count = Object.keys(question.options).length;
      const rangeError = checkOptionRange(count, limits, `${prefix}.options`);
      if (rangeError) return rangeError;
      if (Object.values(question.options).some((description) => typeof description !== 'string' || !description.trim())) {
        return invalid(`${prefix}.options values must be non-empty descriptions (core/registry/advice.json limits.minOptions)`);
      }
    } else if (question.type === 'yesno') {
      if (typeof question.no !== 'string' || !question.no.trim()) return invalid(`${prefix}.no is required (core/registry/advice.json limits.minOptions)`);
      if (typeof question.yes !== 'string' || !question.yes.trim()) return invalid(`${prefix}.yes is required (core/registry/advice.json limits.minOptions)`);
      const rangeError = checkOptionRange(2, limits, prefix);
      if (rangeError) return rangeError;
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria)) return invalid(`${prefix}.criteria must be an array of criterion strings (core/registry/advice.json limits.minOptions)`);
      const rangeError = checkOptionRange(question.criteria.length, limits, `${prefix}.criteria`);
      if (rangeError) return rangeError;
      if (question.criteria.some((criterion) => typeof criterion !== 'string' || !criterion.trim())) {
        return invalid(`${prefix}.criteria must be non-empty strings (core/registry/advice.json limits.minOptions)`);
      }
      if (new Set(question.criteria).size !== question.criteria.length) {
        return invalid(`${prefix}.criteria must be distinct (core/registry/advice.json limits.minOptions)`);
      }
    } else {
      return invalid(`${prefix}.type must be choice, yesno or score (core/registry/advice.json)`);
    }
  }
  return { ok: true, questionSet };
}

function validateStaticAnswer(question, value) {
  if (value === undefined || value === null) return { ok: true };
  const validOptions = question?.type === 'choice'
    ? Object.keys(question.options || {})
    : question?.type === 'yesno' ? ['no', 'yes']
      : question?.type === 'score' && Array.isArray(question.criteria) ? question.criteria : [];
  if (validOptions.includes(value)) return { ok: true };
  return invalid(`static answer must be one of: ${validOptions.join(', ')}`, 'usage-error');
}

module.exports = { materializeKind, validateQuestionSet, validateStaticAnswer };

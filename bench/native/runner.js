'use strict';

// Native sessions are launched by an operator/controller, never by the offline test suite.
// The host sees ordinary prompts and the installed skill catalog, not expectedSkills or checks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const corpus = require('./cases.json');
const root = path.resolve(__dirname, '../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function caseFor(id) {
  const item = corpus.cases.find(c => c.id === id);
  if (!item) throw new Error(`Unknown native case '${id}'`);
  return item;
}

function prepare({ id, harness, directory, model, hostVersion }) {
  const item = caseFor(id);
  if (!corpus.harnesses.includes(harness)) throw new Error('harness must be codex or claude');
  if (!model || !hostVersion) throw new Error('Record an explicit model and hostVersion');
  const runDir = path.resolve(directory);
  // Exclusive creation prevents a repeated preparation from overwriting measured work.
  fs.mkdirSync(runDir);
  const workspace = path.join(runDir, 'workspace');
  fs.mkdirSync(workspace);
  for (const [file, content] of Object.entries(item.files)) fs.writeFileSync(path.join(workspace, file), content);
  const sourceHashes = {};
  const skills = path.join(root, 'core/shared/skills');
  for (const name of fs.readdirSync(skills)) {
    const file = path.join(skills, name, 'SKILL.md');
    if (fs.existsSync(file)) sourceHashes[name] = hash(fs.readFileSync(file));
  }
  const plan = {
    version: 1, id, harness, model, hostVersion, workspace,
    corpusHash: hash(JSON.stringify(item)), sourceHashes,
    install: { executable: process.execPath, args: [path.join(root, 'bin/doflow.js'), 'install', workspace, '--force', '-t', harness] },
    messages: item.messages,
    restartBeforeMessage: item.restartBeforeMessage ?? null,
    checkpointFiles: item.checkpointFiles || [],
  };
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
  return plan;
}

function grade(directory) {
  const runDir = path.resolve(directory);
  const plan = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
  const item = caseFor(plan.id);
  if (plan.corpusHash !== hash(JSON.stringify(item))) throw new Error('Case changed since preparation; prepare a new run');
  const workspace = path.join(runDir, 'workspace');
  // Use the committed grader's program, never a command supplied by the measured agent.
  const check = spawnSync(process.execPath, ['-e', item.checks], {
    cwd: workspace, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  const taskSuccess = check.status === 0 && !check.error;
  const missing = [];
  let session = null;
  const file = path.join(runDir, 'session.json');
  if (fs.existsSync(file)) session = JSON.parse(fs.readFileSync(file, 'utf8'));
  const complete = session?.version === 1 && session.completed === true
    && session.harness === plan.harness && session.model === plan.model
    && session.hostVersion === plan.hostVersion && Array.isArray(session.events);
  if (!complete) missing.push('complete controller session record with matching host/model identity');
  const transcript = path.join(runDir, 'transcript.jsonl');
  if (!fs.existsSync(transcript) || !session?.transcriptSha256
      || hash(fs.readFileSync(transcript)) !== session.transcriptSha256) missing.push('matching raw host transcript');
  const events = complete ? session.events : [];
  const questions = events.filter(e => e.type === 'question').length;
  const userTurns = events.filter(e => e.type === 'user-message').length;
  if (userTurns < item.messages.length) missing.push('all scripted user messages');
  const skillReads = events.filter(e => e.type === 'skill-read');
  const routing = item.expectedSkills.every(skill => skillReads.some(e => e.skill === skill
    && e.sha256 === plan.sourceHashes[skill] && e.projected === true));
  if (!skillReads.length) missing.push('observed native skill reads and source hashes');
  const restart = item.restartBeforeMessage === undefined || events.some(e => e.type === 'restart'
    && e.previousProcess !== e.nextProcess && e.previousProcess && e.nextProcess
    && item.checkpointFiles.every(f => typeof e.checkpointHashes?.[f] === 'string'
      && e.checkpointHashes[f] === e.resumedHashes?.[f]));
  const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const metrics = {
    taskSuccess,
    routing: complete && skillReads.length ? routing : null,
    extraTurns: complete ? Math.max(0, userTurns - item.messages.length) : null,
    questions: complete ? questions : null,
    toolCalls: complete ? events.filter(e => e.type === 'tool-call').length : null,
    costUSD: nonnegative(session?.usage?.costUSD),
    inputTokens: nonnegative(session?.usage?.inputTokens),
    outputTokens: nonnegative(session?.usage?.outputTokens),
    durationMs: nonnegative(session?.usage?.durationMs),
  };
  return {
    id: plan.id, harness: plan.harness, model: plan.model, hostVersion: plan.hostVersion,
    status: missing.length ? 'INCONCLUSIVE' : taskSuccess && routing && restart
      && questions <= item.maxQuestions && metrics.extraTurns === 0 ? 'PASS' : 'FAIL',
    metrics, restartVerified: item.restartBeforeMessage === undefined ? null : restart,
    missing, verification: { exitCode: check.status, error: check.error?.message || null,
      output: `${check.stdout || ''}${check.stderr || ''}` },
  };
}

if (require.main === module) {
  try {
    const [action, ...args] = process.argv.slice(2);
    let result;
    if (action === 'list') result = corpus;
    else if (action === 'prepare') {
      const [id, harness, directory, model, hostVersion] = args;
      result = prepare({ id, harness, directory, model, hostVersion });
    } else if (action === 'grade') result = grade(args[0]);
    else throw new Error('Usage: runner.js list | prepare CASE HARNESS NEW_DIRECTORY MODEL HOST_VERSION | grade DIRECTORY');
    console.log(JSON.stringify(result, null, 2));
    if (action === 'grade' && result.status !== 'PASS') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}

module.exports = { corpus, prepare, grade };

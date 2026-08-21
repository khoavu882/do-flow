#!/usr/bin/env node
'use strict';

/**
 * DoFlow Stream Hook Runner for Antigravity & Gemini CLI.
 * Consumes Antigravity JSON stdin/stdout protocol:
 * Stdin: { toolCall: { name, args }, conversationId, workspacePaths, stepIdx }
 * Stdout: { decision: "allow" | "deny" | "ask" | "force_ask", reason?: string, overwrite?: object }
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDIT_TOOL_PATTERN = /^(replace_file_content|write_to_file|multi_replace_file_content|edit_file|Edit|Write)$/i;
const COMMAND_TOOL_PATTERN = /^(run_command|run_shell_command|Bash|bash)$/i;
const DESTRUCTIVE_COMMAND_PATTERN = /\brm\s+-rf\s+[\/~]/i;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

function resolveProjectRoot(workspacePaths) {
  if (Array.isArray(workspacePaths) && workspacePaths.length > 0 && fs.existsSync(workspacePaths[0])) {
    return workspacePaths[0];
  }
  let d = process.cwd();
  while (d !== path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git')) || fs.existsSync(path.join(d, '.doflow'))) {
      return d;
    }
    d = path.dirname(d);
  }
  return process.cwd();
}

function findGateScript(projectRoot, scriptName) {
  const candidates = [
    path.join(projectRoot, '.gemini/hooks', scriptName),
    path.join(projectRoot, '.claude/hooks', scriptName),
    path.join(projectRoot, '.codex/hooks', scriptName),
    path.join(projectRoot, '.doflow/scripts', scriptName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function checkPreImplementGate(projectRoot) {
  const gateScript = findGateScript(projectRoot, 'pre-implement-gate.sh');
  if (!gateScript) return null;

  try {
    execFileSync('bash', [gateScript], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DOFLOW_PROJECT_DIR: projectRoot },
    });
    return null;
  } catch (err) {
    const errorMsg = err.stderr ? err.stderr.toString().trim() : (err.stdout ? err.stdout.toString().trim() : '');
    return {
      decision: 'deny',
      reason: errorMsg || '[GATE-C BLOCKED] Implementation requires an approved plan.md. Please run /do-plan first.',
    };
  }
}

function checkPreBashGuard(toolArgs) {
  const cmd = toolArgs.CommandLine || toolArgs.command || '';
  if (DESTRUCTIVE_COMMAND_PATTERN.test(cmd)) {
    return {
      decision: 'deny',
      reason: '[SAFETY INVARIANT BLOCKED] Destructive command rejected by DoFlow pre-bash guard.',
    };
  }
  return null;
}

function evaluateToolCall(toolCall, projectRoot) {
  if (!toolCall || typeof toolCall !== 'object') {
    return { decision: 'allow' };
  }

  const toolName = toolCall.name || '';
  const toolArgs = toolCall.args || {};

  if (EDIT_TOOL_PATTERN.test(toolName)) {
    const gateDenial = checkPreImplementGate(projectRoot);
    if (gateDenial) return gateDenial;
  }

  if (COMMAND_TOOL_PATTERN.test(toolName)) {
    const bashDenial = checkPreBashGuard(toolArgs);
    if (bashDenial) return bashDenial;
  }

  return { decision: 'allow' };
}

function evaluatePayload(payload, projectRoot) {
  if (!payload || typeof payload !== 'object') {
    return { decision: 'allow' };
  }

  // PreToolUse: toolCall object present
  if (payload.toolCall) {
    return evaluateToolCall(payload.toolCall, projectRoot);
  }

  // PreInvocation: injection hook
  if (payload.invocationNum !== undefined) {
    return { injectSteps: [] };
  }

  // Stop hook: termination reason check
  if (payload.terminationReason) {
    return { decision: 'allow' };
  }

  // PostToolUse / PostInvocation: empty object response
  if (payload.stepIdx !== undefined || payload.terminationBehavior !== undefined) {
    return {};
  }

  return { decision: 'allow' };
}

async function main() {
  try {
    const rawInput = await readStdin();
    if (!rawInput || !rawInput.trim()) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawInput);
    } catch {
      process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
      return;
    }

    const projectRoot = resolveProjectRoot(payload.workspacePaths);
    const result = evaluatePayload(payload, projectRoot);

    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    process.stderr.write(`[stream-hook-runner error] ${err.message}\n`);
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { evaluateToolCall, evaluatePayload, resolveProjectRoot };

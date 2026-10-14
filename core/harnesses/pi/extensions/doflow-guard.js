import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// C.3's renderer replaces this relative source-tree path for each install scope.
const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);
const ROUTES = [
  { tools: ['edit', 'write'], policy: 'pre-implementation-gate' },
  { tools: ['bash'], policy: 'pre-bash-guard' },
];
const LIMIT = 1024 * 1024;
const TIMEOUT_MS = 5000;
const ERROR_REASON = (policy) => `[${policy}] DoFlow policy error; details: doflow-run failure list`;

function route(toolName) {
  for (const row of ROUTES) {
    if (row.tools.includes(toolName)) return row.policy;
  }
  return typeof toolName === 'string' && toolName.startsWith('mcp__') ? 'mcp-tool-guard' : undefined;
}

function captureFailure(policy, point) {
  const script = new URL('../policies/capture-failure.sh', BRIDGE);
  try {
    const child = spawn('bash', ['-c', '. "$1"; doflow_capture_failure "$2" "$3"', 'doflow-capture', fileURLToPath(script), policy, point], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Failure capture must never change Pi's tool-call decision.
  }
}

function bridgeCall(policy, payload, ctx) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const env = { ...process.env };
      delete env.DOFLOW_PROJECT_DIR;
      child = spawn('bash', [fileURLToPath(BRIDGE), 'pi', 'tool_call', policy], {
        cwd: ctx.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      reject(Object.assign(error, { failurePoint: 'bridge-spawn' }));
      return;
    }

    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let aborted = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    };
    const fail = (point) => {
      overflow = point === 'bridge-output-limit';
      kill();
      finish(Object.assign(new Error(point), { failurePoint: point }));
    };
    const onAbort = () => {
      aborted = true;
      kill();
      finish(null, undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => finish(Object.assign(error, { failurePoint: 'bridge-spawn' })));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > LIMIT) return fail('bridge-output-limit');
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > LIMIT) return fail('bridge-output-limit');
    });
    child.on('close', (code) => {
      if (settled) return;
      if (aborted) return finish(null, undefined);
      if (timedOut) return finish(Object.assign(new Error('bridge timed out'), { failurePoint: 'bridge-timeout' }));
      if (overflow) return finish(Object.assign(new Error('bridge output exceeded limit'), { failurePoint: 'bridge-output-limit' }));
      if (code !== 0) return finish(Object.assign(new Error(`bridge exited ${code}`), { failurePoint: 'bridge-spawn' }));
      const output = Buffer.concat(stdout).toString('utf8');
      if (!output.trim()) return finish(null, undefined);
      if (output.trim().split(/\r?\n/).length !== 1) {
        return finish(Object.assign(new Error('bridge answer must be one JSON line'), { failurePoint: 'bridge-spawn' }));
      }
      try {
        const answer = JSON.parse(output);
        if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.block !== true || typeof answer.reason !== 'string') {
          throw new Error('invalid bridge answer');
        }
        finish(null, { block: true, reason: answer.reason });
      } catch {
        finish(Object.assign(new Error('invalid bridge answer'), { failurePoint: 'bridge-spawn' }));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

export default function (pi) {
  pi.on('tool_call', async (event, ctx) => {
    let policy = 'unknown';
    try {
      policy = route(event.toolName);
      if (!policy) return undefined;
      if (!existsSync(BRIDGE)) {
        captureFailure(policy, 'bridge-missing');
        return { block: true, reason: '[doflow] shared hooks lack the bridge; run: doflow update -t pi' };
      }
      const payload = JSON.stringify({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId,
        input: event.input,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
      });
      if (Buffer.byteLength(payload) > LIMIT) throw Object.assign(new Error('bridge input exceeded limit'), { failurePoint: 'bridge-input-limit' });
      return await bridgeCall(policy, payload, ctx);
    } catch (error) {
      const point = error?.failurePoint || 'bridge-spawn';
      captureFailure(policy, point === 'bridge-timeout' || point === 'bridge-missing' ? point : 'bridge-spawn');
      if ((process.env.DOFLOW_FAULT_PROFILE || 'compat-1') === 'strict-1') return { block: true, reason: ERROR_REASON(policy) };
      return undefined;
    }
  });
}

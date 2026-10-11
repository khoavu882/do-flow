'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

function defaultResponse({ method, pathname, body }) {
  if (method === 'POST' && pathname === '/v1/systemone') {
    const answers = {};
    for (const [name, question] of Object.entries(body?.questions || {})) {
      if (question.type === 'choice') {
        const options = Object.keys(question.criteria || {});
        const probabilities = Object.fromEntries(options.map((option, index) => [option, index === 0 ? 0.85 : 0.15 / Math.max(1, options.length - 1)]));
        answers[name] = { choice: options[0], probabilities, confidence: 0.71 };
      } else {
        answers[name] = { noul: 0.7 };
      }
    }
    return { status: 200, body: { answers } };
  }
  if (method === 'GET' && pathname === '/api/version') return { status: 200, body: { version: '0.40.2' } };
  if (method === 'GET' && pathname === '/api/tags') return { status: 200, body: { models: [{ name: 'clef-flash:latest', capabilities: ['decision'] }] } };
  if (method === 'POST' && pathname === '/api/show') return { status: 200, body: { capabilities: ['decision'] } };
  return { status: 404, body: { error: 'not found' } };
}

async function writeResponse(response, res) {
  if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
  if (res.destroyed) return;
  const status = response.status ?? 200;
  const headers = { ...(response.headers || {}) };
  let payload;
  if (typeof response.body === 'string') payload = response.body;
  else if (response.body === undefined) payload = '';
  else {
    payload = JSON.stringify(response.body);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function createServer({ routes = {}, requests = [] } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      let body = null;
      if (chunks.length) {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { body = JSON.parse(raw); } catch { body = raw; }
      }
      const request = { method: req.method, pathname: new URL(req.url, 'http://127.0.0.1').pathname, headers: req.headers, body };
      requests.push(request);
      const key = `${request.method} ${request.pathname}`;
      let response = routes[key] ?? routes[request.pathname];
      if (typeof response === 'function') response = await response(request);
      if (response === undefined) response = defaultResponse(request);
      try { await writeResponse(response, res); } catch { if (!res.destroyed) res.destroy(); }
    });
  });
  return server;
}

function startFakeServer(options = {}) {
  const requests = [];
  const server = createServer({ ...options, requests });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve({
        server,
        requests,
        port: address.port,
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => {
          server.close((error) => error ? fail(error) : done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

async function spawnFakeServer({ routes = {}, dir, timeoutMs = 5000 } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('spawnFakeServer requires an absolute temp directory from test/helper/tmp.js');
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const routesFile = path.join(dir, `fake-routes-${suffix}.json`);
  const portFile = path.join(dir, `fake-port-${suffix}.txt`);
  fs.writeFileSync(routesFile, JSON.stringify(routes));
  const child = spawn(process.execPath, [__filename, '--child', portFile, routesFile], { stdio: 'ignore' });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(portFile)) {
      const port = Number(fs.readFileSync(portFile, 'utf8'));
      if (Number.isInteger(port) && port > 0) {
        return {
          child, port, origin: `http://127.0.0.1:${port}`,
          close: () => new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', resolve);
            if (!child.killed) child.kill('SIGTERM');
          }),
        };
      }
    }
    if (child.exitCode !== null) throw new Error(`fake decision server exited with code ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill('SIGTERM');
  throw new Error('fake decision server did not write its port in time');
}

async function runChild(portFile, routesFile) {
  const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
  const server = createServer({ routes });
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module && process.argv[2] === '--child') {
  runChild(process.argv[3], process.argv[4]).catch(() => process.exit(1));
}

module.exports = { startFakeServer, spawnFakeServer };

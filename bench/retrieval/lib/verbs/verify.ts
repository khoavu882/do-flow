'use strict';

/**
 * `retrieval verify` (074 IC-002): is the pinned commit present, does its manifest still match the
 * committed digest, are the pinned tool versions installed, and does this machine's Node/OS/arch
 * match. The other verbs call `verifySnapshot` before they measure anything.
 */

const fs = require('node:fs');
const path = require('node:path');
const snapshotLib = require('../snapshot.ts');
const environment = require('../environment.ts');

const flags = {};

/**
 * Runs the four IC-002 steps. Returns `{exitCode, message?, result}` where `result` is the IC-002
 * `--json` body (without the header). Exit 3 for a missing commit or manifest drift, 4 for tool
 * drift; the first step that fails with 3 stops the later manifest-dependent work.
 */
function verifySnapshot({ snapshotPath, repoRoot }: any) {
  const snapshot = snapshotLib.loadSnapshot(snapshotPath);
  const result = {
    commit: snapshot.commit,
    manifest: { expected: snapshot.manifestSha256, actual: null, ok: false, added: [], removed: [], changed: [] },
    tools: [],
    env: environment.compareEnv(snapshot),
  };

  if (!snapshotLib.commitExists(repoRoot, snapshot.commit)) {
    return { exitCode: 3, message: `pinned commit ${snapshot.commit} is absent (shallow clone or unfetched); fetch full history`, result, snapshot };
  }

  const actualEntries = snapshotLib.buildManifest(repoRoot, snapshot.commit, snapshot);
  result.manifest.actual = snapshotLib.manifestDigest(actualEntries);
  const manifestFile = path.resolve(repoRoot, snapshot.manifestPath);
  let committed = null;
  if (fs.existsSync(manifestFile)) committed = snapshotLib.loadManifest(manifestFile);
  const committedDigest = committed ? snapshotLib.manifestDigest(committed.entries) : null;
  const diff = snapshotLib.diffManifest(committed ? committed.entries : [], actualEntries);
  Object.assign(result.manifest, diff);
  result.manifest.ok = result.manifest.actual === snapshot.manifestSha256
    && committedDigest === snapshot.manifestSha256
    && committed.commit === snapshot.commit;

  result.tools = environment.compareTools(snapshot.tools);
  const toolDrift = result.tools.some((t: any) => !t.ok);

  const codes = [];
  const messages = [];
  if (!result.manifest.ok) {
    codes.push(3);
    messages.push(committed ? 'manifest does not match the pinned commit' : `manifest file is missing: ${snapshot.manifestPath}`);
  }
  if (toolDrift) {
    codes.push(4);
    for (const t of (result.tools.filter((x: any) => !x.ok) as any)) messages.push(`tool ${t.id}: pinned "${t.expected}", found "${t.actual}"`);
  }
  const exitCode = codes.includes(3) ? 3 : codes.includes(4) ? 4 : 0;
  return { exitCode, codes, message: messages.join('; ') || undefined, result, snapshot };
}

function run(ctx: any) {
  const out = verifySnapshot({ snapshotPath: ctx.snapshotPath, repoRoot: ctx.repoRoot });
  const lines = [];
  if (out.message) lines.push(`verify: ${out.message}`);
  const { manifest, tools, env } = out.result;
  lines.push(`manifest ${manifest.ok ? 'ok' : 'MISMATCH'}: expected ${manifest.expected}, actual ${manifest.actual}`);
  for (const t of (tools as any)) lines.push(`tool ${t.id}: ${t.ok ? 'ok' : 'DRIFT'} (${t.expected} -> ${t.actual})`);
  if (env.differs.length > 0) lines.push(`env differs (not a failure): ${env.differs.join(', ')}`);
  const body: any = { ...out.result };
  if (out.message && out.exitCode !== 0) body.error = out.message;
  return { exitCode: out.exitCode, codes: out.codes || [], lines, ...body };
}

module.exports = { flags, verifySnapshot, run };

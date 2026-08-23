'use strict';
// `doflow status` — resolved context plus installed state from the manifest, with per-harness
// lifecycle verification. Must stay usable even when the local registry is invalid (--json for
// scripting).
const path = require('node:path');
const { resolveTargets, toolDirs } = require('../../install/targets');
const { resolveContext, printContext } = require('../../install/context');
const { readManifest } = require('../../install/manifest');
const { sourceCommit } = require('../../helper/git');
const { loadRegistry } = require('../../registry');
const { readLedger } = require('../../state');
const { verifyLifecycle } = require('../../lifecycle');
const { registryLifecycleView, LIFECYCLE_HARNESSES } = require('../../lifecycle/view');
const { REPO_ROOT, SCRIPT_DIR, scopeOf } = require('../shared');

function cmdStatus(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const ctx = resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: sourceCommit(SCRIPT_DIR), ...scope });
  const manifest = readManifest(dirs.claude);
  let registryView = null;
  try {
    const registry = loadRegistry({ repoRoot: REPO_ROOT });
    registryView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets,
      mcpIds: manifest?.mcpServers ?? undefined });
    ctx.registry = {
      directory: registryView.registry.directory,
      versions: registryView.registry.versions,
      stateRoot: registryView.stateRoot,
      ledgerPresent: Boolean(readLedger(registryView.stateRoot)),
      plan: { changes: registryView.plan.changes.length, conflicts: registryView.plan.conflicts, prerequisites: registryView.plan.prerequisites },
    };
    // Per-harness status must derive from that harness's own plan target, not the flattened
    // registryView.plan.changes/conflicts across every target — otherwise, e.g., Codex having
    // pending changes when it isn't installed yet would make Claude's line falsely report
    // 'drift-or-pending-change' even though Claude itself has nothing pending.
    const harnessPlan = (harness) => registryView.plan.targets.find((target) => target.harness === harness);
    // Hook-wiring status needs the same general per-harness verification every install/update run
    // already flows through (src/lifecycle's verifyLifecycle) rather than a Codex-only hardcode:
    // it is the one place that can tell 'installed and active' apart from 'installed but pending a
    // prerequisite' (Codex's unreviewed trust, Gemini's live hook-trust check) from 'absent'.
    const verification = verifyLifecycle({ plan: registryView.plan, adapters: registryView.adapters, context: { registry } });
    const hooksFor = (harness) => verification.verifications.find((item) => item.harness === harness)?.hookWiring ?? null;
    const harnessStatus = (harness) => {
      const target = harnessPlan(harness);
      if (!target) return { status: 'verified', resources: [], errors: [], hooks: hooksFor(harness) };
      return {
        status: target.conflicts.length ? 'conflict-or-invalid' : (target.changes.length ? 'drift-or-pending-change' : 'verified'),
        resources: registryView.ledger.resources.filter((resource) => resource.harness === harness),
        errors: target.conflicts,
        hooks: hooksFor(harness),
      };
    };
    // Every lifecycle-wired harness gets the same per-harness status treatment — not just the
    // four that historically had it — so 'doflow status --target copilot/opencode/pi --json'
    // reports 'verified'/'conflict-or-invalid' instead of silently omitting the harness.
    for (const harness of LIFECYCLE_HARNESSES) {
      if (targets.includes(harness)) ctx[harness] = harnessStatus(harness);
    }
  } catch (error) {
    // Status must remain usable for an existing installation even if a local registry is invalid.
    ctx.registry = { status: 'invalid', error: error.message };
  }

  if (o.json) {
    console.log(JSON.stringify({ context: ctx, manifest, codex: ctx.codex ?? null }, null, 2));
    return;
  }

  const hookLine = (label, hooks) => {
    if (!hooks || hooks.status === 'absent') return null;
    const prereqSuffix = hooks.prerequisites.length ? ` (unmet: ${hooks.prerequisites.join(', ')})` : '';
    return `  ${label} hooks: ${hooks.status}${prereqSuffix}`;
  };

  printContext(ctx);
  if (!manifest) {
    console.log("[WARN] No install manifest found — run 'doflow install' to get started");
    return;
  }

  console.log('\nInstall Status');
  console.log(`  Last operation:       ${manifest.operation}`);
  console.log(`  Last run:             ${manifest.lastRun}`);
  console.log(`  Source commit:        ${manifest.sourceCommit}`);
  console.log(`  Last backup ID:       ${manifest.backupId}`);
  console.log(`  Script version:       ${manifest.scriptVersion}`);
  console.log(`  MCP servers:          ${manifest.mcpServers ? manifest.mcpServers.join(', ') || 'none' : 'all (default)'}`);
  // Printed in the same order LIFECYCLE_HARNESSES declares, so every wired harness gets a line —
  // not just the four that historically had a hand-written block — with Codex keeping its extra
  // capability-gap line since that note is Codex-specific, not a general per-harness property.
  for (const harness of LIFECYCLE_HARNESSES) {
    const status = ctx[harness];
    if (!status) continue;
    const label = `${harness.charAt(0).toUpperCase()}${harness.slice(1)}`;
    console.log(`  ${`${label} verification:`.padEnd(24)}${status.status}`);
    console.log(`  ${`${label} resources:`.padEnd(24)}${status.resources.length} manifest-owned`);
    const line = hookLine(label, status.hooks);
    if (line) console.log(line);
    if (status.errors.length) console.log(`  ${`${label} issues:`.padEnd(24)}${status.errors.join('; ')}`);
    if (harness === 'codex') {
      console.log('  Codex capability gaps: no Claude-only event emulation is installed; review docs/capability-map.md#codex-capability-detail');
    }
  }
  if (ctx.registry) {
    console.log(`  Registry lifecycle:   ${ctx.registry.status === 'invalid' ? ctx.registry.error : `${ctx.registry.plan.changes} pending, ${ctx.registry.plan.conflicts.length} conflict(s)`}`);
    if (ctx.registry.status !== 'invalid') console.log(`  Neutral state:         ${ctx.registry.stateRoot}${ctx.registry.ledgerPresent ? ' (ledger present)' : ' (not yet created)'}`);
  }
  console.log('\n  TOOL         STATUS         LAST UPDATED');
  for (const tool of LIFECYCLE_HARNESSES) {
    const t = manifest.tools[tool];
    const status = t?.installed ? 'installed' : 'not installed';
    console.log(`  ${tool.padEnd(12)} ${status.padEnd(14)} ${t?.last_updated ?? 'never'}`);
  }
}

module.exports = cmdStatus;

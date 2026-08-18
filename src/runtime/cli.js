'use strict';

const path = require('node:path');
const { CapabilityRouter } = require('./capability-router');
const { EvidenceLedger } = require('./evidence-ledger');
const { ClaimsManager } = require('./claims');
const { ReadinessEngine } = require('./readiness');
const { loadRegistry } = require('../registry');

/**
 * Handles `doflow capabilities` command execution.
 * @param {Object} options
 * @param {boolean} [options.json=false]
 * @param {boolean} [options.check=false]
 * @param {string} [options.repoRoot]
 */
function handleCapabilitiesCommand({ json = false, check = false, repoRoot } = {}) {
  const root = repoRoot || path.resolve(__dirname, '..', '..');
  const router = new CapabilityRouter({ repoRoot: root });
  const report = router.getAllCapabilitiesHealth(check);

  if (json) {
    console.log(JSON.stringify({ capabilities: report }, null, 2));
    return;
  }

  console.log('\nDoFlow Abstract Capabilities & Resolved Providers:');
  console.log('═'.repeat(78));
  console.log(
    'Capability'.padEnd(26) +
    'Active Provider'.padEnd(22) +
    'Status'.padEnd(14) +
    'Description'
  );
  console.log('─'.repeat(78));

  for (const item of report) {
    const statusFormatted =
      item.status === 'HEALTHY' ? '✓ HEALTHY' :
      item.status === 'FALLBACK' ? '▲ FALLBACK' :
      '✗ UNAVAIL';

    console.log(
      item.capability.padEnd(26) +
      item.activeProvider.padEnd(22) +
      statusFormatted.padEnd(14) +
      item.description
    );
  }
  console.log('═'.repeat(78));
  console.log(`Mode: ${check ? 'Deep Smoke Check' : 'Fast Presence Check'} · Total Capabilities: ${report.length}\n`);
}

/**
 * Handles `doflow readiness` command execution.
 * @param {Object} options
 * @param {string} [options.taskClass='feature']
 * @param {string} [options.taskId='default']
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 */
function handleReadinessCommand({ taskClass = 'feature', taskId = 'default', json = false, repoRoot, stateRoot } = {}) {
  // Two different roots, previously conflated into one. `root` locates the *registry* (the
  // readiness templates ship inside the DoFlow package). `state` locates the invoking project's
  // evidence, which belongs to the caller's repo — not to wherever DoFlow happens to be installed.
  // Sharing one root put every project's per-task evidence inside the DoFlow install directory,
  // which under an npm install is node_modules/ — shared across all projects and often read-only.
  const root = repoRoot || path.resolve(__dirname, '..', '..');
  const state = stateRoot || process.cwd();
  const ledger = new EvidenceLedger({ repoRoot: state });
  ledger.load(taskId);

  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: state });
  claims.load(taskId);

  const engine = new ReadinessEngine({ repoRoot: root });
  // Only what the caller actually told us. Previously this asserted `verificationPlan: 'npm test'`
  // and `scopeClear: true` unconditionally, which auto-satisfied the verification and scope
  // requirement families for every task regardless of project state — the gate reported checkmarks
  // it had not measured. Unproven prerequisites must read as MISSING.
  const report = engine.evaluateReadiness({ taskId, taskClass }, ledger, claims);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\nDoFlow Task Readiness Evaluation [${report.taskClass.toUpperCase()}]:`);
  console.log('═'.repeat(70));
  console.log(`Task ID:       ${report.taskId}`);
  console.log(`Template:      ${report.templateName}`);
  console.log(`Overall State: ${report.state === 'READY' ? '✓ READY' : report.state === 'NEEDS_EVIDENCE' ? '▲ NEEDS EVIDENCE' : '✗ ' + report.state}`);
  console.log(`Summary:       ${report.summary}`);
  console.log('─'.repeat(70));
  console.log('Requirements Breakdown:');

  for (const req of report.requirements) {
    const mark = req.satisfied ? '✓ Satisfied' : req.required ? '✗ MISSING' : '○ Optional';
    console.log(`  ${req.id.padEnd(26)} ${mark.padEnd(14)} ${req.description}`);
    if (!req.satisfied && req.recommendedAction) {
      console.log(`    └─ Recommended: [${req.recommendedAction.capability}] ${req.recommendedAction.action}`);
    }
  }
  console.log('═'.repeat(70) + '\n');
}

/**
 * Handles `doflow evidence` command execution.
 * @param {Object} options
 * @param {string} [options.taskId='default']
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 */
function handleEvidenceCommand({ taskId = 'default', json = false, repoRoot, stateRoot } = {}) {
  // See handleReadinessCommand: evidence is the caller's project state, not DoFlow package state.
  const root = stateRoot || repoRoot || process.cwd();
  const ledger = new EvidenceLedger({ repoRoot: root });
  ledger.load(taskId);
  const items = ledger.queryEvidence({ taskId });

  if (json) {
    console.log(JSON.stringify({ taskId, evidenceCount: items.length, evidence: items }, null, 2));
    return;
  }

  console.log(`\nDoFlow Evidence Ledger [Task: ${taskId}]:`);
  console.log('═'.repeat(78));
  if (items.length === 0) {
    console.log('No evidence items recorded for this task.');
  } else {
    console.log('ID'.padEnd(16) + 'Kind'.padEnd(20) + 'Status'.padEnd(12) + 'File Locator');
    console.log('─'.repeat(78));
    for (const item of items) {
      const loc = item.locator?.file ? `${item.locator.file}` : 'None';
      console.log(
        item.id.padEnd(16) +
        item.kind.padEnd(20) +
        item.freshness.status.padEnd(12) +
        loc
      );
    }
  }
  console.log('═'.repeat(78) + '\n');
}

module.exports = {
  handleCapabilitiesCommand,
  handleReadinessCommand,
  handleEvidenceCommand,
};

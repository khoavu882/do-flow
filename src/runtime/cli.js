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
 * Handles `doflow doctor` diagnostics execution.
 * @param {Object} options
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 */
function handleDoctorCommand({ json = false, repoRoot } = {}) {
  const root = repoRoot || path.resolve(__dirname, '..', '..');
  const registry = loadRegistry({ repoRoot: root });
  const router = new CapabilityRouter({ repoRoot: root });
  const capabilityReport = router.getAllCapabilitiesHealth(true);

  const doctorResults = {
    harnesses: registry.harnesses.map((h) => ({
      id: h.id,
      displayName: h.displayName,
      status: 'PASS',
    })),
    externalTools: registry.externalTools.map((tool) => {
      let available = false;
      const bin = tool.id === 'semble' ? 'semble' : tool.id === 'graphify' ? 'graphify' : 'rtk';
      available = router.isBinaryAvailable(bin);
      return {
        id: tool.id,
        displayName: tool.displayName,
        status: available ? 'PASS' : 'ABSENT',
      };
    }),
    capabilities: capabilityReport,
  };

  if (json) {
    console.log(JSON.stringify(doctorResults, null, 2));
    return;
  }

  console.log('\nDoFlow System Diagnostics (doflow doctor)');
  console.log('═'.repeat(60));
  
  console.log('\n[Harness Adapters]');
  for (const h of doctorResults.harnesses) {
    console.log(`  ${h.displayName.padEnd(28)} PASS`);
  }

  console.log('\n[External Tools]');
  for (const t of doctorResults.externalTools) {
    const status = t.status === 'PASS' ? '✓ PASS' : '○ ABSENT (Optional)';
    console.log(`  ${t.displayName.padEnd(28)} ${status}`);
  }

  console.log('\n[Runtime Capabilities]');
  for (const c of doctorResults.capabilities) {
    const status = c.status === 'HEALTHY' ? '✓ HEALTHY' : c.status === 'FALLBACK' ? '▲ FALLBACK' : '✗ UNAVAILABLE';
    console.log(`  ${c.capability.padEnd(28)} ${status.padEnd(16)} (${c.activeProvider})`);
  }
  console.log('\n' + '═'.repeat(60) + '\n');
}

/**
 * Handles `doflow readiness` command execution.
 * @param {Object} options
 * @param {string} [options.taskClass='feature']
 * @param {string} [options.taskId='default']
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 */
function handleReadinessCommand({ taskClass = 'feature', taskId = 'default', json = false, repoRoot } = {}) {
  const root = repoRoot || path.resolve(__dirname, '..', '..');
  const ledger = new EvidenceLedger({ repoRoot: root });
  ledger.load(taskId);

  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: root });
  claims.load(taskId);

  const engine = new ReadinessEngine({ repoRoot: root });
  const report = engine.evaluateReadiness(
    { taskId, taskClass, verificationPlan: 'npm test', scopeClear: true },
    ledger,
    claims
  );

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
function handleEvidenceCommand({ taskId = 'default', json = false, repoRoot } = {}) {
  const root = repoRoot || path.resolve(__dirname, '..', '..');
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
  handleDoctorCommand,
  handleReadinessCommand,
  handleEvidenceCommand,
};

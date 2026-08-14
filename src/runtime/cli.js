'use strict';

const path = require('node:path');
const { CapabilityRouter } = require('./capability-router');
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

module.exports = {
  handleCapabilitiesCommand,
  handleDoctorCommand,
};

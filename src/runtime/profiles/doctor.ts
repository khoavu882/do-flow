'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveRolloutProfile, isCapabilityActive } = require('./resolve.ts');
const { checkRollbackState, tripRollback, resetRollback } = require('./rollback.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

interface ProfileDoctorReport {
  profile: ReturnType<typeof resolveRolloutProfile>;
  rollback: ReturnType<typeof checkRollbackState>;
  registryVerified: {
    harnessCount: number;
    verifiedFacts: boolean;
    nativeTelemetry: boolean;
  };
}

function buildProfilesDoctor(options?: {
  repoRoot?: string;
  projectRoot?: string;
  env?: any;
  fsImpl?: any;
}): ProfileDoctorReport {
  const fsImpl = options?.fsImpl || fs;
  const repoRoot = options?.repoRoot || REPO_ROOT;

  const profile = resolveRolloutProfile(options);
  const rollback = checkRollbackState(options);

  let harnessCount = 0;
  let verifiedFacts = true;
  let nativeTelemetry = true;

  try {
    const harnessesPath = path.join(repoRoot, 'core', 'registry', 'harnesses.json');
    if (fsImpl.existsSync(harnessesPath)) {
      const data = JSON.parse(fsImpl.readFileSync(harnessesPath, 'utf8'));
      if (Array.isArray(data.harnesses)) {
        harnessCount = data.harnesses.length;
        for (const h of data.harnesses) {
          if (!h.contextProfile || typeof h.contextProfile.capacityTokens?.value !== 'number') {
            verifiedFacts = false;
          }
          if (!h.nativeTelemetry || !Array.isArray(h.nativeTelemetry.signals)) {
            nativeTelemetry = false;
          }
        }
      }
    }
  } catch {
    verifiedFacts = false;
    nativeTelemetry = false;
  }

  return {
    profile,
    rollback,
    registryVerified: {
      harnessCount,
      verifiedFacts,
      nativeTelemetry,
    },
  };
}

function printProfilesDoctor(report: ProfileDoctorReport): void {
  console.log('\n[Rollout Profile & Governance]');
  const p = report.profile;
  const r = report.rollback;

  console.log(`  profile           ${p.name.padEnd(12)} (${p.origin.source}: ${p.origin.detail || 'default'})`);
  if (r.active) {
    console.log(`  rollback          ACTIVE (${r.reason}, origin: ${r.origin}) -> forced baseline`);
  } else {
    console.log('  rollback          inactive (normal operation)');
  }

  const caps = p.capabilities;
  console.log(`  capabilities      retrieval: ${caps.retrieval}, advisor: ${caps.advisor}, graph: ${caps.graph}, verification: ${caps.verification}`);
  console.log(`  canary tag        ${caps.telemetryCanaryTag ? 'yes' : 'no'} (sample rate: ${(p.canarySampleRate * 100).toFixed(0)}%)`);

  const reg = report.registryVerified;
  const regStatus = reg.verifiedFacts && reg.nativeTelemetry ? 'PASS' : 'UNVERIFIED';
  console.log(`  harness registry  ${reg.harnessCount}/8 harnesses verified (${regStatus})`);
}

module.exports = {
  buildProfilesDoctor,
  printProfilesDoctor,
  resolveRolloutProfile,
  checkRollbackState,
  isCapabilityActive,
  tripRollback,
  resetRollback,
};

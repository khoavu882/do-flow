'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The person-written billing record (`workers.billing`, global-only): which headless workers the
 * owner states are `free` or `metered`. It lets a capped dispatch (`--billing-cap free`) treat a
 * worker the registry lists as `unknown` as free, and it can only narrow a worker the registry
 * lists as `free`. It lives with the settings it reads so dispatch needs no settings internals.
 */

type Billing = 'free' | 'metered' | 'unknown';
type RecordEntry = { billing: 'free' | 'metered'; asserted: string; basis?: string };
type BillingRecord = { state: 'absent' | 'set' | 'invalid'; reason: string | null; workers: Record<string, RecordEntry> };

const none = (state: BillingRecord['state'], reason: string | null = null): BillingRecord => ({ state, reason, workers: {} });

/**
 * Read fresh on every call (never memoised: a copied env defeats the resolver cache), from the user
 * layer only: a project file never decides it. Absent is no config home or no decided value. Invalid
 * is a resolution in the invalid state, any invalid candidate, an id that is not in `workerIds`
 * (reason `unknown-worker:<id>`) or any thrown error: the caller then counts no worker as free.
 * A retired harness id (127 IC-005) is dropped by the resolver before this sees the value, with an
 * advisory in the settings view's notes; it is never an unknown worker. `registry` is an optional
 * loaded settings registry (tests); it defaults to the shipped one.
 */
function readWorkerBilling(env: any = process.env, { workerIds = [], registry }: { workerIds?: string[]; registry?: any } = {}): BillingRecord {
  try {
    const { loadSettings } = require('./resolve.ts');
    const resolution = loadSettings({ global: true, env: { ...env }, registry }).get('workers.billing', 'global');
    const bad = resolution.candidates.find((c: any) => c.status === 'invalid');
    if (bad || resolution.state === 'invalid') return none('invalid', (bad && bad.reason) || 'invalid');
    if (resolution.origin?.via === 'no-config-home') return none('absent');
    const value = resolution.value;
    if (value === null || value === undefined) return none('absent');
    for (const id of Object.keys(value)) {
      if (!workerIds.includes(id)) return none('invalid', `unknown-worker:${id}`);
    }
    return { state: 'set', reason: null, workers: structuredClone(value) };
  } catch {
    return none('invalid', 'unreadable');
  }
}

/**
 * Derives billing category from harness detected authentication mode (IC-004).
 * subscription -> free, api-key -> metered, unverified -> unknown.
 */
function deriveBilling(mode: 'subscription' | 'api-key' | 'unverified' | string): Billing {
  if (mode === 'subscription') return 'free';
  if (mode === 'api-key') return 'metered';
  return 'unknown';
}

/**
 * The billing a capped dispatch judges for one worker.
 * Precedence: user record (`workers.billing`) > derived (`catalogue`) > registry descriptor.
 * Cap enforcement: neither record nor derived ever lifts a registry `metered`.
 */
function effectiveBilling(
  descriptorBilling: unknown,
  harnessId: string,
  record: BillingRecord | null,
  catalogue?: any
): {
  value: Billing;
  source: 'registry' | 'user-record' | 'derived';
  asserted?: string;
  detectedMode?: string;
} {
  const base: Billing = descriptorBilling === 'free' || descriptorBilling === 'metered' ? descriptorBilling : 'unknown';
  const entry = record && record.state === 'set' && Object.hasOwn(record.workers, harnessId) ? record.workers[harnessId] : null;

  // 1. User record
  if (entry) {
    if (base === 'metered') {
      return { value: 'metered', source: 'registry' };
    }
    if (entry.billing !== base && (entry.billing === 'metered' || base === 'unknown')) {
      return { value: entry.billing, source: 'user-record', asserted: entry.asserted };
    }
    if (entry.billing === base) {
      return { value: base, source: 'registry' };
    }
  }

  // 2. Derived from catalogue
  if (catalogue && catalogue.harnesses && Object.hasOwn(catalogue.harnesses, harnessId)) {
    const catHarness = catalogue.harnesses[harnessId];
    const derived = catHarness.derivedBilling || deriveBilling(catHarness.detectedMode);
    if (derived === 'free' || derived === 'metered') {
      if (base === 'metered') {
        return { value: 'metered', source: 'registry' };
      }
      return {
        value: derived,
        source: 'derived',
        detectedMode: catHarness.detectedMode,
      };
    }
  }

  // 3. Fallback to registry descriptor
  return { value: base, source: 'registry' };
}

module.exports = { readWorkerBilling, deriveBilling, effectiveBilling };

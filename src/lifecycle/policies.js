'use strict';

// Registry lifecycle policies are logical intent. This projection reports what a
// harness may render and any human prerequisite; native event serialization stays
// in the owning harness adapter.
const { harnessFor } = require('../registry');

const POLICY_STATUSES = new Set(['supported', 'different', 'unavailable', 'prerequisite']);

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function policyFor(registry, id) {
  const policy = registry?.lifecycle?.find((item) => item.id === id);
  if (!policy) throw new Error(`Unknown lifecycle policy '${id}'`);
  return policy;
}

function renderPolicy(policy, harness) {
  const mapping = policy?.mappings?.[harness.id];
  if (!mapping) throw new Error(`Lifecycle policy '${policy.id}' has no mapping for '${harness.id}'`);
  const requiredCapabilities = (policy.requires || []).map((capability) => {
    const declaration = harness.capabilities?.[capability];
    if (!declaration) throw new Error(`Lifecycle policy '${policy.id}' requires unknown '${harness.id}' capability '${capability}'`);
    return [capability, declaration];
  });
  const unavailableCapability = requiredCapabilities.find(([, declaration]) => declaration.status === 'unavailable');
  const prerequisites = unique([
    ...(mapping.prerequisites || []),
    ...requiredCapabilities.flatMap(([, declaration]) => declaration.prerequisites || []),
  ]);
  const capabilityStatus = unavailableCapability ? 'unavailable' : mapping.status;
  const unavailable = capabilityStatus === 'unavailable';
  const status = unavailable ? 'unavailable' : (prerequisites.length ? 'prerequisite' : capabilityStatus);
  return Object.freeze({
    id: policy.id,
    intent: policy.intent,
    harness: harness.id,
    status,
    capabilityStatus,
    event: unavailable ? null : mapping.event,
    renderable: !unavailable,
    prerequisites,
    fallback: unavailable ? (mapping.fallback || 'guidance') : null,
    reason: unavailableCapability ? `Required capability '${unavailableCapability[0]}' is unavailable` : null,
  });
}

/** Render policy status data for one harness without calling an adapter or writing state. */
function renderPolicies(registry, { harness: harnessId, policyIds } = {}) {
  if (!harnessId) throw new Error('A harness id is required to render lifecycle policies');
  const harness = harnessFor(registry, harnessId);
  const policies = policyIds === undefined || policyIds === null
    ? registry.lifecycle
    : policyIds.map((id) => policyFor(registry, id));
  if (!Array.isArray(policies)) throw new Error('Lifecycle policies must be an array');
  return Object.freeze(policies.map((policy) => renderPolicy(policy, harness)));
}

module.exports = { POLICY_STATUSES, policyFor, renderPolicy, renderPolicies };

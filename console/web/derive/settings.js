// The Settings view's derivations (feature 151, plan task C.2; IC-017, FR-004, DEC-003): the concept group of a setting
// key and the keys of a `config-list` body grouped by concept. No DOM and no fetch, so console/test/derive-manage.test.ts
// runs them as plain functions. The rule reads only the key's first segment, so a key the registry gains later lands in a
// group (Other at worst) with no change here.

/** The groups in the order the screen shows them (DESIGN-v2 section 5.3). */
const GROUPS = Object.freeze(['Workers', 'Advice and shadow', 'Review and debate', 'Rollout', 'Other']);

/** Key prefixes, first segment and its dot, to their group (IC-017). Every other prefix is Other. */
const PREFIX_GROUP = Object.freeze({
  'workers.': 'Workers',
  'dispatch.': 'Workers',
  'team.': 'Workers',
  'advice.': 'Advice and shadow',
  'review.': 'Review and debate',
  'debate.': 'Review and debate',
  'rollout.': 'Rollout',
});

/**
 * The group of a setting key: the group of its first segment, else Other.
 * @param {any} key
 * @returns {string}
 */
function groupOf(key) {
  if (typeof key !== 'string') return 'Other';
  const dot = key.indexOf('.');
  if (dot < 1) return 'Other';
  return /** @type {Record<string, string>} */ (PREFIX_GROUP)[key.slice(0, dot + 1)] ?? 'Other';
}

/** The key of an entry: a key string as it is, or the `key` of a `config-list` row. @param {any} entry */
const keyOf = (entry) => (typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? entry.key : undefined);

/**
 * The entries (key strings or `config-list` `keys[]` rows) grouped by concept, in GROUPS order; the entries of each group
 * keep the order they came in, which is the registry's. Every entry is in exactly one group; a group with no entry is
 * left out.
 * @param {any} keys
 * @returns {Array<{ group: string, keys: any[] }>}
 */
function groupKeys(keys) {
  if (!Array.isArray(keys)) return [];
  /** @type {Map<string, any[]>} */
  const by = new Map(GROUPS.map((group) => [group, []]));
  for (const entry of keys) /** @type {any[]} */ (by.get(groupOf(keyOf(entry)))).push(entry);
  return GROUPS.filter((group) => /** @type {any[]} */ (by.get(group)).length > 0).map((group) => ({ group, keys: /** @type {any[]} */ (by.get(group)) }));
}

export { GROUPS, groupOf, groupKeys };

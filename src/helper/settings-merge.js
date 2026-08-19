'use strict';

// settings.json and keybindings.json are SHARED files: the user hand-maintains them, DoFlow adds
// its hooks, and third-party tools (other installers, command proxies) add their own entries.
// That makes
// whole-file SHA-256 ownership — correct for copy-tree assets DoFlow owns outright — the wrong
// model here. It can only ever hold on a machine DoFlow provisioned from empty, so on any real
// machine a first install saw "target != source" and refused, aborting the entire lifecycle
// before a single file landed.
//
// These helpers give the settings renderer the same posture marker-merge already gives
// CLAUDE.md: DoFlow guarantees ITS keys are present and correct, and treats everything else in
// the file as none of its business — preserved on write, ignored on verify, left behind on
// remove.

/** A hook entry's identity is its (matcher, commands) pair — NOT the commands alone. One script is
 * legitimately registered under several matchers for the same event (post-edit-lint.sh runs on
 * both `Edit` and `Write`), so comparing commands only makes those entries indistinguishable and
 * silently collapses them to one during a merge. Position is not usable: it is not stable across
 * a re-render. */
function hookCommands(entry) {
  return (entry?.hooks || []).map((hook) => hook?.command).filter((command) => typeof command === 'string');
}

function sameHookEntry(a, b) {
  if ((a?.matcher ?? null) !== (b?.matcher ?? null)) return false;
  const left = hookCommands(a);
  const right = hookCommands(b);
  return left.length === right.length && left.every((command, index) => command === right[index]);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Union of managed hook entries into whatever is already registered for an event. Foreign
 * entries keep their relative order and stay first, so a third-party guard that was already
 * intercepting a tool keeps intercepting it. */
function mergeHookEvent(existing, managed) {
  const result = Array.isArray(existing) ? existing.slice() : [];
  for (const entry of managed || []) {
    if (!result.some((present) => sameHookEntry(present, entry))) result.push(entry);
  }
  return result;
}

function mergeHooks(existing, managed) {
  const result = isPlainObject(existing) ? { ...existing } : {};
  for (const [event, entries] of Object.entries(managed || {})) {
    result[event] = mergeHookEvent(result[event], entries);
  }
  return result;
}

/** Merge DoFlow's managed settings into an existing file.
 *
 * Precedence is deliberate and asymmetric:
 *   - `hooks` — managed entries are ADDED (union). DoFlow's guardrails must actually be present,
 *     and foreign entries must survive.
 *   - everything else — the EXISTING value wins. DoFlow ships opinionated defaults (`model`,
 *     `permissions`, `outputStyle`), and silently overriding a user's explicit choice during an
 *     install is exactly the surprise this module exists to prevent. Managed keys the file does
 *     not have yet are still added, so a fresh install is unchanged.
 */
function mergeSettings(existing, managed) {
  if (!isPlainObject(existing)) return managed;
  const result = { ...existing };
  for (const [key, value] of Object.entries(managed || {})) {
    if (key === 'hooks') { result.hooks = mergeHooks(existing.hooks, value); continue; }
    if (!Object.hasOwn(result, key)) { result[key] = value; continue; }
    if (isPlainObject(result[key]) && isPlainObject(value)) result[key] = mergeSettings(result[key], value);
    // else: existing scalar/array wins — user intent is preserved.
  }
  return result;
}

/** Verification predicate replacing byte-equality: DoFlow's own keys must be present, and every
 * managed hook entry must still be registered. A foreign key, a user-tuned `model`, or an extra
 * hook entry are all legitimate and must NOT read as drift. */
function settingsContains(current, managed) {
  if (!isPlainObject(current)) return false;
  for (const [key, value] of Object.entries(managed || {})) {
    if (key === 'hooks') {
      for (const [event, entries] of Object.entries(value || {})) {
        const present = current.hooks?.[event];
        if (!Array.isArray(present)) return false;
        for (const entry of entries || []) {
          if (!present.some((candidate) => sameHookEntry(candidate, entry))) return false;
        }
      }
      continue;
    }
    if (!Object.hasOwn(current, key)) return false;
    if (isPlainObject(value) && isPlainObject(current[key]) && !settingsContains(current[key], value)) return false;
  }
  return true;
}

/** Remove DoFlow's hook entries and leave everything else standing. `doflow remove` previously
 * rmSync'd the whole file, which on a shared settings.json would delete the user's entire
 * own configuration along with DoFlow's contribution. Returns null only when nothing
 * meaningful remains, letting the caller delete a file DoFlow genuinely created. */
function stripManagedSettings(current, managed) {
  if (!isPlainObject(current)) return null;
  const result = { ...current };
  const managedHooks = managed?.hooks;
  if (isPlainObject(result.hooks) && isPlainObject(managedHooks)) {
    const hooks = {};
    for (const [event, entries] of Object.entries(result.hooks)) {
      const remaining = (entries || []).filter(
        (entry) => !(managedHooks[event] || []).some((owned) => sameHookEntry(owned, entry)),
      );
      if (remaining.length) hooks[event] = remaining;
    }
    if (Object.keys(hooks).length) result.hooks = hooks; else delete result.hooks;
  }
  // Beyond hooks, drop any key still holding exactly the value DoFlow wrote — we put it there and
  // nothing has touched it since. A key the user changed no longer matches and is left alone.
  // Without this, a file DoFlow created outright (keybindings.json, which has no hooks at all)
  // would survive `remove` fully intact and read as a resource that refused to go away.
  for (const [key, value] of Object.entries(managed || {})) {
    if (key === 'hooks') continue;
    if (Object.hasOwn(result, key) && JSON.stringify(result[key]) === JSON.stringify(value)) delete result[key];
  }
  const meaningful = Object.keys(result).filter((key) => !key.startsWith('$'));
  return meaningful.length ? result : null;
}

/** True when at least one managed hook entry is still registered. Only hook entries count:
 * non-hook managed keys are ordinary settings that survive a remove and are indistinguishable
 * from the user's own, so they cannot signal DoFlow's presence. Lets verification tell "removed"
 * (none of ours left) apart from "damaged" (some of ours left, some missing). */
function settingsContainsAny(current, managed) {
  if (!isPlainObject(current)) return false;
  for (const [event, entries] of Object.entries(managed?.hooks || {})) {
    const present = current.hooks?.[event];
    if (!Array.isArray(present)) continue;
    if ((entries || []).some((entry) => present.some((candidate) => sameHookEntry(candidate, entry)))) return true;
  }
  return false;
}

module.exports = { mergeSettings, settingsContains, settingsContainsAny, stripManagedSettings, sameHookEntry };

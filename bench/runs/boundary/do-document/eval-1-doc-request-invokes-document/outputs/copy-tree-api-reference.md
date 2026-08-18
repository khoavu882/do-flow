# `src/adapters/copy-tree.js` — API reference

Shared copy-tree engine — the generic "own a tree of files" implementation every asset declaring
`renderer: "copy-tree"` in `core/registry/assets.yaml` uses. Generalizes Codex's original
per-file fingerprint/conflict model (`ownedRemovalPlan`, `nativeManagedResources`) so Claude,
Gemini, and Codex's own tree-shaped assets (skills, rules, agent-specs, templates, scripts,
modes, references) share one implementation instead of three adapter-specific copies.

Source: [`src/adapters/copy-tree.js`](../../../../../src/adapters/copy-tree.js)

## Exports

```js
module.exports = {
  discoverTree, planTree, applyTree, removeTree, verifyTree,
  copyTreeAssets, copyTreeDestDir, ledgerFileResources,
  resolveLayout, LAYOUTS,
  fingerprint, readJson, sourceDirFor,
};
```

Thirteen exports: five tree-lifecycle functions, three per-adapter glue helpers, two layout
helpers, and three general-purpose utilities. (`sha256`, `walkRelFiles`, and `stableSort` are
internal — not exported.)

---

### `discoverTree({ sourceDir, destDir, fsImpl = fs, layout })`

List every source file with its would-be destination and content fingerprint. Does not touch the
destination tree beyond checking existence.

- **Parameters** (single options object):
  - `sourceDir` `string` — directory to walk recursively. Throws if missing.
  - `destDir` `string` — destination root each source-relative path is resolved against.
  - `fsImpl` `object` (default `fs`) — injectable fs implementation, for tests.
  - `layout` `string | (sourceRel: string) => string` — optional destination-path remapping; a
    string is resolved via `resolveLayout`, a function is used as-is.
- **Returns** `{ files: Array<{ relPath, sourceAbs, destAbs, exists, fingerprint }> }`.
  `relPath` is destination-relative and doubles as the ledger identity — a layout change relocates
  the recorded resource rather than orphaning it.
- **Throws** `Error` if `sourceDir` does not exist.

```js
const { discoverTree } = require('./src/adapters/copy-tree.js');
const { files } = discoverTree({ sourceDir: 'core/shared/skills', destDir: '.claude/skills' });
```

---

### `planTree({ sourceDir, destDir, previousResources = [], operation = 'apply', fsImpl = fs, layout })`

Diff the source tree against `previousResources` (the ledger's prior per-file ownership records:
`{relPath, fingerprint}`) to produce create/update/remove changes. Refuses to touch any
destination file whose on-disk content doesn't match its last-recorded fingerprint (or, for a
never-before-owned file, doesn't match the source it would be overwritten with) — the same
conflict-safety Codex's adapter applies to agents and hooks.

- **Parameters**:
  - `sourceDir` `string` — source tree root; skipped entirely when `operation === 'remove'`.
  - `destDir` `string` — destination tree root.
  - `previousResources` `Array<{relPath, fingerprint, target?}>` (default `[]`) — prior ownership
    records from the state ledger. `target`, when present, is the resource's *actual* recorded
    location (used so a relocated asset — e.g. after a `nativeDir` change — is removed from where
    it really is, not from where it would land today).
  - `operation` `'apply' | 'remove'` (default `'apply'`) — `'remove'` proposes removals for every
    previously-owned file and never reads `sourceDir`.
  - `fsImpl` `object` (default `fs`).
  - `layout` — same as `discoverTree`.
- **Returns** `{ changes: Array<{relPath, target, operation, fingerprint, source?}>, conflicts: string[] }`.
  `operation` per change is one of `'create' | 'update' | 'remove'`. A `conflicts` entry means a
  destination file was modified outside DoFlow and was left untouched.
- **Throws**: none directly (errors from `discoverTree`/`sourceFingerprint` propagate if
  `sourceDir` is missing during an `'apply'` operation).

```js
const { planTree } = require('./src/adapters/copy-tree.js');
const { changes, conflicts } = planTree({
  sourceDir: 'core/shared/skills',
  destDir: '.claude/skills',
  previousResources: ledger.getResources('claude', 'skills'),
});
```

---

### `applyTree({ changes = [], fsImpl = fs })`

Write every `create`/`update` change from a `planTree` result (`remove` changes are skipped —
use `removeTree` for those). Preserves the source file's mode (so a hook script's `+x` bit
survives the copy) and mtime.

- **Parameters**: `changes` — the array returned by `planTree`; `fsImpl` (default `fs`).
- **Returns** `{ applied: number }` — count of files written.
- **Side effects**: creates destination directories as needed (`mkdirSync` recursive), copies file
  bytes, chmods to the source's mode bits, and sets atime/mtime to match the source.

---

### `removeTree({ changes = [], fsImpl = fs })`

Delete every `remove` change, re-checking each file's fingerprint immediately before deletion.

- **Parameters**: `changes` — a `planTree` result (only `operation === 'remove'` entries act);
  `fsImpl` (default `fs`).
- **Returns** `{ removed: number }`.
- **Throws** `Error` — "Refusing to remove modified copy-tree resource: `<relPath>`" if the file's
  current content no longer matches the fingerprint recorded when `planTree` computed the change
  (i.e., something modified it since planning). A target that's already gone is silently skipped.

---

### `verifyTree({ sourceDir, destDir, fsImpl = fs, layout })`

Re-derive ownership resources from what's actually on disk right now, for status/verify commands.

- **Parameters**: same shape as `discoverTree`.
- **Returns** `{ ok: boolean, resources: Array<{relPath, target, fingerprint}>, conflicts: string[] }`.
  `resources` only includes files that exist and match their source fingerprint; a mismatch is
  reported in `conflicts` instead. `ok` is `true` iff `conflicts` is empty.

---

### `copyTreeAssets(assets)`

Filter a harness's asset list down to the ones this engine handles.

- **Parameters**: `assets` — array of asset definitions (or nullish).
- **Returns** `Array` — the subset where `asset.renderer === 'copy-tree'`. Returns `[]` for a
  nullish input.

---

### `copyTreeDestDir(configDir, asset)`

Resolve an asset's native destination directory under the harness's already-resolved config dir.

- **Parameters**: `configDir` `string`; `asset` `{ nativeDir?: string }`.
- **Returns** `string` — `path.join(configDir, asset.nativeDir || '')`.

---

### `ledgerFileResources(resources, harness, assetId)`

Narrow a harness's flat neutral-resource list to one asset's previously-owned copy-tree files.

- **Parameters**: `resources` — the full neutral resource list; `harness` `string`; `assetId`
  `string`.
- **Returns** `Array<{relPath, fingerprint, target}>` — filtered to entries where
  `resource.harness === harness && resource.assetId === assetId && resource.kind === 'copy-tree-file'`,
  reshaped from `{identity, fingerprint, target}` to `{relPath, fingerprint, target}` (`identity`
  is renamed to `relPath` for `planTree`'s `previousResources` shape).

---

### `resolveLayout(name)`

Resolve a declared layout name to its mapper function. Unknown names fail loudly rather than
silently mirroring, because a typo would otherwise install to the wrong shape and look like it
worked.

- **Parameters**: `name` `string | undefined`.
- **Returns** `(sourceRel: string) => string` — the identity function `(rel) => rel` when `name`
  is falsy, otherwise the named entry from `LAYOUTS`.
- **Throws** `Error` — "Unknown copy-tree layout '`<name>`' (known: ...)" if `name` is truthy but
  not a key in `LAYOUTS`.

---

### `LAYOUTS`

```js
/** @type {Record<string, (sourceRel: string) => string>} */
```

Not a function — an exported registry of named destination-path remappings, consumed by
`resolveLayout`. Currently one entry:

- `'dir-per-file:agent.md'` — `spec-analyst.md` → `spec-analyst/agent.md`. Used where a harness
  (e.g. Antigravity) discovers a custom agent at `.agents/agents/<name>/agent.md` — a directory
  per agent — rather than DoFlow's flat `<name>.md` spec files.

---

### `fingerprint(value)`

Content fingerprint every adapter uses to track what it owns.

- **Parameters**: `value` `any`.
- **Returns** `string` — sha256 hex digest. A `string` value is hashed as-is; anything else is
  JSON-serialized after a stable (recursive, key-sorted) sort first, so two logically-equal
  objects with differently-ordered keys (e.g. after a settings file is merged and re-merged)
  fingerprint identically instead of spuriously registering as changed.

---

### `readJson(file, { fsImpl = fs } = {})`

Read and parse a native JSON file an adapter merges into. Distinguishes "absent" (safe to create)
from "present but unparseable" (a conflict to report, never silently overwritten).

- **Parameters**: `file` `string`; options object with `fsImpl` (default `fs`).
- **Returns** `{ exists: boolean, value: object | null, error: string | null }`:
  - absent file → `{ exists: false, value: {}, error: null }`
  - present + valid JSON → `{ exists: true, value: <parsed>, error: null }`
  - present + invalid JSON → `{ exists: true, value: null, error: 'Invalid JSON in <file>: <message>' }`
    (does not throw).

---

### `sourceDirFor(asset, context = {}, fsImpl = fs, harnessName = 'Adapter')`

Resolve an asset's source directory against the repo root, refusing a path that escapes the
repository or does not exist.

- **Parameters**:
  - `asset` `{ source: string }` — must have a string `source` field.
  - `context` `{ repoRoot?: string }` (default `{}`) — `repoRoot` defaults to `process.cwd()`.
  - `fsImpl` `object` (default `fs`).
  - `harnessName` `string` (default `'Adapter'`) — only shapes the thrown error message.
- **Returns** `string` — the resolved absolute source path.
- **Throws** `Error`:
  - "`<harnessName>` asset requires a source path" if `asset.source` isn't a string.
  - "`<harnessName>` asset source is unavailable: `<asset.source>`" if the resolved path escapes
    `repoRoot` (path-traversal guard) or doesn't exist on disk.

---

## Typical flow (discover → plan → apply/remove → verify)

```js
const ct = require('./src/adapters/copy-tree.js');

const { files } = ct.discoverTree({ sourceDir, destDir });          // 1. inspect
const { changes, conflicts } = ct.planTree({ sourceDir, destDir,     // 2. diff against ledger
  previousResources });
if (conflicts.length) { /* surface and stop */ }
const { applied } = ct.applyTree({ changes });                       // 3a. write create/update
// ...later, on removal...
const { removed } = ct.removeTree({ changes: removalChanges });      // 3b. delete remove entries
const { ok, resources } = ct.verifyTree({ sourceDir, destDir });     // 4. re-derive ownership
```

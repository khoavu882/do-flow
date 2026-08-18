# API Reference — `src/adapters/copy-tree.js`

The shared copy-tree engine: the generic "own a tree of files" implementation behind every asset
that declares `renderer: "copy-tree"` in `core/registry/assets.yaml`. Adapters (`claude`, `codex`,
`gemini`, …) call into it instead of carrying their own file-copy and ownership logic.

```js
const { discoverTree, planTree, applyTree, removeTree, verifyTree } = require('./src/adapters/copy-tree.js');
```

Thirteen names are exported: five lifecycle functions (`discoverTree`, `planTree`, `applyTree`,
`removeTree`, `verifyTree`), the layout registry (`LAYOUTS`, `resolveLayout`), and six per-adapter
glue helpers (`copyTreeAssets`, `copyTreeDestDir`, `ledgerFileResources`, `fingerprint`, `readJson`,
`sourceDirFor`).

Every function takes `fsImpl` (default: `node:fs`) so callers and tests can substitute a filesystem.

---

## Shared shapes

```js
// A discovered source file, destination-relative.
DiscoveredFile = { relPath, sourceAbs, destAbs, exists, fingerprint }

// A planned mutation. `source` is absent on removals.
Change = { relPath, target, source?, operation: 'create' | 'update' | 'remove', fingerprint }

// A prior ownership record read out of the neutral state ledger.
PreviousResource = { relPath, fingerprint, target? }
```

`relPath` is **destination**-relative and doubles as the ledger identity, so a layout change
relocates the recorded resource rather than orphaning it.

---

## Lifecycle functions

### `discoverTree({ sourceDir, destDir, fsImpl?, layout? }) → { files }`

Lists every file under `sourceDir` (recursively) with its would-be destination and content
fingerprint. Does not touch the destination tree beyond an `existsSync` check.

- `sourceDir` (string): source tree root. **Throws** `copy-tree source is missing: <dir>` if absent.
- `destDir` (string): destination tree root.
- `layout` (string | function, optional): a `LAYOUTS` key or a `(sourceRel) => relPath` mapper.
  Omitted means mirror source paths exactly.
- Returns `{ files: DiscoveredFile[] }`.

```js
const { files } = discoverTree({ sourceDir: 'core/shared/skills', destDir: '.claude/skills' });
// files[0] → { relPath: 'do/SKILL.md', sourceAbs: …, destAbs: …, exists: true, fingerprint: 'e77be8…' }
```

---

### `planTree({ sourceDir, destDir, previousResources?, operation?, fsImpl?, layout? }) → { changes, conflicts }`

Diffs the source tree against the ledger's prior ownership records and proposes create/update/remove
changes. This is where all of the engine's conflict safety lives; it never writes.

- `previousResources` (`PreviousResource[]`, default `[]`): what this harness last recorded owning.
- `operation` (`'apply' | 'remove'`, default `'apply'`): `'remove'` skips the source tree entirely
  and only proposes removals for previously-owned files.
- Returns `{ changes: Change[], conflicts: string[] }`. A conflict is a human-readable string, e.g.
  `"<relPath> was modified outside DoFlow"` — the file is skipped, not overwritten.

Behavior worth knowing before you rely on it:

- **Untampered test (apply path).** An existing destination file is safe to write if its bytes match
  the source about to be written **or** the fingerprint this harness last recorded *at this same
  location*. Source-match is checked first and unconditionally, because a destination can be claimed
  by several harnesses (`guidance.context-layer` projects one destination for three), so a sibling's
  install legitimately changes bytes that this harness's row still describes.
- **Relocation.** A `prev` whose `target` differs from the file's current `destAbs` counts as
  relocated: the change is emitted as `create` at the new path and the old path gets a removal.
  `prev.target === undefined` means "location unknown" (pre-fix ledger data) and is treated as
  same-location.
- **No-op skip.** Same location + same fingerprint + destination exists → no change emitted.
- **Removal path.** `proposeRemoval` deletes from `prev.target` (the recorded location), not from
  today's `destDir`. It accepts the same two signals as the apply path and carries the *observed*
  fingerprint on the change, so `removeTree`'s pre-delete re-check agrees rather than throwing
  mid-apply.

```js
const { changes, conflicts } = planTree({
  sourceDir, destDir,
  previousResources: ledgerFileResources(state.resources, 'claude', 'skills.doflow'),
});
if (conflicts.length) return { ok: false, conflicts };
```

---

### `applyTree({ changes?, fsImpl? }) → { applied }`

Writes every `create`/`update` change; ignores removals. Creates parent directories, then preserves
the source file's mode (so a hook script's `+x` bit survives without a separate chmod pass) and its
mtime.

- Returns `{ applied: number }` — the count of files written.

---

### `removeTree({ changes?, fsImpl? }) → { removed }`

Deletes every `remove` change. Re-hashes each file immediately before deletion and **throws**
`Refusing to remove modified copy-tree resource: <relPath>` if it no longer matches
`change.fingerprint`. A target that has already disappeared is skipped silently.

- Returns `{ removed: number }`.

---

### `verifyTree({ sourceDir, destDir, fsImpl?, layout? }) → { ok, resources, conflicts }`

Re-derives ownership from what is actually on disk right now, for `status`/`verify`. Files that do
not exist at the destination are skipped; files whose bytes differ from source are reported as
`"<relPath> does not match source"`.

- Returns `{ ok: boolean, resources: { relPath, target, fingerprint }[], conflicts: string[] }`,
  where `ok === (conflicts.length === 0)`.

---

## Layouts

### `LAYOUTS`

`Record<string, (sourceRel: string) => string>` — the destination-shape registry. A copy-tree
normally mirrors source paths, but a harness may need a different shape for the same content.
Declared here (and referenced per projection in the registry) rather than branched on inside an
adapter.

| Key | Mapping |
| --- | --- |
| `dir-per-file:agent.md` | `spec-analyst.md` → `spec-analyst/agent.md` — Antigravity discovers a custom agent at `.agents/agents/<name>/agent.md` |

### `resolveLayout(name) → (sourceRel) => relPath`

Resolves a layout name to its mapper. A falsy `name` returns the identity mirror. An unknown name
**throws** ``Unknown copy-tree layout '<name>' (known: …)`` — deliberately loud, because a typo
would otherwise install to the wrong shape and look like it worked.

---

## Per-adapter glue

These exist so `codex`/`claude`/`gemini` don't each carry their own copy.

### `copyTreeAssets(assets) → Asset[]`

Filters a harness's asset list down to `asset.renderer === 'copy-tree'`. Null-safe on both the list
and its entries.

### `copyTreeDestDir(configDir, asset) → string`

`path.join(configDir, asset.nativeDir || '')` — the asset's native destination under the harness's
already-resolved config directory.

### `ledgerFileResources(resources, harness, assetId) → PreviousResource[]`

Narrows the flat neutral-resource list from the state ledger to one asset's previously-owned files
(`kind === 'copy-tree-file'`), remapping `identity` → `relPath`. This is the value you feed to
`planTree`'s `previousResources`.

### `fingerprint(value) → string`

The content fingerprint every adapter uses to track what it owns: sha256 of a string as-is, or of a
**stably key-sorted** JSON serialization of anything else — so two logically-equal objects with
differently-ordered keys (a settings file merged and re-merged) hash identically instead of
spuriously registering as changed.

### `readJson(file, { fsImpl? }) → { exists, value, error }`

Reads and parses a native JSON file an adapter merges into, distinguishing the two cases that must
be handled differently:

| Case | `exists` | `value` | `error` |
| --- | --- | --- | --- |
| absent — safe to create | `false` | `{}` | `null` |
| present and valid | `true` | parsed object | `null` |
| present but unparseable — a conflict | `true` | `null` | `"Invalid JSON in <file>: …"` |

Never throws; an unparseable file is reported, never silently overwritten.

### `sourceDirFor(asset, context?, fsImpl?, harnessName?) → string`

Resolves `asset.source` against `context.repoRoot` (default `process.cwd()`), refusing a path that
escapes the repository or does not exist. `harnessName` (default `'Adapter'`) only shapes the error
text.

- **Throws** `<harnessName> asset requires a source path` when `asset.source` is not a string.
- **Throws** `<harnessName> asset source is unavailable: <source>` when the resolved path escapes
  the repo root or is missing.

---

## Not exported

`sha256`, `walkRelFiles`, and `stableSort` are module-private. Use `fingerprint` for hashing;
`discoverTree` is the public way to walk a tree.

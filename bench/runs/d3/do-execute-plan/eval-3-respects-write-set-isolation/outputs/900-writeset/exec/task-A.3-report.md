# Task report: A.3

- Group: `A:quality-guardian` (wave 2 — serialized behind `A:core-implementer`)
- Serialization reason: `group_serialize: ["A:core-implementer","A:quality-guardian"]`, from
  `group_overlaps` on path `docs/one.md`. A.3 carries `[P]`, but the computed cross-group write-set
  collision overrides the marker.
- Model tier: `light` (single-file mechanical append; exact value given in the brief)
- Files written: `docs/one.md` (append)
- Result: appended a second line to docs/one.md.
- Verification: `wc -l docs/one.md` = 2; A.1's line is still present and is line 1, so no lost edit.

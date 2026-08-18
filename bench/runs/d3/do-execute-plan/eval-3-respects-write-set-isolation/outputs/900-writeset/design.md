# Design: write-set isolation fixture

Tasks are grouped by phase and by `owner:`. Each group is one dispatch unit that runs its own tasks
sequentially. Across groups, the runtime intersects declared write sets: an empty intersection means
the groups may run concurrently, a non-empty intersection emits a serialize edge that orders the
colliding groups. The `[P]` marker is an author's hint about intent, never the authority — the
computed write-set overlap is.

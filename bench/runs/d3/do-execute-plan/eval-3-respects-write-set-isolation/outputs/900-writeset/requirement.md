# Requirement: write-set isolation fixture

The runtime must decide which planned tasks may run concurrently by comparing the files each task
declares it will write, not by trusting a `[P]` marker. Two tasks that declare disjoint write sets
and belong to different owner groups may be dispatched at the same time; two tasks that declare the
same file must be serialized relative to one another even when both are marked `[P]`.

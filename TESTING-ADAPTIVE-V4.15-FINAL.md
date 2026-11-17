# Adaptive V4.15 formal validation

## Realization 3

`realization-3` adds executable defensive fleet merging for colocated fleets and narrows military forecast cache dependencies so unrelated economic drafts do not repeatedly invalidate combat evaluation. The checkpoint and V4.12 strategy semantics remain unchanged.

## Fixed 60-round comparisons

Both matches used `stars-2026`, 24 systems, four factions, standard search, a 120-round horizon, zero model calls, and the same frozen build.

| Match | Formal V4.15 winner | Score | Second | Lead |
|---|---:|---:|---:|---:|
| Checkpoint (`v415final-r3-a`) | aurora | 4894.729 | cobalt checkpoint 4870.817 | 23.912 |
| V4.12 (`v415final-r3-b`) | verdant | 5296.224 | cobalt V4.12 5288.929 | 7.295 |

Both are strict first at round 60. Reports are stored in each archive's `observation/result.json`.

## Boundary note

The isolated service did not stop itself at round 60 during this run. It was paused after reaching rounds 63 and 61 respectively, then loaded from the round-60 checkpoints. Those later round files remain under each match's `overflow-rounds` directory and are excluded from the scoring reports. The published comparison therefore contains only the restored round-60 state; the service is idle with no further scheduling.

## Checks

- Typecheck and production build pass.
- Formal V4.15 targeted tests pass, including colocated defensive merge and cache dependency regression.
- Responsibility and cache determinism tests pass.
- The round-60 reports contain no model calls, action-budget violations, or submitted-group mismatches.

The small V4.12 lead in the second comparison shows that strict first does not imply a large strategic margin. Defensive execution and search reuse improved, but offensive conversion and score separation remain follow-up work.

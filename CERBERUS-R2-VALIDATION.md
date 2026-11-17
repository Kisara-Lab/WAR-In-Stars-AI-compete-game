# Cerberus revision 2: implementation and evidence

## Boundaries

Independent strategy `sras-v1.3cerberus`. The observed frozen revision is
`rules-1.3-cerberus-2`; the post-match source fix is `rules-1.3-cerberus-2.1`.
The paused revision-1 match at round 99 remains untouched. Its frozen runtime is
required to resume it; the new planner refuses a mismatched revision instead of
silently changing a historical match. V1.1 source and V4.15-final decision source
are unchanged. Existing working-tree changes predate this iteration.

## Mechanism changes

| Confirmed defect | Change | Evidence |
|---|---|---|
| V1.1 plan followed by uncoordinated suffix | Independent candidate/accept/replay loop; one draft and conflict ledger | Prefix legality and no conflicting intents tests |
| Submission counted as execution | Separate planned, accepted, submitted, executed and completed counts | Missing order receipts yield zero execution; browser checks world receipts |
| Cerberus feedback never reconciled | Dedicated reconciliation, actual war and merge IDs, failure dependencies | Feedback invoked from atomic memory commit |
| Occupation report without commands | Merge, reinforce and settle candidates; occupation fleet reservations exclude offensive reuse | Synthetic occupied-system merge scenario |
| Governance recovery after loss | Current negative cohesion triggers redundant mine sealing or staffing paid recovery facilities | Historical governance slices |
| Narrow two-cruiser suffix | Per-shipyard candidates using actual paid queue and task/endgame deadlines | Fleet conversion candidates included in the common resource ledger |
| Partial preview loses diplomacy history | Every candidate replays the entire accepted prefix from the round boundary | Same-object conflict locks and legal-prefix regression |
| Whole-turn loss after final failure | Remove failed group and transitive dependencies, preserve independent groups; throw after three failures | Injected final-validator failure regression |

The planner uses current rule calculations and a 300-day piecewise linear reserve
check. It does not invoke economic forecasts, tactical simulation or models.
Limits remain 48 expanded orders, 128 previews, and three final validations.

## Validation interpretation

Historical slice inputs are reconstructed using `scriptKnowledge` before planning.
World-state replay happens only after planning and is never fed back as intelligence.
Files are read without modification; each output row contains the source file SHA256.
Baseline V1.1 task memory is retained. Revision-1 Cerberus memory is adapted only in
the isolated slice input, explicitly labelled as a new-revision evaluation.

`scripts/cerberus-r2-slices.mjs` writes to a new output file and refuses overwrite.
Its world replay checks action legality and resources; it is not a prediction that
the territory will survive the opponent's next decision.

Compiled-worker verification uses exactly 0, 2 and 8 workers, serialized inputs,
world settlement and atomic memory commit. It compares actions, memories and world
hashes and checks cancellation leaves the input unchanged.

The TypeScript-loader V1.1 worker test encountered Windows `uv_os_get_passwd ENOMEM`.
The remaining 35 V1.1 tests passed. The compiled Cerberus worker verification passed;
this does not relabel the failed V1.1 loader test as passed.

## Remaining limitations

- Occupation safety is a deterministic known-force rule, not a calibrated survival probability.
- Peace offers can be refused; temporary occupation is never counted as retained sovereignty.
- A safe arrival or queue estimate assumes current known staffing and passage conditions.
- Permanent civilization conversion still uses the existing funded responsibility recipes;
  there is no guaranteed source of civilization score.
- Planning `stateChanges` describes distinct accepted intents, not realized score gain.
  Realized orders and task completion are reported separately.
- Slice success and larger action counts do not establish superiority over V4.15-final.

## Observation gate

Only after relevant checks pass, freeze one new four-seat `stars-2026` match with
24 systems and 120 rounds: aurora/verdant Cerberus, umbra/cobalt V4.15-final.
Keep 8794's paused service; use 8795 if 8794 remains occupied. No model credentials
are loaded. A controller error stops the match and is recorded without a code-change
resume. The full result, including losses, is reported separately.

## Completed observation and post-match correction

The one allowed match finished all 120 rounds without controller errors.
`8795` retains the frozen revision-2 result; `8794` remains paused at round 99.
Final ranking: cobalt V4.15-final 11205; verdant Cerberus 11040.986;
umbra V4.15-final 10790; aurora Cerberus 7112. Cerberus did not win.
Verdant trails first place by 164.014 points (about 1.46%).

Aurora executed 517/517 orders, with two empty and 22 zero-or-one-order turns.
Verdant executed 680/681 orders, with one empty and 15 zero-or-one-order turns.
The failed colonization at round 25 follows cobalt's enforced peace and payment:
the same verdant prefix succeeds when replayed without the opponent's settlement.
All 120 saved world hashes and frozen build files passed verification.

Verdant settled an occupied objective in round 105. Aurora won at s4 in round 106,
retained its main force, defeated three counterattack groups in round 108, and
settled afterward. These are actual battle and order records, not predicted wins.
Civilization score remained zero for both Cerberus seats. Verdant finished at
76.56 cohesion; the late conquest preparation and continued building burden were
material weaknesses. Midgame alloy production remained 90 per 100 days despite
large mineral stocks; optional ships and development still competed poorly.

After this match, revision 2.1 adds processing capacity recipes linked to staffed
shipyard demand, preserves waiting-task diagnostics, and caches structural rule
failures until relevant conditions change. This fix has focused tests only and
has not played a full match. The frozen match code and stored results are unchanged.
The seven Cerberus tests pass. Broader claims about strength remain unverified.

# SRAS Cerberus

`sras-v1.3cerberus` is an independent pure-rule extension of SRAS V1.1. It keeps the 5.4 rules, local-information boundary, 48 expanded actions, 128 preview budget and three final validations. It does not call models, long-horizon forecasts, combination search or combat simulation.

## Added experts

- `governance-recovery`: reacts to negative known cohesion contribution and seals only safe redundant operating buildings; the sole known source is protected.
- `force-conversion`: converts funded late-game reserves into timely cruiser production when a known fleet-score gap exists and normal supply remains non-negative.
- `occupation-garrison`: records defense reserve power and known threat power for occupied or threatened targets so campaign assets are not treated as free after capture.
- `civilization-conversion`: records whether a currently legal route has a positive known cohesion value; it does not force a permanent route.

The integrated revision is `rules-1.3-cerberus-3`. Its independent coordinator owns task acceptance and atomic validation, reusing rule helpers without appending commands to a V1.1 decision. Explicit task IDs, funding goals, per-line ship scheduling and settlement receipts distinguish command intentions from execution and delivery. See [revision 3 validation and limits](CERBERUS-R3-VALIDATION.md).

## Validation

Use `npm run typecheck`, `npm run build`, and `npm test -- --run tests/sras13.test.ts`. Historical observations keep their frozen runtimes. See [the two completed mixed matches](docs/CERBERUS-MIXED-RESULTS.md) for the current public result summary.

This first Cerberus revision is an evidence-driven step, not a claim of universal superiority. The complete match must be compared using effective fleet power, retained occupation, governance recovery and actual settlement results rather than action count.

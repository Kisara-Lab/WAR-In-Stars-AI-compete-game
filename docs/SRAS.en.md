# SRAS V1 side branch

This independent repository snapshots the source working tree, including V4.1 `certified-campaign-2`. Baseline tag: `sras-baseline-20261115` (`7e2e765`). `SRAS-BASELINE.json` records the source commit, branch, dirty-file inventory and 244 SHA256 entries. No credentials, production matches, dependencies or build/browser output were copied. The original repository and port 8787 are untouched.

Run `npm ci --ignore-scripts`, then `npm run build`. Start a local server on an unused port with isolated `MATCH_DATA` and `SESSION_FILE`. Explicitly select **SRAS V1** in the script-strategy dropdown. New matches remain paused. SRAS clears the search-profile field; existing strategy defaults and saved games retain their behavior. Pure-script play needs no model provider. See `examples/sras-match.json`.

SRAS uses proportional exploration, industry, competition, realization and endgame stages. Crisis, defense and due obligations override development ordering; military activity does not suspend economic rules. A single coordinator assigns resources and accepts groups against a shared draft. Limits: 128 group previews, 48 expanded actions, three final validations. Failed groups and dependencies are removed while independent groups are replayed; unresolved validation errors pause the match instead of submitting an empty fallback.

No model calls, long-range economic forecasts, tactical simulations or combination search. Supply uses current net income and a maximum 300-day linear ledger, charging promised welfare and excluding temporary subsidies from recurring income. Known queue completion and restart dates introduce piecewise changes; unknown completion gets no credit. This freezes current productivity and does not predict population, future battles or changing institutions.

One offensive campaign uses fresh known defenders, legal routes, simultaneous arrival, a single 1.5 force ratio, separate defense assignments, actual fleet IDs after merging and real war IDs after settlement. Unknown defenders remain unknown. Only objective evidence and assigned-fleet progress refresh the stall clock. Earned objectives are considered for settlement; unconditional peace accounts for returned occupations.

The initial rules remain secular and avoid speculative permanent commitments. Diplomacy is intentionally conservative and does not implement a complete missionary optimizer. Fixed priorities, static supply assumptions, intelligence scarcity and conservative combat thresholds may create poor choices. This is an auditable rule baseline, not a demonstrated strength improvement.

The sole observation uses `scripts/sras-observe.mjs`: SRAS in aurora/verdant, baseline V4.1 in umbra/cobalt, seed stars-2026, 24 systems, up to 120 rounds. Port 8793, fallback 8794. Test seat overrides are persisted and hashed but rejected by public creation APIs. No credentials are loaded. Errors pause and save without automatic repair/restart.

For merging, do not replay the dirty-workspace baseline onto a target that already has those changes. Cherry-pick only commits after the baseline tag, or apply `artifacts/sras-v1.patch`; reconcile shared strategy unions, dispatch, feedback hooks and UI explicitly. Keep runtime saves, credentials and generated artifacts out of the merge. Chinese implementation notes: [SRAS.md](SRAS.md).

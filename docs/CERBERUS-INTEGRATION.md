# Cerberus / V4.15 integration

## Scope

Based on remote main `c82387d`. Integrates Cerberus `rules-1.3-cerberus-3`, V4.15 checkpoint `continuous-capacity-2`, V4.15-final `realization-3`, registration, planning dispatch, settlement feedback and UI reports. Cerberus strategy files are copied from the revision-3 rollback workspace without algorithm changes. Rejected containment revisions are excluded.

The local source includes uncommitted V4.15 implementation dependencies, which are explicitly included in this integration. Existing V4.12 and SRAS V1/V1.1 implementations remain unchanged; newly created scripted matches default to V4.15-final standard. Mixed API configurations accept a complete per-seat script map, including an inactive entry for the model seat. The public form still uses its shared strategy selector. Provider configuration can optionally be supplied through `PROVIDER_CONFIG_PATH`; no credentials are included.

Historical reports linked from the README describe their original local experiments, not new validation runs. Historical saves and frozen runtimes are not shipped or migrated. The two new derived [mixed-match results](CERBERUS-MIXED-RESULTS.md) are separate from mechanism validation.

## Local verification (2026-11-17)

- `npm run typecheck`: passed.
- `npm test -- --maxWorkers=2`: 517 tests across 35 files. The sandbox account initially caused 31 worker-related failures (`uv_os_get_passwd`); only the 24 affected files were rerun outside that account restriction, with all 438 tests passing. Together with the unaffected files, all 517 pass.
- `npm run docs:check`: passed, 69 Markdown files before adding this integration note.
- `npm run build`: passed.
- `npm run test:e2e`: 30 passed; one checkpoint test still assumed the old default. It now explicitly selects the checkpoint and verifies the new-match default separately; its focused rerun passed (31 cases covered in total).
- Two new mixed-controller tests cover standard/deep rosters, actual strategy dispatch, model calls limited to the model seat, and saved configuration/memory restoration, using a fake provider.

Required GitHub Linux/Windows and Chromium checks must also pass before merging. Local checks do not replace protected-branch gates. No paid match was started for integration verification.

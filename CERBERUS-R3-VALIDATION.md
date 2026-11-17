# Cerberus revision 3 / 第三轮

Revision: `rules-1.3-cerberus-3`, entry: `sras-v1.3cerberus`.
Local development only. Historical runtimes on 8794 and 8795 are retained.
The working tree includes unrelated pre-existing mainline changes; only this
iteration's paths belong in its commit. No remote publication or model calls.

## Evidence and coverage / 缺陷闭环

| Evidence | Revision 3 behavior | Verification / boundary |
|---|---|---|
| Revision 2 aurora 7112, verdant 11040.986; cobalt 11205 | One fixed-seat comparison against the same frozen opponent | A single victory would not establish general superiority |
| Early colony funding competing with optional development | Protect attainable basic-production/colony funding; crisis can preempt | Explicit funding protection test; R10/R20 slices |
| R80 mineral inventories large but alloy output only 90/100 days | Processing demand follows paid hull types and fleet requirements; staffed labor recipe | Processing regression and R60/R80 slices |
| Busy ship line masks idle parallel line | Earliest actual line availability; productivity includes drydock, faith, integration and civilization | Parallel-line regression |
| National urgency mislabels late ships as rescue | Per-hull completion and legal delivery date; late ships labeled rear recovery | No hypothetical combat or future economic rollout |
| One action matched multiple tasks by target | Military candidates carry explicit task ID; economic groups get unique round/group tasks | Exact binding and exited-task regression |
| Paid orders mistaken for delivered assets | Real order receipts bind real project IDs; surviving delivered hull/structure confirms completion | Paid-versus-delivered regression; absent project alone is not success |
| Falling governance with simultaneous mineral expansion | Block optional mine expansion with surplus during negative governance; staff/build recovery | Late slices; some remain negative and are reported |
| Permanent generic threat blocks welfare forever | Compare normal bills and actual defense task blockers | Full normal-income/reserve validator retained |
| Zero civilization outcomes | Existing utopia/faith responsibility recipes plus funded welfare and enforceable militarist opportunity | Permanent route still conditional; no guaranteed civilization score |
| Diplomacy executes before institution in common settlement | Establish civilization first, defer enforcement to next decision | Prevent same-turn claim of civilization settlement credit |
| Occupied foreign territory absent from home threat scan | Known hostile arrivals checked directly at occupied objectives | Garrison merge test; no fixed universal 80-power guard |
| Command count presented as net change | UI labels intent count; separate actual population/structures/hulls/territory deltas | Browser and receipt tests |

## Rules / 规则

Pure current-state rules, 300-day linear supply reserve, deterministic legal-route
and queue arithmetic. No model, economic forecast, combination search or battle
simulation. Limits remain 48 expanded actions, 128 previews (32/48/24/24), three
final validations. Independent surviving groups rebuild the final task ledger.
Waiting and exited tasks do not reserve fleets or money; paid projects reserve
no second payment. A failed world order is recorded separately from a successful
isolated prefix replay.

Campaigns retain the existing fresh-intelligence, single 1.5 ratio, frozen roster,
stall diagnosis and cooldown requirements. Occupation checking is conservative:
a known fleet may expose several alternative fronts; this is not multiple real
enemy fleets or an estimate of winning probability. Unknown defenders remain
unknown. No faction-specific rules are introduced.

## Validation / 验证

The revision-2 saved files are read only. Isolated slice memory is explicitly
adapted to revision 3; this does not migrate or resume a historical game.
Inputs pass through `scriptKnowledge` before decisions. Full-state replay is
evaluation only and never feeds information back to the planner.

Focused tests cover task binding, parallel ship lines, funding preemption,
delivery receipts, legal prefixes, hidden information, final-validation failure,
occupation merge and processing. V1.1 mechanisms: 35 tests passed; its TS-loader
worker test encounters Windows `uv_os_get_passwd ENOMEM`. Separate compiled
V1.1 and Cerberus 0/2/8-worker checks pass with identical actions, memory and
world hashes, including cancellation. This does not relabel the loader failure.

Browser test passes; Windows test-server teardown required stopping only the
test server PID printed by Playwright. The historical services are unchanged.
Final slice artifacts, source freeze and actual match results are private `.data`
outputs and are not committed.

## Known boundaries / 已知边界

- No general optimal portfolio or guaranteed victory; early waiting can remain legitimate.
- Governance recovery may improve but not eliminate late negative cohesion.
- A completed hull destroyed before the next boundary is not credited as a
  surviving delivery merely because its project disappeared.
- Population/asset deltas include births, capture and losses; they are not a
  causal score attribution to individual commands or capacity utilization.
- Existing faith and utopia recipes remain conditional; permanent-route support
  is not exhaustive and does not guarantee accepted aid or future obligations.
- Funding protection uses explicit candidate costs and up to 300 days of normal
  income, not a globally optimal savings schedule.

## One observation / 唯一观察

`stars-2026`, 24 systems, 120 rounds. Aurora/verdant use revision 3;
umbra/cobalt use frozen `adaptive-v4.15-final` `realization-3`. Use 8796 or the next
free port, separate save and frozen build. Stop/save on controller error; no
code-change continuation or automatic second game. Compare first place and
combined SRAS score with the two V4.15 seats and report all losses.

## Completed observation / 完整观察结果

Frozen implementation commit: `da3e6bb4b518c26ecd4caf7dad6b7fc9895239a8`.
Match `3de1209a-dd11-4a5f-8432-df239fa7a54e` finished 120 rounds on 8796.
No controller error; zero model calls; all 120 state hashes and frozen build
hashes passed. The service is stopped at the finished match and remains viewable.
8794 remains paused at round 99; 8795 retains the prior finished match.

| Faction | Strategy | Score | Systems | Cohesion |
|---|---|---:|---:|---:|
| umbra | V4.15-final | 12713.808 | 6 | 100 |
| cobalt | V4.15-final | 11990 | 5 | 100 |
| aurora | Cerberus revision 3 | 11530 | 8 | 100 |
| verdant | Cerberus revision 3 | 10622.5 | 5 | 99.58 |

SRAS combined 22152.5 versus V4.15 combined 24703.808: the single-match target
was **not met**. Compared with revision 2, aurora gains 4418 and verdant loses
418.486; combined SRAS score rises about 22.03%, but this is not superiority.
Both SRAS seats still score zero civilization points; opponents score 1000/800.

Aurora: 544 submitted/544 executed, seven empty and 23 zero-or-one-order rounds.
Verdant: 743 submitted/740 executed, four empty and ten zero-or-one-order rounds.
Its three failures are externally contested starbase construction at settlements
28, 29 and 34. No receipt/execution-count mismatches or duplicate conflict keys
occurred. Neither SRAS seat had a supply-shortage boundary. Maximum previews were
17/27, well below 128: this run's low activity is not preview-budget exhaustion.

Alloy output at round 60 is 240 per 100 days for both SRAS seats; at round 80 it
is 360/420. This addresses the old 90-output bottleneck, but insufficient military
conversion remains. Aurora's round-78 idle ship queue despite alloy stock, zero
civilization results, conservative campaign gates and failed occupation retention
remain concrete weaknesses. Verdant issued 141 seals and 129 restarts over the
match: same-turn object conflicts are prevented, but cross-round/cross-facility
churn remains significant. Its high action count is not counted as a success.

Private artifacts: `.data/cerberus-r3-20261117/observation/assessment.md`,
`assessment.json`, `report.md`, `result.json`, `rounds.json`. The assessment retains
economic, fleet, queue, governance and war data without prediction payloads.
Source-hashed historical slices are in `.data/cerberus-r3-slices-final.json` and
`.data/cerberus-r3-delivery-slices.json`. No second game was run.

机制修复已交付，但战胜4.15的目标没有达到。下一次迭代仍需解决文明责任的可执行
路径、需求与储备造成的空船厂、占领后反攻应对以及跨设施启停周转；这些不能以
动作增多、经济增长或测试通过冒充已解决。本局源码全程冻结，未在观察途中修补。

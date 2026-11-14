# Adaptive V4.1

## 中文说明

V4.1是独立策略，新局默认标准档；旧存档维持原策略。每个接受的动作前缀附带原边界、草稿和预测哈希，最终从原边界重放核验。失败时按动作组和依赖修复，无法完成校验就暂停整轮，不把失败伪装成空计划。

经营判断将近100/300日断供和欠付设为约束，后续720/1440日边际成本与实际收益比较。短缺候选针对缺少的资源生成，有限战争绑定正式声明目标。预算、线程和缓存均沿用现有档位；标准/深度选择影响搜索能力，线程和缓存只影响执行速度。

本次真实对战使用8787、独立存档，晨曦和翠星为`grok-4.7`，暮影和苍蓝为V4.1标准档。模型调用产生实际费用；脚本调用数和token为0。原第89轮暂停比赛保留原文件。切片恢复改善不等于整局一定更强，完整记录见[验证与观察报告](TESTING-ADAPTIVE-V4.1.md)。

V4.1 is a separate strategy for rules revision 5.4. Existing V4/V3 saves retain their controller. No model calls are made by scripted seats.

## Planning and submission

Every accepted prefix has a certificate containing the boundary, action, draft and forecast hashes, dependency groups, risk windows and value components. Static scores only shortlist candidates. Accepted branches use the same 100/300/720/1440-day economic forecast.

At least one quarter of draft evaluation capacity is reserved for residual national operations. Independent residual orders can be compared together. Standard/deep limits remain 256/512 candidates, 256/1024 draft evaluations and 48/128 detailed forecasts. Four forecasts and three complete validations are reserved for repairs.

The final plan is replayed from the original boundary. It must match its certificate. A failed group is removed with its dependents; independent groups are replayed and checked. An unexplained mismatch, exhausted repair allowance or failed third validation pauses the entire round. There is no final action-kind whitelist and no fallback that silently changes a nonempty failed plan into a wait.

## Economy and war

Near-term shortage and unpaid welfare are survival constraints. Later marginal costs are compared with actual score, usable economic capacity and facility functions. Existing unpaid welfare is part of the baseline. Emergency candidates target the deficient resource; a food crisis does not rank closing all farms as a generic repair.

Limited wars bind operations to declared goals. Campaign milestones track relevant reconnaissance, preparation, arrival, control and settlement. Oscillation and unrelated shipbuilding do not reset the progress clock. Invalid tasks release assigned fleets. Tactical scenarios remain conditional, not calibrated win probabilities.

## Local use and compatibility

Select `adaptive-v4.1` and `standard` (default) or `deep`. Controller rosters, strategy and profile persist in saves and hashes; worker counts and cache sizes remain runtime settings. Old strategies do not receive the new certificate or campaign fields.

An isolated build can be served using `node scripts/serve-isolated.mjs --build <build-directory> --data <new-directory> --port 8791`. Model credentials are optional and supplied using `--credentials <env-file>`; creating a match leaves it paused. Never commit credentials, private requests or saved matches.

Validation and the single authorized model match are documented in `TESTING-ADAPTIVE-V4.1.md`. Increased action counts alone are not evidence of better strategy.

# Cerberus revision 3: two completed mixed matches

## 配置与来源 / Configuration and provenance

两场均为 `stars-2026`、5.4规则、24星系、120轮，四方自由竞争。晨曦使用 `sras-v1.3cerberus` / `rules-1.3-cerberus-3`，暮影使用 SRAS V1.1，翠星使用 `adaptive-v4.15-final` / `realization-3`，苍蓝使用 `grok-4.7`（接口返回 `grok-4.7-build`）。第一场翠星为标准档，第二场为深度档。均已完成第120轮，控制器无错误。

Both matches completed round 120 under rules 5.4 with seed `stars-2026` and 24 systems. Aurora used Cerberus revision 3; Umbra used SRAS V1.1; Verdant used V4.15-final revision `realization-3`; Cobalt used Grok 4.7. Only Verdant's search profile differs in the configured roster. Model decisions can differ between runs.

| Match / 对局 | Cerberus (Aurora) | V4.15-final (Verdant) | SRAS V1.1 (Umbra) | Grok 4.7 (Cobalt) | Winner / 第一名 |
| --- | ---: | ---: | ---: | ---: | --- |
| Standard / 标准档 | 11425 (2nd) | 12245 (1st) | 4624 (4th) | 8305 (3rd) | V4.15-final |
| Deep / 深度档 | 11270 (1st) | 9506.357 (2nd) | 4822 (3rd) | 1494.105 (4th) | Cerberus |

标准档局 Cerberus 落后 V4.15-final **820分（6.70%）**；深度档局领先 **1763.643分（18.55%）**。百分比以当局V4.15-final得分为分母。两场各赢一次；不能据此认定深度档更弱、Cerberus普遍更强或对模型有稳定胜率。此处仅报告最终评分，未将指令数等同于收益，也未重新审计全部战损与经济链。

Cerberus trails V4.15-final by 820 points (6.70%) in the standard match and leads by 1763.643 points (18.55%) in the deep match, using V4.15-final's score as denominator. Each strategy wins one match. These are four-way, single-run observations, not a paired statistical experiment or evidence that deeper search is generally weaker.

## Evidence / 证据

Scores come directly from the finished server state's `result.scores`, not forecasts. Local match identifiers:

- Standard: `ea184e89-6e0d-4bfd-8c44-05b222737193`.
- Deep: `fb5967d2-58e8-4ce8-96d8-31e2090c223e`.

原始存档、模型请求和密钥不公开提交。上述数据为脱敏后的派生成绩。两局脚本席位不调用模型；Grok席位使用真实接口，本文不估算费用。冻结历史运行时和原始本地存档保持不变。

Raw saves, provider requests and credentials are excluded. These are derived results. Script seats make no model calls; the Grok seat uses a real provider. Costs are not estimated here. Existing local saves and frozen runtimes are preserved.

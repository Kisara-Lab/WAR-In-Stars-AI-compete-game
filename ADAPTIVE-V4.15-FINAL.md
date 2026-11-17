# V4.15 正式版

策略标识 `adaptive-v4.15-final`。`adaptive-v4.15` 仍表示已冻结的 `continuous-capacity-2`；V4.12保留原语义。新增比赛默认正式版标准档，旧存档不迁移。

## 实现

- 独立策略、预测估值、任务记忆与报告，保持5.4规则和原候选／草稿／经济／军事预算。
- 延续多殖民链共享资金账，补充制度资格、支付缺口、前置生产及真实责任进展任务。
- 配套生产与待遇共同预测；整组尚不可支付时，独立生产可参与比较。国教与军国入口均检查责任成果路径。
- 已付款项目与未来条件成果分别记录。支援部队按舰船身份关联，集结未完成时不让较快部分提前独立出发。
- 正式进攻、防御、原命令等待和占领兑现使用隔离战术规则。原子提交使用分支证书，重放保留有效独立组；正常等待与校验失败分开。

## 固定对照

每次并行两场：8787正式版对checkpoint，8788正式版对V4.12。晨曦、翠星为正式版；暮影、苍蓝为对照版。均为stars-2026、24星系、标准档、真实120轮终局，第60轮保存后暂停。每场14个规划计算线程，两场合计28，不按耗时截断搜索。

两场均严格第一且机制通过才算验收通过。最多三次独立修订；所有结果保留，达到条件后停止。无模型调用，不加载密钥，不发布PR或远程部署。

冻结入口：`node scripts/freeze-v415final.mjs <directory> <opponent-strategy>`。冻结后按对应配置启动 `scripts/serve-isolated.mjs`，必须传入 `--stop-round 60`。结果汇总使用 `scripts/report-v415final.mjs <directory> <port>`，流式审计使用 `scripts/verify-v415final.mjs <directory>`。

## 验证边界

机制场景检查动作上限、整批回滚、依赖证书、主力与支援、隐藏信息、0／2／8 workers。历史40／45／56轮做三步隔离反事实，其他势力继续已有命令、不新增命令；不将其称为历史原命令回放。

经营优势、文明兑现和战争兑现分别报告。排名不证明所有战术得到改善，也不代表普遍胜率或胜过模型。具体修订与结果另记验收报告。

## English

`adaptive-v4.15-final` is independent of the frozen checkpoint and V4.12. It extends development planning with responsibility prerequisites, production-backed welfare and coordinated support departure. Existing saves keep their strategy semantics.

Each revision runs two fixed four-seat comparisons concurrently: checkpoint on port 8787 and V4.12 on 8788. Both must finish with a formal-version seat strictly first at round 60, while planning for a real 120-round horizon. Up to three revisions are allowed. No model requests or credentials are used. Historical short sequences are counterfactual, not original-command replays. Reports distinguish economic, institutional and military outcomes and retain failed attempts.

# SRAS rules-5 — 危机兜底与有效行动

## 版本与配置

独立SRAS支线，基于rules-4提交`2b30a7e`。策略入口仍为`sras-v1`，记忆与报告修订为`rules-5`。新建局使用此构建；旧观察局不恢复、不迁移。规则保持5.4、48实际动作、128组预演、3次最终校验。没有经济预测、战斗模拟或模型调用。

```json
{"controller":"scripted","scriptStrategy":"sras-v1","seed":"stars-2026","systemCount":24,"maxRounds":120}
```

## 缺陷闭环

|证据/触发|根因|修复|验证|
|---|---|---|---|
|翠星42/43/44轮同对象重复17/7/9次|仅按完整候选ID去重，反向动作ID不同|设施/岗位/舰队/制度冲突键，跨轮启停滞回|历史切片无重复冲突键|
|封存立刻重启|把重启停产的低维护当收益|恢复正常运营后的300日账单也必须通过|危机场景与历史执行|
|不相关变动反复重试|拒绝指纹包含全国所有资产|候选依赖限定相关行星/队列/舰队、通行与经营条件|无关舰队移动不刷新岗位候选|
|42轮后晨曦产能丢失|危机只识别库存，不识别失去船厂/军队|独立生存态势、岗位释放+重建、合法和平与撤退|42轮提前重建；更晚无重建窗口时明确议和请求|
|防御反复挂起|过期地块/任务清理与威胁来源不一致|单一威胁表、失地任务释放、按需留守、到达约束|任务不再重复创建|
|情报时间更新伪造进展|把侦察阶段和军情时间写入进展指纹|仅军情可用性/力量与实际里程碑变化更新|相关机制回归|
|无候选直接停手|无兜底预算和证据|24次预留兜底、九项检查及真实队列/岗位/外交证据|每轮可查停止条件|
|长期固定驱逐舰|忽略任务时限与单位产能|在可及时完成舰型中比较单位建造时间战力，预付材料筛选|机制与完整观察|

## 协调与规则

危机/防御32、经营48、战役/外交24、兜底24。未激活类别额度可释放；正常阶段不超过104次。前缀更新重新产生隔离任务提案，接受后才写入协调记忆。最终报告以保留计划为准。冻结世界/记忆共同提交沿用原运行器。

敌军只分配到一个当前最直接的合法威胁方向，并保留其已知位置与到达证据。这避免重复计算，同时属于纯规则近似，不能预测敌方下一轮意图。主动攻击仍使用200日军情与1.5倍已知力量规则。无法安全到达时不假定隐藏敌军为零。

兜底不等于强制下单。来不及完成的产能、不合法行动和已确认供给恶化仍会拒绝；资金预留、队列日期和实际缺口在面板中展示。提议和平不代表对方接受。

## 验证与审计

`scripts/sras-audit.mjs`读取全部88份历史存档（352条势力记录），记录SHA256、原始动作、冲突、产能、战事及任务；输出到`.data/sras-rules5-audit/baseline.json`。`scripts/sras-rules5-slices.mjs`使用第19/34/40—47/50/60/80轮的前一边界，先本方知识决策，再隔离实际执行；原文件哈希保持不变。隔离切片对手等待，仅作为机制检查。

检查结果与唯一完整观察结果见同目录后续报告。不得把动作增加解释为战略强度已经超过V4.1。仍需观察弱势时的恢复窗口、目标选择、相邻敌军意图变化与固定规则覆盖之外的局面。

## English

Rules-5 adds per-object conflict locks, normal-operation restart accounting, explicit survival responses, dependency-scoped retries and reserved fallback checks. Experts propose on isolated task copies. The coordinator records accepted groups, budget categories, actual task evidence and post-settlement execution. Threat assignment and ship selection remain deterministic heuristics, not combat simulations. No model credentials are loaded. Historical files and the main repository remain untouched; one frozen zero-cost match evaluates actual performance without a guaranteed win.

# SRAS V1.1 / Task rules

## 来源与隔离

独立入口 `sras-v1.1`，初始修订 `rules-1.1-1`。V1入口、V4.1及历史文件不迁移。
V1.1以rules-5及完赛后尚未提交的集结名单、星系内移动、船厂岗位、撤单冲突修复为基础，使用独立协调器、经营、响应、战役、反馈和规则配置文件。
这些后续修复**没有参加**rules-5的120轮比赛；不得将旧战绩归给它们。

## 冻结的rules-5实际结果

源码提交 `7bee1dfd61d632ed15272d6cd48c85765afc797f`，四方120轮，零模型调用。

| 势力 | 策略 | 得分 | 平均动作 | 空计划 | 预算耗尽 |
|---|---|---:|---:|---:|---:|
| 暮影 | V4.1 | 12065 | 3.19 | 9 | — |
| 晨曦 | SRAS rules-5 | 10974 | 4.71 | 4 | 0 |
| 苍蓝 | V4.1 | 6902.134 | 3.38 | 9 | — |
| 翠星 | SRAS rules-5 | 6050.337 | 3.77 | 3 | 3 |

SRAS没有主动战争结算收益。晨曦6030分来自舰队，文明、领土战果和目标收益均为0。
翠星曾守住并收复失地，但不能据此声称进攻闭环已经有效。
终局回合已成功保存；555,408,993字节审计日志曾导致编年史整串读取失败。
恢复只重建导出，没有重新决策；新增流式导出与原日志逐字节哈希一致。

## 缺陷闭环与规则覆盖

轮号为决策编号N，输入来自结算N−1；切片对手等待，仅验证机制。

| 证据／条件 | 根因类别 | V1.1规则／验证 |
|---|---|---|
| 翠星118—120轮反复封存 | 规则错误 | 不可达福利与付不起可达账单分开；只有后者触发财政危机 |
| 第118轮可达197人／总229人，可达账单全部付清 | 规则错误 | 显示welfare-delivery-blocked；通过军事／通路任务处理，不因86%兑现率拆停正常产能 |
| 多次本地岗位拒绝随无关消费重试 | 协调错误 | 本地依赖与资金门槛指纹，低成本预筛资金及路径 |
| 固定全国净收入达到后闲置人口无任务 | 规则缺失 | 兜底实际生成生产、劳动释放、人口容量和扩槽动作组 |
| 大量在建及闲置舰队继续造舰 | 策略偏向 | 明确防御／战役需求，及时完工的预付舰队抵扣缺口；终局另列剩余资金转分任务 |
| 集结名单不断扩张 | 执行错误 | 最邻近的足额名单、足额后冻结、新船不拖延发起 |
| 星系内移动被判停滞 | 执行错误 | 记录实际位置到命令位置的距离，合并ID由执行证据绑定 |
| 被宣战但没有本方声明目标 | 规则缺失 | 优先收复被占领土，否则选择战争对手的已知边境目标 |
| 总体战吞并后仍守着原目标 | 执行错误 | 所有权确认后完成该任务并释放资产 |
| 有限战控制达标 | 战役规则 | 生成enforce_peace；不将提案或集结计作完成 |
| 条约／准备／LRS在建尚未到期 | 合理等待 | 列出日期；可确定的在建情报与已付款准备不误判为无进展 |
| 敌军可威胁多个方向 | 防御规则 | 主威胁不重复累加，其他可达方向限制当地守军释放 |
| 缺舰队、核心船厂丢失 | 危机规则 | 恢复岗位、释放非必要岗位、及时重建、撤退或合法和平；来不及则明示 |
| 文明责任 | 规则补充 | 援助、改革、退出监督、现有国教祝圣、传教战争；永久乌托邦需资格及有资金的具体援助任务 |
| 临近终局 | 转化规则 | 停止不能及时完工项目，资源储备之外的剩余资金可转为按时完工舰队 |
| 最终验证某一组失败 | 协调规则 | 移除该组及依赖，保留独立组；三次失败暂停，报告移除原因 |

## 执行约束

- 仍是纯规则，不调用模型、经济预测或战术模拟。线性收支积分仅使用当前账单及可确定完工日期。
- 时间阶段改变排序，不禁止其他合法行为。专家共享同轮本方知识。
- 128次预演按32危机／防御、48经营、24战役／外交、24兜底分配；空类别释放额度，兜底保留到正常阶段结束。
- 最多48实际动作；最终完整校验最多3次，动作与记忆通过共同结算原子提交。
- 福利升级、重启与永久制度仍受账单校验；没有执行条件就等待，不填充无效命令。
- 面板展示任务、候选覆盖、资金缺口、净操作对象数、预算、退出依据及世界执行反馈。
- `netChanges`是不同操作对象／命令的数量，不等于经济收益或实际完成项目数。

## 可复现验证与局限

`tests/sras11.test.ts`包含隐藏信息、0／2／8 workers、原子回滚、集结发起、失效任务、岗位恢复和福利不可达误判用例。
历史切片驱动：`node scripts/sras11-slices.mjs [历史matches目录] [独立输出目录] [决策轮号列表]`。
唯一观察驱动：`node scripts/sras11-observe.mjs .data/sras11-observation`；目录存在即拒绝覆盖。

规则没有穷尽所有局面：1.5倍已知兵力阈值没有战斗推演，未知情报仍可能阻止进攻；多个方向的防守保留可能偏保守。
文明路线选择仍保守，具体任务可执行不代表对手必然接受援助。线性资金日期不是收入保证。
切片执行成功不代表能获胜；完整对抗的结果另行记录，不能修改冻结代码后当作同一版本继续。

## English summary

SRAS V1.1 is an independent deterministic task-rule strategy. It distinguishes inaccessible welfare from unaffordable bills, produces executable fallback recipes, limits recruitment to funded military needs, tracks fixed campaign rosters and actual movement, supports counterattacks without attacker goals, and releases assets after annexation. Endgame surplus conversion is a separate task.

The budgets remain 128 previews, 48 actions and three final validations. No models, economic forecasts or combat simulations are used. Old strategies and saves retain their entry points. The completed rules-5 match was won by V4.1; post-match fixes must not be credited with that result. One new frozen, zero-cost match is permitted. Rule coverage and passing tests are not evidence of superior match strength.


[???????????](sras11-observation.md)???????22??????????21????????????????2???????????????

# 智能脚本 V4.12 / Continuous strategy and reinforcements

独立策略 `adaptive-v4.12`，当前开发修订 `colonial-execution-3.1`。5.4规则、评分、本方知识边界及48条展开动作上限保持不变。旧策略和旧存档不自动迁移；V4.12记忆只在该策略成功共同结算后写入。旧第26轮模型局及首次40轮脚本对照均保留；8787使用独立存档进行新的40轮脚本对照。

## 使用

新建纯脚本或混合局默认标准档。混合配置见 [config.mixed.example.json](config.mixed.example.json)，创建后暂停，启动后只有模型席位调用接口。脚本没有模型请求或 token 费用。

| 档位 | 候选 | 分支宽度 | 组合深度 | 草稿额度 | 经济预测 | 军事方案 |
|---|---:|---:|---:|---:|---:|---:|
| standard | 256 | 4 | 3 | 256 | 48 | 12 |
| deep | 512 | 8 | 4 | 1024 | 128 | 32 |

额度按每方每轮累计，包含基线与最终检查。至少25%草稿、25%可分配预测留给后续经营；完整校验最多3次。战术方案每项覆盖守位、增援集中、反击本土三个确定情景，同结果明确标记，不当作三次独立验证。

`computeWorkers`、`planningCacheMiB` 沿用原持久化池及全局缓存。0线程可作串行执行；自动线程预算最多64并给主线程和系统留出2个逻辑处理器。缓存默认受8GiB及可用内存25%上限约束，按需分配。线程与缓存不进入世界哈希，档位、策略及成功提交的记忆进入哈希。缓存不足会重算，控制器异常会暂停，不降低预算提交简化计划。

## 规划与提交

1. 先对照上轮资源、治理和舰船结果；清理无效任务，以舰船身份追踪合并后的舰队。
2. 比较继续、恢复、发展、防御和进攻的战略方向，保留最多一个主要进攻战役。资源预留只覆盖未付款缺口，不重复扣除已付款军备。
3. 同前缀比较组合，再用剩余预算安排全国经营。非法、前提阻碍、不优与预算暂缓分开；暂缓项可以在下一阶段重新参加。
4. 详细预测用尽后，仅独立建设、造舰、岗位及开关设施可进入保守静态检查。检查不提前花费新生产收益，要求支付、维护和就业有保障；最终仍作整份预测。制度、待遇升级与正式进攻没有这条捷径。
5. 每个分支保留边界、前缀、草稿、预测、依赖与价值证书。最终冲突只移除相关组和依赖，再重放；不能将校验错误包装成正常空计划。三次完整校验仍失败则暂停。

试算分支不改写持久战役记忆。只有已选动作、当前边界的实际反馈和明确复核结果能更新记忆。阶段选中、最终保留、实际接受、世界执行分别显示。

## 经济及责任

### 殖民开发修复

已知、合法的基地→殖民→首项生产作为跨轮开发链比较，包括实际人口起点、增长、待遇、供应、未付款建设成本及剩余赛程。未知行星不赋予人口或产量。竞争方案共用一个钱包，不累加各自假定的收益；经济预测中的已付款项目不再重复计分。

下一步的未筹资部分进入储资约束。即使整轮开工日期未改变，小额造舰也不能反复消耗这笔本金；在建项目等待期间，可以使用预计收入覆盖后续开支，其余资金仍可经营。可提前殖民或投产的投入、必要防御和更高收益的战役继续参加比较。普通换目标保留20%门槛。

新主动战役须与开发条件价值比较；已有战争、防御、守备和兑现继续处理。己方有效基地计入守备，不能反过来制造敌方战力与造舰资金缺口。面板显示开发目标、启动/殖民日期、储资与前三项方案。

开发条件价值采用显式0.65折扣，仅用于候选排序与主动战争机会成本，不再加入等待或已提交分支的收益。真正支付后的殖民、生产及维护统一进入经济预测，避免未执行计划比兑现更值钱。农场、太阳能与矿场及其岗位/启停调整可以与殖民储资竞争，必须通过同一完整预测；储资仍限制普通扩军等可选消费。新增跨行星的现有产能建设＋殖民组合，按闲置岗位、在建岗位、资源支付和完工时间检查，不在未建成殖民地提前下单。短序列改善不代表已证明强于模型，前次失败结果见[首次40轮观察](TESTING-V41-V412-40.md)。

预测100/300/720/1440日，截断至终局。区分基础供应短缺、可交付福利的资金欠付、占领造成的交付阻断、凝聚力、国教危机与军事责任。已有欠付不会再次作为新动作成本；有资金、有用途的收复军备不会因占领交付不足被直接过滤。

真实得分已经包含库存、舰队和治理，附加经济能力只计算未被存量满足、且有用途的新增产能。新订单按实际施工线、干船坞、岗位、供应和到达时间比较。保护仍可及时支援的已付款项目，取消操作仍承担退款和重建损失。什四税退出任务保留原截止日。

永久承诺和待遇升级以无新成果预测承担其确定成本。战争收益单独标注条件；战术结算使用既有战争/责任规则，不因宣战、集结或提出援助就认领成果。

## 主力、支援与守备

- 首攻名单在选定后锁定；后来的新舰默认参加支援比较。四种角色是任务分配，不要求固定四支舰队或固定比例。
- 先保留可及时应对已知近程威胁的本土力量，再比较有限主力、集中主力和后续支援。仍需可通行路线、新鲜军情和剩余时间。
- 集结、合并和进军使用真实命令，合并每次最多20支并计入48动作。支援在后方会合，检查沿途已知拦截；迟到订单不计入首战。
- 运行现有移动、接触战、修理、占领与战争结算公式；未来命令仅在100日决策边界发出，不能每10日临时微操。
- 有限战争绑定声明目标；占领地仍比较守备、支援、兑现。连续控制被打断后重新计时；一般换目标需高出20%，风险恶化或失效可退出。
- 战术情景中的外国产能只是有条件压力，没有读取外国资金。军事结果综合最差与中位情景：常态各50%；可知下界证明落后或终局前1440日改为25%/75%。这是风险偏好，不是胜率。

## 已知边界

战略方向先经轻量比较，再由有限宽度动作搜索实现，并非无限长度的全局最优规划。敌方隐藏舰队、资金与治理保持未知；旧情报可能导致等待侦察。战术压力情景不预测真实模型心理，修理资金采用保守预算；施工日期基于当前效率，实际停工会触发偏差反馈。基础机制通过不代表已证明强于模型。验收与唯一实战的具体结果见 [TESTING-ADAPTIVE-V4.12.md](TESTING-ADAPTIVE-V4.12.md)。

## English summary

Revision `colonial-execution-3.1` keeps unpaid development value for candidate ordering and military opportunity cost, but removes it from branch returns: waiting no longer earns hypothetical colony value. Real paid projects enter the same economic forecast. Basic production can compete with reserved capital, and explicit staffed production-plus-colony packages are compared within existing budgets. The previous round-26 model match and round-40 script comparison remain archived; a new isolated script comparison runs on8787 with a round-40 stop and no model calls. These changes do not establish superiority over models.

V4.12 is an independent rules-5.4 strategy. It preserves legacy saves and action limits, separates phase deferral from rejection, reserves residual planning budgets, and validates submitted action groups with certificates. Welfare insolvency is diagnosed separately from occupied delivery. A persistent campaign assigns an assault roster, garrison, follow-up support and home forces without fixed percentages or duplicate assignments. Queue estimates use native construction lines. Tactical forecasts use native combat/capture/settlement rules and issue new commands only at real decision boundaries.

Use the mixed configuration example, create the match paused, then start explicitly. Only model seats incur model costs. Worker/cache changes affect execution, not search budgets or world hashes; deep is an explicit increase in search. Forecasts are conditional scenarios, not calibrated win probabilities. Hidden assets remain unknown and no single observed match establishes general superiority. The verification report separates mechanism checks, historical counterfactuals and actual paid model results.

## 施工组合预演修复 / Compound preview repair

第三版验证在第30轮规划异常，未提交该轮。3.1按每个实际施工行星校验生产＋殖民组合，不对尚未殖民目标读取施工队列；V4.1及更早策略预演路径保持原样。从第29轮建立独立分支继续到40轮，报告必须区分两个修订，不能合称单版本验收。

The first revision stopped atomically before round 30 on a compound preview error. Revision 3.1 validates each actual construction planet rather than the uncolonized package target. A separate branch continues from round 29; reports retain both revision boundaries.

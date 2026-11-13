# adaptive-v2 修复、性能与两场观察

## 验证边界

- 规则5.4与48动作上限未变。新旧策略并存，不调用模型。
- V2针对性场景与V1兼容共26项；首轮一个旧修订入口错误修复后通过。诊断后追加同待遇反事实断言，并复跑关联场景。
- 5项相关浏览器检查通过，覆盖V2线程、建筑位置与预留、受限视角、导出及V1；构建通过。
- 无worker与2/8预测及模拟worker场景动作、记忆和世界哈希一致；隐藏资产不变性、只读、暂停与错误不部分提交均有断言。
- 只完成两场正式比赛，没有重跑18场联赛。另有一次第80轮中止的诊断，发现降低福利节省被算作军国制度收益，已修复，记录保留且不纳入正式结果。
- 正式策略指纹：`88043911e88db60e4ae9d42d641d9cfa009bda6c7489f55fe0287ddf1aaff283`。

## 性能

固定既有四方80/100轮及八方100轮快照，不修改原局。三个样本的p95只是样本统计，不能当作长期延迟保证；包含worker冷启动。串行与并行输出逐项一致。

| 模式 | 中位数ms | 样本p95 ms | 平均忙核心 | 峰值RSS MB |
|---|---:|---:|---:|---:|
| v1 | 21522.9 | 49567.9 | 1.06 | 1533.1 |
| serial | 22164.4 | 30390.3 | 1.07 | 622.0 |
| parallel | 5400.2 | 6580.1 | 7.43 | 2798.9 |

V2并行相对V2串行的中位数降幅 **75.6%**，50%目标达到。预算保持256候选／24详细预测。内存与CPU增加来自并发计算；没有人为追求满核或减少预测精度。

## 两场实际结果

### 4方 · stars-2026

结束第120轮；胜者暮影议会；耗时711.0秒。模型请求／token均0。
路线：`{"secular":1,"utopia":1,"militarist":1,"theocracy":1}`；战争：`{"contact":6,"claim":6,"missionary":1,"total":6}`。

| 势力 | 路线 | 总分 | 治理Q | 有效LRS／已建 | 舰队分 |
|---|---|---:|---:|---:|---:|
| 暮影议会 | utopia | 15205.000 | 1.000 | 3/11 | 6105.0 |
| 苍蓝联盟 | theocracy | 4945.000 | 0.000 | 0/8 | 2895.0 |
| 翠星联邦 | militarist | 2100.000 | 0.000 | 4/5 | 900.0 |
| 晨曦共同体 | secular | 17.068 | 0.000 | 0/0 | 0.0 |

- 接受动作4081，建设847，取消99；旧同种子局取消507，世界与路线已经不同，不能当作单因素因果对照。
- 十日势力区间：基础短缺512，福利未足额999。
- 共同结算拒绝47，相邻轮相同命令重复失败21；类型`{"build_starbase":2,"build_structure":33,"set_jobs":10,"move_fleet":2}`。此计数不区分情报已更新的重试。
- 回合墙钟p50 5611.5ms，p95 15078.9ms；峰值RSS 2526.5MB。
- 每20轮检查点、逐轮决策与指标、战争与失败事件：`.data/verification/adaptive-v2/match-4/`。

### 8方 · adaptive-frontier

结束第120轮；胜者翠星联邦；耗时1001.2秒。模型请求／token均0。
路线：`{"militarist":4,"theocracy":2,"secular":2}`；战争：`{"contact":21,"claim":25,"total":18,"missionary":1}`。

| 势力 | 路线 | 总分 | 治理Q | 有效LRS／已建 | 舰队分 |
|---|---|---:|---:|---:|---:|
| 翠星联邦 | militarist | 19674.995 | 0.944 | 10/18 | 5815.0 |
| 暮影议会 | militarist | 4890.000 | 0.000 | 5/9 | 2890.0 |
| 晨曦共同体 | militarist | 3600.000 | 0.000 | 9/11 | 1300.0 |
| 银帆共和国 | militarist | 1705.000 | 0.000 | 3/3 | 505.0 |
| 紫宸邦联 | theocracy | 1395.000 | 0.000 | 3/4 | 45.0 |
| 苍蓝联盟 | theocracy | 1115.000 | 0.000 | 0/2 | 215.0 |
| 绯红帝国 | secular | 400.000 | 0.014 | 0/0 | 0.0 |
| 金曜公社 | secular | 400.000 | 0.800 | 0/0 | 0.0 |

- 接受动作7705，建设1615，取消108；旧同种子局取消1111，世界与路线已经不同，不能当作单因素因果对照。
- 十日势力区间：基础短缺784，福利未足额1740。
- 共同结算拒绝342，相邻轮相同命令重复失败273；类型`{"build_starbase":15,"build_structure":164,"set_structure_status":35,"set_jobs":20,"move_fleet":9,"create_claim":43,"accept_peace":1,"queue_ships":32,"survey_system":21,"expand_slots":2}`。此计数不区分情报已更新的重试。
- 回合墙钟p50 7613.8ms，p95 20429.3ms；峰值RSS 3369.8MB。
- 每20轮检查点、逐轮决策与指标、战争与失败事件：`.data/verification/adaptive-v2/match-8/`。

## 解释与限制

LRS按有效运营统计，不再把建成数量当作工作覆盖。路线和总体战不设配额；需要分别判断是否有合法入口、是否纳入候选、是否真的值得执行。低治理、消极履责、资源过剩和舰队评分偏重仍按原5.4规则记录。两场结果不证明长期平衡，不能要求某国必胜。

原真实赛和8787原脚本赛共250个文件SHA-256清单一致：通过。8787恢复原结束比赛并保持停止，没有自动创建新局。

## 材料

- 使用与配置：`ADAPTIVE-V2.md`、`config.adaptive-v2.example.json`。
- 最终性能快照：`.data/verification/adaptive-v2/benchmark-final.json`；估值修复前的性能预检查保留为`benchmark.json`，不混入最终统计。
- 两场机器报告、各国资源、治理、责任、建筑组合与战争成果：`.data/verification/adaptive-v2/report.json`。
- 中止诊断：`.data/verification/adaptive-v2/diagnostic-military-baseline/`。

## 观测后定点修复与剩余问题

最终交付指纹：`9570c011d28328c1b1ab123daaba569e13ce4d8434f6f32dbc50fd5de0e7a3d0`。两场完整局使用开局时同一指纹；观测后追加下列修复，只复跑对应场景和固定快照，不增加完整比赛。最终性能数据对应交付程序，比赛结果不是后补修复的长局验收。

- 四方局出现终局扩槽连续下单、撤回。原因是建筑与舰船有终局完工检查，扩槽遗漏；现已统一纳入同一检查，并以低凝聚力、短缺、满槽的终局场景断言拒绝无法完工的扩建。
- 失地后的旧殖民情报造成重复建设失败；原失败指纹包含全国库存，收入变化错误解锁重试。现按本地设施、项目、殖民情报和相关通行条件生成指纹；库存与LRS军情日期变化不再解锁施工失败，新增断言通过。
- 上述新增2项与原26项合计28项场景，采用关联项增量验证，没有宣称同一次运行全套28项。
- 取消并非全部已消除：已建项目受后续岗位、供应及战争变化影响，终局仍可能无法完工；报告保留撤单类型。军国及国教的低治理、LRS后期失去运营和资源用途不足仍属于可见策略弱点。

### 4方预算及撤单明细

候选使用62110/105984，详细预测5748/9936，达到任一预算的决策148/414。
撤单原项目类型：`{"queue_ships:cruiser":2,"queue_ships:destroyer":51,"queue_ships:battleship":2,"expand_slots:":20,"queue_ships:dreadnought":1,"build_structure:maintenance":1,"build_structure:solar":21,"build_structure:agriculture":1}`。
终局有效LRS 7/24；有效覆盖按各国分别统计：`{"umbra":23,"cobalt":0,"verdant":16,"aurora":0}`。

### 8方预算及撤单明细

候选使用123159/225280，详细预测12166/21120，达到任一预算的决策236/880。
撤单原项目类型：`{"queue_ships:destroyer":75,"queue_ships:dreadnought":4,"queue_ships:battleship":2,"queue_ships:cruiser":4,"expand_slots:":21,"build_structure:farm":2}`。
终局有效LRS 30/47；有效覆盖按各国分别统计：`{"verdant":31,"umbra":25,"aurora":30,"silver":18,"violet":18,"cobalt":0,"rose":0,"solar":0}`。

性能内存值是同一进程按模式依次运行时观测的RSS峰值，包含运行时保留内存和worker退出后的残留，不是各算法隔离进程的内存下限。CPU为进程CPU时间／墙钟时间换算的平均忙核心数；完整比赛计时含保存和诊断读取，固定快照测速期间没有并跑比赛。

4方LRS停工分解（sealed封存、restarting重启、understaffed缺员、supplyBlocked满员但维护短缺）：`{"aurora":{"sealed":0,"restarting":0,"understaffed":0,"supplyBlocked":0},"umbra":{"sealed":0,"restarting":0,"understaffed":8,"supplyBlocked":0},"verdant":{"sealed":0,"restarting":0,"understaffed":1,"supplyBlocked":0},"cobalt":{"sealed":2,"restarting":0,"understaffed":5,"supplyBlocked":1}}`。覆盖以星系去重，不能简单用运营座数代替实际视野。

8方LRS停工分解（sealed封存、restarting重启、understaffed缺员、supplyBlocked满员但维护短缺）：`{"aurora":{"sealed":0,"restarting":0,"understaffed":2,"supplyBlocked":0},"umbra":{"sealed":0,"restarting":0,"understaffed":4,"supplyBlocked":0},"verdant":{"sealed":0,"restarting":0,"understaffed":8,"supplyBlocked":0},"cobalt":{"sealed":0,"restarting":0,"understaffed":2,"supplyBlocked":0},"rose":{"sealed":0,"restarting":0,"understaffed":0,"supplyBlocked":0},"solar":{"sealed":0,"restarting":0,"understaffed":0,"supplyBlocked":0},"violet":{"sealed":0,"restarting":0,"understaffed":1,"supplyBlocked":0},"silver":{"sealed":0,"restarting":0,"understaffed":0,"supplyBlocked":0}}`。覆盖以星系去重，不能简单用运营座数代替实际视野。

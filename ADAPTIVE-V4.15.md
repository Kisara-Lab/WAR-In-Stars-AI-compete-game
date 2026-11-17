# V4.15 持续产能与可靠执行

独立策略 `adaptive-v4.15`，修订 `continuous-capacity-2`，基于 main `c82387d`。旧 V4.12 决策文件不变；默认仅影响新建脚本与混合比赛。

## 规划

开发链在同一滚动资金账中排序分配，不能把同一笔未来收入同时支付两条链。链包含未付款成本与真实项目，已付款步骤不重复预留。资源缓冲覆盖当前净流出；未获资金的机会明确暂缓。开发条件价值用于可选扩军、主动战争和制度消费的机会成本，不作为等待方案已经拥有的资产。

危机防御、经营军备、组合战役、剩余经营四阶段各获得累计25%的可分配草稿与预测额度；未使用份额向后释放。标准256候选、宽度4、深度3、256草稿、48经济预测、12军事评估；深度512、8、4、1024、128、32。保留最终预测与三次校验额度。详细预测不足时仅安全独立经营可采用静态检查，最终再次预测。

主力与支援使用舰船身份；固定集结点用于抵达计算。迟于首次接敌的已付款军备不填补首战缺口。实际发令再次检查合法路线；战术推演合并最多20支舰队。占领、反击、守备和兑现仍使用原游戏规则。计划和实际里程碑分开记录，无关投资不刷新相关任务进展。

每个分支保存证书；最终失败移除相关组和依赖，重放其余有效动作。无法验证则暂停，不提交伪装的空计划。报告只为最终预测保存详细曲线，其余保留全部窗口摘要；大型导出沿用 main 的流式审计实现。

## 验证约束

第二修订按候选类别和生产类型分散轻筛，避免单一动作族占满昂贵搜索。福利升级可以与有岗位的基础生产组成方案，共同通过完整预测。固定对照中翠星第40轮、晨曦第45轮实际提交生产与福利组合。第二次对照严格第一；首次失败也保留，详见[验证报告](TESTING-ADAPTIVE-V4.15.md)。

唯一固定对照配置：stars-2026、24星系、120轮终局，60轮保存后暂停。晨曦、翠星V4.15，暮影、苍蓝V4.12，均标准档。观察停止日不提供给策略。最多三次冻结后从零尝试；严格第一和机制通过同时满足才算通过。无模型调用、无性能矩阵。

## 限制

开发账是保守条件计划，不会模拟未来免费下单；实际施工、敌方动作和供应变化会改变完成日期。战术三情景不是胜率，未知资产不当作事实。固定对照第一也不能证明一般胜率。实际结果另记验收报告。

## English

Current revision: `continuous-capacity-2`. Revision 2 diversifies candidate categories and production types, and evaluates staffed production plus welfare as a fully forecast package. The second fixed comparison passed at round 60: V4.15 scored 5207.043 and 4696.587; V4.12 scored 4453.432 and 4435.027. The failed first attempt is retained. See [verification and limitations](TESTING-ADAPTIVE-V4.15.md).

V4.15 is an independent strategy based on main c82387d. A shared development ledger prevents concurrent chains from spending the same projected capital. Discretionary investments pay the opportunity cost of delayed funded development; hypothetical colonies are never current assets. Four cumulative budget stages release unused work forward without increasing profile limits. Stable staging, first-contact reinforcement accounting, legal-route checks and native merge limits improve execution fidelity. Final certificates distinguish planned, submitted and executed actions.

New matches default to V4.15; existing saves and V4.12 semantics remain unchanged. The fixed comparison uses two V4.15 and two V4.12 seats, standard profile, stars-2026 and 24 systems, with a real 120-round horizon and a server-side stop after round60. At most three frozen attempts are allowed; success requires a strict V4.15 first place and mechanism checks. No model calls or benchmark matrix. Results do not establish a general win rate.

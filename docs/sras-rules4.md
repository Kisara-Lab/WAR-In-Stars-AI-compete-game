# SRAS rules-4: defense allocation and production capacity

## 观察与修复

rules-3观察记录结束于第88轮。本次检查时8793不可连接，没有恢复或改写旧局。

- 防御不再无条件认领所在星系的所有舰队：达到已知威胁所需兵力即停止分配，释放多余舰队，并显示剩余缺口。
- 造舰提供填满两个队列位置的方案，以及资金不足时的一艘回退方案；仍经过供应、岗位、资金与终局工期检查。
- 去除全国仅一座船厂的隐含限制：每四个殖民地对应一个船厂需求，已有船厂有排队时才比较扩建；仍检查建设岗位与成本。
- 情报或兵力条件变化后，不保留上一轮宣称/征服准备的过期资源预留。

## Verification / 验证

18项SRAS机制测试通过，包括留守释放、造舰队列、船厂扩建、0/2/8 workers一致性、隐藏信息与回滚。类型检查及构建通过。未改UI，未运行额外联赛或性能矩阵。

隔离读取第20/40/60/80轮存档，仅从本方知识重新决策。初次修复切片中，第80轮翠星产生19条动作，大部分为受威胁防区之间的增援；原21舰队留守区缩至4支。它说明多余留守可被释放，不证明战斗获胜或新发展路线更强。切片原文件未修改。

仍需改进：相邻敌军对多个星系的保守威胁计算、兵力不足时的战役选择、情报受阻后的主动获取路线。晨曦后期已经退出决策，不能将其0动作计为存活势力空计划。本修复未追加完整比赛。

## English summary

Defense now retains only enough known force and reports deficits. Ship orders can fill open queue capacity with a smaller funding fallback. Additional staffed shipyards become candidates when colony scale and existing paid backlog justify capacity. Invalid campaign reservations are cleared before rechecking prerequisites. All 18 focused tests and the build passed. Historical decisions demonstrate released garrisons, not proven stronger play; multi-front threat allocation and intelligence-blocked campaigns remain limitations.

# SRAS rules-3 / 舰队任务修复

本地修复，不修改8787或原仓库。保留rules-2生产建设与资金预留逻辑。

- 集结资产包含在途及已有命令的舰队；不再因非空闲状态丢失。
- 防御优先且舰队分配互斥，持续保留正赶赴防区的增援。
- 所有分配舰队到位后才合并与发起，不让快舰提前出发。
- 已经进军目标的任务保持launch，不返回集结点。
- 已有战役只匹配其对手的战争，防御任务不使用进攻目标更新逻辑。
- 每个草稿前缀先更新军事任务，再决定造舰优先级及取消订单。

验证：15项SRAS机制检查通过，包括新增的在途保留、分配互斥、进军不召回，以及0/2/8 workers一致性；类型检查和构建通过。初次worker测试在沙箱的Windows用户信息查询处失败，正常本地环境补跑通过。

第30/31轮隔离切片检查未发现重复分配，但仍只有1–2条动作，主要军事阻碍为军情缺失或兵力不足。该检查不证明战略强度提升，也不声称动作少的问题已经全部解决。新局需观察集结推进、有效战损及经营执行；不设最低动作数。

## English

Rules-3 retains assigned fleets during travel, makes defense/offense allocation exclusive, waits for assigned arrivals before merging/launch, and prevents active invasions being recalled to rally. Campaign war selection is opponent-specific. Defense assignments refresh before economic funding/cancellation decisions.

All 15 mechanism checks and the build passed, including deterministic 0/2/8-worker planning. Historical round-30/31 isolated decisions still have only 1–2 actions with intelligence/force blockers; these checks establish assignment correctness, not superior play. A fresh zero-cost observation must evaluate actual progress and losses.

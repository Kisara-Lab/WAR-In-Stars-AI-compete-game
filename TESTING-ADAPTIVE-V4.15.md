# V4.15 验证与固定对照

## 基线与结论

基线 main：`c82387dbd2ee70b4e75a46cd777bb4cb087b65a0`；分支 `feat/adaptive-v415`。最终修订 `continuous-capacity-2`。V4.12策略源文件保持基线内容，历史比赛不迁移。没有模型调用、PR、发布或远程部署。

第二次固定对照达到严格第一，停止后续尝试。这只证明固定60轮对照通过，不证明普遍胜率、120轮胜负或胜过大模型。

固定配置：stars-2026、四方24星系、标准档、真实终局120轮。晨曦、翠星V4.15；暮影、苍蓝V4.12。第60轮仅为服务停止点。

## 两次实际比赛

| 尝试／修订 | 晨曦 V4.15 | 翠星 V4.15 | 暮影 V4.12 | 苍蓝 V4.12 | 结果 |
|---|---:|---:|---:|---:|---|
| 1 / continuous-capacity-1 | 2894.610 | 4950.656 | 5241.801 | 5583.316 | 失败 |
| 2 / continuous-capacity-2 | 4696.587 | 5207.043 | 4453.432 | 4435.027 | 通过 |

首轮暴露生产候选同质化、福利缺乏配套供应。第二修订加入类别覆盖与生产／福利组合，仍须完整预测安全；未改变种子、席位、评分或预算。两次独立冻结并从零运行。

首次比赛 `7764db18-7a0f-4d34-9da2-03abc63bd8a7` 保存在 `.data/v415-attempt-2`。`.data/v415-attempt-1`仅为未开局预冻结目录，不是第三场比赛。第一次启动漏传60轮停止参数，第46轮发现后暂停未提交决策，用同一冻结构建和存档补上参数恢复；没有变更策略，审计保留暂停，最终仍停60轮，无61轮。

第二次比赛 `9ab924ff-7b66-41f8-bc01-8ea3750631b1` 保存在 `.data/v415-run-2`。8787保留该局，60轮完成保存，`running=false`、`busy=false`、`error=null`，无61轮。未开第三场。

## 每20轮与实际经营

下表为第二次比赛，单元格依次为分数／殖民地／舰船。

| 轮次 | 晨曦 | 翠星 | 暮影 | 苍蓝 |
|---|---|---|---|---|
| 20 | 1302.564 / 3 / 12 | 1196.829 / 3 / 14 | 1118.509 / 3 / 15 | 1149.736 / 3 / 18 |
| 40 | 3390.667 / 12 / 31 | 3979.188 / 15 / 36 | 2955.890 / 9 / 32 | 3196.939 / 10 / 26 |
| 60 | 4696.587 / 14 / 76 | 5207.043 / 15 / 95 | 4453.432 / 12 / 57 | 4435.027 / 11 / 74 |

翠星领先最高V4.12席位753.611分。翠星最终治理质量1，晨曦0.984842。翠星第40轮、晨曦第45轮提交两座农场、一座电站及乌托邦待遇组合，提供了生产与福利共同执行的证据。

| 势力 | 动作总数 | 空计划轮数 | 停手包含预算原因的轮数 | 轮末供应短缺次数 |
|---|---:|---:|---:|---:|
| 晨曦 | 221 | 2 | 9 | 0 |
| 翠星 | 248 | 3 | 16 | 0 |
| 暮影 | 204 | 2 | 11 | 0 |
| 苍蓝 | 327 | 2 | 16 | 0 |

轮末正常不代表轮内从未短缺。翠星动作数低于首次290条，得分反而更高。规划池累计墙钟规划376.198秒，报告峰值RSS约3705.29MiB；累计缓存命中0、未命中6134。没有另跑基准，不能宣称缓存改善。

## 验证与历史覆盖

- V4.15核心18项、开发6项、组合账3项通过；相关V4.12、混合控制器、策略对照及默认配置检查通过。
- 初次合并测试4项因沙箱worker启动 `uv_os_get_passwd ENOMEM` 失败；正常Windows权限仅补跑相关项通过，实际覆盖0／2／8 workers。
- 类型检查、构建、3项受影响浏览器检查通过；文档及差异空白检查通过。
- 逐轮检查报告与动作一致性、预算、冻结构建与世界哈希。两局流式审计均确认60次提交；第二局9522条记录，末条 `runtime.paused`。
- 以下历史状态复制后按本方知识规划，在隔离真实世界执行三轮。其他势力不下新命令、已有命令继续，是反事实序列，不是原命令回放或自适应敌方验证。

| 历史切片 | 检查重点 | 三轮动作数 | 执行结果 |
|---|---|---|---|
| capacity-6 第33轮暮影 | 预算受限经营与军备 | 3 / 3 / 3 | 全部接受，轮末无短缺 |
| capacity-6 第60轮暮影 | 多行星经营连续性 | 23 / 8 / 6 | 全部接受，轮末无短缺 |
| 旧V4第41轮苍蓝 | 独立动作不整批清空 | 11 / 9 / 2 | 全部接受，轮末无短缺 |

来源只读并记录哈希；旧策略记忆仅在副本中丢弃，不伪造V4.15历史记忆。输出 `.data/verification/v415/slices-continuous-capacity-2.json`。第41轮并非相同候选集合的直接重放，不能声称原来4条全部保留。切片副本第61轮不属于正式60轮观察局。

## 可复核标识

- 配置哈希：`eef79b18a32fe0f9ba2e1a08dd1fcfe1cd6b206188ade0ecb26a48c8a5976d03`
- 第二局源码哈希：`fd0ab4b1fcacd2224000f99064683819ebabd5f68f4e19a269434dce4ba3f4e6`
- 第二局世界哈希：`7a77bd11d6350e3cf69951b076f1f0d63e2cb3401f9dfeba9ca43c70dfca0b48`
- 第二局审计链尾：`7718463bd1097cc0da1d91092fb9aa5f2c2d3d15604beb68878536cb51051e21`
- 首次世界哈希：`5bb3de44e9209b07574ec9c9e6575507f463fe90c772d57a1d71f818d041defe`

各目录的 `manifest.json` 保存冻结标识，`observation/result.json`、`rounds.json`、`stopped.json`、`verification.json` 保存详细记录。冻结构建不随源码后续编辑改变。

## 剩余缺陷

1. 预算耗尽和空计划仍存在，不能保证所有等待均最优；候选覆盖仍有优化空间。
2. 本局优势主要来自殖民、生产和福利。V4.15的领土与目标评分均0，不能据此证明多线战争、二次支援、占领兑现已全面改善。
3. 晨曦文明分0、翠星100，两个V4.12均400。制度责任仍有差距；旧41轮序列虽持续经营，军国责任不满仍上升。
4. 共享账和军事三情景仍是启发式，部分军事逻辑沿用独立复制的基线，并非全局最优任务求解器。
5. 历史覆盖限于上述三个短序列，未穷尽全部计划轮次及主动反击响应。120轮后期、不同种子及模型对战未验证，本次不追加。

## English summary

Independent revision `continuous-capacity-2` passed the fixed comparison on attempt two: V4.15 scored 5207.043 and 4696.587 against 4453.432 and 4435.027. Both attempts are retained. The server is paused and idle after round 60, with a real 120-round planning horizon. No model calls occurred.

The evidence supports better colony development, production-backed welfare and reliable independent submissions. Mechanism checks, actual 0/2/8-worker checks, type checking, build and three browser checks passed. Historical sequences are counterfactual with no new opponent orders, not original replays. Budget exhaustion, institutional responsibilities and combat realization remain limitations. The fixed result does not establish a general win rate or superiority over models.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const directory = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const rows = JSON.parse(await readFile(join(directory, 'observation/rounds.json'), 'utf8'));
const stopped = JSON.parse(await readFile(join(directory, 'observation/stopped.json'), 'utf8'));
if (rows.at(-1)?.round !== manifest.stopRound || stopped.status.busy || stopped.status.running) throw Error('Observation is not complete and paused');
const median = values => { const a = values.slice().sort((a, b) => a - b); return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
const statistics = rows.at(-1).factions.map(f => {
  const history = rows.map(r => ({ ...r.factions.find(x => x.actor === f.actor), round: r.round }));
  const counts = {};
  for (const row of history) for (const a of row.actions) counts[a.type] = (counts[a.type] ?? 0) + 1;
  const times = history.map(r => r.ms / 1000).sort((a, b) => a - b);
  const repeatedMoves = history.slice(1).flatMap((r, i) => r.actions.filter(a => a.type === 'move_fleet' && history[i].actions.some(b => JSON.stringify(a) === JSON.stringify(b))).map(action => ({ round: r.round, action })));
  return { actor: f.actor, name: f.name, strategy: f.strategy, score: f.score.total,
    systems: f.systems, colonies: f.colonies, population: f.population, ships: f.ships,
    quality: f.governance.quality, resources: f.resources, idle: f.idle,
    actions: history.reduce((sum, r) => sum + r.actions.length, 0),
    emptyRounds: history.filter(r => !r.actions.length).map(r => r.round),
    planningMedianSeconds: median(times), planningP95Seconds: times[Math.ceil(times.length * .95) - 1],
    budgetStops: history.filter(r => /预算/.test(r.stop)).length, actionTypes: counts,
    repeatedMoves,
    boundaryShortages: history.filter(r => Object.values(r.shortages).some(Boolean)).map(r => r.round),
    welfareChanges: history.flatMap(r => r.actions.filter(a => a.type === 'set_welfare').map(a => ({ round: r.round, welfare: a.args.welfare }))),
    removedGroups: history.reduce((sum, r) => sum + (r.removed?.length ?? 0), 0),
    worldFailures: history.flatMap(r => r.failures),
  };
});
const checkHashes = async file => {
  const hashes = JSON.parse(await readFile(file, 'utf8'));
  const changed = [];
  for (const [path, expected] of Object.entries(hashes)) if (createHash('sha256').update(await readFile(path)).digest('hex') !== expected) changed.push(path);
  if (changed.length) throw Error('Protected files changed: ' + changed.join(', '));
  return Object.keys(hashes).length;
};
const historyFiles = await checkHashes(join(directory, 'previous-match-hashes.json'));
const sourceFiles = await checkHashes(join(directory, 'source-hashes.json'));
for (const [file, expected] of Object.entries(manifest.hashes)) if (createHash('sha256').update(await readFile(file)).digest('hex') !== expected) throw Error('Frozen build changed: ' + file);
const saved25 = JSON.parse(await readFile(join(directory, 'matches', manifest.id, 'round-0025.json'), 'utf8'));
const certs = saved25.decisions.cobalt.scriptReport.v412.certificates;
const baseline = certs.find(c => !c.groups.length);
const colony = certs.find(c => c.groups.length === 1 && c.groups[0].startsWith('colonize_planet:s21-p1:'));
const evidence = { round: 25, actor: 'cobalt', baseline, colony,
  farmCandidates: saved25.decisions.cobalt.scriptReport.v412.candidates.filter(c => c.id.includes('farm')) };
await writeFile(join(directory, 'observation/colony-evidence.json'), JSON.stringify(evidence, null, 2));
const summary = { id: manifest.id, config: manifest.config, round: manifest.stopRound, revision: manifest.v412Revision,
  statistics, metrics: stopped.status.metrics, planning: stopped.status.planning,
  protectedHistoryFiles: historyFiles, frozenSourceFiles: sourceFiles, frozenBuildFiles: Object.keys(manifest.hashes).length,
  stateHash: rows.at(-1).hash, wars: rows.at(-1).wars };
await writeFile(join(directory, 'observation/summary.json'), JSON.stringify(summary, null, 2));
const n = x => Number(x).toFixed(1);
const lines = [
  '# V4.1 vs 修复版 V4.12：前40轮观察', '',
  '结论：尚未修好。V4.12殖民没有持续转化成经济优势；40轮时两席均明显落后于V4.1。本次只观察前40轮，未判定整场胜负。', '',
  `比赛 ${manifest.id}。stars-2026、24星系、5.4规则、两方各两席交错、双方标准档。V4.12修订 ${manifest.v412Revision}。规则期限保持120轮，提交第40轮后自动暂停并保存。模型请求与token均为0。`, '',
  '| 势力 | 版本 | 分数 | 星系 | 殖民地 | 人口 | 舰船 | Q | 总动作 / 均值 | 空计划 | 规划秒中位 / p95 |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...statistics.slice().sort((a,b) => b.score-a.score).map(f => `| ${f.name} | ${f.strategy.replace('adaptive-', '')} | ${n(f.score)} | ${f.systems} | ${f.colonies} | ${f.population} | ${f.ships} | ${n(f.quality*100)}% | ${f.actions} / ${n(f.actions/40)} | ${f.emptyRounds.length}/40 | ${n(f.planningMedianSeconds)} / ${n(f.planningP95Seconds)} |`), '',
  '## 殖民进程', '',
  '| 轮次 | 晨曦 V4.1 | 暮影 V4.12 | 翠星 V4.1 | 苍蓝 V4.12 |',
  '|---|---:|---:|---:|---:|',
  ...rows.filter(r => r.round%10===0).map(r => `| ${r.round} | ${r.factions.map(f => f.colonies).join(' | ')} |`), '',
  '## 已核实的问题', '',
  '1. **储资与真正下单之间存在估值落差。** 第25轮苍蓝的等待方案，评分与经济能力合计为'+n(baseline.value.score+baseline.value.economy)+'，附加开发条件价值为'+n(baseline.value.conditional)+'；殖民s21-p1方案的前两项升至'+n(colony.value.score+colony.value.economy)+'，但条件价值降为'+n(colony.value.conditional)+'，总值从'+n(baseline.value.total)+'降到'+n(colony.value.total)+'，被拒绝。待开发潜力在支付后减少，却没有通过完整后续经营计划公平比较其兑现。', '',
  '2. **生产配套没有及时进入同一方案。** 上述殖民方案前720日无供应短缺或福利欠付，1440日窗口预测310日福利资金欠付；这是真实需要修复的远期粮食约束，不能简单关闭风险检查。但同轮农场候选在组合阶段和后续阶段均被预算暂缓，未形成“先补粮食产能、再殖民”的有效比较。', '',
  '3. **保护殖民资金也会拦住生产投资。** 第24轮苍蓝报告以储备200矿物、100食物为由拒绝多个矿场和其他建筑。第25轮起已具备殖民付款能力，殖民仍被收益比较拒绝。需要让预留资金服务于可兑现的完整建设序列，避免互相阻塞。', '',
  '4. **治理折损和重复行动仍存在。** V4.12两席第10轮把待遇降为基础，分别到第18/20轮恢复舒适；Q一度从0.8降到0.6。动作数须结合动作类型与实际结果阅读，移动指令不等于殖民、生产或战果。详细序列见JSON统计。', '',
  '5. **战争也没有弥补发展落后。** 第31轮翠星对暮影发起宣称战争，第35轮兑现s10；晨曦同时对暮影发起有限战争并完成兑现。第38轮翠星又对苍蓝开战，第40轮其s23目标连续控制已达210日，尚未在本次观察内结算。V4.12不能仅靠减少军费解决问题，还需让殖民产能及时形成有效防御。', '',
  '第4轮（第360日）晨曦与暮影还发生了接触战，暮影舰船从第3轮的4艘降为1艘。这不能称作正式宣战，但说明开局移动/侦察仍会卷入代价较高的早期交战。', '',
  '## 提交与执行', '',
  ...statistics.map(f => `- ${f.name}：移除动作组 ${f.removedGroups}；世界拒绝 ${f.worldFailures.length}；空计划轮 ${f.emptyRounds.join('、')||'无'}；因预算停手 ${f.budgetStops}/40；与上一轮完全相同的移动指令 ${f.repeatedMoves.length} 条（不直接等同于无效，需按舰队实际状态判断）。`), '',
  '暮影第26轮建基地在共同结算时被拒绝：目标已不满足施工条件。它与规划器整批回退是不同问题，应依据实际执行反馈处理竞争目标。', '',
  '## 修复方向', '',
  '- 统一等待、已付款项目、已完工殖民地的价值转化，避免计划本身的条件价值压过实际落地。',
  '- 按“粮食/岗位保障→殖民→首批生产”比较带日期和资金约束的完整方案；农场等必要前置项目应得到相关组合预算。',
  '- 对持续两轮无法执行的开发任务重算瓶颈；允许先投产能，解除既不殖民也不建设的资金锁定。',
  '- 分开统计实际经营动作与重复移动；按相关目标进展解除或改派侦察、守备任务。', '',
  '## 验证与文件保护', '',
  `本次新增对照分派的2个定向用例通过；类型检查、独立服务端/前端构建通过；浏览器席位标签检查通过（检查脚本中文传递编码修正后仅复跑该项）。未改动对局策略。旧第26轮比赛${historyFiles}个文件、冻结源码${sourceFiles}个文件、运行构建${Object.keys(manifest.hashes).length}个文件哈希一致。`, '',
  `规划进程累计峰值RSS：${n(stopped.status.planning?.peakRssMb)} MiB。只记录本局耗时，无测速矩阵、额外联赛或付费调用。`, '',
  `本地完整审计、每轮状态和报告：${directory}。第40轮哈希：${rows.at(-1).hash}。`, '',
  '这是同地图交错席位的一场前40轮观察，尚不足以推导普遍胜率；已足够否定“此次殖民修复已完成”的结论。',
];
await writeFile(join(directory, 'observation/report.md'), lines.join('\n'));
await writeFile('TESTING-V41-V412-40.md', lines.join('\n'));
console.log(JSON.stringify(summary));

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const root=resolve(process.argv[2]),previous=resolve(process.argv[3]);
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const manifest=await read(join(root,'manifest.json'));
const rows=await read(join(root,'observation/rounds.json'));
const stopped=await read(join(root,'observation/stopped.json'));
const oldRows=await read(join(previous,'observation/rounds.json'));
if(rows.at(-1)?.round!==40||stopped.status.running||stopped.status.busy||stopped.status.error)throw Error('Expected clean paused round 40');
const stats=series=>series.at(-1).factions.map(f=>{
  const h=series.map(r=>({...r.factions.find(x=>x.actor===f.actor),round:r.round}));
  const types={};for(const r of h)for(const a of r.actions)types[a.type]=(types[a.type]??0)+1;
  const times=h.map(r=>r.ms/1000).sort((a,b)=>a-b);
  const repeats=h.slice(1).reduce((n,r,i)=>n+r.actions.filter(a=>a.type==='move_fleet'&&h[i].actions.some(b=>JSON.stringify(a)===JSON.stringify(b))).length,0);
  return {actor:f.actor,name:f.name,strategy:f.strategy,score:f.score.total,colonies:f.colonies,systems:f.systems,population:f.population,ships:f.ships,q:f.governance.quality,
    totalActions:h.reduce((n,r)=>n+r.actions.length,0),emptyRounds:h.filter(r=>!r.actions.length).map(r=>r.round),types,repeats,
    budgetStops:h.filter(r=>/预算/.test(r.stop)).length,removed:h.reduce((n,r)=>n+(r.removed?.length??0),0),
    failures:h.flatMap(r=>r.failures.map(e=>({round:r.round,...e}))),resources:f.resources,idle:f.idle,
    medianSeconds:(times[19]+times[20])/2,p95Seconds:times[37],boundaryShortages:h.filter(r=>Object.values(r.shortages).some(Boolean)).map(r=>r.round),
    welfare:h.flatMap(r=>r.actions.filter(a=>a.type==='set_welfare').map(a=>({round:r.round,welfare:a.args.welfare}))),
    maxForecasts:Math.max(...h.map(r=>r.budget.forecasts)),maxDrafts:Math.max(...h.map(r=>r.budget.evaluations)),
  };
});
const current=stats(rows),old=stats(oldRows);
const verify=async hashes=>{for(const [file,hash]of Object.entries(hashes)){if(createHash('sha256').update(await readFile(file)).digest('hex')!==hash)throw Error('Frozen file changed: '+file);}return Object.keys(hashes).length;};
const preservation={history:await verify(await read(join(root,'previous-match-hashes.json'))),source:await verify(await read(join(root,'source-hashes.json'))),build:await verify(manifest.hashes)};
for(const f of current){if(stopped.status.metrics[f.actor].requests||stopped.status.metrics[f.actor].totalTokens)throw Error('Unexpected model usage');if(f.maxForecasts>48||f.maxDrafts>256)throw Error('Search budget exceeded');}
const segments=[...new Set(rows.map(r=>r.revision))].map(revision=>{const part=rows.filter(r=>r.revision===revision);return {revision,from:part[0].round,through:part.at(-1).round,actors:part.at(-1).factions.map(f=>({actor:f.actor,colonies:f.colonies,score:f.score.total,actions:part.reduce((n,r)=>n+r.factions.find(x=>x.actor===f.actor).actions.length,0)}))};});
const summary={id:manifest.id,revision:manifest.v412Revision,parent:manifest.parent,segments,config:manifest.config,round:40,hash:rows.at(-1).hash,current,previous:old,preservation,planning:stopped.status.planning,wars:rows.at(-1).wars};
await writeFile(join(root,'observation/summary.json'),JSON.stringify(summary,null,2));
const n=x=>Number(x).toFixed(1);
const lines=['# V4.12 殖民兑现修复与分段观察至40轮','','## 结论','',
  '持续经营有实质改善，但不是全面通过：暮影/苍蓝殖民地由前次4/6增至8/12，建筑指令5/2增至27/24，空计划6/8减至2/2且只在开局第3、4轮。第40轮Q为85.5%/90%。这次暮影兑现对晨曦的宣称目标，但又被翠星割走s10，战争防御与跨战线分配仍有缺陷。苍蓝3410.7分略高于晨曦3401.5，仍低于翠星3867.0；暮影2433.5仍居末位。未宣称胜过V4.1或模型。','',
  '## 版本边界（不是单版本40轮验收）','',
  ...segments.map(s=>`- 第${s.from}—${s.through}轮：${s.revision}。`),
  '第30轮首次规划发生控制器异常并整轮暂停，保留第29轮原档。原因是生产＋殖民组合跨行星，而预演按未殖民目标读取施工队列。3.1只修正V4.12预演为逐个实际施工行星检查；补充对应回归用例并复跑通过，第30轮苍蓝回放成功提交农场＋殖民。随后从第29轮建立新比赛ID续验，原档未修改。下表全程统计跨两个修订，不能当成单版本40轮结果。','',
  '## 实现与范围','',
  '修订 `colonial-execution-3` / `colonial-execution-3.1`，保留5.4规则、V4.1行为、48动作与标准档256候选/256草稿/48预测预算。',
  '- 未下单开发的条件价值保留作候选排序与军事机会成本，从真实分支收益中移除。等待不再凭未执行殖民计划加分。',
  '- 农场、太阳能、矿场及岗位/运营调整可与殖民储资竞争，付费后的同口径预测仍决定能否接受；可选扩军仍受储资约束。',
  '- 按当前可用与在建岗位生成现有产能＋殖民的真实动作组，优先覆盖各个必要生产资源；未来未完成殖民地不能提前施工。',
  '- 没有改动战斗公式、军事预算或旧策略；本次未声称修好重复侦察、全部战争任务与目标选择。','',
  '## 必要检查','',
  '6项殖民机制用例、11项V4.12回归通过；类型检查及独立前后端构建通过。回归包含实际提交证书、48/49动作、三次校验失败暂停、隐藏信息与串并行一致性。',
  '在上一局第24轮边界的隔离副本上，修复版苍蓝第25轮提交农场、矿场、岗位调整共3条；原版该轮仅探索。前者使用16次预测，最终移除0组，原切片哈希不变。该切片只证明恢复生产选择，不冒充完整反事实比赛结果。','',
  '## 新局设置','',
  `续验比赛 ${manifest.id}，来源比赛 ${manifest.parent?.id??'无'}；stars-2026，四方24星系，晨曦/翠星V4.1，暮影/苍蓝V4.12，双方标准档。规则期限120轮，第40轮提交后自动暂停。模型请求0，token0。各段代码冻结，异常修复有显式版本边界。`,'',
  '| 势力 | 策略 | 分数 | 星系 | 殖民地 | 人口 | 舰船 | Q | 平均动作 | 空计划 |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...current.slice().sort((a,b)=>b.score-a.score).map(f=>`| ${f.name} | ${f.strategy.replace('adaptive-','')} | ${n(f.score)} | ${f.systems} | ${f.colonies} | ${f.population} | ${f.ships} | ${n(f.q*100)}% | ${n(f.totalActions/40)} | ${f.emptyRounds.length}/40 |`),'',
  '## 与前次同席位V4.12对比','',
  '| 势力 | 殖民地：旧→新 | 分数：旧→新 | 建筑指令：旧→新 | 空计划：旧→新 |',
  '|---|---:|---:|---:|---:|',
  ...current.filter(f=>f.strategy==='adaptive-v4.12').map(f=>{const p=old.find(p=>p.actor===f.actor);return `| ${f.name} | ${p.colonies} → ${f.colonies} | ${n(p.score)} → ${n(f.score)} | ${p.types.build_structure??0} → ${f.types.build_structure??0} | ${p.emptyRounds.length} → ${f.emptyRounds.length} |`;}),'',
  '建筑指令是提交数量，实际拒绝另列。不同策略行为会改变对手行动和共同结算，不能把差异解释成完全独立的单变量收益。','',
  '## 每10轮殖民/治理','',
  ...rows.filter(r=>r.round%10===0).map(r=>`- 第${r.round}轮：${r.factions.map(f=>`${f.name} ${f.colonies}殖民地/Q${n(f.governance.quality*100)}%`).join('；')}。`),'',
  '## 执行、预算及剩余问题','',
  ...current.map(f=>`- ${f.name}：建筑指令${f.types.build_structure??0}，移动${f.types.move_fleet??0}（其中与上一轮完全相同${f.repeats}条）；最终移除${f.removed}组；世界拒绝${f.failures.length}。空计划轮：${f.emptyRounds.join('、')||'无'}。预算停手${f.budgetStops}/40；规划秒中位/p95 ${n(f.medianSeconds)}/${n(f.p95Seconds)}。`),'',
  '重复移动不直接等于无效，需要按实际位置与通行权进一步诊断。本次未改动这项逻辑。无边界短缺也不能替代十日结算中的完整福利和供应检查。',
  ...current.flatMap(f=>f.failures.map(e=>`- 世界拒绝：${f.name}第${e.round}轮，${e.details?.action?.type}：${e.details?.reason}。`)),'',
  ...rows.at(-1).wars.map(w=>`- 战争：${w.type}，${w.factions.join(' / ')}，第${w.startedDay}日开始，${w.endedDay!==undefined?`第${w.endedDay}日结束：${w.outcome}`:'第40轮仍未结束'}。`),'',
  `峰值RSS ${n(stopped.status.planning.peakRssMb)} MiB。冻结源码${preservation.source}、构建${preservation.build}、旧比赛文件${preservation.history}份哈希均一致。第40轮哈希 ${summary.hash}。`,
  '',`原始审计及每轮存档：${root}。未追加联赛、性能矩阵、模型调用或PR。只有前40轮观察，未判定整场胜负或普遍胜率。`];
await writeFile(join(root,'observation/report.md'),lines.join('\n'));
await writeFile('TESTING-V412-COLONIAL-EXECUTION-3.md',lines.join('\n'));
console.log(JSON.stringify({id:summary.id,current:current.map(({repeats,types,actor,score,colonies,q,totalActions,emptyRounds})=>({actor,score,colonies,q,totalActions,emptyRounds,types,repeats})),preservation}));

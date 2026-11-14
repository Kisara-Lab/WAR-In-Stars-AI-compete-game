import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const folder=resolve(process.argv[2]??'.data/live-adaptive-v412-20261115/observation');
const rows=JSON.parse(await readFile(join(folder,'rounds.json'),'utf8'));
if(!rows.length)throw Error('No observed rounds');
const last=rows.at(-1),n=x=>Number(x??0).toFixed(1);
const stopped=await readFile(join(folder,'stopped.json'),'utf8').then(JSON.parse).catch(()=>null);
const table=last.factions.slice().sort((a,b)=>b.score.total-a.score.total).map((f,i)=>{
  const history=rows.flatMap(r=>r.factions.filter(x=>x.actor===f.actor&&x.ms!==undefined)),actions=history.map(x=>x.actions.length),times=history.map(x=>x.ms/1000).sort((a,b)=>a-b);
  return `| ${i+1} | ${f.name} | ${f.controller==='model'?'grok-4.7':'V4.12'} | ${n(f.score.total)} | ${f.systems} | ${f.ships} | ${n(f.governance.quality*100)}% | ${n(actions.reduce((a,b)=>a+b,0)/Math.max(1,actions.length))} | ${actions.filter(x=>!x).length}/${actions.length} | ${n(times[Math.floor(times.length/2)])} / ${n(times[Math.min(times.length-1,Math.ceil(times.length*.95)-1)])} |`;
}).join('\n');
const costs=last.factions.map(f=>{const m=stopped?.status?.metrics?.[f.actor]??f.metrics;return `- ${f.name}：请求 ${m?.requests??0}；输入 ${m?.inputTokens??0}，输出 ${m?.outputTokens??0}，已报告合计 ${m?.totalTokens??0} token；用量未知请求 ${m?.unknownUsageRequests??0}。`;}).join('\n');
const lines=[`# V4.12 唯一真实观察（截至第${last.round}轮）`,'',`状态：${last.result?'比赛结束':stopped?'用户叫停，已保存；未运行到终局':'已保存的中间观察，尚非终局'}。配置固定：stars-2026，24星系，晨曦/翠星grok-4.7，暮影/苍蓝V4.12标准。`,'','| 排名 | 势力 | 控制器 | 分数 | 星系 | 舰船 | Q | 平均动作 | 空计划 | 决策秒中位/p95 |','|---|---|---|---:|---:|---:|---:|---:|---:|---:|',table,'','## 已记录实际用量','',costs,'','没有接口单价数据，token不换算为推测金额。脚本席位模型请求和token应始终为0。已取消轮次的真实请求保留；用量未知不等于免费。','', '## 每20轮观察',''];
for(const round of rows.filter(r=>r.round%20===0||r===last)){
  lines.push(`### 第${round.round}轮`,'');
  for(const f of round.factions)lines.push(`- ${f.name}：${n(f.score.total)}分，${f.actions.length}动作，${f.ships}舰，Q=${n(f.governance.quality*100)}%，待遇${f.welfare}，兑现${n((f.paid??0)*100)}%；${f.operation?`战役${f.operation.stage}→${f.operation.targets.join(',')}，${f.operation.nextStep}`:'无主要战役'}。${f.controller==='scripted'?`停手：${f.stop}；草稿${f.budget?.evaluations}，预测${f.budget?.forecasts}；世界拒绝${f.failures.length}。`:''}`);
  lines.push('');
}
lines.push('## 解释边界','','此表按实际保存轮次统计；若淘汰后沿用旧决策记录，最终分析须剔除这些重复记录。胜负属于一次具体观察，不推导普遍胜率。预测战果、指令接受与世界战果应分别核对完整审计。');
const filename=stopped?'report-stopped.md':'report.md';
await writeFile(join(folder,filename),lines.join('\n'));
console.log(JSON.stringify({through:last.round,result:last.result??null,report:join(folder,filename)}));

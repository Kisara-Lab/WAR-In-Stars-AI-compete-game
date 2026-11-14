import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const directory=process.argv[2]??'.data/live-adaptive-v41-20261114';
const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
const slices=JSON.parse(await readFile('.data/verification/adaptive-v41/frozen-slices/summary.json','utf8'));
let continuation=null;try{continuation=JSON.parse(await readFile(join(directory,'continuation.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const observation=continuation?.observation??'observation';
let rows=[];try{rows=JSON.parse(await readFile(join(directory,observation,'rounds.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
let stopped=null;try{stopped=JSON.parse(await readFile(join(directory,observation,'stopped.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const latest=rows.at(-1),quantile=(values,q)=>values.sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))]??0;
const costsOutsideBranch={};
if(continuation){
  const paused=JSON.parse(await readFile(join(directory,'observation/stopped.json'),'utf8'));
  const boundary=rows.find(r=>r.round===continuation.fromRound);
  for(const [id,total] of Object.entries(paused.status.metrics)){
    const committed=boundary.factions.find(f=>f.actor===id).metrics;
    costsOutsideBranch[id]=Object.fromEntries(['requests','inputTokens','outputTokens','totalTokens','unknownUsageRequests'].map(k=>[k,Math.max(0,(total[k]??0)-(committed[k]??0))]));
  }
}
const lines=['# 智能脚本 V4.1：修复与真实观察','','## 版本和边界','',
`- 修订：\`${manifest.revision}\`；切片代码摘要：\`${slices.revision}\`。源代码和完整构建哈希见 \`${directory}/manifest.json\`。`,
'- 新增独立 `adaptive-v4.1`，规则5.4、标准档、48条原子动作；不迁移旧策略。无性能矩阵、无联赛、无远程发布。',
`- 旧局 \`${manifest.preservedMatch}\` 保持第89轮暂停。启动前核验${Object.keys(manifest.preserved).length}个存档文件、${manifest.oldBuildVerified}个原构建文件；原状态哈希 \`${manifest.originalStateHash}\`。`,
'','## 已修复机制','',
'- 搜索接受的前缀记录边界、动作、草稿、预测哈希及风险/收益分解；最终从原边界校验相同草稿，删除旧版动作白名单和整轮空计划回退。',
'- 最终校验能归因时移除失败组及依赖，重新预测独立组；最多三次完整校验。不能保留有效方案或证书不一致时暂停整轮。',
'- 近100/300日供应、欠付风险作为约束；720/1440日边际软成本进入价值比较，已有损失保留在基线。福利升级、永久承诺采用更严格窗口检查。',
'- 根据缺少的投入生成救急候选，避免食品短缺时把关闭农业设施当作通用正收益；过滤无效调岗和重复移动。',
'- 有限战争绑定已声明目标；相关侦察、准备成熟、指定舰队到达、控制与结算更新进展；无关造舰不刷新停滞时钟。',
'- 组合深度遵循标准/深度档配置，至少25%草稿预算保留给剩余经营；所有阶段共享原预算，没有提高上限。',
'','## 必要检查','',
'- V4.1机制7项通过：精确提交证书、软/硬风险、失败组修复、战争目标、相关进展、48/49动作、隐藏信息及0/2/8 worker动作/记忆一致、暂停。',
'- 旧V4与混合控制器相关21项通过；类型检查通过；隔离客户端和服务端构建通过。',
'- 受影响浏览器1项通过。首次暴露隔离构建位于`.data`时首页绝对路径被静态服务拒绝，改为受限根目录相对文件路径后仅复跑失败项。',
'- Windows沙箱中的tsx用户信息查询受限；经执行权限审核后用相同测试命令通过，未将其误报为物理内存不足。',
'','## 历史切片','',
'表中边界N对应重新决策并执行到N+1轮。决策只读取当时本方知识；执行评价才使用隔离真实状态及其他席位原有命令。预测风险是缺口和未兑现的加权量，不是实际得分或胜率。','',
'| 边界轮 | 势力 | 原动作 | V4.1动作 | 预测风险前→后 | 世界拒绝 | 规划和执行秒 |',
'|---:|---|---:|---:|---:|---:|---:|'];
for(const r of slices.rows)lines.push(`| ${r.round} | ${r.actor} | ${r.baseline.actions?.length??0} | ${r.actions.length} | ${r.report.v4.risk.value.toFixed(1)} → ${r.report.v4.finalRisk.value.toFixed(1)} | ${r.execution.failures.length} | ${(r.ms/1000).toFixed(2)} |`);
lines.push('','第41轮最终保留4条生产/重启动作，并非强行保留旧版的4条候选。第64—68轮暮影分别提交6、9、11、7、14条有效经营动作，预测供应欠付风险下降；这不能证明后续受到敌军攻击时仍一定恢复。苍蓝第73/74轮切片仍仅1条动作、预测风险未改善，属于尚未解决的困境。',
'','## 唯一真实模型对战','',
`- 地址：http://127.0.0.1:8787/；比赛ID：\`${manifest.matchId}\`。`,
'- `stars-2026`、四方24星系、最多120轮；晨曦/翠星 `grok-4.7`，暮影/苍蓝 V4.1标准档。',
'- 使用已授权接口实际付费；脚本请求/token均为0。费用按供应商实际账单，报告不从token虚构金额。',
'- 开局冻结策略；模型超时允许当前轮额外重试一次，仍失败或控制器错误则暂停保存。运行线程30，模拟线程8，规划缓存上限8192MiB；两个计算阶段不重叠。这些参数不进入世界哈希。',
`- 当前记录到${latest?.round??0}轮：${latest?.result?'比赛已结束。':stopped?'比赛已暂停，未完赛。':'进行中；尚无最终结论。'}`);
if(stopped)lines.push(`- 暂停原因：${stopped.status.error??stopped.status.phase}。`);
if(continuation)lines.push('', '### 第30轮控制器修复与恢复边界','',
  '- 现场发现预演战争ID使用本方知识中的战争序号，实际共同结算使用全局序号，导致暮影把正在进行的战争误报为已结算。第30轮立即暂停，取消未提交的第31轮；已发生的模型usage保留。',
  '- `certified-campaign-2` 在实际共同结算后按本方战争、对手和声明目标绑定真实ID；并在集结转进攻时重置不同目的地的距离基准。旧策略不改变。新增战争ID用例及原目标断言通过；V4.1原7项与类型/隔离构建通过。',
  '- 只复核发生问题的第28轮暮影切片：修复后正确进入control、绑定实际war-aurora:umbra-2700-1，12条动作、0执行拒绝。',
  `- 恢复分支 \`${continuation.matchId}\` 从第30轮边界接续，只执行后续轮次。源记录 \`${continuation.parent}\` 保持暂停，修复构建和源码摘要见 \`${directory}/${continuation.manifest}\`。`,
  '- 本场包含明确的控制器修订边界，不能称为单一冻结策略版本的120轮验收，也不与未中断结果混作强度证明。');
if(continuation)lines.push(`- 中断但未提交的请求单列补回总账：${JSON.stringify(costsOutsideBranch)}。恢复分支的界面累计数从已提交轮边界继承；本报告另计原审计中的这部分费用，未知usage不按0 token或免费处理。`);
if(latest){
  lines.push('','| 势力 | 总分 | Q | 星系 | 平均动作 | 空计划/决策轮 | 决策中位秒 | p95秒 | 请求 | token |','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for(const f of latest.factions){const turns=rows.map(r=>r.factions.find(x=>x.actor===f.actor)).filter(x=>x?.ms!==undefined),times=turns.map(x=>x.ms/1000),extra=costsOutsideBranch[f.actor];lines.push(`| ${f.name} | ${f.score.total.toFixed(3)} | ${f.governance.quality.toFixed(4)} | ${f.systems} | ${(turns.reduce((n,x)=>n+x.actions.length,0)/Math.max(1,turns.length)).toFixed(2)} | ${turns.filter(x=>!x.actions.length).length}/${turns.length} | ${quantile([...times],.5).toFixed(2)} | ${quantile([...times],.95).toFixed(2)} | ${(f.metrics?.requests??0)+(extra?.requests??0)} | ${(f.metrics?.totalTokens??0)+(extra?.totalTokens??0)} |`);}
  lines.push('','### 每20轮观察','', '| 轮 | 势力 | 平均动作 | 空计划 | Q | 福利兑现 | 短缺 | 战役阶段 | 行星覆盖均值 | 峰值RSS MiB |','|---:|---|---:|---:|---:|---:|---|---|---:|---:|');
  for(const r of rows.filter(r=>r.round%20===0||r.result))for(const f of r.factions){const block=rows.filter(x=>x.round>r.round-20&&x.round<=r.round).map(x=>x.factions.find(y=>y.actor===f.actor)).filter(x=>x?.ms!==undefined);lines.push(`| ${r.round} | ${f.actor} | ${(block.reduce((n,x)=>n+x.actions.length,0)/Math.max(1,block.length)).toFixed(2)} | ${block.filter(x=>!x.actions.length).length} | ${f.governance.quality.toFixed(3)} | ${(f.paid??0).toFixed(3)} | ${Object.entries(f.shortages).filter(([,v])=>v).map(([k])=>k).join('/')||'无'} | ${f.operation?.stage??'无'} | ${(block.reduce((n,x)=>n+(x.turn?.planets??0),0)/Math.max(1,block.length)).toFixed(2)} | ${Math.max(0,...block.map(x=>x.performance?.peakRssMb??0)).toFixed(1)} |`);}
  lines.push('','### 已记录停手与真实执行','');
  for(const f of latest.factions.filter(x=>x.controller==='scripted')){const turns=rows.map(r=>r.factions.find(x=>x.actor===f.actor)).filter(x=>x?.ms!==undefined),reasons={};for(const t of turns)reasons[t.stop]=(reasons[t.stop]??0)+1;lines.push(`- ${f.name}：世界拒绝${turns.reduce((n,t)=>n+t.failures.length,0)}条；阶段移除${turns.reduce((n,t)=>n+(t.removedGroups?.length??0),0)}组；停手原因 ${JSON.stringify(reasons)}。`);}
  lines.push('','### 动作构成和战损','');
  for(const f of latest.factions.filter(x=>x.controller==='scripted')){
    const types={};for(const row of rows)for(const action of row.factions.find(x=>x.actor===f.actor)?.actions??[])types[action.type]=(types[action.type]??0)+1;
    lines.push(`- ${f.name}实际接受动作构成：${JSON.stringify(types)}。移动动作不自动认定为取得侦察或战役成果。`);
  }
  const losses={},events=[];
  for(const row of rows){
    const id=continuation&&row.round>continuation.fromRound?continuation.matchId:manifest.matchId;
    const record=JSON.parse(await readFile(join(directory,'matches',id,`round-${String(row.round).padStart(4,'0')}.json`),'utf8'));
    for(const event of record.state.events.filter(e=>e.round===row.round)){
      if(event.type==='war'&&/结束|结算|吞并|割让/.test(event.text))events.push({round:row.round,text:event.text});
      if(event.type!=='battle'||!event.details?.participants||!event.details?.remaining)continue;
      for(const unit of event.details.participants){
        const survivors=event.details.remaining.filter(next=>next.id===unit.id).flatMap(next=>next.ships);
        const lost=unit.ships.filter(ship=>!survivors.some(next=>next.id===ship.id));
        losses[unit.ownerId]=(losses[unit.ownerId]??0)+lost.length;
      }
    }
  }
  lines.push(`- 已记录战斗中的舰船损毁数：${JSON.stringify(losses)}。不包含非战斗解体、合并或转移。`);
  for(const e of events)lines.push(`- 第${e.round}轮：${e.text}`);
}
lines.push('','## 尚存限制','',
'- 严重失地、凝聚力见底和生产不足同时发生时，现有候选仍可能无法找到短期恢复方案；上述苍蓝切片证明问题尚未全部解决。',
'- 搜索常用尽草稿或预测额度，有限预算可能遗漏跨行星长期组合；没有按动作数设最低指标，也不能宣称所有正收益机会都已穷尽。',
'- 战术推演使用本方可知情报和三个确定情景，不能代表隐藏增援或对手未来选择的真实概率。',
'- 代码机制通过、切片改善和对模型胜负分别报告。单场结果不证明更强或平衡，无胜率结论。',
'',`完整审计、每20轮检查点及原始存档：\`${directory}\`。`);
await writeFile('TESTING-ADAPTIVE-V4.1.md',lines.join('\n')+'\n');
console.log(JSON.stringify({report:'TESTING-ADAPTIVE-V4.1.md',round:latest?.round??0,finished:!!latest?.result,stopped:!!stopped}));

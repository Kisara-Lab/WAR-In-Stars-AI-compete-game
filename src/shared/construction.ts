import type { GameState, Planet, StarSystem } from './types.js';
import { governed, V53 } from './governance.js';
import { support, EXPANSIONS, INDUSTRY } from './industry.js';
import { STRUCTURES } from './rules.js';
import { occupied, faithEffects } from './v4.js';
import { annexationFactor } from './balance.js';
import { CIVILIZATION } from './civilization.js';

export function constructionView(state: GameState, system: StarSystem, planet: Planet) {
  const f = state.factions[planet.ownerId!];
  const drydock = support(planet, 'drydock', state.day);
  const supplied = !f.shortages.energy && !f.shortages.minerals;
  const shipLines = governed(state) && drydock === 1 && supplied ? V53.drydockShipLines : V53.normalShipLines;
  const constructionLines = governed(state) ? V53.constructionLines : 1;
  const productivity = (.5 + f.unity/10000) * .5 ** Object.values(f.shortages).filter(Boolean).length * faithEffects(f,state.day).production * annexationFactor(system,state.day);
  const shipFactor = support(planet,'shipyard',state.day) * (1+INDUSTRY.bonus*drydock) * (f.civilization?.choice==='militarist'?CIVILIZATION.militaryShipSpeed:1);
  const queues = ['ground','orbital','ship'].map(slot=>{
    const lines = slot==='ship'?shipLines:constructionLines, available=Array(lines).fill(0) as number[];
    const projects=system.projects.filter(p=>p.planetId===planet.id&&(slot==='ship'?p.kind==='ship':p.expansion?EXPANSIONS[p.expansion].slot===slot:p.kind==='building'&&p.structureType?STRUCTURES[p.structureType].slot===slot:false)).sort((a,b)=>a.createdDay-b.createdDay||a.id.localeCompare(b.id));
    return {slot,lines,projects:projects.map((p,index)=>{
      const line=available.indexOf(Math.min(...available)),rate=productivity*(slot==='ship'?shipFactor:1);
      const duration=rate>0?Math.max(10,Math.ceil(Math.max(0,p.requiredDays-p.progress/1000)/rate/10)*10):Infinity;
      available[line]+=duration;
      return {id:p.id,line:line+1,active:index<lines&&!occupied(system),paused:occupied(system)?'临时占领':index>=lines?'等待施工线':rate<=0?'缺员或无有效进度':null,estimatedCompleteDay:Number.isFinite(available[line])&&!occupied(system)?state.day+available[line]:null,prepaid:p.cost};
    })};
  });
  return {constructionLines,shipLines,secondShipLineReason:shipLines===2?'满员干船坞及电矿供应正常':!governed(state)?'旧修订单线':drydock!==1?'缺少正常满员干船坞':!supplied?'电力或矿物维护短缺':'未开放',queues,assumption:'当前效率冻结的十日队列估算；实际人口、岗位、供应、整合完工及新设施会改变日期，详见720/1440日条件预测。每步活动线冻结，空位下一步接续。'};
}

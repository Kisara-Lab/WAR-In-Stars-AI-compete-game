import { STRUCTURES } from '../shared/rules.js';
import { policyComparison } from '../shared/comparison.js';
import { industryPlanet } from '../shared/industry.js';
import type { GameState } from '../shared/types.js';
import type { ScriptCandidate } from './adaptive-types.js';
import type { economicForecast } from './forecast.js';
import { recoveryCandidatesV4, economicCandidatesV4, emptyRiskV4 } from './adaptive-v4-economy.js';

/** Build repairs for the deficient inputs, not every operating building in the empire. */
export function economyCandidatesV41(state:GameState,actor:string,base:ScriptCandidate[],projection:ReturnType<typeof economicForecast>) {
  const own=state.factions[actor],last=projection.horizons.at(-1)!,risk=structuredClone(projection.trajectory?.at(-1)?.risk??emptyRiskV4());
  const quote=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  if(risk.unpaidSeverity>0)for(const resource of ['energy','food','minerals'] as const)if((last.resources[resource]??0)<1)risk.shortfall[resource]=Math.max(risk.shortfall[resource],1);
  risk.value=risk.shortageDays+risk.unpaidSeverity;
  const scarce=(['energy','food','minerals'] as const).filter(r=>risk.shortfall[r]>0);
  const buildings=new Map(state.systems.flatMap(s=>s.planets.flatMap(p=>p.structures.map(b=>[b.id,{b,p}] as const))));
  const recovery=recoveryCandidatesV4(state,actor,base,risk).flatMap(c=>{
    let gain=0;
    const actions=c.actions.filter(a=>{
      if(a.type!=='set_structure_status'||a.args.sealed!==true)return true;
      const item=buildings.get(String(a.args.structureId));if(!item)return false;
      const rule=STRUCTURES[item.b.type];
      if(scarce.some(r=>rule.output[r]>0)||scarce.includes('food')&&item.b.type==='agriculture'||scarce.includes('energy')&&item.b.type==='solar_hub')return false;
      const workforce=industryPlanet({...item.p,operation:undefined},state.day),vacant=workforce.population-workforce.employed;
      const release=vacant===0&&scarce.some(r=>item.p.structures.some(b=>STRUCTURES[b.type].output[r]>0));
      const saved=(scarce.includes('energy')?rule.energy:0)+(scarce.includes('minerals')?rule.upkeep+(item.b.type==='foundry'?40:0):0);
      if(!saved&&!release)return false;
      gain+=saved+(release?20:0);return true;
    });
    if(!actions.length)return [];
    const produces=actions.some(a=>a.type==='build_structure');
    const isSocial=actions.some(a=>!['set_jobs','set_structure_status','build_structure'].includes(a.type));
    if(!gain&&!produces&&!isSocial&&!actions.some(a=>a.type==='set_jobs'))return [];
    return [{...c,actions,id:'v41:repair:'+JSON.stringify(actions),value:gain||c.value,priority:scarce.length?3:1}];
  });
  const economic:ScriptCandidate[]=economicCandidatesV4(state,actor,base.filter(c=>c.kind!=='ships'&&!(own.civilization?.choice==='militarist'&&c.kind==='welfare'&&c.actions.some(a=>!['comfortable','basic','survival'].includes(String(a.args.welfare))))));
  // Current historical welfare payment is not a forecast of permanent insolvency.
  const near=projection.horizons.find(h=>h.days>=300)??projection.horizons[0];
  if(!near.shortageDays&&!near.unpaidDays)economic.push(...base.filter(c=>c.kind==='ships'));
  // The light screen guarantees each kind/resource/planet an entry; exact acceptance remains forecast-based.
  for(const c of economic) {
    if(c.kind==='build'&&c.actions.some(a=>scarce.some(r=>STRUCTURES[a.args.structureType as keyof typeof STRUCTURES]?.output[r]>0)))c.priority=Math.max(c.priority,3);
    if(c.kind==='jobs') {
      const a=c.actions[0],p=state.systems.flatMap(s=>s.planets).find(p=>p.id===a.args.planetId);
      if(p&&industryPlanet({...p,operation:undefined},state.day).population>=industryPlanet({...p,operation:undefined},state.day).jobs)c.value=0;
    }
    if(c.kind==='welfare'&&quote.effectiveUnityChange<0)c.priority=Math.max(c.priority,2);
  }
  return [...recovery,...economic];
}

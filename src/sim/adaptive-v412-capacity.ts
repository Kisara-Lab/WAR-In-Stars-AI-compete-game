import {createHash} from 'node:crypto';
import type {GameState,Fleet} from '../shared/types.js';
import type {CapacityV412,MilitaryOptionV412} from '../shared/adaptive-v412.js';
import {ADAPTIVE_V412 as CONFIG} from '../shared/adaptive-v412.js';
import {SHIPS} from '../shared/rules.js';
import {controller} from '../shared/v4.js';
import {relationKey} from '../shared/diplomacy.js';
import {policyComparison} from '../shared/comparison.js';
import {shipMaterials} from '../shared/industry.js';
import {RESPONSIBILITY} from '../shared/responsibility.js';
import {fleetPower} from './math.js';
import {arrivalV412,militaryKnowledge} from './adaptive-v412-military.js';
import {paidReinforcementsV412} from './adaptive-v412-memory.js';
import type {developmentV412} from './adaptive-v412-development.js';

/** Full filtered state identity: audit/history never serve as an evaluation cache. */
export function militaryDependencyV412(state:GameState,actor:string) {
  return createHash('sha256').update(JSON.stringify({actor,day:state.day,round:state.round,
    systems:state.systems,factions:state.factions,fleets:state.fleets,relations:state.relations,
    wars:state.wars,conquests:state.conquests})).digest('hex');
}

export function capacityV412(state:GameState,actor:string,plans:MilitaryOptionV412[],development:Pick<ReturnType<typeof developmentV412>,'alternatives'>):CapacityV412 {
  const key=militaryDependencyV412(state,actor),own=state.factions[actor];
  const quote=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  const end=state.day+(state.config.maxRounds-state.round)*100;
  const needs:CapacityV412['needs']=[];
  // Observed peacetime strength is pressure, not proof of an incoming invasion.
  // Each known fleet contributes to one nearest border only.
  for(const r of militaryKnowledge(state,actor).filter(r=>state.day-r.day<=CONFIG.intelDays)) {
    const relation=state.relations[relationKey(actor,r.fleet.ownerId)];
    if(!relation||['unknown','alliance'].includes(relation.status))continue;
    const probe={...state,relations:{...state.relations,[relationKey(actor,r.fleet.ownerId)]:{...relation,status:'war' as const}}};
    const targets=state.systems.filter(s=>s.ownerId===actor).map(s=>({s,days:arrivalV412(probe,r.fleet.ownerId,r.fleet,s.id)}))
      .filter(x=>x.days<=300).sort((a,b)=>Number(b.s.id===r.fleet.order?.systemId)-Number(a.s.id===r.fleet.order?.systemId)||a.days-b.days||a.s.id.localeCompare(b.s.id));
    if(!targets.length)continue;
    const t=targets[0],active=state.wars?.some(w=>w.endedDay===undefined&&w.factions.includes(actor)&&w.factions.includes(r.fleet.ownerId));
    const id='border:'+r.fleet.ownerId+':'+t.s.id;
    let need=needs.find(n=>n.id===id);
    if(!need){need={id,target:t.s.id,opponent:r.fleet.ownerId,kind:active?'defend':'pressure',deadline:Math.min(end,state.day+(active?Math.max(100,t.days):720)),power:0,present:controller(t.s)===actor?(t.s.base?.hull??0):0,paid:0,missing:0,fleetIds:[],projectIds:[],evidenceDays:[],conditional:!active};needs.push(need);}
    need.power+=fleetPower(r.fleet);need.evidenceDays.push(r.day);
  }
  const campaign=plans.filter(p=>p.mode!=='defend'&&p.evaluated&&p.value>0&&!p.eliminated).sort((a,b)=>Number(!!b.holding)-Number(!!a.holding)||b.value-a.value||a.id.localeCompare(b.id))[0];
  if(campaign)needs.push({id:campaign.planKey??campaign.id,target:campaign.target,opponent:campaign.opponent,kind:'campaign',deadline:Math.min(end,campaign.expectedDay),power:campaign.requiredPower??campaign.knownPower,present:0,paid:0,missing:0,fleetIds:[],projectIds:[],evidenceDays:campaign.intelDays,conditional:true});
  needs.sort((a,b)=>Number(b.kind==='defend')-Number(a.kind==='defend')||a.deadline-b.deadline||a.id.localeCompare(b.id));
  const assigned=new Set<string>(),usedProjects=new Set<string>(),usedBases=new Set<string>();
  const allocations:CapacityV412['allocations']=[];
  const projects:CapacityV412['projects']=paidReinforcementsV412(state,actor);
  for(const need of needs) {
    if(usedBases.has(need.target))need.present=0;else usedBases.add(need.target);
    for(const f of state.fleets.filter(f=>f.ownerId===actor&&!f.withdrawal&&!assigned.has(f.id))
      .map(f=>({f,arrival:state.day+arrivalV412(state,actor,f,need.target)})).filter(x=>x.arrival<=need.deadline)
      .sort((a,b)=>a.arrival-b.arrival||a.f.id.localeCompare(b.f.id))) {
      if(need.present>=need.power)break;
      assigned.add(f.f.id);need.fleetIds.push(f.f.id);need.present+=fleetPower(f.f);
      allocations.push({fleetId:f.f.id,shipIds:f.f.ships.map(s=>s.id),taskId:need.id,arrivalDay:f.arrival});
    }
    for(const p of projects.filter(p=>!usedProjects.has(p.id)).sort((a,b)=>a.completeDay-b.completeDay||a.id.localeCompare(b.id))) {
      if(need.present+need.paid>=need.power)break;
      const type=p.shipType as keyof typeof SHIPS;
      const mock:Fleet={id:p.id,ownerId:actor,name:'paid',systemId:p.systemId,position:{x:500,y:500},order:null,transit:null,ships:[{id:p.id,type,hull:SHIPS[type].power}]};
      const arrival=Math.ceil(p.completeDay/100)*100+arrivalV412(state,actor,mock,need.target);
      if(arrival>need.deadline)continue;
      usedProjects.add(p.id);need.paid+=SHIPS[type].power;need.projectIds.push(p.id);p.taskId=need.id;p.arrivalDay=arrival;
    }
    need.missing=Math.max(0,need.power-need.present-need.paid);
  }
  const materials=shipMaterials('destroyer');
  const count=needs.reduce((n,r)=>n+Math.ceil(r.missing/SHIPS.destroyer.power),0);
  return {day:state.day,dependencyKey:key,needs,projects,allocations,
    resources:Object.fromEntries((['energy','food','minerals','alloys'] as const).map(r=>[r,{stock:(own.resources[r]??0)/1000,netPer100:quote.net[r]??0,maintenance:r==='alloys'?0:quote.upkeep[r]??0,reserved:Math.min((own.resources[r]??0)/1000,count*(materials[r]??0)/1000)}])),
    development:development.alternatives.map(d=>({id:d.id,target:d.planetId,next:d.next,readyDay:d.readyDay,completeDay:d.productiveDay,cost:d.cost}))};
}

export function commitmentBlockV412(state:GameState,actor:string,choice:string,plans:MilitaryOptionV412[]) {
  if(!['militarist','theocracy'].includes(choice))return null;
  const deadline=state.day+(choice==='militarist'?RESPONSIBILITY.militaryGrace:RESPONSIBILITY.religiousGrace);
  const actual=state.factions[actor].responsibility;
  if((actual?.satisfiedUntil??0)>=deadline)return null;
  const executable=plans.some(p=>p.evaluated&&!p.unknown&&!p.eliminated&&p.ready&&p.value>0&&p.expectedDay<=deadline&&
    (choice==='militarist'||p.warType==='missionary')&&p.fleetIds.length>0&&p.scenarios.length>0&&p.scenarios.every(s=>s.won)&&
    p.fleetIds.every(id=>state.fleets.some(f=>f.id===id&&f.ownerId===actor&&!f.withdrawal)));
  return executable?null:'永久制度缺少责任宽限期内可执行且已推演的成果路径；保留世俗方案';
}

/** Conditional outcomes are alternatives, never cumulative rewards for each order. */
export function conditionalValueV412(groups:{value:number;kind:string;target:string;military?:MilitaryOptionV412}[]) {
  const outcomes=new Map<string,number>();
  for(const g of groups){
    const key=g.military?(g.military.planKey??[g.military.mode,g.military.opponent,g.military.target,g.military.warType].join(':')):['scout','explore','contact'].includes(g.kind)?g.kind+':'+g.target:null;
    if(key)outcomes.set(key,Math.max(outcomes.get(key)??0,g.value));
  }
  return [...outcomes.values()].reduce((n,v)=>n+v,0);
}

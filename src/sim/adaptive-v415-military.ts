import { ADAPTIVE_V415 as CONFIG, type CampaignV415, type MilitaryOptionV415, type WaveV415 } from '../shared/adaptive-v415.js';
import type { MilitaryOptionV4, TacticalScenarioV4 } from '../shared/adaptive-v4.js';
import type { ScriptMemory } from '../shared/adaptive.js';
import type { Action, Fleet, GameState } from '../shared/types.js';
import { activeWar, controller, type War, type WarType } from '../shared/v4.js';
import { SHIPS, RULES } from '../shared/rules.js';
import { ESCALATION, preparationRule } from '../shared/escalation.js';
import { relationKey, canFight } from '../shared/diplomacy.js';
import { scoreBreakdown } from '../shared/scoring.js';
import { governanceView } from '../shared/governance.js';
import { constructionView } from '../shared/construction.js';
import { accessiblePath } from './diplomacy.js';
import { distance, fleetPower } from './math.js';
import { economyFactors, repairFaction } from './engine.js';
import { processLocal, type FactionFactors } from './local.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { paidReinforcementsV415 } from './adaptive-v415-memory.js';
import { settleCaptures, settleWar, updateWars, restoreBases } from './wars.js';
import { policyComparison } from '../shared/comparison.js';
import type { candidateFacts } from './adaptive-candidates.js';

export interface TacticalRequestV415 { actor:string; option:MilitaryOptionV415; }
export interface MilitaryCandidateV415 extends ScriptCandidate { military?:MilitaryOptionV415; }
const fleetScore=(fleets:Fleet[])=>fleets.flatMap(fleet=>fleet.ships).reduce((sum,ship)=>sum+SHIPS[ship.type].power*ESCALATION.fleetScoreFactor,0);
const move=(fleetId:string,systemId:string):Action=>({type:'move_fleet',args:{fleetId,systemId,x:500,y:500,targetFleetId:null}});

export function militaryKnowledge(state:GameState,actor:string) {
  const records=new Map<string,{fleet:Fleet;day:number}>();
  const own=state.factions[actor];
  for(const snapshot of [...Object.values(own.intel),...Object.values(own.militaryIntel??{})])for(const fleet of snapshot.fleets) {
    if(fleet.ownerId!==actor&&(!records.has(fleet.id)||records.get(fleet.id)!.day<snapshot.day))records.set(fleet.id,{fleet,day:snapshot.day});
  }
  for(const record of Object.values(own.transitIntel??{}))if(!records.has(record.fleet.id)||records.get(record.fleet.id)!.day<record.day)records.set(record.fleet.id,{fleet:record.fleet,day:record.day});
  for(const [id,record] of records) {
    const systemId=record.fleet.systemId;
    const newer=systemId?[own.intel[systemId],own.militaryIntel?.[systemId]].filter(Boolean).sort((first,second)=>second!.day-first!.day)[0]:undefined;
    if(newer&&newer.day>record.day&&!newer.fleets.some(fleet=>fleet.id===id))records.delete(id);
  }
  return [...records.values()].sort((first,second)=>first.fleet.id.localeCompare(second.fleet.id,'en'));
}

export function arrivalV415(state:GameState,actor:string,fleet:Fleet,target:string) {
  if(fleet.withdrawal||!fleet.ships.length)return Infinity;
  const start=fleet.transit?.to??fleet.systemId;
  if(!start)return Infinity;
  const path=accessiblePath(state,actor,start,target);
  if(!path)return Infinity;
  const speed=Math.min(...fleet.ships.map(ship=>SHIPS[ship.type].speed));
  let position=fleet.transit?state.systems.find(system=>system.id===start)?.gates[fleet.transit.from]:fleet.position;
  let current=start,days=fleet.transit?.remainingDays??0;
  for(const next of path) {
    const source=state.systems.find(system=>system.id===current)!;
    days+=Math.ceil(distance(position??{x:500,y:500},source.gates[next])/speed/10)*10+RULES.jumpDays;
    position=state.systems.find(system=>system.id===next)!.gates[current];current=next;
  }
  return days+Math.ceil(distance(position??{x:500,y:500},{x:500,y:500})/speed/10)*10;
}

export function cleanTasksV415(state:GameState,actor:string,memory:ScriptMemory) {
  const operation=memory.operation as CampaignV415|undefined;
  // Follow individual ship identities across merges/splits; do not discard a
  // surviving wave because its former fleet ID disappeared.
  if(operation?.stage!=='exit')for(const wave of operation?.waves??[]) {
    wave.fleetIds=state.fleets.filter(f=>f.ownerId===actor&&f.ships.some(s=>wave.shipIds.includes(s.id))).map(f=>f.id);
    wave.shipIds=state.fleets.filter(f=>wave.fleetIds.includes(f.id)).flatMap(f=>f.ships.filter(s=>wave.shipIds.includes(s.id)).map(s=>s.id));
    wave.projects=wave.projects.filter(p=>state.systems.some(s=>s.projects.some(q=>q.id===p.id)));
    for(const id of wave.fleetIds)if(!memory.tasks.some(t=>t.fleetId===id))memory.tasks.push({fleetId:id,role:wave.role==='garrison'?'hold':wave.role==='home'?'defend':'assemble',target:wave.role==='support'?wave.staging:wave.target,campaignId:operation!.id,warId:operation!.warId,expiresDay:operation!.deadline});
  }
  memory.tasks=memory.tasks.filter(task=>{
    const fleet=state.fleets.find(fleet=>fleet.id===task.fleetId&&fleet.ownerId===actor);
    if(!fleet||task.expiresDay!==undefined&&task.expiresDay<=state.day)return false;
    if(task.warId&&!state.wars?.some(war=>war.id===task.warId&&war.endedDay===undefined))return false;
    if(task.role==='withdraw')return !!fleet.withdrawal||fleet.order?.systemId===task.target||fleet.transit?.to===task.target;
    if(task.role==='hold')return state.wars?.some(war=>war.endedDay===undefined&&war.factions.includes(actor)&&(war.type==='total'&&state.systems.some(s=>s.id===task.target&&controller(s)===actor)||war.goals[actor]?.some(goal=>goal.systemId===task.target&&!goal.invalid)))??false;
    if(task.role==='defend')return militaryKnowledge(state,actor).some(record=>canFight(state.relations[relationKey(actor,record.fleet.ownerId)])&&arrivalV415(state,record.fleet.ownerId,record.fleet,task.target)<=CONFIG.crisisDays);
    return !!memory.operation&&memory.operation.stage!=='exit'&&task.campaignId===memory.operation.id;
  });
}

export function scoreIntervalsV415(state:GameState,actor:string) {
  const result:Record<string,{low:number;high:number|null}>={[actor]:{low:scoreBreakdown(state,actor).total,high:scoreBreakdown(state,actor).total}};
  const records=militaryKnowledge(state,actor);
  for(const relation of Object.values(state.relations).filter(relation=>relation.factions.includes(actor)&&relation.status!=='unknown')) {
    const opponent=relation.factions.find(id=>id!==actor)!;
    result[opponent]={low:state.systems.filter(system=>system.ownerId===opponent).length*100+fleetScore(records.filter(record=>record.fleet.ownerId===opponent).map(record=>record.fleet)),high:null};
  }
  return result;
}

export function tacticalV415(state:GameState,request:TacticalRequestV415):MilitaryOptionV415 {
  const {actor}=request,option:MilitaryOptionV415=structuredClone(request.option),opponent=option.opponent;
  const ownFactors=economyFactors(state)[actor];
  const records=militaryKnowledge(state,actor).filter(record=>record.fleet.ownerId===opponent||canFight(state.relations[relationKey(actor,record.fleet.ownerId)]));
  const originalFleets=state.fleets.filter(fleet=>fleet.ownerId===actor);
  const ownQuote=policyComparison(state,actor,[state.factions[actor].policy?.choice??'none'])[0];
  const remaining=(state.config.maxRounds-state.round)*100;
  const assignedShips=new Set(originalFleets.filter(fleet=>option.fleetIds.includes(fleet.id)).flatMap(fleet=>fleet.ships.map(ship=>ship.id)));
  const ownInitial=fleetScore(originalFleets);
  const enemyInitial=fleetScore(records.map(record=>record.fleet));
  const scenarios:TacticalScenarioV4[]=[];
  option.scenarioEvidence=records.map(r=>({kind:'observed',day:r.day,source:r.fleet.id,assumption:'仅已观测舰队；到达与参战按合法路径推进'}));
  for(const kind of ['hold','reinforce','counterattack'] as const) {
    const systems=structuredClone(state.systems).map(system=>({...system,projects:[]}));
    const relations=structuredClone(Object.fromEntries(Object.entries(state.relations).filter(([,relation])=>relation.factions.includes(actor))));
    relations[relationKey(actor,opponent)]={...relations[relationKey(actor,opponent)],status:option.response==='wait'&&!activeWar(state,actor,opponent)?state.relations[relationKey(actor,opponent)].status:'war'};
    const war:War=structuredClone(activeWar(state,actor,opponent)??{id:'v415-projection',factions:[actor,opponent],type:option.warType as WarType,startedDay:state.day,startedRound:state.round,attackers:[actor],reasons:{},goals:{[actor]:['total','contact'].includes(option.warType)?[]:[{systemId:option.target,type:option.warType as Exclude<WarType,'total'|'contact'>,heldDays:option.heldDays??0}],[opponent]:[]},fatigue:{[actor]:0,[opponent]:0},openingValue:{},lossWindow:0,lossUsed:{}});
    const wars=[...(option.response==='wait'&&!activeWar(state,actor,opponent)?[]:[war]),...structuredClone((state.wars??[]).filter(w=>w.id!==war.id&&w.endedDay===undefined&&w.factions.includes(actor)))];
    const probe:GameState={...structuredClone(state),systems,relations,wars,events:[]};
    for(const id of war.factions){war.goals[id]??=[];war.fatigue[id]??=0;}
    for(const goal of war.goals[actor])if(goal.heldDays>0&&goal.heldSince===undefined)goal.heldSince=state.day-goal.heldDays;
    let fleets=structuredClone([...originalFleets,...records.map(record=>record.fleet)]);
    const repairState=probe;repairState.fleets=fleets;
    const paidSpawned=new Set<string>();let addedOwnScore=0;
    const supports=new Set(option.waves?.filter(w=>w.role==='support').flatMap(w=>w.shipIds)??[]);
    const production=kind==='hold'?[]:Object.values(state.factions[actor].intel).filter(i=>state.day-i.day<=CONFIG.intelDays&&i.system.ownerId===opponent).flatMap(i=>i.system.planets.filter(p=>p.ownerId===opponent&&p.structures.some(b=>b.type==='shipyard'&&!b.sealed)).map(p=>({systemId:i.system.id,id:p.id,day:i.day})));
    for(const yard of production)option.scenarioEvidence.push({kind:'conditional-production',day:yard.day,source:yard.id,assumption:'压力情景：已观察船厂若能获得资金和岗位，可按规则补充驱逐舰；不推断实际库存'});
    let pressureAdded=0;
    const factors:Record<string,FactionFactors>=Object.fromEntries(state.config.factionIds.map(id=>[id,id===actor?ownFactors:{unity:6000,shortages:{energy:false,food:false,minerals:false},civilizationCombat:1}]));
    const vulnerable=systems.filter(system=>system.ownerId===actor&&system.planets.some(planet=>planet.ownerId===actor)).sort((first,second)=>(first.base?.hull??0)+fleetPowerTotal(fleets.filter(fleet=>fleet.ownerId===actor&&fleet.systemId===first.id&&!option.fleetIds.includes(fleet.id)))-(second.base?.hull??0)-fleetPowerTotal(fleets.filter(fleet=>fleet.ownerId===actor&&fleet.systemId===second.id&&!option.fleetIds.includes(fleet.id)))||first.id.localeCompare(second.id))[0];
    const issue=(fleet:Fleet,target:string)=>{
      const start=fleet.transit?.to??fleet.systemId;if(!start)return;
      const path=accessiblePath(probe,fleet.ownerId,start,target);if(!path)return;
      fleet.order={systemId:target,position:{x:500,y:500},targetFleetId:null,route:path};
    };
    let launched=option.mode==='defend'||!!option.holding;
    for(const fleet of fleets) {
      if(fleet.ownerId===actor&&option.response==='wait')continue;
      if(fleet.ownerId===actor&&option.fleetIds.includes(fleet.id))issue(fleet,option.mode==='defend'?option.target:option.staging??fleet.systemId??option.target);
      else if(fleet.ownerId===actor&&fleet.ships.some(s=>supports.has(s.id)))issue(fleet,option.waves?.find(w=>w.role==='support'&&fleet.ships.some(s=>w.shipIds.includes(s.id)))?.staging??option.staging??option.target);
      else if(fleet.ownerId===opponent&&option.mode==='defend'&&option.threatFleetIds&&!option.threatFleetIds.includes(fleet.id))continue;
      else if(fleet.ownerId===opponent&&(kind!=='hold'||option.mode==='defend'))issue(fleet,kind==='counterattack'&&option.mode!=='defend'&&fleet.systemId!==option.target&&vulnerable?vulnerable.id:option.target);
      else if(fleet.ownerId===opponent)fleet.order=null;
    }
    let capturedDay:number|null=option.holding?state.day-(option.heldDays??0):null,heldDays=option.heldDays??0;
    const until=Math.min(remaining,option.arrival+CONFIG.tacticalDays);
    for(let elapsed=10;elapsed<=until;elapsed+=10) {
      const day=state.day+elapsed;
      const assigned=fleets.filter(fleet=>fleet.ownerId===actor&&fleet.ships.some(ship=>assignedShips.has(ship.id)));
      // New commands are issued only at the same 100-day boundaries as the live controller.
      const decisionBoundary=(elapsed-10)%100===0;
      if(decisionBoundary) {
        for(const p of option.waves?.flatMap(w=>w.projects)??[])if(!paidSpawned.has(p.id)&&day-10>=p.completeDay&&controller(systems.find(s=>s.id===p.systemId)!)===actor) {
          paidSpawned.add(p.id);const ship={id:'paid:'+p.id,type:p.shipType as keyof typeof SHIPS,hull:SHIPS[p.shipType as keyof typeof SHIPS].power};supports.add(ship.id);
          const fleet:Fleet={id:'paid:'+p.id,name:'paid support',ownerId:actor,systemId:p.systemId,position:{x:500,y:500},transit:null,order:null,ships:[ship]};fleets.push(fleet);addedOwnScore+=SHIPS[p.shipType as keyof typeof SHIPS].power*ESCALATION.fleetScoreFactor;if(option.response!=='wait')issue(fleet,option.waves?.find(w=>w.projects.some(q=>q.id===p.id))?.staging??option.staging??option.target);
        }
        const support=fleets.filter(f=>f.ownerId===actor&&f.ships.some(s=>supports.has(s.id))&&!f.transit);
        const supportStaging=option.waves?.find(w=>w.role==='support')?.staging??option.staging??option.target;
        const ready=support.filter(f=>f.systemId===supportStaging&&distance(f.position,{x:500,y:500})<=20);
        if(ready.length&&option.response!=='wait') {
          const knownThreat=records.filter(r=>arrivalV415(probe,opponent,r.fleet,option.target)<=option.arrival+200).reduce((n,r)=>n+fleetPower(r.fleet),0);
          const joined=assigned.filter(f=>f.systemId===option.target&&!f.transit).reduce((n,f)=>n+fleetPower(f),0);
          const escort={...ready[0],ships:ready.flatMap(f=>f.ships)};
          if((joined+fleetPowerTotal(ready)>knownThreat||option.mode==='defend')&&routeSafeV415(probe,actor,escort,option.target,true)) {
            const lead=ready[0];lead.ships=ready.flatMap(f=>f.ships);fleets=fleets.filter(f=>f===lead||!ready.includes(f));issue(lead,option.target);
          }
        }
        for(const yard of production)if(controller(systems.find(s=>s.id===yard.systemId)!)===opponent&&elapsed-10>=SHIPS.destroyer.days&&pressureAdded<production.length*Math.floor((elapsed-10)/SHIPS.destroyer.days)) {
          const fleet:Fleet={id:'pressure:'+yard.id+':'+elapsed,name:'conditional production',ownerId:opponent,systemId:yard.systemId,position:{x:500,y:500},transit:null,order:null,ships:[{id:'pressure:'+yard.id+':'+elapsed,type:'destroyer',hull:SHIPS.destroyer.power}]};fleets.push(fleet);pressureAdded++;issue(fleet,kind==='counterattack'&&vulnerable?vulnerable.id:option.target);
        }
      }
      if(option.response!=='wait'&&decisionBoundary&&!launched&&day-10>=(option.availableDay??state.day)&&assigned.length&&assigned.every(fleet=>fleet.systemId===assigned[0].systemId&&!fleet.transit&&distance(fleet.position,assigned[0].position)<=20)) {
        const batch=assigned.slice(0,20),combined=batch[0];combined.ships=batch.flatMap(fleet=>fleet.ships);
        fleets=fleets.filter(fleet=>fleet===combined||!batch.includes(fleet));
        if(assigned.length<=20){issue(combined,option.target);launched=true;}
      }
      for(const fleet of fleets) {
        delete fleet.previousPosition;delete fleet.departedDay;delete fleet.movementDays;
        if(!fleet.transit)continue;
        fleet.transit.remainingDays-=10;
        if(fleet.transit.remainingDays<=0) {
          const target=systems.find(system=>system.id===fleet.transit!.to)!;
          fleet.position={...target.gates[fleet.transit.from]};fleet.movementDays=Math.min(10,-fleet.transit.remainingDays);fleet.systemId=target.id;fleet.transit=null;
        }
      }
      for(const phase of ['advance','combat'] as const) {
        const output=processLocal({phase,seed:state.config.seed,day,systems,fleets,factions:factors,relations,wars});fleets=output.fleets;
        probe.day=day;probe.fleets=fleets;
        if(output.captures.length)settleCaptures(probe,output.captures);
      }
      // Reserve baseline maintenance/welfare before repair. Positive future
      // production is deliberately not spent twice on tactical repairs.
      for(const r of ['energy','food','minerals','alloys'] as const)probe.factions[actor].resources[r]=Math.max(0,(probe.factions[actor].resources[r]??0)+Math.min(0,ownQuote.net[r]??0)*100);
      if(!Object.values(ownFactors.shortages).some(Boolean)) {repairState.day=day;repairState.fleets=fleets;repairFaction(repairState,actor);}
      updateWars(probe);
      restoreBases(probe);
      const target=systems.find(system=>system.id===option.target)!;
      if(controller(target)===actor) {capturedDay??=day;heldDays+=10;}else{capturedDay=null;heldDays=0;}
    }
    const won=controller(systems.find(system=>system.id===option.target)!)===actor;
    const ownLoss=Math.max(0,ownInitial+addedOwnScore-fleetScore(fleets.filter(fleet=>fleet.ownerId===actor)));
    const observedShips=new Set(records.flatMap(r=>r.fleet.ships.map(s=>s.id)));
    const enemyLoss=Math.max(0,enemyInitial-fleetScore(fleets.filter(fleet=>fleet.ownerId!==actor).map(f=>({...f,ships:f.ships.filter(s=>observedShips.has(s.id))}))));
    const exposedLoss=systems.filter(system=>state.systems.find(original=>original.id===system.id)!.ownerId===actor&&controller(system)!==actor).reduce((sum,system)=>sum+100+system.planets.filter(planet=>planet.population>0).reduce((value,planet)=>value+200+5*planet.population,0),0);
    const achieved=won&&(option.warType==='total'||heldDays>=200);
    const eliminated=systems.every(system=>system.ownerId!==actor);
    option.eliminated=option.eliminated||eliminated;
    // Settlement uses the native rules. Foreign balances in the knowledge
    // projection are placeholders, so compensation/foreign Q never contribute
    // an asserted exact benefit.
    if(option.response!=='wait'&&option.mode!=='defend'&&achieved&&war.type!=='total'&&(war.goals[actor]??[]).filter(g=>!g.invalid).every(g=>g.heldDays>=200))settleWar(probe,war,true,'V415 conditional settlement');
    const beforeScore=scoreBreakdown(state,actor),afterScore=scoreBreakdown(probe,actor);
    // Tactical probes do not advance the economic/governance ledger. Its
    // changing lookback window must not manufacture a reward for moving ships.
    const quality=governanceView(state,actor).quality;
    const social=(world:GameState)=>world.systems.filter(s=>s.ownerId===actor).flatMap(s=>s.planets).filter(p=>p.ownerId===actor).reduce((n,p)=>n+200+5*p.population,0)*quality;
    const ownAssetDelta=afterScore.systems-beforeScore.systems+social(probe)-social(state)+afterScore.territory-beforeScore.territory+afterScore.objectives-beforeScore.objectives;
    const enemyTerritoryLoss=Math.max(0,state.systems.filter(s=>s.ownerId===opponent).length-systems.filter(s=>s.ownerId===opponent).length)*100;
    const temporaryLoss=(world:GameState)=>world.systems.filter(s=>s.ownerId===actor&&controller(s)!==actor).reduce((n,sys)=>n+100+sys.planets.filter(p=>p.ownerId===actor).reduce((v,p)=>v+(200+5*p.population)*quality,0),0);
    const blockedChange=temporaryLoss(probe)-temporaryLoss(state);
    const value=eliminated?-beforeScore.total:enemyLoss-ownLoss+ownAssetDelta+enemyTerritoryLoss-(option.response==='wait'&&!activeWar(state,actor,opponent)?0:option.maintenance)-blockedChange;

    scenarios.push({kind,won,ownLoss,enemyLoss,capturedDay,heldDays,exposedLoss,value});
  }
  option.scenarios=scenarios;
  option.distinctScenarios=new Set(scenarios.map(s=>JSON.stringify({...s,kind:undefined}))).size;
  if(option.distinctScenarios===1)option.scenarioEvidence.push({kind:'uncertainty',day:state.day,source:'own knowledge',assumption:'三个情景相同，不是三份独立安全证据；未知增援仍未知'});
  const ordered=scenarios.map(scenario=>scenario.value).sort((first,second)=>first-second);
  const ownScore=scoreBreakdown(state,actor).total,lower=Math.max(0,...Object.values(scoreIntervalsV415(state,actor)).filter(item=>item.high===null).map(item=>item.low));
  const contest=ownScore<lower||remaining<=1440;
  option.value=contest?ordered[1]*.75+ordered[0]*.25:ordered[1]*.5+ordered[0]*.5;
  if(!scenarios.some(scenario=>scenario.won))option.blockers.push('已评估兵力方案无法取得目标，比较增援、侦察或退出');
  if(option.unknown)option.value*=CONFIG.preparationDiscount;
  return option;
}

const fleetPowerTotal=(fleets:Fleet[])=>fleets.reduce((sum,fleet)=>sum+fleetPower(fleet),0);

export function militaryPlansV415(state:GameState,actor:string,facts:ReturnType<typeof candidateFacts>,memory:ScriptMemory) {
  const own=state.factions[actor],remaining=(state.config.maxRounds-state.round)*100,records=militaryKnowledge(state,actor);
  const ownFleets=state.fleets.filter(fleet=>fleet.ownerId===actor&&!fleet.withdrawal);
  const homeAssigned=new Set<string>();
  const homeTargets=new Map<string,string>();
  // Reserve each known incoming threat once, at its actual destination (or the
  // nearest reachable colony). Other forces remain available for concentration.
  const homeThreats=new Map<string,number>();
  const threatBySystem=new Map<string,Set<string>>();
  for(const record of records.filter(r=>state.day-r.day<=CONFIG.intelDays&&canFight(state.relations[relationKey(actor,r.fleet.ownerId)]))) {
    const targets=state.systems.filter(s=>s.ownerId===actor).map(s=>({s,days:arrivalV415(state,record.fleet.ownerId,record.fleet,s.id)})).filter(x=>x.days<=CONFIG.crisisDays).sort((a,b)=>Number(b.s.id===record.fleet.order?.systemId)-Number(a.s.id===record.fleet.order?.systemId)||a.days-b.days||a.s.id.localeCompare(b.s.id));
    if(targets[0]) {
      homeThreats.set(targets[0].s.id,(homeThreats.get(targets[0].s.id)??0)+fleetPower(record.fleet));
      const ids=threatBySystem.get(targets[0].s.id)??new Set<string>();
      ids.add(record.fleet.id); threatBySystem.set(targets[0].s.id,ids);
    }
  }
  for(const [id,threat] of [...homeThreats].sort(([a],[b])=>a.localeCompare(b))) {
    let covered=state.systems.find(s=>s.id===id)?.base?.hull??0;
    for(const fleet of ownFleets.filter(f=>!homeAssigned.has(f.id)&&arrivalV415(state,actor,f,id)<=100).sort((a,b)=>arrivalV415(state,actor,a,id)-arrivalV415(state,actor,b,id)||a.id.localeCompare(b.id))) {
      if(covered>=threat)break;homeAssigned.add(fleet.id);homeTargets.set(fleet.id,id);covered+=fleetPower(fleet);
    }
  }
  const plans:MilitaryOptionV415[]=[];
  for(const system of state.systems.filter(system=>system.ownerId===actor)) {
    const assignedThreats=threatBySystem.get(system.id);
    const threats=records.filter(record=>canFight(state.relations[relationKey(actor,record.fleet.ownerId)])&&
      (assignedThreats?.has(record.fleet.id)??false)&&arrivalV415(state,record.fleet.ownerId,record.fleet,system.id)<=CONFIG.crisisDays);
    const occupier=controller(system)!==actor?controller(system):null;
    for(const opponent of [...new Set([...threats.map(record=>record.fleet.ownerId),...(occupier&&canFight(state.relations[relationKey(actor,occupier)])?[occupier]:[])])]) {
      const hostile=threats.filter(record=>record.fleet.ownerId===opponent),arrival=hostile.length?Math.min(...hostile.map(record=>arrivalV415(state,opponent,record.fleet,system.id))):0;
      const recapture=occupier===opponent;
      const knownPower=fleetPowerTotal(hostile.map(record=>record.fleet))+(recapture?system.base?.hull??0:0);
      const local=ownFleets.filter(fleet=>fleet.systemId===system.id&&!fleet.order);
      // Local hull totals cannot certify defense; compare the combat timelines.
      const available=ownFleets.filter(fleet=>(!homeTargets.has(fleet.id)||homeTargets.get(fleet.id)===system.id)&&!fleet.transit&&!fleet.withdrawal&&arrivalV415(state,actor,fleet,system.id)<=Math.max(arrival,recapture?CONFIG.tacticalDays:100));
      // Keep an unfilled defense requirement available to shipbuilding even
      // when no existing fleet can arrive. It cannot emit a move by itself.
      plans.push({id:'defense:'+system.id+':'+opponent,opponent,target:system.id,warType:activeWar(state,actor,opponent)?.type??'contact',mode:'defend',threatFleetIds:hostile.map(r=>r.fleet.id),fleetIds:available.map(fleet=>fleet.id),staging:system.id,arrival,expectedDay:state.day+arrival,knownPower,availablePower:fleetPowerTotal(available),unknown:hostile.some(record=>state.day-record.day>CONFIG.intelDays),intelDays:hostile.map(record=>record.day),scenarios:[],territory:100+system.planets.filter(planet=>planet.ownerId===actor).reduce((sum,planet)=>sum+200+5*planet.population,0),duty:0,maintenance:0,value:1000+knownPower,blockers:[],ready:true,preparation:false});
    }
  }
  for(const comparison of facts.facts.comparison.wars) {
    const opponent=comparison.target,war=activeWar(state,actor,opponent);
    const probe={...state,relations:{...state.relations,[relationKey(actor,opponent)]:{...state.relations[relationKey(actor,opponent)],status:'war' as const}}};
    const continuing=memory.operation?.opponent===opponent?memory.operation.targets:[];
    const targetIds=[...new Set([...(comparison.targetIntel??[]).map(t=>t.systemId),...continuing])];
    for(const targetId of targetIds) {
      const targetInfo={systemId:targetId};
      const target=state.systems.find(system=>system.id===targetInfo.systemId)!;
      const holding=controller(target)===actor;
      if(holding&&!war)continue;
      if(war&&war.type!=='total'&&!war.goals[actor]?.some(goal=>!goal.invalid&&goal.systemId===target.id))continue;
      const intel=own.militaryIntel?.[target.id]??own.intel[target.id];
      const unknown=!intel||state.day-intel.day>CONFIG.intelDays;
      const legal=comparison.options.filter(option=>option.allowed&&(option.warType==='total'||option.systemIds.includes(target.id)));
      const preparation=!war&&!legal.some(option=>option.warType==='total')&&comparison.preparation.allowed;
      const pendingPreparation=state.conquests?.find(item=>item.actor===actor&&item.target===opponent&&item.endedDay===undefined);
      const newClaim=!war&&comparison.claims.some(claim=>claim.systemId===target.id&&claim.allowed&&!claim.existingClaim)&&!legal.some(option=>option.warType==='claim'&&option.systemIds.includes(target.id));
      const types=war?[{warType:war.type,systemIds:war.goals[actor]?.filter(goal=>!goal.invalid).map(goal=>goal.systemId)??[],grievanceId:null}]:[...legal,...(preparation||pendingPreparation&&!legal.some(option=>option.warType==='total')?[{warType:'total',systemIds:[],grievanceId:null}]:[]),...(newClaim?[{warType:'claim',systemIds:[target.id],grievanceId:null}]:[])];
      const reachable=ownFleets.filter(fleet=>!homeAssigned.has(fleet.id)&&!memory.tasks.some(task=>task.fleetId===fleet.id&&['hold','defend'].includes(task.role)&&task.target!==target.id)).map(fleet=>({fleet,days:arrivalV415(probe,actor,fleet,target.id)})).filter(item=>item.days<remaining-200).sort((first,second)=>first.days-second.days||first.fleet.id.localeCompare(second.fleet.id));
      if(!reachable.length)continue;
      const defending=records.filter(record=>record.fleet.ownerId===opponent&&record.fleet.systemId===target.id);
      const enemy=(holding?0:target.base?.hull??0)+fleetPowerTotal(defending.map(record=>record.fleet));
      const limited:typeof reachable=[];let power=0;
      for(const item of reachable){limited.push(item);power+=fleetPower(item.fleet);if(power>enemy)break;}
      const existing=memory.operation as CampaignV415|undefined;
      const committed=existing&&existing.stage!=='exit'&&existing.opponent===opponent&&existing.targets.includes(target.id);
      const assigned=new Set(committed?existing.shipIds??[]:[]);
      const fixed=reachable.filter(item=>item.fleet.ships.some(ship=>assigned.has(ship.id)));
      const variants=committed&&fixed.length?['continue','supported'] as const:['limited','concentrated','supported'] as const;
      for(const variant of variants) {
        const mode=variant==='limited'?'limited':'concentrated';
        const fast=reachable.filter(item=>item.days<=reachable[0].days+CONFIG.supportWindow);
        const force=committed&&fixed.length?fixed:variant==='limited'?limited:variant==='supported'?fast:reachable;
        if(!force.length)continue;
        const staging=state.systems.filter(system=>controller(system)===actor&&force.every(item=>Number.isFinite(arrivalV415(state,actor,item.fleet,system.id)))).sort((first,second)=>Math.max(...force.map(item=>arrivalV415(state,actor,item.fleet,first.id)))+arrivalV415(probe,actor,{...force[0].fleet,systemId:first.id,transit:null,position:{x:500,y:500}},target.id)-Math.max(...force.map(item=>arrivalV415(state,actor,item.fleet,second.id)))-arrivalV415(probe,actor,{...force[0].fleet,systemId:second.id,transit:null,position:{x:500,y:500}},target.id)||first.id.localeCompare(second.id))[0];
        const clustered=force.every(item=>item.fleet.systemId===force[0].fleet.systemId&&!item.fleet.transit&&distance(item.fleet.position,force[0].fleet.position)<=20);
        const ready=clustered&&force.length<=20;
        const gathered=holding?target.id:committed&&existing.staging?existing.staging:ready?force[0].fleet.systemId:staging?.id;
        const slowest=force.flatMap(item=>item.fleet.ships).sort((first,second)=>SHIPS[first.type].speed-SHIPS[second.type].speed)[0];
        const gatherDays=ready?0:gathered?Math.max(...force.map(item=>arrivalV415(state,actor,item.fleet,gathered))):Infinity;
        const travelDays=gathered?arrivalV415(probe,actor,{...force[0].fleet,systemId:gathered,transit:null,position:ready?force[0].fleet.position:{x:500,y:500},ships:[slowest]},target.id):Infinity;
        for(const type of types) {
          const prep=type.warType==='total'&&preparation;
          const claim=type.warType==='claim'&&newClaim;
          const wait=prep?preparationRule(state,actor).days:type.warType==='total'&&pendingPreparation?Math.max(0,pendingPreparation.readyDay-state.day):claim?100:0;
          const arrival=Math.max(wait,gatherDays)+travelDays;
          const colonies=target.planets.filter(planet=>planet.ownerId===opponent);
          const social=colonies.reduce((sum,planet)=>sum+200+5*planet.population,0);
          const territory=['total','claim'].includes(type.warType)?100+social*.5+100:50;
          const threatenedSocial=governanceView(state,actor).rawSocial;
          const duty=type.warType==='missionary'&&own.faith?threatenedSocial*Math.min(1,own.faith.crisis/100):type.warType==='humanitarian'&&own.civilization?.choice==='utopia'?(own.responsibility?.rescuePenalty??0):own.civilization?.choice==='militarist'?threatenedSocial*Math.min(1,(own.responsibility?.dissatisfaction??0)/100):0;
          const maintenance=type.warType==='total'?(comparison.totalWarExtraPer100.energy+comparison.totalWarExtraPer100.minerals)*Math.min(remaining,arrival+600)/100*CONFIG.investmentValue:0;
          const id=['military',opponent,target.id,type.warType,variant].join(':');
          const blockers=[...(unknown?['目标军情未知或超过200日']:[]),...(!ready?['指定舰队尚未集中，先集结再协调进攻']:[]),...(prep?['尚需征服准备']:[])];
          plans.push({id,variant,holding,heldDays:war?.goals[actor]?.find(g=>g.systemId===target.id)?.heldDays??0,planKey:opponent+':'+type.warType+':'+target.id,opponent,target:target.id,warType:type.warType,mode,fleetIds:force.map(item=>item.fleet.id),staging:gathered??null,arrival,expectedDay:state.day+arrival+200,knownPower:enemy,availablePower:fleetPowerTotal(force.map(item=>item.fleet)),unknown,intelDays:intel?[intel.day,...defending.map(record=>record.day)]:[],scenarios:[],territory,duty,maintenance,value:territory+duty+fleetScore(defending.map(record=>record.fleet))*.5-maintenance,blockers,ready,preparation:prep,claim,availableDay:state.day+wait});
        }
      }
    }
  }
  for(const plan of plans) {
    const target=state.systems.find(s=>s.id===plan.target)!;
    const force=ownFleets.filter(f=>plan.fleetIds.includes(f.id));
    const staging=plan.staging??plan.target;
    const primary:WaveV415={role:plan.holding?'garrison':plan.mode==='defend'?'home':'assault',fleetIds:force.map(f=>f.id),shipIds:force.flatMap(f=>f.ships.map(s=>s.id)),target:plan.target,staging,departureDay:Math.max(state.day,plan.availableDay??state.day),arrivalDay:state.day+plan.arrival,projects:[]};
    const probe={...state,relations:{...state.relations,[relationKey(actor,plan.opponent)]:{...state.relations[relationKey(actor,plan.opponent)],status:'war' as const}}};
    const supporting=plan.variant==='supported'||plan.holding||plan.mode==='defend'?ownFleets.filter(f=>!homeAssigned.has(f.id)&&!plan.fleetIds.includes(f.id)&&!memory.tasks.some(t=>t.fleetId===f.id&&['hold','defend'].includes(t.role)&&t.target!==plan.target)&&Number.isFinite(arrivalV415(probe,actor,f,plan.target))):[];
    const paid=paidReinforcementsV415(state,actor).map(p=>{const mock:Fleet={id:p.id,ownerId:actor,name:'paid',systemId:p.systemId,position:{x:500,y:500},order:null,transit:null,ships:[{id:p.id,type:p.shipType,hull:SHIPS[p.shipType].power}]};return {...p,arrivalDay:Math.ceil(p.completeDay/100)*100+arrivalV415(probe,actor,mock,plan.target)};}).filter(p=>p.arrivalDay<=plan.expectedDay+CONFIG.supportWindow);
    // Secondary forces assemble at a legal rear base, including after capture.
    const rear=plan.holding?state.systems.filter(s=>s.ownerId===actor&&controller(s)===actor&&s.id!==plan.target).sort((a,b)=>Math.max(0,...supporting.map(f=>arrivalV415(state,actor,f,a.id)))-Math.max(0,...supporting.map(f=>arrivalV415(state,actor,f,b.id)))||a.id.localeCompare(b.id))[0]?.id??staging:staging;
    const support:WaveV415={role:'support',fleetIds:supporting.map(f=>f.id),shipIds:supporting.flatMap(f=>f.ships.map(s=>s.id)),staging:rear,target:plan.target,departureDay:state.day,arrivalDay:state.day+Math.max(0,...supporting.map(f=>arrivalV415(probe,actor,f,plan.target)),...paid.map(p=>p.arrivalDay-state.day)),projects:paid};
    const home=ownFleets.filter(f=>homeAssigned.has(f.id)&&!plan.fleetIds.includes(f.id));
    plan.waves=[primary,...(supporting.length||paid.length?[support]:[]),...home.map(f=>({role:'home' as const,fleetIds:[f.id],shipIds:f.ships.map(s=>s.id),target:f.order?.systemId??f.systemId??f.transit!.to,staging:f.systemId??f.transit!.to,departureDay:state.day,arrivalDay:state.day,projects:[]}))];
    const reinforcement=records.filter(r=>r.fleet.ownerId===plan.opponent&&arrivalV415(probe,plan.opponent,r.fleet,target.id)<=plan.arrival+200).reduce((n,r)=>n+fleetPower(r.fleet),0);
    const friendlyBase=controller(target)===actor&&(target.base?.disabledUntil??0)<=state.day?(target.base?.hull??0):0;
    const hostileBase=controller(target)!==actor&&!plan.holding?(target.base?.hull??0):0;
    // A home base supports defense. Counting it as hostile manufactures a ship
    // deficit and locks colonial capital even after sufficient forces assemble.
    plan.requiredPower=Math.max(0,Math.max(plan.knownPower,reinforcement+hostileBase)-friendlyBase);
    plan.paidPower=paid.filter(p=>p.arrivalDay<=state.day+plan.arrival).reduce((n,p)=>n+SHIPS[p.shipType].power,0);
    plan.shortPower=Math.max(0,plan.requiredPower-plan.availablePower-plan.paidPower);
  }
  return plans.filter(plan=>plan.expectedDay<=state.day+remaining).sort((first,second)=>second.value-first.value||first.id.localeCompare(second.id));
}

export function militaryActionV415(state:GameState,actor:string,option:MilitaryOptionV415,facts:ReturnType<typeof candidateFacts>):MilitaryCandidateV415|null {
  if(option.value<=0||option.eliminated)return null;
  const comparison=facts.facts.comparison.wars.find(war=>war.target===option.opponent)!;
  const war=activeWar(state,actor,option.opponent);
  const force=state.fleets.filter(fleet=>option.fleetIds.includes(fleet.id));
  if(!force.length&&option.mode!=='defend')return null;
  if(war&&war.type!=='total'&&option.mode!=='defend'&&!war.goals[actor]?.some(goal=>!goal.invalid&&goal.systemId===option.target))return null;
  let kind='war',actions:Action[]=[];
  if(option.holding) {
    const eligible=war?.goals[actor]?.filter(g=>!g.invalid)??[];
    if(eligible.length&&eligible.every(g=>g.heldDays>=200)) {actions=[{type:'enforce_peace',args:{factionId:option.opponent}}];kind='settle';}
    else {actions=supportActionsV415(state,actor,option);kind='hold';}
  } else if(option.mode==='defend') {
    actions=force.filter(fleet=>!fleet.transit&&fleet.order?.systemId!==option.target&&(fleet.systemId!==option.target||distance(fleet.position,{x:500,y:500})>20)).map(fleet=>move(fleet.id,option.target));kind='defend';
  } else if(option.unknown&&!option.ready&&option.staging&&controller(state.systems.find(s=>s.id===option.staging)!)===actor) {
    actions=force.filter(f=>!f.transit&&f.order?.systemId!==option.staging&&(f.systemId!==option.staging||distance(f.position,{x:500,y:500})>20)&&routeSafeV415(state,actor,f,option.staging!)).map(f=>move(f.id,option.staging!));kind='assemble';
  } else if(option.unknown) {
    const scout=force.filter(fleet=>!fleet.order&&!fleet.transit&&Number.isFinite(arrivalV415(state,actor,fleet,option.target))).sort((first,second)=>fleetPower(first)-fleetPower(second))[0];
    const target=state.systems.find(system=>system.id===option.target)!;
    if(!scout)return null;
    const path=accessiblePath(state,actor,scout.systemId!,target.id);if(!path?.length)return null;
    const gate=target.gates[path.length>1?path.at(-2)!:scout.systemId!];if(!gate)return null;
    const hostile=canFight(state.relations[relationKey(actor,option.opponent)]);
    if(hostile&&(!option.ready||force.length>20||!option.scenarios.length||!option.scenarios.every(s=>s.won)))return null;
    // A hostile border visit uses the evaluated concentrated force. Do not send
    // a tiny scout whose survival was never evaluated by that plan.
    const lead=hostile?force[0]:scout;
    if(hostile&&force.length>1)actions.push({type:'merge_fleets',args:{fleetIds:force.map(f=>f.id)}});
    actions.push({type:'move_fleet',args:{fleetId:lead.id,systemId:target.id,x:gate.x,y:gate.y,targetFleetId:null}});kind='scout';
  } else if(option.claim) {
    actions=[{type:'create_claim',args:{systemId:option.target}}];kind='claim';
  } else if(option.preparation) {
    actions=[{type:'prepare_conquest',args:{factionId:option.opponent,reason:'V415比较实际战损、对手失分和可兑现目标后准备'}}];kind='prepare';
  } else if(!option.ready) {
    if(!option.staging)return null;
    const grouped=force.length>20&&force.every(fleet=>fleet.systemId===force[0].systemId&&!fleet.transit&&distance(fleet.position,force[0].position)<=20);
    actions=grouped?[{type:'merge_fleets',args:{fleetIds:force.slice(0,20).map(fleet=>fleet.id)}}]:force.filter(fleet=>!fleet.transit&&fleet.order?.systemId!==option.staging&&(fleet.systemId!==option.staging||distance(fleet.position,{x:500,y:500})>20)).map(fleet=>move(fleet.id,option.staging!));kind='assemble';
  } else {
    if((option.availableDay??state.day)>state.day)return null;
    const selected=comparison.options.find(item=>item.allowed&&item.warType===option.warType&&(item.warType==='total'||item.systemIds.includes(option.target)));
    if(!war&&!selected)return null;
    if(!war)actions.push({type:'declare_war',args:{factionId:option.opponent,warType:option.warType,systemIds:option.warType==='total'?[]:[option.target],grievanceId:selected!.grievanceId??null,reason:'V415比较主力、支援、占领与反击后的可兑现收益'}});
    if(force.length>1)actions.push({type:'merge_fleets',args:{fleetIds:force.map(fleet=>fleet.id)}});
    if(force[0]&&!(force.length===1&&(force[0].order?.systemId===option.target||force[0].transit?.to===option.target)))actions.push(move(force[0].id,option.target));
  }
  if(kind==='war'||kind==='assemble'||kind==='defend')actions.push(...supportActionsV415(state,actor,option).filter(a=>!actions.some(b=>JSON.stringify(a)===JSON.stringify(b))));
  const routeState=actions.some(action=>action.type==='declare_war')?{...state,relations:{...state.relations,[relationKey(actor,option.opponent)]:{...state.relations[relationKey(actor,option.opponent)],status:'war' as const}}}:state;
  for(const action of actions.filter(action=>action.type==='move_fleet')) {
    const fleet=state.fleets.find(fleet=>fleet.id===action.args.fleetId);
    const start=fleet?.transit?.to??fleet?.systemId;
    if(!start||!accessiblePath(routeState,actor,start,String(action.args.systemId)))return null;
  }
  if(!actions.length)return null;
  const assigned=state.fleets.filter(f=>option.fleetIds.includes(f.id)||actions.some(a=>a.args.fleetId===f.id||(a.args.fleetIds as string[]|undefined)?.includes(f.id)));
  return {id:option.id,label:kind+' '+option.opponent+'/'+option.target,kind,target:option.target,actions,priority:option.mode==='defend'||option.holding?3:option.duty>0?2:1,value:option.value*(['war','defend','hold','settle'].includes(kind)?1:CONFIG.preparationDiscount),risk:0,reason:JSON.stringify(option),evidenceDays:option.intelDays,progress:option.id,deadline:option.expectedDay,economic:false,exclusive:[...(option.mode==='defend'?[]:['offensive-campaign']),...assigned.map(fleet=>'fleet:'+fleet.id)],fingerprint:option.id,tasks:assigned.map(fleet=>({fleetId:fleet.id,role:kind==='hold'?'hold':kind==='defend'?'defend':kind==='war'?'attack':'assemble',target:['war','defend','hold'].includes(kind)?option.target:option.staging??option.target,campaignId:option.id,expiresDay:option.expectedDay+600,...(war?{warId:war.id}:{})})),successDay:option.expectedDay,military:option};
}

/** Stage secondary forces together. Only a viable escort/group enters the front. */
export function supportActionsV415(state:GameState,actor:string,option:MilitaryOptionV415):Action[] {
  const actions:Action[]=[],records=militaryKnowledge(state,actor).filter(r=>r.fleet.ownerId===option.opponent);
  for(const wave of option.waves?.filter(w=>w.role==='support')??[]) {
    const fleets=state.fleets.filter(f=>f.ownerId===actor&&wave.shipIds.some(id=>f.ships.some(s=>s.id===id))&&!f.withdrawal);
    const stationary=fleets.filter(f=>!f.transit),ready=stationary.filter(f=>f.systemId===wave.staging&&distance(f.position,{x:500,y:500})<=20);
    const threat=records.filter(r=>arrivalV415(state,option.opponent,r.fleet,wave.target)<=CONFIG.supportWindow).reduce((n,r)=>n+fleetPower(r.fleet),0);
    const present=state.fleets.filter(f=>f.ownerId===actor&&f.systemId===wave.target&&!f.transit&&!fleets.includes(f)).reduce((n,f)=>n+fleetPower(f),0);
    const escort=ready[0]?{...ready[0],ships:ready.flatMap(f=>f.ships)}:undefined;
    if(escort&&fleetPowerTotal(ready)+present>threat&&routeSafeV415(state,actor,escort,wave.target,true)) {
      const first=ready[0];for(let i=1;i<ready.length;i+=19)actions.push({type:'merge_fleets',args:{fleetIds:[first.id,...ready.slice(i,i+19).map(f=>f.id)]}});
      if(first.systemId!==wave.target||distance(first.position,{x:500,y:500})>20)actions.push(move(first.id,wave.target));
    }
    for(const fleet of stationary.filter(f=>!ready.includes(f)&&f.order?.systemId!==wave.staging&&f.order?.systemId!==wave.target&&routeSafeV415(state,actor,f,wave.staging)))actions.push(move(fleet.id,wave.staging));
  }
  return actions;
}

/** Only known contacts can veto a route; missing intelligence stays explicit. */
export function routeSafeV415(state:GameState,actor:string,fleet:Fleet,target:string,excludeTarget=false) {
  const start=fleet.transit?.to??fleet.systemId;if(!start)return false;
  const path=accessiblePath(state,actor,start,target);if(!path)return false;
  const records=militaryKnowledge(state,actor).filter(r=>canFight(state.relations[relationKey(actor,r.fleet.ownerId)]));
  for(const id of [start,...path].filter(id=>!excludeTarget||id!==target)) {
    const system=state.systems.find(s=>s.id===id)!;
    const arrival=arrivalV415(state,actor,fleet,id);
    const enemies=records.filter(r=>r.fleet.systemId===id||r.fleet.order?.systemId===id&&arrivalV415(state,r.fleet.ownerId,r.fleet,id)<=arrival);
    const base=controller(system)&&controller(system)!==actor&&canFight(state.relations[relationKey(actor,controller(system)!)])?(system.base?.hull??0):0;
    if(base+fleetPowerTotal(enemies.map(r=>r.fleet))>=fleetPower(fleet))return false;
  }
  return true;
}

export function campaignProgressV415(state:GameState,actor:string,memory:ScriptMemory) {
  const operation=memory.operation as CampaignV415|undefined;if(!operation)return;
  const war=activeWar(state,actor,operation.opponent);
  const target=state.systems.find(system=>system.id===operation.targets[0]);
  const relation=state.relations[relationKey(actor,operation.opponent)];
  const lostGoal=war&&war.type!=='total'&&!war.goals[actor]?.some(goal=>!goal.invalid&&operation.targets.includes(goal.systemId));
  const complete=!!operation.warId&&!war;
  if(complete||!target||lostGoal||operation.deadline<state.day||!war&&(relation?.pactUntil??0)>state.day) {
    operation.stage='exit';operation.ready=false;operation.reserve={};operation.completed=!!complete;
    operation.exitReason=complete?'关联战争已结算':lostGoal?'目标不属于当前战争条款':'目标、条约或最迟出发日期失效';
    operation.nextStep=operation.exitReason;memory.tasks=memory.tasks.filter(t=>t.campaignId!==operation.id);return;
  }
  if(war)operation.warId=war.id;
  const ships=new Set(operation.shipIds??[]);
  const fleets=state.fleets.filter(f=>f.ownerId===actor&&(operation.fleetIds.includes(f.id)||f.ships.some(s=>ships.has(s.id))));
  operation.fleetIds=fleets.map(f=>f.id);operation.shipIds=fleets.flatMap(f=>f.ships.map(s=>s.id));
  const intel=state.factions[actor].militaryIntel?.[target.id]??state.factions[actor].intel[target.id];
  const destination=war?target.id:operation.staging??target.id;
  const next={destination,reconDay:intel&&state.day-intel.day<=CONFIG.intelDays?intel.day:-1,
    prepared:state.conquests?.some(c=>c.actor===actor&&c.target===operation.opponent&&c.endedDay===undefined&&c.readyDay<=state.day)??false,
    arrived:fleets.filter(f=>f.systemId===destination&&!f.transit&&distance(f.position,{x:500,y:500})<=20).map(f=>f.id).sort(),
    distance:fleets.reduce((n,f)=>n+Math.min(100000,arrivalV415(state,actor,f,destination)),0),
    held:Math.max(0,...war?.goals[actor]?.filter(g=>operation.targets.includes(g.systemId)).map(g=>g.heldDays)??[]),launched:!!war};
  const old=operation.milestones;
  const sameDestination=old?.destination===destination;
  const progressed=!old||next.reconDay>=0&&old.reconDay<0||next.prepared&&!old.prepared||next.launched&&!old.launched||next.held>old.held||next.arrived.some(id=>!old.arrived.includes(id))||sameDestination&&next.distance+10<old.distance;
  if(progressed)operation.lastProgressRound=state.round;
  // Keep the best distance/held milestone: oscillation never resets the clock.
  operation.milestones={...next,distance:old&&sameDestination?Math.min(old.distance,next.distance):next.distance,held:next.held};
  operation.progress=JSON.stringify(operation.milestones);
  if(next.held>=200){operation.stage='settle';operation.nextStep='比较强制议和与继续作战的实际保留收益';}
  else if(next.held>0){operation.stage='control';operation.nextStep='保持声明目标控制至200日';}
  else if(war){operation.stage='attack';operation.nextStep='集中指定舰队进攻当前战争声明目标';}
  if(state.round-operation.lastProgressRound>=CONFIG.stalledRounds) {
    operation.lastAssessmentRound=state.round;operation.reassess=true;
    operation.nextStep='两轮无实际进展：比较继续、补强、调整和退出，保留仍有效的分配';
  }
  if(!war&&operation.launchBy!==undefined&&state.day>=operation.launchBy){operation.reassess=true;operation.nextStep='已到最迟发起日：本轮重新比较发起、明确补强期限或退出，不能追加首攻名单拖延';}
}


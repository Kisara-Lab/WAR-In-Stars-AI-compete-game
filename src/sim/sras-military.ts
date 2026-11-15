import { SRAS, type SrasMemory, type SrasTask } from '../shared/sras.js';
import type { GameState } from '../shared/types.js';
import { controller } from '../shared/v4.js';
import { settlementPreview } from '../shared/settlement-preview.js';
import { warReasons } from '../shared/escalation.js';
import { fleetPower, distance, shortestPath } from './math.js';
import { threatTable, campaignDependency } from './sras-response.js';
import { arrival, digest, group, knownDefense, ledger, move, owned, ownPower, remaining, type RuleGroup } from './sras-rules.js';

export function refreshTasks(s:GameState,a:string,m:SrasMemory) {
  const alive=new Set(s.fleets.filter(f=>f.ownerId===a).map(f=>f.id));
  m.cooldowns??={};
  for(const t of m.tasks.filter(t=>t.expert==='campaign'&&t.stage==='exit'))m.cooldowns[t.target]=campaignDependency(s,a,t.target);
  m.tasks=m.tasks.filter(t=>t.stage!=='exit'&&t.deadline>s.day).map(t=>({...t,assets:t.assets.filter(id=>alive.has(id))}));
  for(const t of m.tasks) {
    if(t.expert!=='campaign'&&t.expert!=='defense')continue;
    if(t.expert==='defense'){if(!owned(s,a).some(h=>h.id===t.target)){t.stage='exit';t.assets=[];t.reserve={};t.exit='defense territory lost';}continue;}
    const war=s.wars?.find(w=>w.endedDay===undefined&&w.factions.includes(a)&&w.factions.includes(t.opponent??''));
    if(t.warId&&!war){t.stage='exit';t.exit='war ended';t.assets=[];continue;}
    if(war){t.warId=war.id;t.warType=war.type;const goal=war.goals[a]?.find(g=>!g.invalid&&g.systemId===t.target)??war.goals[a]?.find(g=>!g.invalid);if(goal)t.target=goal.systemId;}
    const target=s.systems.find(x=>x.id===t.target);
    if(!target){t.stage='exit';t.exit='target invalid';t.assets=[];continue;}
    // Only assigned assets and objective evidence refresh the progress clock.
    const intel=knownDefense(s,a,t.target);
    const objective=digest({war:war?.id,controlled:controller(target)===a,held:war?.goals[a]?.find(g=>g.systemId===t.target)?.heldDays,intel:intel?{known:true,power:intel.power}:null,ready:s.conquests?.some(c=>c.actor===a&&c.target===t.opponent&&c.readyDay<=s.day&&c.endedDay===undefined)});
    const destination=t.stage==='assemble'&&t.rally?t.rally:t.target;
    const distances=Object.fromEntries(t.assets.map(id=>{const f=s.fleets.find(x=>x.id===id)!;const from=f.systemId??f.transit?.to;const path=from?shortestPath(s.systems,from,destination):null;return [id,path?path.length*10000+(f.transit?.remainingDays??0)+(path.length?distance(f.position,s.systems.find(x=>x.id===from)!.gates[path[0]]):0):Number.MAX_SAFE_INTEGER];}));
    const evidence=digest({objective,distances});
    if(!t.progress||objective!==t.progress.objective||Object.entries(distances).some(([id,d])=>t.progress!.distance[id]!==undefined&&d<t.progress!.distance[id])){t.lastProgressRound=s.round;t.evidence=evidence;delete t.diagnosedRound;}
    else if(s.round-t.lastProgressRound>=SRAS.stalledRounds){if(t.diagnosedRound!==undefined&&s.round>t.diagnosedRound){t.stage='exit';t.exit='still blocked after stalled-task diagnosis';t.assets=[];}else{t.diagnosedRound=s.round;t.blockers=['two rounds without objective or assigned-fleet progress'];}}
    t.progress={objective,distance:distances};
    if(t.stage==='exit'){t.reserve={};m.cooldowns[t.target]=campaignDependency(s,a,t.target);}
  }
}
export function militaryRules(s:GameState,a:string,m:SrasMemory):RuleGroup[] {
  const result:RuleGroup[]=[],claimed=new Set<string>();
  const own=s.fleets.filter(f=>f.ownerId===a&&!f.withdrawal).sort((x,y)=>x.id.localeCompare(y.id));
  const idle=s.fleets.filter(f=>f.ownerId===a&&f.systemId&&!f.transit&&!f.order&&!f.withdrawal).sort((x,y)=>x.id.localeCompare(y.id));
  const hostile=new Set(Object.values(s.relations).filter(r=>r.factions.includes(a)&&r.status==='war').flatMap(r=>r.factions.filter(x=>x!==a)));
  const threats=threatTable(s,a);
  for(const t of m.tasks.filter(t=>t.expert==='defense'&&t.stage!=='exit'))if(!threats.some(x=>x.system===t.target)){t.stage='exit';t.assets=[];t.reserve={};t.exit='territory lost or threat reassigned';}
  // Allocate local garrisons first. Other experts cannot claim these fleet IDs.
  for(const row of threats) {
    const home=s.systems.find(h=>h.id===row.system)!;
    const threat=row.power;
    if(!threat)continue;
    let power=home.base?.hull??0;
    const previous=m.tasks.find(t=>t.expert==='defense'&&t.target===home.id&&t.stage!=='exit');
    const defenders=own.filter(f=>!claimed.has(f.id)&&((f.systemId===home.id&&!f.transit&&(!f.order||f.order.systemId===home.id))||(previous?.assets.includes(f.id)&&(f.order?.systemId===home.id||f.transit?.to===home.id))));
    const retained:typeof defenders=[];
    for(const f of defenders){if(power>=threat)break;claimed.add(f.id);retained.push(f);power+=ownPower(s,a,f);}
    let task=m.tasks.find(t=>t.expert==='defense'&&t.target===home.id&&t.stage!=='exit');
    if(!task){task={id:'defense:'+home.id,expert:'defense',target:home.id,assets:[],reserve:{},stage:'assemble',deadline:s.day+300,evidence:'',lastProgressRound:s.round,next:'retain garrison and reinforce threatened colony',blockers:[],exit:'threat gone'};m.tasks.push(task);}
    task.assets=retained.map(f=>f.id);
    task.deadline=s.day+300;
    for(const f of idle.filter(f=>!claimed.has(f.id)).sort((x,y)=>arrival(s,a,x,home.id)-arrival(s,a,y,home.id)||x.id.localeCompare(y.id))) {
      if(power>=threat)break;
      if(arrival(s,a,f,home.id)>Math.max(100,row.arrival))continue;
      claimed.add(f.id);task.assets.push(f.id);power+=ownPower(s,a,f);
      result.push(group('defense',0,100,[move(f.id,home.id)],'reinforce known nearby invasion; retain local garrisons'));
    }
    task.next=power>=threat?'retain sufficient defense; release surplus to other tasks':'reinforce defense deficit '+Math.ceil(threat-power);
    task.blockers=power>=threat?[]:['known defense deficit '+Math.ceil(threat-power)];
  }
  // Defense may preempt offense, but no fleet can belong to both tasks.
  for(const t of m.tasks.filter(t=>t.expert==='campaign'))t.assets=t.assets.filter(id=>!claimed.has(id)&&own.some(f=>f.id===id));
  for(const relation of Object.values(s.relations).filter(r=>r.factions.includes(a)).sort((x,y)=>x.factions.join().localeCompare(y.factions.join()))) {
    const opponent=relation.factions.find(id=>id!==a)!;
    if(relation.status==='contact'&&!relation.confirmed.includes(a))result.push(group('diplomacy',1,80,[{type:'confirm_contact',args:{factionId:opponent}}],'confirm actual contact'));
    const war=s.wars?.find(w=>w.endedDay===undefined&&w.factions.includes(a)&&w.factions.includes(opponent));
    if(war){const view=settlementPreview(s,a,war);if(!view)continue;if(view.enforced.goals.some(g=>g.eligible))result.push(group('diplomacy',1,100,[{type:'enforce_peace',args:{factionId:opponent}}],'cash out eligible declared objectives'));
      if(ledger(s,a).risk>0&&view.unconditional.returnOccupations.filter(x=>x.from===a).length===0&&!relation.offers[a])result.push(group('diplomacy',1,50,[{type:relation.offers[opponent]&&relation.offers[opponent].createdRound<s.round?'accept_peace':'propose_peace',args:{factionId:opponent}}],'supply crisis; no occupied gains returned'));
    }
  }
  let task=m.tasks.find(t=>t.expert==='campaign'&&t.stage!=='exit');
  const wars=s.wars?.filter(w=>w.factions.includes(a)&&w.endedDay===undefined).sort((x,y)=>x.id.localeCompare(y.id))??[];
  const war=task?wars.find(w=>w.factions.includes(task!.opponent??'')):wars[0];
  if(!task) {
    const targets=s.systems.filter(x=>x.ownerId&&x.ownerId!==a&&x.neighbors.some(id=>owned(s,a).some(h=>h.id===id))&&Object.values(s.relations).some(r=>r.factions.includes(a)&&r.factions.includes(x.ownerId!)&&['peace','war'].includes(r.status))).sort((x,y)=>(knownDefense(s,a,x.id)?.power??Infinity)-(knownDefense(s,a,y.id)?.power??Infinity)||x.id.localeCompare(y.id));
    const eligible=targets.filter(x=>m.cooldowns?.[x.id]!==campaignDependency(s,a,x.id));
    const target=(war?s.systems.find(x=>war.goals[a]?.some(g=>!g.invalid&&g.systemId===x.id)&&m.cooldowns?.[x.id]!==campaignDependency(s,a,x.id)):undefined)??(!war?eligible[0]:undefined);
    if(target&&remaining(s)>SRAS.settlementDays+300&&!m.tasks.some(t=>t.expert==='campaign'&&t.stage==='exit'&&t.target===target.id)) {
      task={id:'campaign:'+target.id,expert:'campaign',target:target.id,opponent:war?.factions.find(x=>x!==a)??target.ownerId!,warId:war?.id,warType:war?.type,assets:[],reserve:{},stage:'investigate',deadline:s.day+remaining(s)-SRAS.settlementDays,evidence:'',lastProgressRound:s.round,next:'obtain fresh known defenders',blockers:[],exit:'invalid objective, supply deficit, deadline or unresolved stall'};m.tasks.push(task);
    }
  }
  if(!task)return result;
  // Reservations describe the next actionable commitment, never a stale claim
  // from a previous round whose intelligence or force checks no longer pass.
  task.reserve={};
  // Orders already issued to this objective remain binding while travelling.
  // Do not recall an invasion to its rally on the next economic prefix/round.
  const attacking=own.filter(f=>task!.assets.includes(f.id)&&(f.order?.systemId===task!.target||f.transit?.to===task!.target));
  if(war&&attacking.length){task.stage='launch';task.next='complete coordinated arrival at '+task.target;task.blockers=['assigned invasion in transit'];return result;}
  const target=s.systems.find(x=>x.id===task.target)!,known=knownDefense(s,a,target.id);
  if(controller(target)===a){task.stage='control';task.next='hold declared objective until settlement eligible';return result;}
  if(!known){task.stage='recon';task.blockers=['missing or older than 200-day defender intelligence; do not enter unknown contact'];task.next='staff LRS coverage or await safe intelligence';return result;}
  if(ledger(s,a).risk>0){task.blockers=['300-day supply deficit'];task.next='repair supply before committing main force';return result;}
  const rally=owned(s,a).filter(h=>target.neighbors.includes(h.id)).sort((x,y)=>x.id.localeCompare(y.id))[0];
  if(!rally){task.blockers=['no legal owned border staging point'];return result;}
  const fleets=own.filter(f=>!claimed.has(f.id)&&(task!.assets.includes(f.id)||idle.some(x=>x.id===f.id)));
  task.assets=fleets.map(f=>f.id);
  const power=fleets.reduce((n,f)=>n+ownPower(s,a,f),0);
  if(power<=0||power<known.power*SRAS.attackRatio){task.stage=fleets.some(f=>f.transit||f.order)?'assemble':'prepare';task.blockers=['insufficient known force after defense allocation'];task.next='complete assigned arrivals and paid fleet orders before new investment';return result;}
  if(!war) {
    const preparation=s.conquests?.find(c=>c.actor===a&&c.target===task!.opponent&&c.endedDay===undefined);
    const claim=s.claims?.find(c=>c.factionId===a&&c.systemId===target.id&&c.expiresDay>s.day);
    const total=warReasons(s,a).some(r=>r.target===task!.opponent&&r.usable&&r.availableDay<=s.day);
    if(!total&&remaining(s)>SRAS.reserveDays+SRAS.settlementDays) {
      if(preparation&&preparation.readyDay>s.day){task.stage='prepare';task.next='wait for paid conquest preparation on day '+preparation.readyDay;task.blockers=['preparation not yet mature'];}
      else if(!preparation&&!claim&&target.id!==s.factions[task.opponent!].homeSystemId){task.stage='prepare';task.reserve={minerals:100};result.push(group('campaign',2,95,[{type:'create_claim',args:{systemId:target.id}}],'known superior force; obtain cession rights before launching'));return result;}
      else if(!preparation&&!claim&&target.id===s.factions[task.opponent!].homeSystemId){task.stage='prepare';task.reserve={minerals:300,food:100};result.push(group('campaign',2,95,[{type:'prepare_conquest',args:{factionId:task.opponent,reason:'SRAS known superior merged-force opportunity'}}],'prepare legal conquest after force and supply checks'));return result;}
      if(preparation&&preparation.readyDay>s.day||claim&&claim.createdRound>=s.round){task.reserve={};return result;}
    }
  }
  task.reserve={};
  const gathered=fleets.filter(f=>f.systemId===rally.id&&!f.transit&&!f.order);
  task.assets=fleets.map(f=>f.id);task.stage='assemble';task.rally=rally.id;task.next='assemble and merge at '+rally.id;task.blockers=[];
  for(const f of fleets.filter(f=>f.systemId!==rally.id&&!f.transit&&!f.order))if(Number.isFinite(arrival(s,a,f,rally.id)))result.push(group('campaign',2,80,[move(f.id,rally.id)],'assemble on owned border before war'));
  if(gathered.length!==fleets.length){task.blockers=['wait for all assigned fleets to reach rally before merging or launching'];return result;}
  if(gathered.length>1){const first=gathered[0],near=gathered.filter(f=>distance(first.position,f.position)<=20);if(near.length>1)result.push(group('campaign',2,85,[{type:'merge_fleets',args:{fleetIds:near.map(f=>f.id)}}],'merge before launch; use actual surviving fleet ID next round'));else for(const f of gathered.slice(1))result.push(group('campaign',2,80,[{type:'move_fleet',args:{fleetId:f.id,systemId:rally.id,x:first.position.x,y:first.position.y,targetFleetId:null}}],'rendezvous before merging'));return result;}
  const main=gathered[0];if(!main||!s.fleets.some(f=>f.id===main.id)||ownPower(s,a,main)<known.power*SRAS.attackRatio)return result;
  // The same merged fleet arrives together. Hypothetical war grants only the passage
  // the real declaration would grant; the complete group still uses the real validator.
  const prospective=structuredClone(s);for(const r of Object.values(prospective.relations))if(r.factions.includes(a)&&r.factions.includes(task.opponent!))r.status='war';
  const travel=arrival(prospective,a,main,target.id);
  const reinforcements=s.fleets.filter(f=>f.ownerId===task!.opponent&&f.systemId&&f.systemId!==target.id&&arrival(prospective,f.ownerId,f,target.id)<=travel).reduce((n,f)=>n+fleetPower(f),0);
  if(!Number.isFinite(travel)||travel+SRAS.settlementDays>=remaining(s)||ownPower(s,a,main)<(known.power+reinforcements)*SRAS.attackRatio){task.blockers=['legal arrival, time or timely reinforcement threshold not met'];return result;}
  task.next='launch merged fleet';
  if(war&&war.factions.includes(task.opponent!)){task.stage='launch';result.push(group('campaign',2,100,[move(main.id,target.id)],'fresh defenders, timely reinforcements and 1.5 ratio passed'));}
  else {
    const reason=warReasons(s,a).find(r=>r.target===task!.opponent&&r.usable&&r.availableDay<=s.day);
    const claim=s.claims?.find(c=>c.factionId===a&&c.systemId===target.id&&c.createdRound<s.round&&c.expiresDay>s.day);
    const type=reason?'total':claim?'claim':'limited';
    result.push(group('opportunity',2,90,[{type:'declare_war',args:{factionId:task.opponent,warType:type,systemIds:type==='total'?[]:[target.id],grievanceId:reason?.id??null,reason:'SRAS fresh known-force and common-arrival rules'}},move(main.id,target.id)],'declare and launch as one validated group'));
  }
  return result;
}

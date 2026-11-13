import { ADAPTIVE } from '../shared/adaptive.js';
import { policyComparison } from '../shared/comparison.js';
import { policyWindow } from '../shared/civil.js';
import { route, civilizationEligibility } from '../shared/civilization.js';
import { constructionView } from '../shared/construction.js';
import { industryPlanet, support, shipMaterials } from '../shared/industry.js';
import { RULES, SHIPS, STRUCTURES, BASE, type ShipType } from '../shared/rules.js';
import { controller, occupied } from '../shared/v4.js';
import type { Action, GameState, Fleet } from '../shared/types.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { decisionComparison } from './options.js';
import { resourcePurposes, constructionOptions, constructionContext } from './industry.js';
import { accessiblePath } from './diplomacy.js';
import { distance, fleetPower } from './math.js';
import { createHash } from 'node:crypto';
import { observation } from './intel.js';
import { responsibilityView } from '../shared/responsibility.js';
import { ESCALATION } from '../shared/escalation.js';
import { V53, governanceView } from '../shared/governance.js';
import { adaptiveResourceWeights } from './adaptive-economics.js';
import { ADAPTIVE_V2 } from '../shared/adaptive.js';
import { functionalValue, routeComparison } from './adaptive-v2-values.js';
import { failureConditions } from './adaptive-v2-failures.js';

export const actionKey=(action:Action)=>action.type+':'+String(action.args.systemId??action.args.planetId??action.args.fleetId??action.args.factionId??action.args.projectId??action.args.proposalId??'national');

export function candidateFacts(world:GameState,actor:string,v2=false) {
  const own=world.factions[actor], facts=observation(world,actor,null,false);
  const comparison=decisionComparison(world,actor,false), purpose=resourcePurposes(world,actor);
  const routes=v2?routeComparison(world,actor,comparison):[];
  const functions=v2?functionalValue(world,actor):null;
  const buildingContext=v2?constructionContext(world,actor):undefined;
  const remaining=(world.config.maxRounds-world.round)*RULES.daysPerRound;
  const horizon=Math.min(ADAPTIVE.horizons[1],remaining), safety=Math.min(remaining,ADAPTIVE.safetyDays);
  const policy=own.policy?.choice??'none', economy=policyComparison(world,actor,[policy])[0];
  const candidates:ScriptCandidate[]=[];
  let generated=0;
  const wealth=purpose.resources;
  const weights=adaptiveResourceWeights(world,actor,purpose);
  const netValue=(net:Record<string,number>)=>Object.entries(net).reduce((sum,[resource,amount])=>sum+amount*weights[resource],0);
  const danger=wealth.some(item=>item.resource!=='alloys'&&item.stock+item.netPer100*safety/100<0);
  const add=(action:Action|Action[],value:number,kind:string,options:Partial<ScriptCandidate>={})=>{
    generated++;
    if(!v2&&candidates.length>=ADAPTIVE.candidates)return;
    const actions=Array.isArray(action)?action:[action], first=actions[0];
    const target=String(first.args.systemId??first.args.planetId??first.args.factionId??first.args.fleetId??first.args.projectId??'national');
    const id=actionKey(first)+':'+JSON.stringify(v2?actions:first.args);
    const relevant={args:actions.map(action=>action.args),intel:own.intel[target]?.day,military:own.militaryIntel?.[target]?.day,failed:own.failedOrders?.[target],resources:own.resources,projects:world.systems.flatMap(system=>system.projects).filter(project=>project.planetId===target||project.id===target).map(project=>[project.id,project.progress]),fleet:world.fleets.filter(fleet=>fleet.ownerId===actor&&fleet.id===target),relations:Object.values(world.relations).filter(relation=>relation.factions.includes(target)),policy:own.policy,welfare:own.welfare?.choice};
    const details=['base','scout','war','defend','withdraw'].includes(kind)?JSON.stringify({args:relevant.args,intel:relevant.intel,military:relevant.military,fleets:world.fleets.filter(fleet=>actions.some(action=>action.args.fleetId===fleet.id)),projects:relevant.projects,relations:v2?Object.values(world.relations):relevant.relations}):JSON.stringify(relevant);
    const fingerprint=v2?failureConditions(world,actor,actions):createHash('sha256').update(details).digest('hex');
    candidates.push({id,label:kind+' '+target,kind,target,actions,priority:0,value,risk:0,reason:'比较可见收益、真实费用与剩余赛程',evidenceDays:[world.day],progress:fingerprint,deadline:world.day+remaining,economic:true,exclusive:[],fingerprint,tasks:[],...options});
  };
  const move=(fleet:Fleet,target:string):Action=>({type:'move_fleet',args:{fleetId:fleet.id,systemId:target,x:null,y:null,targetFleetId:null}});
  const idle=world.fleets.filter(fleet=>fleet.ownerId===actor&&fleet.systemId&&!fleet.order&&!fleet.transit&&!fleet.withdrawal).sort((first,second)=>first.id.localeCompare(second.id));
  const holding=new Set(idle.filter(fleet=>world.wars?.some(war=>war.endedDay===undefined&&war.goals[actor]?.some(goal=>goal.systemId===fleet.systemId&&!goal.invalid&&goal.heldDays<200)&&world.systems.some(system=>system.id===fleet.systemId&&controller(system)===actor))).map(fleet=>fleet.id));
  for(const fleet of idle.filter(fleet=>holding.has(fleet.id))) {
    add(move(fleet,fleet.systemId!),ADAPTIVE.dutyValue,'hold',{priority:2,economic:false,exclusive:['fleet:'+fleet.id],label:'守住目标等待200日兑现 '+fleet.systemId,tasks:[{fleetId:fleet.id,role:'hold',target:fleet.systemId!}]});
    candidates.at(-1)!.actions=[];
  }
  const ownSystems=world.systems.filter(system=>system.ownerId===actor&&!occupied(system));
  const power=(fleet:Fleet)=>facts.ownFleets.find(known=>known.id===fleet.id)?.effectivePower??0;
  const home=world.systems.find(system=>system.id===own.homeSystemId)!;
  const homeThreat=[...new Map(comparison.wars.flatMap(war=>war.military.fleets).map(fleet=>[fleet.id,fleet])).values()].filter(fleet=>fleet.systemId===home.id||home.neighbors.includes(fleet.systemId??'')).reduce((sum,fleet)=>sum+fleet.hullPower*ADAPTIVE.militaryUncertainty,0);
  const availableFleets=idle.filter(fleet=>!holding.has(fleet.id)&&(fleet.systemId!==own.homeSystemId||(home.base?.hull??0)+idle.filter(other=>other.id!==fleet.id&&other.systemId===home.id).reduce((sum,other)=>sum+power(other),0)>=homeThreat));
  const arrival=(fleet:Fleet,path:string[])=>path.reduce((days,id,index)=>{
    const from=world.systems.find(system=>system.id===(index?path[index-1]:fleet.systemId))!;
    const speed=Math.min(...fleet.ships.map(ship=>SHIPS[ship.type].speed));
    return days+RULES.jumpDays+Math.ceil((index?Math.SQRT2*1000:distance(fleet.position,from.gates[id]))/speed/10)*10;
  },0);
  for(const relation of Object.values(world.relations).sort((first,second)=>first.factions.join().localeCompare(second.factions.join()))) {
    const target=relation.factions.find(id=>id!==actor)!;
    if(relation.status==='contact'&&!relation.confirmed.includes(actor))add({type:'confirm_contact',args:{factionId:target}},ADAPTIVE.capacityValue,'contact',{priority:2,economic:false,label:'确认接触 '+target});
    const settlement=comparison.settlementPreview?.find(item=>item?.target===target);
    if(settlement?.enforced.goals.some(goal=>goal.eligible))add({type:'enforce_peace',args:{factionId:target}},ADAPTIVE.dutyValue,'settle',{priority:3,economic:false,exclusive:['war:'+target],label:'兑现达标战争目标 '+target,reason:JSON.stringify(settlement.enforced)});
    const retained=settlement?.unconditional.retainAnnexations.length??0;
    const abandoned=settlement?.unconditional.returnOccupations.filter(item=>item.from===actor).length??0;
    if(relation.status==='war'&&(danger||retained>0||settlement?.enforced.goals.length===0)) {
      const accept=relation.offers[target]&&relation.offers[target].createdRound<world.round;
      if(accept||!relation.offers[actor])add({type:accept?'accept_peace':'propose_peace',args:{factionId:target}},ADAPTIVE.dutyValue*(retained+Number(danger))-abandoned*ADAPTIVE.colonyValue,'peace',{priority:danger?2:1,exclusive:['war:'+target],label:(accept?'接受':'提出')+'无条件停战 '+target,reason:JSON.stringify(settlement?.unconditional)});
    }
  }
  for(const comparisonWar of comparison.wars) {
    const target=comparisonWar.target;
    if(v2&&comparisonWar.status==='peace') {
      const opportunity=comparisonWar.targetIntel?.some(info=>info.travel.some(travel=>travel.topologicallyReachable));
      const alreadyTotal=comparisonWar.options.some(option=>option.allowed&&option.warType==='total');
      if(opportunity&&comparisonWar.preparation.allowed&&!alreadyTotal&&remaining>1080)add({type:'prepare_conquest',args:{factionId:target,reason:'提前准备，同时侦察与集结；达到进攻门槛后单独宣战'}},ADAPTIVE_V2.conquestOptionValue,'prepare',{economic:true,exclusive:['conquest'],label:'征服准备阶段 '+target,reason:'不要求当前已有进攻军力；正式宣战重新校验'});
      for(const claim of comparisonWar.claims.filter(claim=>claim.allowed&&!claim.existingClaim))if(remaining>720)add({type:'create_claim',args:{systemId:claim.systemId}},ADAPTIVE.baseValue*.5,'claim',{exclusive:['claim:'+claim.systemId],label:'先建立宣称 '+claim.systemId});
    }
    for(const targetInfo of comparisonWar.targetIntel??[]) {
      const system=world.systems.find(system=>system.id===targetInfo.systemId)!;
      const known=facts.systems.find(known=>known.id===system.id)!;
      const date=targetInfo.militaryIntelDay??targetInfo.colonyIntelDay;
      const fresh=date!==null&&world.day-date<=ADAPTIVE.intelDays;
      const paths=availableFleets.map(fleet=>({fleet,path:accessiblePath(world,actor,fleet.systemId!,system.id)})).filter(item=>item.path!==null);
      if(!fresh||known.lastSeenDay===null) {
        const scout=paths.sort((first,second)=>arrival(first.fleet,first.path!)-arrival(second.fleet,second.path!)||first.fleet.id.localeCompare(second.fleet.id))[0];
        if(scout&&comparisonWar.status!=='war')add(move(scout.fleet,system.id),ADAPTIVE.explorationValue,'scout',{economic:false,exclusive:['fleet:'+scout.fleet.id],label:'刷新军情 '+system.id,evidenceDays:date===null?[]:[date],reason:'旧军情或未知守军；合法通行，不把未知按零',tasks:[{fleetId:scout.fleet.id,role:'assemble',target:system.id}]});
        continue;
      }
      const defenders=comparisonWar.military.fleets.filter(fleet=>fleet.systemId===system.id||system.neighbors.includes(fleet.systemId??''));
      if(defenders.some(fleet=>world.day-fleet.lastSeenDay>ADAPTIVE.intelDays))continue;
      const enemy=(defenders.reduce((sum,fleet)=>sum+fleet.hullPower,0)+(known.base?.hull??0))*ADAPTIVE.militaryUncertainty;
      const options=comparisonWar.options.filter(option=>option.allowed&&(option.systemIds.includes(system.id)||option.warType==='total'));
      const war=world.wars?.find(war=>war.endedDay===undefined&&war.factions.includes(actor)&&war.factions.includes(target));
      const probe=structuredClone(world);
      const probeRelation=Object.values(probe.relations).find(relation=>relation.factions.includes(actor)&&relation.factions.includes(target))!;
      probeRelation.status='war';
      const assault=availableFleets.map(fleet=>({fleet,path:accessiblePath(probe,actor,fleet.systemId!,system.id)})).filter(item=>item.path!==null).sort((first,second)=>arrival(first.fleet,first.path!)-arrival(second.fleet,second.path!)||first.fleet.id.localeCompare(second.fleet.id));
      const force:typeof assault=[];let forcePower=0;
      for(const item of assault){if(forcePower>=enemy*ADAPTIVE.attackRatio)break;force.push(item);forcePower+=power(item.fleet);}
      const travel=force.length?Math.max(...force.map(item=>arrival(item.fleet,item.path!))):Infinity;
      const feasible=force.length>0&&forcePower>=enemy*ADAPTIVE.attackRatio&&travel+200<remaining;
      if(!feasible)continue;
      if(war&&controller(system)===actor)continue;
      const reward=ADAPTIVE.colonyValue*(1+(known.planets?.filter(planet=>planet.population).length??0));
      const score=reward-enemy*ADAPTIVE.peaceLossWeight-travel*ADAPTIVE.routeCost;
      const warValue=(type:string)=>type==='total'?reward*Math.min(1,Math.max(0,remaining-travel-720)/1440)-(comparisonWar.totalWarExtraPer100.energy*weights.energy+comparisonWar.totalWarExtraPer100.minerals*weights.minerals)*7.2*ADAPTIVE.economicValue:type==='claim'?reward:type==='missionary'?50+(route(world,actor)==='theocracy'?ADAPTIVE.dutyValue:0):type==='humanitarian'?50+ADAPTIVE.dutyValue:50;
      const declaration=options.sort((first,second)=>v2?warValue(second.warType)-warValue(first.warType)||first.warType.localeCompare(second.warType):({claim:4,total:3,humanitarian:2,missionary:route(world,actor)==='theocracy'?5:1,limited:0,ideological:1}[second.warType]??0)-({claim:4,total:3,humanitarian:2,missionary:route(world,actor)==='theocracy'?5:1,limited:0,ideological:1}[first.warType]??0))[0];
      if(war||declaration) {
        const commands:Action[]=war?[]:[{type:'declare_war',args:{factionId:target,warType:declaration.warType,systemIds:declaration.systemIds,grievanceId:declaration.grievanceId??null,reason:'基于带日期的守军、增援及本土留守比较'}}];
        commands.push(...force.map(item=>move(item.fleet,system.id)));
        add(commands,v2?warValue(war?.type??declaration.warType)-enemy*ADAPTIVE.peaceLossWeight-travel*ADAPTIVE.routeCost:score,'war',{target:system.id,priority:war?2:0,exclusive:['war:'+target,...force.map(item=>'fleet:'+item.fleet.id)],label:'组织进攻 '+target+'/'+system.id,evidenceDays:[date!,...defenders.map(fleet=>fleet.lastSeenDay)],reason:`条件收益${reward}；已知敌方保守战力${enemy}，分配${forcePower}；航行上界${travel}日；战争不保证获胜`,tasks:force.map(item=>({fleetId:item.fleet.id,role:'attack',target:system.id}))});
      } else if(comparisonWar.status==='peace') {
        const claim=comparisonWar.claims.find(claim=>claim.systemId===system.id&&claim.allowed);
        if(claim)add({type:'create_claim',args:{systemId:system.id}},score*.5,'claim',{exclusive:['claim:'+system.id],label:'建立可兑现宣称 '+system.id,evidenceDays:[date!]});
        if(comparisonWar.preparation.allowed)add({type:'prepare_conquest',args:{factionId:target,reason:'比较所有已知对手后准备可达目标'}},score*.4,'prepare',{exclusive:['conquest'],label:'准备征服 '+target});
      }
    }
  }
  for(const system of ownSystems) {
    const enemies=world.fleets.filter(fleet=>fleet.ownerId!==actor&&fleet.systemId===system.id);
    if(enemies.length) for(const fleet of idle.filter(fleet=>fleet.systemId!==system.id)) {
      if(accessiblePath(world,actor,fleet.systemId!,system.id))add(move(fleet,system.id),ADAPTIVE.defenseValue,'defend',{priority:3,economic:false,exclusive:['fleet:'+fleet.id],label:'保卫领土 '+system.id,tasks:[{fleetId:fleet.id,role:'defend',target:system.id}]});
    }
  }
  for(const fleet of idle) {
    const local=world.systems.find(system=>system.id===fleet.systemId)!;
    const threats=world.fleets.filter(enemy=>enemy.ownerId!==actor&&enemy.systemId===local.id).reduce((sum,enemy)=>sum+fleetPower(enemy),0);
    if(threats>power(fleet)) {
      const destination=ownSystems.map(system=>({system,path:accessiblePath(world,actor,local.id,system.id)})).filter(item=>item.path?.length).sort((first,second)=>first.path!.length-second.path!.length||first.system.id.localeCompare(second.system.id))[0];
      if(destination)add(move(fleet,destination.system.id),ADAPTIVE.defenseValue,'withdraw',{priority:3,economic:false,exclusive:['fleet:'+fleet.id],label:'撤离优势敌军 '+local.id,tasks:[{fleetId:fleet.id,role:'withdraw',target:destination.system.id}]});
    }
  }
  const social=responsibilityView(world,actor)!;
  for(const aid of social.aid.filter(aid=>aid.target===actor&&aid.acceptedDay===undefined&&aid.endedDay===undefined&&aid.expiresDay>world.day))add({type:'accept_aid',args:{proposalId:aid.id}},ADAPTIVE.dutyValue,'aid',{priority:2,label:'接受福利援助'});
  for(const reform of social.reforms.filter(reform=>reform.target===actor&&reform.acceptedDay===undefined&&reform.endedDay===undefined&&reform.offerUntil>world.day))add({type:'accept_reform',args:{proposalId:reform.id}},ADAPTIVE.dutyValue,'reform',{priority:2,label:'接受改革与停战条款'});
  if(route(world,actor)==='utopia')for(const concern of social.concerns.filter(concern=>concern.target!==actor&&concern.closedDay===undefined)) {
    if(!social.aid.some(aid=>aid.target===concern.target&&aid.actor===actor&&aid.endedDay===undefined))add({type:'offer_aid',args:{factionId:concern.target,concernId:concern.id}},ADAPTIVE.dutyValue,'aid',{priority:2,exclusive:['response:'+concern.id],label:'援助困境居民 '+concern.target});
    if(!social.reforms.some(reform=>reform.target===concern.target&&reform.actor===actor&&reform.endedDay===undefined))add({type:'propose_reform',args:{factionId:concern.target,concernId:concern.id}},ADAPTIVE.dutyValue*.5,'reform',{priority:2,exclusive:['response:'+concern.id],label:'提出改革协议 '+concern.target});
  }
  const emergency=social.emergency!;
  if(emergency.available&&danger)add({type:'activate_extraction',args:{}},ADAPTIVE.defenseValue,'recovery',{priority:3,label:'启用一次救急并修复退出经济',reason:JSON.stringify(comparison.emergencyEconomy)});
  if(emergency.own?.phase==='extraction'&&!danger&&['energy','food','minerals'].every(resource=>economy.net[resource as 'food']>=0))add({type:'stop_extraction',args:{}},ADAPTIVE.dutyValue,'recovery',{priority:2,label:'停止征收，原期限渐退'});
  for(const event of emergency.events.filter(event=>event.stoppedDay===undefined)) {
    if(event.target===actor)for(const demand of event.demands.filter(demand=>demand.acceptedDay===undefined&&demand.rejectedDay===undefined))add({type:'accept_stop_extraction',args:{demandId:demand.id}},ADAPTIVE.dutyValue,'recovery',{priority:2,label:'接受停止要求，转入受监督恢复'});
    else if(route(world,actor)==='utopia'&&!event.demands.some(demand=>demand.actor===actor))add({type:'demand_stop_extraction',args:{factionId:event.target,eventId:event.id}},ADAPTIVE.dutyValue,'demand',{priority:2,economic:false,label:'要求停止征收 '+event.target});
  }
  if(own.faith?.dispute)for(const response of ['reconcile','reform'])add({type:'respond_dispute',args:{response,warId:null,systemId:null}},ADAPTIVE.dutyValue,'faith',{priority:2,exclusive:['dispute'],label:'处理当前信仰争端'});
  if(policyWindow(world,actor)!==null)for(const option of policyComparison(world,actor).filter(option=>option.allowed))add({type:'choose_policy',args:{policy:option.choice}},netValue(Object.fromEntries(Object.entries(option.net).map(([key,value])=>[key,value-economy.net[key as keyof typeof economy.net]])))+option.effectiveUnityChange-economy.effectiveUnityChange,'policy',{exclusive:['policy'],label:'两年政策 '+option.choice});
  if(['secular','militarist'].includes(route(world,actor))&&(own.welfare?.firstChoice||world.day>=own.welfare!.selectedDay+360))for(const welfare of ['survival','basic','comfortable','welfare','utopian'] as const) {
    if(welfare===own.welfare?.choice)continue;
    const draft=structuredClone(world);draft.factions[actor].welfare!.choice=welfare;
    const quote=policyComparison(draft,actor,[policy])[0];
    const gain=netValue(Object.fromEntries(Object.entries(quote.net).map(([key,value])=>[key,value-economy.net[key as keyof typeof economy.net]])))+(quote.effectiveUnityChange-economy.effectiveUnityChange)*ADAPTIVE.unityValue+governanceView(world,actor).rawSocial*(V53.treatment[welfare]-V53.treatment[own.welfare!.choice])*Math.min(1,remaining/720);
    add({type:'set_welfare',args:{welfare}},gain,'welfare',{priority:danger&&gain>0?2:0,exclusive:['welfare'],label:'民众待遇 '+welfare});
  }
  if(route(world,actor)==='secular'&&!v2) {
    if(civilizationEligibility(world,actor,'utopia').allowed)add({type:'establish_civilization',args:{civilization:'utopia',acknowledgePermanent:true}},Math.min(1500,remaining/720*100),'civilization',{exclusive:['civilization','welfare'],label:'承诺永久乌托邦',reason:'永久最高福利；征服准备禁用，其他合法战争不禁用；救援责任须有路径'});
    const actionable=comparison.wars.some(war=>war.status==='war'||war.preparation.allowed||war.options.some(option=>option.allowed));
    if(actionable&&idle.reduce((sum,fleet)=>sum+power(fleet),0)>0)add({type:'establish_civilization',args:{civilization:'militarist',acknowledgePermanent:true,welfare:['comfortable','basic','survival'].includes(own.welfare?.choice??'')?own.welfare!.choice:'comfortable'}},idle.reduce((sum,fleet)=>sum+power(fleet)*.1,0)-ADAPTIVE.dutyValue*.25,'civilization',{exclusive:['civilization','welfare'],label:'承诺永久军国',reason:'战力收益减维护、工业和成果责任风险；需要真实履责路径'});
    for(const candidate of comparison.religion.candidates.filter(candidate=>candidate.allowed))add([{type:'establish_religion',args:{planetId:candidate.planetId,name:own.name+'星海教会',doctrine:'维持居民保障与圣地协作，以实际外交成果承担责任',acknowledgePermanent:true}},{type:'consecrate',args:{planetId:candidate.planetId}}],ADAPTIVE.dutyValue+(actionable?ADAPTIVE.missionValue:0)-Math.max(0,remaining-1080)/100*6,'civilization',{exclusive:['civilization','welfare'],label:'建立国教并祝圣 '+candidate.planetId,reason:'主圣地状态分与协作；计入1080日后传教压力，不能假设自动胜利'});
  }
  if(v2&&route(world,actor)==='secular')for(const option of routes.filter(option=>option.allowed&&option.choice!=='secular')) {
    const candidate=comparison.religion.candidates.find(candidate=>candidate.allowed);
    const actions:Action[]=option.choice==='theocracy'?[{type:'establish_religion',args:{planetId:candidate!.planetId,name:own.name+'星海教会',doctrine:'居民保障与对外传教成果',acknowledgePermanent:true}},{type:'consecrate',args:{planetId:candidate!.planetId}}]:[{type:'establish_civilization',args:{civilization:option.choice,acknowledgePermanent:true,...(option.choice==='militarist'?{welfare:'comfortable'}:{})}}];
    add(actions,option.value,'civilization',{exclusive:['civilization','welfare'],label:'比较永久路线 '+option.choice,reason:JSON.stringify(option)});
  }
  if(own.faith)for(const site of own.faith.sites.filter(site=>site.consecratedDay===undefined))add({type:'consecrate',args:{planetId:site.planetId}},ADAPTIVE.dutyValue,'faith',{label:'祝圣固定圣地 '+site.planetId});
  for(const system of world.systems.sort((first,second)=>first.id.localeCompare(second.id))) {
    const adjacent=system.neighbors.some(id=>ownSystems.some(owned=>owned.id===id));
    if(!adjacent&&!ownSystems.some(owned=>owned.id===system.id))continue;
    if(!own.surveyed.includes(system.id)&&remaining>RULES.surveyDays)add({type:'survey_system',args:{systemId:system.id}},ADAPTIVE.explorationValue,'explore',{label:'探索 '+system.id});
    else if(!system.ownerId&&remaining>BASE.days) add({type:'build_starbase',args:{systemId:system.id}},ADAPTIVE.baseValue,'base',{label:'建立基地 '+system.id,evidenceDays:[own.intel[system.id]?.day??world.day]});
    if(system.ownerId===actor&&!occupied(system))for(const planet of system.planets.filter(planet=>!planet.ownerId))if(remaining>RULES.colonizeDays)add({type:'colonize_planet',args:{planetId:planet.id}},ADAPTIVE.colonyValue,'colonize',{label:'殖民 '+planet.id});
  }
  for(const system of ownSystems)for(const planet of system.planets.filter(planet=>planet.ownerId===actor)) {
    const industry=industryPlanet(planet,world.day), queue=constructionView(world,system,planet);
    const options=constructionOptions(world,actor,planet.id,buildingContext);
    for(const option of options.filter(option=>option.type!=='wait'&&option.allowed)) {
      const type=option.type as keyof typeof STRUCTURES;
      let value=netValue(option.net)*Math.max(0,horizon-STRUCTURES[type].days)/100*ADAPTIVE.economicValue-(option.mineralCost+2*option.alloyCost)*ADAPTIVE.materialValue;
      value+=option.unity*(own.unity<10000?ADAPTIVE.unityValue:ADAPTIVE.surplusWeight);
      if(!v2&&type==='housing'&&planet.population>=industry.populationCap-1&&remaining>720)value+=ADAPTIVE.growthValue;
      if(!v2&&type==='shipyard'&&option.operation>0&&!planet.structures.some(building=>building.type==='shipyard')&&!system.projects.some(project=>project.planetId===planet.id&&project.structureType==='shipyard')&&purpose.afterQueuedDestroyerMaterialCapacityPer100>0&&remaining>720)value+=ADAPTIVE.capacityValue;
      if(!v2&&type==='drydock'&&queue.queues.find(queue=>queue.slot==='ship')!.projects.length>1&&option.operation===1)value+=ADAPTIVE.capacityValue;
      if(!v2&&type==='lrs'&&option.operation===1&&system.neighbors.some(id=>world.systems.find(system=>system.id===id)?.ownerId!==actor))value+=ADAPTIVE.explorationValue;
      if(v2&&['lrs','drydock','hospital','housing','habitat','shipyard'].includes(type)) {
        const draft=structuredClone(world);
        for(const sector of draft.systems)for(const project of sector.projects.filter(project=>project.ownerId===actor&&project.kind==='building'&&project.structureType)) {
          const host=sector.planets.find(planet=>planet.id===project.planetId);if(host)host.structures.push({id:project.id,type:project.structureType!});
        }
        const before=functionalValue(draft,actor).value;
        draft.systems.find(sector=>sector.id===system.id)!.planets.find(host=>host.id===planet.id)!.structures.push({id:'functional-preview',type});
        value+=functionalValue(draft,actor).value-before;
        if(type==='lrs'&&option.operation!==1) {
          const host=draft.systems.find(sector=>sector.id===system.id)!.planets.find(host=>host.id===planet.id)!;
          host.priorities={...host.priorities,lrs:5,mine:0};delete host.operation;
          const supported=industryPlanet(host,world.day).buildings.find(building=>building.id==='functional-preview')?.operation===1;
          if(supported)add([{type:'build_structure',args:{planetId:planet.id,structureType:type}},{type:'set_jobs',args:{planetId:planet.id,structureType:'lrs',priority:5}},{type:'set_jobs',args:{planetId:planet.id,structureType:'mine',priority:0}}],functionalValue(draft,actor).value-before,'build',{label:'LRS建设与岗位保障 '+planet.id,exclusive:['build:'+planet.id+':lrs','jobs:'+planet.id]});
          value=-1;
        }
      }
      add({type:'build_structure',args:{planetId:planet.id,structureType:type}},value,'build',{label:STRUCTURES[type].name+' '+planet.id,reason:JSON.stringify({operation:option.operation,displaced:option.displaced,supported:option.supportedFacilities,net:option.net,prepaidIncluded:true}),exclusive:['build:'+planet.id+':'+type]});
    }
    for(const building of planet.structures) {
      const operation=industry.buildings.find(item=>item.id===building.id)?.operation??0;
      if(operation===0||building.sealed)add({type:'set_structure_status',args:{planetId:planet.id,structureId:building.id,sealed:!building.sealed}},building.sealed?ADAPTIVE.capacityValue:ADAPTIVE.materialValue*(STRUCTURES[building.type].energy+STRUCTURES[building.type].upkeep),'status',{label:(building.sealed?'重启 ':'封存闲置 ')+building.id,exclusive:['structure:'+building.id]});
      if(building.sealed&&['foundry','shipyard',...(v2?['lrs','drydock']:[])].includes(building.type))add([{type:'set_structure_status',args:{planetId:planet.id,structureId:building.id,sealed:false}},{type:'set_jobs',args:{planetId:planet.id,structureType:building.type,priority:5}},...(weights.minerals===ADAPTIVE.surplusWeight?[{type:'set_jobs',args:{planetId:planet.id,structureType:'mine',priority:0}}]:[])],ADAPTIVE.capacityValue,'status',{label:'重启并重新分配岗位 '+building.id,exclusive:['structure:'+building.id,'jobs:'+planet.id]});
    }
    for(const type of [...new Set(planet.structures.map(building=>building.type))]) {
      if((planet.priorities?.[type]??-1)!==5)add({type:'set_jobs',args:{planetId:planet.id,structureType:type,priority:5}},ADAPTIVE.capacityValue,'jobs',{label:'比较岗位优先 '+type+'/'+planet.id,exclusive:['jobs:'+planet.id]});
      if(type==='mine'&&weights.minerals===ADAPTIVE.surplusWeight&&planet.priorities?.mine!==0)add({type:'set_jobs',args:{planetId:planet.id,structureType:'mine',priority:0}},ADAPTIVE.capacityValue,'jobs',{label:'释放过剩矿业岗位 '+planet.id,exclusive:['jobs:'+planet.id]});
    }
    if(industry.population>industry.employed)for(const slot of ['ground','orbital'] as const) {
      if(planet.structures.filter(building=>STRUCTURES[building.type].slot===slot).length>=(slot==='ground'?industry.groundSlots:industry.orbitalSlots))add({type:'expand_slots',args:{planetId:planet.id,slot}},remaining>720?ADAPTIVE.capacityValue:0,'expand',{label:'扩建 '+slot+'/'+planet.id});
    }
    for(const project of system.projects.filter(project=>project.planetId===planet.id)) {
      const finish=queue.queues.flatMap(queue=>queue.projects).find(item=>item.id===project.id)?.estimatedCompleteDay;
      if((!v2&&danger)||finish!==undefined&&((!v2&&finish===null)||finish!==null&&finish>world.day+remaining))add({type:'cancel_order',args:{projectId:project.id}},ADAPTIVE.capacityValue,'cancel',{priority:danger?2:0,label:'取消低效预付项目 '+project.id});
    }
    if(support(planet,'shipyard',world.day)>0)for(const shipType of Object.keys(SHIPS) as ShipType[]) {
      const cost=shipMaterials(shipType), queueCount=system.projects.filter(project=>project.planetId===planet.id&&project.kind==='ship').length;
      const count=Math.min(20,Math.max(0,(v2?Math.max(queue.shipLines,Math.floor(Math.min(remaining,ADAPTIVE_V2.queueDays)/SHIPS[shipType].days)*queue.shipLines):40)-queueCount),Math.floor(own.resources.minerals/cost.minerals),Math.floor((own.resources.alloys??0)/(cost.alloys??1)));
      if(count<1)continue;
      for(const quantity of [...new Set([1,Math.min(count,queue.shipLines),count])])add({type:'queue_ships',args:{planetId:planet.id,shipType,count:quantity}},SHIPS[shipType].power*ESCALATION.fleetScoreFactor*quantity*(remaining<720?ADAPTIVE.fleetScoreWeight:ADAPTIVE.futureFleetWeight),'ships',{label:`${quantity}艘${SHIPS[shipType].name} ${planet.id}`,exclusive:['ships:'+planet.id],reason:'按预付材料、实际施工线和终局日期检查；舰队评分有囤舰激励'});
    }
  }
  for(const system of ownSystems) {
    const fleets=idle.filter(fleet=>fleet.systemId===system.id);
    const first=fleets[0];
    if(!first)continue;
    const group=fleets.filter(fleet=>distance(first.position,fleet.position)<=20).slice(0,20);
    if(group.length>1)add({type:'merge_fleets',args:{fleetIds:group.map(fleet=>fleet.id)}},ADAPTIVE.capacityValue,'merge',{economic:false,exclusive:group.map(fleet=>'fleet:'+fleet.id),label:'合并同地舰队 '+system.id});
  }
  for(const fleet of availableFleets) {
    const targets=world.systems.filter(system=>system.id!==fleet.systemId&&!own.surveyed.includes(system.id)).map(system=>({system,path:accessiblePath(world,actor,fleet.systemId!,system.id)})).filter(item=>item.path!==null&&item.path.every(id=>{
      const system=world.systems.find(system=>system.id===id)!,host=controller(system);
      const relation=Object.values(world.relations).find(relation=>relation.factions.includes(actor)&&relation.factions.includes(host??''));
      return !host||host===actor||relation?.status==='peace'||!system.base&&!world.fleets.some(enemy=>enemy.ownerId!==actor&&enemy.systemId===id);
    })).sort((first,second)=>first.path!.length-second.path!.length||first.system.id.localeCompare(second.system.id));
    if(targets[0])add(move(fleet,targets[0].system.id),ADAPTIVE.explorationValue/(1+targets[0].path!.length),'scout',{economic:false,exclusive:['fleet:'+fleet.id],label:'巡察公共航道 '+targets[0].system.id,tasks:[{fleetId:fleet.id,role:'assemble',target:targets[0].system.id}]});
  }
  const ranked=[...new Map(candidates.map(candidate=>[candidate.id,candidate])).values()].sort((first,second)=>second.priority-first.priority||second.value-first.value||first.id.localeCompare(second.id,'en'));
  const selected:ScriptCandidate[]=[];
  if(v2) {
    for(const kind of [...new Set(ranked.map(candidate=>candidate.kind))].sort()) {
      const best=ranked.find(candidate=>candidate.kind===kind)!;selected.push(best);
    }
    for(const candidate of ranked)if(selected.length<ADAPTIVE.candidates&&!selected.includes(candidate))selected.push(candidate);
  }
  return {facts:{...facts,comparison,resourcePurposes:purpose,construction:ownSystems.flatMap(system=>system.planets.filter(planet=>planet.ownerId===actor).map(planet=>({planetId:planet.id,...constructionView(world,system,planet)})))},...(v2?{comparisons:{routes,sensors:functions,wars:comparison.wars}}:{}),candidates:(v2?selected:candidates).sort((first,second)=>first.id.localeCompare(second.id)),generated,truncated:generated>ADAPTIVE.candidates};
}

import { BASE, RULES, STRUCTURES } from '../shared/rules.js';
import { ADAPTIVE_V415, type DevelopmentV415 } from '../shared/adaptive-v415.js';
import { controller } from '../shared/v4.js';
import { INDUSTRY, outputBonus, industryPlanet, LABOR } from '../shared/industry.js';
import { welfareRules } from '../shared/civilization.js';
import { policyComparison } from '../shared/comparison.js';
import { V53 } from '../shared/governance.js';
import { canFight, relationKey } from '../shared/diplomacy.js';
import type { Action, GameState } from '../shared/types.js';
import type { economicForecast } from './forecast.js';
import type { ScriptCandidate } from './adaptive-types.js';

type Forecast = ReturnType<typeof economicForecast>;
const resources = ['energy', 'food', 'minerals', 'alloys'] as const;
const empty = () => ({ energy:0, food:0, minerals:0, alloys:0 });
const boundary = (day:number) => Math.ceil(day / RULES.daysPerRound) * RULES.daysPerRound;

/** Quotes only known, legally reachable development. No unseen planet counts,
 * hypothetical annexation or new-order income is fed back into affordability. */
export function developmentV415(state:GameState, actor:string, projection:Forecast, previous?:DevelopmentV415) {
  const own = state.factions[actor], end = state.day + (state.config.maxRounds-state.round)*100;
  const last = projection.horizons.at(-1);
  const limit = state.day + (last?.days ?? 0);
  const quote = policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  const welfare = welfareRules(state)[own.welfare?.choice??'comfortable'];
  const quality = Math.min(V53.treatment[own.welfare?.choice??'comfortable'],last?.governance?.quality??1);
  const productivity = Math.max(.125,(.5+own.unity/10000)*.5**Object.values(own.shortages).filter(Boolean).length);
  const balances = (day:number) => {
    const elapsed = Math.max(0,day-state.day);
    const points = [{days:0,resources:Object.fromEntries(resources.map(r=>[r,(own.resources[r]??0)/1000]))},...projection.horizons];
    const upper = points.find(p=>p.days>=elapsed)??points.at(-1)!;
    const lower = [...points].reverse().find(p=>p.days<=elapsed)??points[0];
    const fraction = upper.days===lower.days?0:(elapsed-lower.days)/(upper.days-lower.days);
    return Object.fromEntries(resources.map(r=>[r,lower.resources[r]+(upper.resources[r]-lower.resources[r])*fraction]));
  };
  const options:DevelopmentV415[] = [];
  for (const system of state.systems.slice().sort((a,b)=>a.id.localeCompare(b.id))) {
    if (!own.surveyed.includes(system.id)) continue;
    if (system.ownerId && (system.ownerId!==actor || controller(system)!==actor)) continue;
    const base = system.projects.find(p=>p.ownerId===actor&&p.kind==='base');
    if (!system.ownerId && !base && !system.neighbors.some(id=>state.systems.some(s=>s.id===id&&s.ownerId===actor))) continue;
    const failed = own.failedOrders?.['build_starbase:'+system.id];
    if (!system.ownerId && failed && Math.max(own.intel[system.id]?.day??-1,own.militaryIntel?.[system.id]?.day??-1)<=failed.intelDay) continue;
    // Known hostile contact makes peaceful development unavailable until cleared.
    if (state.fleets.some(f=>f.ownerId!==actor&&f.systemId===system.id&&canFight(state.relations[relationKey(actor,f.ownerId)]))) continue;
    for (const planet of system.planets.slice().sort((a,b)=>a.id.localeCompare(b.id))) {
      if (planet.ownerId && planet.ownerId!==actor) continue;
      if (planet.ownerId===actor && (planet.structures.length || system.projects.some(p=>p.planetId===planet.id&&p.kind==='building'))) continue;
      const colony = system.projects.find(p=>p.ownerId===actor&&p.planetId===planet.id&&p.kind==='colonize');
      const committed = [base,colony].filter(p=>!!p);
      const completed = (p:NonNullable<typeof base>,fixed=false) => projection.completedProjects.find(c=>c.id===p.id)?.day
        ?? state.day + Math.ceil((p.requiredDays-p.progress/1000)/(fixed?1:productivity)/10)*10;
      const spent = empty();
      // Keep 100 days of any declining balance available for existing bills.
      const buffer = Object.fromEntries(resources.map(r=>[r,Math.max(0,-quote.net[r])])) as ReturnType<typeof empty>;
      const costs = empty();
      let cursor = state.day, next:DevelopmentV415['next']|undefined, action:Action|undefined;
      let readyDay = state.day, reserve = empty();
      const pay = (cost:Partial<typeof spent>, earliest:number, kind:DevelopmentV415['next'], command:Action) => {
        for (let day=boundary(earliest);day<=limit;day+=100) {
          const balance=balances(day);
          if (!resources.every(r=>balance[r]-spent[r]>= (cost[r]??0)+buffer[r])) continue;
          for (const r of resources) { spent[r]+=cost[r]??0;costs[r]+=cost[r]??0; }
          if (!next) {
            next=kind;action=command;readyDay=day;
            // Save the unfunded part before the *physical prerequisite* completes.
            // Using the affordability day here would reserve zero indefinitely.
            const untilPrerequisite=balances(Math.min(limit,boundary(earliest)));
            reserve=Object.fromEntries(resources.map(r=>[r,Math.max(0,(cost[r]??0)-Math.max(0,untilPrerequisite[r]-(own.resources[r]??0)/1000))])) as typeof reserve;
          }
          return day;
        }
        return Infinity;
      };
      const needsBase = !system.ownerId && !base;
      if (base) cursor=boundary(completed(base));
      else if (needsBase) cursor=boundary(pay({minerals:BASE.minerals},cursor,'base',{type:'build_starbase',args:{systemId:system.id}})+BASE.days/productivity);
      let colonyDay = state.day;
      if (colony) colonyDay=completed(colony,true);
      else if (!planet.ownerId) colonyDay=pay({minerals:RULES.colonizeMinerals,food:RULES.colonizeFood},cursor,'colonize',{type:'colonize_planet',args:{planetId:planet.id}})+RULES.colonizeDays;
      if (!Number.isFinite(colonyDay) || colonyDay>=end) continue;
      // Two initial workers can staff one real producer. Price its construction,
      // input and welfare before counting useful output; no free buildings.
      const type = quote.net.food < 2*(RULES.foodPerPopulation+welfare.food) ? 'farm'
        : quote.net.energy < STRUCTURES.mine.energy+2*welfare.energy ? 'solar' : 'mine';
      const rule = STRUCTURES[type];
      const productionStart = pay({minerals:rule.minerals},Math.max(cursor,colonyDay),'production',{type:'build_structure',args:{planetId:planet.id,structureType:type}});
      const productiveDay = productionStart+rule.days/productivity;
      if (!next || !action) continue;
      // A colony which cannot yet afford a factory remains valid. Its option
      // includes no productive benefit until the unpaid factory is fundable.
      const horizonValue = (days:number) => {
        const until=state.day+days;
        if (until<=colonyDay) return 0;
        const growth=1+(planet.trait==='habitable'?INDUSTRY.traitBonus:0);
        const population=Math.min(RULES.populationCap,2+Math.floor((until-colonyDay)*growth/RULES.populationGrowthDays));
        const social=(!planet.ownerId&&!colony)?(200+population*5)*quality:0;
        const productionDays=Math.max(0,until-productiveDay);
        const resource=type==='mine'?'minerals':type==='farm'?'food':'energy';
        const rate=rule.output[resource]*outputBonus(planet,resource,state.day)*productivity;
        // Only value output which can fund the next known colony or its supply.
        const demand=resource==='minerals'?RULES.colonizeMinerals+BASE.minerals:resource==='food'?RULES.colonizeFood:STRUCTURES.mine.energy*days/100;
        const usable=Math.min(demand,Math.max(0,rate-rule.upkeep-rule.energy-2*(welfare.energy+welfare.food+welfare.minerals+RULES.foodPerPopulation))*productionDays/100);
        const averagePopulation=(2+population)/2;
        const carrying=(until-colonyDay)/100*((!planet.ownerId&&!colony?averagePopulation*(welfare.energy+welfare.food+welfare.minerals+RULES.foodPerPopulation):0)+(needsBase?BASE.energy+BASE.upkeep:0));
        // Already paid base/colony assets are in the exact forecast. Unpaid costs
        // and additional welfare are charged here; projected stocks stay separate.
        return Math.max(0,(needsBase?100:0)+social+usable*ADAPTIVE_V415.investmentValue-(costs.minerals+carrying)/INDUSTRY.reserveFirstRate);
      };
      const divisor=projection.horizons.reduce((n,_,i)=>n+(ADAPTIVE_V415.valueWeights[i]??.4),0)||1;
      const optionValue=projection.horizons.reduce((n,h,i)=>n+horizonValue(h.days)*(ADAPTIVE_V415.valueWeights[i]??.4)/divisor,0)*ADAPTIVE_V415.developmentOptionWeight;
      const value=horizonValue(Math.min(1440,end-state.day));
      if (value<=0) continue;
      options.push({id:'development:'+planet.id,systemId:system.id,planetId:planet.id,next,action,readyDay,colonyDay,productiveDay:Number.isFinite(productiveDay)?productiveDay:end+1,reserve,cost:costs,projects:committed.map(p=>p.id),value,optionValue,
        reason:'已知殖民地→人口→已筹资生产；扣除未付款投资、供应和待遇；未来成果为条件收益'});
    }
  }
  options.sort((a,b)=>b.optionValue-a.optionValue||a.readyDay-b.readyDay||a.id.localeCompare(b.id));
  const old=options.find(o=>o.id===previous?.id);
  const selected=old&&old.value*ADAPTIVE_V415.switchRatio>=(options[0]?.value??0)?old:options[0];
  // Competing alternatives share the same wallet. Never sum their hypothetical
  // returns or spend the same future income on multiple development chains.
  return {selected,alternatives:options,optionValue:options[0]?.optionValue??0};
}

export function developmentCandidateV415(candidate:ScriptCandidate, plan:ReturnType<typeof developmentV415>) {
  const option=plan.alternatives.find(p=>candidate.actions.some(a=>a.type===p.action.type&&JSON.stringify(a.args)===JSON.stringify(p.action.args)));
  return option?{...candidate,priority:Math.max(2,candidate.priority),value:Math.max(candidate.value,option.value),reason:option.reason}:candidate;
}

export function protectsDevelopmentV415(before:ReturnType<typeof developmentV415>, after:ReturnType<typeof developmentV415>, candidate:ScriptCandidate, emergency=false, funds?:{before:Record<string,number>;after:Record<string,number>}) {
  if (emergency || !before.selected) return null;
  const prior=before.selected;
  if (candidate.actions.some(a=>a.type===prior.action.type&&JSON.stringify(a.args)===JSON.stringify(prior.action.args))) return null;
  if(['base','colonize'].includes(candidate.kind))return null; // Competing expansion still has its exact branch comparison.
  // Production is a competing use of the same capital. Its paid cost, actual
  // staffing, completion and supply must win the exact forecast, not an ETA veto.
  if(candidate.actions.every(a=>a.type==='set_jobs'||a.type==='set_structure_status'||a.type==='build_structure'&&['farm','solar','mine'].includes(String(a.args.structureType))))return null;
  const next=after.alternatives.find(p=>p.id===prior.id);
  const advances=!!next&&(next.readyDay<prior.readyDay||next.colonyDay<prior.colonyDay||next.productiveDay<prior.productiveDay-1);
  const consumesReserve=funds&&resources.some(r=>funds.after[r]<Math.min(funds.before[r],prior.reserve[r])-.001);
  if(consumesReserve&&!advances)return `殖民储资 ${prior.planetId}：保留下一未付款步骤所需资金 ${JSON.stringify(prior.reserve)}；该动作消耗已储本金且未提前殖民或投产`;
  if (next && next.readyDay<=prior.readyDay && next.colonyDay<=prior.colonyDay && next.productiveDay<=prior.productiveDay) return null;
  if (!['ships','welfare','civilization','prepare','claim','war','build','explore','expand'].includes(candidate.kind)) return null;
  return `殖民储资 ${prior.planetId}：${prior.next}原可在${prior.readyDay}日启动、${Math.ceil(prior.productiveDay)}日投产；该投入预计${next?.readyDay??'赛程外'}日启动、${next?Math.ceil(next.productiveDay):'赛程外'}日投产，需先完成或证明防御/战役收益高于开发方案`;
}

/** Compare supply investment and colonization together across planets. A new
 * colony cannot host a building order until complete, so use existing workplaces.
 * These are real, payable current orders; no future action is executed for free. */
export function developmentPackagesV415(state:GameState,actor:string,candidates:ScriptCandidate[],projection:Forecast):ScriptCandidate[] {
  const quote=policyComparison(state,actor,[state.factions[actor].policy?.choice??'none'])[0];
  const own=state.factions[actor],last=projection.horizons.at(-1);
  const needed=new Set<string>();
  if(quote.net.food<4*(RULES.foodPerPopulation+welfareRules(state)[own.welfare?.choice??'comfortable'].food)||(last?.resources.food??0)<(own.resources.food/1000))needed.add('farm');
  if(quote.net.energy<4||(last?.resources.energy??0)<own.resources.energy/1000)needed.add('solar');
  if(quote.net.minerals<RULES.colonizeMinerals/5)needed.add('mine');
  const producers=candidates.filter(c=>c.kind==='build'&&c.actions.length===1&&needed.has(String(c.actions[0].args.structureType))).filter(c=>{
    const p=state.systems.flatMap(s=>s.planets).find(p=>p.id===c.actions[0].args.planetId);
    if(!p||p.ownerId!==actor)return false;
    const labor=industryPlanet({...p,operation:undefined},state.day);
    const queued=state.systems.flatMap(s=>s.projects).filter(o=>o.planetId===p.id&&o.kind==='building'&&o.structureType).reduce((n,o)=>n+LABOR[o.structureType!].jobs,0);
    return labor.population-labor.employed-queued>=LABOR[c.actions[0].args.structureType as keyof typeof LABOR].jobs;
  }).sort((a,b)=>b.value-a.value||a.id.localeCompare(b.id,'en'));
  // Give each required resource a chance before spending forecasts on many copies.
  const supports=[...needed].flatMap(type=>producers.filter(c=>c.actions[0].args.structureType===type).slice(0,1));
  for(const c of supports){c.priority=Math.max(3,c.priority);c.reason+='；殖民配套产能，按实际岗位和完工时间比较';}
  const colonies=candidates.filter(c=>c.kind==='colonize').sort((a,b)=>b.value-a.value||a.id.localeCompare(b.id,'en'));
  const result:ScriptCandidate[]=[];
  for(const colony of colonies.slice(0,4))for(const supply of supports){
    if(colony.exclusive.some(k=>supply.exclusive.includes(k)))continue;
    result.push({...colony,id:'v415:development-package:'+supply.id+':'+colony.id,
      label:supply.label+'＋'+colony.label,kind:'colonize',priority:Math.max(3,colony.priority,supply.priority),
      actions:[...supply.actions,...colony.actions],exclusive:[...supply.exclusive,...colony.exclusive],
      value:colony.value+supply.value,reason:'已就业产能配套＋殖民：共同付款、共同预测；不把未下单计划记作收益'});
  }
  return result;
}


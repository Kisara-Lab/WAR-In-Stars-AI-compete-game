import { governed } from '../shared/governance.js';
import { constructionView } from '../shared/construction.js';
import { previewDraft } from './preview.js';
import { industrial, industryPlanet, BUILDING_EFFECTS, LABOR, INDUSTRY, TRAITS } from '../shared/industry.js';
import { STRUCTURES, units, factionIds, type StructureType } from '../shared/rules.js';
import { policyComparison } from '../shared/comparison.js';
import type { GameState } from '../shared/types.js';
import { applyAction } from './actions.js';
import { migrateBalance } from './balance.js';
import { v4Event, occupied } from '../shared/v4.js';
import { randomGenerator } from './math.js';
import { refreshIntel } from './intel.js';

function completedPipeline(state: GameState, actor: string) {
  const draft = previewDraft(state);
  for(const s of draft.systems) for(const p of s.planets.filter(p=>p.ownerId===actor)) {
    delete p.operation;
    for(const q of s.projects.filter(q=>q.planetId===p.id&&q.kind==='building'&&q.structureType)) p.structures.push({id:q.id,type:q.structureType!});
  }
  return draft;
}

export function industryComparison(state: GameState, actor: string, planetId?: string | null) {
  const pipeline=completedPipeline(state,actor);
  const policy=state.factions[actor].policy?.choice??'none';
  const baseline=policyComparison(state,actor,[policy])[0];
  return state.systems.filter(s=>s.ownerId===actor).flatMap(s=>s.planets.filter(p=>p.ownerId===actor&&(!planetId||p.id===planetId)).map(p=>{
    const future=pipeline.systems.find(q=>q.id===s.id)!.planets.find(q=>q.id===p.id)!;
    const queue=s.projects.filter(q=>q.planetId===p.id);
    const alternatives: unknown[]=[];
    const preview=(action: import('../shared/types.js').Action)=>{
      const draft=previewDraft(state);
      try { applyAction(draft,actor,action,'industry-preview'); const after=policyComparison(draft,actor,[policy])[0];alternatives.push({action,allowed:true,netChange:Object.fromEntries(Object.entries(after.net).map(([k,v])=>[k,v-baseline.net[k as keyof typeof baseline.net]]))}); }
      catch(error){alternatives.push({action,allowed:false,blocker:error instanceof Error?error.message:String(error)});}
    };
    for(const b of p.structures) preview({type:'set_structure_status',args:{planetId:p.id,structureId:b.id,sealed:!b.sealed}});
    for(const type of [...new Set(p.structures.map(b=>b.type))]) preview({type:'set_jobs',args:{planetId:p.id,structureType:type,priority:5}});
    return {...(governed(state)?{construction:constructionView(state,s,p)}:{}),systemId:s.id,...industryPlanet(p,state.day),occupied:occupied(s),queue:queue.map(q=>({...q,cost:Object.fromEntries(Object.entries(q.cost).map(([k,v])=>[k,v/1000])),progress:q.progress/1000})),reservedJobs:queue.filter(q=>q.structureType).reduce((n,q)=>n+LABOR[q.structureType!].jobs,0),afterQueuedBuildings:industryPlanet(future,state.day),prepaidShips:queue.filter(q=>q.kind==='ship').map(q=>({id:q.id,shipType:q.shipType,materials:Object.fromEntries(Object.entries(q.cost).map(([k,v])=>[k,v/1000]))})),options:constructionOptions(state,actor,p.id),administration:alternatives};
  }));
}

export function constructionOptions(state: GameState, actor: string, planetId: string) {
  const system = state.systems.find(s => s.planets.some(p => p.id === planetId));
  const planet = system?.planets.find(p => p.id === planetId);
  if (!industrial(state) || !planet || planet.ownerId !== actor || system?.ownerId !== actor) return [];
  const policy = state.factions[actor].policy?.choice ?? 'none';
  const pipeline = completedPipeline(state,actor);
  const before = policyComparison(pipeline, actor, [policy])[0];
  const beforeJobs = industryPlanet(pipeline.systems.find(s=>s.id===system.id)!.planets.find(p=>p.id===planetId)!, state.day);
  const result = [{ type: 'wait' as string, effect: '不增加设施与维护，保留劳动力和库存，允许等待已付款产能完成', allowed: true, reason: null as string | null, jobs: 0, displaced: [] as string[], net: { energy: 0, food: 0, minerals: 0, alloys: 0 }, unity: 0, mineralCost: 0, alloyCost: 0, paybackDays: null as number | null, alloyThroughputPer100: 0, supportedFacilities: [] as string[], operation: 0, estimate: '静态每100日；全国已有排队建筑先视为完成，不计队列期间收益。paybackDays仅为净矿物节省回收建材的估算，不是综合价值或排名；加工、民生、造舰须比较具体用途，null不表示无价值。未来人口/供应/战争可改变结果。' }];
  for (const type of Object.keys(STRUCTURES) as StructureType[]) {
    const validation = previewDraft(state);
    try {
      applyAction(validation, actor, { type: 'build_structure', args: { planetId, structureType: type } }, 'preview');
      // Both alternatives include the same queued assets across the whole nation.
      // Validate affordability on today's state, then compare steady operation without paying again.
      const draft = previewDraft(pipeline);
      const p = draft.systems.find(s => s.id === system.id)!.planets.find(p => p.id === planetId)!;
      p.structures.push({ id: 'preview-building', type }); delete p.operation;
      // Static operation preview must not mistake construction reservation for a permanent loss of working capital.
      draft.factions[actor].resources = { ...state.factions[actor].resources };
      const after = policyComparison(draft, actor, [policy])[0];
      const afterJobs = industryPlanet(p, state.day);
      const net = { energy: after.net.energy - before.net.energy, food: after.net.food - before.net.food, minerals: after.net.minerals - before.net.minerals, alloys: after.net.alloys - before.net.alloys };
      const supportType = ({refinery:'mine',agriculture:'farm',solar_hub:'solar',drydock:'shipyard'} as Partial<Record<StructureType,StructureType>>)[type];
      result.push({ ...result[0], type, effect: BUILDING_EFFECTS[type] ?? STRUCTURES[type].name, jobs: LABOR[type].jobs, displaced: beforeJobs.buildings.filter(b => (afterJobs.buildings.find(a => a.id === b.id)?.operation ?? 0) < b.operation).map(b => b.id), net, unity: after.cohesion.total - before.cohesion.total, mineralCost: STRUCTURES[type].minerals, alloyCost: LABOR[type].alloys, paybackDays: net.minerals > 0 && net.alloys >= 0 && type !== 'foundry' ? (STRUCTURES[type].minerals + 2 * LABOR[type].alloys) / net.minerals * 100 : null, alloyThroughputPer100:net.alloys, supportedFacilities:beforeJobs.buildings.filter(b=>b.type===supportType&&b.operation>0).map(b=>b.id), operation: afterJobs.buildings.find(b => b.id === 'preview-building')!.operation });
    } catch (error) { result.push({ ...result[0], type, allowed: false, reason: error instanceof Error ? error.message : String(error), mineralCost: STRUCTURES[type].minerals, alloyCost: LABOR[type].alloys }); }
  }
  return result;
}

export function resourcePurposes(state: GameState, actor: string) {
  const f=state.factions[actor], choice=f.policy?.choice??'none';
  const current=policyComparison(state,actor,[choice])[0], queued=policyComparison(completedPipeline(state,actor),actor,[choice])[0];
  const reserveValue=(f.resources.minerals+2*(f.resources.alloys??0))/1000;
  const resources=(['energy','food','minerals','alloys'] as const).map(resource=>{
    const stock=(f.resources[resource]??0)/1000, net=current.net[resource];
    return {resource,stock,netPer100:net,afterQueuedNetPer100:queued.net[resource],depletionDays:net<0?stock/-net*100:null,
      marginalUse:resource==='energy'||resource==='food' ? net>=0&&queued.net[resource]>=0?'当前及已排队设施未显示额外产能缺口；库存无直接评分，新增用途需明确人口/福利/舰船计划':'存在净消耗或在建需求，优先比较补给/封存/调岗' : resource==='minerals' ? reserveValue>=10000?'储备分已封顶；矿物仍用于福利、维护、冶炼和新订单，不应为库存分继续扩矿':'比较建设与冶炼需求，储备评分递减' : '合金用于新船、轨道和修复；已有造舰订单已付款，不能作为重复材料需求'};
  });
  return {resources,reserveValue,reserveScoreRemaining:400-Math.min(200,reserveValue/10)-Math.min(200,Math.max(0,reserveValue-2000)/40),
    processing:{...current.processing,afterQueued:queued.processing,remainingMineralsPer100:current.net.minerals,warning:'步初库存减维护和福利限制当步加工；正库存可以暂时掩盖持续净亏损'},
    newDestroyerMaterialCapacityPer100:Math.max(0,Math.min(current.net.minerals/20,current.net.alloys/20)),
    afterQueuedDestroyerMaterialCapacityPer100:Math.max(0,Math.min(queued.net.minerals/20,queued.net.alloys/20)),
    explanation:'驱逐舰材料能力仅按新增净矿物/20与合金/20较小值，不是造舰速度、战力保证或推荐；队列完工假设冻结人口，可能缺员。暂不建设也是有效选择。'};
}

export function migrateIndustry(original: GameState): GameState {
  if (original.result) throw new Error('已结束比赛不能创建继续运行的4.3分支');
  if (industrial(original)) return previewDraft(original);
  const state = migrateBalance(original);
  const previousRevision = original.rulesRevision ?? '4.0';
  state.rulesRevision = INDUSTRY.revision;
  for (const faction of Object.values(state.factions)) { faction.resources.alloys = 0; faction.lastIncome.alloys = 0; }
  const count = state.config.factionIds.length, sector = state.systems.length / count;
  for (let i = 0; i < state.systems.length; i++) {
    const system = state.systems[i];
    system.projects.sort((a,b) => a.createdDay - b.createdDay || a.id.localeCompare(b.id));
    for (let p = 0; p < system.planets.length; p++) system.planets[p].trait = Object.values(state.factions).some(f => f.homeSystemId === system.id) ? 'ordinary' : TRAITS[Math.floor(randomGenerator(state.config.seed + ':trait:' + (Number.isInteger(sector) ? i % sector : i) + ':' + p)() * TRAITS.length)];
  }
  for (const faction of Object.values(state.factions)) for (const id of faction.surveyed) { const memory = faction.intel[id]; const system = state.systems.find(s=>s.id===id); if (memory && system) for (const p of memory.system.planets) p.trait = system.planets.find(q=>q.id===p.id)?.trait; }
  refreshIntel(state);
  v4Event(state, 'beacon', '显式迁移至4.3：启用人口岗位、合金与串行施工；不补发合金或建筑，保留旧项目预付款。', factionIds(state), { previousRevision, revision: '4.3', fromDay: state.day, preview: factionIds(state).map(actor => ({ actor, planets: state.systems.filter(s => s.ownerId === actor).flatMap(s => s.planets.filter(p => p.ownerId === actor).map(p => industryPlanet(p,state.day))), economy: policyComparison(state,actor).find(p => p.choice === (state.factions[actor].policy?.choice ?? 'none')) })) });
  return state;
}

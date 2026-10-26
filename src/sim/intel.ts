import { governed, actionLimit, governanceView } from '../shared/governance.js';
import { responsible, responsibilityView } from '../shared/responsibility.js';
import { modern, route, CIVILIZATION, V5_POLICIES } from '../shared/civilization.js';
import { industrial, industryPlanet, BUILDING_EFFECTS, INDUSTRY, LABOR, EXPANSIONS, shipMaterials } from '../shared/industry.js';
import { BALANCE, balancedRules } from '../shared/balance.js';
import { decisionComparison } from './options.js';
import { conquestOptions, escalationView } from '../shared/escalation.js';
import { scoreBreakdown } from '../shared/scoring.js';
import { cohesionBreakdown, currentPolicy, POLICIES, policyWindow, sensorCoverage } from '../shared/civil.js';
import { BASE, factionIds, SHIPS, STRUCTURES, display } from '../shared/rules.js';
import type { FactionId } from '../shared/rules.js';
import type { Fleet, GameState, StarSystem } from '../shared/types.js';
import { fleetPower, shortageMultiplier } from './math.js';
import { controller, faithEffects, V4 } from '../shared/v4.js';

export function visibleSystems(state: GameState, factionId: FactionId): Set<string> {
  return new Set([...state.systems.filter(system => controller(system) === factionId).map(system => system.id), ...state.fleets.filter(fleet => fleet.ownerId === factionId && fleet.systemId).map(fleet => fleet.systemId!)]);
}

export function militarySystems(state: GameState, factionId: FactionId): Set<string> {
  return new Set([...visibleSystems(state, factionId), ...sensorCoverage(state, factionId)]);
}

function militaryFleet(fleet: Fleet): Fleet {
  return { id: fleet.id, name: fleet.name, ownerId: fleet.ownerId, systemId: fleet.systemId, position: structuredClone(fleet.position), transit: structuredClone(fleet.transit), order: null, ships: structuredClone(fleet.ships) };
}

export function refreshIntel(state: GameState): void {
  for (const factionId of factionIds(state)) {
    const faction = state.factions[factionId];
    const local = visibleSystems(state, factionId);
    const military = militarySystems(state, factionId);
    const coverage = sensorCoverage(state, factionId);
    faction.militaryIntel ??= {};
    faction.transitIntel ??= {};
    for (const record of Object.values(faction.transitIntel)) record.live = false;
    for (const fleet of state.fleets) {
      if (fleet.transit && (coverage.has(fleet.transit.from) && coverage.has(fleet.transit.to) || fleet.departedDay === state.day && military.has(fleet.transit.from))) faction.transitIntel[fleet.id] = { day: state.day, fleet: militaryFleet(fleet), live: coverage.has(fleet.transit.from) && coverage.has(fleet.transit.to) };
      else if (fleet.systemId && military.has(fleet.systemId)) delete faction.transitIntel[fleet.id];
    }
    for (const system of state.systems.filter(candidate => military.has(candidate.id))) faction.militaryIntel[system.id] = { day: state.day, source: local.has(system.id) ? 'local' : 'lrs', ownerId: system.ownerId, controllerId: controller(system), base: structuredClone(system.base), fleets: state.fleets.filter(fleet => fleet.systemId === system.id).map(militaryFleet) };
    for (const systemId of local) {
      const system = structuredClone(state.systems.find(candidate => candidate.id === systemId)!);
      system.projects = system.projects.filter(project => project.ownerId === factionId);
      faction.intel[systemId] = { day: state.day, system, fleets: structuredClone(state.fleets.filter(fleet => fleet.systemId === systemId)) };
    }
  }
}

function fleetView(fleet: Fleet, state: GameState, viewer: FactionId) {
  const composition = Object.fromEntries(Object.keys(SHIPS).map(type => [type, fleet.ships.filter(ship => ship.type === type).length]));
  return { id: fleet.id, name: fleet.name, ownerId: fleet.ownerId, systemId: fleet.systemId, position: fleet.position, transit: fleet.transit, withdrawal: fleet.ownerId === viewer ? fleet.withdrawal : undefined, composition, ships: fleet.ships, hullPower: Math.round(fleetPower(fleet) * 100) / 100, effectivePower: fleet.ownerId === viewer ? Math.round(fleetPower(fleet) * shortageMultiplier(state.factions[fleet.ownerId].shortages) * currentPolicy(state, fleet.ownerId).combat * faithEffects(state.factions[fleet.ownerId], state.day).combat * (modern(state) ? (route(state,viewer)==='militarist'?CIVILIZATION.militaryCombat:1)*(state.factions[viewer].policy?.choice==='exercises'?CIVILIZATION.exerciseCombat:1):1) * 100) / 100 : undefined, order: fleet.ownerId === viewer ? fleet.order : undefined };
}

export function observation(state: GameState, factionId: FactionId, focusSystemId: string | null = null, comparison = balancedRules(state), unified = true) {
  const faction = state.factions[factionId];
  const visible = visibleSystems(state, factionId);
  const military = militarySystems(state, factionId);
  const systems = state.systems.filter(system => !focusSystemId || system.id === focusSystemId).map(system => {
    const surveyed = faction.surveyed.includes(system.id);
    const intel = faction.intel[system.id];
    const militaryIntel = faction.militaryIntel?.[system.id];
    const militaryKnown = military.has(system.id) ? system : militaryIntel ?? intel?.system;
    const known: StarSystem | undefined = visible.has(system.id) ? system : intel?.system;
    const planetSource = surveyed ? known ?? system : undefined;
    return {
      id: system.id, name: system.name, position: system.position, neighbors: system.neighbors, gates: system.gates,
      surveyed, visible: military.has(system.id), intelligenceSource: visible.has(system.id) ? 'local' : military.has(system.id) ? 'lrs' : 'last_known', lastSeenDay: military.has(system.id) ? state.day : militaryIntel?.day ?? intel?.day ?? null,
      planetLastSeenDay: visible.has(system.id) ? state.day : intel?.day ?? null,
      ownerId: militaryKnown ? militaryKnown.ownerId : 'unknown',
      controllerId: militaryKnown ? controller(militaryKnown) : 'unknown',
      annexation: system.ownerId === factionId ? system.annexation : known?.annexation,
      base: militaryKnown?.base ? { hull: militaryKnown.base.hull, maximumHull: BASE.power } : null,
      planets: planetSource?.planets.map(planet => ({ id: planet.id, name: planet.name, position: planet.position, trait: industrial(state) ? planet.trait : undefined, industry: industrial(state) && planet.ownerId === factionId ? industryPlanet(planet, state.day) : undefined, holyCandidate: planet.holyCandidate ?? false, influence: planet.ownerId === factionId ? planet.influence : undefined, structures: known ? planet.structures : [], ownerId: known ? planet.ownerId : null, population: known ? planet.population : null })) ?? null,
      projects: system.projects.filter(project => project.ownerId === factionId).map(project => ({ ...project, progress: display(project.progress), cost: Object.fromEntries(Object.entries(project.cost).map(([resource, amount]) => [resource, display(amount)])) })),
      fleets: (military.has(system.id) ? state.fleets.filter(fleet => fleet.systemId === system.id) : militaryIntel?.fleets ?? intel?.fleets ?? []).map(fleet => fleetView(fleet, state, factionId)),
    };
  });
  return {
    ...(comparison ? { comparison: decisionComparison(state, factionId, unified) } : {}),
    decisionFacts: {
      units: { resources: '实际资源单位，无需再除1000', unity: '0到100；100是满值，不是低凝聚力', date: '游戏日', income: '每100游戏日' },
      unity: { value: faction.unity / 100, minimum: 0, maximum: 100, atMaximum: faction.unity === 10000, cohesionProductionMultiplier: 0.5 + faction.unity / 10000 },
      conquestOptions: conquestOptions(state, factionId),
      remainingRounds: state.config.maxRounds - state.round,
      evidenceRule: '当前事实优先于最近战略摘要；未知敌军不等于零，也不等于无限强。资格是否有效以当前canDeclareTotalNow及剩余自由和平日为准。',
    },
    escalation: escalationView(state, factionId),
    score: scoreBreakdown(state, factionId),
    ...(governed(state)?{governance:governanceView(state,factionId),actionLimit:actionLimit(state)}:{}),
    wars: (state.wars ?? []).filter(war => war.factions.includes(factionId)).map(war => ({ ...war, ...(war.openingTerritories?{openingTerritories:{[factionId]:war.openingTerritories[factionId]}}:{}), openingValue: { [factionId]: war.openingValue[factionId] }, lossUsed: { [factionId]: war.lossUsed[factionId] } })),
    claims: (state.claims ?? []).filter(claim => claim.factionId === factionId),
    grievances: (state.grievances ?? []).filter(grievance => grievance.actor === factionId && (grievance.active || grievance.expiresDay > state.day)),
    faith: faction.faith ?? null,
    faithEffects: faithEffects(faction, state.day),
    beacon: faction.beacon ?? null,
    missions: (state.missions ?? []).filter(mission => mission.hostId === factionId || mission.religionId === factionId),
    civilizationRules: V4,
    relations: Object.fromEntries(Object.entries(state.relations).filter(([, relation]) => relation.factions.includes(factionId))),
    knownFactions: Object.values(state.factions).filter(candidate => candidate.id === factionId || Object.values(state.relations).some(relation => relation.factions.includes(factionId) && relation.factions.includes(candidate.id) && relation.status !== 'unknown')).map(candidate => ({ id: candidate.id, name: candidate.name, eliminated: candidate.eliminatedDay !== undefined, religion: candidate.faith ? { name: candidate.faith.name, doctrine: candidate.faith.doctrine, mainSite: candidate.faith.sites.find(site => site.main)?.planetId } : null })),
    round: state.round, day: state.day, maxRounds: state.config.maxRounds, factionId,
    faction: { id: factionId, name: faction.name, homeSystemId: faction.homeSystemId, resources: Object.fromEntries(Object.entries(faction.resources).map(([resource, amount]) => [resource, display(amount)])), netIncomePer100Days: Object.fromEntries(Object.entries(faction.lastIncome).map(([resource, amount]) => [resource, display(amount)])), unity: faction.unity / 100, shortages: faction.shortages },
    systems,
    ...(industrial(state) ? { industry: { rules: INDUSTRY, effects: BUILDING_EFFECTS, buildings: LABOR, expansions: EXPANSIONS, shipMaterials: Object.fromEntries(Object.keys(SHIPS).map(type => [type, Object.fromEntries(Object.entries(shipMaterials(type as keyof typeof SHIPS)).map(([k,v]) => [k, display(v)]))])), warning: governed(state)?'5.3：地表轨道各2条，满员且供电矿正常干船坞开第二造舰线；不增加劳动力，预付材料不重扣。':'建筑需要本行星人口运营。首轮comparison.industry已提供建设、暂不建设及缺员挤占比较；地表/轨道各串行。矿物与2倍合金合并储备分最高400。' } } : {}),
    militaryTransits: Object.values(faction.transitIntel ?? {}).map(record => ({ day: record.day, live: record.live, fleet: fleetView(record.fleet, state, factionId) })),
    policy: { current: faction.policy ?? null, selectionTerm: policyWindow(state, factionId), choices: modern(state) ? V5_POLICIES : balancedRules(state) ? Object.fromEntries(Object.entries(POLICIES).filter(([id])=>['none','militarism','utopia','balanced'].includes(id)).map(([id, policy]) => [id, id === 'utopia' ? { ...policy, energy: BALANCE.utopiaProduction[0], minerals: BALANCE.utopiaProduction[0] } : policy])) : POLICIES },
    cohesion: cohesionBreakdown(state, factionId),
    ownFleets: state.fleets.filter(fleet => fleet.ownerId === factionId).map(fleet => fleetView(fleet, state, factionId)),
    events: state.events.filter(event => event.day > state.day - 100 && event.audience.includes(factionId)).slice(-80).map(event => ({ ...event, details: undefined })),
    strategies: faction.strategies.slice(-5),
    ...(governed(state)?{actualWarSettlements:state.events.filter(e=>e.type==='war'&&e.audience.includes(factionId)&&e.day>=state.day-500).map(e=>({day:e.day,text:e.text,source:e.id})),militaryProgress:faction.annexationProgress}:{}),
    ...(responsible(state)?{recentWorldResults:recentWorldResults(state,factionId)}:{}),
    ...(responsible(state)?{responsibilities:responsibilityView(state,factionId),recentSettlementFailures:Object.values(faction.failedOrders??{}).map(r=>({...r,requiresRefresh:Math.max(faction.intel[r.target]?.day??-1,faction.militaryIntel?.[r.target]?.day??-1)<=r.intelDay}))}:{}),
  };
}

/** The retained committed event window is separate from model intent and tool staging. */
export function recentWorldResults(state:GameState,actor:string){
  const rows=new Map<string,{type:string;target:string;accepted:number;failed:number;lastDay:number;lastFailureDay?:number;status:string}>();
  for(const event of state.events.filter(e=>e.type==='order'&&e.audience.includes(actor)&&e.day>=state.day-500)){
    const details=event.details as {factionId?:string;accepted?:boolean;action?:{type:string;args:Record<string,unknown>}}|undefined;
    if(details?.factionId!==actor||!details.action||details.accepted===undefined)continue;
    const {type,args}=details.action,target=String(args.systemId??args.planetId??args.fleetId??args.factionId??args.proposalId??'national'),key=type+':'+target;
    const row=rows.get(key)??{type,target,accepted:0,failed:0,lastDay:event.day,status:''};
    row.lastDay=event.day;if(details.accepted){row.accepted++;row.status='世界执行已接受';}else{row.failed++;row.lastFailureDay=event.day;row.status='世界执行失败，不计已有项目；按最新己方情报检查前置条件';}rows.set(key,row);
  }
  return {window:'最近500日内保留的已提交事件；历史截断时不代表全部历史',commands:[...rows.values()]};
}

export function factionStatistics(state: GameState, factionId: FactionId) {
  const systems = state.systems.filter(system => system.ownerId === factionId);
  const planets = systems.flatMap(system => system.planets).filter(planet => planet.ownerId === factionId);
  const fleets = state.fleets.filter(fleet => fleet.ownerId === factionId);
  return { systems: systems.length, colonies: planets.length, population: planets.reduce((sum, planet) => sum + planet.population, 0), ships: fleets.reduce((sum, fleet) => sum + fleet.ships.length, 0), power: fleets.reduce((sum, fleet) => sum + fleetPower(fleet), 0), effectivePower: fleets.reduce((sum, fleet) => sum + fleetPower(fleet), 0) * shortageMultiplier(state.factions[factionId].shortages) * currentPolicy(state, factionId).combat * faithEffects(state.factions[factionId], state.day).combat * (modern(state) ? (route(state,factionId)==='militarist'?CIVILIZATION.militaryCombat:1)*(state.factions[factionId].policy?.choice==='exercises'?CIVILIZATION.exerciseCombat:1):1), structures: planets.flatMap(planet => planet.structures).map(structure => STRUCTURES[structure.type].name) };
}

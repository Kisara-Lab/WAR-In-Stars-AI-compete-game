import { emergencyRules } from '../shared/emergency.js';
import { EMERGENCY_SCHEMAS, EMERGENCY_DESCRIPTIONS } from '../shared/emergency-tools.js';
import { applyEmergency } from './emergency.js';
import { responsible, decisionBalanced, aidView } from '../shared/responsibility.js';
import { actionLimit, governed } from '../shared/governance.js';
import type { Aid } from '../shared/responsibility.js';
import { applySocialAction } from './social.js';
import { SOCIAL_SCHEMAS, SOCIAL_DESCRIPTIONS } from '../shared/social-tools.js';
import { modern, civilizationView, V5_POLICIES } from '../shared/civilization.js';
import { applyCivilization } from './civilization.js';
import { capacity, EXPANSIONS, EXTRA, INDUSTRY, industrial, LABOR, shipMaterials, industryPlanet } from '../shared/industry.js';
import { industryComparison, constructionOptions } from './industry.js';
import { policyWindow } from '../shared/civil.js';
import type { PolicyId } from '../shared/civil.js';
import { z } from 'zod';
import { BASE, RULES, SHIPS, STRUCTURES, units } from '../shared/rules.js';
import type { FactionId, ShipType, StructureType } from '../shared/rules.js';
import type { Action, Fleet, GameState, Project, Resources, StarSystem, ToolTrace } from '../shared/types.js';
import { observation, militarySystems } from './intel.js';
import { distance } from './math.js';

import { accessiblePath, applyDiplomacy, DIPLOMATIC_ACTIONS } from './diplomacy.js';
import { canFight, relationship } from '../shared/diplomacy.js';
import { occupied } from '../shared/v4.js';
import { applyV4Action } from './v4-actions.js';
import { V4_SCHEMAS, V4_DESCRIPTIONS } from '../shared/war-tools.js';

const identifier = z.string().min(1).max(160);
const shape = <Shape extends z.ZodRawShape>(fields: Shape) => z.strictObject(fields);
export const TOOL_SCHEMAS = {
  move_fleets: shape({ fleetIds: z.array(identifier).min(1).max(48), systemId: identifier, x: z.number().min(0).max(1000).nullable(), y: z.number().min(0).max(1000).nullable(), targetFleetId: identifier.nullable() }),
  queue_ships_many: shape({ orders: z.array(shape({ planetId: identifier, shipType: z.enum(['destroyer','cruiser','battleship','dreadnought']), count: z.number().int().min(1).max(20) })).min(1).max(48) }),
  set_structures_status: shape({ structures: z.array(shape({ planetId: identifier, structureId: identifier, sealed: z.boolean() })).min(1).max(48) }),
  ...EMERGENCY_SCHEMAS,
  ...SOCIAL_SCHEMAS,
  ...V4_SCHEMAS,
  set_welfare: shape({ welfare: z.enum(['survival','basic','comfortable','welfare','utopian']) }),
  get_civilization: shape({}),
  establish_civilization: shape({ civilization: z.enum(['utopia','militarist']), acknowledgePermanent: z.literal(true), welfare:z.enum(['comfortable','basic','survival']).nullable().optional() }),
  get_industry: shape({ planetId: identifier.nullable() }),
  set_jobs: shape({ planetId: identifier, structureType: z.enum(Object.keys(STRUCTURES) as [StructureType, ...StructureType[]]), priority: z.number().int().min(0).max(5) }),
  set_structure_status: shape({ planetId: identifier, structureId: identifier, sealed: z.boolean() }),
  expand_slots: shape({ planetId: identifier, slot: z.enum(['ground', 'orbital']) }),
  choose_policy: shape({ policy: z.enum(['none', 'militarism', 'utopia', 'balanced', 'exercises', 'exchange', 'listening']) }),
  get_diplomacy: shape({}),
  confirm_contact: shape({ factionId: identifier }),
  propose_peace: shape({ factionId: identifier }),
  accept_peace: shape({ factionId: identifier }),
  reject_peace: shape({ factionId: identifier }),
  withdraw_peace: shape({ factionId: identifier }),
  open_borders: shape({ factionId: identifier }),
  close_borders: shape({ factionId: identifier }),
  get_report: shape({ systemId: identifier.nullable() }),
  survey_system: shape({ systemId: identifier }),
  build_starbase: shape({ systemId: identifier }),
  colonize_planet: shape({ planetId: identifier }),
  build_structure: shape({ planetId: identifier, structureType: z.enum(Object.keys(STRUCTURES) as [StructureType, ...StructureType[]]) }),
  scrap_structure: shape({ planetId: identifier, structureId: identifier }),
  queue_ships: shape({ planetId: identifier, shipType: z.enum(['destroyer', 'cruiser', 'battleship', 'dreadnought']), count: z.number().int().min(1).max(20) }),
  move_fleet: shape({ fleetId: identifier, systemId: identifier, x: z.number().min(0).max(1000).nullable(), y: z.number().min(0).max(1000).nullable(), targetFleetId: identifier.nullable() }),
  split_fleet: shape({ fleetId: identifier, count: z.number().int().min(1).max(10000) }),
  merge_fleets: shape({ fleetIds: z.array(identifier).min(2).max(20) }),
  cancel_order: shape({ projectId: identifier }),
  end_turn: shape({ summary: z.string().min(1).max(1000) }),
};
export type ToolName = keyof typeof TOOL_SCHEMAS;

export const batchSchema = (state?: { rulesRevision?: string }) => shape({
  orders: z.array(z.discriminatedUnion('type', [
    shape({type:z.literal('offer_aid'),args:TOOL_SCHEMAS.offer_aid}),
    ...(emergencyRules(state)?[
      shape({type:z.literal('activate_extraction'),args:TOOL_SCHEMAS.activate_extraction}),
      shape({type:z.literal('stop_extraction'),args:TOOL_SCHEMAS.stop_extraction}),
      shape({type:z.literal('demand_stop_extraction'),args:TOOL_SCHEMAS.demand_stop_extraction}),
      shape({type:z.literal('accept_stop_extraction'),args:TOOL_SCHEMAS.accept_stop_extraction}),
      shape({type:z.literal('reject_stop_extraction'),args:TOOL_SCHEMAS.reject_stop_extraction}),
    ]:[]),
    shape({type:z.literal('accept_aid'),args:TOOL_SCHEMAS.accept_aid}),
    shape({type:z.literal('reject_aid'),args:TOOL_SCHEMAS.reject_aid}),
    shape({type:z.literal('propose_reform'),args:TOOL_SCHEMAS.propose_reform}),
    shape({type:z.literal('accept_reform'),args:TOOL_SCHEMAS.accept_reform}),
    shape({type:z.literal('reject_reform'),args:TOOL_SCHEMAS.reject_reform}),
    shape({ type: z.literal('set_welfare'), args: TOOL_SCHEMAS.set_welfare }),
    shape({ type: z.literal('establish_civilization'), args: TOOL_SCHEMAS.establish_civilization }),
    shape({ type: z.literal('set_jobs'), args: TOOL_SCHEMAS.set_jobs }),
    shape({ type: z.literal('set_structure_status'), args: TOOL_SCHEMAS.set_structure_status }),
    shape({ type: z.literal('expand_slots'), args: TOOL_SCHEMAS.expand_slots }),
    shape({ type: z.literal('prepare_conquest'), args: TOOL_SCHEMAS.prepare_conquest }),
    shape({ type: z.literal('cancel_conquest'), args: TOOL_SCHEMAS.cancel_conquest }),
    shape({ type: z.literal('create_claim'), args: TOOL_SCHEMAS.create_claim }),
    shape({ type: z.literal('enforce_peace'), args: TOOL_SCHEMAS.enforce_peace }),
    shape({ type: z.literal('establish_religion'), args: TOOL_SCHEMAS.establish_religion }),
    shape({ type: z.literal('consecrate'), args: TOOL_SCHEMAS.consecrate }),
    shape({ type: z.literal('respond_dispute'), args: TOOL_SCHEMAS.respond_dispute }),
    shape({ type: z.literal('integrate_thought'), args: TOOL_SCHEMAS.integrate_thought }),
    shape({ type: z.literal('choose_policy'), args: TOOL_SCHEMAS.choose_policy }),
    shape({ type: z.literal('confirm_contact'), args: TOOL_SCHEMAS.confirm_contact }),
    shape({ type: z.literal('declare_war'), args: TOOL_SCHEMAS.declare_war }),
    shape({ type: z.literal('propose_peace'), args: TOOL_SCHEMAS.propose_peace }),
    shape({ type: z.literal('accept_peace'), args: TOOL_SCHEMAS.accept_peace }),
    shape({ type: z.literal('reject_peace'), args: TOOL_SCHEMAS.reject_peace }),
    shape({ type: z.literal('withdraw_peace'), args: TOOL_SCHEMAS.withdraw_peace }),
    shape({ type: z.literal('open_borders'), args: TOOL_SCHEMAS.open_borders }),
    shape({ type: z.literal('close_borders'), args: TOOL_SCHEMAS.close_borders }),
    shape({ type: z.literal('survey_system'), args: TOOL_SCHEMAS.survey_system }),
    shape({ type: z.literal('build_starbase'), args: TOOL_SCHEMAS.build_starbase }),
    shape({ type: z.literal('colonize_planet'), args: TOOL_SCHEMAS.colonize_planet }),
    shape({ type: z.literal('build_structure'), args: TOOL_SCHEMAS.build_structure }),
    shape({ type: z.literal('scrap_structure'), args: TOOL_SCHEMAS.scrap_structure }),
    shape({ type: z.literal('queue_ships'), args: TOOL_SCHEMAS.queue_ships }),
    shape({ type: z.literal('move_fleet'), args: TOOL_SCHEMAS.move_fleet }),
    shape({ type: z.literal('split_fleet'), args: TOOL_SCHEMAS.split_fleet }),
    shape({ type: z.literal('merge_fleets'), args: TOOL_SCHEMAS.merge_fleets }),
    shape({ type: z.literal('cancel_order'), args: TOOL_SCHEMAS.cancel_order }),
    ...(governed(state) ? [
      shape({ type: z.literal('move_fleets'), args: TOOL_SCHEMAS.move_fleets }),
      shape({ type: z.literal('queue_ships_many'), args: TOOL_SCHEMAS.queue_ships_many }),
      shape({ type: z.literal('set_structures_status'), args: TOOL_SCHEMAS.set_structures_status }),
    ] : []),
  ])).max(actionLimit(state)),
  summary: z.string().min(1).max(1000),
});
export const BATCH_SCHEMA = batchSchema();
const BULK_TOOLS = ['move_fleets', 'queue_ships_many', 'set_structures_status'];
export function expandOrder(name: string, args: Record<string, unknown>): Action[] {
  if (name === 'move_fleets') { const {fleetIds,...destination}=TOOL_SCHEMAS.move_fleets.parse(args); return fleetIds.map(fleetId=>({type:'move_fleet',args:{...destination,fleetId}})); }
  if (name === 'queue_ships_many') return TOOL_SCHEMAS.queue_ships_many.parse(args).orders.map(args=>({type:'queue_ships',args}));
  if (name === 'set_structures_status') return TOOL_SCHEMAS.set_structures_status.parse(args).structures.map(args=>({type:'set_structure_status',args}));
  return [{type:name,args}];
}

const DESCRIPTIONS: Record<ToolName, string> = {
  move_fleets: '5.3：按输入顺序移动多支舰队到同一目的地；每支舰队算一条动作，任何子项失败整批回滚。',
  queue_ships_many: '5.3：多个船厂分别下单；每项1～20艘，每项算一条动作，材料预付，任何失败整批回滚。',
  set_structures_status: '5.3：批量封存或重启设施；每项算一条动作，任何失败整批回滚。',
  ...EMERGENCY_DESCRIPTIONS,
  ...SOCIAL_DESCRIPTIONS,
  ...V4_DESCRIPTIONS,
  set_welfare: 'V5五档民众待遇，按人口实际支付；每360日可调整，乌托邦及教廷永久锁定。最高待遇不等于乌托邦制度。',
  get_civilization: '只读查询本国文明资格、永久后果、福利账单、兑现率和720日考核。',
  establish_civilization: 'V5永久确立乌托邦或军国主义，互斥且不可撤销。乌托邦须最高待遇720日且90%区间合格，不禁止合法战争但不能主动准备征服；军国无需战绩门槛。',
  get_industry: '查询己方行星岗位、队列、禀赋、扩槽与建设净收益；包括暂不建设，静态估算不保证未来。',
  set_jobs: '4.3：设置本行星某类建筑的就业优先级0至5，5最高，同级按需求比例分配。',
  set_structure_status: '4.3：封存设施保持10%维护且不提供效果；重启需100日，其间20%维护。',
  expand_slots: '4.3：地表8→10→12、轨道6→8；扩建不占槽，按对应串行队列完成，需人口门槛并预付矿物合金。',
  choose_policy: '每届720日，只可选择一次，包括明确跳过none；第0日选择首届，换届前最后一轮可预选下一届，不能撤销或自动续期。',
  get_diplomacy: '查询仅本方参与的双边外交状态。',
  confirm_contact: '确认首次接触；双方确认后和平，边境默认关闭。',
  propose_peace: '提出有效300日的停战提议，等待对方下一轮接受。',
  accept_peace: '接受上一轮收到的停战提议，保留领土并签订1080日互不侵犯。',
  reject_peace: '拒绝收到的停战提议。',
  withdraw_peace: '撤回己方尚未接受的停战提议。',
  open_borders: '单向允许目标势力穿越己方领土，与战争和停战独立。',
  close_borders: '撤销目标势力的通行权，境内舰队获得撤离期。',
  get_report: '查询允许获知的情报和本方预留后的资源；systemId=null 返回全局摘要。',
  survey_system: '探索相邻领土或己方舰队所在的未知星系。花费50矿物，500日完成，每方最多并行2个。',
  build_starbase: '在已探索、邻接己方领土的无主星系建基地，花费200矿物，基础工期200日。',
  colonize_planet: '殖民己方星系中的空行星，花费200矿物和100食物，500日后获得2人口。',
  build_structure: '在己方殖民地建设设施，自动预留地表或轨道槽位及当前修订的矿物/合金造价；每颗行星最多一个船厂。4.3按地表/轨道分别串行，建成不保证有人运营。',
  scrap_structure: '拆除己方设施并返还25%造价。船厂有造舰队列时不能拆除。',
  queue_ships: '在己方船厂排队建造1至20艘同型舰船，按当前修订预付材料（4.3同时预付矿物和合金），每个船厂串行生产，4.3进度受人口岗位影响。',
  move_fleet: '命令舰队沿航道前往目标星系和坐标；x/y=null表示基地中心500。targetFleetId=null为普通移动，否则追击可见敌舰。',
  split_fleet: '从己方舰队分出指定数量舰船，优先选择小型舰，返回新舰队ID。',
  merge_fleets: '合并同星系、相距不超过20的己方舰队，保留列表第一个ID并清除移动命令。',
  cancel_order: '取消本方未完成的建设、造舰、探索或殖民项目，返还已支付资源50%。',
  end_turn: '结束本轮决策，并写入不超过1000字的公开战略摘要；其后不再执行本轮其他命令。',
};

export function toolDefinitions(batch = false, state?: GameState) {
  const overrides: Partial<Record<ToolName,string>> = governed(state) ? {
    accept_peace: '无条件停战：归还全部临时占领，仅保留已正式吞并主权，放弃尚未兑现目标；签订1080日互不侵犯。参见settlementPreview。',
    build_structure: '预付材料并预留槽位；每行星地表、轨道各2条施工线，按创建日期/ID排队。增加建筑不增加劳动力。',
    expand_slots: '扩槽进入对应地表/轨道队列，各2条施工线；预付材料，人口门槛不变，不增加劳动力。',
    queue_ships: '预付1～20艘材料。默认1条造舰线，满员且电力矿物供应正常的本地干船坞开放第2条；失效保留进度。',
  } : {};
  if(emergencyRules(state))overrides.declare_war='合法战争：总体战systemIds=[]及重大理由ID；救援战使用普通关注、协议违约或停止什四税通牒的eventId，且仅1个己方已知、可达边境殖民目标。必须通牒被拒/到期；征收停止或到期后旧事件理由失效。遵守条约，不割地，不升级现有战争。';
  const v52=!!state&&responsible(state);
  const v5 = !!state && modern(state);
  const policyIds = v5 ? Object.keys(V5_POLICIES) : ['none','militarism','utopia','balanced'];
  const newTools = ['set_welfare','get_civilization','establish_civilization'];
  const description=(name:ToolName)=>overrides[name] ?? (v52&&name==='prepare_conquest'?'公开准备征服：普通世俗/国教300矿100粮10凝聚力、360日；军国150矿50粮5凝聚力、180日；乌托邦禁止。须正式和平、已知法理接壤，可在条约内准备，成熟资格1080个无条约和平日。另行合法宣战，不自动开战。':v52&&name==='declare_war'?'声明合法战争：总体战systemIds=[]和重大理由ID；民生救援战一个边境殖民目标和关注/违约理由ID，不割地。其余理由null。条约禁战，战争中不能升级。':v52&&name==='establish_religion'?'探索且法理拥有并实际控制未登记创教候选，永久确认与公开教义；全图仅两个永久名额，附属圣地不提供创教资格。':DESCRIPTIONS[name]);
  const adapt = (parameters: any) => {
    const adjustArgs=(p:any)=>{
      if(p.properties?.warType){if(!v52)p.properties.warType.enum=p.properties.warType.enum.filter((x:string)=>x!=='humanitarian');else {p.properties.grievanceId.description='总体战填写重大理由ID，民生救援战填写关注或违约理由ID；其余类型null。';p.properties.systemIds.description='总体战[]；宣称1～2目标，其余含救援战为1个己方已知目标。';}}
      if(p.properties?.civilization){if(v52){p.required??=[];if(!p.required.includes('welfare'))p.required.push('welfare');p.properties.welfare.description='军国同时指定合法待遇，保持已有合法待遇或建立乌托邦时填null。';}else{delete p.properties.welfare;p.required=p.required?.filter((x:string)=>x!=='welfare');}}
      if(emergencyRules(state)&&p.properties?.grievanceId)p.properties.grievanceId.description='总体战填写重大理由ID；民生救援战填写关注、违约或已拒绝/到期停止通牒对应的征收eventId。其他类型null。';
    };
    adjustArgs(parameters);
    if (parameters.properties?.policy?.enum) parameters.properties.policy.enum = policyIds;
    const branches = parameters.properties?.orders?.items?.anyOf ?? parameters.properties?.orders?.items?.oneOf;
    if (branches) { for (let i=branches.length-1;i>=0;i--) { const name=branches[i].properties?.type?.const; if(name in DESCRIPTIONS) branches[i].description=description(name as ToolName); adjustArgs(branches[i].properties.args); if(!v5&&newTools.includes(name)||!v52&&name in SOCIAL_SCHEMAS) branches.splice(i,1); else if(name==='choose_policy') branches[i].properties.args.properties.policy.enum=policyIds; } }
    return parameters;
  };
  const definitions = Object.entries(TOOL_SCHEMAS).filter(([name]) => (emergencyRules(state) || !(name in EMERGENCY_SCHEMAS)) && (governed(state) || !BULK_TOOLS.includes(name)) && (v52 || !(name in SOCIAL_SCHEMAS)) && (v5 || !newTools.includes(name)) && (!batch || name.startsWith('get_'))).map(([name, schema]) => {
    const parameters = adapt(z.toJSONSchema(schema));
    delete parameters.$schema;
    return { type: 'function', name, description: description(name as ToolName), parameters, strict: true };
  });
  if (batch) {
    const parameters = adapt(z.toJSONSchema(batchSchema(state)));
    delete parameters.$schema;
    definitions.unshift({ type: 'function', name: 'submit_turn', description: '一次提交本轮完整计划。任何命令错误会整批退回，所有资源预留撤销；收到错误后重交完整orders，不能只补失败命令。全部校验成功才结束决策。总体战declare_war必须systemIds=[]及有效grievanceId，进攻目的地另用move_fleet。orders=[]表示明确等待。', parameters, strict: true });
  }
  return definitions;
}

function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

function pay(state: GameState, factionId: FactionId, cost: Resources) {
  const resources = state.factions[factionId].resources;
  ensure(resources.energy >= cost.energy && resources.food >= cost.food && resources.minerals >= cost.minerals && (resources.alloys ?? 0) >= (cost.alloys ?? 0), '可用资源不足，已排队项目的资源也已预留');
  for (const resource of ['energy', 'food', 'minerals'] as const) resources[resource] -= cost[resource];
  if (industrial(state)) resources.alloys = (resources.alloys ?? 0) - (cost.alloys ?? 0);
}

function findSystem(state: GameState, id: string) {
  const system = state.systems.find(candidate => candidate.id === id);
  ensure(system, '星系不存在');
  return system;
}

function findPlanet(state: GameState, id: string) {
  const system = state.systems.find(candidate => candidate.planets.some(planet => planet.id === id));
  ensure(system, '行星不存在');
  return { system, planet: system.planets.find(planet => planet.id === id)! };
}

function ownFleet(state: GameState, factionId: FactionId, id: string): Fleet {
  const fleet = state.fleets.find(candidate => candidate.id === id && candidate.ownerId === factionId);
  ensure(fleet, '己方舰队不存在');
  ensure(!fleet.withdrawal, '舰队正在执行强制撤离，不能调动、拆分或合并');
  ensure(fleet.systemId && !fleet.transit, '舰队正在超空间航行，抵达后才能下达新命令');
  return fleet;
}

function addProject(state: GameState, system: StarSystem, factionId: FactionId, ticket: string, details: Partial<Project> & Pick<Project, 'kind' | 'requiredDays' | 'cost'>) {
  pay(state, factionId, details.cost);
  const project: Project = { id: ticket, ownerId: factionId, planetId: null, structureType: null, shipType: null, progress: 0, createdDay: state.day, ...details };
  system.projects.push(project);
  return { projectId: project.id, requiredDays: project.requiredDays };
}

export function applyAction(state: GameState, factionId: FactionId, action: Action, ticket: string, committed = true): unknown {
  ensure(action.type in TOOL_SCHEMAS, '未知工具');
  const args = TOOL_SCHEMAS[action.type as ToolName].parse(action.args) as Record<string, unknown>;
  const faction = state.factions[factionId];
  ensure(faction && faction.eliminatedDay === undefined, '势力不存在或已淘汰');
  if(action.type in EMERGENCY_SCHEMAS)return applyEmergency(state,factionId,{type:action.type,args},ticket);
  if(action.type in SOCIAL_SCHEMAS){const result=applySocialAction(state,factionId,{type:action.type,args},ticket);return ['offer_aid','accept_aid'].includes(action.type)?aidView(result as Aid):result;}
  if (action.type === 'get_civilization') return civilizationView(state,factionId);
  if (['set_welfare','establish_civilization'].includes(action.type)) return applyCivilization(state,factionId,{type:action.type,args});
  if (action.type in V4_SCHEMAS) return applyV4Action(state, factionId, { type: action.type, args }, ticket, committed);
  if (['colonize_planet', 'build_structure', 'scrap_structure', 'queue_ships'].includes(action.type)) {
    const { system } = findPlanet(state, args.planetId as string);
    ensure(!occupied(system), '占领期间禁止建设、拆除、殖民与造舰');
  }
  if (DIPLOMATIC_ACTIONS.includes(action.type)) return applyDiplomacy(state, factionId, { type: action.type, args });
  const zero = () => ({ energy: 0, food: 0, minerals: 0 });
  switch (action.type) {
    case 'get_industry': {
      ensure(industrial(state), '当前修订没有人口产业规则');
      return industryComparison(state,factionId,args.planetId as string | null);
    }
    case 'set_jobs':
    case 'set_structure_status':
    case 'expand_slots': {
      ensure(industrial(state), '需要4.3规则');
      const {system, planet} = findPlanet(state, args.planetId as string);
      ensure(system.ownerId === factionId && planet.ownerId === factionId && !occupied(system), '只能管理己方实际控制的殖民地');
      if (action.type === 'set_jobs') {
        planet.priorities ??= {}; planet.priorities[args.structureType as StructureType] = args.priority as number; delete planet.operation;
        return { priorities: planet.priorities };
      }
      if (action.type === 'set_structure_status') {
        const structure = planet.structures.find(s => s.id === args.structureId);
        ensure(structure, '设施不存在');
        if (args.sealed) { ensure(!structure.sealed, '设施已封存'); structure.sealed = true; delete structure.restartUntil; }
        else { ensure(structure.sealed, '设施未封存或正在重启'); structure.sealed = false; structure.restartUntil = state.day + INDUSTRY.restartDays; }
        delete planet.operation;
        return { sealed: structure.sealed, restartUntil: structure.restartUntil ?? null };
      }
      const key = args.slot === 'orbital' ? 'orbital' : (planet.expansions?.ground ?? 0) === 0 ? 'ground1' : 'ground2';
      ensure(args.slot === 'orbital' ? !planet.expansions?.orbital : (planet.expansions?.ground ?? 0) < 2, '已达到扩建上限');
      ensure(!system.projects.some(p => p.planetId === planet.id && p.expansion && EXPANSIONS[p.expansion].slot === args.slot), '对应扩建已排队');
      const expansion = EXPANSIONS[key];
      ensure(planet.population >= expansion.population, '未达到扩建人口门槛');
      return addProject(state, system, factionId, ticket, {kind: 'expansion', planetId: planet.id, expansion: key, requiredDays: expansion.days, cost: {...zero(), minerals: units(expansion.minerals), alloys: units(expansion.alloys)}});
    }
    case 'choose_policy': {
      ensure(modern(state) ? args.policy! as string in V5_POLICIES : ['none','utopia','militarism','balanced'].includes(args.policy as string), '政策不适用于此规则版本');
      ensure(args.policy !== 'utopia' || !faction.faith, '永久国教国家永远不能采用乌托邦');
      const term = policyWindow(state, factionId);
      ensure(term !== null, '本届已锁定或下一届选择窗口尚未开放');
      faction.policy ??= { term: Math.floor(state.day / RULES.policyDays), choice: 'none', explicit: false, locked: false };
      if (term === faction.policy.term) Object.assign(faction.policy, { choice: args.policy as PolicyId, explicit: true, locked: true });
      else faction.policy.next = { term, choice: args.policy as PolicyId };
      state.events.push({ id: `${ticket}-policy`, day: state.day, round: state.round + 1, type: 'policy', systemId: null, audience: [factionId], text: `${faction.name}明确选择第${term + 1}届政策 ${args.policy}，第${term * RULES.policyDays}日生效`, details: { term, policy: args.policy, explicit: true } });
      return { term, startsDay: term * RULES.policyDays, policy: args.policy };
    }
    case 'get_diplomacy': return observation(state, factionId).relations;
    case 'get_report': return observation(state, factionId, args.systemId as string | null);
    case 'end_turn': return { summary: args.summary };
    case 'survey_system': {
      const system = findSystem(state, args.systemId as string);
      ensure(!faction.surveyed.includes(system.id), '星系已经探索完成');
      const projects = state.systems.flatMap(candidate => candidate.projects).filter(project => project.kind === 'survey' && project.ownerId === factionId);
      ensure(!projects.some(project => system.projects.includes(project)), '该星系已在探索中');
      ensure(projects.length < RULES.maxSurveys, `已达到${RULES.maxSurveys}个并行探索项目上限；当前己方探索：${state.systems.flatMap(s=>s.projects.filter(p=>p.ownerId===factionId&&p.kind==='survey').map(p=>`${s.id} ${p.progress/1000}/${p.requiredDays}日`)).join('；')}。殖民队列不占探索名额`);
      ensure(system.neighbors.some(neighbor => findSystem(state, neighbor).ownerId === factionId) || state.fleets.some(fleet => fleet.ownerId === factionId && fleet.systemId === system.id), '探索目标必须邻接己方领土或存在己方舰队');
      return addProject(state, system, factionId, ticket, { kind: 'survey', requiredDays: RULES.surveyDays, cost: { ...zero(), minerals: units(RULES.surveyCost) } });
    }
    case 'build_starbase': {
      const failed=faction.failedOrders?.['build_starbase:'+args.systemId];
      if(responsible(state)&&failed){const intelDay=Math.max(faction.intel[args.systemId as string]?.day??-1,faction.militaryIntel?.[args.systemId as string]?.day??-1);ensure(intelDay>failed.intelDay,`目标 ${args.systemId} 上次共同结算失败，尚无更新情报；先派己方舰队在合法通行范围观察或取得正常LRS覆盖，勿重复旧意图`);}
      const system = findSystem(state, args.systemId as string);
      ensure(faction.surveyed.includes(system.id), '必须先探索星系');
      const intel=faction.intel[system.id], military=faction.militaryIntel?.[system.id];
      const latest=military&&military.day>=(intel?.day??-1)?military:intel?.system;
      const known=system.ownerId===factionId?system:latest;
      ensure(committed? !system.ownerId&&!system.base : !known?.ownerId&&!known?.base, committed ? decisionBalanced(state)&&!known?.ownerId&&!known?.base?'目标在共同结算时已不满足基地施工条件':'目标已有主权基地' : `星系 ${system.id} 的已知法理所有者 ${known?.ownerId??'无'}，基地${known?.base?'已存在':'无'}；建基地仅适用于已探索无主且无基地星系，不能重复建设或覆盖敌方基地`);
      ensure(!system.projects.some(project => project.kind === 'base' && project.ownerId === factionId), '己方已在此建造基地');
      ensure(!committed&&modern(state)||!system.projects.some(project => project.kind === 'base' && project.createdDay < state.day), decisionBalanced(state)?'目标在共同结算时已不满足基地施工条件':'该星系已有上一轮开始的基地施工项目');
      ensure(system.neighbors.some(neighbor => findSystem(state, neighbor).ownerId === factionId), '基地必须邻接己方领土');
      const knownFleets=military&&military.day>=(intel?.day??-1)?military.fleets:intel?.fleets??[];
      ensure(!(committed?state.fleets:knownFleets).some(fleet => fleet.ownerId !== factionId && canFight(relationship(state, factionId, fleet.ownerId)) && fleet.systemId === system.id && distance(fleet.position, { x: 500, y: 500 }) <= RULES.engagementRange), committed?(decisionBalanced(state)?'目标在共同结算时已不满足基地施工条件':'基地施工范围存在敌舰'):'已知基地施工范围存在敌舰；先排除威胁');
      return addProject(state, system, factionId, ticket, { kind: 'base', requiredDays: BASE.days, cost: { ...zero(), minerals: units(BASE.minerals) } });
    }
    case 'colonize_planet': {
      const { system, planet } = findPlanet(state, args.planetId as string);
      ensure(system.ownerId === factionId && faction.surveyed.includes(system.id), '只能殖民己方已探索星系');
      ensure(!planet.ownerId && planet.population === 0, '行星已有殖民地');
      ensure(!system.projects.some(project => project.kind === 'colonize' && project.planetId === planet.id), `行星 ${planet.id} 已有殖民项目，勿重复下单；固定500日，查看己方队列进度`);
      return addProject(state, system, factionId, ticket, { kind: 'colonize', planetId: planet.id, requiredDays: RULES.colonizeDays, cost: { ...zero(), minerals: units(RULES.colonizeMinerals), food: units(RULES.colonizeFood) } });
    }
    case 'build_structure': {
      const { system, planet } = findPlanet(state, args.planetId as string);
      ensure(system.ownerId === factionId && planet.ownerId === factionId, '只能在己方殖民地建设');
      const type = args.structureType as StructureType;
      const rule = STRUCTURES[type];
      ensure(industrial(state) || !(type in EXTRA), '新建筑需要4.3规则');
      const pending = system.projects.filter(project => project.kind === 'building' && project.planetId === planet.id);
      const occupied = planet.structures.filter(structure => STRUCTURES[structure.type].slot === rule.slot).length + pending.filter(project => STRUCTURES[project.structureType!].slot === rule.slot).length;
      ensure(occupied < (industrial(state) ? capacity(planet, rule.slot) : rule.slot === 'ground' ? RULES.groundSlots : RULES.orbitalSlots), `行星 ${planet.id} 的 ${rule.slot} 槽位已用/预留 ${occupied}/${industrial(state)?capacity(planet,rule.slot):rule.slot==='ground'?RULES.groundSlots:RULES.orbitalSlots}；先取消、拆除或符合人口门槛后扩槽`);
      ensure(type !== 'shipyard' || !planet.structures.some(structure => structure.type === 'shipyard') && !pending.some(project => project.structureType === 'shipyard'), '每颗行星最多一个船厂');
      const limit = industrial(state) ? LABOR[type].limit : type === 'sanatorium' ? 1 : type === 'resort' ? 2 : Infinity;
      ensure(planet.structures.filter(structure => structure.type === type).length + pending.filter(project => project.structureType === type).length < limit, '已达到该行星设施数量上限（包含预留）');
      ensure(type !== 'lrs' || !system.planets.some(candidate => candidate.structures.some(structure => structure.type === 'lrs')) && !system.projects.some(project => project.structureType === 'lrs'), '每星系最多一个LRS阵列（包含预留）');
      ensure(type !== 'maintenance' || !system.planets.some(p => p.structures.some(s => s.type === 'maintenance')) && !system.projects.some(p => p.structureType === 'maintenance'), '每星系最多一个舰队维护站');
      return addProject(state, system, factionId, ticket, { kind: 'building', planetId: planet.id, structureType: type, requiredDays: rule.days, cost: { ...zero(), minerals: units(rule.minerals), ...(industrial(state) ? { alloys: units(LABOR[type].alloys) } : {}) } });
    }
    case 'scrap_structure': {
      const { system, planet } = findPlanet(state, args.planetId as string);
      ensure(system.ownerId === factionId && planet.ownerId === factionId, '不能拆除他方设施');
      const structure = planet.structures.find(candidate => candidate.id === args.structureId);
      ensure(structure, '设施不存在');
      ensure(structure.type !== 'shipyard' || !system.projects.some(project => project.kind === 'ship' && project.planetId === planet.id), '请先取消船厂的全部造舰队列');
      planet.structures = planet.structures.filter(candidate => candidate !== structure);
      const refund = units(STRUCTURES[structure.type].minerals * RULES.scrapRefund);
      faction.resources.minerals += refund;
      if (industrial(state)) faction.resources.alloys = (faction.resources.alloys ?? 0) + units(LABOR[structure.type].alloys * RULES.scrapRefund);
      return { refundedMinerals: refund / 1000 };
    }
    case 'queue_ships': {
      const { system, planet } = findPlanet(state, args.planetId as string);
      ensure(system.ownerId === factionId && planet.ownerId === factionId, '只能在己方殖民地造舰');
      ensure(planet.structures.some(structure => structure.type === 'shipyard'), `行星 ${planet.id} 没有已完成船厂；在建船厂完成后才可造舰`);
      const shipType = args.shipType as ShipType;
      const count = args.count as number;
      const rule = SHIPS[shipType];
      ensure(system.projects.filter(project => project.kind === 'ship' && project.planetId === planet.id).length + count <= 40, '每个船厂最多排队40艘舰船');
      const material = industrial(state) ? shipMaterials(shipType) : { ...zero(), minerals: units(rule.minerals) };
      ensure(faction.resources.minerals >= material.minerals * count && (faction.resources.alloys ?? 0) >= (material.alloys ?? 0) * count, `造舰需预付矿物 ${material.minerals*count/1000} / 合金 ${(material.alloys??0)*count/1000}，当前预留后余额 ${faction.resources.minerals/1000} / ${(faction.resources.alloys??0)/1000}`);
      const projectIds: string[] = [];
      for (let index = 0; index < count; index++) {
        const result = addProject(state, system, factionId, `${ticket}-${index}`, { kind: 'ship', planetId: planet.id, shipType, requiredDays: rule.days, cost: material });
        projectIds.push(result.projectId);
      }
      return { projectIds };
    }
    case 'move_fleet': {
      const fleet = ownFleet(state, factionId, args.fleetId as string);
      let destination = findSystem(state, args.systemId as string);
      let position = { x: (args.x as number | null) ?? 500, y: (args.y as number | null) ?? 500 };
      const targetId = args.targetFleetId as string | null;
      if (targetId) {
        const visible = militarySystems(state, factionId);
        const target = state.fleets.find(candidate => candidate.id === targetId && candidate.ownerId !== factionId && candidate.systemId && visible.has(candidate.systemId));
        ensure(target?.systemId, '只能追击当前可见的敌方舰队');
        ensure(canFight(relationship(state, factionId, target.ownerId)), '必须先宣战，和平与互不侵犯期间禁止攻击');
        destination = findSystem(state, target.systemId);
        position = { ...target.position };
      }
      const route = accessiblePath(state, factionId, fleet.systemId!, destination.id, true);
      ensure(route, '目标没有可达航道或边境未开放');
      fleet.order = { systemId: destination.id, position, targetFleetId: targetId, route };
      return { fleetId: fleet.id, route, destination: position };
    }
    case 'split_fleet': {
      const fleet = ownFleet(state, factionId, args.fleetId as string);
      const count = args.count as number;
      ensure(count < fleet.ships.length, '拆分后原舰队至少保留一艘舰船');
      const ordered = [...fleet.ships].sort((first, second) => SHIPS[first.type].power - SHIPS[second.type].power || first.id.localeCompare(second.id));
      const ships = ordered.slice(0, count);
      const picked = new Set(ships.map(ship => ship.id));
      fleet.ships = fleet.ships.filter(ship => !picked.has(ship.id));
      const newFleet: Fleet = { ...structuredClone(fleet), id: `${ticket}-fleet`, name: `${faction.name}分遣队`, order: null, ships };
      state.fleets.push(newFleet);
      return { fleetId: newFleet.id, count };
    }
    case 'merge_fleets': {
      const ids = args.fleetIds as string[];
      ensure(new Set(ids).size === ids.length, '合并列表不能重复');
      const fleets = ids.map(id => ownFleet(state, factionId, id));
      const target = fleets[0];
      ensure(fleets.every(fleet => fleet.systemId === target.systemId && distance(fleet.position, target.position) <= 20), `合并须同一星系且距第一支舰队<=20；己方位置：${fleets.map(f=>`${f.id}@${f.systemId}(${f.position.x.toFixed(1)},${f.position.y.toFixed(1)})`).join('；')}`);
      target.ships = fleets.flatMap(fleet => fleet.ships);
      target.order = null;
      state.fleets = state.fleets.filter(fleet => !ids.slice(1).includes(fleet.id));
      return { fleetId: target.id, ships: target.ships.length };
    }
    case 'cancel_order': {
      const system = state.systems.find(candidate => candidate.projects.some(project => project.id === args.projectId && project.ownerId === factionId));
      ensure(system, '己方项目不存在或已经完成');
      const project = system.projects.find(candidate => candidate.id === args.projectId)!;
      system.projects = system.projects.filter(candidate => candidate !== project);
      for (const resource of ['energy', 'food', 'minerals'] as const) faction.resources[resource] += Math.round(project.cost[resource] * RULES.cancelRefund);
      if (industrial(state)) faction.resources.alloys = (faction.resources.alloys ?? 0) + Math.round((project.cost.alloys ?? 0) * RULES.cancelRefund);
      return { projectId: project.id, cancelled: true };
    }
    default: throw new Error('未知动作');
  }
}

export class StagingArea {
  draft: GameState;
  actions: Action[] = [];
  trace: ToolTrace[] = [];
  summary = '';
  ended = false;
  private calls = 0;

  constructor(state: GameState, readonly factionId: FactionId) { this.draft = structuredClone(state); }

  execute(name: string, args: Record<string, unknown>): { ok: boolean; result?: unknown; error?: string; subIndex?: number } {
    if (BULK_TOOLS.includes(name)) {
      try {
        ensure(governed(this.draft), '批量动作需要5.3规则');
        ensure(!this.ended, '本轮已经结束');
        const orders = expandOrder(name, args);
        ensure(this.actions.length + orders.length <= actionLimit(this.draft), '展开动作超过本轮48条上限');
        const candidate = new StagingArea(this.draft, this.factionId);
        candidate.actions = structuredClone(this.actions);
        for (const [subIndex,order] of orders.entries()) {
          const result = candidate.execute(order.type, order.args);
          if (!result.ok) {
            this.trace.push(...candidate.trace.map((trace,index)=>({...trace,parentTool:name,subIndex:index})));
            this.trace.push({name,args:structuredClone(args),ok:false,message:`子项${subIndex}: ${result.error}`});
            return {ok:false,error:`子项${subIndex}: ${result.error}`,subIndex};
          }
        }
        this.draft=candidate.draft; this.actions=candidate.actions; this.trace.push(...candidate.trace.map((trace,index)=>({...trace,parentTool:name,subIndex:index})));
        return {ok:true,result:{expanded:orders.length}};
      } catch(error) {
        const message=error instanceof Error?error.message:'批量参数错误';
        this.trace.push({name,args:structuredClone(args),ok:false,message});
        return {ok:false,error:message};
      }
    }
    this.calls++;
    try {
      ensure(!this.ended, '本轮已经结束');
      ensure(governed(this.draft) ? name === 'end_turn' || name.startsWith('get_') || this.actions.length < actionLimit(this.draft) : this.calls <= RULES.maxActions, '本轮动作次数已达上限');
      if (this.draft.rulesRevision && ['prepare_conquest', 'cancel_conquest'].includes(name)) ensure(!this.actions.some(action => ['prepare_conquest', 'cancel_conquest'].includes(action.type)), '同轮征服准备与撤回不能重复或冲突');
      if (DIPLOMATIC_ACTIONS.includes(name)) {
        const category = (type: string) => ['open_borders', 'close_borders'].includes(type) ? 'access' : 'relation';
        ensure(!this.actions.some(action => DIPLOMATIC_ACTIONS.includes(action.type) && action.args.factionId === args.factionId && category(action.type) === category(name)), '同一回合对同一势力不能提交冲突或重复的外交指令');
      }
      const candidate = structuredClone(this.draft);
      const action = { type: name, args };
      const ticket = `${this.factionId}-r${this.draft.round}-a${this.actions.length}`;
      const result = applyAction(candidate, this.factionId, action, ticket, false);
      this.draft = candidate;
      if (name === 'end_turn') { this.ended = true; this.summary = args.summary as string; }
      else if (!name.startsWith('get_')) this.actions.push(structuredClone(action));
      this.trace.push({ name, args: structuredClone(args), ok: true, message: name === 'get_report' ? '情报已返回' : JSON.stringify(result) });
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : '命令无效';
      this.trace.push({ name, args: structuredClone(args), ok: false, message });
      return { ok: false, error: message };
    }
  }
}

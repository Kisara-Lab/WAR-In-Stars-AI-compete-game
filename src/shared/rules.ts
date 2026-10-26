export const FACTIONS = ['aurora', 'umbra', 'verdant', 'cobalt'] as const;
export type FactionId = string;
export const FACTION_PRESETS = [
  { id: 'aurora', name: '晨曦共同体', color: '#56dfd3' },
  { id: 'umbra', name: '暮影议会', color: '#ffac75' },
  { id: 'verdant', name: '翠星联邦', color: '#a6e768' },
  { id: 'cobalt', name: '苍蓝联盟', color: '#739dff' },
  { id: 'rose', name: '绯红帝国', color: '#f477ac' },
  { id: 'solar', name: '金曜公社', color: '#efdc70' },
  { id: 'violet', name: '紫宸邦联', color: '#c296ff' },
  { id: 'silver', name: '银帆共和国', color: '#cbd9ed' },
];
export const factionIds = (state: { factions: Record<string, unknown> }) => Object.keys(state.factions).sort();
export const factionRecord = <Value>(ids: string[], create: (id: string) => Value): Record<string, Value> => Object.fromEntries(ids.map(id => [id, create(id)]));
export const SCALE = 1000;
export const units = (value: number) => Math.round(value * SCALE);
export const display = (value: number) => value / SCALE;

export const RULES = {
  daysPerYear: 360,
  policyDays: 720,
  sensorHops: 2,
  freeMines: 2,
  miningUnityPenalty: 2,
  sanatoriumUnity: 2,
  resortUnity: 4,
  suppliedUnity: 1,
  foodUnityPenalty: 12,
  energyUnityPenalty: 4,
  maintenanceUnityPenalty: 4,
  nonAggressionDays: 1080,
  peaceOfferDays: 300,
  withdrawalDays: 300,
  evacuationDays: 100,
  daysPerRound: 100,
  tickDays: 10,
  surveyDays: 500,
  surveyCost: 50,
  maxSurveys: 2,
  colonizeDays: 500,
  colonizeMinerals: 200,
  colonizeFood: 100,
  startingEnergy: 300,
  startingFood: 300,
  startingMinerals: 600,
  startingPopulation: 10,
  startingUnity: 6000,
  groundSlots: 8,
  orbitalSlots: 6,
  populationCap: 16,
  populationGrowthDays: 500,
  foodPerPopulation: 2,
  jumpDays: 30,
  engagementRange: 80,
  repairRadius: 100,
  repairFractionPerRound: 0.1,
  repairCostFraction: 0.5,
  maxActions: 24,
  maxRequests: 3,
  requestTimeoutMs: 90_000,
  decisionTimeoutMs: 180_000,
  maxOutputTokens: 4096,
  winnerDamageFraction: 0.5,
  cancelRefund: 0.5,
  scrapRefund: 0.25,
} as const;

export const STRUCTURES = {
  foundry: { name: '合金冶炼厂', slot: 'ground', minerals: 240, days: 300, energy: 12, upkeep: 2, output: { energy: 0, food: 0, minerals: 0 } },
  refinery: { name: '矿物精炼中心', slot: 'ground', minerals: 240, days: 300, energy: 12, upkeep: 3, output: { energy: 0, food: 0, minerals: 0 } },
  agriculture: { name: '农业加工中心', slot: 'ground', minerals: 180, days: 300, energy: 8, upkeep: 2, output: { energy: 0, food: 0, minerals: 0 } },
  housing: { name: '居住区', slot: 'ground', minerals: 200, days: 300, energy: 6, upkeep: 2, output: { energy: 0, food: 0, minerals: 0 } },
  hospital: { name: '医疗中心', slot: 'ground', minerals: 220, days: 300, energy: 10, upkeep: 2, output: { energy: 0, food: 0, minerals: 0 } },
  solar_hub: { name: '太阳能调度站', slot: 'orbital', minerals: 220, days: 300, energy: 8, upkeep: 2, output: { energy: 0, food: 0, minerals: 0 } },
  drydock: { name: '轨道干船坞', slot: 'orbital', minerals: 300, days: 400, energy: 16, upkeep: 4, output: { energy: 0, food: 0, minerals: 0 } },
  habitat: { name: '轨道居住环', slot: 'orbital', minerals: 350, days: 500, energy: 12, upkeep: 3, output: { energy: 0, food: 0, minerals: 0 } },
  maintenance: { name: '舰队维护站', slot: 'orbital', minerals: 280, days: 400, energy: 12, upkeep: 3, output: { energy: 0, food: 0, minerals: 0 } },
  sanatorium: { name: '行星疗养所', slot: 'ground', minerals: 180, days: 300, energy: 8, upkeep: 2, output: { energy: 0, food: 0, minerals: 0 } },
  resort: { name: '行星度假区', slot: 'ground', minerals: 260, days: 400, energy: 14, upkeep: 3, output: { energy: 0, food: 0, minerals: 0 } },
  lrs: { name: 'LRS 长程传感阵列', slot: 'orbital', minerals: 320, days: 400, energy: 18, upkeep: 4, output: { energy: 0, food: 0, minerals: 0 } },
  farm: { name: '农场', slot: 'ground', minerals: 100, days: 200, energy: 4, upkeep: 1, output: { energy: 0, food: 40, minerals: 0 } },
  mine: { name: '矿场', slot: 'ground', minerals: 120, days: 200, energy: 6, upkeep: 1, output: { energy: 0, food: 0, minerals: 60 } },
  solar: { name: '太阳能电站', slot: 'orbital', minerals: 100, days: 200, energy: 1, upkeep: 1, output: { energy: 100, food: 0, minerals: 0 } },
  shipyard: { name: '轨道船厂', slot: 'orbital', minerals: 200, days: 300, energy: 8, upkeep: 2, output: { energy: 0, food: 0, minerals: 0 } },
} as const;
export type StructureType = keyof typeof STRUCTURES;
export const BASE = { minerals: 200, days: 200, power: 40, energy: 6, upkeep: 2 } as const;

export const SHIPS = {
  destroyer: { name: '驱逐舰', minerals: 60, days: 100, power: 10, speed: 20, energy: 2, upkeep: 1 },
  cruiser: { name: '巡洋舰', minerals: 180, days: 200, power: 30, speed: 16, energy: 5, upkeep: 2.5 },
  battleship: { name: '战列舰', minerals: 480, days: 400, power: 80, speed: 12, energy: 12, upkeep: 6 },
  dreadnought: { name: '无畏舰', minerals: 1200, days: 800, power: 200, speed: 8, energy: 28, upkeep: 14 },
} as const;
export type ShipType = keyof typeof SHIPS;
export const SHIP_ORDER = Object.keys(SHIPS) as ShipType[];

export const DEFAULT_CONFIG = {
  seed: 'stars-2026',
  systemCount: 24,
  maxRounds: 120,
  factionIds: [...FACTIONS] as string[],
  models: factionRecord([...FACTIONS], () => 'grok-4.7'),
  controller: 'model' as 'model' | 'scripted',
};

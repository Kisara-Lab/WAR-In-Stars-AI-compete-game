import type { PolicyState } from './civil.js';
import type { FactionId, ShipType, StructureType } from './rules.js';
import type { Beacon, Claim, Faith, Grievance, Mission, War } from './v4.js';

export interface Point { x: number; y: number }
export interface Resources { energy: number; food: number; minerals: number; alloys?: number }
export interface Shortages { energy: boolean; food: boolean; minerals: boolean }
export interface Structure { id: string; type: StructureType; sealed?: boolean; restartUntil?: number }
export interface Planet {
  trait?: typeof import('./industry.js').TRAITS[number];
  priorities?: Partial<Record<StructureType, number>>;
  expansions?: { ground: number; orbital: boolean };
  operation?: { day: number; rates: Record<string, number> };
  holyCandidate?: boolean;
  influence?: Record<string, number>;
  id: string;
  name: string;
  position: Point;
  ownerId: FactionId | null;
  population: number;
  growthDays: number;
  structures: Structure[];
}
export interface Project {
  id: string;
  kind: 'survey' | 'base' | 'colonize' | 'building' | 'ship' | 'consecrate' | 'expansion';
  expansion?: keyof typeof import('./industry.js').EXPANSIONS;
  ownerId: FactionId;
  planetId: string | null;
  structureType: StructureType | null;
  shipType: ShipType | null;
  progress: number;
  requiredDays: number;
  cost: Resources;
  createdDay: number;
}
export interface Starbase { hull: number; disabledUntil?: number }
export interface StarSystem {
  controllerId?: FactionId | null;
  occupationWarId?: string;
  annexation?: { ownerId: string; warId: string; startedDay: number; controlledDays: number; completedDay?: number };
  integrationUntil?: number;
  missionProtectionUntil?: number;
  id: string;
  name: string;
  position: Point;
  neighbors: string[];
  gates: Record<string, Point>;
  ownerId: FactionId | null;
  base: Starbase | null;
  planets: Planet[];
  projects: Project[];
}
export interface Ship { id: string; type: ShipType; hull: number }
export interface FleetOrder {
  systemId: string;
  position: Point;
  targetFleetId: string | null;
  route: string[];
}
export interface Fleet {
  withdrawal?: { hostId: FactionId; deadline: number; emergencyUntil: number | null; destinationId: string | null };
  id: string;
  name: string;
  ownerId: FactionId;
  systemId: string | null;
  position: Point;
  previousPosition?: Point;
  departedDay?: number;
  movementDays?: number;
  transit: { from: string; to: string; remainingDays: number } | null;
  order: FleetOrder | null;
  ships: Ship[];
}
export interface Intel {
  day: number;
  system: StarSystem;
  fleets: Fleet[];
}
export interface MilitaryIntel { day: number; source: 'local' | 'lrs'; ownerId: string | null; controllerId?: string | null; base: Starbase | null; fleets: Fleet[] }
export interface Faction {
  extraction?: import('./emergency.js').Extraction;
  governance?: import('./governance.js').GovernanceSample[];
  annexationProgress?: { systems: string[]; wars: Record<string, { granted: number; remaining: number }> };
  responsibility?: import('./responsibility.js').ResponsibilityState;
  failedOrders?: Record<string, { type: string; target: string; count: number; day: number; intelDay: number; reason: string }>;
  civilization?: import('./civilization.js').CivilizationState;
  welfare?: import('./civilization.js').WelfareState;
  stableFaith?: { term: number; totalDays: number; qualifiedDays: number; wholeTerm: boolean };
  faith?: Faith;
  beacon?: Beacon;
  policy?: PolicyState;
  militaryIntel?: Record<string, MilitaryIntel>;
  transitIntel?: Record<string, { day: number; fleet: Fleet; live: boolean }>;
  eliminatedDay?: number;
  id: FactionId;
  name: string;
  color: string;
  homeSystemId: string;
  resources: Resources;
  lastIncome: Resources;
  unity: number;
  shortages: Shortages;
  surveyed: string[];
  intel: Record<string, Intel>;
  strategies: { round: number; text: string }[];
}
export interface MatchConfig {
  factionIds: FactionId[];
  legacy?: boolean;
  seed: string;
  systemCount: number;
  maxRounds: number;
  models: Record<FactionId, string>;
  controller: 'model' | 'scripted';
}
export interface GameEvent {
  details?: unknown;
  id: string;
  day: number;
  round: number;
  type: 'construction' | 'exploration' | 'colony' | 'movement' | 'battle' | 'capture' | 'economy' | 'population' | 'order' | 'game' | 'diplomacy' | 'policy' | 'war' | 'religion' | 'beacon';
  text: string;
  systemId: string | null;
  audience: FactionId[];
}
export type LocalEvent = Omit<GameEvent, 'id' | 'round'>;
export interface GameResult {
  winner: FactionId | null;
  reason: 'elimination' | 'score';
  scores: Record<FactionId, number>;
}
export interface GameState {
  rulesRevision?: '4.1' | '4.2' | '4.3' | '5.0' | '5.1' | '5.2' | '5.3' | '5.4';
  social?: import('./responsibility.js').SocialState;
  balanceStartedDay?: number;
  civilizationAwards?: { actor: string; category: 'utopia' | 'faith'; term: number; day: number; dedupKey: string }[];
  revisionStartedDay?: number;
  rivalries?: Record<string, import('./escalation.js').Rivalry>;
  conquests?: import('./escalation.js').Conquest[];
  warAchievements?: import('./escalation.js').WarAchievement[];
  version: 3 | 4 | 5;
  wars?: War[];
  claims?: Claim[];
  grievances?: Grievance[];
  missions?: Mission[];
  cessions?: { day: number; systemId: string; from: string; to: string; warId: string }[];
  lineage?: { matchId: string; round: number; hash: string; version: number };
  relations: Record<string, Relation>;
  id: string;
  config: MatchConfig;
  round: number;
  day: number;
  systems: StarSystem[];
  fleets: Fleet[];
  factions: Record<FactionId, Faction>;
  events: GameEvent[];
  result: GameResult | null;
}

export interface Relation {
  warId?: string;
  factions: [FactionId, FactionId];
  status: 'unknown' | 'contact' | 'peace' | 'war';
  contactDay: number | null;
  confirmed: FactionId[];
  warDay: number | null;
  pactUntil: number | null;
  access: Record<FactionId, boolean>;
  offers: Record<FactionId, { createdRound: number; expiresDay: number }>;
}
export interface Action { type: string; args: Record<string, unknown> }
export interface ToolTrace {
  parentTool?: string;
  subIndex?: number;
  batchId?: string;
  disposition?: 'rejected' | 'rolled_back' | 'accepted';
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  message: string;
}
export interface DecisionMetrics {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  reportedModel: string;
  unknownUsageRequests?: number;
}
export interface Decision {
  actions: Action[];
  summary: string;
  trace: ToolTrace[];
  metrics: DecisionMetrics;
}
export interface WorkerMetric { id: number; tasks: number; systems: number; durationMs: number; threadId: number }
export interface TurnRecord {
  attemptId?: string;
  auditHash?: string;
  round: number;
  decisions: Record<FactionId, Decision>;
  hash: string;
  state: GameState;
  metrics?: Record<FactionId, DecisionMetrics>;
}
export type MatchPhase = 'ready' | 'deciding' | 'simulating' | 'paused' | 'finished' | 'error';
export interface LiveStatus {
  phase: MatchPhase;
  running: boolean;
  busy: boolean;
  error: string | null;
  ai: Record<FactionId, { status: string; requests: number; actions: number }>;
  metrics: Record<FactionId, DecisionMetrics>;
  workers: WorkerMetric[];
}
export interface LiveSnapshot { state: GameState; status: LiveStatus; lastDecisions: Record<FactionId, Decision> | null }

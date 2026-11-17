import type { GameState } from '../shared/types.js';
import type { SrasTask } from '../shared/sras11.js';
import { controller } from '../shared/v4.js';
import { funding } from './sras11-experts.js';
import { ledger, remaining, type RuleGroup } from './sras11-rules.js';

export type TaskGroup = RuleGroup & { taskId?: string };

export function realizedAssets(state: GameState, actor: string) {
  const planets = state.systems.flatMap(system => system.planets).filter(planet => planet.ownerId === actor);
  return { population: planets.reduce((sum, planet) => sum + planet.population, 0), structures: planets.reduce((sum, planet) => sum + planet.structures.length, 0), ships: state.fleets.filter(fleet => fleet.ownerId === actor).reduce((sum, fleet) => sum + fleet.ships.length, 0), territories: state.systems.filter(system => system.ownerId === actor && controller(system) === actor).length };
}

export function fundingGoal(state: GameState, actor: string, groups: RuleGroup[]) {
  const book = ledger(state, actor);
  return groups.filter(candidate => candidate.actions.some(action => action.type === 'colonize_planet' || action.type === 'build_starbase' || action.type === 'build_structure' && ['farm', 'solar', 'foundry'].includes(String(action.args.structureType))))
    .sort((left, right) => left.priority - right.priority || right.rank - left.rank || left.id.localeCompare(right.id))
    .map(candidate => ({ candidate, ...funding(state, actor, candidate.actions) }))
    .find(goal => goal.gaps.length && goal.gaps.every(gap => gap.earliestDay !== null && gap.earliestDay < state.day + Math.min(300, remaining(state))) && book.risk === 0);
}

export function protectedFunding(state: GameState, actor: string, candidate: RuleGroup, goal: ReturnType<typeof fundingGoal>) {
  if (!goal || candidate.id === goal.candidate.id || candidate.priority < 2 || candidate.priority < goal.candidate.priority) return false;
  const price = funding(state, actor, candidate.actions).price;
  return Object.entries(goal.price).some(([resource, required]) => required > 0 && (price[resource] ?? 0) > 0 && (state.factions[actor].resources[resource as 'minerals'] ?? 0) - price[resource] < required);
}

export function acceptedTask(candidate: TaskGroup, proposals: SrasTask[]): SrasTask[] {
  const task = proposals.find(item => item.id === candidate.taskId && item.stage !== 'exit');
  if (!task) return [];
  return [{ ...structuredClone(task), status: 'accepted', reserve: {}, plannedGroup: candidate.id }];
}

export function nextShipLineDay(day: number, queue: { lines: number; projects: { line: number; estimatedCompleteDay: number | null }[] }) {
  const lines = Array.from({ length: queue.lines }, () => day);
  for (const project of queue.projects) lines[project.line - 1] = Math.max(lines[project.line - 1], project.estimatedCompleteDay ?? Infinity);
  return Math.min(...lines);
}

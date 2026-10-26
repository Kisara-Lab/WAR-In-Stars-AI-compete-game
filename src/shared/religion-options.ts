import { modern, route } from './civilization.js';
import { canEnter } from './diplomacy.js';
import type { GameState } from './types.js';
import { controller } from './v4.js';
import { responsible } from './responsibility.js';

export function religionEligibility(state: GameState, actor: string, planetId: string, committed = false): string | null {
  const faction = state.factions[actor];
  const system = state.systems.find(system => system.planets.some(planet => planet.id === planetId));
  if (!system || !faction.surveyed.includes(system.id)) return '须完成探索后发现圣地候选';
  if (!system.planets.some(planet => planet.id === planetId && planet.holyCandidate)) return '该行星不是发现的圣地候选';
  if (faction.faith) return '国教不可撤销、更换或改宗';
  if (modern(state) && route(state,actor) !== 'secular') return '永久文明路线互斥，只有普通世俗可立教';
  if (responsible(state)) {
    if (system.ownerId!==actor || controller(system)!==actor) return '5.2立教须法理拥有并实际控制创教候选星系';
    if (state.social?.founders.some(f=>f.planetId===planetId)) return '该创教候选的永久名额已经登记，失守或淘汰不释放';
    if ((state.social?.founders.length??0)>=2) return '全图两个创教资格已经用尽';
  }
  if (!modern(state) && (faction.policy?.choice === 'utopia' || faction.policy?.next?.choice === 'utopia')) return '当前或已预约乌托邦禁止确立国教';
  const allowed = new Set(state.systems.filter(candidate => candidate.id === system.id || canEnter(state, actor, controller(committed ? candidate : faction.intel[candidate.id]?.system ?? { ownerId: null }))).map(candidate => candidate.id));
  const visited = new Set(state.systems.filter(candidate => candidate.ownerId === actor && controller(candidate) === actor && allowed.has(candidate.id)).map(candidate => candidate.id));
  const frontier = [...visited];
  for (let index = 0; index < frontier.length; index++) {
    const id = frontier[index];
    if (id === system.id) return null;
    for (const neighbor of state.systems.find(candidate => candidate.id === id)!.neighbors) if (allowed.has(neighbor) && !visited.has(neighbor)) { visited.add(neighbor); frontier.push(neighbor); }
  }
  return '没有满足中间通行条件的候选抵达路线';
}

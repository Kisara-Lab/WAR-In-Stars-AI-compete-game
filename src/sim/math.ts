import { createHash } from 'node:crypto';
import { SHIPS } from '../shared/rules.js';
import type { Faction, Fleet, GameState, Point, Shortages } from '../shared/types.js';

export function seedNumber(seed: string): number {
  let value = 2166136261;
  for (const character of seed) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

export function randomGenerator(seed: string): () => number {
  let value = seedNumber(seed);
  return () => {
    value += 0x6d2b79f5;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export const distance = (first: Point, second: Point) => Math.hypot(first.x - second.x, first.y - second.y);
export const shortageMultiplier = (shortages: Shortages) => 0.5 ** Object.values(shortages).filter(Boolean).length;
export const productivity = (faction: Pick<Faction, 'unity' | 'shortages'>) => (0.5 + faction.unity / 10000) * shortageMultiplier(faction.shortages);
export const fleetPower = (fleet: Fleet) => fleet.ships.reduce((sum, ship) => sum + ship.hull, 0);
export const fleetFullPower = (fleet: Fleet) => fleet.ships.reduce((sum, ship) => sum + SHIPS[ship.type].power, 0);

export function shortestPath(systems: GameState['systems'], from: string, to: string): string[] | null {
  const queue = [from];
  const previous = new Map<string, string | null>([[from, null]]);
  const byId = new Map(systems.map(system => [system.id, system]));
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current === to) {
      const path: string[] = [];
      let step = to;
      while (step !== from) { path.unshift(step); step = previous.get(step)!; }
      return path;
    }
    for (const neighbor of byId.get(current)?.neighbors ?? []) {
      if (!previous.has(neighbor)) { previous.set(neighbor, current); queue.push(neighbor); }
    }
  }
  return null;
}

export function stateHash(state: GameState): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([first], [second]) => first.localeCompare(second)).map(([key, entry]) => [key, canonical(entry)]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify(state.version >= 4 ? canonical(state) : state)).digest('hex');
}

export function segmentDistance(firstStart: Point, firstEnd: Point, secondStart: Point, secondEnd: Point): number {
  const start = { x: firstStart.x - secondStart.x, y: firstStart.y - secondStart.y };
  const delta = { x: firstEnd.x - firstStart.x - secondEnd.x + secondStart.x, y: firstEnd.y - firstStart.y - secondEnd.y + secondStart.y };
  const lengthSquared = delta.x ** 2 + delta.y ** 2;
  const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(start.x * delta.x + start.y * delta.y) / lengthSquared));
  return Math.hypot(start.x + delta.x * amount, start.y + delta.y * amount);
}

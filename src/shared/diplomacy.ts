import type { GameState, Relation } from './types.js';

export const relationKey = (first: string, second: string) => [first, second].sort().join(':');
export const relationship = (state: Pick<GameState, 'relations'>, first: string, second: string): Relation | undefined => state.relations?.[relationKey(first, second)];
export const canFight = (relation: Relation | undefined) => !!relation && (relation.status === 'war' || relation.status === 'contact');
export const canEnter = (state: Pick<GameState, 'relations'>, visitor: string, host: string | null) => {
  if (!host || visitor === host) return true;
  const relation = relationship(state, visitor, host);
  return !relation || relation.status !== 'peace' || !!relation.access[host];
};
export const relationLabel = (relation: Relation | undefined, day: number) => !relation || relation.status === 'unknown' ? '未接触' : relation.status === 'contact' ? '接触中' : relation.status === 'war' ? '战争' : relation.pactUntil && relation.pactUntil > day ? `互不侵犯 · ${relation.pactUntil - day}日` : '和平';

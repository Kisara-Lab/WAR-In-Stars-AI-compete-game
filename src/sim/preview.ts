import type { GameState } from '../shared/types.js';

/** Comparisons never consult narrative history; avoid copying 1500 large audit events
 * for every possible building. Economic history (welfare/faith/beacon) is retained. */
export function previewDraft(state: GameState): GameState {
  return structuredClone({...state,events:[],factions:Object.fromEntries(Object.entries(state.factions).map(([id,f])=>[id,{...f,strategies:[]}]))});
}

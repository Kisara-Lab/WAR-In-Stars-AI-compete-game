import { extractingAt, V54 } from './emergency.js';
import type { Faction, GameState } from './types.js';

export const V53 = {
  revision: '5.3', scale: 1_000_000, samples: 72, tickDays: 10,
  actions: 48, outputTokens: 8192, constructionLines: 2, normalShipLines: 1, drydockShipLines: 2,
  annexationRelief: 30, annexationBuffer: 360, annexationBufferCap: 1080,
  treatment: { survival: .4, basic: .6, comfortable: .8, welfare: .9, utopian: 1, church: .85 },
} as const;
export const governed = (state?: { rulesRevision?: string }) => [V53.revision, '5.4'].includes(state?.rulesRevision ?? '');
export const actionLimit = (state?: { rulesRevision?: string }) => governed(state) ? V53.actions : 23;
export const outputLimit = (state?: { rulesRevision?: string }) => governed(state) ? V53.outputTokens : 4096;
export interface GovernanceSample { day: number; quality: number; treatment: number; welfare: number; supply: number; stability: number }
const fixed = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * V53.scale);
export function governanceSample(faction: Faction, day: number): GovernanceSample {
  const treatment = fixed(V53.treatment[faction.welfare?.choice ?? 'comfortable']);
  const welfare = fixed(faction.welfare?.last?.fraction ?? 1);
  const supply = fixed(.5 ** Object.values(faction.shortages).filter(Boolean).length);
  const stability = fixed(faction.unity / 6000);
  let quality = [welfare, supply, stability].reduce((value, factor) => Math.round(value * factor / V53.scale), treatment);
  if (extractingAt(faction.extraction, day-10)) quality=Math.min(quality, fixed(V54.governanceCap));
  return { day, quality, treatment, welfare, supply, stability };
}
export function recordGovernance(state: GameState) {
  if (!governed(state)) return;
  for (const faction of Object.values(state.factions)) {
    if (faction.eliminatedDay !== undefined) continue;
    const samples = faction.governance ??= [];
    if (samples.at(-1)?.day === state.day) continue;
    samples.push(governanceSample(faction, state.day));
    faction.governance = samples.filter(sample => sample.day > state.day - V53.samples * V53.tickDays).slice(-V53.samples);
  }
}
export function governanceView(state: GameState, actor: string) {
  const faction = state.factions[actor], samples = faction.governance ?? [];
  const current = governanceSample(faction, state.day);
  const quality = samples.length ? Math.round(samples.reduce((sum, sample) => sum + sample.quality, 0) / samples.length) : current.quality;
  const planets = state.systems.filter(s => s.ownerId === actor).flatMap(s => s.planets).filter(p => p.ownerId === actor);
  const rawSocial = planets.length * 200 + planets.reduce((sum, p) => sum + p.population * 5, 0);
  return { quality: quality / V53.scale, days: samples.length * V53.tickDays, estimated: !samples.length, note: samples.length ? '最近实际十日区间平均' : '尚无历史区间：当前状态估计；使用最近兑现率，无兑现记录时暂按足额，首个经济步后由实际样本替换', rawSocial, adjustedSocial: Math.round(rawSocial * quality / V53.scale * 1000) / 1000, factors: current };
}

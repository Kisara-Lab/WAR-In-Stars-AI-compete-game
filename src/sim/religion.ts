import { modernRules } from '../shared/responsibility.js';
import { awardCivilization } from './balance.js';
import { RULES, factionIds } from '../shared/rules.js';
import { V4, controller, foreignInfluence, observeHolyControl, occupied, roundValue, v4Event } from '../shared/v4.js';
import type { Faction, GameState, StarSystem } from '../shared/types.js';
import { seedNumber, shortestPath } from './math.js';
import { DECISION_BALANCE } from '../shared/civilization.js';
import { addInfluence } from './wars.js';

/** Add complete rotation groups near home borders; no revelation before survey. */
export function assignEarlyHolyCandidates(systems: StarSystem[], homes: string[], seed: string) {
  const rule = DECISION_BALANCE.earlyHoly, size = systems.length / homes.length;
  if (!Number.isInteger(size)) return 0;
  const qualifies = (system: StarSystem) => {
    const d = homes.map(home => shortestPath(systems,home,system.id)?.length ?? Infinity).sort((a,b)=>a-b);
    return !homes.includes(system.id) && system.neighbors.length >= 2 && d[0] === rule.nearest && d[1] <= rule.second && d[1]-d[0] <= rule.difference;
  };
  let added = 0;
  for (let offset=0;offset<size;offset++) {
    const group = homes.map((_,sector)=>systems[sector*size+offset]);
    if (!group.every(qualifies)) continue;
    for (const system of group) {
      if (!system.planets.some(p=>p.holyCandidate)) { system.planets[seedNumber(`${seed}:holy:${offset}`)%system.planets.length].holyCandidate=true; added++; }
    }
  }
  return added;
}

export function assignHolyCandidates(systems: StarSystem[], homes: string[], seed: string, relaxed = false) {
  const eligible = systems.filter(system => {
    const distances = homes.map(home => shortestPath(systems, home, system.id)?.length ?? Infinity).sort((first, second) => first - second);
    return system.neighbors.length >= 2 && distances[0] >= (relaxed ? 1 : 2) && distances[1] <= 4 && distances[1] - distances[0] <= (relaxed ? 2 : 1);
  });
  for (const system of eligible) {
    const offset = systems.indexOf(system) % (systems.length / homes.length);
    system.planets[seedNumber(`${seed}:holy:${offset}`) % system.planets.length].holyCandidate = true;
  }
  return eligible.length;
}

export function discoverHoly(state: GameState, actor: string, system: StarSystem, migration = false) {
  const candidates = system.planets.filter(planet => planet.holyCandidate).map(planet => planet.id);
  if (candidates.length) v4Event(state, 'religion', `${migration ? '新规则勘察：' : ''}${state.factions[actor].name}在${system.name}发现圣地候选`, [actor], { candidates, migration }, system.id);
}

export function finishConsecrations(state: GameState, completed: { actor: string; planetId: string }[]) {
  for (const { actor, planetId } of completed) {
    const faith = state.factions[actor].faith;
    if (!faith) continue;
    let site = faith.sites.find(candidate => candidate.planetId === planetId);
    if (!site) { site = { planetId, main: false, lossKeys: [], recoveryKeys: [] }; faith.sites.push(site); }
    if (site.consecratedDay !== undefined) continue;
    site.consecratedDay = state.day;
    faith.pending.push({ reason: '首次祝圣', amount: -(site.main ? V4.mainBlessing : V4.secondaryBlessing), source: planetId });
    v4Event(state, 'religion', `${faith.name}${site.main ? '主' : '附属'}圣地祝圣完成`, [actor], { actor, site: structuredClone(site) }, state.systems.find(system => system.planets.some(planet => planet.id === planetId))!.id);
  }
}

function updateInfluence(state: GameState) {
  const start = state.day - RULES.tickDays;
  for (const system of state.systems) {
    if (occupied(system)) continue;
    const missions = (state.missions ?? []).filter(mission => mission.systemId === system.id && mission.hostId === system.ownerId && mission.startsDay <= start && mission.expiresDay > start).sort((first, second) => first.religionId.localeCompare(second.religionId));
    for (const planet of system.planets.filter(planet => planet.population > 0)) {
      const influence = planet.influence ??= {};
      const before = { ...influence };
      for (const religionId of Object.keys(influence).sort()) if (!missions.some(mission => mission.religionId === religionId)) influence[religionId] = roundValue(Math.max(0, influence[religionId] - V4.missionDecay * RULES.tickDays / 100));
      for (const mission of missions) addInfluence(influence, mission.religionId, V4.missionGrowth * RULES.tickDays / 100);
      if ((system.integrationUntil ?? 0) > start) {
        const foreign = Object.keys(influence).filter(id => id !== system.ownerId).sort();
        const total = foreign.reduce((sum, id) => sum + influence[id], 0);
        let remaining = Math.min(total, V4.integrationRate * RULES.tickDays / 100);
        const reduction = remaining;
        for (const [index, id] of foreign.entries()) {
          const amount = Math.min(influence[id], index === foreign.length - 1 ? remaining : roundValue(reduction * influence[id] / total));
          influence[id] = roundValue(influence[id] - amount); remaining = roundValue(remaining - amount);
        }
      }
      for (const id of Object.keys(influence)) if (!influence[id]) delete influence[id];
      if (JSON.stringify(before) !== JSON.stringify(influence)) v4Event(state, 'religion', `${planet.name}地方宗教影响变化`, [system.ownerId!], { planetId: planet.id, before, after: { ...influence }, missions: missions.map(mission => mission.id) }, system.id);
    }
  }
  for (const mission of state.missions ?? []) if (mission.expiresDay === state.day) v4Event(state, 'religion', '传教权到期，地方影响开始自然消退', [mission.religionId, mission.hostId], mission, mission.systemId);
}

export function updateFaith(state: GameState) {
  updateInfluence(state);
  const portion = RULES.tickDays / 100;
  for (const actor of factionIds(state)) {
    const faction = state.factions[actor];
    const faith = faction.faith;
    if (!faith || faction.eliminatedDay !== undefined) continue;
    for (const site of faith.sites.filter(site => site.consecratedDay !== undefined)) {
      const system = state.systems.find(system => system.planets.some(planet => planet.id === site.planetId))!;
      observeHolyControl(state, system);
      if (site.lostSince !== undefined && site.lostSince < state.day) faith.pending.push({ reason: '圣地持续失守', amount: (site.main ? V4.mainPressure : V4.secondaryPressure) * portion, source: site.planetId });
    }
    const main = faith.sites.find(site => site.main);
    const foreign = foreignInfluence(state, actor);
    const triggers = [
      { key: '主圣地失守', condition: main?.lostSince !== undefined, days: 300 },
      { key: '持续信仰危机', condition: faith.crisis >= 40, days: 200 },
      { key: '外国教派思想争端', condition: foreign >= 0.2, days: 300 },
    ];
    for (const trigger of triggers) {
      const tracker = faith.triggers[trigger.key] ??= { days: 0, clearDays: 0, armed: true };
      tracker.days = trigger.condition ? tracker.days + RULES.tickDays : 0;
      if (trigger.key === '主圣地失守') tracker.days = main?.lostSince === undefined ? 0 : state.day - main.lostSince;
      tracker.clearDays = trigger.condition ? 0 : tracker.clearDays + RULES.tickDays;
      if (tracker.clearDays >= V4.disputeResetDays) tracker.armed = true;
      if (!faith.dispute && tracker.armed && tracker.days >= trigger.days) {
        tracker.armed = false;
        faith.dispute = { id: `${actor}-dispute-${state.day}`, cause: trigger.key, openedDay: state.day };
        v4Event(state, 'religion', `${faction.name}爆发教义争端：${trigger.key}`, [actor], { dispute: faith.dispute });
      }
    }
    if (faith.dispute) faith.pending.push({ reason: '教义争端未回应', amount: V4.disputePressure * portion, source: faith.dispute.id });
    if (foreign) faith.pending.push({ reason: '外国宗教影响', amount: V4.foreignPenalty * foreign * portion });
    if (!Object.values(faction.shortages).some(Boolean) && faith.sites.every(site => site.lostSince === undefined)) {
      const atWar = (state.wars ?? []).some(war => war.endedDay === undefined && war.factions.includes(actor));
      faith.pending.push({ reason: '供应正常且圣地安全', amount: -(atWar ? V4.warRecovery : V4.peaceRecovery) * portion });
    }
    const response = faith.response;
    if (response && response.effectUntil > state.day - RULES.tickDays && response.type !== 'zeal') faith.pending.push({ reason: response.type === 'reform' ? '教义改革' : '调和教派', amount: -(response.type === 'reform' ? V4.reformRecovery : V4.reconciliationRecovery) * portion });
    const vow = response?.vow;
    if (vow && !vow.resolved) {
      const fulfilled = vow.planetId ? controller(state.systems.find(system => system.planets.some(planet => planet.id === vow.planetId))!) === actor : state.wars?.find(war => war.id === vow.warId)?.goals[actor].some(goal => goal.systemId === vow.systemId && goal.achieved);
      if (fulfilled || state.day >= vow.deadline) {
        vow.resolved = true;
        faith.pending.push({ reason: fulfilled ? '圣战承诺兑现' : '圣战承诺失败', amount: fulfilled ? -V4.vowSuccess : V4.vowFailure });
        v4Event(state, 'religion', fulfilled ? '圣战承诺兑现' : '圣战承诺失败', [actor], { vow, fulfilled });
      }
    }
    const before = faith.crisis;
    faith.lastChanges = faith.pending.map(change => ({ ...change, amount: roundValue(change.amount) }));
    faith.crisis = roundValue(Math.max(0, Math.min(100, faith.crisis + faith.pending.reduce((sum, change) => sum + change.amount, 0))));
    faith.pending = [];
    if (faith.lastChanges.length) v4Event(state, 'religion', `${faction.name}信仰危机 ${before.toFixed(2)} → ${faith.crisis.toFixed(2)}`, [actor], { actor, before, after: faith.crisis, changes: faith.lastChanges });
  }
}

export function trackBeacon(state: GameState, previous: Record<string, Pick<Faction, 'shortages' | 'policy'>>) {
  if (modernRules(state)) return;
  for (const actor of factionIds(state)) {
    const faction = state.factions[actor];
    if (faction.eliminatedDay !== undefined || faction.faith) continue;
    const term = Math.floor((state.day - RULES.tickDays) / RULES.policyDays);
    const beacon = faction.beacon ??= { term, totalDays: 0, suppliedDays: 0, disqualified: state.day - RULES.tickDays !== term * RULES.policyDays, streak: 0, highest: 0 };
    beacon.totalDays += RULES.tickDays;
    if (!Object.values(previous[actor].shortages).some(Boolean)) beacon.suppliedDays += RULES.tickDays;
    if (previous[actor].policy?.choice !== 'utopia') beacon.disqualified = true;
    if (state.day % RULES.policyDays) continue;
    const qualified = beacon.totalDays === RULES.policyDays && !beacon.disqualified && beacon.suppliedDays / RULES.policyDays >= V4.beaconSupply;
    if (qualified) awardCivilization(state, actor, 'utopia', term, { ...beacon });
    beacon.streak = qualified ? beacon.streak + 1 : 0;
    beacon.highest = Math.max(beacon.highest, Math.min(2, Math.max(0, beacon.streak - 1)));
    v4Event(state, 'beacon', `${faction.name}乌托邦任期${qualified ? '合格' : '未合格'}，连续${beacon.streak}届`, [actor], { ...beacon, qualified });
    beacon.term = term + 1; beacon.totalDays = 0; beacon.suppliedDays = 0; beacon.disqualified = false;
  }
}

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/shared/rules.js';
import { createGame } from '../src/sim/world.js';
import { validateControllers } from '../src/shared/controllers.js';
import { cerberusDecision } from '../src/sim/sras13-cerberus.js';
import { scriptKnowledge } from '../src/sim/adaptive-knowledge.js';
import { validateScriptPlan, commitScriptMemory } from '../src/sim/adaptive-adapter.js';
import { conflictKeys } from '../src/sim/sras11-response.js';
import { relationKey } from '../src/shared/diplomacy.js';
import { units } from '../src/shared/rules.js';
import { SRAS_CERBERUS } from '../src/shared/sras13.js';
import { processingGroups, cerberusDependency } from '../src/sim/sras13-experts.js';
import { acceptedTask, nextShipLineDay, fundingGoal, protectedFunding } from '../src/sim/sras13-coordination.js';
import { reconcileSrasCerberus } from '../src/sim/sras13-feedback.js';

describe('SRAS Cerberus', () => {
  it('binds real paid project IDs and waits for actual delivered ships', async () => {
    const state = createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted', scriptStrategy: 'sras-v1.3cerberus', maxRounds: 120 }, 'receipt-delivery');
    const decision = await cerberusDecision(scriptKnowledge(state, 'aurora'), 'aurora', undefined);
    const action = { type: 'queue_ships', args: { planetId: state.systems.find(system => system.ownerId === 'aurora')!.planets[0].id, shipType: 'destroyer', count: 1 } };
    decision.actions = [action];
    decision.scriptReport!.selected = [{ id: 'paid-hull', label: 'hull', actions: [action], fingerprint: 'hull' }];
    state.events.push({ id: 'receipt', round: state.round, day: state.day, type: 'order', systemId: null, audience: ['aurora'], text: 'paid', details: { factionId: 'aurora', action, accepted: true, result: { projectIds: ['real-project'] } } });
    reconcileSrasCerberus(state, 'aurora', decision.scriptMemory!, decision);
    expect(decision.scriptMemory!.cerberus!.receipts![0].status).toBe('executed');
    state.fleets.find(fleet => fleet.ownerId === 'aurora')!.ships.push({ id: 'real-project-ship', type: 'destroyer', hull: 80 });
    reconcileSrasCerberus(state, 'aurora', decision.scriptMemory!, decision);
    expect(decision.scriptMemory!.cerberus!.receipts![0].status).toBe('completed');
    expect(decision.scriptReport!.cerberus!.realized!.ships).toBe(1);
  });
  it('uses the idle ship line rather than the busiest line', () => {
    expect(nextShipLineDay(100, { lines: 2, projects: [{ line: 1, estimatedCompleteDay: 500 }] })).toBe(100);
    expect(nextShipLineDay(100, { lines: 2, projects: [{ line: 1, estimatedCompleteDay: 500 }, { line: 2, estimatedCompleteDay: 300 }] })).toBe(300);
  });

  it('never associates an unrelated or exited task with an accepted group', () => {
    const candidate = { id: 'move', taskId: 'campaign:active', expert: 'campaign' as const, priority: 2, rank: 1, actions: [], reason: 'test', dependencies: [] };
    const task = { id: 'campaign:active', expert: 'campaign' as const, stage: 'assemble' as const, target: 's1', assets: ['f1'], reserve: { minerals: 100 }, deadline: 500, evidence: '', lastProgressRound: 1, next: '', blockers: [], exit: '' };
    expect(acceptedTask(candidate, [{ ...task, id: 'campaign:other' }, task])).toEqual([{ ...task, reserve: {}, status: 'accepted', plannedGroup: 'move' }]);
    expect(acceptedTask(candidate, [{ ...task, stage: 'exit' }])).toEqual([]);
  });

  it('protects attainable development savings but permits emergency preemption', () => {
    const state = createGame({ ...structuredClone(DEFAULT_CONFIG), maxRounds: 120 }, 'cerberus-saving');
    state.factions.aurora.resources = { energy: units(10000), food: units(10000), minerals: 0, alloys: units(10000) };
    const candidate = { id: 'colony', expert: 'exploration' as const, priority: 2, rank: 100, actions: [{ type: 'colonize_planet', args: { planetId: 'p1' } }], reason: 'colony', dependencies: [] };
    const goal = { candidate, price: { minerals: units(300) }, gaps: [{ resource: 'minerals', gap: 300, normalNet: 100, earliestDay: state.day + 300 }] };
      const investment = { ...candidate, id: 'optional', priority: 4, actions: [{ type: 'build_structure', args: { planetId: 'p1', structureType: 'hospital' } }] };
      expect(protectedFunding(state, 'aurora', investment, goal)).toBe(true);
      expect(protectedFunding(state, 'aurora', { ...investment, priority: 0 }, goal)).toBe(false);
  });
  it('registers as an independent pure scripted strategy', () => {
    const config = { ...structuredClone(DEFAULT_CONFIG), controller: 'scripted' as const, scriptStrategy: 'sras-v1.3cerberus' as const };
    validateControllers(config);
    expect((config as { scriptSearchProfile?: string }).scriptSearchProfile).toBeUndefined();
  });

  it('keeps the 48-action limit and reports expert quality without model calls', async () => {
    const state = createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted', scriptStrategy: 'sras-v1.3cerberus', maxRounds: 120 }, 'cerberus-fixture');
    const decision = await cerberusDecision(state, 'aurora', undefined);
    expect(decision.actions.length).toBeLessThanOrEqual(48);
    expect(decision.metrics.requests).toBe(0);
    expect(decision.scriptReport?.version).toBe('sras-v1.3cerberus');
    expect(decision.scriptReport?.cerberus?.revision).toBe(SRAS_CERBERUS.revision);
    expect(decision.scriptMemory?.version).toBe('sras-v1.3cerberus');
    expect(decision.scriptReport?.cerberus?.experts['occupation-garrison']).toBeDefined();
  });

  it('replays one legal prefix and preserves budgets and unexecuted status', async () => {
    const state = createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted', scriptStrategy: 'sras-v1.3cerberus', maxRounds: 120 }, 'cerberus-prefix');
    const known = scriptKnowledge(state, 'aurora');
    const decision = await cerberusDecision(known, 'aurora', undefined);
    expect(validateScriptPlan(known, 'aurora', decision.actions).ok).toBe(true);
    expect(decision.scriptReport!.cerberus!.quality.executed).toBe(0);
    expect(Object.values(decision.scriptReport!.sras!.budget!).reduce((sum, value) => sum + value, 0)).toBe(decision.scriptReport!.sras!.previews);
    expect(decision.scriptReport!.sras!.budget!.fallback).toBeLessThanOrEqual(24);
    const keys = decision.actions.flatMap(conflictKeys);
    expect(new Set(keys).size).toBe(keys.length);
    commitScriptMemory(state, { aurora: decision });
    expect(state.factions.aurora.scriptMemory!.cerberus!.quality.executed).toBe(0);
    expect(decision.scriptReport!.sras!.fallback!.length).toBeGreaterThan(0);
  });

  it('throws after three failed final validations and never substitutes an empty plan', async () => {
    const state = createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted', scriptStrategy: 'sras-v1.3cerberus', maxRounds: 120 }, 'cerberus-final');
    let calls = 0;
    await expect(cerberusDecision(scriptKnowledge(state, 'aurora'), 'aurora', undefined, {}, (world, actor, actions) => { calls++; return { ...validateScriptPlan(world, actor, actions), ok: false, index: 0, reason: 'injected failure' }; })).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('does not observe hidden foreign inventory', async () => {
    const state = createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted', scriptStrategy: 'sras-v1.3cerberus', maxRounds: 120 }, 'cerberus-hidden');
    const before = await cerberusDecision(scriptKnowledge(state, 'aurora'), 'aurora', undefined);
    state.factions.umbra.resources.minerals += 999000000;
    const after = await cerberusDecision(scriptKnowledge(state, 'aurora'), 'aurora', undefined);
    expect(after.actions).toEqual(before.actions);
    expect(after.scriptMemory).toEqual(before.scriptMemory);
    expect(after.scriptReport).toEqual(before.scriptReport);
  });

  it('issues an actual occupation merge and keeps the garrison out of offense', async () => {
    const state = createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted', scriptStrategy: 'sras-v1.3cerberus', maxRounds: 120 }, 'cerberus-garrison');
    const actor = 'aurora', enemy = 'umbra';
    const target = state.systems.find(system => system.ownerId === enemy)!;
    state.relations[relationKey(actor, enemy)].status = 'war';
    state.factions[actor].resources = { energy: units(10000), food: units(10000), minerals: units(10000), alloys: units(1000) };
    target.controllerId = actor; target.occupationWarId = 'occupation-war';
    state.wars = [{ id: 'occupation-war', type: 'limited', factions: [actor,enemy], attackers: [actor], startedDay: 0, startedRound: 0, reasons: {}, goals: { [actor]: [{ type: 'limited', systemId: target.id, heldDays: 0 }] }, fatigue: {}, openingValue: {}, lossWindow: 0, lossUsed: {} }];
    state.fleets = state.fleets.filter(fleet => fleet.ownerId !== enemy);
    const fleet = state.fleets.find(item => item.ownerId === actor)!;
    fleet.systemId = target.id; fleet.position = { x: 500, y: 500 }; fleet.order = null; fleet.transit = null;
    fleet.ships = [{ id: 'guard-one', type: 'cruiser', hull: 1000 }];
    const second = structuredClone(fleet); second.id = 'guard-second'; second.ships[0].id = 'guard-two'; state.fleets.push(second);
    const decision = await cerberusDecision(scriptKnowledge(state, actor), actor, undefined);
    expect(decision.actions.some(action => action.type === 'merge_fleets')).toBe(true);
    expect(decision.actions.some(action => action.type === 'move_fleet' && action.args.fleetId === fleet.id && action.args.systemId !== target.id)).toBe(false);
    expect(decision.scriptMemory!.cerberus!.base.tasks.some(task => task.id === 'occupation:' + target.id)).toBe(true);
    expect(validateScriptPlan(state, actor, decision.actions).ok).toBe(true);
  });

  it('couples liquid minerals to alloy capacity and ignores unrelated inventory in claim failures', () => {
    const state = createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted', scriptStrategy: 'sras-v1.3cerberus', maxRounds: 120 }, 'processing');
    state.round = 60; state.day = 6000;
    state.factions.aurora.resources = { energy: units(100000), food: units(100000), minerals: units(100000), alloys: 0 };
    for (const planet of state.systems.flatMap(system => system.planets).filter(planet => planet.ownerId === 'aurora')) { planet.population = 30; planet.structures = planet.structures.filter(structure => structure.type !== 'foundry'); }
    const groups = processingGroups(state, 'aurora');
    expect(groups.some(candidate => candidate.actions.some(action => action.type === 'build_structure' && action.args.structureType === 'foundry' || action.type === 'expand_slots'))).toBe(true);
    const candidate = { id: 'claim', expert: 'campaign' as const, priority: 2, rank: 1, actions: [{ type: 'create_claim', args: { systemId: 's6' } }], reason: 'test', dependencies: [] };
    const before = cerberusDependency(state, 'aurora', candidate);
    state.factions.aurora.resources.energy += 1000;
    expect(cerberusDependency(state, 'aurora', candidate)).toBe(before);
  });
});

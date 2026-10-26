import { assignFoundingCandidates } from './founding.js';
import type { MatchConfig, Point, StarSystem } from '../shared/types.js';
import { distance, randomGenerator, shortestPath } from './math.js';
import { assignHolyCandidates, assignEarlyHolyCandidates } from './religion.js';

export function generateGalaxy(config: MatchConfig, earlyHoly = false, twoFounders = false): StarSystem[] {
  const count = config.factionIds.length;
  const perSector = config.systemCount / count;
  const sectorAngle = 2 * Math.PI / count;
  for (let attempt = 0; attempt < 128; attempt++) {
    const random = randomGenerator(`${config.seed}:mesh:${attempt}`);
    const templates: Point[] = [{ x: 820, y: 500 }];
    const coreRadius = 60 + random() * 40;
    const coreAngle = (random() - 0.5) * sectorAngle * 0.6;
    templates.push({ x: 500 + coreRadius * Math.cos(coreAngle), y: 500 + coreRadius * Math.sin(coreAngle) });
    const separation = 420 / Math.sqrt(config.systemCount);
    for (let tries = 0; templates.length < perSector && tries < 10000; tries++) {
      const radius = 40 + Math.sqrt(random()) * 400;
      const angle = (random() - 0.5) * sectorAngle * 0.88;
      const point = { x: 500 + radius * Math.cos(angle), y: 500 + radius * Math.sin(angle) };
      if (templates.every(other => distance(point, other) >= separation)) templates.push(point);
    }
    if (templates.length !== perSector) continue;
    const planetCounts = templates.map((_, index) => index === 0 ? 3 : 1 + Math.floor(random() * 3));
    const systems: StarSystem[] = [];
    for (let sector = 0; sector < count; sector++) for (let local = 0; local < perSector; local++) {
      const angle = sector * sectorAngle;
      const point = templates[local];
      const id = `s${sector * perSector + local}`;
      const name = `${['天枢', '北冕', '翠星', '苍蓝', '绯红', '金曜', '紫宸', '银帆'][sector]}-${local + 1}`;
      systems.push({ id, name, position: { x: 500 + (point.x - 500) * Math.cos(angle) - (point.y - 500) * Math.sin(angle), y: 500 + (point.x - 500) * Math.sin(angle) + (point.y - 500) * Math.cos(angle) }, neighbors: [], gates: {}, ownerId: null, base: null, projects: [],
        planets: Array.from({ length: planetCounts[local] }, (_, index) => ({ id: `${id}-p${index}`, name: `${name} ${index + 1}`, position: { x: 500 + Math.cos(index * 2 * Math.PI / planetCounts[local] + angle) * 260, y: 500 + Math.sin(index * 2 * Math.PI / planetCounts[local] + angle) * 260 }, ownerId: null, population: 0, growthDays: 0, structures: [] })),
      });
    }
    const homes = Array.from({ length: count }, (_, index) => systems[index * perSector].id);
    const rotate = (index: number, rotation: number) => (index + rotation * perSector) % systems.length;
    const candidates = new Map<string, { edges: [number, number][]; length: number }>();
    for (let first = 0; first < perSector; first++) for (let second = first + 1; second < systems.length; second++) {
      const edges = Array.from({ length: count }, (_, rotation) => [rotate(first, rotation), rotate(second, rotation)].sort((left, right) => left - right) as [number, number]);
      const unique = [...new Map(edges.map(edge => [edge.join(':'), edge])).values()].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
      candidates.set(unique.map(edge => edge.join(':')).join(','), { edges: unique, length: distance(systems[first].position, systems[second].position) });
    }
    const edges: [number, number][] = [];
    const cross = (first: [number, number], second: [number, number]) => {
      if (first.some(index => second.includes(index))) return false;
      const [start, end, otherStart, otherEnd] = [...first, ...second].map(index => systems[index].position);
      const side = (origin: Point, target: Point, point: Point) => (target.x - origin.x) * (point.y - origin.y) - (target.y - origin.y) * (point.x - origin.x);
      return side(start, end, otherStart) * side(start, end, otherEnd) < -0.0001 && side(otherStart, otherEnd, start) * side(otherStart, otherEnd, end) < -0.0001;
    };
    const ordered = [...candidates.values()].sort((first, second) => first.length - second.length || first.edges[0][0] - second.edges[0][0] || first.edges[0][1] - second.edges[0][1]);
    for (const candidate of ordered) {
      if (candidate.edges.some(([first, second]) => systems[first].neighbors.includes(systems[second].id))) continue;
      const disconnected = candidate.edges.some(([first, second]) => !shortestPath(systems, systems[first].id, systems[second].id));
      const needsDegree = candidate.edges.some(([first, second]) => systems[first].neighbors.length < 3 || systems[second].neighbors.length < 3);
      if (!disconnected && !needsDegree && edges.length >= systems.length * 1.7) continue;
      if (!disconnected && candidate.edges.some(([first, second]) => systems[first].neighbors.length >= 5 || systems[second].neighbors.length >= 5)) continue;
      if (candidate.edges.some((edge, index) => [...edges, ...candidate.edges.slice(0, index)].some(other => cross(edge, other)))) continue;
      for (const [first, second] of candidate.edges) { systems[first].neighbors.push(systems[second].id); systems[second].neighbors.push(systems[first].id); }
      const tooClose = homes.some((home, index) => homes.slice(index + 1).some(other => { const route = shortestPath(systems, home, other); return route && route.length < 3; }));
      if (tooClose) {
        for (const [first, second] of candidate.edges) { systems[first].neighbors = systems[first].neighbors.filter(id => id !== systems[second].id); systems[second].neighbors = systems[second].neighbors.filter(id => id !== systems[first].id); }
      } else edges.push(...candidate.edges);
    }
    const valid = systems.every(system => shortestPath(systems, homes[0], system.id)) && homes.every(home => {
      const nearest = Math.min(...homes.filter(other => home !== other).map(other => shortestPath(systems, home, other)?.length ?? Infinity));
      return systems.find(system => system.id === home)!.neighbors.length >= 2 && nearest >= 3 && (perSector !== 6 || nearest <= 4);
    }) && edges.length >= systems.length * 1.5 && templates.some(point => distance(point, { x: 500, y: 500 }) < 240);
    if (!valid) continue;
    if (twoFounders && !assignFoundingCandidates(systems,homes,config.seed)) continue;
    if (!twoFounders && !assignHolyCandidates(systems, homes, config.seed)) continue;
    if (!twoFounders && earlyHoly && !assignEarlyHolyCandidates(systems, homes, config.seed)) continue;
    for (const system of systems) {
      system.neighbors.sort();
      for (const neighborId of system.neighbors) {
        const neighbor = systems.find(candidate => candidate.id === neighborId)!;
        const angle = Math.atan2(neighbor.position.y - system.position.y, neighbor.position.x - system.position.x);
        system.gates[neighborId] = { x: 500 + 450 * Math.cos(angle), y: 500 + 450 * Math.sin(angle) };
      }
    }
    return systems;
  }
  throw new Error('无法生成满足公平性和连通性约束的网状地图，请更换种子或星系数量');
}

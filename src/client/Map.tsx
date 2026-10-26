import { controller, occupied } from '../shared/v4.js';
import { sensorCoverage } from '../shared/civil.js';
import { STRUCTURES } from '../shared/rules.js';
import { useEffect, useRef, useState } from 'react';
import type { GameState, Point } from '../shared/types.js';

import { canEnter, relationship } from '../shared/diplomacy.js';

interface Props { viewer: string; state: GameState; selected: string; mode: 'galaxy' | 'system'; onSelect: (id: string) => void; onEnter: () => void }
const background = Array.from({ length: 450 }, (_, index) => {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  const second = Math.sin(index * 269.5 + 183.3) * 22478.145;
  return { x: value - Math.floor(value), y: second - Math.floor(second), radius: index % 7 === 0 ? 1.2 : 0.65, opacity: 0.12 + (index % 9) * 0.045 };
});

export function StarMap({ state, viewer, selected, mode, onSelect, onEnter }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 600 });
  const [camera, setCamera] = useState({ zoom: 1, x: 0, y: 0 });
  const pointer = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);
  const hitPoints = useRef<{ id: string; x: number; y: number }[]>([]);
  const selectedSystem = state.systems.find(system => system.id === selected) ?? state.systems[0];

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const rectangle = entries[0].contentRect;
      setSize({ width: rectangle.width, height: rectangle.height });
    });
    observer.observe(wrapper.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setCamera({ zoom: 1, x: 0, y: 0 }); }, [mode, state.id]);
  useEffect(() => {
    const element = canvas.current!;
    const wheel = (event: WheelEvent) => { event.preventDefault(); setCamera(current => ({ ...current, zoom: Math.max(0.6, Math.min(3.5, current.zoom * (event.deltaY > 0 ? 0.9 : 1.1))) })); };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    const coverage = viewer ? sensorCoverage(state, viewer) : new Set<string>();
    const colors = Object.fromEntries(Object.values(state.factions).map(faction => [faction.id, faction.color]));
    const element = canvas.current!;
    const context = element.getContext('2d')!;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    element.width = size.width * ratio;
    element.height = size.height * ratio;
    let frame = 0;
    let stopped = false;
    const draw = (time: number) => {
      if (stopped) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const { width, height } = size;
      context.clearRect(0, 0, width, height);
      const glow = context.createRadialGradient(width * 0.4, height * 0.42, 10, width * 0.5, height * 0.5, width * 0.75);
      glow.addColorStop(0, '#111b30'); glow.addColorStop(0.5, '#0c1222'); glow.addColorStop(1, '#080d18');
      context.fillStyle = glow; context.fillRect(0, 0, width, height);
      for (const star of background) {
        context.fillStyle = `rgba(192,211,245,${star.opacity})`;
        context.beginPath(); context.arc(star.x * width, star.y * height, star.radius, 0, Math.PI * 2); context.fill();
      }
      const scale = Math.min(width, height) * 0.82 / 1000 * camera.zoom;
      const project = (position: Point) => ({ x: width / 2 + (position.x - 500) * scale + camera.x, y: height / 2 + (position.y - 500) * scale + camera.y });
      context.strokeStyle = '#26314944'; context.lineWidth = 1;
      context.beginPath();
      for (let coordinate = 0; coordinate <= 1000; coordinate += 200) {
        const first = project({ x: coordinate, y: 0 }); const second = project({ x: coordinate, y: 1000 }); context.moveTo(first.x, first.y); context.lineTo(second.x, second.y);
        const third = project({ x: 0, y: coordinate }); const fourth = project({ x: 1000, y: coordinate }); context.moveTo(third.x, third.y); context.lineTo(fourth.x, fourth.y);
      }
      context.stroke();
      context.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
      context.textAlign = 'center';
      const dot = (position: Point, radius: number, color: string, bloom = false) => {
        context.save();
        if (bloom) { context.shadowBlur = 18; context.shadowColor = color; }
        context.fillStyle = color; context.beginPath(); context.arc(position.x, position.y, radius, 0, Math.PI * 2); context.fill(); context.restore();
      };
      const fleetIcon = (position: Point, color: string, amount: number) => {
        context.fillStyle = color; context.beginPath(); context.moveTo(position.x, position.y - 5); context.lineTo(position.x - 4, position.y + 4); context.lineTo(position.x + 4, position.y + 4); context.closePath(); context.fill();
        context.textAlign = 'left'; context.fillText(String(amount), position.x + 7, position.y + 4); context.textAlign = 'center';
      };
      const starById = new Map(state.systems.map(system => [system.id, system]));
      if (mode === 'galaxy') {
        for (const system of state.systems) if (system.ownerId) {
          const point = project(system.position);
          const territory = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, 95 * camera.zoom);
          territory.addColorStop(0, `${colors[system.ownerId]}24`); territory.addColorStop(1, `${colors[system.ownerId]}00`);
          context.fillStyle = territory; context.fillRect(point.x - 95 * camera.zoom, point.y - 95 * camera.zoom, 190 * camera.zoom, 190 * camera.zoom);
        }
        for (const system of state.systems) for (const neighborId of system.neighbors) if (system.id < neighborId) {
          const neighbor = starById.get(neighborId)!;
          const first = project(system.position); const second = project(neighbor.position);
          context.strokeStyle = system.ownerId && system.ownerId === neighbor.ownerId ? `${colors[system.ownerId]}66` : '#3c4b6766'; context.lineWidth = system.ownerId && system.ownerId === neighbor.ownerId ? 1.6 : 1;
          const border = system.ownerId !== neighbor.ownerId && (system.ownerId || neighbor.ownerId);
          const hostile = viewer && [system.ownerId, neighbor.ownerId].some(owner => owner && owner !== viewer && relationship(state, viewer, owner)?.status === 'war');
          const closed = viewer && (!canEnter(state, viewer, controller(system)) || !canEnter(state, viewer, controller(neighbor)));
          if (hostile) context.strokeStyle = '#ff7373aa';
          else if (closed) context.strokeStyle = '#a58b6688';
          else if (border) context.strokeStyle = '#88accb88';
          context.setLineDash(closed ? [3, 5] : []);
          context.beginPath(); context.moveTo(first.x, first.y); context.lineTo(second.x, second.y); context.stroke(); context.setLineDash([]);
        }
        hitPoints.current = state.systems.map(system => ({ id: system.id, ...project(system.position) }));
        for (const system of state.systems) {
          const point = project(system.position);
          if (coverage.has(system.id)) { context.strokeStyle = '#6bc9ff'; context.fillStyle = '#6bc9ff18'; context.lineWidth = 1; context.beginPath(); context.arc(point.x, point.y, 22, 0, Math.PI * 2); context.fill(); context.stroke(); }
          const color = system.ownerId ? colors[system.ownerId] : '#afbdd5';
          if (viewer && system.ownerId === viewer) { context.strokeStyle = color; context.lineWidth = 2; context.beginPath(); context.arc(point.x, point.y, 11, 0, Math.PI * 2); context.stroke(); }
          if (viewer && system.ownerId && relationship(state, viewer, system.ownerId)?.status === 'war') { context.strokeStyle = '#ff7373'; context.strokeRect(point.x - 10, point.y - 10, 20, 20); }
          if (system.id === selected) {
            context.strokeStyle = '#dbe6fba0'; context.lineWidth = 1; context.setLineDash([3, 4]);
            context.beginPath(); context.arc(point.x, point.y, 17 + Math.sin(time / 700), 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
          }
          if (occupied(system)) { context.strokeStyle = colors[controller(system)!] ?? '#ffffff'; context.setLineDash([2, 2]); context.lineWidth = 3; context.strokeRect(point.x - 12, point.y - 12, 24, 24); context.setLineDash([]); context.lineWidth = 1; }
          const markers = [system.planets.some(planet => planet.holyCandidate) ? '✧' : '', state.wars?.some(war => war.endedDay === undefined && Object.values(war.goals).flat().some(goal => goal.systemId === system.id && !goal.invalid)) ? '⚑' : '', state.missions?.some(mission => mission.systemId === system.id && mission.expiresDay > state.day) ? '传' : '', (system.base?.disabledUntil ?? 0) > state.day ? '停' : ''].join('');
          if (markers) { context.fillStyle = '#e6cd83'; context.fillText(markers, point.x, point.y - 19); }
          dot(point, system.base ? 4 : 2.8, color, !!system.ownerId);
          if (system.base) { context.strokeStyle = `${color}88`; context.strokeRect(point.x - 7, point.y - 7, 14, 14); }
          if (state.systems.length <= 64 || system.id === selected) { context.fillStyle = system.id === selected ? '#edf3ff' : '#8c9bb6'; context.fillText(system.name, point.x, point.y + 28); }
        }
        for (const fleet of state.fleets) {
          if (!fleet.systemId && !fleet.transit) continue;
          let position: Point;
          if (fleet.transit) {
            const from = starById.get(fleet.transit.from)!.position; const to = starById.get(fleet.transit.to)!.position;
            const progress = Math.max(0, Math.min(1, 1 - fleet.transit.remainingDays / 30));
            position = project({ x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress });
          } else {
            const system = starById.get(fleet.systemId!)!;
            position = project(system.position);
            position = { x: position.x + (fleet.position.x - 500) * 0.07, y: position.y + (fleet.position.y - 500) * 0.07 - 10 };
          }
          fleetIcon(position, colors[fleet.ownerId], fleet.ships.length);
          if (fleet.order?.route.length && (fleet.systemId === selected || fleet.order.systemId === selected)) {
            context.strokeStyle = `${colors[fleet.ownerId]}88`; context.setLineDash([3, 6]); context.lineDashOffset = -time / 100; context.beginPath(); context.moveTo(position.x, position.y);
            for (const systemId of fleet.order.route) { const point = project(starById.get(systemId)!.position); context.lineTo(point.x, point.y); }
            context.stroke(); context.setLineDash([]);
          }
        }
      } else {
        const center = project({ x: 500, y: 500 });
        const stellarGlow = context.createRadialGradient(center.x, center.y, 0, center.x, center.y, 65 * camera.zoom);
        stellarGlow.addColorStop(0, '#ffd68e44'); stellarGlow.addColorStop(1, '#ffd68e00'); context.fillStyle = stellarGlow; context.beginPath(); context.arc(center.x, center.y, 65 * camera.zoom, 0, Math.PI * 2); context.fill();
        dot(center, 12 * camera.zoom, '#ffe1a4', true);
        context.fillStyle = '#c5b69c'; context.fillText(selectedSystem.name, center.x, center.y + 34);
        if (selectedSystem.base) { context.strokeStyle = selectedSystem.ownerId ? colors[selectedSystem.ownerId] : '#a8b9d4'; context.lineWidth = 2; context.beginPath(); context.arc(center.x, center.y, 23 * camera.zoom, -0.5, Math.PI + 0.5); context.stroke(); }
        for (const planet of selectedSystem.planets) {
          const point = project(planet.position);
          const radius = Math.hypot(planet.position.x - 500, planet.position.y - 500) * scale;
          context.strokeStyle = '#35425a66'; context.lineWidth = 1; context.beginPath(); context.arc(center.x, center.y, radius, 0, Math.PI * 2); context.stroke();
          dot(point, (planet.ownerId ? 9 : 7) * camera.zoom, planet.ownerId ? colors[planet.ownerId] : '#7c8daa', true);
          context.fillStyle = '#bccae1'; context.fillText(`${planet.name}${planet.ownerId ? ` · ${planet.population}人口` : ' · 未殖民'}`, point.x, point.y + 26);
          for (let slot = 0; slot < 6; slot++) { const angle = slot / 6 * Math.PI * 2; const filled = slot < planet.structures.filter(structure => STRUCTURES[structure.type].slot === 'orbital').length; dot({ x: point.x + Math.cos(angle) * 20, y: point.y + Math.sin(angle) * 20 }, 2, filled ? '#f5d58d' : '#354158'); }
        }
        for (const [neighborId, gate] of Object.entries(selectedSystem.gates)) {
          const point = project(gate); context.strokeStyle = '#7a8aab'; context.lineWidth = 2; context.beginPath(); context.arc(point.x, point.y, 8, 0, Math.PI * 2); context.stroke();
          context.fillStyle = '#788ba9'; context.fillText(`→ ${starById.get(neighborId)?.name}`, point.x, point.y + 22);
        }
        hitPoints.current = [];
        for (const fleet of state.fleets.filter(candidate => candidate.systemId === selected)) {
          const point = project(fleet.position);
          fleetIcon(point, colors[fleet.ownerId], fleet.ships.length);
          if (fleet.order) {
            const destination = fleet.order.route.length ? selectedSystem.gates[fleet.order.route[0]] : fleet.order.position;
            if (destination) { const target = project(destination); context.strokeStyle = `${colors[fleet.ownerId]}88`; context.setLineDash([3, 5]); context.lineDashOffset = -time / 100; context.beginPath(); context.moveTo(point.x, point.y); context.lineTo(target.x, target.y); context.stroke(); context.setLineDash([]); }
          }
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { stopped = true; cancelAnimationFrame(frame); };
  }, [state, viewer, selected, mode, camera, size, selectedSystem]);

  return <div className="star-map" ref={wrapper}>
    <canvas ref={canvas} aria-label={mode === 'galaxy' ? '星系群地图，点击选择星系，双击进入星系，滚轮缩放' : `${selectedSystem.name}星系视图`} role="img"
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); pointer.current = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false }; }}
      onPointerMove={event => { const current = pointer.current; if (!current) return; const dx = event.clientX - current.x; const dy = event.clientY - current.y; if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 4) current.moved = true; if (current.moved) setCamera(value => ({ ...value, x: value.x + dx, y: value.y + dy })); current.x = event.clientX; current.y = event.clientY; }}
      onPointerUp={event => { const current = pointer.current; if (current && !current.moved && mode === 'galaxy') { const bounds = event.currentTarget.getBoundingClientRect(); const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }; const hit = hitPoints.current.find(candidate => Math.hypot(candidate.x - point.x, candidate.y - point.y) < 20); if (hit) onSelect(hit.id); } pointer.current = null; }}
      onPointerCancel={() => { pointer.current = null; }} onDoubleClick={() => { if (mode === 'galaxy') onEnter(); }} />
    <div className="map-corner-label"><span className="crosshair">⌖</span> {mode === 'galaxy' ? 'GALACTIC OVERVIEW' : 'SYSTEM SURVEY'}<small>{mode === 'galaxy' ? `${state.systems.length} 个星系 · 全图观察` : `${selectedSystem.planets.length} 颗行星 · 实时位置`}</small></div>
    <div className="map-legend">{viewer && <span><i style={{ background: '#6bc9ff' }} />LRS 覆盖 {sensorCoverage(state, viewer).size} 星系</span>}{Object.values(state.factions).map(faction => <span key={faction.id}><i style={{ background: faction.color }} />{faction.name.slice(0, 2)}</span>)}<span><i style={{ background: '#99a8c1' }} />无主</span></div>
    <div className="map-navigation"><button title="放大" onClick={() => setCamera(value => ({ ...value, zoom: Math.min(3.5, value.zoom * 1.2) }))}>＋</button><button title="缩小" onClick={() => setCamera(value => ({ ...value, zoom: Math.max(0.6, value.zoom / 1.2) }))}>−</button><button title="重置视角" onClick={() => setCamera({ zoom: 1, x: 0, y: 0 })}>⌖</button></div>
    <div className="map-hint">拖动平移 · 滚轮缩放{mode === 'galaxy' ? ' · 双击进入星系' : ''}</div>
  </div>;
}

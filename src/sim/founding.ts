import { RESPONSIBILITY as R } from '../shared/responsibility.js';
import type { GameState } from '../shared/types.js';
import { shortestPath, seedNumber } from './math.js';
/** Only this function changes candidate markers; existing main sites can be pinned during migration. */
export function assignFoundingCandidates(systems:GameState['systems'], homes:string[], seed:string, pinned:string[]=[]):boolean {
  const dist=(a:string,b:string)=>shortestPath(systems,a,b)?.length??Infinity;
  const eligible=systems.filter(s=>!homes.includes(s.id)&&s.neighbors.length>=2).filter(s=>{
    const d=homes.map(h=>dist(h,s.id)).sort((a,b)=>a-b);
    return d[0]>=R.holyNearestMin&&d[0]<=R.holyNearestMax&&d[1]<=R.holySecondMax&&d[1]-d[0]<=R.holyDistanceGap;
  });
  const fixed=pinned.map(id=>systems.find(s=>s.planets.some(p=>p.id===id))!).filter(Boolean);
  if(fixed.length!==pinned.length||new Set(fixed.map(s=>s.id)).size!==fixed.length||fixed.length>2)return false;
  const pool=[...new Map([...fixed,...eligible].map(s=>[s.id,s])).values()];
  const pairs:{ids:string[];max:number;gap:number;tie:number}[]=[];
  for(let i=0;i<pool.length;i++)for(let j=i+1;j<pool.length;j++){
    const ids=[pool[i].id,pool[j].id].sort();
    if(!fixed.every(s=>ids.includes(s.id))||dist(...ids as [string,string])<R.holySeparation)continue;
    const d=homes.map(h=>Math.min(...ids.map(id=>dist(h,id))));
    pairs.push({ids,max:Math.max(...d),gap:Math.max(...d)-Math.min(...d),tie:seedNumber(seed+':founding:'+ids.join(':'))});
  }
  pairs.sort((a,b)=>a.max-b.max||a.gap-b.gap||a.tie-b.tie||a.ids.join(':').localeCompare(b.ids.join(':')));
  if(!pairs.length)return false;
  for(const s of systems)for(const p of s.planets)delete p.holyCandidate;
  for(const id of pairs[0].ids){const s=systems.find(s=>s.id===id)!;const p=s.planets.find(p=>pinned.includes(p.id))??s.planets[seedNumber(seed+':founding-planet:'+id)%s.planets.length];p.holyCandidate=true;}
  return true;
}

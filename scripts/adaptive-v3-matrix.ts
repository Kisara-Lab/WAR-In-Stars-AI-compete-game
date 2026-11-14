import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const root=process.argv[2];
if(!root)throw new Error('Pass the directory containing the existing adaptive-v1 league snapshots');
const output=resolve('.data/verification/adaptive-v3/performance-release');await mkdir(output,{recursive:true});
const snapshots=[['four-80','self-0-4/round-80.json'],['four-100','self-0-4/round-100.json'],['eight-100','self-2-8/round-100.json']];
const configurations=[['v2','adaptive-v2','standard','auto'],['standard-serial','adaptive-v3','standard','0'],['standard-parallel','adaptive-v3','standard','auto'],['deep-serial','adaptive-v3','deep','0'],['deep-parallel','adaptive-v3','deep','auto']];
const results:unknown[]=[];
for(const [label,file] of snapshots) {
  const hashes=new Map<string,string>();
  for(const [name,strategy,profile,workers] of configurations) {
    const directory=join(output,label+'-'+name);
    console.log('BENCHMARK '+label+' '+name);
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx','scripts/adaptive-v3-observe.ts','--mode','benchmark','--snapshot',join(root,file),'--strategy',strategy,'--profile',profile,'--workers',workers,'--repeat','2','--output',directory],{stdio:'inherit',windowsHide:true});
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(label+' '+name+' failed '+code)));
    });
    const result=JSON.parse(await readFile(join(directory,'benchmark.json'),'utf8'));
    const same=new Set(result.samples.map((sample:{hash:string})=>sample.hash));
    if(same.size!==1)throw new Error('Cold/warm determinism mismatch: '+label+' '+name);
    if(strategy==='adaptive-v3') {
      const hash=result.samples[0].hash;
      if(hashes.has(profile)&&hashes.get(profile)!==hash)throw new Error('Worker determinism mismatch: '+label+' '+profile);
      hashes.set(profile,hash);
    }
    results.push({label,name,...result,samples:result.samples.map((sample:{actors:Record<string,{report:{candidates:number;forecasts:number;search?:{evaluations:number};performance:unknown};actions:number}>})=>({...sample,actors:Object.fromEntries(Object.entries(sample.actors).map(([actor,row])=>[actor,{actions:row.actions,candidates:row.report.candidates,forecasts:row.report.forecasts,evaluations:row.report.search?.evaluations,performance:row.report.performance}]))}))});
    await writeFile(join(output,'matrix.json'),JSON.stringify(results,null,2));
  }
}

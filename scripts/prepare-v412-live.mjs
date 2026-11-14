import {mkdir,readFile,writeFile,readdir,cp,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,relative} from 'node:path';
const directory=resolve('.data/live-adaptive-v412-20261115');
try{await access(join(directory,'manifest.json'));throw Error('Frozen observation already exists; refusing to replace it');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(directory,{recursive:true});
const runtime=resolve('.data/verification/adaptive-v412/runtime');
async function tree(root){return (await Promise.all((await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)).map(async e=>e.isDirectory()?tree(join(root,e.name)):[join(root,e.name)]))).flat();}
const hashes={};
for(const root of ['src',join(runtime,'dist')])for(const path of await tree(root))hashes[relative(process.cwd(),path).replaceAll('\\','/')]=createHash('sha256').update(await readFile(path)).digest('hex');
await cp('src',join(directory,'source'),{recursive:true,errorOnExist:true,force:false});
const config={...JSON.parse(await readFile('config.mixed.example.json','utf8')),workers:8,computeWorkers:30,planningCacheMiB:8192};
await writeFile(join(directory,'config.json'),JSON.stringify(config,null,2));
await writeFile(join(directory,'manifest.json'),JSON.stringify({created:new Date().toISOString(),strategy:'adaptive-v4.12',revision:'continuous-campaign-1',profile:'standard',runtime,config,hashes,sourceDigest:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),policy:{maximumMatches:1,maximumRounds:120,extraTimeoutRetriesPerRound:1,noPaidProbe:true,frozen:true}},null,2));
console.log(JSON.stringify({directory,runtime,config,files:Object.keys(hashes).length}));

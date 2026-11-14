import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {advanceRound} from '../src/sim/engine.js';
import {stateHash} from '../src/sim/math.js';
import {SimulationPool} from '../src/sim/pool.js';

const directory=resolve('.data/verification/adaptive-v412');await mkdir(directory,{recursive:true});
const roots=['.data/live-adaptive-v4-20261114','.data/live-adaptive-v41-20261114'];
async function walk(path:string):Promise<string[]> {const entries=await readdir(path,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?walk(join(path,e.name)):Promise.resolve([join(path,e.name)])))).flat();}
async function digest(path:string){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
const files=Object.fromEntries(await Promise.all((await Promise.all(roots.map(walk))).flat().sort().map(async path=>[path,await digest(path)])));
const file=join(directory,'history-hashes.json');
let before:typeof files|undefined;try{before=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
if(before){for(const [path,hash] of Object.entries(before))if(files[path]!==hash)throw Error('Historical file changed: '+path);}else await writeFile(file,JSON.stringify(files,null,2));
if(!process.argv.includes('--hashes-only')){
  const frozen=await import(pathToFileURL(resolve('.data/verification/adaptive-v41/runtime/dist/sim/engine.js')).href);
  const pool=new SimulationPool(0),results=[];
  try{for(const path of [join(roots[0],'matches/da00f345-d0f8-4ef8-807b-efff8c53690c/round-0040.json'),join(roots[1],'matches/e6e59bae-e296-4f3f-8a89-05cf13164c0f/round-0059.json')]){
    const saved=JSON.parse(await readFile(path,'utf8'));
    const original=stateHash(saved.state),current=await advanceRound(saved.state,pool,{}),old=await frozen.advanceRound(saved.state,pool,{});
    if(stateHash(current)!==stateHash(old)||stateHash(saved.state)!==original)throw Error('Legacy world regression: '+path);
    results.push({path,source:saved.hash,worldHash:stateHash(current),frozenWorldHash:stateHash(old)});
  }}finally{await pool.close();}
  await writeFile(join(directory,'compatibility.json'),JSON.stringify({files:Object.keys(files).length,results},null,2));
}
console.log(JSON.stringify({historicalFiles:Object.keys(files).length,unchanged:true}));

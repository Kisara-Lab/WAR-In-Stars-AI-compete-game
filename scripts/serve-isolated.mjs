import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const argument=(name,fallback)=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:fallback;
const build=resolve(argument('--build',process.env.ISOLATED_BUILD??'.data/verification/adaptive-v41/runtime/dist'));
const directory=resolve(argument('--data',process.env.ISOLATED_DATA??'.data/verification/adaptive-v41/browser'));
const port=Number(argument('--port','8791'));
const credentials=argument('--credentials','');
const configFile=argument('--config','');
const branchFile=argument('--branch-from','');
const stopRound=Number(argument('--stop-round','0'));
if(!Number.isInteger(stopRound)||stopRound<0)throw new Error('Invalid observation stop round');
const load=name=>import(pathToFileURL(join(build,name)).href);
const [{DEFAULT_CONFIG},{SimulationPool},{createGame},{createApplication},{ModelProvider,readProviderConfig},{MatchRunner},{MatchStore}]=await Promise.all([
  load('shared/rules.js'),load('sim/pool.js'),load('sim/world.js'),load('server/app.js'),load('server/provider.js'),load('server/runner.js'),load('server/storage.js')]);
const store=new MatchStore(join(directory,'matches'),join(directory,'session.json'));
const checkpoint=await store.sessionCheckpoint();
const provider=async()=>{if(!credentials)throw new Error('No model credentials configured for this isolated service');return new ModelProvider(await readProviderConfig(credentials));};
const config=configFile?JSON.parse(await readFile(resolve(configFile),'utf8')):{...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:argument('--strategy','adaptive-v4.1'),scriptSearchProfile:'standard'};
const {validateControllers}=await load('shared/controllers.js');
validateControllers(config);
if(config.scriptStrategies&&credentials)throw new Error('Script comparison must run without model credentials');
const branch=(!checkpoint&&branchFile)?JSON.parse(await readFile(resolve(branchFile),'utf8')):null;
if(branch){branch.state.lineage={matchId:branch.state.id,round:branch.state.round,hash:branch.hash,version:branch.state.version};branch.state.id=randomUUID();}
const runner=new MatchRunner(checkpoint?.state??branch?.state??createGame(config),new SimulationPool(Number(argument('--workers','2'))),store,provider);
if(checkpoint)await runner.recover(checkpoint);else {
  if(branch){runner.lastDecisions=branch.decisions??branch.lastDecisions;runner.status.metrics=branch.metrics;}
  await runner.initialize();
}
// Stop only after the round is committed. Keep the full match horizon in game config.
let stopping=false;
runner.subscribe(()=>{
  if(stopRound&&runner.state.round>=stopRound&&runner.status.running&&!stopping){
    stopping=true;
    runner.pause();
    stopping=false;
    console.log(JSON.stringify({observationLimit:stopRound,round:runner.state.round,id:runner.state.id}));
  }
});
const {server,sockets}=createApplication(runner,provider,resolve(build,'..'));
server.listen(port,'127.0.0.1',()=>console.log(`Isolated match service http://127.0.0.1:${port}/ (paused)`));
let closing=false;
const close=async()=>{if(closing)return;closing=true;for(const socket of sockets.clients)socket.close();server.close();await runner.close();process.exit(0);};
process.on('SIGINT',close);process.on('SIGTERM',close);
server.on('error',async error=>{console.error(error.message);await runner.close();process.exitCode=1;});

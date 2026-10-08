// Read-only source snapshot; migration and load tests touch only .cache fixtures.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, cpSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const product = fileURLToPath(new URL('..',import.meta.url));
const id = process.argv[2];
if(!id||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(id)) throw new Error('Usage: node scripts/release-storage-benchmark.mjs <existing-projectId>');
const source = resolve(process.env.VIDEOGRAPH_PROJECTS ?? join(product,'projects'),id);
const root = join(product,'.cache','release020-storage-benchmark'), target = join(root,'projects',id);
if(existsSync(join(target,'project.sqlite'))) throw new Error('isolated benchmark already exists; choose a fresh run directory');
mkdirSync(target,{recursive:true});
const sourceDb = new DatabaseSync(join(source,'project.sqlite'),{readOnly:true});
try { sourceDb.prepare('VACUUM INTO ?').run(join(target,'project.sqlite')); } finally{sourceDb.close();}
if(existsSync(join(source,'.records'))) cpSync(join(source,'.records'),join(target,'.records'),{recursive:true});
process.env.VIDEOGRAPH_PROJECTS=join(root,'projects');
const repo = await import('../src/server/project-repository.mjs');
const {migrateProjectStorage}=await import('../src/server/storage-maintenance.mjs');
const {OperationPool}=await import('../src/server/operation-pool.mjs');
const {createProjectService}=await import('../src/server/service.mjs');
const {readServiceConfig}=await import('../src/server/service-config.mjs');
function totals(){const db=new DatabaseSync(join(target,'project.sqlite'));try{return {dbBytes:statSync(join(target,'project.sqlite')).size,jobs:db.prepare('SELECT count(*) AS count,sum(length(data)) AS bytes FROM jobs').get(),revisions:db.prepare('SELECT count(*) AS count,sum(length(data)) AS bytes FROM revisions').get()};}finally{db.close();}}
const before=totals(), started=performance.now();
const pool=new OperationPool({size:1,timeoutMs:600000});
let migration;try{migration=await pool.call('migrateProjectStorage',[id,{vacuum:true}]);}finally{await pool.close();}
const after=totals();
let objectBytes=0,objectCount=0;
for(const name of readdirSync(join(target,'.records/objects'))){objectBytes+=statSync(join(target,'.records/objects',name)).size;objectCount++;}
const config=readServiceConfig({...process.env,VIDEOGRAPH_SERVICE_PORT:'0',VIDEOGRAPH_SERVICE_TOKEN_FILE:join(root,'token')});
// No analyzer starts: source state is preserved; fixtures already have completed analysis.
const service=createProjectService(config);
const health=[];
try{
  const {url}=await service.start();const token=(await import('node:fs')).readFileSync(config.tokenPath,'utf8');
  const headers={authorization:`Bearer ${token}`};
  const heavy=Promise.all(Array.from({length:12},()=>fetch(`${url}/projects/${id}/director`,{headers}).then(async r=>{if(!r.ok)throw new Error(await r.text());return r.arrayBuffer();})));
  for(let i=0;i<30;i++){const t=performance.now();const r=await fetch(`${url}/health`);if(!r.ok)throw new Error('health failed');await r.json();health.push(performance.now()-t);}
  await heavy;
  const payload=await fetch(`${url}/projects/${id}/jobs?limit=40`,{headers}).then(r=>r.text());
  health.sort((a,b)=>a-b);
  const report={projectId:id,sourceReadOnly:true,before,after,objectBytes,objectCount,migration,elapsedMs:performance.now()-started,
    totalStorageReduction:1-(after.dbBytes+objectBytes)/before.dbBytes,jobsListBytes:Buffer.byteLength(payload),
    health:{requests:health.length,medianMs:health[Math.floor(health.length/2)],p95Ms:health[Math.floor(health.length*.95)],maxMs:health.at(-1)}};
  writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await service.close();}

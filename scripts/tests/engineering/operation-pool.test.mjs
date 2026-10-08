import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { OperationPool } from '../../../src/server/operation-pool.mjs';
const root=mkdtempSync(join(tmpdir(),'vg-worker-pool-')),file=join(root,'worker.mjs');
writeFileSync(file,`import{parentPort}from'node:worker_threads';import{appendFileSync}from'node:fs';
parentPort.on('message',async({id,name,args})=>{
if(name==='hang'){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return;}
if(name==='crash'){appendFileSync(args[0],'commit\\n');process.exit(7);}
if(name==='delay')await new Promise(r=>setTimeout(r,100));
parentPort.postMessage({id,value:args});});`);
test.after(()=>rmSync(root,{recursive:true,force:true}));
test('bounded FIFO rejects overflow; close rejects queued and active calls',async()=>{
  const pool=new OperationPool({size:1,maxQueued:1,workerUrl:pathToFileURL(file)});
  try {
    const first=pool.call('delay',[1]),second=pool.call('echo',[2]);
    await assert.rejects(pool.call('echo',[3]),e=>e.status===503);
    assert.deepEqual(await first,[1]);assert.deepEqual(await second,[2]);
    const active=assert.rejects(pool.call('delay'),/closing/),queued=assert.rejects(pool.call('echo'),/closing/);
    await pool.close();await Promise.all([active,queued]);
  } finally{await pool.close();}
});
test('crashed mutation is never replayed; timed-out workers are replaced',async()=>{
  const pool=new OperationPool({size:1,timeoutMs:1000,workerUrl:pathToFileURL(file)}),log=join(root,'commits');
  try {
    await assert.rejects(pool.call('crash',[log]),/outcome/);
    assert.equal(readFileSync(log,'utf8'),'commit\n');
    await assert.rejects(pool.call('hang'),/timed out/);
    assert.deepEqual(await pool.call('echo',[4]),[4]);
    assert.equal(readFileSync(log,'utf8'),'commit\n');
  } finally{await pool.close();}
});

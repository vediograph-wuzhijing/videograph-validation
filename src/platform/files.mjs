import { renameSync, createReadStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const transient = error => ['EPERM','EBUSY','EACCES'].includes(error.code);
export function renameRetrySync(from,to,attempts=6) {
  for(let i=0;;i++) try{return renameSync(from,to);}catch(error){if(i+1>=attempts||!transient(error))throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50*2**i);}
}
export async function renameRetry(from,to,attempts=6) {
  for(let i=0;;i++) try{return await rename(from,to);}catch(error){if(i+1>=attempts||!transient(error))throw error;await delay(50*2**i);}
}
export async function hashFileAsync(path) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Exercise a copied Windows installation with spaces, using its bundled Node.
// Synthetic input lives outside the installation; never touches daily projects.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { browserPath } from '../src/server/browser.mjs';
import { writeWavMono16 } from '../src/vocal/wav.mjs';
import { freePort } from './tests/helpers/free-port.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const source=resolve(process.argv[2]??join(root,'.cache/releases/VideoGraph-0.2.0-windows-x64-rc2'));
const out=mkdtempSync(join(root,'.cache/release020-package-audit-'));
const zipped=source.endsWith('.zip'),extractRoot=join(out,'Windows extract with spaces');
const install=zipped?join(extractRoot,basename(source,'.zip')):join(out,'Windows install with spaces');
if(zipped)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:VIDEOGRAPH_AUDIT_ZIP, $env:VIDEOGRAPH_AUDIT_EXTRACT)'],{env:{...process.env,VIDEOGRAPH_AUDIT_ZIP:source,VIDEOGRAPH_AUDIT_EXTRACT:extractRoot},windowsHide:true});
const verifiedRoot=zipped?install:source;
const manifest=JSON.parse(readFileSync(join(verifiedRoot,'release-manifest.json'),'utf8'));
for(const entry of manifest.files){
  assert.equal(createHash('sha256').update(readFileSync(join(verifiedRoot,entry.file))).digest('hex'),entry.sha256,entry.file);
  assert.doesNotMatch(entry.file,/\.(?:mp3|wav|flac|mid|midi|mp4|sqlite)$/i);
}
if(!zipped)cpSync(source,install,{recursive:true});
const node=join(install,'runtime/node.exe'),servicePort=await freePort(),studioPort=await freePort();
const env={...process.env};
for(const key of Object.keys(env))if(/^(?:VIDEOGRAPH_|VITE_VIDEOGRAPH_)/.test(key))delete env[key];
writeFileSync(join(install,'workbench.json'),JSON.stringify({servicePort,studioPort,projects:'projects'}));
const base=`http://127.0.0.1:${servicePort}`,origin=`http://127.0.0.1:${studioPort}`;
const run=async(args,timeout=60000)=>(await promisify(execFile)(node,args,{cwd:install,env,windowsHide:true,timeout,maxBuffer:2*1024*1024})).stdout;
const control=async(method='status')=>{
  const state=JSON.parse(readFileSync(join(install,'.cache/workbench.json'),'utf8'));
  const res=await fetch(state.url+'/__workbench/'+method,{method:method==='status'?'GET':'POST',headers:{authorization:`Bearer ${state.controlToken}`}});
  return {status:res.status,body:await res.json()};
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wav=join(out,'synthetic backing.wav'),dry=join(out,'synthetic vocal.wav');
writeWavMono16(wav,new Float32Array(44100*4));
writeWavMono16(dry,Float32Array.from({length:44100*4},(_,i)=>Math.sin(2*Math.PI*440*i/44100)*.1));
let client,browser,started=false;
const uiErrors=[];
try{
  const doctor=JSON.parse(await run(['scripts/workbench.mjs','doctor']));assert.ok(doctor.checks.filter(c=>c.ready!==undefined).every(c=>c.ready));
  assert.match(await run(['scripts/check-docs.mjs']),/local links valid/);
  const boot=JSON.parse(await run(['scripts/workbench.mjs','start']));started=true;
  assert.equal(boot.url,origin);assert.equal(boot.serviceUrl,base);assert.equal(boot.health.diskVersion,'0.2.0');
  const tokenBefore=readFileSync(join(install,'.cache/service-token'),'utf8');
  await assert.rejects(run(['scripts/workbench.mjs','serve']));
  assert.equal(readFileSync(join(install,'.cache/service-token'),'utf8'),tokenBefore);
  assert.equal((await control()).body.pid,boot.pid);
  const html=await(await fetch(origin)).text();assert.ok(html.includes(base));
  const asset=/<script[^>]+src="([^"]+)"/.exec(html)[1];
  assert.match((await fetch(origin+asset)).headers.get('content-type'),/javascript/);
  assert.equal((await fetch(origin+'/audio/pdoom.mp3')).status,404);
  const transport=new StdioClientTransport({command:join(install,'MCP.cmd'),cwd:install,env,stderr:'pipe'});
  client=new Client({name:'release-package-audit',version:'0.2.0'});await client.connect(transport);
  assert.equal(client.getServerVersion().version,'0.2.0');
  assert.equal((await client.listTools()).tools.length,65);
  assert.ok((await client.readResource({uri:'videograph://docs/mcp-guide'})).contents[0].text.includes('65 个工具'));
  const tool=async(name,args={})=>{
    const response=await client.callTool({name,arguments:args},undefined,{timeout:120000});
    assert.ok(!response.isError,response.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
    return {value:JSON.parse(response.content.find(c=>c.type==='text').text),response};
  };
  assert.equal((await tool('service_health_get')).value.pid,boot.pid);
  assert.equal((await tool('scene_component_search',{query:'海'})).response.isError,undefined);
  assert.equal((await tool('effect_search',{kind:'post',query:'print'})).response.isError,undefined);
  const workflow=await tool('craft_guide',{topic:'pv-production'});
  assert.equal(workflow.value.file,'references/pv-production.md');
  const workflowText=workflow.response.content.find(c=>c.type==='text'&&c.text.startsWith('# shotcraft 节选'));
  assert.ok(workflowText&&workflowText.text.length<=12000);
  assert.ok((await client.readResource({uri:'videograph://skills/shotcraft/references/pv-production.md'})).contents[0].text.length>1000);
  assert.ok(client.getInstructions().includes('project_filmstrip'));
  let project=(await tool('project_create_from_audio',{audioPath:wav,name:'Fresh installation test',truth:{rhythm:{bpm:120,beats:[0,.5,1,1.5,2,2.5,3,3.5],downbeats:[0,2],meter:4},sections:[{name:'intro',start:0,end:4}]}})).value;
  assert.equal(project.status,'analysis-draft');
  project=(await tool('song_analysis_confirm',{projectId:project.id,expectedInputRevision:project.revision})).value;
  project=(await tool('project_plan_submit',{projectId:project.id,expectedInputRevision:project.revision,plan:[{t:0,id:'a'},{t:2,id:'b'}]})).value;
  const code=readFileSync(join(install,'engine-base/scenes/_window-template.ts'),'utf8').replace('c.globalAlpha = 1;', 'c.globalAlpha = 1; c.fillStyle = "#ffffff"; c.fillRect(120 + f.t * 360, 480, 120, 120);');
  const checked=await tool('project_draft_check',{projectId:project.id,shotId:'a',expectedProjectRevision:project.revision,code});assert.equal(checked.value.ok,true,JSON.stringify(checked.value));
  const frames=await tool('project_draft_stills',{projectId:project.id,shotId:'a',expectedProjectRevision:project.revision,code,times:[.5,.75]});assert.ok(frames.response.content.some(c=>c.type==='image'));
  project=(await tool('project_scene_module_submit',{projectId:project.id,moduleId:'shared',expectedProjectRevision:project.revision,code,bindings:project.shots.map(s=>({shotId:s.id,expectedInputRevision:s.inputRevision}))})).value;
  let motion=await tool('project_filmstrip',{projectId:project.id,start:1,end:3,sampleFps:6,columns:6,thumbWidth:320,waitSeconds:25});
  for(let i=0;i<6&&motion.value.status!=='done'&&motion.value.status!=='error';i++)motion=await tool('project_job_get',{projectId:project.id,jobId:motion.value.id,waitSeconds:10});
  assert.equal(motion.value.status,'done',motion.value.error);assert.equal(motion.value.result.times.length,12);
  const motionImage=motion.response.content.find(c=>c.type==='image');assert.ok(motionImage);
  writeFileSync(join(out,'motion-filmstrip.png'),Buffer.from(motionImage.data,'base64'));
  const inbox=(await tool('project_feedback_inbox',{projectId:project.id,shotId:'a',status:'open'})).value;
  assert.ok(inbox&&typeof inbox==='object');
  const state=(await tool('project_vocal_import_audio',{projectId:project.id,expectedInputRevision:0,audioPath:dry,referencePath:dry,mix:{processing:{exciter:{amount:.1},doubling:{wet:.1}}}})).value;
  const job=(await tool('project_vocal_render',{projectId:project.id,expectedInputRevision:state.inputRevision})).value;
  assert.equal((await control('stop')).status,409,'busy workbench must refuse stop');
  let done;
  for(let i=0;i<10;i++){done=(await tool('project_job_get',{projectId:project.id,jobId:job.id,waitSeconds:10})).value;if(done.status==='done'||done.status==='error')break;}
  assert.equal(done.status,'done',done.error);assert.ok(done.result.bandReportFile);assert.equal(done.result.pitchReportFile,null);
  browser=await chromium.launch({headless:true,executablePath:browserPath()});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>uiErrors.push(e.message));
  const motionCenters=await page.evaluate(async base64=>{
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
    // 6 columns, 320x180 tiles, 6px gaps, 34px title and 40px labels.
    return Array.from({length:12},(_,i)=>{
      const pixels=ctx.getImageData(6+(i%6)*326,40+Math.floor(i/6)*226+90,320,1).data;
      let weighted=0,count=0;for(let x=16;x<304;x++){const p=x*4;if(pixels[p]>220&&pixels[p+1]>220&&pixels[p+2]>220){weighted+=x;count++;}}
      return count?weighted/count:null;
    });
  },motionImage.data);
  assert.ok(motionCenters.every(Number.isFinite),`moving marker missing: ${motionCenters}`);
  assert.ok(motionCenters.every((x,i)=>i===0||x>motionCenters[i-1]+5),`motion frames out of order: ${motionCenters}`);
  await page.goto(`${origin}/?view=project&project=${project.id}`);
  await page.getByRole('button',{name:'查看 / 修改真实源码'}).waitFor();
  await page.locator('.vocal-panel > summary').click();
  await page.getByRole('button',{name:'采用此混音'}).waitFor();
  assert.deepEqual(uiErrors,[]);
  const tools=JSON.parse(await run(['scripts/workbench.mjs','http-tools','tools']));assert.equal(tools.length,65);
  const report={out,install,version:manifest.version,manifestFiles:manifest.files.length,doctor,customPorts:true,rootOwnership:true,busyStopRefused:true,tools:65,externalTruth:true,bundledEngineDraft:true,sharedSource:true,pvWorkflowResource:true,motionFrames:motion.value.result.times.length,motionCenters,feedbackInbox:true,externalVocal:true,bandReport:true,uiErrors};
  writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
  await browser?.close();await client?.close();
  if(started){let stopped=false;for(let i=0;i<50;i++){const result=await control('stop');if(result.status===200){stopped=true;break;}await sleep(100);}assert.ok(stopped,'owned installation did not become idle');for(let i=0;i<50&&existsSync(join(install,'.cache/workbench.json'));i++)await sleep(100);assert.equal(existsSync(join(install,'.cache/workbench.json')),false);}
}

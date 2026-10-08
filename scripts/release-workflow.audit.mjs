// Real-engine isolated audit: external truth, draft compile, temporary frames,
// continuous preview and atomic shared-module publication. No user project writes.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeWavMono16 } from '../src/vocal/wav.mjs';
const product=fileURLToPath(new URL('..',import.meta.url)),root=mkdtempSync(join(product,'.cache','release020-workflow-'));
process.env.VIDEOGRAPH_PROJECTS=join(root,'projects');
const store=await import('../src/server/project-store.mjs'),song=await import('../src/server/song-project.mjs');
const drafts=await import('../src/server/scene-drafts.mjs');
const file=join(root,'audio.wav');writeWavMono16(file,new Float32Array(44100*8),44100);
const truth={rhythm:{bpm:120,beats:Array.from({length:16},(_,i)=>i*.5),downbeats:[0,2,4,6],meter:4},sections:[{name:'verse',start:0,end:4},{name:'chorus',start:4,end:8}],lyrics:{language:'ja',lines:[{text:'あい',start:1,end:2,words:[{w:'あ',start:1,end:1.5},{w:'い',start:1.5,end:2}]}]}};
let project=store.createProjectFromAudio(file,'Release workflow fixture',{truth,author:'mcp'});
assert.equal(project.status,'analysis-draft');assert.equal(project.analysis.source,'external-truth');assert.deepEqual(project.analysis.neutralLayers,['envelopes','onsets']);assert.equal(store.listJobs(project.id).length,0);
project=song.confirmSongAnalysis(project.id,'mcp',project.revision);
project=song.submitPlan(project.id,project.revision,[{t:0,id:'verse'},{t:4,id:'chorus'}],'isolation audit');
const template=readFileSync(join(product,'engine-base/scenes/_window-template.ts'),'utf8');
const opts={shotId:'verse',expectedProjectRevision:project.revision,code:template};
const start=performance.now(),check=await drafts.checkSceneDraft(project.id,opts);
writeFileSync(join(root,'check.json'),JSON.stringify(check,null,2));assert.equal(check.ok,true,JSON.stringify(check));
const bad=template.replace("Layer2D, W, H, clearRT","Layer2D, W, H, clearRT, FSPass").replace('private ui = new Layer2D();',"private ui = new Layer2D(); private bad = new FSPass('void main(){fragColor=invalidName;}');");
const shader=await drafts.checkSceneDraft(project.id,{...opts,code:bad});assert.equal(shader.ok,false);assert.ok(shader.shaders.errors.length);
const syntax=await drafts.checkSceneDraft(project.id,{...opts,code:template+'\nconst invalid:number="wrong";'});assert.equal(syntax.ok,false);assert.ok(syntax.diagnostics.length);
const frames=await drafts.sampleSceneDraft(project.id,{...opts,times:[1,1.2,1.4]});writeFileSync(join(root,'draft.png'),Buffer.from(frames.image.base64,'base64'));
const componentCode=`import type * as THREE from 'three';
import {Scene,type Frame} from '../engine/scene';
import {Layer2D} from '../engine/gl';
import {environment,ENVIRONMENTS} from '../components/environment';
import {LayerStack} from '../components/layers';
import {textMotion,graphemes} from '../components/text-motion';
import {worldCamera,projectWorld} from '../components/world';
import {Vector3} from 'three';
export default class Components extends Scene {
 private worlds=ENVIRONMENTS.map(kind=>environment(kind)); private stack=new LayerStack(this.ctx.comp); private background=this.stack.add('world');private labels=this.stack.add('text');private ui=new Layer2D();
 render(f:Frame,out:THREE.WebGLRenderTarget){
  this.stack.clear(this.ctx.renderer);this.worlds[Math.floor(f.t)%3]!.render(this.ctx.renderer,this.background.target,f.t);
  const camera=worldCamera({position:[0,0,5],target:[0,0,0],drift:.02},f.t);if(!projectWorld(new Vector3(),camera))throw new Error('projection failed');
  this.ui.clear('transparent');const c=this.ui.ctx;c.font='60px sans-serif';c.fillStyle='white';graphemes('VideoGraph').forEach((letter,i)=>{const state=textMotion(f.t,0,4,i,10);c.globalAlpha=state.opacity;c.fillText(letter,400+i*60+state.x,540+state.y);});
  this.ctx.comp.draw(this.ctx.renderer,this.ui.upload(),this.labels.target,{mode:'replace'});this.stack.compose(this.ctx.renderer,out);return {hud:0};
 }
 dispose(){this.worlds.forEach(w=>w.dispose());this.stack.dispose();this.ui.texture.dispose();}
}`;
const components=await drafts.checkSceneDraft(project.id,{...opts,code:componentCode});assert.equal(components.ok,true,JSON.stringify(components));
const environments=await drafts.sampleSceneDraft(project.id,{...opts,code:componentCode,times:[.7,1.7,2.7]});writeFileSync(join(root,'components.png'),Buffer.from(environments.image.base64,'base64'));
assert.equal(store.readProject(project.id).revision,project.revision);assert.equal(store.listJobs(project.id).length,0);
project=store.submitSceneModule(project.id,'song-world',project.revision,template,project.shots.map(s=>({shotId:s.id,expectedInputRevision:s.inputRevision})), 'workflow audit','human');
assert.equal(new Set(project.shots.map(s=>s.module)).size,1);
const report={projectId:project.id,root,externalTruth:true,noDraftJobsOrRevisions:true,validShaderGroups:check.shaders.compiled,componentShaderGroups:components.shaders.compiled,environmentsRendered:3,layerComposition:true,worldProjection:true,invalidShaderDetected:true,typeErrorDetected:true,draftFrames:3,sharedShots:project.shots.length,elapsedMs:performance.now()-start};
writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));

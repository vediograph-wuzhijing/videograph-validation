import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureProject, fixtureScene } from '../feedback/helpers.mjs';
const root = mkdtempSync(join(tmpdir(), 'vg-scene-module-'));
process.env.VIDEOGRAPH_PROJECTS = join(root, 'projects');
const repo = await import('../../../src/server/project-repository.mjs');
const { submitSceneModule, submitShotSource, updateShot } = await import('../../../src/server/project-store.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('39 shot bindings publish one source and one revision; locks/conflicts roll back the whole batch', () => {
  const id = createFixtureProject(repo.projectsRoot);
  const before = repo.mutateProject(id, 0, p => ({ ...p, transitions: [], shots: Array.from({length:39}, (_, i) => ({...p.shots[0], id:`s${i}`, start:i*8, end:(i+1)*8})) }));
  const bindings = before.shots.map(s => ({shotId:s.id, expectedInputRevision:s.inputRevision, params:{index:s.id}}));
  const after = submitSceneModule(id, 'world', before.revision, fixtureScene(72), bindings);
  assert.equal(after.revision, before.revision+1);
  assert.equal(new Set(after.shots.map(s=>s.module)).size,1);
  assert.equal(readdirSync(join(repo.projectDir(id),'engine/app/src/scenes')).filter(f=>f.startsWith('vg-')).length,1);
  assert.ok(after.shots.every(s=>s.inputRevision===1 && s.sceneModuleId==='world' && s.sceneModuleRevision===1));
  const next = after.shots.map(s=>({shotId:s.id,expectedInputRevision:s.inputRevision}));
  assert.throws(()=>submitSceneModule(id,'world',after.revision,fixtureScene(80),next.slice(1)),e=>e.status===409);
  assert.throws(()=>submitSceneModule(id,'world',before.revision,fixtureScene(80),next),e=>e.status===409);
  const locked = updateShot(id,'s0',1,{locked:true},undefined,'human');
  assert.throws(()=>submitSceneModule(id,'world',locked.revision,fixtureScene(80),next),/锁定/);
  assert.equal(repo.readProject(id).revision,locked.revision);
  assert.equal(repo.readProject(id).shots[1].codeHash,after.shots[1].codeHash);
  const detached = submitShotSource(id,'s1',1,fixtureScene(88),'',[],'human');
  assert.equal(detached.shots[1].sceneModuleId,undefined);
});

test('shared publication requires each director lease and returns all commit receipts atomically', () => {
  const id = createFixtureProject(repo.projectsRoot);
  const current = repo.mutateProject(id,0,p=>({...p,director:{version:1,appliedShots:{},operations:Object.fromEntries(p.shots.map(s=>[s.id,{status:'claimed',leaseExpiresAt:Date.now()+60000,directorVersion:1,targetId:s.id,targetKind:'shot',kind:'generate',targetToken:s.inputToken,attemptToken:`lease-${s.id}`}]))}}));
  const bindings = current.shots.map(s=>({shotId:s.id,expectedInputRevision:s.inputRevision,attemptToken:`lease-${s.id}`}));
  const incomplete = structuredClone(bindings);delete incomplete[1].attemptToken;
  assert.throws(()=>submitSceneModule(id,'managed',current.revision,fixtureScene(44),incomplete),e=>e.status===409);
  assert.equal(repo.readProject(id).revision,current.revision);
  const done=submitSceneModule(id,'managed',current.revision,fixtureScene(44),bindings);
  assert.equal(done.revision,current.revision+1);
  for(const shot of done.shots)assert.equal(done.director.operations[shot.id].receipt.inputToken,shot.inputToken);
});

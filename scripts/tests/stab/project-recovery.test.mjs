import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createFixtureProject } from '../feedback/helpers.mjs';
import { stageGeneration, projectAnalysisFile, projectDataRoot, projectManifestFile } from '../../../src/server/project-generation.mjs';
import { startReferenceServer } from '../../../src/server/reference-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'videograph-recovery-'));
process.env.VIDEOGRAPH_PROJECTS = join(root, 'projects');
const repo = await import('../../../src/server/project-repository.mjs');
const { backupProject, restoreProject, inspectProjectStorage } = await import('../../../src/server/project-backup.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));
function contents(id, version) {
  const manifest = JSON.parse(readFileSync(join(repo.projectDir(id), 'engine-manifest.json')));
  const audio = JSON.stringify({ version }), lyrics = JSON.stringify({ version, lines: [] });
  manifest.files.push(['data/audio.json', repo.sha256(audio)], ['data/lyrics.json', repo.sha256(lyrics)]);
  return { 'analysis-v2.json': JSON.stringify({ version }), 'data/audio.json': audio, 'data/lyrics.json': lyrics, 'engine-manifest.json': JSON.stringify(manifest) };
}
function publish(id, version, options) {
  return repo.mutateProject(id, undefined, (p) => ({ ...p, analysisGeneration: stageGeneration(repo.projectDir(id), contents(id, version), options) }));
}
test('每个文件/发布边界失败，SQLite保持完整旧版本；完整新版本可重试发布', () => {
  const id = createFixtureProject(repo.projectsRoot), old = publish(id, 'old'), dir = repo.projectDir(id);
  for (const point of ['file:analysis-v2.json', 'file:data/audio.json', 'file:data/lyrics.json', 'file:engine-manifest.json', 'before-publish', 'after-publish']) {
    assert.throws(() => publish(id, point, { checkpoint(at) { if (at === point) throw new Error('injected'); } }), /injected/);
    const active = repo.readProject(id);
    assert.equal(active.revision, old.revision);
    assert.equal(active.analysisGeneration, old.analysisGeneration);
    assert.equal(JSON.parse(readFileSync(projectAnalysisFile(dir, active))).version, 'old');
  }
  const next = publish(id, 'after-publish');
  assert.equal(JSON.parse(readFileSync(projectAnalysisFile(dir, next))).version, 'after-publish');
  assert.equal(JSON.parse(readFileSync(join(projectDataRoot(dir, old), 'audio.json'))).version, 'old');
});
test('子进程在提交前退出保持旧版本，提交后退出保留完整新版本', () => {
  const id = createFixtureProject(repo.projectsRoot), old = publish(id, 'old');
  for (const point of ['file:data/audio.json', 'after-publish']) {
    const program = `import {mutateProject,projectDir} from ${JSON.stringify(new URL('../../../src/server/project-repository.mjs', import.meta.url).href)};
      import {stageGeneration} from ${JSON.stringify(new URL('../../../src/server/project-generation.mjs', import.meta.url).href)};
      mutateProject(${JSON.stringify(id)},undefined,p=>({...p,analysisGeneration:stageGeneration(projectDir(p.id),${JSON.stringify(contents(id, point))},{checkpoint(at){if(at===${JSON.stringify(point)})process.exit(73)}})}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { env: process.env, windowsHide: true });
    assert.equal(result.status, 73, result.stderr.toString());
    assert.equal(repo.readProject(id).analysisGeneration, old.analysisGeneration);
    assert.equal(repo.readProject(id).revision, old.revision);
  }
  const report = inspectProjectStorage(id);
  assert.equal(report.valid, true);
  assert.equal(report.activeGeneration, old.analysisGeneration);
  assert.equal(report.stagingDirectories.length, 1);
  const committed = `import {mutateProject,projectDir} from ${JSON.stringify(new URL('../../../src/server/project-repository.mjs', import.meta.url).href)};
    import {stageGeneration} from ${JSON.stringify(new URL('../../../src/server/project-generation.mjs', import.meta.url).href)};
    mutateProject(${JSON.stringify(id)},undefined,p=>({...p,analysisGeneration:stageGeneration(projectDir(p.id),${JSON.stringify(contents(id, 'committed'))})})); process.exit(73);`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', committed], { env: process.env, windowsHide: true }).status, 73);
  const current = repo.readProject(id);
  assert.equal(current.revision, old.revision + 1);
  assert.equal(JSON.parse(readFileSync(projectAnalysisFile(repo.projectDir(id), current))).version, 'committed');
});
test('缺失或已损坏的generation无法成为活动指针', () => {
  const id = createFixtureProject(repo.projectsRoot), old = publish(id, 'old'), dir = repo.projectDir(id);
  assert.throws(() => repo.mutateProject(id, old.revision, (p) => ({ ...p, analysisGeneration: 'a'.repeat(64) })));
  const generation = stageGeneration(dir, contents(id, 'new'));
  writeFileSync(projectAnalysisFile(dir, { analysisGeneration: generation }), '{}');
  assert.throws(() => repo.mutateProject(id, old.revision, (p) => ({ ...p, analysisGeneration: generation })), /corrupt/);
  assert.equal(repo.readProject(id).revision, old.revision);
});
test('旧工程继续读取传统manifest/data路径', () => {
  const id = createFixtureProject(repo.projectsRoot), p = repo.readProject(id), dir = repo.projectDir(id);
  assert.equal(projectManifestFile(dir, p), join(dir, 'engine-manifest.json'));
  assert.equal(projectDataRoot(dir, p), join(dir, 'engine/data'));
});
test('预览读取发布的数据版本，冻结预览不会被后续更新改变', async () => {
  const id = createFixtureProject(repo.projectsRoot), old = publish(id, 'old'), dir = repo.projectDir(id);
  let a, b;
  try {
    a = await startReferenceServer({ root: join(dir, 'engine'), dataRoot: projectDataRoot(dir, old) });
    const next = publish(id, 'new');
    b = await startReferenceServer({ root: join(dir, 'engine'), dataRoot: projectDataRoot(dir, next) });
    assert.equal((await (await fetch(a.url + '/data/audio.json')).json()).version, 'old');
    assert.equal((await (await fetch(b.url + '/data/audio.json')).json()).version, 'new');
  } finally { await a?.close(); await b?.close(); }
});
test('一致快照备份/恢复保留历史和分析，变更身份并中断旧任务', () => {
  const id = createFixtureProject(repo.projectsRoot), old = publish(id, 'old'); publish(id, 'new');
  const media = Buffer.alloc(3 * 1024 * 1024 + 73, 0x7f);
  writeFileSync(join(repo.projectDir(id), 'artifacts/media.bin'), media);
  repo.saveJob(id, { id: 'pending', kind: 'render', status: 'running', projectId: id, input: { project: old } });
  // A live WAL writer has uncommitted edits; VACUUM INTO must capture committed state.
  const writer = new DatabaseSync(join(repo.projectDir(id), 'project.sqlite'));
  writer.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
  const uncommitted = repo.readProject(id); uncommitted.name = 'not committed';
  writer.prepare('UPDATE project SET data=? WHERE id=1').run(JSON.stringify(uncommitted));
  let snapshot;
  try { snapshot = backupProject(id, join(root, 'backup')); } finally { writer.exec('ROLLBACK'); writer.close(); }
  assert.equal(snapshot.revision, 2);
  const restored = restoreProject(snapshot.destination, { id: 'restored' });
  const p = repo.readProject(restored.projectId), dir = repo.projectDir(p.id);
  assert.equal(p.revision, 2); assert.equal(p.restoredFrom.projectId, id);
  assert.notEqual(p.name, 'not committed');
  assert.equal(JSON.parse(readFileSync(projectAnalysisFile(dir, p))).version, 'new');
  assert.equal(JSON.parse(readFileSync(projectAnalysisFile(dir, old))).version, 'old');
  assert.equal(repo.readJob(p.id, 'pending').status, 'interrupted');
  assert.equal(repo.readJob(p.id, 'pending').input.project.id, p.id);
  assert.equal(repo.readJob(id, 'pending').status, 'running');
  assert.equal(repo.sha256(readFileSync(join(dir, 'artifacts/media.bin'))), repo.sha256(media));
  assert.throws(() => restoreProject(snapshot.destination, { id }), /已存在/);
  assert.throws(() => backupProject(id, snapshot.destination), /已存在/);
  assert.throws(() => backupProject(id, join(repo.projectDir(id), 'backup')), /工程内部/);
});
test('校验失败或恶意路径的备份不会发布工程', () => {
  const id = createFixtureProject(repo.projectsRoot); publish(id, 'new');
  const { destination } = backupProject(id, join(root, 'bad-backup'));
  const file = join(destination, 'backup.json'), manifest = JSON.parse(readFileSync(file));
  const original = readFileSync(join(destination, manifest.files[0][0]));
  writeFileSync(join(destination, manifest.files[0][0]), 'corrupt');
  assert.throws(() => restoreProject(destination, { id: 'bad-hash' }), /校验失败/);
  assert.equal(existsSync(join(repo.projectsRoot, 'bad-hash')), false);
  writeFileSync(join(destination, manifest.files[0][0]), original);
  manifest.files.unshift(['../escape', '0'.repeat(64)]); writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => restoreProject(destination, { id: 'bad-path' }), /非法路径/);
  assert.equal(existsSync(join(repo.projectsRoot, 'bad-path')), false);
  assert.ok(readdirSync(repo.projectsRoot).includes(id));
});

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, copyFileSync, constants, renameSync, existsSync, rmSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectDir, projectsRoot, safeId, decodeProjectRecord, encodeProjectRecord } from './project-repository.mjs';
import { decodeJobRecord, encodeJobRecord } from './job-records.mjs';
import { verifyGeneration, projectManifestFile, projectEngineFile } from './project-generation.mjs';
import { ProjectError } from './errors.mjs';
import { hashFile } from './file-hash.mjs';

function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new ProjectError('备份不接受符号链接');
    const path = prefix + entry.name;
    return entry.isDirectory() ? files(join(dir, entry.name), path + '/') : [path];
  }).sort();
}
function checkSnapshot(dir) {
  const db = new DatabaseSync(join(dir, 'project.sqlite'), { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new ProjectError('备份数据库校验失败');
    const cache = new Map();
    const project = decodeProjectRecord(dir, JSON.parse(db.prepare('SELECT data FROM project WHERE id=1').get().data), cache);
    verifyGeneration(dir, project);
    for (const row of db.prepare('SELECT data FROM revisions').iterate()) verifyGeneration(dir, decodeProjectRecord(dir, JSON.parse(row.data), cache));
    for (const row of db.prepare('SELECT data FROM jobs').iterate()) {
      const frozen = decodeJobRecord(dir, JSON.parse(row.data), undefined, cache).input?.project;
      if (frozen) verifyGeneration(dir, frozen);
    }
    const manifest = JSON.parse(readFileSync(projectManifestFile(dir, project), 'utf8'));
    for (const [file, hash] of manifest.files) {
      if (hashFile(projectEngineFile(dir, project, file)) !== hash) throw new ProjectError(`备份引擎文件不完整：${file}`);
    }
    for (const shot of project.shots ?? []) if (shot.codeHash) {
      if (!/^[a-zA-Z0-9_-]+$/.test(shot.module) || hashFile(join(dir, 'engine/app/src/scenes', `${shot.module}.ts`)) !== shot.codeHash) throw new ProjectError(`镜头源码损坏：${shot.id}`);
    }
    if (project.vocal?.active && hashFile(join(dir, 'engine/audio', `vocal-${project.vocal.active.mixHash}.wav`)) !== project.vocal.active.mixHash) throw new ProjectError('已采用歌声损坏');
    return project;
  } finally { db.close(); }
}
/** Diagnostics only: staging may belong to a running publisher; never delete it here. */
export function inspectProjectStorage(id) {
  const dir = projectDir(id), project = checkSnapshot(dir);
  const root = join(dir, 'generations'), entries = existsSync(root) ? readdirSync(root) : [];
  return { projectId: id, revision: project.revision, valid: true, activeGeneration: project.analysisGeneration ?? null,
    completedGenerations: entries.filter((name) => /^[a-f0-9]{64}$/.test(name)).length,
    stagingDirectories: entries.filter((name) => name.startsWith('.staging-')),
    note: 'staging不参与读取；可能来自运行中或中断的发布，确认没有写入者后才能清理。历史/冻结任务仍可引用旧generation。' };
}
export function backupProject(id, destination) {
  const dir = projectDir(id), target = resolve(destination);
  const rel = relative(dir, target);
  if (!rel || (!isAbsolute(rel) && !rel.startsWith('..'))) throw new ProjectError('备份目标不能位于工程内部');
  if (existsSync(target)) throw new ProjectError('备份目标已存在，不能覆盖', 409);
  const staging = `${target}.staging-${randomUUID()}`;
  mkdirSync(staging, { recursive: true });
  try {
    const db = new DatabaseSync(join(dir, 'project.sqlite'));
    try { db.exec('PRAGMA busy_timeout=5000'); db.prepare('VACUUM INTO ?').run(join(staging, 'project.sqlite')); }
    finally { db.close(); }
    // SQLite snapshot first; all referenced immutable files existed before its publication.
    // Exclude caches and task scratch; preserve original media, history generations and outputs.
    files(dir); // Reject symlinks before recursive copying.
    cpSync(dir, staging, { recursive: true, filter: (source) => {
      const path = relative(dir, source).replaceAll('\\', '/');
      return !/^project\.sqlite(?:-wal|-shm|-journal)?$/.test(path) && !/^(\.vocal-cache|\.vocal-work)(\/|$)/.test(path) && !/(^|\/)\.staging-/.test(path);
    } });
    const project = checkSnapshot(staging);
    const index = files(staging).map((name) => [name, hashFile(join(staging, name))]);
    writeFileSync(join(staging, 'backup.json'), JSON.stringify({ schema: 'videograph-backup/v1', projectId: id, revision: project.revision, files: index }, null, 2));
    renameSync(staging, target);
    return { projectId: id, revision: project.revision, destination: target, files: index.length };
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}
export function restoreProject(source, { id = randomUUID() } = {}) {
  if (!safeId(id)) throw new ProjectError('invalid restore project id');
  const backup = resolve(source), manifest = JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8'));
  if (manifest.schema !== 'videograph-backup/v1' || !Array.isArray(manifest.files) || !manifest.files.length) throw new ProjectError('无效备份清单');
  const target = join(projectsRoot, id);
  if (existsSync(target)) throw new ProjectError('恢复目标已存在，不能覆盖', 409);
  files(backup);
  const staging = join(projectsRoot, `.restore-${randomUUID()}`); mkdirSync(staging, { recursive: true });
  try {
    for (const [path, expected] of manifest.files) {
      if (typeof path !== 'string' || !path || path.split('/').some((part) => !part || part === '.' || part === '..') || path.includes('\\') || isAbsolute(path) || path.includes(':') || !/^[a-f0-9]{64}$/.test(expected)) throw new ProjectError('备份包含非法路径或校验值');
      const output = join(staging, path), parent = resolve(output, '..'); mkdirSync(parent, { recursive: true });
      copyFileSync(join(backup, path), output, constants.COPYFILE_EXCL);
      if (hashFile(output) !== expected) throw new ProjectError(`备份文件校验失败：${path}`);
    }
    const original = checkSnapshot(staging);
    if (original.id !== manifest.projectId || original.revision !== manifest.revision) throw new ProjectError('备份身份与数据库不一致');
    const db = new DatabaseSync(join(staging, 'project.sqlite'));
    try {
      db.exec('BEGIN IMMEDIATE');
      const transform = (p) => {
        p.id = id;
        if (p.status === 'analysis-pending') { p.status = 'analysis-failed'; p.analysis = { ...p.analysis, error: '工程已从备份恢复，请明确重试分析' }; }
        return p;
      };
      const project = transform(decodeProjectRecord(staging, JSON.parse(db.prepare('SELECT data FROM project WHERE id=1').get().data)));
      project.restoredFrom = { projectId: manifest.projectId, revision: manifest.revision, restoredAt: Date.now() };
      db.prepare('UPDATE project SET data=? WHERE id=1').run(JSON.stringify(project));
      for (const row of db.prepare('SELECT revision,data FROM revisions').iterate()) {
        const restored = { ...decodeProjectRecord(staging, JSON.parse(row.data)), id };
        db.prepare('UPDATE revisions SET data=? WHERE revision=?').run(JSON.stringify(encodeProjectRecord(staging, restored)), row.revision);
      }
      const hasSummary = db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'summary');
      for (const row of db.prepare('SELECT id,data FROM jobs').iterate()) {
        const job = decodeJobRecord(staging, JSON.parse(row.data)); job.projectId = id; if (job.input?.project) job.input.project.id = id;
        if (['queued', 'running'].includes(job.status)) { job.status = 'interrupted'; job.error = '从备份恢复；旧任务不会自动重跑'; }
        const record = hasSummary ? encodeJobRecord(staging, job) : job;
        db.prepare(`UPDATE jobs SET status=?,data=?${hasSummary ? ',summary=NULL' : ''} WHERE id=?`).run(job.status, JSON.stringify(record), row.id);
      }
      db.exec('COMMIT');
    } finally { db.close(); }
    renameSync(staging, target);
    return { projectId: id, restoredFrom: manifest.projectId, revision: manifest.revision };
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}

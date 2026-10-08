// Persistence boundary: project identity, SQLite transactions/history and job records.
// Domain commands depend on this module; it never imports song/director/HTTP orchestration.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectError } from './errors.mjs';
import { normalizeProject } from './transitions.mjs';
import { verifyGeneration } from './project-generation.mjs';
import { encodeSnapshot, decodeSnapshot } from './record-objects.mjs';
import { encodeJobRecord, decodeJobRecord, jobSummary } from './job-records.mjs';

export const productRoot = fileURLToPath(new URL('../..', import.meta.url));
export const projectsRoot = resolve(process.env.VIDEOGRAPH_PROJECTS ?? join(productRoot, 'projects'));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(value);
export function projectDir(id) {
  if (!safeId(id)) throw new ProjectError('invalid project id');
  const dir = join(projectsRoot, id);
  if (!existsSync(join(dir, 'project.sqlite'))) throw new ProjectError('project not found', 404);
  return dir;
}
// Old running services may spawn an updated worker from disk. Until a 0.2 host
// explicitly opts in, IPC workers keep the old format so that host stays usable.
export const compactStorage = () => !process.connected || process.env.VIDEOGRAPH_STORAGE_FORMAT === '2';
export function ensureStorageSchema(db) {
  if (!compactStorage()) return;
  db.exec('PRAGMA journal_mode=WAL;');
  // Startup migration and HTTP workers may first open the same legacy database
  // concurrently. Serialize discovery together with ALTER TABLE.
  db.exec('BEGIN IMMEDIATE');
  try {
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'summary')) db.exec('ALTER TABLE jobs ADD COLUMN summary TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS jobs_updated_id ON jobs(updated_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS jobs_status_updated ON jobs(status,updated_at);
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
    INSERT OR IGNORE INTO metadata VALUES('jobsVersion',0);
    PRAGMA user_version=2; COMMIT;`);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function assertStorageWritable(db) {
  const lease = db.prepare("SELECT value FROM metadata WHERE key='storageMaintenanceUntil'").get();
  if (lease && lease.value > Date.now()) throw new ProjectError('工程正在清理存储，请稍后重新读取再操作', 503);
}
function open(id, write = false) { const db = new DatabaseSync(join(projectDir(id), 'project.sqlite')); db.exec('PRAGMA busy_timeout=5000;'); if (write) ensureStorageSchema(db); return db; }
function parse(row) { return row ? JSON.parse(row.data) : null; }
export function decodeProjectRecord(dir, value, cache) { return normalizeProject(decodeSnapshot(dir, value, cache)); }
export function encodeProjectRecord(dir, value) { return compactStorage() ? encodeSnapshot(dir, value) : value; }

export function readProject(id) {
  const db = open(id);
  try { return decodeProjectRecord(projectDir(id), parse(db.prepare('SELECT data FROM project WHERE id=1').get())); }
  finally { db.close(); }
}
/** 单个工程读不出来（半建好、库损坏）时跳过，不能让列表与后台轮询整体失败。 */
export function listProjects() {
  if (!existsSync(projectsRoot)) return [];
  return readdirSync(projectsRoot).filter((id) => safeId(id) && existsSync(join(projectsRoot, id, 'project.sqlite')))
    .flatMap((id) => {
      let p;
      try { p = readProject(id); } catch (error) { console.error(`[工程] 跳过无法读取的 ${id}：${error.message}`); return []; }
      return [{ id, name: p.name, revision: p.revision, createdAt: p.createdAt, updatedAt: p.updatedAt ?? p.createdAt, shots: p.shots.length, duration: p.song?.duration ?? null, status: p.status ?? 'normal',
        audio: { name: p.audio?.name ?? null, hash: p.audio?.hash?.slice(0, 12) ?? null }, audioHash: p.audio?.hash ?? null }];
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
const KEEP_REVISIONS = 200;
export function mutateProject(id, expectedRevision, mutate) {
  const db = open(id, true);
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    begun = true;
    if (compactStorage()) assertStorageWritable(db);
    const current = decodeProjectRecord(projectDir(id), parse(db.prepare('SELECT data FROM project WHERE id=1').get()));
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new ProjectError('工程已更新，请重新读取后再操作', 409);
    const next = normalizeProject(mutate(structuredClone(current)));
    if (next.analysisGeneration !== current.analysisGeneration) verifyGeneration(projectDir(id), next);
    next.revision = current.revision + 1;
    next.updatedAt = Date.now();
    const data = JSON.stringify(next), revisionData = JSON.stringify(encodeProjectRecord(projectDir(id), next));
    db.prepare('UPDATE project SET data=? WHERE id=1').run(data);
    db.prepare('INSERT INTO revisions(revision,data,created_at) VALUES(?,?,?)').run(next.revision, revisionData, next.updatedAt);
    // Compact roots share unchanged fragments. Keep a bounded, recoverable history.
    db.prepare('DELETE FROM revisions WHERE revision > 0 AND revision <= ?').run(next.revision - KEEP_REVISIONS);
    db.exec('COMMIT');
    return next;
  } catch (error) {
    if (begun) { try { db.exec('ROLLBACK'); } catch { /* 保留原始错误 */ } }
    throw error;
  }
  finally { db.close(); }
}

export const SCHEMA_VERSION = 2;
/** 新工程库：project 单行 + revisions 历史 + jobs；user_version 供以后迁移判断。 */
export function initProjectDb(file, project) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS project(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(revision INTEGER PRIMARY KEY,data TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL);
      PRAGMA user_version=1;`);
    ensureStorageSchema(db);
    db.prepare('INSERT INTO project VALUES(1,?)').run(JSON.stringify(project));
    db.prepare('INSERT INTO revisions VALUES(0,?,?)').run(JSON.stringify(encodeProjectRecord(resolve(file, '..'), project)), project.createdAt);
  } finally { db.close(); }
}

export function hashTree(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const key = prefix + entry.name;
    return entry.isDirectory() ? hashTree(join(dir, entry.name), key + '/') : [[key, sha256(readFileSync(join(dir, entry.name)))]];
  });
}

export function saveJob(id, job, { onlyUnfinished = false } = {}) {
  const db = open(id, true);
  try {
    if (!compactStorage()) db.prepare('INSERT INTO jobs(id,kind,status,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at')
      .run(job.id, job.kind, job.status, JSON.stringify(job), Date.now());
    else {
      const record = encodeJobRecord(projectDir(id), job);
      db.exec('BEGIN IMMEDIATE');
      try {
        assertStorageWritable(db);
        db.prepare(`INSERT INTO jobs(id,kind,status,data,summary,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,summary=excluded.summary,updated_at=excluded.updated_at ${onlyUnfinished ? "WHERE jobs.status IN ('queued','running')" : ''}`)
          .run(job.id, job.kind, job.status, JSON.stringify(record), JSON.stringify(jobSummary(record)), Date.now());
        db.exec("UPDATE metadata SET value=value+1 WHERE key='jobsVersion'; COMMIT");
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  finally { db.close(); }
}
export const saveUnfinishedJob = (id,job) => saveJob(id,job,{onlyUnfinished:true});
export function listJobs(id, limit = 40) {
  const db = open(id);
  try {
    const summaries = db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'summary');
    return db.prepare(`SELECT ${summaries ? 'coalesce(summary,data)' : 'data'} AS data FROM jobs ORDER BY updated_at DESC,id DESC LIMIT ?`)
      .all(Math.min(10000, Math.max(1, limit))).map(row => jobSummary(parse(row)));
  }
  finally { db.close(); }
}
/** 服务重启时恢复用：只取未结束的任务，按创建先后排序。 */
export function listUnfinishedJobs(id) {
  const db = open(id);
  try { return db.prepare("SELECT data FROM jobs WHERE status IN ('queued','running')").all().map(parse).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)); }
  finally { db.close(); }
}
export function readJob(id, jobId, options) {
  const db = open(id);
  try { const job = parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(jobId)); if (!job) throw new ProjectError('job not found', 404); return decodeJobRecord(projectDir(id), job, options); }
  finally { db.close(); }
}
export const readJobMetadata = (id, jobId) => readJob(id, jobId, { input: false, result: false });
/** Worker progress cannot replace the frozen input. Reuse its committed object
 * references instead of traversing and hashing the whole song on every tick. */
export function saveJobProgress(id, job) {
  if(!compactStorage()) return saveJob(id,job);
  const previous=readJobMetadata(id,job.id);
  if (['done','error','cancelled','interrupted'].includes(previous.status)) return;
  if(!previous._recordRefs?.input) return saveJob(id,job);
  const {input,_recordRefs,_resultSummary,...patch}=job;
  return saveJob(id,{...previous,...patch,_recordRefs:previous._recordRefs,
    ...(patch.result!==undefined?{_resultSummary:_resultSummary===true}:{})},{onlyUnfinished:true});
}
export function listJobsPage(id, { limit = 40, cursor } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProjectError('limit 必须是 1..100');
  let after;
  if (cursor) {
    try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new ProjectError('invalid job cursor'); }
    if (!Number.isSafeInteger(after.time) || !safeId(after.id)) throw new ProjectError('invalid job cursor');
  }
  const db = open(id);
  try {
    const summaries = db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'summary');
    const rows = db.prepare(`SELECT id,updated_at,${summaries ? 'coalesce(summary,data)' : 'data'} AS data FROM jobs
      ${after ? 'WHERE updated_at < ? OR (updated_at = ? AND id < ?)' : ''} ORDER BY updated_at DESC,id DESC LIMIT ?`)
      .all(...(after ? [after.time, after.time, after.id] : []), limit + 1);
    const last = rows[Math.min(limit, rows.length) - 1];
    return { jobs: rows.slice(0, limit).map(row => jobSummary(parse(row))),
      nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ time: last.updated_at, id: last.id })).toString('base64url') : null };
  } finally { db.close(); }
}
export function projectVersion(id) {
  const db = open(id);
  try {
    const p = db.prepare(`SELECT coalesce(json_extract(data,'$.revision'),json_extract(data,'$.value.revision')) AS revision,
      coalesce(json_extract(data,'$.status'),json_extract(data,'$.value.status'),'normal') AS status FROM project WHERE id=1`).get();
    const hasMetadata = db.prepare("SELECT 1 FROM sqlite_master WHERE name='metadata'").get();
    return { projectId: id, revision: p.revision, status: p.status ?? 'normal',
      jobsVersion: hasMetadata ? db.prepare("SELECT value FROM metadata WHERE key='jobsVersion'").get()?.value ?? 0
        : db.prepare('SELECT coalesce(max(updated_at),0) AS version FROM jobs').get().version };
  } finally { db.close(); }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createFixtureProject } from '../feedback/helpers.mjs';
import { encodeSnapshot, decodeSnapshot } from '../../../src/server/record-objects.mjs';

const root = mkdtempSync(join(tmpdir(), 'vg-storage-records-'));
process.env.VIDEOGRAPH_PROJECTS = join(root, 'projects');
const repo = await import('../../../src/server/project-repository.mjs');
const { migrateProjectStorage } = await import('../../../src/server/storage-maintenance.mjs');
const { retainProjectStorage } = await import('../../../src/server/storage-retention.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('large immutable input is shared; summaries/page reads never hydrate frozen projects', () => {
  const id = createFixtureProject(repo.projectsRoot);
  let p = repo.mutateProject(id, 0, p => ({ ...p, song: { ...p.song, spectrum: 'abcd'.repeat(150000) } }));
  for (let i = 0; i < 30; i++) {
    repo.saveJob(id, { id: `job-${i}`, projectId: id, kind: 'validate', status: 'done', createdAt: i, input: { project: p }, result: { valid: true, report: 'details'.repeat(10000) } });
    p = repo.mutateProject(id, p.revision, p => ({ ...p, name: `revision-${i}` }));
  }
  const db = new DatabaseSync(join(repo.projectDir(id), 'project.sqlite'));
  try {
    assert.ok(db.prepare('SELECT sum(length(data)) AS bytes FROM jobs').get().bytes < 100000);
    assert.ok(db.prepare('SELECT sum(length(data)) AS bytes FROM revisions WHERE revision>0').get().bytes < 200000);
  } finally { db.close(); }
  const first = repo.listJobsPage(id, { limit: 7 });
  assert.equal(first.jobs.length, 7);
  assert.ok(first.nextCursor);
  assert.ok(first.jobs.every(job => !job.input.project && !job._recordRefs));
  assert.ok(JSON.stringify(first).length < 20000);
  const ids = new Set(first.jobs.map(job => job.id));
  let cursor = first.nextCursor;
  while (cursor) {
    const page = repo.listJobsPage(id, { limit: 7, cursor });
    for (const job of page.jobs) { assert.ok(!ids.has(job.id)); ids.add(job.id); }
    cursor = page.nextCursor;
  }
  assert.equal(ids.size, 30);
  const job = repo.readJob(id, 'job-0');
  assert.equal(job.input.project.revision, 1);
  assert.equal(job.input.project.song.spectrum.length, 600000);
  assert.equal(job.result.report.length, 70000);
  job.input.project.name='changed after freeze';
  repo.saveJobProgress(id,{...job,progress:1});
  repo.saveUnfinishedJob(id,{...job,status:'error',error:'late watchdog'});
  assert.equal(repo.readJobMetadata(id,'job-0').status,'done');
  assert.notEqual(repo.readJob(id,'job-0').input.project.name,'changed after freeze');
  repo.saveJob(id, { ...repo.readJobMetadata(id, 'job-0'), detail: 'metadata update' });
  assert.equal(repo.readJob(id, 'job-0').result.report.length, 70000);
  assert.equal(repo.projectVersion(id).revision, 31);
  assert.throws(() => repo.listJobsPage(id, { cursor: 'invalid' }), /cursor/);
});

test('legacy migration is resumable, keeps frozen identities and refuses active vacuum', () => {
  const id = createFixtureProject(repo.projectsRoot), original = repo.readProject(id), file = join(repo.projectDir(id), 'project.sqlite');
  const legacy = { id: 'legacy', projectId: id, kind: 'export', status: 'running', input: { project: original }, result: { file: 'exports/movie.mp4' } };
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(legacy.id, legacy.kind, legacy.status, JSON.stringify(legacy), 1); db.close();
  assert.throws(() => migrateProjectStorage(id, { vacuum: true }), /idle/);
  assert.deepEqual(repo.readJob(id, legacy.id).input.project, original);
  assert.equal(migrateProjectStorage(id).jobs, 0);
  repo.saveJob(id, { ...repo.readJob(id, legacy.id), status: 'done' });
  assert.equal(migrateProjectStorage(id, { vacuum: true }).vacuumed, true);
});

test('reserved literal objects survive encoding; corrupt immutable objects fail closed', () => {
  const value = { marker: { __videograph_ref: 'user-content' }, literal: { __videograph_literal: { x: 1 } }, text: 'x'.repeat(20000) };
  const packed = encodeSnapshot(root, value);
  assert.deepEqual(decodeSnapshot(root, packed), value);
  const files = readdirSync(join(root, '.records', 'objects'));
  assert.ok(files.length);
  const file = join(root, '.records', 'objects', files[0]);
  const original = readFileSync(file);
  writeFileSync(file, '{}');
  assert.throws(() => decodeSnapshot(root, packed), /corrupt/);
  writeFileSync(file, original);
});

test('retention preserves review evidence, frozen inputs and exports; active jobs block cleanup', () => {
  const id = createFixtureProject(repo.projectsRoot), dir = repo.projectDir(id), p = repo.readProject(id);
  const old = new Date(Date.now() - 2 * 86400000), key = 'a'.repeat(64), orphan = 'b'.repeat(64);
  for (const hash of [key, orphan]) { const path = join(dir, 'artifacts', `${hash}.png`); writeFileSync(path, 'image'); utimesSync(path, old, old); }
  repo.saveJob(id, { id: 'review', kind: 'stills', status: 'done', input: { project: p }, result: { images: [{ file: `artifacts/${key}.png` }] } });
  repo.mutateProject(id, p.revision, p => ({ ...p, review: { jobId: 'review' } }));
  repo.saveJob(id, { id: 'obsolete', kind: 'stills', status: 'done', result: { images: [{ file: `artifacts/${orphan}.png` }] } });
  repo.saveJob(id, { id: 'newest', kind: 'export', status: 'done', result: { file: 'exports/final.mp4' } });
  const db = new DatabaseSync(join(dir, 'project.sqlite'));
  db.prepare('UPDATE jobs SET updated_at=?').run(old.getTime());
  db.prepare("UPDATE jobs SET updated_at=updated_at+1 WHERE id='newest'").run(); db.close();
  const dry = retainProjectStorage(id, { keepJobs: 1 });
  assert.deepEqual(dry.jobsToRemove, ['obsolete']); assert.equal(existsSync(join(dir, 'artifacts', `${orphan}.png`)), true);
  const applied = retainProjectStorage(id, { keepJobs: 1, apply: true });
  assert.equal(applied.failures.length, 0);
  assert.equal(existsSync(join(dir, 'artifacts', `${key}.png`)), true);
  assert.equal(existsSync(join(dir, 'artifacts', `${orphan}.png`)), false);
  assert.equal(repo.readJob(id, 'review').input.project.revision, 0);
  repo.saveJob(id, { id: 'running', kind: 'validate', status: 'running' });
  assert.throws(() => retainProjectStorage(id, { apply: true }), error => error.status === 409);
});

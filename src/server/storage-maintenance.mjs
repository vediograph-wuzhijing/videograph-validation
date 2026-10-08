// Explicit maintenance runs in a worker/CLI, never in a request on the main loop.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { projectDir, ensureStorageSchema, encodeProjectRecord, decodeProjectRecord } from './project-repository.mjs';
import { encodeJobRecord, decodeJobRecord, jobSummary } from './job-records.mjs';
export function migrateProjectStorage(id, { vacuum = false } = {}) {
    const dir = projectDir(id), file = join(dir, 'project.sqlite'), beforeBytes = statSync(file).size;
    const db = new DatabaseSync(file);
    let revisions = 0, jobs = 0;
    try {
        db.exec('PRAGMA busy_timeout=5000');
        ensureStorageSchema(db);
        for (const row of db.prepare('SELECT revision,data FROM revisions ORDER BY revision').iterate()) {
            const old = JSON.parse(row.data);
            if (old.format === 'videograph-snapshot/v2')
                continue;
            const data = JSON.stringify(encodeProjectRecord(dir, decodeProjectRecord(dir, old)));
            db.prepare('UPDATE revisions SET data=? WHERE revision=? AND data=?').run(data, row.revision, row.data);
            revisions++;
        }
        // Optimistic replacement leaves a concurrently updated task untouched.
        for (const row of db.prepare('SELECT id,data FROM jobs WHERE summary IS NULL').iterate()) {
            const record = encodeJobRecord(dir, decodeJobRecord(dir, JSON.parse(row.data)));
            const changed = db.prepare('UPDATE jobs SET data=?,summary=? WHERE id=? AND data=?')
                .run(JSON.stringify(record), JSON.stringify(jobSummary(record)), row.id, row.data);
            jobs += Number(changed.changes);
        }
        db.exec("UPDATE metadata SET value=value+1 WHERE key='jobsVersion'");
        if (vacuum) {
            if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running') LIMIT 1").get())
                throw new Error('VACUUM requires an idle project; running tasks were preserved');
            db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
        }
        return { projectId: id, revisions, jobs, beforeBytes, afterBytes: statSync(file).size, vacuumed: vacuum };
    }
    finally {
        db.close();
    }
}

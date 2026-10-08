// Reachability-based maintenance. Never touches user media, exports or engine
// sources. A writer lock and an idle-job check protect in-flight publication.
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { projectDir, decodeProjectRecord, ensureStorageSchema, assertStorageWritable } from './project-repository.mjs';
import { decodeJobRecord } from './job-records.mjs';
import { recordReferences, getRecordObject } from './record-objects.mjs';
import { ProjectError } from './errors.mjs';
function strings(value, into) {
    if (typeof value === 'string')
        into.add(value);
    else if (value && typeof value === 'object')
        for (const v of Object.values(value))
            strings(v, into);
}
function managedFile(dir, filename, root) {
    const path = resolve(dir, root, filename), base = resolve(dir, root);
    if (!path.startsWith(base + sep) || relative(base, path).includes(sep))
        throw new Error('invalid maintenance path');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile())
        return null;
    return { file: `${root.replaceAll('\\', '/')}/${filename}`, bytes: stat.size, mtime: stat.mtimeMs, path };
}
export function retainProjectStorage(id, { apply = false, keepJobs = 100, graceMs = 86400000, now = Date.now() } = {}) {
    if (typeof apply !== 'boolean' || !Number.isInteger(keepJobs) || keepJobs < 1 || keepJobs > 10000 || !Number.isSafeInteger(graceMs) || graceMs < 3600000 || !Number.isSafeInteger(now))
        throw new ProjectError('invalid retention options (grace must be at least one hour)');
    const dir = projectDir(id), db = new DatabaseSync(join(dir, 'project.sqlite'));
    let begun = false, leaseUntil;
    try {
        db.exec('PRAGMA busy_timeout=5000');
        ensureStorageSchema(db);
        db.exec('BEGIN IMMEDIATE');
        begun = true;
        assertStorageWritable(db);
        if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running') LIMIT 1").get())
            throw new ProjectError('工程仍有未完成任务，保留策略未执行', 409);
        const cache = new Map(), refs = new Set(), protectedStrings = new Set();
        for (const table of ['project', 'revisions'])
            for (const row of db.prepare(`SELECT data FROM ${table}`).iterate()) {
                const record = JSON.parse(row.data);
                recordReferences(record, refs);
                strings(decodeProjectRecord(dir, record, cache), protectedStrings);
            }
        const removedJobs = [], retainedJobs = [], allJobs = new Map();
        let count = 0;
        for (const row of db.prepare('SELECT id,data,updated_at FROM jobs ORDER BY updated_at DESC,id DESC').iterate()) {
            allJobs.set(row.id, row);
            if (count++ < keepJobs || row.updated_at > now - graceMs || protectedStrings.has(row.id))
                retainedJobs.push(row);
            else
                removedJobs.push(row.id);
        }
        const retainedIds = new Set(retainedJobs.map(row => row.id));
        for (let index = 0; index < retainedJobs.length; index++) {
            const row = retainedJobs[index];
            const record = JSON.parse(row.data);
            recordReferences(record, refs);
            for (const hash of Object.values(record._recordRefs ?? {}))
                refs.add(hash);
            strings(decodeJobRecord(dir, record, { input: true, result: true }, cache), protectedStrings);
            for (const jid of protectedStrings)
                if (allJobs.has(jid) && !retainedIds.has(jid)) {
                    retainedIds.add(jid);
                    retainedJobs.push(allJobs.get(jid));
                }
        }
        // Every reference is verified. Missing/corrupt reachable objects abort all cleanup.
        const pending = [...refs], visited = new Set();
        while (pending.length) {
            const hash = pending.pop();
            if (visited.has(hash))
                continue;
            visited.add(hash);
            const object = getRecordObject(dir, hash, cache);
            for (const child of recordReferences(object))
                if (!visited.has(child)) {
                    refs.add(child);
                    pending.push(child);
                }
        }
        const protectedKeys = new Set();
        for (const text of protectedStrings) {
            if (/^[a-f0-9]{64}$/.test(text))
                protectedKeys.add(text);
            for (const match of text.matchAll(/(?:^|[\\/])([a-f0-9]{64})(?:\.[a-z]+)?(?:$|[\\/])/g))
                protectedKeys.add(match[1]);
        }
        const candidates = [], protectedFiles = [];
        for (const folder of ['artifacts', '.records/objects']) {
            if (!existsSync(join(dir, folder)))
                continue;
            for (const name of readdirSync(join(dir, folder))) {
                if (!/^[a-f0-9]{64}\.(?:png|mp4|json|gray|wav|ustx|lrc)$/.test(name))
                    continue;
                const file = managedFile(dir, name, folder);
                if (!file)
                    continue;
                const hash = name.slice(0, 64), isProtected = folder === '.records/objects' ? refs.has(hash) : protectedKeys.has(hash);
                (isProtected || file.mtime > now - graceMs ? protectedFiles : candidates).push(file);
            }
        }
        if (apply) {
            const drop = db.prepare('DELETE FROM jobs WHERE id=?');
            for (const jid of removedJobs)
                if (!retainedIds.has(jid))
                    drop.run(jid);
            // The durable lease stops future job publication while files disappear.
            // After a crash it expires; missing unreferenced cache files are rebuilt.
            leaseUntil = Date.now() + 300000;
            db.prepare("INSERT INTO metadata VALUES('storageMaintenanceUntil',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(leaseUntil);
            db.exec("UPDATE metadata SET value=value+1 WHERE key='jobsVersion'");
        }
        db.exec('COMMIT');
        begun = false;
        if (apply) {
            // Hold the writer lock through unlink. A time lease alone cannot fence a
            // process suspended longer than its deadline; a new publisher must never
            // commit a reference to a file the old collector is about to remove.
            db.exec('BEGIN IMMEDIATE');
            begun = true;
            if (db.prepare("SELECT value FROM metadata WHERE key='storageMaintenanceUntil'").get()?.value !== leaseUntil)
                throw new ProjectError('存储维护所有权已改变；停止删除', 409);
        }
        // Database pointers disappear before files. A partial unlink failure leaves
        // redundant bytes, never a dangling committed reference; next run retries.
        const failures = [];
        if (apply)
            for (const file of candidates) {
                try {
                    const current = lstatSync(file.path);
                    if (!current.isSymbolicLink() && current.isFile() && current.mtimeMs === file.mtime && current.size === file.bytes)
                        unlinkSync(file.path);
                }
                catch (error) {
                    failures.push({ file: file.file, error: error.message });
                }
            }
        if (begun) {
            db.exec('COMMIT');
            begun = false;
        }
        return { projectId: id, applied: apply, jobsToRemove: removedJobs.filter(jid => !retainedIds.has(jid)), retainedJobs: retainedJobs.length,
            filesToRemove: candidates.map(({ path, ...file }) => file), reclaimableBytes: candidates.reduce((sum, f) => sum + f.bytes, 0),
            protectedBytes: protectedFiles.reduce((sum, f) => sum + f.bytes, 0), failures };
    }
    catch (error) {
        if (begun)
            db.exec('ROLLBACK');
        throw error;
    }
    finally {
        if (leaseUntil)
            db.prepare("DELETE FROM metadata WHERE key='storageMaintenanceUntil' AND value=?").run(leaseUntil);
        db.close();
    }
}

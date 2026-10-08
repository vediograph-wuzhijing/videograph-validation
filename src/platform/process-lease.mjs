import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
/** Atomic process ownership, including stale-owner recovery. Never kills a process. */
export function acquireProcessLease(file) {
    const token = randomUUID();
    const db = new DatabaseSync(file, { timeout: 5000 });
    try {
        db.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL)');
        db.exec('BEGIN IMMEDIATE');
        const prior = db.prepare('SELECT pid FROM owner WHERE id=1').get();
        if (prior) {
            if (!Number.isInteger(Number(prior.pid)) || Number(prior.pid) <= 0)
                throw new Error('服务归属记录损坏，请检查后恢复');
            try {
                process.kill(Number(prior.pid), 0);
            }
            catch (error) {
                if (error.code !== 'ESRCH')
                    throw error;
                db.prepare('DELETE FROM owner WHERE id=1').run();
            }
            if (db.prepare('SELECT id FROM owner WHERE id=1').get()) {
                const error = new Error('该目录已有服务进程；请使用独立目录或先正常停止它');
                Object.assign(error, { status: 409 });
                throw error;
            }
        }
        db.prepare('INSERT INTO owner VALUES(1,?,?)').run(process.pid, token);
        db.exec('COMMIT');
    }
    catch (error) {
        if (db.isTransaction)
            db.exec('ROLLBACK');
        throw error;
    }
    finally {
        db.close();
    }
    return () => {
        const release = new DatabaseSync(file, { timeout: 5000 });
        try {
            release.prepare('DELETE FROM owner WHERE id=1 AND token=?').run(token);
        }
        finally {
            release.close();
        }
    };
}

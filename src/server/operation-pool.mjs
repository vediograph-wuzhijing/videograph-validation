import { Worker } from 'node:worker_threads';
import { ProjectError } from './errors.mjs';
/** Bounded persistent workers, one operation per worker. Mutations are never
 * retried automatically: a crash may occur after their transaction committed. */
export class OperationPool {
    constructor({ size = 2, maxQueued = 128, timeoutMs = 300000, workerUrl = new URL('./operation-worker.mjs', import.meta.url) } = {}) {
        if (!Number.isInteger(size) || size < 1 || size > 8 || !Number.isInteger(maxQueued) || maxQueued < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
            throw new Error('invalid operation pool limits');
        this.size = size;
        this.maxQueued = maxQueued;
        this.timeoutMs = timeoutMs;
        this.workerUrl = workerUrl;
        this.workers = new Set();
        this.pending = [];
        this.sequence = 0;
        this.closed = false;
    }
    call(name, args = []) {
        if (this.closed)
            return Promise.reject(new ProjectError('service is closing', 503));
        if (this.pending.length >= this.maxQueued)
            return Promise.reject(new ProjectError('service operation queue is full; retry a read later', 503));
        return new Promise((resolve, reject) => { this.pending.push({ id: ++this.sequence, name, args, resolve, reject }); this.pump(); });
    }
    pump() {
        if (this.closed)
            return;
        while (this.workers.size < this.size && this.pending.length) {
            const entry = { worker: new Worker(this.workerUrl), active: null };
            this.workers.add(entry);
            entry.worker.on('message', reply => {
                const task = entry.active;
                if (!task || task.id !== reply.id)
                    return;
                clearTimeout(entry.timer);
                entry.active = null;
                reply.error ? task.reject(new ProjectError(reply.error.message, reply.error.status, reply.error.details)) : task.resolve(reply.value);
                this.pump();
            });
            const failed = error => {
                if (!this.workers.delete(entry))
                    return;
                clearTimeout(entry.timer);
                entry.active?.reject(error);
                entry.active = null;
                this.pump();
            };
            entry.worker.on('error', failed);
            entry.worker.on('exit', code => failed(new ProjectError(`operation worker exited ${code}; mutation outcome may need checking`, 503)));
        }
        for (const entry of this.workers)
            if (!entry.active && this.pending.length) {
                const task = this.pending.shift();
                entry.active = task;
                entry.timer = setTimeout(() => {
                    if (!this.workers.delete(entry))
                        return;
                    entry.active = null;
                    task.reject(new ProjectError('operation timed out; check mutation outcome before retrying', 503));
                    void entry.worker.terminate();
                    this.pump();
                }, this.timeoutMs);
                try {
                    entry.worker.postMessage({ id: task.id, name: task.name, args: task.args });
                }
                catch (error) {
                    clearTimeout(entry.timer);
                    entry.active = null;
                    task.reject(error);
                    queueMicrotask(() => this.pump());
                }
            }
    }
    async close() {
        this.closed = true;
        for (const task of this.pending.splice(0))
            task.reject(new ProjectError('service is closing', 503));
        const workers = [...this.workers];
        for (const entry of workers) {
            clearTimeout(entry.timer);
            entry.active?.reject(new ProjectError('service is closing; check mutation outcome before retrying', 503));
            entry.active = null;
        }
        await Promise.all(workers.map(entry => entry.worker.terminate()));
        this.workers.clear();
    }
}

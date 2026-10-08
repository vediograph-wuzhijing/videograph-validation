// @ts-check
// Child-process scheduling owns task recovery, cancellation and resource cleanup.
// Storage and spawning are injected so failure paths can be exercised without GPU rendering.
/** @typedef {{ projectId: string, jobId: string, kind?: string, createdAt?: number }} QueueEntry */
/** @typedef {{ id: string, status: string, progress?: number, detail?: string,
 * error?: string, finishedAt?: number } & Record<string, unknown>} QueueJob */
/** @typedef {{ spawnWorker: (entry: QueueEntry) => import('node:child_process').ChildProcess,
 * readJob: (projectId: string, jobId: string) => QueueJob | Promise<QueueJob>,
 * saveJob: (projectId: string, job: QueueJob) => unknown,
 * terminateWorker?: (child: import('node:child_process').ChildProcess) => unknown,
 * stallMs?: number, onError?: (error: unknown) => void }} QueueOptions */
export class RenderQueue {
  /** @type {QueueEntry[]} */
  pending = [];
  /** @type {(QueueEntry & { child: import('node:child_process').ChildProcess }) | null} */
  active = null;
  closed = false;
  /** @param {QueueOptions} options */
  constructor({ spawnWorker, readJob, saveJob, terminateWorker = (child) => child.kill('SIGKILL'), stallMs = 600_000, onError = (error) => console.error('[render queue]', error) }) {
    if (!Number.isFinite(stallMs) || stallMs <= 0) throw new Error('VIDEOGRAPH_JOB_STALL_MS must be positive');
    this.spawnWorker = spawnWorker; this.readJob = readJob; this.saveJob = saveJob;
    this.terminateWorker = terminateWorker; this.stallMs = stallMs; this.onError = onError;
  }
  /** @param {QueueEntry} entry */
  enqueue(entry) { this.pending.push(entry); this.pump(); }
  pump() {
    if (this.active || this.closed || !this.pending.length) return;
    const entry = this.pending.shift();
    if (!entry) return;
    let child;
    try { child = this.spawnWorker(entry); }
    catch (error) { void this.#fail(entry, error); queueMicrotask(() => this.pump()); return; }
    this.active = { ...entry, child };
    let log = '', observed = '', lastProgress = Date.now();
    /** @param {unknown} chunk */
    const record = (chunk) => { log = (log + chunk).slice(-12000); };
    child.stdout?.on('data', record); child.stderr?.on('data', record);
    child.on('error', record);
    let checking = false;
    const watchdog = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const job = await this.readJob(entry.projectId, entry.jobId);
        if (this.active?.child !== child) return;
        const signature = JSON.stringify([job.status, job.progress, job.detail]);
        if (signature !== observed) { observed = signature; lastProgress = Date.now(); }
        if (Date.now() - lastProgress > this.stallMs) {
          await this.#fail(entry, new Error('render worker stalled without progress'));
          this.terminateWorker(child);
        }
      } catch (error) { this.onError(error); if (this.active?.child === child) this.terminateWorker(child); }
      finally { checking = false; }
    }, Math.min(5000, this.stallMs));
    watchdog.unref();
    child.once('close', async (code) => {
      clearInterval(watchdog);
      try {
        const job = await this.readJob(entry.projectId, entry.jobId);
        if (!['done', 'error', 'cancelled', 'interrupted'].includes(job.status)) {
          await this.saveJob(entry.projectId, { ...job, status: 'error', error: `render worker exited ${code}\n${log}`, finishedAt: Date.now() });
        }
      } catch (error) { this.onError(error); }
      finally { this.active = null; this.pump(); }
    });
  }
  /** @param {QueueEntry} entry @param {unknown} error */
  async #fail(entry, error) {
    try {
      const job = await this.readJob(entry.projectId, entry.jobId);
      if (['done', 'error', 'cancelled', 'interrupted'].includes(job.status)) return;
      const detail = error && typeof error === 'object' && 'message' in error ? error.message ?? error : error;
      await this.saveJob(entry.projectId, { ...job, status: 'error', error: String(detail), finishedAt: Date.now() });
    } catch (storageError) { this.onError(storageError); }
  }
  /** @param {string} projectId @param {QueueJob} job */
  async cancel(projectId, job) {
    if (this.active?.projectId === projectId && this.active.jobId === job.id) {
      if (this.active.child.connected) this.active.child.send('cancel', (error) => { if (error) this.onError(error); });
      return;
    }
    const index = this.pending.findIndex((entry) => entry.projectId === projectId && entry.jobId === job.id);
    if (index >= 0) this.pending.splice(index, 1);
    if (job.status === 'queued') await this.saveJob(projectId, { ...job, status: 'cancelled', finishedAt: Date.now() });
  }
  close() {
    this.closed = true;
    const child = this.active?.child;
    if (!child) return;
    if (child.connected) child.send('cancel', (error) => { if (error) this.onError(error); });
    const deadline = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) this.terminateWorker(child); }, 5000);
    deadline.unref();
    child.once('close', () => clearTimeout(deadline));
  }
}

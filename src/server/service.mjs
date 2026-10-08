// @ts-check
// Composition and lifecycle. Importing this module never starts a server or worker.
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { productRoot } from './project-repository.mjs';
import { createServiceAuth } from './auth.mjs';
import { createHttpHandler } from './http-app.mjs';
import { readServiceConfig } from './service-config.mjs';
import { createProjectRouter } from './project-router.mjs';
import { RenderQueue } from './render-queue.mjs';
import { PreviewPool } from './preview-pool.mjs';
import { startReferenceServer } from './reference-server.mjs';
import { startAnalysisWorker, analyzeProject } from './analysis-jobs.mjs';
import { killAll, runAnalysis } from '../song/analyzer-runner.mjs';
import { OperationPool } from './operation-pool.mjs';
import {ProjectError} from './errors.mjs';
import {acquireServiceLease} from './service-lease.mjs';

/** @typedef {{ url: string, port: number }} RunningService */

export function createProjectService(config = readServiceConfig()) {
  const auth = createServiceAuth(config.allowedOrigins), bootTime = Date.now();
  const srcMtime = statSync(new URL('./index.mjs', import.meta.url)).mtimeMs;
  const previews = new PreviewPool({ create: startReferenceServer });
  const operations = new OperationPool();
  let admissionPaused = false;
  /** @param {string} name @param {unknown[]} args */
  const run = (name, args) => admissionPaused ? Promise.reject(new ProjectError('工作台正在停止，暂不接受工程操作', 503)) : operations.call(name, args);
  const renders = new RenderQueue({ readJob: (id, jobId) => run('readJobMetadata', [id, jobId]), saveJob: (id, job) => run('saveUnfinishedJob', [id, job]), stallMs: config.stallMs,
    /** @param {import('node:child_process').ChildProcess} child */
    terminateWorker: (child) => {
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, (error) => {
          if (error && child.exitCode === null && child.signalCode === null) { console.error('[render terminate]', error); child.kill('SIGKILL'); }
        });
      } else child.kill('SIGKILL');
    },
    /** @param {import('./render-queue.mjs').QueueEntry} entry */
    spawnWorker: (entry) => spawn(process.execPath, [join(productRoot, entry.kind === 'vocal' ? 'src/server/vocal-worker.mjs' : 'src/server/render-worker.mjs'), entry.projectId, entry.jobId], {
      cwd: productRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, VIDEOGRAPH_STORAGE_FORMAT: '2' },
    }),
  });
  const commands = {
    /** @param {string} id @param {string} kind @param {unknown} options */
    enqueue: async (id, kind, options) => {
      const job = await run('prepareRenderJob', [id, kind, options]);
      renders.enqueue({ projectId: id, jobId: job.id, kind: job.kind }); return job;
    },
    /** @param {string} id @param {string} jobId @param {number} seconds */
    waitJob: async (id, jobId, seconds) => {
      const deadline = Date.now() + Math.min(50, Math.max(0, seconds)) * 1000;
      let job = await run('readJob', [id, jobId, { input: false }]);
      while (!['done','error','cancelled','interrupted'].includes(job.status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        job = await run('readJob', [id, jobId, { input: false }]);
      }
      return job;
    },
  };
  const route = createProjectRouter({ renders, previews, run, ...commands });
  /** @type {any} */
  let diagnostics = null;
  let loadedFingerprint = '';
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let diagnosticsTimer;
  let diagnosticsRunning = false;
  const storageMigration = { state:'pending', projectId:'', completed:0, total:0, errors:/** @type {string[]} */([]) };
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let retentionTimer;
  let retaining = false;
  const retainIdleProjects = async () => {
    if(retaining||closing) return;
    retaining=true;
    try {
      for(const project of await run('listProjects',[])) {
        if(closing) break;
        try {await run('retainProjectStorage',[project.id,{apply:true}]);}
        catch(error){if(!error||typeof error!=='object'||!('status' in error)||error.status!==409)console.error('[storage retention]',error);}
      }
    } finally{retaining=false;}
  };
  const sampleDiagnostics = async () => {
    if (diagnosticsRunning || closing || admissionPaused) return;
    diagnosticsRunning = true;
    try {
      diagnostics = await run('serviceDiagnostics', []);
      loadedFingerprint ||= diagnostics.codeFingerprint;
    } catch (error) { console.error('[service diagnostics]', error); }
    finally { diagnosticsRunning = false; }
  };
  const health = () => ({ ok: true, pid: process.pid, apiVersion: 'project-service/v5-llm-ae', bootTime, srcMtime,
    activeJob: renders.active?.jobId ?? null, queued: renders.pending.length,
    ...diagnostics, loadedFingerprint, codeStale: diagnostics ? diagnostics.codeFingerprint !== loadedFingerprint : null,
    operationsQueued: operations.pending.length,
    operationsActive: [...operations.workers].filter(worker=>worker.active).length,
    storageMigration,
    analysis: 'reference fingerprint import + SONG analyzer for new audio' });
  const server = createServer(createHttpHandler({ allowedOrigins: config.allowedOrigins, auth, health, route }));
  /** @type {(() => void) | undefined} */
  let stopAnalysisWorker;
  /** @type {Promise<RunningService> | undefined} */
  let startPromise;
  /** @type {Promise<void> | undefined} */
  let closePromise;
  /** @type {Promise<void> | undefined} */
  let listeningPromise;
  let closing = false;
  /** @type {(() => void) | undefined} */
  let releaseOwnership;

  /** @returns {Promise<RunningService>} */
  async function start() {
    if (closing) throw new Error('service already closed');
    if (startPromise) return startPromise;
    startPromise = (async () => {
      listeningPromise = new Promise((done, reject) => {
        /** @param {Error} error */
        const onError = (error) => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); done(); };
        server.once('error', onError); server.once('listening', onListen);
        server.listen(config.port, config.host);
      });
      await listeningPromise;
      if (closing) throw new Error('service closed during startup');
      releaseOwnership=acquireServiceLease();
      // Only the process that owns the port may publish credentials and recover tasks.
      mkdirSync(dirname(config.tokenPath), { recursive: true });
      writeFileSync(config.tokenPath, auth.mcpToken, { mode: 0o600 });
      await sampleDiagnostics();
      diagnosticsTimer = setInterval(() => void sampleDiagnostics(), 10000);
      diagnosticsTimer.unref();
      const projects = await run('listProjects', []);
      storageMigration.state='running';storageMigration.total=projects.length;
      for(const project of projects) {
        storageMigration.projectId=project.id;
        try {await run('migrateProjectStorage',[project.id]);}
        catch(error){storageMigration.errors.push(`${project.id}: ${error instanceof Error?error.message:String(error)}`);}
        storageMigration.completed++;
        if(project.status==='analysis-importing') await run('resumeExternalAnalysis',[project.id]);
      }
      storageMigration.state=storageMigration.errors.length?'incomplete':'done';storageMigration.projectId='';
      for (const project of projects) for (const job of await run('listUnfinishedJobs', [project.id])) {
        if (job.kind === 'analysis') {
          if (job.status === 'running') await run('saveJob', [project.id, { ...job, status: 'interrupted', error: '服务重启；工程仍为 analysis-pending 时会自动重新分析。' }]);
          continue;
        }
        if (job.status === 'queued') renders.pending.push({ projectId: project.id, jobId: job.id, kind: job.kind, createdAt: job.createdAt });
        else if (job.status === 'running') await run('saveJob', [project.id, { ...job, status: 'interrupted', error: '服务重启，旧渲染进程未恢复；可重新发起并复用已完成分段。' }]);
      }
      renders.pending.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      stopAnalysisWorker = startAnalysisWorker({list:()=>run('listProjects',[]),analyze:(id)=>analyzeProject(id,
        async(input)=>runAnalysis({...input,...await run('analyzerSettings',[])}),{
          saveJob:(id,job)=>run('saveJob',[id,job]),analysisInput:(id)=>run('analysisInput',[id]),
          completeAnalysis:(id,data,options)=>run('completeAnalysis',[id,data,options]),failAnalysis:(id,error)=>run('failAnalysis',[id,error]),
        })}); renders.pump();
      retentionTimer=setInterval(()=>void retainIdleProjects().catch(error=>console.error('[storage retention]',error)),6*3600000);
      retentionTimer.unref();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('service has no listening TCP address');
      return { url: `http://${config.host}:${address.port}`, port: address.port };
    })();
    try { return await startPromise; } catch (error) { await close(); throw error; }
  }
  /** @returns {Promise<void>} */
  function close() {
    closing = true;
    admissionPaused = true;
    if (!closePromise) closePromise = (async () => {
      if (listeningPromise) await listeningPromise.catch(() => {});
      if (diagnosticsTimer) clearInterval(diagnosticsTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      if (stopAnalysisWorker) { stopAnalysisWorker(); killAll(); }
      renders.close();
      /** @type {unknown[]} */
      const errors = [];
      const resources = [
        () => previews.close(),
        () => server.listening ? new Promise((done, reject) => {
          server.close((error) => error ? reject(error) : done(undefined));
          server.closeIdleConnections();
        }) : Promise.resolve(),
        () => operations.close(),
      ];
      for (const closeResource of resources) {
        try { await closeResource(); } catch (error) { errors.push(error); }
      }
      releaseOwnership?.();
      if (errors.length) throw new AggregateError(errors, 'service shutdown failed');
    })();
    return closePromise;
  }
  async function prepareIdleStop() {
    if (admissionPaused) throw new ProjectError('停止操作已在进行',409);
    admissionPaused=true;
    try {
      if(renders.active||renders.pending.length||operations.pending.length||[...operations.workers].some(worker=>worker.active)||storageMigration.state==='running') throw new ProjectError('工作台仍有任务或维护操作；完成后再停止',409);
      /** @type {{status:string}[]} */
      const projects=await operations.call('listProjects');
      if(projects.some(project=>['analysis-pending','analysis-importing'].includes(project.status))) throw new ProjectError('仍有待分析工程；不会中断分析',409);
      // Admission remains paused until close(); no new mutation can slip into
      // the gap between checking the queue and stopping the owned instance.
    }catch(error){admissionPaused=false;throw error;}
  }
  return { start, close, server, health, prepareIdleStop };
}

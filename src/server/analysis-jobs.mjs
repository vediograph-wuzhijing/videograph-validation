// analysis-jobs.mjs — SONG-05：新歌工程的后台分析。轮询 analysis-pending 工程，调用 SONG-01 分析器，结果经契约校验后写回工程。
// 与渲染队列分离（分析走 Python 子进程，不占渲染宿主）；同一时间只跑一个分析，服务重启后从 analysis-pending 状态自然恢复。
import { randomUUID } from 'node:crypto';
import { listProjects, saveJob } from './project-store.mjs';
import { analysisInput, completeAnalysis, failAnalysis } from './song-project.mjs';
import { runAnalysis } from '../song/analyzer-runner.mjs';

/** 启动后台轮询器（5 秒一次）；返回停止函数。
 * @param {{interval?:number,run?:typeof runAnalysis,list?:()=>ReturnType<typeof listProjects>|Promise<ReturnType<typeof listProjects>>,analyze?:(id:string,run:typeof runAnalysis)=>Promise<unknown>,onError?:(error:unknown)=>void}} [options] */
export function startAnalysisWorker({ interval = 5000, run = runAnalysis, list = listProjects, analyze = analyzeProject, onError = (error) => console.error('[analysis worker]', error) } = {}) {
  let busy = false, stopped = false;
  const retryAt = new Map();
  const failures = new Map();
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    let pending;
    try {
      pending = (await list()).filter((project) => project.status === 'analysis-pending' && (retryAt.get(project.id) ?? 0) <= Date.now())
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (pending) {
        await analyze(pending.id, run);
        failures.delete(pending.id); retryAt.delete(pending.id);
      }
    } catch (error) {
      if (pending) {
        const attempts = (failures.get(pending.id) ?? 0) + 1;
        failures.set(pending.id, attempts);
        retryAt.set(pending.id, Date.now() + Math.min(300_000, Math.max(1000, interval * 2 ** Math.min(attempts, 10))));
      }
      onError(error);
    } finally { busy = false; }
  };
  const timer = setInterval(tick, interval);
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

/** @param {string} projectId @param {typeof runAnalysis} [run]
 * @param {{saveJob:(id:string,job:any)=>unknown,analysisInput:(id:string)=>ReturnType<typeof analysisInput>|Promise<ReturnType<typeof analysisInput>>,completeAnalysis:(id:string,data:any,options:any)=>unknown,failAnalysis:(id:string,error:string)=>unknown}} [storage] */
export async function analyzeProject(projectId, run = runAnalysis, storage = {saveJob,analysisInput,completeAnalysis,failAnalysis}) {
  const job = { id: randomUUID(), projectId, kind: 'analysis', status: 'running', progress: 0, detail: '音频分析', createdAt: Date.now() };
  let persistenceError;
  let progressWrites = Promise.resolve();
  try {
    await storage.saveJob(projectId, job);
    const input = await storage.analysisInput(projectId);
    const result = await run({ ...input, onProgress: (line) => {
      job.detail = `分析 ${line.stage ?? ''}`.trim();
      const snapshot = {...job};
      progressWrites = progressWrites.then(()=>storage.saveJob(projectId,snapshot)).catch(error=>console.error('[analysis progress]',error));
    } });
    await progressWrites;
    await storage.completeAnalysis(projectId, result.analysis, { cached: result.cached });
    Object.assign(job, { status: 'done', progress: 1, detail: result.cached ? '复用分析缓存' : '分析完成', finishedAt: Date.now(), result: { cached: result.cached, key: result.key } });
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 4000);
    await progressWrites;
    try { await storage.failAnalysis(projectId, message); } catch (error) { persistenceError = error; }
    Object.assign(job, { status: 'error', error: message, finishedAt: Date.now() });
    console.error(`[分析] 工程 ${projectId} 失败：${message}`);
  }
  await storage.saveJob(projectId, job);
  if (persistenceError) throw persistenceError; // Back off if failed status could not be persisted.
  return job;
}

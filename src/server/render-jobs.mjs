import { randomUUID } from 'node:crypto';
import { readProject, readJob, saveJob } from './project-repository.mjs';
import { ProjectError } from './errors.mjs';
import { feedbackTargetWindow } from './feedback.mjs';
import { transitionPair, transitionWindow } from './transitions.mjs';
import { assertDirectorExport } from './director.mjs';

// AE-02/03/04：只读的画面/节奏分析任务。参数在入队时校验并展开为确定的时间点，渲染进程只执行。
export const AE_KINDS = ['filmstrip', 'contact-sheet', 'rhythm'];
function aeRange(project, options) {
  const duration = project.song?.duration ?? Math.max(...project.shots.map((shot) => shot.end));
  if (options.shotId) {
    const shot = project.shots.find((entry) => entry.id === options.shotId);
    if (!shot) throw new ProjectError('shot not found', 404);
    return { start: shot.start, end: shot.end, label: `镜头 ${shot.id}`, shots: [shot] };
  }
  if (options.transitionId) {
    const transition = project.transitions.find((entry) => entry.id === options.transitionId);
    if (!transition) throw new ProjectError('transition not found', 404);
    const { left, right } = transitionPair(project, transition);
    const window = transitionWindow(project, transition);
    const start = Math.max(left.start, window.start - 1), end = Math.min(right.end, window.end + 1);
    return { start, end, label: `转场 ${transition.id}`, shots: [left, right] };
  }
  const start = Math.max(0, options.start ?? 0), end = Math.min(duration, options.end ?? duration);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.05) throw new ProjectError('start/end 必须构成有效时间段');
  return { start, end, label: options.start === undefined && options.end === undefined ? '全片' : `${start.toFixed(2)}–${end.toFixed(2)}s`,
    shots: project.shots.filter((shot) => shot.end > start && shot.start < end) };
}
function aeInput(project, kind, options) {
  const fps = project.output.fps;
  const intIn = (value, fallback, min, max, name) => {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < min || result > max) throw new ProjectError(`${name} 必须是 ${min}..${max} 的整数`);
    return result;
  };
  if (kind === 'contact-sheet') {
    let selections;
    if(options.selections!==undefined){
      if(options.ratios!==undefined||!Array.isArray(options.selections)||!options.selections.length||options.selections.length>120) throw new ProjectError('selections 为1..120个镜头/时间点，不能与 ratios 混用');
      selections=options.selections.map(entry=>{
        const shot=project.shots.find(s=>s.id===entry?.shotId);
        if(!shot||!Number.isFinite(entry.t)||entry.t<shot.start||entry.t>=shot.end) throw new ProjectError('联系表采样必须落在指定镜头内');
        return {shotId:shot.id,t:entry.t};
      });
    }
    const ratios = options.ratios ?? [0.45];
    if (!Array.isArray(ratios) || !ratios.length || ratios.length > 3 || !ratios.every((ratio) => Number.isFinite(ratio) && ratio >= 0 && ratio <= 1)) throw new ProjectError('ratios 必须是 1–3 个 0..1 的数');
    return { ratios, ...(selections?{selections}:{}), thumbWidth: intIn(options.thumbWidth, (selections?.length??project.shots.length * ratios.length) > 24 ? 240 : 320, 160, 480, 'thumbWidth'),
      columns: intIn(options.columns, ratios.length > 1 ? ratios.length * 2 : 6, 1, 12, 'columns') };
  }
  const range = aeRange(project, options);
  const missing = range.shots.filter((shot) => !shot.module).map((shot) => shot.id);
  if (missing.length) throw new ProjectError(`这些镜头还没有源码：${missing.join(', ')}；先 project_shot_submit`, 409);
  const frame = (t) => Math.round(t * fps) / fps;
  if (kind === 'filmstrip') {
    let times;
    if (options.around !== undefined) {
      if (!Number.isFinite(options.around) || options.around < range.start || options.around >= range.end) throw new ProjectError('around 必须落在目标时间段内');
      const half = intIn(options.frames, 5, 1, 11, 'frames');
      times = Array.from({ length: half * 2 + 1 }, (_, i) => frame(options.around) + (i - half) / fps);
    } else if (options.sampleFps !== undefined) {
      if (!Number.isFinite(options.sampleFps) || options.sampleFps <= 0 || options.sampleFps > fps) throw new ProjectError(`sampleFps 必须在 (0, ${fps}]`);
      times = [];
      for (let t = range.start; t < range.end - 1e-6; t += 1 / options.sampleFps) times.push(t);
    } else {
      const count = Math.min(24, Math.max(6, Math.round((range.end - range.start) * 4)));
      times = Array.from({ length: count }, (_, i) => range.start + (range.end - range.start) * i / count);
    }
    times = [...new Set(times.map(frame).filter((t) => t >= range.start - 1e-6 && t < range.end - 1e-6).map((t) => +t.toFixed(4)))];
    if (!times.length || times.length > 24) throw new ProjectError(`帧数 ${times.length} 超出 1..24：缩小时间段或降低 sampleFps`);
    return { times, label: options.around !== undefined ? `${range.label === '全片' ? '' : range.label + ' · '}around ${options.around}s` : range.label, thumbWidth: intIn(options.thumbWidth, 320, 160, 480, 'thumbWidth'), columns: intIn(options.columns, Math.min(6, times.length), 1, 12, 'columns') };
  }
  const sampleFps = intIn(options.sampleFps, range.end - range.start > 30 ? 15 : fps, 10, 60, 'sampleFps');
  if ((range.end - range.start) * sampleFps > 6000) throw new ProjectError('采样帧过多（>6000）：缩小时间段或降低 sampleFps');
  return { start: range.start, end: range.end, sampleFps, label: range.label };
}
export function publicJob(job) {
  const { input, _recordRefs, _resultSummary, ...result } = job;
  if (!input) return result; // 分析任务没有渲染输入
  return { ...result, inputRevision: input.project?.revision ?? input.projectRevision, shotId: input.shotId, transitionId: input.transitionId, fps: input.fps, samples: input.samples, ...(input.stills ? { stills: input.stills } : {}), ...(input.ae ? { ae: input.ae } : {}) };
}

export function createRenderJobs(renders) {
  function enqueue(projectId, kind, options) {
    const project = readProject(projectId);
    if (!['validate', 'validate-transition', 'export', 'stills', ...AE_KINDS].includes(kind)) throw new ProjectError('invalid job kind');
    if (kind === 'validate-transition' && !project.transitions.some((transition) => transition.id === options.transitionId)) throw new ProjectError('transition not found', 404);
    if (kind === 'validate' && !project.shots.some((shot) => shot.id === options.shotId)) throw new ProjectError('shot not found', 404);
    if (kind === 'export' && [...project.shots, ...project.transitions].some((target) => (target.feedback ?? []).some((note) => note.status !== 'accepted'))) throw new ProjectError('存在未接受的镜头或转场意见：请先配置/改写、校验并确认采用。', 409);
    if (['validate', 'export', 'stills', ...AE_KINDS].includes(kind) && project.status && project.status !== 'planned') throw new ProjectError(`工程还在 ${project.status} 阶段：先完成分析确认与镜头规划`, 409);
    if (kind === 'validate' && !project.shots.find((shot) => shot.id === options.shotId).module) throw new ProjectError('镜头还没有源码：先 project_shot_submit', 409);
    if (kind === 'export' && project.shots.some((shot) => !shot.module || shot.status === 'needs-generation')) throw new ProjectError('有镜头尚未生成源码（needs-generation）', 409);
    if (kind === 'export' && project.transitions.some((transition) => transition.status === 'needs-generation')) throw new ProjectError('有转场指导尚未落实为效果配置', 409);
    if (kind === 'export') assertDirectorExport(project);
    let stills = null;
    if (kind === 'stills') {
      const shotTarget = options.shotId ? project.shots.find((shot) => shot.id === options.shotId) : null;
      const transitionTarget = !shotTarget && options.transitionId ? project.transitions.find((transition) => transition.id === options.transitionId) : null;
      if (!shotTarget && !transitionTarget) throw new ProjectError('必须指定存在的 shotId 或 transitionId', 404);
      const targetKind = shotTarget ? 'shot' : 'transition';
      const target = shotTarget ?? transitionTarget;
      if (options.version === 'before-feedback' && !target.reviewBaseline) throw new ProjectError('没有可比较的修改前版本');
      const pair = targetKind === 'transition' ? transitionPair(project, target) : null;
      const window = feedbackTargetWindow(project, target, targetKind, pair);
      const fps0 = project.output?.fps ?? 30;
      const tolerance = 0.5 / fps0;
      const inWindow = (t) => Number.isFinite(t) && t >= window.start - tolerance && t <= window.end + tolerance;
      let times = options.times;
      if (times === undefined || times === null) {
        // 默认时间点：未接受意见的锚点 t，再加窗口的 0 / 0.5 / 1（终点回退一帧，避免停在窗口外）。
        const last = Math.max(window.start, window.end - 1 / fps0);
        const anchors = (target.feedback ?? []).filter((note) => note.status !== 'accepted' && inWindow(note.anchor?.t)).map((note) => Math.min(note.anchor.t, last));
        times = [...anchors, window.start, window.start + (window.end - window.start) * .5, last];
      }
      if (!Array.isArray(times) || !times.length || times.length > 6 || !times.every(inWindow)) throw new ProjectError('times 必须是落在目标时间窗内、最多 6 个的时间点');
      times = [...new Set(times.map((t) => Math.round(t * 1000) / 1000))];
      const width = options.width ?? 960;
      if (!Number.isInteger(width) || width < 320 || width > 1920) throw new ProjectError('width 必须是 320..1920 的整数像素');
      stills = { targetKind, targetId: target.id, times, version: options.version === 'before-feedback' ? 'before-feedback' : 'current', width };
    }
    const ae = AE_KINDS.includes(kind) ? aeInput(project, kind, options) : null;
    const fps = AE_KINDS.includes(kind) ? project.output.fps : options.fps ?? project.output.fps;
    const samples = AE_KINDS.includes(kind) ? 1 : options.samples ?? project.output.samples;
    if (![24, 30, 60].includes(fps) || ![1, 4, 12].includes(samples)) throw new ProjectError('fps supports 24/30/60; samples supports 1/4/12');
    const job = { id: randomUUID(), projectId, kind, status: 'queued', progress: 0, detail: '等待渲染进程', createdAt: Date.now(), input: { project, shotId: options.shotId, transitionId: options.transitionId, fps, samples, ...(stills ? { stills } : {}), ...(ae ? { ae } : {}) } };
    saveJob(projectId, job);
    renders.enqueue({ projectId, jobId: job.id });
    return publicJob(job);
  }
  // AE-06：GET 任务时可阻塞等待到结束（最多 50 秒，留余量给 MCP 客户端常见的 60 秒请求超时），减少 agent 轮询回合。
  async function waitJob(projectId, jobId, seconds) {
    const deadline = Date.now() + Math.min(50, Math.max(0, seconds)) * 1000;
    let job = readJob(projectId, jobId, { input: false });
    while (!['done', 'error', 'cancelled', 'interrupted'].includes(job.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = readJob(projectId, jobId, { input: false });
    }
    return job;
  }
  return { enqueue, waitJob };
}

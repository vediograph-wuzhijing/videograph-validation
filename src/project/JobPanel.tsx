import { projectFile } from './api';
import type { ProjectJob } from './contracts';
import { cacheSummaryText } from './labels';

const jobLabel: Record<string, string> = { queued: '排队', running: '运行中', done: '完成', error: '失败', interrupted: '已中断', cancelled: '已取消' };
const jobKindLabel = (job: ProjectJob) => job.kind === 'vocal' ? '歌声渲染' : job.kind === 'analysis' ? '歌曲分析'
  : job.kind === 'export' ? '完整 PV' : job.kind === 'validate-transition' ? `转场 ${job.transitionId ?? ''}`
  : job.kind === 'contact-sheet' ? '全片联系表' : job.kind === 'rhythm' ? '节奏报告'
  : job.kind === 'filmstrip' ? '运动帧序列' : job.kind === 'stills' ? '静帧'
  : `镜头 ${job.shotId ?? ''}`;

export function JobPanel({ projectId, jobs, onCancel }: { projectId: string; jobs: ProjectJob[]; onCancel: (id: string) => void }) {
  const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const completedVideo = jobs.find((job) => job.kind === 'export' && job.status === 'done' && job.result?.file);
  return <section className="project-jobs">
    <div className="sidebar-title">后台任务 {activeJobs.length > 0 && <span>{activeJobs.length} 进行中</span>}</div>
    {jobs.slice(0, 5).map((job) => <article key={job.id} className={`job-${job.status}`}>
      <strong>{jobKindLabel(job)} · {jobLabel[job.status] ?? job.status}</strong>
      {['running', 'queued'].includes(job.status) && <div className="job-progress">
        <i style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
      </div>}
      <p>{job.detail}</p>
      {job.error && <pre>{job.error}</pre>}
      {job.kind !== 'analysis' && ['running', 'queued'].includes(job.status) &&
        <button className="mini-button" onClick={() => onCancel(job.id)}>取消任务</button>}
      {cacheSummaryText(job) && <p className="job-cache">{cacheSummaryText(job)}</p>}
      {job.result?.file && <a href={projectFile(projectId, job.result.file)} target="_blank" rel="noreferrer">
        打开成片 · 工程 rev_{job.inputRevision}
      </a>}
    </article>)}
    {!jobs.length && <p className="project-note">暂无任务。</p>}
    {completedVideo && <p className="project-note">
      最新成片：{completedVideo.result?.frames} 帧 / {completedVideo.result?.seconds?.toFixed(2)}s。后续编辑不改变已经导出的版本。
    </p>}
  </section>;
}

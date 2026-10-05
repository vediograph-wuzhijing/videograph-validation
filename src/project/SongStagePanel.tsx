// SongStagePanel.tsx — 新歌工程在镜头规划之前的阶段面板：分析进度、分析摘要、人工确认、兜底规划。
// src/song/ui/AnalysisCorrector 的局部指令（bpmShift/offset/逐词）与服务端整层替换契约不一致，暂未挂载；此处只做阶段推进的最小入口。
import { useEffect, useState } from 'react';
import { projectApi, type AnalysisSummary, type VideoProject } from './api';

const stageLabel: Record<string, string> = {
  'analysis-pending': '分析中：节拍 / 段落 / 歌词',
  'analysis-failed': '分析失败',
  'analysis-draft': '分析草稿：待确认',
  'analysis-confirmed': '分析已确认：待规划镜头',
};

export function SongStagePanel({ project, busy, onProject, onAction }: { project: VideoProject; busy: boolean; onProject: (project: VideoProject) => void; onAction: (task: () => Promise<void>) => Promise<boolean> }) {
  const status = project.status!;
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  // 分析摘要只随工程版本变化：每个版本拉一次，不轮询；换版本时保留旧摘要直到新摘要到达，避免闪烁和按钮短暂失效。
  useEffect(() => {
    if (!['analysis-draft', 'analysis-confirmed'].includes(status)) { setSummary(null); setAnalysisError(''); return; }
    let stopped = false;
    projectApi<AnalysisSummary>(`/projects/${project.id}/song/analysis`)
      .then((data) => { if (!stopped) { setSummary(data); setAnalysisError(''); } })
      .catch((error: unknown) => { if (!stopped) setAnalysisError(error instanceof Error ? error.message : String(error)); });
    return () => { stopped = true; };
  }, [project.id, project.revision, status]);
  const current = summary?.inputRevision === project.revision;
  const rhythm = summary?.data.rhythm, lines = summary?.data.lyrics?.lines ?? [];
  return <div className="song-stage">
    <div className="sidebar-title">{stageLabel[status] ?? status}</div>
    <p className="project-note">分析来源：{project.analysis.source || '未知'}{project.analysis.cached ? ' · 缓存命中' : ''}</p>
    {project.analysis.task && <p className="project-note">分析任务：{project.analysis.task}</p>}
    {status === 'analysis-pending' && <p className="project-note">后台正在分析音频，完成后自动进入草稿。页面可以关闭。</p>}
    {status === 'analysis-failed' && <>
      <pre className="song-stage-error">{project.analysis.error}</pre>
      <button className="action-button" disabled={busy} onClick={() => void onAction(async () => onProject(await projectApi<VideoProject>(`/projects/${project.id}/song/analysis/retry`, { expectedRevision: project.revision })))}>重新分析</button>
    </>}
    {analysisError && <p className="song-stage-error" role="alert">无法读取分析摘要：{analysisError}</p>}
    {summary && <dl className="song-stage-facts">
      <dt>时长</dt><dd>{summary.data.audio?.duration?.toFixed(2) ?? '未知'}s</dd>
      <dt>BPM</dt><dd>{rhythm?.bpm?.toFixed(2) ?? '变速'}</dd>
      <dt>拍 / 下拍</dt><dd>{rhythm?.beats?.length ?? 0} / {rhythm?.downbeats?.length ?? 0}</dd>
      <dt>段落</dt><dd>{summary.data.sections?.map((section) => section.name).join(' · ')}</dd>
      <dt>歌词</dt><dd>{lines.length ? `${lines.length} 行` : '无（器乐或未提供歌词）'}</dd>
    </dl>}
    {lines.length > 0 && <ol className="song-stage-lyrics">{lines.slice(0, 40).map((line, index) => <li key={index}><span>{line.start.toFixed(2)}</span>{line.text}</li>)}</ol>}
    {status === 'analysis-draft' && <>
      <p className="project-note">核对节拍、段落和歌词后确认；确认后才能规划镜头。agent 也可以通过 MCP 确认（会记为 agent 确认）。</p>
      <button className="action-button" disabled={busy || !current} onClick={() => void onAction(async () => onProject(await projectApi<VideoProject>(`/projects/${project.id}/song/analysis/confirm`, { expectedRevision: project.revision })))}>确认分析</button>
    </>}
    {status === 'analysis-confirmed' && <>
      <p className="project-note">确认人：{project.analysis.confirmedBy === 'mcp' ? 'agent（MCP）' : '人工'}。等待 agent 用 project_plan_submit 按歌词/段落规划镜头；也可以先用兜底规划（每段一镜，标注为非 AI 创作）。</p>
      <button className="mini-button" disabled={busy || !current} onClick={() => void onAction(async () => onProject(await projectApi<VideoProject>(`/projects/${project.id}/plan`, { expectedInputRevision: project.revision })))}>兜底规划：每段一镜</button>
    </>}
  </div>;
}

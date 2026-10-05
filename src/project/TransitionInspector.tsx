import { useEffect, useState } from 'react';
import { projectApi, type ProjectJob, type ProjectShot, type ProjectTransition, type VideoProject } from './api';

export const transitionLabels: Record<ProjectTransition['mode'], string> = { cut: '硬切', dissolve: '溶解', wipe: '方向擦除', dip: '暗场过渡', effect: '特效箱动效' };
// 人在这里只配内置转场；特效箱动效要 effectId，由 AI 经 MCP 配置。
const editableModes = ['cut', 'dissolve', 'wipe', 'dip'] as const;
const feedbackLabels: Record<string, string> = { pending: '待响应', 'needs-clarification': 'AI 提问 · 待你回复', responded: '已响应 · 待人确认', accepted: '已接受' };
type Props = {
  project: VideoProject; transition: ProjectTransition; busy: boolean;
  onProject: (project: VideoProject) => void; onJob: (job: ProjectJob) => void;
  onAction: (action: () => Promise<void>) => Promise<boolean>; onPreview: (url: string, label: string) => boolean;
};
const draftOf = (transition: ProjectTransition) => ({ revision: transition.inputRevision, intent: transition.intent,
  mode: transition.mode, duration: transition.duration, easing: transition.easing, direction: transition.direction });

export function TransitionInspector(props: Props) {
  const { project, transition } = props;
  const left = project.shots.find((shot) => shot.id === transition.fromShotId);
  const right = project.shots.find((shot) => shot.id === transition.toShotId);
  // 重新规划镜头后，转场可能短暂引用已不存在的镜头；提示而不是白屏。
  if (!left || !right) return <section className="project-transition-inspector"><p className="project-note">这个转场引用的镜头（{transition.fromShotId} → {transition.toShotId}）已不在当前工程中，等待工程刷新。</p></section>;
  return <TransitionEditor {...props} left={left} right={right} />;
}

function TransitionEditor({ project, transition, busy, onProject, onJob, onAction, onPreview, left, right }: Props & { left: ProjectShot; right: ProjectShot }) {
  const [draft, setDraft] = useState(() => draftOf(transition));
  const [feedback, setFeedback] = useState('');
  const [feedbackRevision, setFeedbackRevision] = useState(transition.inputRevision);
  const [addressed, setAddressed] = useState<string[]>([]);
  const [previewed, setPreviewed] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const stale = draft.revision !== transition.inputRevision;
  const pending = (transition.feedback ?? []).filter((note) => note.status !== 'accepted');
  const responded = pending.filter((note) => note.status === 'responded');
  const prefix = `/projects/${project.id}/transitions/${transition.id}`;
  useEffect(() => { setPreviewed(false); setReviewed(false); setAddressed([]); }, [transition.inputToken, left.inputToken, right.inputToken]);
  const adopt = (next: VideoProject) => { onProject(next); const fresh = next.transitions.find((entry) => entry.id === transition.id); if (fresh) setDraft(draftOf(fresh)); };
  const preview = (before = false) => onAction(async () => {
    const data = await projectApi<{ url: string; range: { start: number; end: number; only: string } }>(`/projects/${project.id}/preview`, { transitionId: transition.id, version: before ? 'before-feedback' : 'current' });
    const q = new URLSearchParams({ only: data.range.only, t: String(data.range.start), rangeStart: String(data.range.start), rangeEnd: String(data.range.end) });
    const accepted = onPreview(`${data.url}/?${q}`, before ? '修改前转场' : '当前转场候选');
    if (!before && accepted) setPreviewed(true);
  });
  return <section className="project-transition-inspector">
    <div className="sidebar-title">转场 / {transitionLabels[transition.mode]}<span>v{transition.inputRevision}</span></div>
    <p className="project-note">{left.title} → {right.title}<br />切点 {right.start.toFixed(3)}s；过渡在切点后进行，保留全片时间轴。</p>
    <div className="project-inspector-actions">
      <button className="mini-button" disabled={busy || transition.status === 'needs-generation'} onClick={() => void preview()}>预览这段转场</button>
      <button className="mini-button" disabled={busy || transition.status === 'needs-generation'} onClick={() => void onAction(async () => onJob(await projectApi<ProjectJob>(prefix + '/validate', {})))}>转场 5 帧校验</button>
      <button className="mini-button" disabled={busy} onClick={() => void onAction(async () => adopt(await projectApi<VideoProject>(prefix, { expectedInputRevision: transition.inputRevision, patch: { locked: !transition.locked } })))}>{transition.locked ? '解锁转场' : '锁定转场'}</button>
      {transition.reviewBaseline && <button className="mini-button" disabled={busy} onClick={() => void preview(true)}>预览修改前转场</button>}
    </div>
    {stale && <div className="shot-lint">转场已在外部改变，当前草稿基于旧版本。<button className="mini-button" onClick={() => setDraft(draftOf(transition))}>载入最新转场</button></div>}
    <label className="field"><span>转场指导 / 想怎样连接两个镜头</span><textarea rows={4} value={draft.intent} disabled={transition.locked} onChange={(event) => setDraft({ ...draft, intent: event.target.value })} /></label>
    <button className="action-button" disabled={busy || stale || transition.locked || !draft.intent.trim()} onClick={() => void onAction(async () => adopt(await projectApi<VideoProject>(prefix, { expectedInputRevision: draft.revision, patch: { intent: draft.intent } })))}>保存指导，等待配置</button>
    <label className="field"><span>效果类型</span><select aria-label="转场类型" value={draft.mode} disabled={transition.locked} onChange={(event) => setDraft({ ...draft, mode: event.target.value as ProjectTransition['mode'], duration: event.target.value === 'cut' ? 0 : draft.duration || .25 })}>{Object.entries(transitionLabels).filter(([value]) => (editableModes as readonly string[]).includes(value) || value === draft.mode).map(([value, label]) => <option key={value} value={value} disabled={value === 'effect'}>{label}</option>)}</select></label>
    <label className="field"><span>时长 / 秒</span><input type="number" step="0.01" min="0" max={Math.min(1.5, (right.end - right.start) / 2)} value={draft.duration} disabled={transition.locked || draft.mode === 'cut'} onChange={(event) => setDraft({ ...draft, duration: Number(event.target.value) })} /></label>
    <label className="field"><span>节奏曲线</span><select value={draft.easing} disabled={transition.locked} onChange={(event) => setDraft({ ...draft, easing: event.target.value as ProjectTransition['easing'] })}><option value="smooth">平滑起落</option><option value="linear">匀速</option></select></label>
    {draft.mode === 'wipe' && <label className="field"><span>擦除方向</span><select value={draft.direction} disabled={transition.locked} onChange={(event) => setDraft({ ...draft, direction: event.target.value as ProjectTransition['direction'] })}><option value="left">从左到右</option><option value="right">从右到左</option></select></label>}
    {pending.length > 0 && <div className="project-transition-feedback"><strong>这次配置响应哪些意见？</strong>{pending.map((note) => <label key={note.id}><input type="checkbox" checked={addressed.includes(note.id)} onChange={(event) => setAddressed(event.target.checked ? [...addressed, note.id] : addressed.filter((id) => id !== note.id))} /><span>{note.text}<small>{feedbackLabels[note.status]}</small></span></label>)}</div>}
    <button className="action-button" disabled={busy || stale || transition.locked} onClick={() => void onAction(async () => {
      const { mode, duration, easing, direction } = draft;
      adopt(await projectApi<VideoProject>(prefix + '/config', { expectedInputRevision: draft.revision, config: { mode, duration, easing, direction }, addressedFeedbackIds: addressed, author: 'human' }));
    })}>保存效果配置</button>
    <label className="field"><span>针对这个转场追加意见</span><textarea rows={3} value={feedback} disabled={transition.locked} onChange={(event) => { if (!feedback) setFeedbackRevision(transition.inputRevision); setFeedback(event.target.value); }} placeholder="例如：用上一镜头的橙色扫描线带出下一镜头，不要淡入淡出。" /></label>
    {feedback.trim() && feedbackRevision !== transition.inputRevision && <div className="shot-lint">转场已更新到 v{transition.inputRevision}（意见草稿基于 v{feedbackRevision}）。<button className="mini-button" onClick={() => setFeedbackRevision(transition.inputRevision)}>基于最新版本提交</button></div>}
    <button className="mini-button" disabled={busy || transition.locked || !feedback.trim() || feedbackRevision !== transition.inputRevision} onClick={() => void onAction(async () => { adopt(await projectApi<VideoProject>(prefix + '/feedback', { expectedInputRevision: feedbackRevision, text: feedback })); setFeedback(''); })}>添加转场修改意见</button>
    {responded.length > 0 && <div className="project-review-box"><p>配置已响应意见；请检查实际两镜头过渡后再采用。</p>
      <label className="project-review-confirm"><input type="checkbox" disabled={!previewed || transition.status !== 'ready'} checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />我已检查当前转场候选</label>
      <button className="action-button" disabled={busy || !reviewed || transition.status !== 'ready'} onClick={() => void onAction(async () => adopt(await projectApi<VideoProject>(prefix + '/accept-feedback', { expectedInputRevision: transition.inputRevision, feedbackIds: responded.map((note) => note.id) })))}>采用此转场修改</button>
      <button className="mini-button" disabled={busy || transition.locked} onClick={() => void onAction(async () => adopt(await projectApi<VideoProject>(prefix + '/reject-feedback', { expectedInputRevision: transition.inputRevision })))}>拒绝候选，恢复原转场</button>
    </div>}
    <p className="project-note">当前状态：{transition.status === 'ready' ? '已验证 / 可用' : transition.status === 'needs-generation' ? '新的指导尚未配置' : '配置待验证'}。改变转场不会改写两侧镜头源码；原语只有四种，复杂形变仍需后续扩展。</p>
  </section>;
}

// Timeline.tsx — 审阅室的全片时间线：段落、镜头（按时长）、转场、意见标记；点击定位。
import { useMemo } from 'react';
import type { VideoProject } from './api';

const feedbackTone: Record<string, string> = { pending: 'pending', 'needs-clarification': 'question', responded: 'responded', accepted: 'accepted' };
const feedbackText: Record<string, string> = { pending: '待 AI 处理', 'needs-clarification': 'AI 提问待回复', responded: '待你确认', accepted: '已采用' };

export function Timeline({ project, selectedId, selectedTransitionId, playhead, onSelectShot, onSelectTransition, onSeekShot }: {
  project: VideoProject; selectedId: string | null; selectedTransitionId: string | null;
  /** 预览播放器广播的当前时间（约 4Hz）；没有在播放时为 null。 */
  playhead: number | null;
  onSelectShot: (id: string) => void; onSelectTransition: (id: string) => void;
  /** 点击带时间锚点的镜头意见：选中镜头并从锚点时间开始预览。 */
  onSeekShot: (id: string, t: number) => void;
}) {
  const duration = project.song?.duration ?? Math.max(1, ...project.shots.map((shot) => shot.end));
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;
  const sections = project.song?.sections ?? [];
  const ticks = useMemo(() => {
    const step = duration > 120 ? 15 : duration > 40 ? 10 : 5;
    return Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step);
  }, [duration]);
  const markers = [...project.shots.map((shot) => ({ target: shot, kind: 'shot' as const })), ...(project.transitions ?? []).map((transition) => ({ target: transition, kind: 'transition' as const }))]
    .flatMap(({ target, kind }) => (target.feedback ?? []).map((note) => {
      const shot = kind === 'shot' ? project.shots.find((entry) => entry.id === target.id) : project.shots.find((entry) => entry.id === (target as { toShotId: string }).toShotId);
      return { note, kind, targetId: target.id, t: note.anchor?.t ?? shot?.start ?? 0, anchored: note.anchor?.t !== undefined };
    }));
  const mm = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  return <div className="timeline" aria-label="全片时间线">
    <div className="timeline-ruler">{ticks.map((t) => <span key={t} style={{ left: pct(t) }}>{mm(t)}</span>)}</div>
    {sections.length > 0 && <div className="timeline-sections">{sections.map((section, index) =>
      <span key={`${section.name}-${index}`} className={`timeline-section tone-${index % 4}`} style={{ left: pct(section.start), width: pct(section.end - section.start) }} title={`${section.name} · ${section.start.toFixed(1)}–${section.end.toFixed(1)}s`}>{section.name}</span>)}</div>}
    <div className="timeline-track">
      {project.shots.map((shot, index) => {
        const open = (shot.feedback ?? []).filter((note) => note.status !== 'accepted').length;
        return <button key={shot.id} type="button" className={`timeline-shot status-${shot.status} ${selectedId === shot.id ? 'is-selected' : ''}`}
          style={{ left: pct(shot.start), width: pct(shot.end - shot.start) }} onClick={() => onSelectShot(shot.id)}
          title={`${String(index + 1).padStart(2, '0')} ${shot.title} · ${shot.start.toFixed(2)}–${shot.end.toFixed(2)}s${open ? ` · ${open} 条意见未完成` : ''}`} aria-label={`镜头 ${index + 1} ${shot.title}`}>
          <span>{String(index + 1).padStart(2, '0')}</span>
        </button>;
      })}
      {(project.transitions ?? []).map((transition) => {
        const at = project.shots.find((shot) => shot.id === transition.toShotId)?.start ?? 0;
        return <button key={transition.id} type="button" className={`timeline-transition mode-${transition.mode} ${selectedTransitionId === transition.id ? 'is-selected' : ''}`}
          style={{ left: pct(at) }} onClick={() => onSelectTransition(transition.id)} title={`转场 ${transition.mode}${transition.mode === 'cut' ? '' : ` ${transition.duration.toFixed(2)}s`} · ${transition.intent}`} aria-label={`转场 ${transition.fromShotId} 到 ${transition.toShotId}`} />;
      })}
      {playhead !== null && <span className="timeline-playhead" style={{ left: pct(playhead) }} aria-hidden="true" />}
    </div>
    <div className="timeline-markers">{markers.map(({ note, kind, targetId, t, anchored }) =>
      <button key={note.id} type="button" className={`timeline-marker tone-${feedbackTone[note.status] ?? 'pending'}`} style={{ left: pct(t) }}
        onClick={() => (kind === 'transition' ? onSelectTransition(targetId) : anchored ? onSeekShot(targetId, t) : onSelectShot(targetId))} title={`${feedbackText[note.status] ?? note.status}${anchored ? ` · @${t.toFixed(2)}s` : ''} · ${note.text.slice(0, 60)}`} aria-label={`意见：${note.text.slice(0, 30)}`} />)}</div>
  </div>;
}

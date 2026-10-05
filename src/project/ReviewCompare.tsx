// ReviewCompare.tsx — FB-02：修改前 / 当前候选并排对比（同一时间点静帧，可切双播放器），
// 采用/拒绝沿用既有接口与“我已检查当前候选”确认约束；AI 不能接受意见，只有人可以。
import { useEffect, useMemo, useState } from 'react';
import { projectApi, projectFile, type ProjectJob, type ProjectShot, type StillsImage, type VideoProject } from './api';

type Props = {
  project: VideoProject;
  shot: ProjectShot;
  busy: boolean;
  onClose: () => void;
  onProject: (project: VideoProject) => void;
  onAction: (action: () => Promise<void>) => Promise<boolean>;
};
type Version = 'current' | 'before-feedback';

export function ReviewCompare({ project, shot, busy, onClose, onProject, onAction }: Props) {
  const responded = (shot.feedback ?? []).filter((note) => note.status === 'responded');
  const span = shot.end - shot.start;
  // 对比时间点：响应意见的锚点优先，再加窗口 0/0.5/1；两列必须同一组时间。
  const times = useMemo(() => {
    const list = [
      ...responded.map((note) => note.anchor?.t).filter((t): t is number => Number.isFinite(t)).map((t) => Math.round(t * 1000) / 1000),
      Math.round(shot.start * 1000) / 1000,
      Math.round((shot.start + span * .5) * 1000) / 1000,
      Math.round((shot.start + span) * 1000) / 1000,
    ];
    return [...new Set(list)].slice(0, 6);
  }, [shot.id, shot.inputToken]);
  const [selected, setSelected] = useState(times[0] ?? shot.start);
  // 人看过的那一版：候选在对比期间被 AI 再次改写时，旧的“已检查”与静帧/播放器全部作废。
  const [seen, setSeen] = useState({ token: shot.inputToken, revision: shot.inputRevision });
  const [mode, setMode] = useState<'stills' | 'players'>('stills');
  const [stills, setStills] = useState<Partial<Record<Version, StillsImage[]>>>({});
  const [stillsState, setStillsState] = useState<Partial<Record<Version, string>>>({});
  const [players, setPlayers] = useState<Partial<Record<Version, string>>>({});
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (seen.token === shot.inputToken) return;
    setSeen({ token: shot.inputToken, revision: shot.inputRevision });
    setStills({}); setStillsState({}); setPlayers({}); setReviewed(false);
  }, [shot.inputToken]);

  // 两个版本各起一个 stills 任务并轮询到完成；失败信息进列头，不阻塞另一列。
  useEffect(() => {
    if (!shot.reviewBaseline) return;
    let cancelled = false;
    const poll = async (jobId: string): Promise<ProjectJob> => {
      for (;;) {
        if (cancelled) throw new Error('对比已关闭');
        const fresh = await projectApi<ProjectJob>(`/projects/${project.id}/jobs/${jobId}`);
        if (['done', 'error', 'cancelled'].includes(fresh.status)) return fresh;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    };
    for (const version of ['current', 'before-feedback'] as Version[]) {
      setStillsState((current) => ({ ...current, [version]: '渲染中…' }));
      void projectApi<ProjectJob>(`/projects/${project.id}/stills`, { shotId: shot.id, times, version })
        .then(async (job) => ({ fresh: await poll(job.id), version }))
        .then(({ fresh, version }) => {
          if (cancelled) return;
          if (fresh.status !== 'done') { setStillsState((current) => ({ ...current, [version]: fresh.error ?? fresh.status })); return; }
          setStills((current) => ({ ...current, [version]: fresh.result?.stills?.images ?? [] }));
          setStillsState((current) => ({ ...current, [version]: '' }));
        })
        .catch((failure) => { if (!cancelled) setStillsState((current) => ({ ...current, [version]: String(failure) })); });
    }
    return () => { cancelled = true; };
  }, [project.id, shot.id, shot.inputToken, times]);

  // 双播放器：两列都从选中时间起播；当前列即“检查当前候选”。
  useEffect(() => {
    if (mode !== 'players') return;
    let cancelled = false;
    for (const version of ['current', 'before-feedback'] as Version[]) {
      if (players[version]) continue;
      void projectApi<{ url: string; range?: { start: number; end: number } }>(`/projects/${project.id}/preview`, { shotId: shot.id, version })
        .then((data) => {
          if (cancelled) return;
          const start = data.range?.start ?? shot.start, end = data.range?.end ?? shot.end;
          const query = new URLSearchParams({ only: shot.id, t: String(selected), rangeStart: String(start), rangeEnd: String(end) });
          setPlayers((current) => ({ ...current, [version]: `${data.url}/?${query}` }));
        })
        .catch((failure) => { if (!cancelled) setError(String(failure)); });
    }
    return () => { cancelled = true; };
  }, [mode, project.id, shot.id, shot.inputToken, selected]);

  const bothStills = Boolean(stills.current?.length) && Boolean(stills['before-feedback']?.length);
  const bothPlayers = Boolean(players.current) && Boolean(players['before-feedback']);
  const checked = mode === 'players' ? bothPlayers : bothStills;
  // 静帧按请求时间的下标对应；服务端回填的 t 可能有舍入，退而按 1ms 容差匹配，找不到就明确说没有。
  const image = (version: Version) => {
    const list = stills[version] ?? [];
    const index = times.indexOf(selected);
    const byIndex = list.length === times.length ? list[index] : undefined;
    return byIndex ?? list.find((entry) => Math.abs(entry.t - selected) < 1e-3);
  };
  const adopt = () => onAction(async () => {
    const next = await projectApi<VideoProject>(`/projects/${project.id}/shots/${shot.id}/accept-feedback`, { expectedInputRevision: seen.revision, feedbackIds: responded.map((note) => note.id) });
    onProject(next); onClose();
  });
  const reject = () => onAction(async () => {
    const next = await projectApi<VideoProject>(`/projects/${project.id}/shots/${shot.id}/reject-feedback`, { expectedInputRevision: shot.inputRevision });
    onProject(next); onClose();
  });

  return <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={`对比 ${shot.title} 的修改前与当前候选`} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <div className="fb-compare-modal">
      <header>
        <strong>{shot.title} · 修改前 ↔ 当前候选</strong>
        <button aria-label="关闭对比" autoFocus onClick={onClose}>×</button>
      </header>
      {error && <p className="shot-error" role="alert">{error}</p>}
      <div className="fb-compare-toolbar" role="tablist" aria-label="对比方式">
        <button role="tab" aria-selected={mode === 'stills'} className={mode === 'stills' ? 'active' : ''} onClick={() => setMode('stills')}>静帧对比</button>
        <button role="tab" aria-selected={mode === 'players'} className={mode === 'players' ? 'active' : ''} onClick={() => setMode('players')}>双播放器</button>
        {mode === 'stills' && <span className="fb-times" role="group" aria-label="选择对比时间点">
          {times.map((t) => <button key={t} className={t === selected ? 'active' : ''} aria-pressed={t === selected} onClick={() => setSelected(t)}>{t.toFixed(2)}s</button>)}
        </span>}
      </div>
      <div className="fb-compare-columns" role="tabpanel" aria-label={mode === 'stills' ? '静帧对比' : '双播放器'}>
        {(['before-feedback', 'current'] as Version[]).map((version) => <section key={version} className="fb-compare-column" data-version={version}>
          <h3>{version === 'current' ? '当前候选' : '修改前'}</h3>
          {mode === 'stills'
            ? stillsState[version]
              ? <p className="fb-compare-note">{stillsState[version]}</p>
              : image(version)
                ? <img src={projectFile(project.id, image(version)!.file)} alt={`${version === 'current' ? '当前候选' : '修改前'} ${selected.toFixed(2)}s 静帧`} />
                : <p className="fb-compare-note">没有 {selected.toFixed(2)}s 的静帧</p>
            : players[version]
              ? <iframe title={`${version === 'current' ? '当前候选' : '修改前'}播放器`} src={players[version]} allow="autoplay" sandbox="allow-scripts allow-same-origin" />
              : <p className="fb-compare-note">播放器启动中…</p>}
        </section>)}
      </div>
      <footer>
        <p className="project-note">技术验证不代表符合你的创作要求；两列是同一时间点的同一目标。采用只针对明确响应了意见的当前候选。</p>
        <label className="project-review-confirm"><input type="checkbox" aria-label="我已检查当前候选" disabled={shot.status !== 'ready' || !checked} checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />我已检查当前候选，确认这些意见已落实</label>
        <div className="fb-compare-actions">
          <button className="action-button" disabled={busy || shot.status !== 'ready' || !reviewed} onClick={() => void adopt()}>我已对比，采用这个修改（{responded.length} 条意见）</button>
          <button className="mini-button" disabled={busy || shot.locked} onClick={() => void reject()}>不采用候选，恢复修改前版本</button>
        </div>
      </footer>
    </div>
  </div>;
}

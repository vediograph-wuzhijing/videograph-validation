// 导演计划与审片状态来自服务端；本面板只读，不提交简报、不执行 actions、不代替人采用。
// 审阅室里它是一张“审片卡”：阶段、阻塞、AI 自评与证据图，人在这里决定是否接受。
import { projectFile, type DirectorSnapshot } from './api';

import type { DirectorLoadState } from './contracts';
export type { DirectorLoadState } from './contracts';

function describe(value: unknown): string {
  if (value == null || value === '') return '未指定';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join('、');
  return JSON.stringify(value, null, 2);
}
const styleLabels = {
  medium: '媒介', palette: '色板', typography: '字体体系', composition: '构图', motion: '运动语言', motif: '母题',
} as const;
const severityLabel = { blocking: '阻塞', warning: '注意', intentional: '有意为之' } as const;
const phaseText: Record<string, string> = { analysis: '分析中', direction: '待定导演方案', planning: '规划中', producing: '制作中', validating: '验证中', repairing: '返修中', reviewing: '审片中', 'awaiting-human': '等待你确认', 'export-ready': '可以导出', exported: '已导出' };

export function DirectorPanel({ state, revision, busy, onAccepted }: { state: DirectorLoadState; revision: number; busy?: boolean; onAccepted?: () => void }) {
  if (state.status === 'absent') return null;
  const snapshot = state.snapshot;
  const director = snapshot?.director;
  const review = snapshot?.review;
  const issues = review?.issues ?? [];
  const images = (review?.evidence ?? []).filter((entry) => typeof entry.file === 'string' && /\.png$/.test(entry.file));
  const blockingCount = issues.filter((issue) => issue.severity === 'blocking').length;
  return <section className="director-panel review-card" aria-label="导演计划（只读）">
    <div className="review-card-head">
      <div className="sidebar-title">审片 <span>AI 导演 · 只读</span></div>
      {snapshot && <span className={`phase-pill phase-${snapshot.phase}`}>{phaseText[snapshot.phase] ?? snapshot.phase}</span>}
    </div>
    {state.status === 'loading' && <p className="project-note" role="status">正在读取导演计划…</p>}
    {state.status === 'error' && <p className="director-error" role="alert">导演状态读取失败：{state.error}。将自动重试，暂不开放导出。</p>}
    {snapshot && <>
      {snapshot.revision !== revision && <p className="director-warning">导演状态与当前工程版本未同步，等待刷新。</p>}
      <div className="review-checklist">
        <span className={review?.current ? 'is-ok' : ''}>{review?.current ? '✓ AI 自评覆盖当前版本' : '○ AI 自评未覆盖当前版本'}</span>
        <span className={blockingCount === 0 ? 'is-ok' : 'is-bad'}>{blockingCount === 0 ? '✓ 无阻塞问题' : `✕ ${blockingCount} 个阻塞问题`}</span>
        <span className={review?.humanAccepted ? 'is-ok' : ''}>{review?.humanAccepted ? '✓ 你已接受' : '○ 等你看片并接受'}</span>
        <span className={snapshot.exportReady ? 'is-ok' : ''}>{snapshot.exportReady ? '✓ 可以导出' : '○ 尚未可导出'}</span>
      </div>
      {(snapshot.blockers ?? []).length > 0 && <div className="review-blockers"><strong>挡在导出前面的</strong>
        <ul>{snapshot.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>
      </div>}
      {review?.summary && <p className="review-summary">{review.summary}</p>}
      {issues.length > 0 && <details className="review-issues" open={blockingCount > 0}><summary>AI 自评问题 · {issues.length}</summary>
        <ul>{issues.map((issue, index) => <li key={index} className={`sev-${issue.severity}`}>
          <span className="sev-chip">{severityLabel[issue.severity] ?? issue.severity}</span>
          <strong>{issue.targetId ?? '全片'}{issue.t !== undefined ? ` @${issue.t.toFixed(1)}s` : ''}</strong>
          <p>{issue.detail}</p>
        </li>)}</ul>
      </details>}
      {images.length > 0 && <details className="review-evidence"><summary>审片证据 · {images.length} 张</summary>
        <div className="evidence-grid">{images.slice(0, 48).map((entry, index) => <a key={`${entry.jobId}:${index}`} href={projectFile(snapshot.projectId, entry.file!)} target="_blank" rel="noreferrer" title={`${String(entry.kind ?? '')} ${String(entry.shotId ?? entry.transitionId ?? '全片')}`}>
          <img src={projectFile(snapshot.projectId, entry.file!)} alt={`证据 ${String(entry.shotId ?? '')}`} loading="lazy" />
        </a>)}</div>
      </details>}
      {review?.current && !review.humanAccepted && onAccepted && <button className="action-button accept-button" disabled={busy || snapshot.revision !== revision || blockingCount > 0} title={blockingCount > 0 ? 'AI 自评仍有阻塞问题：需要先返修或由 AI 按你的决定更新自评' : ''} onClick={onAccepted}>我已检查并接受当前导演候选</button>}
      {director && <details className="review-plan"><summary>导演方案 v{director.version}</summary>
        <dl className="director-facts">
          <dt>意图</dt><dd>{describe(director.brief?.intent)}</dd>
          <dt>受众</dt><dd>{describe(director.brief?.audience)}</dd>
          <dt>必须保留</dt><dd>{describe(director.brief?.mustKeep)}</dd>
          <dt>必须避免</dt><dd>{describe(director.brief?.mustAvoid)}</dd>
          {Object.entries(styleLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{describe(director.style?.[key as keyof typeof styleLabels])}</dd></div>)}
        </dl>
        <strong className="director-subtitle">节奏计划 · {director.rhythm?.sections?.length ?? 0} 段</strong>
        <ol className="director-list">{(director.rhythm?.sections ?? []).map((section, index) => <li key={`${section.sectionIndex}:${index}`}><strong>段落 {section.sectionIndex} · 能量 {section.energy}</strong><p>{section.intent}</p></li>)}</ol>
      </details>}
      {(snapshot.actions ?? []).length > 0 && <details className="review-plan"><summary>AI 的下一步 · {snapshot.actions.length}</summary>
        <ol className="director-list">{snapshot.actions.map((action) => <li key={action.id} data-blocked={Boolean(action.blocked)}>
          <strong>{action.kind}{action.targetId ? ` · ${action.targetId}` : ''}{action.blocked ? ' · 已阻塞' : ''}</strong><p>{action.reason}</p>
        </li>)}</ol>
      </details>}
    </>}
  </section>;
}

// FeedbackComposer.tsx — FB-02：人的意见输入（锚点/保留项/区域）与意见卡列表（响应、澄清、回复）。
// 键盘可完成全部操作；状态用符号+文字区分，不只靠颜色。
import { useRef, useState } from 'react';
import { projectApi, projectFile, type FeedbackAnchor, type FeedbackAspect, type ProjectFeedback, type ProjectShot, type VideoProject } from './api';

const ASPECTS: Array<{ value: FeedbackAspect; label: string }> = [
  { value: 'composition', label: '构图' }, { value: 'motion', label: '运动' }, { value: 'typography', label: '文字' },
  { value: 'color', label: '配色' }, { value: 'timing', label: '时序' }, { value: 'lyrics', label: '歌词' }, { value: 'other', label: '其他' },
];
const QUICK_PRESERVE = ['歌词时序', '镜头时长', '配色', '文字内容'];
const STATUS: Record<string, string> = { pending: '○ 待 AI 响应', 'needs-clarification': '◐ AI 提问 · 待你回复', responded: '◑ 已响应 · 待人确认', accepted: '✓ 已接受' };
const ASPECT_LABEL: Record<string, string> = Object.fromEntries(ASPECTS.map(({ value, label }) => [value, label]));

export function anchorChips(note: ProjectFeedback, elementName: (id: string) => string): string[] {
  const anchor = note.anchor ?? {};
  const chips: string[] = [];
  if (anchor.t !== undefined) chips.push(`@${anchor.t.toFixed(2)}s`);
  if (anchor.range) chips.push(`${anchor.range.start.toFixed(2)}–${anchor.range.end.toFixed(2)}s`);
  if (anchor.lyricElementId) chips.push(`元素：${elementName(anchor.lyricElementId)}`);
  if (anchor.region) chips.push(`区域 ${Math.round(anchor.region.x * 100)}%,${Math.round(anchor.region.y * 100)}% ${Math.round(anchor.region.w * 100)}%×${Math.round(anchor.region.h * 100)}%`);
  if (anchor.aspect) chips.push(`方面：${ASPECT_LABEL[anchor.aspect] ?? anchor.aspect}`);
  return chips;
}

type Props = {
  shot: ProjectShot;
  busy: boolean;
  hasPreviewTime: boolean;
  getPreviewTime: () => number | null;
  onAdd: (input: { text: string; anchor?: FeedbackAnchor; preserve?: string[] }, revision: number) => Promise<boolean>;
  onProject: (project: VideoProject) => void;
  projectId: string;
};
type Region = { x: number; y: number; w: number; h: number };

export function FeedbackComposer({ shot, busy, hasPreviewTime, getPreviewTime, onAdd, onProject, projectId }: Props) {
  const [text, setText] = useState('');
  const [revision, setRevision] = useState(shot.inputRevision);
  const [anchorT, setAnchorT] = useState<number | null>(null);
  const [elementId, setElementId] = useState('');
  const [aspect, setAspect] = useState<FeedbackAspect | ''>('');
  const [preserve, setPreserve] = useState<string[]>([]);
  const [preserveDraft, setPreserveDraft] = useState('');
  const [region, setRegion] = useState<Region | null>(null);
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState('');
  const [replyError, setReplyError] = useState('');
  const regionThumb = useRef<HTMLDivElement | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const elements = shot.lyricPlan?.elements ?? [];
  const elementName = (id: string) => elements.find((element) => element.id === id)?.name ?? id;
  const notes = shot.feedback ?? [];

  const addPreserve = (item: string) => {
    const trimmed = item.trim();
    if (trimmed && !preserve.includes(trimmed) && preserve.length < 12) setPreserve([...preserve, trimmed]);
    setPreserveDraft('');
  };
  const submit = async () => {
    const anchor: FeedbackAnchor | undefined = anchorT !== null || elementId || region || aspect !== '' ? {
      ...(anchorT !== null ? { t: anchorT } : {}),
      ...(elementId ? { lyricElementId: elementId } : {}),
      ...(region ? { region } : {}),
      ...(aspect !== '' ? { aspect } : {}),
    } : undefined;
    if (await onAdd({ text, anchor, preserve: preserve.length ? preserve : undefined }, revision)) {
      setText(''); setAnchorT(null); setElementId(''); setAspect(''); setPreserve([]); setRegion(null);
    }
  };
  const reply = async (note: ProjectFeedback) => {
    const answer = (replyDraft[note.id] ?? '').trim();
    if (!answer || replying) return;
    setReplying(note.id); setReplyError('');
    try {
      const next = await projectApi<VideoProject>(`/projects/${projectId}/shots/${shot.id}/feedback/${note.id}/reply`, { text: answer });
      onProject(next);
      setReplyDraft((current) => ({ ...current, [note.id]: '' }));
    } catch (error) { setReplyError(error instanceof Error ? error.message : String(error)); }
    finally { setReplying(''); }
  };
  // 草稿开始时记下的版本过期（AI 在这期间改了镜头）：让人明确选择基于最新版本提交。
  const revisionStale = Boolean(text.trim()) && revision !== shot.inputRevision;
  const pointerRegion = (event: React.PointerEvent) => {
    const box = regionThumb.current?.getBoundingClientRect();
    if (!box) return null;
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
  };

  return <div className="fb-composer nodrag nopan">
    <details className="fb-notes" open={notes.length > 0}>
      <summary>意见 / {notes.length}</summary>
      {notes.map((note) => <article className="fb-note" key={note.id} data-status={note.status}>
        <header><span className="fb-status">{STATUS[note.status] ?? note.status}</span>{note.author === 'mcp' && <span className="fb-author">agent 转述</span>}</header>
        <p>{note.text}</p>
        {anchorChips(note, elementName).length > 0 && <div className="fb-chips">{anchorChips(note, elementName).map((chip) => <span className="fb-chip" key={chip}>{chip}</span>)}</div>}
        {note.preserve?.length ? <div className="fb-chips">{note.preserve.map((item) => <span className="fb-chip fb-preserve" key={item}>保留 · {item}</span>)}</div> : null}
        {note.response && <div className="fb-response">
          <strong>{note.response.outcome === 'partial' ? '◑ 部分响应（仍有缺口）' : '✓ 已按意见修改'}</strong>
          {note.response.how && <p>{note.response.how}</p>}
        </div>}
        {(note.thread ?? []).map((entry, index) => <p className="fb-thread" key={index}><span>{entry.by === 'mcp' ? 'AI 问' : '你答'}</span>{entry.text}</p>)}
        {note.status === 'needs-clarification' && <div className="fb-reply">
          <label className="field"><span>回复 AI 的澄清问题</span>
            <textarea rows={2} value={replyDraft[note.id] ?? ''} onChange={(event) => setReplyDraft((current) => ({ ...current, [note.id]: event.target.value }))} /></label>
          <button className="mini-button" disabled={busy || Boolean(replying) || !(replyDraft[note.id] ?? '').trim()} onClick={() => void reply(note)}>{replying === note.id ? '发送中…' : '发送回复，意见回到待处理'}</button>
          {replyError && <p className="shot-error" role="alert">回复没发出去：{replyError}</p>}
        </div>}
      </article>)}
      {notes.length === 0 && <p className="fb-empty">还没有意见。写清“只改哪里、什么必须保留”。</p>}
    </details>

    <label className="field"><span>修改意见正文</span>
      <textarea rows={3} aria-label={`${shot.title}的修改意见`} placeholder="只改哪里？哪些必须保留？" value={text} disabled={shot.locked || busy}
        onChange={(event) => { if (!text) setRevision(shot.inputRevision); setText(event.target.value); }} /></label>

    <div className="fb-anchor-row">
      <button type="button" className="mini-button" disabled={shot.locked || busy || !hasPreviewTime}
        title={hasPreviewTime ? '取预览播放器当前时间作为锚点' : '先在右侧预览此镜头，播放后即可定位'}
        onClick={() => { const t = getPreviewTime(); if (t !== null) setAnchorT(Math.round(t * 1000) / 1000); }}>定位到当前预览时间</button>
      {anchorT !== null && <span className="fb-chip"> @{anchorT.toFixed(2)}s <button type="button" aria-label="清除时间锚点" onClick={() => setAnchorT(null)}>×</button></span>}
      {!hasPreviewTime && <small>（预览播放后可定位）</small>}
    </div>

    {elements.length > 0 && <label className="field"><span>关联歌词元素（可选）</span>
      <select aria-label={`选择${shot.title}的歌词元素`} value={elementId} disabled={shot.locked} onChange={(event) => setElementId(event.target.value)}>
        <option value="">不指定</option>
        {elements.map((element) => <option key={element.id} value={element.id}>{element.name}（{element.quote}）</option>)}
      </select></label>}

    <fieldset className="fb-aspect"><legend>方面（可选，单选）</legend>
      {ASPECTS.map(({ value, label }) => <label key={value} className="fb-aspect-option">
        <input type="radio" name={`fb-aspect-${shot.id}`} value={value} checked={aspect === value} disabled={shot.locked} onChange={() => setAspect(value)} />{label}
      </label>)}
    </fieldset>

    <div className="fb-preserve-editor">
      <label className="field"><span>必须保留（≤12 条）</span></label>
      <div className="fb-chips">
        {QUICK_PRESERVE.filter((item) => !preserve.includes(item)).map((item) => <button type="button" className="fb-quick" key={item} disabled={shot.locked || busy} onClick={() => addPreserve(item)}>+ {item}</button>)}
      </div>
      {preserve.length > 0 && <div className="fb-chips">{preserve.map((item) => <span className="fb-chip fb-preserve" key={item}>{item}<button type="button" aria-label={`移除保留项 ${item}`} onClick={() => setPreserve(preserve.filter((entry) => entry !== item))}>×</button></span>)}</div>}
      <div className="fb-preserve-input">
        <input aria-label="新增保留项" value={preserveDraft} disabled={shot.locked || preserve.length >= 12} placeholder="自定义保留项"
          onChange={(event) => setPreserveDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addPreserve(preserveDraft); } }} />
        <button type="button" className="mini-button" disabled={shot.locked || busy || !preserveDraft.trim() || preserve.length >= 12} onClick={() => addPreserve(preserveDraft)}>添加</button>
      </div>
    </div>

    <details className="fb-region">
      <summary>框选画面区域（可选）</summary>
      {shot.validation?.thumb && <div className="fb-region-thumb" ref={regionThumb}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); const start = pointerRegion(event); dragStart.current = start; if (start) setRegion({ x: start.x, y: start.y, w: 0, h: 0 }); }}
        onPointerMove={(event) => { const origin = dragStart.current; if (!origin) return; const point = pointerRegion(event); if (point) setRegion({ x: Math.min(origin.x, point.x), y: Math.min(origin.y, point.y), w: Math.abs(point.x - origin.x), h: Math.abs(point.y - origin.y) }); }}
        onPointerUp={() => { dragStart.current = null; if (region && (region.w < 0.02 || region.h < 0.02)) setRegion(null); }}>
        <img src={projectFile(projectId, `artifacts/${shot.validation.thumb}`)} alt={`${shot.title} 已验证静帧，可拖拽框选区域`} draggable={false} />
        {region && <div className="fb-region-rect" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` }} />}
      </div>}
      <div className="fb-region-inputs">
        <label>x <input type="number" aria-label="区域 x" min={0} max={1} step={0.01} disabled={!region} value={region ? Number(region.x.toFixed(2)) : 0} onChange={(event) => setRegion({ ...(region ?? { x: 0, y: 0, w: 0.2, h: 0.2 }), x: Number(event.target.value) })} /></label>
        <label>y <input type="number" aria-label="区域 y" min={0} max={1} step={0.01} disabled={!region} value={region ? Number(region.y.toFixed(2)) : 0} onChange={(event) => setRegion({ ...(region ?? { x: 0, y: 0, w: 0.2, h: 0.2 }), y: Number(event.target.value) })} /></label>
        <label>宽 <input type="number" aria-label="区域宽" min={0.01} max={1} step={0.01} disabled={!region} value={region ? Number(region.w.toFixed(2)) : 0.2} onChange={(event) => setRegion({ ...(region ?? { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), w: Number(event.target.value) })} /></label>
        <label>高 <input type="number" aria-label="区域高" min={0.01} max={1} step={0.01} disabled={!region} value={region ? Number(region.h.toFixed(2)) : 0.2} onChange={(event) => setRegion({ ...(region ?? { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), h: Number(event.target.value) })} /></label>
        <div>
          <button type="button" className="mini-button" disabled={!region} onClick={() => setRegion(region ? null : { x: 0.1, y: 0.1, w: 0.3, h: 0.3 })}>{region ? '清除区域' : '启用区域'}</button>
          {region && <span className="fb-chip">已框选 {Math.round(region.w * 100)}%×{Math.round(region.h * 100)}</span>}
        </div>
      </div>
    </details>

    {revisionStale && <div className="shot-lint">你开始写这条意见后，镜头已更新到 v{shot.inputRevision}（草稿基于 v{revision}）。请先看最新画面。
      <button type="button" className="mini-button" onClick={() => setRevision(shot.inputRevision)}>基于最新版本提交</button></div>}
    <button type="button" className="mini-button fb-submit" disabled={!text.trim() || shot.locked || busy || revisionStale} onClick={() => void submit()}>添加意见，只修改此镜头</button>
    <small>保留原始意图 · 新版本需人工接受</small>
  </div>;
}

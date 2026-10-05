// EffectsBox.tsx — 特效箱（审阅室里的“效果和预设”）：检索、分类、实时预览、调参、查看代码。
// 人在这里挑风格，点“建议 AI 使用”把选择写成当前镜头的修改意见，由 AI 经 MCP 套用（project_shot_effects）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Sparkles, X, Code2, Wand2 } from 'lucide-react';
import { EffectPreviewer, DEMO_SOURCES, type FxEffect } from '../fx/runtime.mjs';
import { projectApi, type VideoProject } from './api';

type Kind = 'all' | 'post' | 'transition';

const loseContext = (previewer: EffectPreviewer) => {
  const gl = previewer.canvas.getContext('webgl2');
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
};

/** 详情预览画布 → 它的预览器。预览器与画布同寿命（见 EffectDetail）。 */
const detailPreviewers = new WeakMap<HTMLCanvasElement, { previewer: EffectPreviewer; release: ReturnType<typeof setTimeout> | undefined }>();

/** 卡片缩略图：整个特效箱只用一块 WebGL 画布逐个渲染成 dataURL；浏览器同时只保留约 16 个上下文，不能每次筛选都新建。 */
function useThumbnails(effects: FxEffect[]) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRef = useRef(thumbs); thumbsRef.current = thumbs;
  const previewerRef = useRef<EffectPreviewer | null | undefined>(undefined);
  useEffect(() => () => { if (previewerRef.current) loseContext(previewerRef.current); previewerRef.current = undefined; }, []);
  const ids = effects.map((effect) => effect.id).join('\n');
  const effectsRef = useRef(effects); effectsRef.current = effects;
  useEffect(() => {
    const list = effectsRef.current;
    if (!list.length) return;
    let cancelled = false;
    if (previewerRef.current === undefined) {
      const canvas = document.createElement('canvas'); canvas.width = 288; canvas.height = 162;
      try { previewerRef.current = new EffectPreviewer(canvas); } catch { previewerRef.current = null; }
    }
    const previewer = previewerRef.current;
    if (!previewer) return;
    const canvas = previewer.canvas;
    const queue = list.filter((effect) => thumbsRef.current[effect.id] === undefined);
    const source = (effect: FxEffect) => effect.kind === 'transition' ? 'type' : ({ '手绘与绘画': 'scene', '印刷与版画': 'portrait', '胶片与调色': 'scene', '复古与数字': 'shapes', '生成层': 'scene', '镜头与扭曲': 'scene', '画面版式': 'portrait' } as Record<string, string>)[effect.category ?? ''] ?? 'type';
    const step = () => {
      if (cancelled) return;
      const batch: Record<string, string> = {};
      for (const effect of queue.splice(0, 8)) {
        try { previewer.render(effect, { t: 1.0, source: source(effect), toSource: 'shapes', progress: effect.kind === 'transition' ? 0.5 : undefined }); batch[effect.id] = canvas.toDataURL('image/jpeg', 0.82); }
        catch { batch[effect.id] = ''; }
      }
      setThumbs((previous) => ({ ...previous, ...batch }));
      if (queue.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return () => { cancelled = true; };
  }, [ids]);
  return thumbs;
}

function ParamControl({ name, spec, value, onChange }: { name: string; spec: FxEffect['params'][string]; value: unknown; onChange: (value: unknown) => void }) {
  const type = spec.type ?? 'float';
  const label = spec.label ?? name;
  if (type === 'bool') return <label className="fx-param fx-param-bool"><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
  if (type === 'color') return <label className="fx-param"><span>{label}</span><input type="color" value={String(value)} onChange={(event) => onChange(event.target.value)} /><code>{String(value)}</code></label>;
  if (type === 'float' || type === 'int') {
    const min = spec.min ?? 0, max = spec.max ?? Math.max(1, Number(spec.default) * 2 || 1);
    return <label className="fx-param"><span>{label}</span><input type="range" min={min} max={max} step={type === 'int' ? 1 : (max - min) / 200} value={Number(value)} onChange={(event) => onChange(type === 'int' ? Math.round(Number(event.target.value)) : Number(event.target.value))} /><code>{Number(value).toFixed(type === 'int' ? 0 : 3)}</code></label>;
  }
  return <label className="fx-param"><span>{label}</span><code>{JSON.stringify(value)}</code></label>;
}

/** 详情：实时动画预览（requestAnimationFrame）、演示素材、拍速、参数、代码，以及“建议 AI 使用”。 */
function EffectDetail({ effect, onClose, shotTitle, onSuggest, busy }: { effect: FxEffect; onClose: () => void; shotTitle?: string; onSuggest?: (text: string) => void; busy?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(Object.entries(effect.params).map(([name, spec]) => [name, spec.default])));
  const [source, setSource] = useState(effect.kind === 'transition' ? 'type' : 'scene');
  const [bpm, setBpm] = useState(120);
  const [error, setError] = useState('');
  const valuesRef = useRef(values); valuesRef.current = values;
  // 一块画布只建一个预览器，上下文只在画布真正卸载后释放；切换素材/拍速/动效走 ref 读最新值。
  // 原因：loseContext 之后同一块画布的 getContext 仍返回那个已丢失的上下文，在它上面重建预览器必然
  // “着色器编译失败：null”。释放放到下一轮任务里，同一块画布被重新挂上（StrictMode 的二次挂载）时取消。
  const liveRef = useRef({ effect, source, bpm }); liveRef.current = { effect, source, bpm };
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    let held = detailPreviewers.get(canvas);
    if (held) clearTimeout(held.release);
    else {
      try { held = { previewer: new EffectPreviewer(canvas), release: undefined }; detailPreviewers.set(canvas, held); }
      catch (err) { setError(String(err)); return; }
    }
    const { previewer } = held;
    let frame = 0, failed = ''; const start = performance.now();
    const loop = () => {
      const t = (performance.now() - start) / 1000, live = liveRef.current;
      // 出错后不停表：换到能编译通过的动效或素材时，预览自己恢复，错误提示同步清掉。
      try { previewer.render(live.effect, { values: valuesRef.current, t, source: live.source, toSource: 'shapes', bpm: live.bpm, progress: live.effect.kind === 'transition' ? Math.min(1, Math.max(0, ((t % 3) - 0.6) / 1.6)) : undefined }); if (failed) { failed = ''; setError(''); } }
      catch (err) { const message = String(err); if (message !== failed) { failed = message; setError(message); } }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      held.release = setTimeout(() => { detailPreviewers.delete(canvas); loseContext(previewer); }, 0);
    };
  }, []);
  const changed = Object.entries(values).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(effect.params[name]?.default));
  const suggestion = `请为此镜头套用特效箱「${effect.name}」（${effect.id}）${changed.length ? `，参数 ${changed.map(([name, value]) => `${name}=${typeof value === 'number' ? +value.toFixed(4) : value}`).join('，')}` : '（默认参数）'}。套用后用 project_filmstrip 自查节拍与画面，保留歌词时序与配色意图。`;
  return <div className="fx-detail" role="dialog" aria-modal="true" aria-label={`${effect.name} 预览`} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <header><div><span className="eyebrow">{effect.kind === 'transition' ? '转场' : '镜头后期'} · {effect.category} · {effect.id}</span><h3>{effect.name}</h3></div><button className="icon-button" aria-label="关闭特效预览" autoFocus onClick={onClose}><X size={16} /></button></header>
    <div className="fx-detail-body">
      <div className="fx-stage">
        <canvas ref={canvasRef} width={960} height={540} />
        {error && <pre className="fx-error">{error}</pre>}
        <div className="fx-stage-controls">
          <div className="segmented" role="group" aria-label="演示素材">{Object.entries(DEMO_SOURCES).map(([key, label]) => <button key={key} className={source === key ? 'is-active' : ''} title={label} onClick={() => setSource(key)}>{label.split('：')[0]}</button>)}</div>
          <label className="fx-bpm">拍速 <input type="number" min={60} max={200} value={bpm} onChange={(event) => setBpm(Math.min(200, Math.max(60, Number(event.target.value) || 120)))} /> BPM</label>
        </div>
      </div>
      <aside className="fx-side">
        <p className="fx-summary">{effect.summary}</p>
        {effect.when && <p className="fx-when"><strong>适合</strong>{effect.when}</p>}
        {effect.avoid && <p className="fx-avoid"><strong>避免</strong>{effect.avoid}</p>}
        {Object.keys(effect.params).length > 0 && <div className="fx-params"><h4>参数</h4>{Object.entries(effect.params).map(([name, spec]) =>
          <ParamControl key={name} name={name} spec={spec} value={values[name]} onChange={(value) => setValues((previous) => ({ ...previous, [name]: value }))} />)}</div>}
        {Object.keys(effect.bindings ?? {}).length > 0 && <p className="fx-bindings"><strong>节拍绑定</strong>{Object.entries(effect.bindings ?? {}).map(([name, binding]) => `${effect.params[name]?.label ?? name} ← ${({ beat: '每拍', kick: '鼓点', bar: '每小节', energy: '能量' } as Record<string, string>)[binding.to]} +${binding.amount}`).join('；')}</p>}
        <p className="fx-provenance">{effect.origin === 'gl-transitions' ? `上游 gl-transitions · 作者 ${effect.author ?? '未知'} · ${effect.license}（按需下载，不随本仓库分发）` : `本项目原创 · ${effect.license ?? 'MIT'}`}{effect.inspiredBy?.length ? ` · 参考：${effect.inspiredBy.map((entry) => entry.source).join('、')}` : ''}</p>
        {onSuggest && <button className="action-button fx-suggest" disabled={busy} onClick={() => onSuggest(suggestion)} title={suggestion}><Wand2 size={14} />建议 AI 给「{shotTitle}」使用</button>}
        <details className="fx-code"><summary><Code2 size={13} />着色器代码</summary><pre>{effect.glsl.trim()}</pre></details>
      </aside>
    </div>
  </div>;
}

export function EffectsBox({ projectId, shotId, shotTitle, shotRevision, busy, onProject }: { projectId?: string; shotId?: string; shotTitle?: string; shotRevision?: number; busy?: boolean; onProject?: (project: VideoProject) => void }) {
  const [effects, setEffects] = useState<FxEffect[]>([]);
  const [status, setStatus] = useState('正在读取特效箱…');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('post');
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState<FxEffect | null>(null);
  // 打开详情那一刻的目标镜头：之后在别处切了镜头，建议也不会写到另一个镜头上。
  const [target, setTarget] = useState<{ shotId: string; title?: string; revision: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const openEffect = (effect: FxEffect) => { setOpen(effect); setTarget(shotId && shotRevision !== undefined ? { shotId, title: shotTitle, revision: shotRevision } : null); };
  const [notice, setNotice] = useState('');
  useEffect(() => {
    projectApi<{ effects: FxEffect[]; glTransitions: { cached: number; total: number } }>('/fx/effects')
      .then((data) => { setEffects(data.effects); setStatus(`${data.effects.length} 个动效${data.glTransitions.total ? `（含 ${data.glTransitions.cached} 个 gl-transitions 转场）` : '；gl-transitions 尚未下载：让 AI 调一次 effect_search kind=transition'}`); })
      .catch((error) => setStatus(`读取失败：${error instanceof Error ? error.message : String(error)}`));
  }, []);
  const categories = useMemo(() => [...new Set(effects.filter((effect) => kind === 'all' || effect.kind === kind).map((effect) => effect.category ?? '其他'))], [effects, kind]);
  const visible = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return effects.filter((effect) => (kind === 'all' || effect.kind === kind) && (!category || effect.category === category)
      && terms.every((term) => [effect.id, effect.name, effect.summary, effect.when, ...(effect.tags ?? [])].join(' ').toLowerCase().includes(term)));
  }, [effects, query, kind, category]);
  const thumbs = useThumbnails(visible);
  const suggest = async (text: string) => {
    if (!projectId || !target || submitting) return;
    setSubmitting(true);
    try {
      const next = await projectApi<VideoProject>(`/projects/${projectId}/shots/${target.shotId}/feedback`, { expectedInputRevision: target.revision, text, preserve: ['歌词时序', '镜头时长'], anchor: { aspect: 'other' } });
      setNotice(`已写成「${target.title ?? target.shotId}」的修改意见，等待 AI 套用。`); setOpen(null); onProject?.(next);
    } catch (error) { setNotice(`没写成：${error instanceof Error ? error.message : String(error)}`); }
    finally { setSubmitting(false); }
  };
  return <div className="fx-box">
    <div className="fx-toolbar">
      <label className="fx-search"><Search size={14} /><input aria-label="搜索特效" placeholder="搜索风格或用途：risograph、水彩、卡点、glitch、胶片…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="segmented" role="group" aria-label="类型">{(['post', 'transition', 'all'] as Kind[]).map((value) => <button key={value} className={kind === value ? 'is-active' : ''} onClick={() => { setKind(value); setCategory(''); }}>{({ post: '镜头后期', transition: '转场', all: '全部' } as Record<Kind, string>)[value]}</button>)}</div>
      <span className="fx-status"><Sparkles size={13} />{status}</span>
    </div>
    <div className="fx-chips"><button className={!category ? 'is-active' : ''} onClick={() => setCategory('')}>全部类别</button>{categories.map((name) => <button key={name} className={category === name ? 'is-active' : ''} onClick={() => setCategory(name)}>{name}</button>)}</div>
    {notice && <p className="fx-notice" role="status">{notice}</p>}
    <div className="fx-grid">{visible.map((effect) => <button key={effect.id} className="fx-card" onClick={() => openEffect(effect)} aria-label={`预览 ${effect.name}`}>
      <span className="fx-thumb">{thumbs[effect.id] ? <img src={thumbs[effect.id]} alt="" /> : <Sparkles size={18} />}</span>
      <span className="fx-card-text"><strong>{effect.name}</strong><small>{effect.summary}</small></span>
      <span className="fx-card-tags">{effect.kind === 'transition' ? <em>转场</em> : null}{Object.keys(effect.bindings ?? {}).length ? <em className="is-beat">节拍</em> : null}{(effect.tags ?? []).slice(0, 2).map((tag) => <em key={tag}>{tag}</em>)}</span>
    </button>)}</div>
    {!visible.length && <p className="project-note">没有匹配的动效。</p>}
    {notice && open && <p className="fx-notice" role="status">{notice}</p>}
    {open && <EffectDetail key={open.id} effect={open} onClose={() => setOpen(null)} shotTitle={target?.title ?? target?.shotId} busy={busy || submitting} onSuggest={target ? (text) => void suggest(text) : undefined} />}
  </div>;
}

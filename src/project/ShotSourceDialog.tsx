import { X } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { projectApi } from './api';
import type { ProjectShot } from './contracts';
export interface SourceDraft {
    projectId: string;
    shotId: string;
    projectRevision: number;
    revision: number;
    code: string;
    feedbackIds: string[];
    feedback: NonNullable<ProjectShot['feedback']>;
    sharedModule?: {
        id: string;
        bindings: Array<{
            shotId: string;
            expectedInputRevision: number;
        }>;
    };
}
export function ShotSourceDialog({ source, error, busy, onChange, onClose, onSave, onSaveShared }: {
    source: SourceDraft;
    error: string;
    busy: boolean;
    onChange: (source: SourceDraft) => void;
    onClose: () => void;
    onSave: () => void;
    onSaveShared: () => void;
}) {
    const [draftBusy, setDraftBusy] = useState(false), [draftStatus, setDraftStatus] = useState(''), [draftUrl, setDraftUrl] = useState('');
    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const previous = document.activeElement;
        const dialog = dialogRef.current;
        dialog?.querySelector('textarea')?.focus();
        const containFocus = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || !dialog)
                return;
            const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input:not(:disabled), iframe, [tabindex="0"]')].filter(node => node.getClientRects().length > 0);
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        };
        dialog?.addEventListener('keydown', containFocus);
        return () => { dialog?.removeEventListener('keydown', containFocus); if (previous instanceof HTMLElement && previous.isConnected)
            previous.focus(); };
    }, []);
    const draftAction = async (action: 'check' | 'preview') => {
        setDraftBusy(true);
        setDraftStatus(action === 'check' ? '正在检查类型与着色器…' : '正在加载草稿…');
        try {
            const result = await projectApi<{
                ok?: boolean;
                url?: string;
                diagnostics?: Array<{
                    line?: number;
                    message: string;
                }>;
                shaders?: {
                    errors: string[];
                    deferred?: string;
                };
                lyricLint?: {
                    violations: Array<{
                        detail: string;
                    }>;
                };
            }>(`/projects/${source.projectId}/draft/${action}`, { shotId: source.shotId, expectedProjectRevision: source.projectRevision, code: source.code });
            if (action === 'preview' && result.url) {
                setDraftUrl(`${result.url}/?only=${encodeURIComponent(source.shotId)}`);
                setDraftStatus('正在预览未提交草稿。');
            }
            else
                setDraftStatus(result.ok ? `检查通过。${result.shaders?.deferred ?? ''}` : [...(result.diagnostics ?? []).map(d => `${d.line ? `第 ${d.line} 行：` : ''}${d.message}`), ...(result.shaders?.errors ?? []), ...(result.lyricLint?.violations ?? []).map(v => v.detail)].join('\n') || '该引擎不支持着色器快速检查，请使用正式校验。');
        }
        catch (e) {
            setDraftStatus(e instanceof Error ? e.message : String(e));
        }
        finally {
            setDraftBusy(false);
        }
    };
    return <div className="modal-overlay" onKeyDown={(event) => { if (event.key === 'Escape')
        onClose(); }}>
    <div ref={dialogRef} className="project-source-modal" role="dialog" aria-modal="true" aria-label={`${source.shotId} 源码`}>
      <header>
        <strong>{source.shotId} · 源码 / 输入 v{source.revision}</strong>
        <button aria-label="关闭源码" onClick={onClose}><X size={18}/></button>
      </header>
      {error && <p className="shot-error" role="alert">{error}</p>}
      {source.feedback.length > 0 && <div className="project-source-feedback">
        <strong>这次改动明确响应了哪些意见？</strong>
        {source.feedback.map((note) => <label key={note.id}>
          <input type="checkbox" checked={source.feedbackIds.includes(note.id)} onChange={(event) => onChange({
                    ...source,
                    feedbackIds: event.target.checked ? [...source.feedbackIds, note.id] : source.feedbackIds.filter((id) => id !== note.id),
                })}/>{note.text}
        </label>)}
      </div>}
      <div className="source-draft-tools">
        <button className="mini-button" disabled={busy || draftBusy} onClick={() => void draftAction('check')}>快速检查</button>
        <button className="mini-button" disabled={busy || draftBusy} onClick={() => void draftAction('preview')}>预览草稿</button>
        <span>草稿仅供检查，提交后才进入工程版本。</span>
      </div>
      {draftStatus && <p className="source-draft-status" role="status">{draftStatus}</p>}
      <div className={`source-draft-content${draftUrl ? ' has-preview' : ''}`}>
        <textarea aria-label="场景 TypeScript 源码" spellCheck={false} readOnly={busy || draftBusy} value={source.code} onChange={(event) => { setDraftStatus('源码已修改，需重新检查或刷新草稿预览。'); onChange({ ...source, code: event.target.value }); }}/>
        {draftUrl && <iframe title="未提交的场景草稿" src={draftUrl} sandbox="allow-scripts allow-same-origin"/>}
      </div>
      <footer>
        <span>保存为新版本，不覆盖原始文件。需要通过校验后才能作为有效产物。</span>
        <div className="source-draft-actions">
          {(source.sharedModule?.bindings.length ?? 0) > 1 && <button className="mini-button" disabled={busy || draftBusy} onClick={onSaveShared}>提交给全部 {source.sharedModule!.bindings.length} 个共用镜头</button>}
          <button className="run-button" disabled={busy || draftBusy} onClick={onSave}>{(source.sharedModule?.bindings.length ?? 0) > 1 ? '仅提交此镜头' : '提交新源码'}</button>
        </div>
      </footer>
    </div>
  </div>;
}

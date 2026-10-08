import { useEffect, useState } from 'react';
import { projectApi, serviceUrl, type VideoProject, type ProjectJob } from './api';
import './vocal.css';
import type { VocalState, VocalSetup, VocalPitchQuality } from './contracts';
import {VocalImports} from './VocalImports';

function PitchQuality({ report }: { report: VocalPitchQuality }) {
  const value = (n: number | null) => n === null ? '未可靠测出' : `${n.toFixed(1)} 音分`;
  return <details><summary>实测音高质检</summary>
    <p className="project-note">目标曲线误差中位数 {value(report.summary.medianAbsTargetErrorCents)} · P95 {value(report.summary.p95AbsTargetErrorCents)} · 可靠帧 {report.summary.voicedFrames}/{report.summary.scoredFrames}</p>
    <div className="vocal-pitch-table"><table><thead><tr><th>音符 / 别名</th><th>可靠覆盖</th><th>目标误差</th><th>实测起伏</th></tr></thead>
      <tbody>{report.notes.slice(0, 30).map((note) => <tr key={note.index}><td>{note.index + 1} · {note.lyric}</td><td>{(note.voicedCoverage * 100).toFixed(0)}%</td><td>{value(note.medianTargetErrorCents)}</td><td>{note.measuredModulation ? `${note.measuredModulation.rateHz?.toFixed(1)} Hz / ±${note.measuredModulation.depthCents.toFixed(1)} 音分` : '未测得可靠起伏'}</td></tr>)}</tbody>
    </table></div>
    {report.notes.length > 30 && <p className="project-note">显示前 30 个音符，完整结果请下载报告。</p>}
    {report.limitations.map((text) => <p className="project-note" key={text}>{text}</p>)}
  </details>;
}

export function VocalPanel({ project, busy, onProject, onAction, onJob }: { project: VideoProject; busy: boolean; onProject: (p: VideoProject) => void; onAction: (task: () => Promise<void>) => Promise<boolean>; onJob: (job: ProjectJob) => void }) {
  const [state, setState] = useState<VocalState | null>(null), [setup, setSetup] = useState<VocalSetup | null>(null);
  const [error, setError] = useState(''), [editor, setEditor] = useState<string | null>(null), [baseRevision, setBaseRevision] = useState(0);
  const path = `/projects/${project.id}/vocal`;
  useEffect(() => {
    let stopped = false;
    void projectApi<VocalState>(path).then((value) => { if (!stopped) { setState(value); setError(''); } }).catch((e: Error) => { if (!stopped) setError(e.message); });
    return () => { stopped = true; };
  }, [path, project.revision]);
  const file = (name: string) => `${serviceUrl}/projects/${project.id}/files/${name}`;
  const current = state?.projectRevision === project.revision;
  const staleEdit = editor !== null && state?.inputRevision !== baseRevision;
  return <details className="vocal-panel">
    <summary>歌声制作 <span>{state?.active ? '已采用混音' : state?.candidate ? '待试听' : '原音频'}</span></summary>
    <div className="vocal-body">
      <p className="project-note">提交乐谱 → 渲染 → 试听采用。预览与导出使用已采用混音。</p>
      {error && <p role="alert" className="song-stage-error">{error}</p>}
      <VocalImports project={project} state={state} busy={busy||editor!==null} onAction={onAction} onScore={(text,revision)=>{setBaseRevision(revision);setEditor(text);}} onDraft={async value=>{setState(value);onProject(await projectApi<VideoProject>(`/projects/${project.id}`));}} />
      <button className="mini-button" disabled={busy} onClick={() => void onAction(async () => setSetup(await projectApi<VocalSetup>(`${path}/check`)))}>检查声库配置</button>
      {setup && <p className={setup.ready ? 'project-note' : 'song-stage-error'} role="status">{setup.ready ? `${setup.bank} · ${setup.aliasCount} 个别名` : setup.error}</p>}
      {setup?.ready && <details><summary>可用发音别名</summary><pre className="vocal-aliases">{setup.aliases?.join('、')}</pre></details>}
      {!state?.draft && <p className="project-note">让 AI 通过 project_vocal_submit 写入乐谱，或在这里编辑 JSON。需要已完成的歌曲分析。</p>}
      {editor === null ? <button className="mini-button" disabled={busy || !current || !project.song} onClick={() => {
        setBaseRevision(state!.inputRevision);
        setEditor(JSON.stringify({ plan: state?.draft?.plan ?? { name: project.name, tempo: project.song?.bpm ?? 120, tracks: [{}], parts: [{ notes: [] }] }, mix: state?.draft?.mix ?? { backingGain: 0.7, vocalGain: 1 } }, null, 2));
      }}>{state?.draft ? '编辑乐谱' : '新建乐谱'}</button> : <>
        <label className="vocal-editor-label" htmlFor="vocal-score">乐谱与混音 JSON</label>
        <p className="project-note">lyric 填声库别名，text 填显示歌词；支持 pitchCurve、vibrato、volume，以及 part.pitchDeviation / dynamics。mix.processing 可启用 EQ、压缩和混响。固定 BPM，单轨，休止符为 R。</p>
        <textarea id="vocal-score" className="vocal-editor" spellCheck={false} value={editor} onChange={(e) => setEditor(e.target.value)} />
        {staleEdit && <p role="alert" className="song-stage-error">乐谱已被更新。保留你的文本，关闭后重读当前版本再合并。</p>}
        <div className="vocal-actions"><button className="mini-button" disabled={busy || staleEdit} onClick={() => void onAction(async () => {
          const payload: unknown = JSON.parse(editor);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('请输入包含 plan 和 mix 的 JSON 对象');
          const value = payload as { plan?: unknown; mix?: unknown };
          setState(await projectApi<VocalState>(path, { expectedInputRevision: baseRevision, plan: value.plan, mix: value.mix }));
          setEditor(null); onProject(await projectApi<VideoProject>(`/projects/${project.id}`));
        })}>保存乐谱</button><button className="mini-button" disabled={busy} onClick={() => setEditor(null)}>关闭编辑</button></div>
      </>}
      {state?.draft && <>
        <p className="project-note">乐谱版本 {state.inputRevision} · 伴奏 {state.draft.mix.backingGain} / 人声 {state.draft.mix.vocalGain} · {state.draft.mix.processing ? '启用 EQ / 压缩 / 混响' : '干声混合'}</p>
        <div className="vocal-actions"><button className="action-button" disabled={busy || !current || editor !== null || (setup?.ready === false && state.draft.source !== 'external')} onClick={() => void onAction(async () => onJob(await projectApi<ProjectJob>(`${path}/render`, { expectedInputRevision: state.inputRevision })))}>渲染歌声</button>
        </div>
      </>}
      {state?.candidate && <div className="vocal-audition">
        <strong>候选混音</strong><audio controls preload="none" src={file(state.candidate.mixFile)} aria-label="候选伴奏与人声混音" />
        <details><summary>人声干轨与文件</summary><audio controls preload="none" src={file(state.candidate.stemFile)} aria-label="候选人声干轨" />
          <div className="vocal-actions"><a href={file(state.candidate.stemFile)} download>人声 WAV</a>{state.candidate.ustxFile && <a href={file(state.candidate.ustxFile)} download>USTX</a>}{state.candidate.lrcFile && <a href={file(state.candidate.lrcFile)} download>LRC</a>}{state.candidate.pitchReportFile && <a href={file(state.candidate.pitchReportFile)} download>实测音高 JSON</a>}{state.candidate.bandReportFile && <a href={file(state.candidate.bandReportFile)} download>频段能量对比 JSON</a>}</div>
        </details>
        {state.candidate.report.cacheSummary ? <p className="project-note">{state.candidate.report.noteCount} 个音符 · 缓存复用 {state.candidate.report.cacheSummary.hits}，新渲染 {state.candidate.report.cacheSummary.misses}</p> : <p className="project-note">外部人声 · 已冻结源文件并按歌曲时间对齐</p>}
        {state.candidate.report.pitchQuality && <PitchQuality report={state.candidate.report.pitchQuality} />}
        {state.candidate.report.warnings?.map((warning, i) => <p className="project-note" key={i}>{warning}</p>)}
        <button className="action-button" disabled={busy || !current || editor !== null || state.active?.jobId === state.candidate.jobId} onClick={() => void onAction(async () => onProject(await projectApi<VideoProject>(`${path}/adopt`, { expectedProjectRevision: project.revision, expectedInputRevision: state.inputRevision, jobId: state.candidate!.jobId })))}>{state.active?.jobId === state.candidate.jobId ? '此候选已采用' : '采用此混音'}</button>
      </div>}
      {state?.active && <div className="vocal-audition"><strong>已采用混音</strong><audio controls preload="none" src={file(state.active.mixFile)} aria-label="已采用混音" />
        {state.active.jobId !== state.candidate?.jobId && <>
          {state.active.report.pitchQuality && <PitchQuality report={state.active.report.pitchQuality} />}
          {state.active.pitchReportFile && <a href={file(state.active.pitchReportFile)} download>已采用人声实测音高 JSON</a>}
        </>}
        <button className="mini-button" disabled={busy || !current} onClick={() => void onAction(async () => onProject(await projectApi<VideoProject>(`${path}/reset`, { expectedProjectRevision: project.revision })))}>恢复原音频</button>
        {['analysis-draft', 'analysis-confirmed'].includes(project.status ?? '') && (state.active.lyrics?.lines.length ?? 0) > 0 && <button className="mini-button" disabled={busy || !current} onClick={() => void onAction(async () => onProject(await projectApi<VideoProject>(`${path}/lyrics`, { expectedProjectRevision: project.revision })))}>将乐谱歌词用于视频分析</button>}
      </div>}
      <p className="project-note">歌词时间来自乐谱，未经音频对齐；采用混音不会自动改写视频歌词。需要真实 oto 别名，不支持自动音素化或多轨；实测报告不能代替试听。</p>
    </div>
  </details>;
}

import { useState } from 'react';
import { projectApi, type VideoProject } from './api';
import type { VocalState } from './contracts';
export function VocalImports({ project, state, busy, onAction, onDraft, onScore }: {
    project: VideoProject;
    state: VocalState | null;
    busy: boolean;
    onAction: (task: () => Promise<void>) => Promise<boolean>;
    onDraft: (state: VocalState) => Promise<void>;
    onScore: (text: string, revision: number) => void;
}) {
    const [midi, setMidi] = useState(''), [lyrics, setLyrics] = useState(''), [track, setTrack] = useState(''), [channel, setChannel] = useState('');
    const [audio, setAudio] = useState(''), [reference, setReference] = useState(''), [offset, setOffset] = useState('0'), [notice, setNotice] = useState('');
    const disabled = busy || !state || state.projectRevision !== project.revision || !project.song;
    return <details><summary>导入 MIDI 或外部人声</summary><div className="vocal-imports">
    <p className="project-note">文件使用这台工作台上的本地路径。MIDI 先生成可编辑草稿；外部人声保存后仍需渲染、试听和采用。</p>
    <label>MIDI 文件路径<input value={midi} onChange={e => setMidi(e.target.value)} placeholder="完整的 .mid 路径"/></label>
    <label>日语假名歌词<textarea value={lyrics} onChange={e => setLyrics(e.target.value)} placeholder="留空使用 MIDI 逐音符歌词；汉字请先写出读音"/></label>
    <div className="vocal-import-grid"><label>旋律轨号<input type="number" min="0" value={track} onChange={e => setTrack(e.target.value)} placeholder="只有一轨时可留空"/></label><label>通道号<input type="number" min="0" max="15" value={channel} onChange={e => setChannel(e.target.value)} placeholder="0–15"/></label></div>
    <button className="mini-button" disabled={disabled || !midi.trim()} onClick={() => void onAction(async () => {
            const result = await projectApi<{
                plan: Record<string, unknown>;
                expectedInputRevision: number;
                aliasReport: {
                    ready: boolean;
                    missing?: unknown[];
                };
            }>(`/projects/${project.id}/vocal/import-midi`, { midiPath: midi, lyrics: lyrics.trim() || undefined, trackIndex: track === '' ? undefined : Number(track), channel: channel === '' ? undefined : Number(channel) });
            onScore(JSON.stringify({ plan: result.plan, mix: state?.draft?.mix ?? { backingGain: .7, vocalGain: 1 } }, null, 2), result.expectedInputRevision);
            setNotice(result.aliasReport.ready ? '已生成乐谱草稿，请检查后保存。' : '草稿已生成，但声库别名未全部验证；请核对并补齐后保存。');
        })}>生成 MIDI 乐谱草稿</button>
    <label>外部人声干轨路径<input value={audio} onChange={e => setAudio(e.target.value)} placeholder="处理好的 WAV / FLAC 等音频"/></label>
    <label>参考人声路径（可选）<input value={reference} onChange={e => setReference(e.target.value)} placeholder="同时间范围的分离人声，用于频段比较"/></label>
    <label>干轨起点偏移（毫秒）<input type="number" min="0" value={offset} onChange={e => setOffset(e.target.value)}/></label>
    <button className="mini-button" disabled={disabled || !audio.trim()} onClick={() => void onAction(async () => {
            const next = await projectApi<VocalState>(`/projects/${project.id}/vocal/import-audio`, { expectedInputRevision: state!.inputRevision, audioPath: audio, referencePath: reference.trim() || undefined, offsetMs: Number(offset), mix: state?.draft?.mix });
            await onDraft(next);
            setNotice('已保存外部干轨，下一步渲染候选混音。');
        })}>保存外部人声草稿</button>
    {notice && <p className="project-note" role="status">{notice}</p>}
  </div></details>;
}

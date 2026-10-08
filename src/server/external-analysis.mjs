// External timing truth skips models. Absent signal features are neutral and
// explicitly labelled; metadata is checked against the actual audio file.
import { spawnSync } from 'node:child_process';
import { validateAnalysis } from '../song/contract.mjs';
import { ProjectError } from './errors.mjs';
export function prepareExternalAnalysis(path, audioHash, truth, author = 'mcp') {
    if (!truth || typeof truth !== 'object' || Array.isArray(truth))
        throw new ProjectError('truth 必须是分析对象');
    if (!Number.isFinite(truth.rhythm?.bpm))
        throw new ProjectError('truth.rhythm.bpm 必填；当前引擎不接受仅有 tempoMap 的输入。请同时提供名义 BPM 与实际拍点');
    const result = spawnSync(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,sample_rate,channels', '-of', 'json', path], { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0)
        throw new ProjectError(`读取音频元数据失败，请配置 FFPROBE_PATH：${result.error?.message ?? result.stderr.slice(-500)}`, 422);
    const info = JSON.parse(result.stdout), stream = info.streams?.find(s => s.codec_type === 'audio'), duration = Number(info.format?.duration);
    if (!stream || !Number.isFinite(duration) || duration <= 0)
        throw new ProjectError('音频时长或采样信息无效');
    if (truth.audio?.hash !== undefined && truth.audio.hash !== audioHash)
        throw new ProjectError('truth.audio.hash 与实际音频不一致', 409);
    if (truth.audio?.duration !== undefined && Math.abs(truth.audio.duration - duration) > .1)
        throw new ProjectError('truth 时长与实际音频相差超过100ms', 409);
    const supplied = structuredClone(truth), neutral = [], provenance = { ...supplied.provenance };
    const entry = tool => ({ tool, version: '1', startedAt: Date.now(), confidence: tool === 'neutral-placeholder' ? 0 : 1 });
    const envelopes = supplied.envelopes ?? { frameRate: 1, rms: Array(Math.max(2, Math.ceil(duration) + 1)).fill(0) };
    const onsets = supplied.onsets ?? { kick: [], snare: [], hat: [], vocal: [] };
    for (const layer of ['audio', 'rhythm', 'sections', ...(supplied.lyrics ? ['lyrics'] : [])])
        provenance[layer] ??= entry(layer === 'audio' ? 'ffprobe' : 'external-truth');
    for (const layer of ['envelopes', 'onsets']) {
        if (!supplied[layer]) {
            neutral.push(layer);
            provenance[layer] = entry('neutral-placeholder');
        }
        else
            provenance[layer] ??= entry('external-truth');
    }
    const lyrics = supplied.lyrics ? { ...supplied.lyrics, textSource: supplied.lyrics.textSource ?? 'user', humanConfirmed: author === 'human' && supplied.lyrics.humanConfirmed === true } : undefined;
    const analysis = validateAnalysis({ ...supplied, schema: 'videograph-analysis/v2', audio: { hash: audioHash, duration, sampleRate: Number(stream.sample_rate), channels: stream.channels, decoderOffset: supplied.audio?.decoderOffset ?? 0 },
        envelopes, onsets, provenance, overrides: supplied.overrides ?? [], ...(lyrics ? { lyrics } : {}) });
    return { analysis, neutralLayers: neutral };
}

// USTX + explicit oto aliases -> shared pitch timeline, neighbour-aware phoneme
// layout, cached resampling, envelopes/dynamics, dry WAV and measured F0 report.
// Resampler padding is cropped before assembly; mix processing stays in the worker.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, delimiter, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseYaml } from './yaml-lite.mjs';
import { TICKS_PER_BEAT, UstxError, validateUstxText } from './ustx.mjs';
import { loadVoicebank } from './oto.mjs';
import { buildResamplerArgs, callResampler, RESAMPLER_CONTRACTS } from './resampler.mjs';
import { readWav, resampleLinear, writeWavMono16, WAV_SAMPLE_RATE } from './wav.mjs';
import { concatenate } from './wavtool.mjs';
import { createPitchModel, curvePoints, range } from './expressions.mjs';
import { layoutPhonemes, applyEnvelope } from './phoneme-layout.mjs';
import { pitchReport } from './pitch-analysis.mjs';

const fail = (message) => { throw new UstxError(message); };
const msToSamples = (ms) => Math.round(ms * WAV_SAMPLE_RATE / 1000);

function toolFingerprint(argv) {
  return argv.map((arg, index) => {
    const candidates = [resolve(arg)];
    if (index === 0) for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      for (const ext of ['', ...(process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [])]) candidates.push(join(dir, arg + ext));
    }
    const path = candidates.find((path) => existsSync(path) && statSync(path).isFile());
    return path ? [arg, createHash('sha256').update(readFileSync(path)).digest('hex')] : [arg, null];
  });
}

/** 单音符渲染：有 cacheDir 时按内容哈希寻址复用（对齐 OpenUtau 的 res-<hash>.wav 方案）。 */
async function renderNote({ item, toolHash, cacheDir, noteWavPath, timeoutMs, log, signal }) {
  if (!cacheDir) {
    await callResampler(item, { timeoutMs, signal });
    return false;
  }
  const inputHash = createHash('sha256').update(readFileSync(item.inputWav)).digest('hex').slice(0, 16);
  const key = createHash('sha256')
    .update(JSON.stringify(['vocal-note/v3', toolHash, inputHash, item.contract, buildResamplerArgs({ ...item, outputWav: '' }).slice(2)]))
    .digest('hex').slice(0, 32);
  const cachePath = join(cacheDir, `res-${key}.wav`);
  if (existsSync(cachePath)) {
    try {
      readWav(cachePath);
      copyFileSync(cachePath, noteWavPath);
      log(`  缓存命中 ${basename(cachePath)}`);
      return true;
    } catch { log(`  缓存损坏，重新渲染 ${basename(cachePath)}`); }
  }
  await callResampler(item, { timeoutMs, signal });
  readWav(noteWavPath); // Validate before publishing a shared cache artifact.
  mkdirSync(cacheDir, { recursive: true });
  const temporary = `${cachePath}.${randomUUID()}.tmp`;
  try { copyFileSync(noteWavPath, temporary); renameSync(temporary, cachePath); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return false;
}

/**
 * 渲染一个 USTX。
 * 参数：{ ustxText, resampler, outWav, voicebankDir | voicebank, workDir, contract?, cacheDir?, timeoutMs?, log? }
 * voicebank 可传已加载对象（测试复用）或目录（内部加载）。
 * contract: 'classic'（worldline.exe 等，默认）| 'openutau'（moresampler 等）。
 * cacheDir 给定时启用逐音符内容寻址缓存。
 * 返回 { outWav, noteCount, skippedCount, tempo, durationSamples, warnings, bank, cacheSummary }。
 */
export async function renderUstx({ ustxText, resampler, outWav, voicebankDir, voicebank, workDir, contract = 'classic', cacheDir, timeoutMs, signal, onProgress = () => {}, log = () => {} }) {
  signal?.throwIfAborted();
  if (!resampler) fail('缺少重采样器配置（resampler）——任何实现 UTAU/OpenUtau 命令行契约的 exe 或 argv 数组');
  if (!outWav) fail('缺少输出路径（outWav）');
  if (!workDir) fail('缺少工作目录（workDir，存放逐音符中间 WAV）');
  if (!RESAMPLER_CONTRACTS.includes(contract)) fail(`unsupported resampler contract: ${contract}`);

  const verdict = validateUstxText(ustxText);
  if (!verdict.ok) fail(`USTX 结构自检未通过：\n- ${verdict.errors.join('\n- ')}`);
  const project = parseYaml(ustxText);
  if (project.tempos.length !== 1) fail('rendering supports one constant tempo; split tempo changes into separate renders');

  const parts = project.voice_parts ?? [];
  if (parts.length !== 1) fail(`只支持单 voice_part，当前 ${parts.length} 个（多 part 请先合并或拆分渲染）`);
  const part = parts[0];
  const track = (project.tracks ?? [])[part.track_no] ?? {};
  if (track.phonemizer || track.mute || (track.volume ?? 0) !== 0 || (track.pan ?? 0) !== 0)
    fail('渲染不支持 track phonemizer/mute/volume/pan；请用显式 oto 别名、逐音符 volume 或 dyn');
  if (part.masked_curves?.length) fail('渲染不支持 masked_curves（rpit/pito）');
  const tempo = project.tempos?.[0]?.bpm ?? 120;
  range(tempo, 20, 1000, '渲染 BPM');
  const msPerTick = 60000 / (tempo * TICKS_PER_BEAT);
  if (part.notes.length > 2000 || part.notes.some(n => (part.position + n.position + n.duration) * msPerTick > 3600000))
    fail('渲染支持最多 2000 音符、最长一小时');

  const bank = voicebank ?? loadVoicebank(voicebankDir);
  if (track.singer && bank.name && track.singer !== bank.name) {
    log(`提示：track.singer "${track.singer}" 与声库名 "${bank.name}" 不一致，按配置的声库渲染`);
  }

  mkdirSync(workDir, { recursive: true });
  const notes = [...(part.notes ?? [])].sort((a, b) => a.position - b.position);
  const segments = [];
  const warnings = [...bank.warnings];
  let noteCount = 0;
  let skippedCount = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let warnedNegative = false;
  const toolHash = cacheDir ? toolFingerprint(Array.isArray(resampler) ? resampler : [resampler]) : null;
  const model=createPitchModel(part,tempo), dynamics=curvePoints(part,'dyn',msPerTick);
  const layouts=layoutPhonemes(part,tempo,bank);
  skippedCount=notes.length-layouts.length;

  for (const layout of layouts) {
    const {index,note,entry,wav}=layout;
    signal?.throwIfAborted();
    const lyric = note.lyric.trim();
    const durationMs = note.duration * msPerTick;
    // Include leading/skipOver and neighbour-adjusted tail; crop grid padding later.
    let durRequiredMs = Math.max(layout.length+layout.skipOver, entry.consonant);
    durRequiredMs = Math.ceil(durRequiredMs / 50 + 0.5) * 50;

    const noteWavPath = join(workDir, `note-${String(index).padStart(4, '0')}.wav`);
    log(`[${index}] ${lyric} tone=${note.tone} dur=${Math.round(durationMs)}ms → ${entry.file} (offset=${entry.offset} consonant=${entry.consonant} cutoff=${entry.cutoff})`);
    const item = {
      resampler,
      inputWav: wav,
      outputWav: noteWavPath,
      tone: note.tone,
      velocity: layout.velocity,
      flags: '',
      offsetMs: entry.offset,
      durationMs: durRequiredMs,
      consonantMs: entry.consonant,
      cutoffMs: entry.cutoff,
      volume: 100,
      modulation: 0,
      tempo,
      pitches: Array.from({length:Math.ceil((layout.length+layout.skipOver)/model.cadenceMs)+1},(_,i)=>
        Math.round(range(model.centsAt(Math.min(layout.start-layout.rawLeading+i*model.cadenceMs,layout.start-layout.preutter+layout.length))-note.tone*100,-2048,2047,'合成音高偏移（int12）'))),
      contract,
    };
    const hit = await renderNote({ item, toolHash, cacheDir, noteWavPath, timeoutMs, log, signal });
    if (hit) cacheHits++; else cacheMisses++;

    const rendered = readWav(noteWavPath);
    let samples = rendered.sampleRate === WAV_SAMPLE_RATE
      ? rendered.samples
      : resampleLinear(rendered.samples, rendered.sampleRate, WAV_SAMPLE_RATE);

    const skip=msToSamples(layout.skipOver), wanted=msToSamples(layout.length);
    if(samples.length+2<skip+wanted)fail(`重采样器产物过短：notes[${index}] 需要 ${skip+wanted}，仅 ${samples.length} samples`);
    samples=applyEnvelope(samples.subarray(skip,skip+wanted),layout,dynamics);
    let startSample = msToSamples(layout.start - layout.preutter);
    if (startSample < 0) {
      if (!warnedNegative) { warnings.push('存在 preutter 早于 0 的音符，已裁去曲首之前的样本'); warnedNegative = true; }
      samples = samples.subarray(Math.min(samples.length, -startSample));
      startSample = 0;
    }
    segments.push({
      samples,
      startSample,
    });
    noteCount++;
    onProgress(index + 1, notes.length);
  }

  if (noteCount === 0) fail('没有可渲染的音符（全是休止或空 part）');
  signal?.throwIfAborted();
  mkdirSync(dirname(outWav), { recursive: true });
  const mixed = concatenate(segments);
  let peak = 0;
  for (const sample of mixed) {
    if (!Number.isFinite(sample)) fail('合成人声含非有限样本');
    peak = Math.max(peak, Math.abs(sample));
  }
  const stemGain = peak > 0.95 ? 0.95 / peak : 1;
  if (stemGain < 1) {
    for (let i = 0; i < mixed.length; i++) mixed[i] *= stemGain;
    warnings.push(`音量/力度叠加超过干轨余量；全曲统一衰减 ${(-20 * Math.log10(stemGain)).toFixed(1)} dB，保留相对力度`);
  }
  writeWavMono16(outWav, mixed, WAV_SAMPLE_RATE);
  log('分析渲染干轨实测基频');
  const measured=pitchReport(readWav(outWav),ustxText,{signal});
  const pitchReportPath=`${outWav}.pitch.json`;
  writeFileSync(pitchReportPath,JSON.stringify(measured));
  return {
    outWav,
    noteCount,
    skippedCount,
    tempo,
    durationSamples: mixed.length,
    stemGain,
    warnings,
    bank: { name: bank.name, aliases: bank.entries.length },
    toolSignature: toolHash ? createHash('sha256').update(JSON.stringify(toolHash)).digest('hex') : null,
    rendererVersion: 'vocal-render/v4-expressions',
    pitchReportPath,
    pitchQuality:{method:measured.method,timingSource:measured.timingSource,summary:measured.summary,notes:measured.notes,limitations:measured.limitations},
    phonemeLayout: layouts.map(l=>({index:l.index,startMs:l.start,preutterMs:l.preutter,overlapMs:l.overlap,skipOverMs:l.skipOver,tailIntrudeMs:l.tailIntrude,tailOverlapMs:l.tailOverlap,envelope:l.envelope})),
    cacheSummary: { hits: cacheHits, misses: cacheMisses },
  };
}

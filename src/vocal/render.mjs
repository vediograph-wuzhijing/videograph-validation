// render.mjs — M1 无头渲染编排：USTX + 声库 + 重采样器 → 人声 WAV（VOCAL-M1）。
// 流程：结构自检 → 逐音符 oto 别名查找 → 按契约调用重采样器 → 重叠相加 → mono16 WAV。
// M1 边界（完整 ResamplerItem 语义与渲染缓存属 M2，呼应改进建议 B2 的缓存键设计）：
//   durRequired ≈ 音符时长 + overlap；音高曲线固定为平直（zeros）；包络为线性交叠；
//   仅支持单 voice_part；Lyric=R 视为休止跳过；lyric 必须是 oto 别名本身（CV 用法）。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseYaml } from './yaml-lite.mjs';
import { TICKS_PER_BEAT, UstxError, validateUstxText } from './ustx.mjs';
import { loadVoicebank } from './oto.mjs';
import { callResampler, flatPitches } from './resampler.mjs';
import { readWav, resampleLinear, writeWavMono16, WAV_SAMPLE_RATE } from './wav.mjs';
import { concatenate } from './wavtool.mjs';

const fail = (message) => { throw new UstxError(message); };
const msToSamples = (ms) => Math.round(ms * WAV_SAMPLE_RATE / 1000);

/**
 * 渲染一个 USTX。
 * 参数：{ ustxText, resampler, outWav, voicebankDir | voicebank, workDir, timeoutMs?, log? }
 * voicebank 可传已加载对象（测试复用）或目录（内部加载）。
 * 返回 { outWav, noteCount, skippedCount, tempo, durationSamples, warnings }。
 */
export async function renderUstx({ ustxText, resampler, outWav, voicebankDir, voicebank, workDir, timeoutMs, log = () => {} }) {
  if (!resampler) fail('缺少重采样器配置（resampler）——任何实现 UTAU/OpenUtau 命令行契约的 exe 或 argv 数组');
  if (!outWav) fail('缺少输出路径（outWav）');
  if (!workDir) fail('缺少工作目录（workDir，存放逐音符中间 WAV）');

  const verdict = validateUstxText(ustxText);
  if (!verdict.ok) fail(`USTX 结构自检未通过：\n- ${verdict.errors.join('\n- ')}`);
  const project = parseYaml(ustxText);

  const parts = project.voice_parts ?? [];
  if (parts.length !== 1) fail(`M1 只支持单 voice_part，当前 ${parts.length} 个（多 part 请先合并或拆分渲染）`);
  const part = parts[0];
  const track = (project.tracks ?? [])[part.track_no] ?? {};
  const tempo = project.tempos?.[0]?.bpm ?? 120;
  const msPerTick = 60000 / (tempo * TICKS_PER_BEAT);

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
  let warnedNegative = false;

  for (const [index, note] of notes.entries()) {
    const lyric = String(note.lyric ?? '').trim();
    if (lyric.toUpperCase() === 'R') { skippedCount++; continue; }
    const found = bank.findAlias(lyric);
    if (!found) {
      const sample = bank.entries.slice(0, 12).map((e) => e.alias).join('、');
      fail(`声库没有别名 "${lyric}"（notes[${index}]）。M1 约定 lyric 必须是 oto 别名本身；` +
        `声库「${bank.name}」现有 ${bank.entries.length} 个别名，例如：${sample}${bank.entries.length > 12 ? ' …' : ''}`);
    }
    const { entry, wav } = found;
    const startAbsMs = (part.position + note.position) * msPerTick;
    const durationMs = note.duration * msPerTick;
    const overlapMs = Math.max(0, entry.overlap);
    const preutterMs = entry.preutter;
    const durRequiredMs = durationMs + overlapMs + 10;

    const noteWavPath = join(workDir, `note-${String(index).padStart(4, '0')}.wav`);
    log(`[${index}] ${lyric} tone=${note.tone} dur=${Math.round(durationMs)}ms → ${entry.file} (offset=${entry.offset} consonant=${entry.consonant} cutoff=${entry.cutoff})`);
    await callResampler({
      resampler,
      inputWav: wav,
      outputWav: noteWavPath,
      tone: note.tone,
      velocity: 100,
      flags: '',
      offsetMs: entry.offset,
      durationMs: durRequiredMs,
      consonantMs: entry.consonant,
      cutoffMs: entry.cutoff,
      volume: 100,
      modulation: 0,
      tempo,
      pitches: flatPitches(durRequiredMs),
    }, { timeoutMs });

    const rendered = readWav(noteWavPath);
    const samples = rendered.sampleRate === WAV_SAMPLE_RATE
      ? rendered.samples
      : resampleLinear(rendered.samples, rendered.sampleRate, WAV_SAMPLE_RATE);

    let startSample = msToSamples(startAbsMs - preutterMs);
    if (startSample < 0) {
      if (!warnedNegative) { warnings.push('存在 preutter 早于 0 的音符，已钳制到曲首'); warnedNegative = true; }
      startSample = 0;
    }
    segments.push({
      samples,
      startSample,
      fadeInSamples: overlapMs > 0 ? msToSamples(overlapMs) : 0,
      fadeOutSamples: overlapMs > 0 ? msToSamples(overlapMs) : 0,
    });
    noteCount++;
  }

  if (noteCount === 0) fail('没有可渲染的音符（全是休止或空 part）');
  mkdirSync(dirname(outWav), { recursive: true });
  const mixed = concatenate(segments);
  writeWavMono16(outWav, mixed, WAV_SAMPLE_RATE);
  return {
    outWav,
    noteCount,
    skippedCount,
    tempo,
    durationSamples: mixed.length,
    warnings,
    bank: { name: bank.name, aliases: bank.entries.length },
  };
}

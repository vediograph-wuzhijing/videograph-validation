// render.mjs — M2 无头渲染编排：USTX + 声库 + 重采样器 → 人声 WAV（VOCAL-M2）。
// 流程：结构自检 → 逐音符 oto 别名查找 → 按契约调用重采样器（内容寻址缓存）→ 重叠相加 → mono16 WAV。
// 时长公式对齐 OpenUtau ResamplerItem.cs（2026-10-06 核对）：
//   durRequired = max(音符时长, consonant) 向上取整到 50ms 网格；
//   M2 简化布局（leading=preutter、无 tail 侵入）下 skipOver 与 durCorrection 为 0，
//   完整音素布局（TailIntrude/TailOverlap）与包络精修属 M3。
// 缓存（改进建议 B2）：按「重采样器 argv 头 + 输入 wav 内容哈希 + 契约参数」寻址，
//   同参数音符跨渲染直接复用，改动一个音符不再全片重算。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseYaml } from './yaml-lite.mjs';
import { TICKS_PER_BEAT, UstxError, validateUstxText } from './ustx.mjs';
import { loadVoicebank } from './oto.mjs';
import { buildResamplerArgs, callResampler, flatPitches } from './resampler.mjs';
import { readWav, resampleLinear, writeWavMono16, WAV_SAMPLE_RATE } from './wav.mjs';
import { concatenate } from './wavtool.mjs';

const fail = (message) => { throw new UstxError(message); };
const msToSamples = (ms) => Math.round(ms * WAV_SAMPLE_RATE / 1000);

/** 单音符渲染：有 cacheDir 时按内容哈希寻址复用（对齐 OpenUtau 的 res-<hash>.wav 方案）。 */
async function renderNote({ item, argvHead, cacheDir, noteWavPath, timeoutMs, log }) {
  if (!cacheDir) {
    await callResampler(item, { timeoutMs });
    return false;
  }
  const inputHash = createHash('sha256').update(readFileSync(item.inputWav)).digest('hex').slice(0, 16);
  const key = createHash('sha256')
    .update(JSON.stringify([argvHead, inputHash, buildResamplerArgs({ ...item, outputWav: '' }).slice(2)]))
    .digest('hex').slice(0, 32);
  const cachePath = join(cacheDir, `res-${key}.wav`);
  if (existsSync(cachePath)) {
    copyFileSync(cachePath, noteWavPath);
    log(`  缓存命中 ${basename(cachePath)}`);
    return true;
  }
  await callResampler(item, { timeoutMs });
  mkdirSync(cacheDir, { recursive: true });
  copyFileSync(noteWavPath, cachePath);
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
export async function renderUstx({ ustxText, resampler, outWav, voicebankDir, voicebank, workDir, contract = 'classic', cacheDir, timeoutMs, log = () => {} }) {
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
  let cacheHits = 0;
  let cacheMisses = 0;
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
    // ResamplerItem.cs 公式：max(时长, consonant) 后向上取整到 50ms 网格；
    // M2 简化布局下 skipOver 与 durCorrection 为 0（见文件头说明）。
    let durRequiredMs = Math.max(durationMs, entry.consonant);
    durRequiredMs = Math.ceil(durRequiredMs / 50 + 0.5) * 50;

    const noteWavPath = join(workDir, `note-${String(index).padStart(4, '0')}.wav`);
    log(`[${index}] ${lyric} tone=${note.tone} dur=${Math.round(durationMs)}ms → ${entry.file} (offset=${entry.offset} consonant=${entry.consonant} cutoff=${entry.cutoff})`);
    const item = {
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
      contract,
    };
    const argvHead = Array.isArray(resampler) ? resampler : [resampler];
    const hit = await renderNote({ item, argvHead, cacheDir, noteWavPath, timeoutMs, log });
    if (hit) cacheHits++; else cacheMisses++;

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
    cacheSummary: { hits: cacheHits, misses: cacheMisses },
  };
}

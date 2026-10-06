// ust.mjs — 经典 UTAU UST 文本写出（VOCAL-M1，互操作用：给 UTAU/OpenUtau 之外的生态工具）。
// UST 的 Lyric 是 oto 别名本身（无音素化步骤）；M1 只写 CV 基本字段，不写包络。
import { parseYaml } from './yaml-lite.mjs';
import { UstxError } from './ustx.mjs';

const fail = (message) => { throw new UstxError(message); };

/**
 * 由已解析的 USTX 数据对象写 UST 文本。
 * options: { voiceDir?: string, projectName?: string, tempo? }
 * 音符起点换算成 UST 的 Length（tick，四舍五入到整数；UST 无绝对位置，靠 Length 串接，
 * 音符间空隙用 Lyric=R 的休止符补齐）。注意：音符位置按 part 内相对位置串接，
 * part.position 的绝对偏移不带入 UST（M1 限制，多 part 工程请先在 USTX 侧合并）。
 */
export function ustxToUst(project, options = {}) {
  const parts = Array.isArray(project?.voice_parts) ? project.voice_parts : [];
  if (parts.length === 0) fail('USTX 没有 voice_parts，无法转 UST');
  if (parts.length > 1) fail(`USTX 有 ${parts.length} 个 voice_parts，M1 只支持单 part 转 UST`);
  const notes = [...(parts[0].notes ?? [])].sort((a, b) => a.position - b.position);
  if (notes.length === 0) fail('voice_parts 没有音符');
  const tempo = options.tempo ?? project?.tempos?.[0]?.bpm ?? 120;
  const voiceDir = options.voiceDir ?? '';

  const lines = [
    'UST Version 0.3.0',
    `Setting=${[
      `Tempo=${tempo}`,
      'Tracks=1',
      `ProjectName=${options.projectName ?? project?.name ?? ''}`,
      `VoiceDir=${voiceDir}`,
    ].join('!')}`,
  ];

  let cursor = 0; // 当前已写到的 part 内 tick
  let index = 0;
  const emitNote = (length, lyric, noteNum) => {
    lines.push(
      `[#${String(index).padStart(4, '0')}]`,
      `Length=${length}`,
      `Lyric=${lyric}`,
      `NoteNum=${noteNum}`,
      'Velocity=100',
      'Intensity=100',
      'Modulation=0',
      'Flags=',
    );
    index += 1;
  };

  for (const note of notes) {
    if (note.position > cursor) {
      emitNote(note.position - cursor, 'R', 60); // 休止
    }
    emitNote(note.duration, note.lyric, note.tone);
    cursor = note.position + note.duration;
  }
  lines.push('[#NEXT]', '[#TRACKEND]');
  return lines.join('\n') + '\n';
}

/** 便捷入口：USTX 文本 → UST 文本。 */
export function ustxTextToUst(ustxText, options = {}) {
  return ustxToUst(parseYaml(ustxText), options);
}

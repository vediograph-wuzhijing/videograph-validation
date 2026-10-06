// ustx.mjs — OpenUTAU 工程文件（USTX v0.10，YAML）生成器与结构自检（VOCAL-M1）。
// 序列化事实全部对齐 openutau/OpenUtau master 源码（2026-10-06 核对）：
//   Format/USTx.cs（kUstxVersion=0.10、AddDefaultExpressions）、Ustx/UProject.cs、UNote.cs、
//   UTrack.cs、UPart.cs、Util/Yaml.cs（UnderscoredNamingConvention + OmitNull）、Util/NotePresets.cs。
// 引擎加载端 IgnoreUnmatchedProperties：多写字段无害，少写必要字段会在 Validate 时补默认值。
import { emitYaml, parseYaml, YamlError } from './yaml-lite.mjs';

export const USTX_VERSION = '0.10';
export const TICKS_PER_BEAT = 480; // UProject.resolution 固定 480，不序列化
// NotePresets.Default：PortamentoPreset("Standard", 80, -40)、VibratoPreset("Standard", 75, 175, 25, 10, 10, 0, 0, 0)
export const PORTAMENTO = { startMs: -40, lengthMs: 80 };
export const VIBRATO_DEFAULT = { length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, volLink: 0 };

export class UstxError extends Error {
  constructor(message) { super(message); this.name = 'UstxError'; }
}

const fail = (message) => { throw new UstxError(message); };

// UExpressionType：Numerical=0 / Options=1 / Curve=2 / MaskedCurve=3（UExpression.cs）。
const TYPE = { Numerical: 0, Options: 1, Curve: 2, MaskedCurve: 3 };
const num = (name, abbr, min, max, def, flag = '') => (
  { name, abbr, type: TYPE.Numerical, min, max, defaultValue: def, isFlag: Boolean(flag), flag, options: [] });
const curve = (name, abbr, min, max, def) => (
  { name, abbr, type: TYPE.Curve, min, max, defaultValue: def, isFlag: false, flag: '', options: [] });
const opts = (name, abbr, options) => (
  { name, abbr, type: TYPE.Options, min: 0, max: 0, defaultValue: 0, isFlag: false, flag: '', options });

// Format/USTx.cs AddDefaultExpressions 的完整表（缩写是序列化键，注意 `mod+`）。
export const STANDARD_EXPRESSIONS = [
  curve('dynamics (curve)', 'dyn', -240, 120, 0),
  curve('pitch deviation (curve)', 'pitd', -1200, 1200, 0),
  opts('voice color', 'clr', []),
  opts('resampler engine', 'eng', ['', 'worldline']),
  num('velocity', 'vel', 0, 200, 100),
  num('volume', 'vol', 0, 200, 100),
  num('attack', 'atk', 0, 200, 100),
  num('decay', 'dec', 0, 100, 0),
  num('gender', 'gen', -100, 100, 0, 'g'),
  curve('gender (curve)', 'genc', -100, 100, 0),
  num('breath', 'bre', 0, 100, 0, 'B'),
  curve('breathiness (curve)', 'brec', -100, 100, 0),
  num('lowpass', 'lpf', 0, 100, 0, 'H'),
  num('normalize', 'norm', 0, 100, 86, 'P'),
  num('modulation', 'mod', 0, 100, 0),
  num('modulation plus', 'mod+', 0, 100, 0),
  num('alternate', 'alt', 0, 16, 0),
  opts('direct', 'dir', ['off', 'on']),
  num('tone shift', 'shft', -36, 36, 0),
  curve('tone shift (curve)', 'shfc', -1200, 1200, 0),
  curve('tension (curve)', 'tenc', -100, 100, 0),
  curve('voicing (curve)', 'voic', 0, 100, 100),
  opts('voice color y', 'clry', []),
  curve('cross synthesis (curve)', 'xsy', 0, 100, 0),
  curve('growl (curve)', 'grwc', 0, 100, 0),
  { name: 'rendered pitch (masked curve)', abbr: 'rpit', type: TYPE.MaskedCurve, min: 2400, max: 10800, defaultValue: 6000, isFlag: false, flag: '', options: [] },
  { name: 'pitch override (masked curve)', abbr: 'pito', type: TYPE.MaskedCurve, min: 2400, max: 10800, defaultValue: 6000, isFlag: false, flag: '', options: [] },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 音名 ↔ MIDI 编号（C4=60，与 OpenUtau MusicMath 一致）。 */
export function nameToTone(name) {
  if (typeof name === 'number') {
    if (!Number.isInteger(name) || name < 0 || name > 127) fail(`tone 超出 0..127: ${name}`);
    return name;
  }
  const m = /^([A-Ga-g])(#{1,2}|b{1,2})?(-?\d+)$/.exec(String(name).trim());
  if (!m) fail(`音名无法解析（示例 C4 / A#3 / Db5）: ${name}`);
  const base = NOTE_NAMES.indexOf(m[1].toUpperCase());
  let semitone = base;
  for (const ch of m[2] ?? '') semitone += ch === '#' ? 1 : -1;
  const tone = (parseInt(m[3], 10) + 1) * 12 + semitone;
  if (tone < 0 || tone > 127) fail(`音名越界（0..127）: ${name}`);
  return tone;
}

export function toneToName(tone) {
  if (!Number.isInteger(tone) || tone < 0 || tone > 127) fail(`tone 超出 0..127: ${tone}`);
  return NOTE_NAMES[tone % 12] + (Math.floor(tone / 12) - 1);
}

function toTicks(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  fail(`${label} 必须是整数 tick`);
}

function requireDuration(note, index) {
  if (note.durationTicks !== undefined) return toTicks(note.durationTicks, `notes[${index}].durationTicks`);
  if (note.durationBeats !== undefined) {
    if (typeof note.durationBeats !== 'number' || !(note.durationBeats > 0)) fail(`notes[${index}].durationBeats 必须为正数`);
    return Math.round(note.durationBeats * TICKS_PER_BEAT);
  }
  fail(`notes[${index}] 缺时长：给 durationTicks 或 durationBeats`);
}

function startTickOf(note, index) {
  if (note.startTick !== undefined) return toTicks(note.startTick, `notes[${index}].startTick`);
  if (note.startBeats !== undefined) {
    if (typeof note.startBeats !== 'number' || note.startBeats < 0) fail(`notes[${index}].startBeats 不能为负`);
    return Math.round(note.startBeats * TICKS_PER_BEAT);
  }
  fail(`notes[${index}] 缺起点：给 startTick 或 startBeats（相对全曲的绝对位置）`);
}

function buildPitchPoints(note, index) {
  if (note.pitchCurve === undefined) {
    // 默认滑音：Standard 预设（-40ms 回望 → 80ms 到位），平直音高。
    return {
      data: [
        { x: PORTAMENTO.startMs, y: 0, shape: 'sp' },
        { x: PORTAMENTO.lengthMs, y: 0, shape: 'io' },
      ],
      snap_first: true,
    };
  }
  if (!Array.isArray(note.pitchCurve) || note.pitchCurve.length === 0) fail(`notes[${index}].pitchCurve 必须是非空数组`);
  let lastX = -Infinity;
  const data = note.pitchCurve.map((p, i) => {
    if (typeof p.x !== 'number') fail(`notes[${index}].pitchCurve[${i}].x 必须是数字（毫秒，相对音符起点）`);
    if (typeof p.y !== 'number') fail(`notes[${index}].pitchCurve[${i}].y 必须是数字（0.1 半音，相对音符音高）`);
    const shape = p.shape ?? 'io';
    if (!['io', 'lin', 'i', 'o', 'sp'].includes(shape)) fail(`notes[${index}].pitchCurve[${i}].shape 非法: ${shape}`);
    if (p.x <= lastX) fail(`notes[${index}].pitchCurve 的 x 必须严格递增`);
    lastX = p.x;
    return { x: p.x, y: p.y, shape };
  });
  return { data, snap_first: note.snapFirst ?? true };
}

function buildVibrato(note, index) {
  const v = note.vibrato ?? {};
  if (typeof v !== 'object' || Array.isArray(v)) fail(`notes[${index}].vibrato 必须是对象`);
  const length = v.length ?? VIBRATO_DEFAULT.length;
  if (typeof length !== 'number' || length < 0 || length > 100) fail(`notes[${index}].vibrato.length 超出 0..100`);
  const clamp = (value, lo, hi, label) => {
    const n = value ?? VIBRATO_DEFAULT[label];
    if (typeof n !== 'number' || n < lo || n > hi) fail(`notes[${index}].vibrato.${label} 超出 ${lo}..${hi}`);
    return n;
  };
  return {
    length,
    period: clamp(v.period, 5, 500, 'period'),
    depth: clamp(v.depth, 5, 200, 'depth'),
    in: clamp(v.in, 0, 100, 'in'),
    out: clamp(v.out, 0, 100, 'out'),
    shift: clamp(v.shift, 0, 100, 'shift'),
    drift: clamp(v.drift, -100, 100, 'drift'),
    vol_link: clamp(v.volLink, -100, 100, 'volLink'),
  };
}

/**
 * 由 AI 友好的 plan 构建 USTX 数据对象。
 * plan: { name?, tempo?, key?, timeSignatures?, tracks: [{ singer?, phonemizer?, trackName?, volume?, pan? }],
 *         parts: [{ name?, trackNo?, positionTick?, notes: [{ lyric, tone|pitch, startTick|startBeats,
 *                   durationTicks|durationBeats, pitchCurve?, vibrato?, snapFirst? }] }] }
 * notes 的 start* 是相对全曲的绝对位置；part.position 自动对齐到首音符（可显式覆盖）。
 */
export function buildUstx(plan) {
  if (typeof plan !== 'object' || plan === null) fail('plan 必须是对象');
  if (!Array.isArray(plan.tracks) || plan.tracks.length === 0) fail('plan.tracks 必须是非空数组');
  if (!Array.isArray(plan.parts) || plan.parts.length === 0) fail('plan.parts 必须是非空数组');
  const tempo = plan.tempo ?? 120;
  if (typeof tempo !== 'number' || !(tempo >= 20 && tempo <= 1000)) fail('tempo 超出 20..1000');

  const tracks = plan.tracks.map((t, i) => {
    if (typeof t !== 'object' || t === null) fail(`tracks[${i}] 必须是对象`);
    return {
      singer: t.singer ?? '',
      phonemizer: t.phonemizer ?? '',
      renderer_settings: { renderer: 'CLASSIC', resampler: '', wavtool: '' },
      track_name: t.trackName ?? `Track ${i + 1}`,
      track_color: 'Blue',
      mute: false,
      solo: false,
      volume: t.volume ?? 0,
      pan: t.pan ?? 0,
    };
  });

  const voiceParts = plan.parts.map((part, pi) => {
    if (typeof part !== 'object' || part === null) fail(`parts[${pi}] 必须是对象`);
    if (!Array.isArray(part.notes) || part.notes.length === 0) fail(`parts[${pi}].notes 必须是非空数组`);
    const trackNo = part.trackNo ?? 0;
    if (!Number.isInteger(trackNo) || trackNo < 0 || trackNo >= tracks.length) {
      fail(`parts[${pi}].trackNo 超出 0..${tracks.length - 1}`);
    }
    const enriched = part.notes.map((note, ni) => {
      if (typeof note !== 'object' || note === null) fail(`parts[${pi}].notes[${ni}] 必须是对象`);
      if (typeof note.lyric !== 'string' || note.lyric.trim() === '') fail(`parts[${pi}].notes[${ni}].lyric 必须是非空字符串`);
      if (note.tone === undefined && note.pitch === undefined) fail(`parts[${pi}].notes[${ni}] 缺音高：给 tone（MIDI 编号）或 pitch（音名，如 C4）`);
      const tone = note.tone !== undefined ? nameToTone(note.tone) : nameToTone(note.pitch);
      const start = startTickOf(note, ni);
      const duration = requireDuration(note, ni);
      if (duration <= 0) fail(`parts[${pi}].notes[${ni}] 时长必须为正`);
      return { start, duration, tone, note };
    });
    enriched.sort((a, b) => a.start - b.start);
    const partPosition = part.positionTick ?? enriched[0].start;
    let lastEnd = -Infinity;
    const notes = enriched.map((e, ni) => {
      if (e.start < lastEnd) fail(`parts[${pi}] 音符时间重叠（按 startTick 排序后 ${ni} 处）`);
      lastEnd = e.start + e.duration;
      const src = e.note;
      return {
        position: e.start - partPosition,
        duration: e.duration,
        tone: e.tone,
        lyric: src.lyric,
        pitch: buildPitchPoints(src, ni),
        vibrato: buildVibrato(src, ni),
      };
    });
    const duration = Math.max(lastEnd - partPosition, TICKS_PER_BEAT);
    return {
      name: part.name ?? `Part ${pi + 1}`,
      comment: '',
      track_no: trackNo,
      position: partPosition,
      duration,
      notes,
      curves: [],
      masked_curves: [],
    };
  });

  const timeSignatures = (plan.timeSignatures ?? [{ barPosition: 0, beatPerBar: 4, beatUnit: 4 }])
    .map((ts) => ({
      bar_position: ts.barPosition ?? 0,
      beat_per_bar: ts.beatPerBar ?? 4,
      beat_unit: ts.beatUnit ?? 4,
    }));

  return {
    name: plan.name ?? 'Untitled',
    comment: '',
    output_dir: 'Vocal',
    cache_dir: 'UCache',
    ustx_version: USTX_VERSION,
    expressions: Object.fromEntries(STANDARD_EXPRESSIONS.map((e) => [e.abbr, e])),
    exp_primary: 0,
    exp_secondary: 1,
    key: plan.key ?? 0,
    time_signatures: timeSignatures,
    tempos: [{ position: 0, bpm: tempo }],
    tracks,
    voice_parts: voiceParts,
  };
}

/** 序列化为 USTX 文本（USTX = YAML）。 */
export function serializeUstx(project) {
  return emitYaml(project);
}

/** 结构自检：解析文本并核对生成器必须满足的约束（渲染前必跑）。 */
export function validateUstxText(text) {
  const errors = [];
  let project;
  try {
    project = parseYaml(text);
  } catch (err) {
    return { ok: false, errors: [err instanceof YamlError ? `YAML 解析失败：${err.message}` : String(err)] };
  }
  if (typeof project !== 'object' || project === null || Array.isArray(project)) {
    return { ok: false, errors: ['顶层必须是映射'] };
  }
  if (project.ustx_version !== USTX_VERSION) errors.push(`ustx_version 应为 ${USTX_VERSION}，实际 ${JSON.stringify(project.ustx_version)}`);
  if (!Array.isArray(project.tempos) || project.tempos.length === 0 || project.tempos[0].position !== 0) {
    errors.push('tempos 缺失或首项 position 非 0');
  }
  if (!Array.isArray(project.time_signatures) || project.time_signatures.length === 0) errors.push('time_signatures 缺失');
  if (!Array.isArray(project.tracks) || project.tracks.length === 0) errors.push('tracks 缺失');
  for (const abbr of ['dyn', 'pitd', 'clr', 'eng', 'vel', 'vol', 'atk', 'dec']) {
    if (!project.expressions || !project.expressions[abbr]) errors.push(`expressions 缺必需项 ${abbr}`);
  }
  const parts = Array.isArray(project.voice_parts) ? project.voice_parts : [];
  if (parts.length === 0) errors.push('voice_parts 缺失');
  const trackCount = Array.isArray(project.tracks) ? project.tracks.length : 0;
  for (const [pi, part] of parts.entries()) {
    if (!Number.isInteger(part.track_no) || part.track_no < 0 || part.track_no >= trackCount) {
      errors.push(`voice_parts[${pi}].track_no 越界`);
    }
    const notes = Array.isArray(part.notes) ? part.notes : [];
    if (notes.length === 0) { errors.push(`voice_parts[${pi}].notes 为空`); continue; }
    let lastEnd = -Infinity;
    for (const [ni, note] of notes.entries()) {
      const label = `voice_parts[${pi}].notes[${ni}]`;
      if (typeof note.lyric !== 'string' || note.lyric === '') errors.push(`${label}.lyric 缺失`);
      if (!Number.isInteger(note.position) || !Number.isInteger(note.duration) || note.duration <= 0) {
        errors.push(`${label} 的 position/duration 非法`);
      } else if (note.position < lastEnd) errors.push(`${label} 与前一音符重叠`);
      if (lastEnd > -Infinity) lastEnd = Math.max(lastEnd, note.position + note.duration);
      else lastEnd = note.position + note.duration;
      if (!Number.isInteger(note.tone) || note.tone < 0 || note.tone > 127) errors.push(`${label}.tone 越界`);
      const points = note.pitch && Array.isArray(note.pitch.data) ? note.pitch.data : [];
      if (points.length === 0) errors.push(`${label}.pitch.data 为空`);
      const vib = note.vibrato;
      if (vib) {
        if (typeof vib.length !== 'number' || vib.length < 0 || vib.length > 100) errors.push(`${label}.vibrato.length 越界`);
        if (typeof vib.period !== 'number' || vib.period < 5 || vib.period > 500) errors.push(`${label}.vibrato.period 越界`);
        if (typeof vib.depth !== 'number' || vib.depth < 5 || vib.depth > 200) errors.push(`${label}.vibrato.depth 越界`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

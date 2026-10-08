// contract.mjs — videograph-analysis/v2 分析数据契约：校验与归一化（SONG-00）。
// 每一层数据都带 provenance；分析结果默认是草稿，人确认后才能用于规划（SONG-02/05 的状态机）。
// 器乐工程合法：lyrics 缺席即可，不伪造歌词。

export const ANALYSIS_SCHEMA = 'videograph-analysis/v2';
export const SECTION_LABELS = ['intro', 'verse', 'chorus', 'bridge', 'outro', 'unknown'];
export const LYRIC_SOURCES = ['user', 'lrc', 'asr'];
export const TIMING_SOURCES = ['score','manual','audio-aligned','estimated'];
function timingSource(value,label){if(value!==undefined&&!TIMING_SOURCES.includes(value))fail(`${label}.timingSource 非法`);return value;}
export const ANALYSIS_LAYERS = ['audio', 'rhythm', 'sections', 'envelopes', 'onsets', 'lyrics', 'stems'];
export const ENVELOPE_KEYS = ['rms', 'low', 'mid', 'high', 'vocal', 'drums', 'bass', 'other'];
export const ONSET_KEYS = ['kick', 'snare', 'hat', 'vocal'];
export const STEM_KEYS = ['vocal', 'drums', 'bass', 'other'];
const EPS = 1e-6;

export class SongError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const fail = (message) => { throw new SongError(message); };
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value, label, { min = -Infinity, max = Infinity } = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} 必须是有限数字`);
  if (value < min - EPS || value > max + EPS) fail(`${label} 超出 [${min}, ${max}]`);
  return value;
};
const int = (value, label, { min = 0 } = {}) => {
  if (!Number.isInteger(value) || value < min) fail(`${label} 必须是不小于 ${min} 的整数`);
  return value;
};
const str = (value, label, limit = 200) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} 必须是非空字符串`);
  if (value.length > limit) fail(`${label} 超过 ${limit} 字符`);
  return value;
};
const conf = (value, label) => {
  if (value === undefined) return undefined;
  return num(value, `${label}.confidence`, { min: 0, max: 1 });
};
const hash = (value, label) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} 必须是 64 位十六进制内容哈希`);
  return value;
};
const increasing = (values, label, { strict = true } = {}) => {
  if (!Array.isArray(values) || !values.length) fail(`${label} 必须是非空数组`);
  for (let i = 0; i < values.length; i++) num(values[i], `${label}[${i}]`, { min: 0 });
  for (let i = 1; i < values.length; i++) {
    if (strict ? values[i] <= values[i - 1] : values[i] < values[i - 1]) fail(`${label}[${i}] 必须递增`);
  }
  return values;
};
// 空通道合法：无鼓/清唱/纯鼓 loop 的某类起音本来就检测不到。
const onsetTrack = (value, label, duration) => {
  if (!Array.isArray(value)) fail(`${label} 必须是 [time, strength] 数组`);
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) fail(`${label}[${index}] 必须是 [time, strength]`);
    const t = num(entry[0], `${label}[${index}].t`, { min: 0, max: duration + 1 });
    const strength = num(entry[1], `${label}[${index}].strength`, { min: 0, max: 1 });
    return [t, strength];
  }).sort((a, b) => a[0] - b[0]);
};
const sectionLabel = (name) => SECTION_LABELS.find((label) => name.startsWith(label)) ?? 'unknown';

function validateProvenance(layer, value, label) {
  if (!isObject(value)) fail(`${label} 必须是对象`);
  str(value.tool, `${label}.tool`, 120);
  str(value.version, `${label}.version`, 120);
  if (typeof value.startedAt !== 'number') fail(`${label}.startedAt 必须是时间戳`);
  num(value.confidence ?? 1, `${label}.confidence`, { min: 0, max: 1 });
  if (value.model !== undefined) str(value.model, `${label}.model`, 200);
  if (value.params !== undefined && !isObject(value.params)) fail(`${label}.params 必须是对象`);
  return { ...value, layer };
}

function validateWords(words, label, lineStart, lineEnd) {
  if (!Array.isArray(words) || !words.length) fail(`${label}.words 必须是非空数组`);
  let previous = lineStart - 0.05;
  return words.map((word, index) => {
    if (!isObject(word)) fail(`${label}.words[${index}] 必须是对象`);
    const w = str(word.w, `${label}.words[${index}].w`, 200);
    const start = num(word.start, `${label}.words[${index}].start`, { min: Math.max(0, previous), max: lineEnd + 0.5 });
    const end = num(word.end, `${label}.words[${index}].end`, { min: start, max: lineEnd + 0.5 });
    const confidence = conf(word.conf, `${label}.words[${index}]`);
    previous = end;
    const source=timingSource(word.timingSource,`${label}.words[${index}]`);
    return { w, start, end, ...(confidence !== undefined ? { conf: confidence } : {}),...(source?{timingSource:source}:{}) };
  });
}

function validateLyrics(value, duration) {
  str(value.language, 'lyrics.language', 20);
  if (!LYRIC_SOURCES.includes(value.textSource)) fail(`lyrics.textSource 必须是 ${LYRIC_SOURCES.join('/')}`);
  if (typeof value.humanConfirmed !== 'boolean') fail('lyrics.humanConfirmed 必须是布尔值（AI 不能代替人确认）');
  if (!Array.isArray(value.lines) || !value.lines.length) fail('lyrics.lines 必须是非空数组');
  const lines = value.lines.map((line, index) => {
    if (!isObject(line)) fail(`lyrics.lines[${index}] 必须是对象`);
    const text = str(line.text, `lyrics.lines[${index}].text`, 2000);
    const start = num(line.start, `lyrics.lines[${index}].start`, { min: 0, max: duration });
    const end = num(line.end, `lyrics.lines[${index}].end`, { min: start, max: duration });
    const words = validateWords(line.words, `lyrics.lines[${index}]`, start, end);
    const source=timingSource(line.timingSource,`lyrics.lines[${index}]`);
    if(line.fallback!==undefined&&typeof line.fallback!=='boolean')fail('line.fallback 必须为布尔值');
    return { text, start, end, words,...(source?{timingSource:source}:{}),...(line.fallback!==undefined?{fallback:line.fallback}:{}) };
  });
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start < lines[i - 1].start) fail(`lyrics.lines[${i}] 必须按时间排列`);
  }
  let extras;
  timingSource(value.timingSource,'lyrics');
  if (value.extras !== undefined) {
    if (!Array.isArray(value.extras)) fail('lyrics.extras 必须是数组');
    extras = value.extras.map((extra, index) => ({
      start: num(extra.start, `lyrics.extras[${index}].start`, { min: 0, max: duration }),
      end: num(extra.end, `lyrics.extras[${index}].end`, { min: 0, max: duration }),
      desc: str(extra.desc, `lyrics.extras[${index}].desc`, 2000),
    }));
  }
  return { ...value, lines, ...(extras ? { extras } : {}) };
}

/** 校验并归一化一份 v2 分析数据；原对象不被修改。非法即抛 SongError。 */
export function validateAnalysis(raw) {
  if (!isObject(raw)) fail('分析数据必须是对象');
  if (raw.schema !== ANALYSIS_SCHEMA) fail(`schema 必须是 ${ANALYSIS_SCHEMA}`);
  const allowed = ['schema', 'title', 'audio', 'rhythm', 'sections', 'envelopes', 'onsets', 'stems', 'lyrics', 'overrides', 'provenance'];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`未知顶层字段：${key}`);

  const audioLayer = raw.audio;
  if (!isObject(audioLayer)) fail('audio 层必填');
  const audio = {
    hash: hash(audioLayer.hash, 'audio.hash'),
    duration: num(audioLayer.duration, 'audio.duration', { min: 0 }),
    sampleRate: num(audioLayer.sampleRate, 'audio.sampleRate', { min: 1 }),
    channels: int(audioLayer.channels, 'audio.channels', { min: 1 }),
    decoderOffset: num(audioLayer.decoderOffset ?? 0, 'audio.decoderOffset'),
  };
  const duration = audio.duration;

  const rhythmLayer = raw.rhythm;
  if (!isObject(rhythmLayer)) fail('rhythm 层必填');
  let tempoMap;
  if (rhythmLayer.tempoMap !== undefined) {
    if (!Array.isArray(rhythmLayer.tempoMap) || !rhythmLayer.tempoMap.length) fail('rhythm.tempoMap 必须是非空数组');
    tempoMap = rhythmLayer.tempoMap.map((entry, index) => {
      if (!Array.isArray(entry) || entry.length !== 2) fail(`rhythm.tempoMap[${index}] 必须是 [time, bpm]`);
      return [num(entry[0], `rhythm.tempoMap[${index}].t`, { min: 0, max: duration }), num(entry[1], `rhythm.tempoMap[${index}].bpm`, { min: 20, max: 400 })];
    });
  }
  const bpm = rhythmLayer.bpm !== undefined ? num(rhythmLayer.bpm, 'rhythm.bpm', { min: 20, max: 400 }) : undefined;
  if (bpm === undefined && !tempoMap) fail('rhythm 需要 bpm 或 tempoMap 之一');
  const rhythm = {
    ...(bpm !== undefined ? { bpm } : {}),
    ...(tempoMap ? { tempoMap } : {}),
    beatPeriod: rhythmLayer.beatPeriod !== undefined ? num(rhythmLayer.beatPeriod, 'rhythm.beatPeriod', { min: 0.05, max: 3 }) : undefined,
    beats: increasing(rhythmLayer.beats, 'rhythm.beats').map((t, i) => t > duration + 1 ? fail(`rhythm.beats[${i}] 越过音频时长`) : t),
    downbeats: increasing(rhythmLayer.downbeats, 'rhythm.downbeats'),
    meter: int(rhythmLayer.meter ?? 4, 'rhythm.meter', { min: 1 }),
    confidence: conf(rhythmLayer.confidence, 'rhythm') ?? 1,
  };
  if (rhythm.downbeats[rhythm.downbeats.length - 1] > duration + 1) fail('rhythm.downbeats 越过音频时长');

  if (!Array.isArray(raw.sections) || !raw.sections.length) fail('sections 必须是非空数组');
  const sections = raw.sections.map((section, index) => {
    if (!isObject(section)) fail(`sections[${index}] 必须是对象`);
    const start = num(section.start, `sections[${index}].start`, { min: 0, max: duration });
    const end = num(section.end, `sections[${index}].end`, { min: start, max: duration });
    const name = str(section.name ?? section.label, `sections[${index}].name`, 120);
    const label = section.label !== undefined
      ? (SECTION_LABELS.includes(section.label) ? section.label : fail(`sections[${index}].label 必须是 ${SECTION_LABELS.join('/')}`))
      : sectionLabel(name.toLowerCase());
    return { start, end, label, name, confidence: conf(section.confidence, `sections[${index}]`) ?? 1 };
  });
  for (let i = 1; i < sections.length; i++) {
    if (sections[i].start < sections[i - 1].end - EPS) fail(`sections[${i}] 与上一段重叠`);
  }

  if (!isObject(raw.envelopes)) fail('envelopes 必填');
  const frameRate = num(raw.envelopes.frameRate, 'envelopes.frameRate', { min: 1 });
  const envKeys = ENVELOPE_KEYS.filter((key) => raw.envelopes[key] !== undefined);
  if (!envKeys.includes('rms')) fail('envelopes.rms 必填');
  for (const key of envKeys) if (!Array.isArray(raw.envelopes[key])) fail(`envelopes.${key} 必须是数组`);
  const lengths = envKeys.map((key) => raw.envelopes[key].length);
  if (new Set(lengths).size !== 1) fail('envelopes 各通道长度必须一致');
  const frames = lengths[0];
  if (frames < 2) fail('envelopes 帧数不足');
  const envelopes = { frameRate, frames };
  for (const key of envKeys) {
    const values = raw.envelopes[key];
    if (!Array.isArray(values) || values.length < 2) fail(`envelopes.${key} 必须是数组`);
    for (let i = 0; i < values.length; i++) num(values[i], `envelopes.${key}[${i}]`, { min: 0, max: 1 });
    envelopes[key] = values;
  }

  if (!isObject(raw.onsets)) fail('onsets 必填');
  const onsets = {};
  for (const key of ONSET_KEYS) {
    if (raw.onsets[key] === undefined) fail(`onsets.${key} 必填`);
    onsets[key] = onsetTrack(raw.onsets[key], `onsets.${key}`, duration);
  }

  let stems;
  if (raw.stems !== undefined) {
    if (!isObject(raw.stems)) fail('stems 必须是对象（内容哈希，不含字节）');
    stems = {};
    for (const key of Object.keys(raw.stems)) {
      if (!STEM_KEYS.includes(key)) fail(`stems 不支持通道 ${key}`);
      stems[key] = hash(raw.stems[key], `stems.${key}`);
    }
  }

  let lyrics;
  if (raw.lyrics !== undefined) lyrics = validateLyrics(raw.lyrics, duration);

  if (!Array.isArray(raw.overrides)) fail('overrides 必须是数组（无修正时为空数组）');
  const overrides = raw.overrides.map((entry, index) => {
    if (!isObject(entry)) fail(`overrides[${index}] 必须是对象`);
    return {
      layer: str(entry.layer, `overrides[${index}].layer`, 40),
      author: entry.author === 'human' || entry.author === 'mcp' ? entry.author : fail(`overrides[${index}].author 必须是 human/mcp`),
      at: typeof entry.at === 'number' ? entry.at : fail(`overrides[${index}].at 必须是时间戳`),
      patch: isObject(entry.patch) ? entry.patch : fail(`overrides[${index}].patch 必须是对象`),
      ...(entry.note !== undefined ? { note: str(entry.note, `overrides[${index}].note`, 2000) } : {}),
    };
  });

  if (!isObject(raw.provenance)) fail('provenance 必填');
  const provenance = {};
  const present = ['audio', 'rhythm', 'sections', 'envelopes', 'onsets', ...(lyrics ? ['lyrics'] : []), ...(stems ? ['stems'] : [])];
  for (const layer of present) {
    if (raw.provenance[layer] === undefined) fail(`provenance.${layer} 缺失`);
    provenance[layer] = validateProvenance(layer, raw.provenance[layer], `provenance.${layer}`);
  }

  return {
    schema: ANALYSIS_SCHEMA,
    ...(raw.title !== undefined ? { title: str(raw.title, 'title', 200) } : {}),
    audio, rhythm, sections, envelopes, onsets,
    ...(stems ? { stems } : {}),
    ...(lyrics ? { lyrics } : {}),
    overrides, provenance,
  };
}

/** 器乐工程判定：没有 lyrics 层即视为器乐（不伪造歌词）。 */
export const isInstrumental = (analysis) => analysis.lyrics === undefined;

/** 供 UI/规划使用的节拍查询：返回 [start, end) 内的拍时刻。 */
export function beatsBetween(analysis, start, end) {
  return analysis.rhythm.beats.filter((t) => t >= start && t < end);
}

/** 段落查询：返回覆盖 [start, end) 的段落（可跨界）。 */
export function sectionsBetween(analysis, start, end) {
  return analysis.sections.filter((section) => section.start < end && section.end > start);
}

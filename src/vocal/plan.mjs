import { buildUstx, serializeUstx, validateUstxText, UstxError, TICKS_PER_BEAT } from './ustx.mjs';
export { normalizeMix } from './mix.mjs';

const fail = (message) => { throw new UstxError(message); };
function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} 不支持这些字段：${unknown.join(', ')}`);
}
// The service deliberately exposes the renderer's supported subset. No silent loss of expressions.
export function prepareVocalPlan(plan, duration) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('plan 必须是对象');
  keys(plan, ['name', 'tempo', 'key', 'timeSignatures', 'tracks', 'parts'], 'plan');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) fail('先完成歌曲分析（支持最长一小时）');
  if (plan.tracks?.length !== 1 || plan.parts?.length !== 1) fail('目前支持一条轨道、一个 part、固定 BPM');
  keys(plan.parts[0], ['name', 'trackNo', 'positionTick', 'notes', 'pitchDeviation', 'dynamics'], 'part');
  const notes = plan.parts[0].notes;
  if (!Array.isArray(notes) || !notes.length || notes.length > 2000) fail('音符数量必须为 1..2000');
  const track = plan.tracks[0];
  keys(track, ['singer', 'phonemizer', 'trackName', 'volume', 'pan'], 'track');
  if (track.phonemizer || (track.volume !== undefined && track.volume !== 0) || (track.pan !== undefined && track.pan !== 0)) fail('不支持 phonemizer / 轨道音量 / 声像；请使用 oto 别名和 mix 增益');
  for (const note of notes) {
    keys(note, ['lyric', 'tone', 'pitch', 'startTick', 'startBeats', 'durationTicks', 'durationBeats', 'pitchCurve', 'vibrato', 'snapFirst', 'text', 'volume', 'velocity', 'attack', 'decay', 'envelope'], '音符');
    if (typeof note.lyric !== 'string' || !note.lyric.trim() || note.lyric.length > 200) fail('lyric 必须是 oto 别名（休止符为 R）');
    if (note.vibrato !== undefined) keys(note.vibrato, ['length','period','depth','in','out','shift','drift','volLink'], 'vibrato');
    if ((note.vibrato?.volLink ?? 0) !== 0) fail('尚不支持 vibrato.volLink，请用 dynamics');
    if (note.text !== undefined && (typeof note.text !== 'string' || note.text.length > 200 || /[\r\n]/.test(note.text))) fail('text 必须是单行显示歌词，最长 200 字');
  }
  if (!notes.some((note) => note.lyric.trim().toUpperCase() !== 'R')) fail('乐谱必须包含非休止音符');
  const ustx = buildUstx(plan);
  const ustxText = serializeUstx(ustx), verdict = validateUstxText(ustxText);
  if (!verdict.ok) fail(verdict.errors.join('; '));
  const secondsPerTick = 60 / (ustx.tempos[0].bpm * TICKS_PER_BEAT);
  const part = ustx.voice_parts[0];
  for (const note of part.notes) {
    if (![note.position, note.duration, part.position].every(Number.isSafeInteger)) fail('音符位置和时长必须是安全整数');
    if ((part.position + note.position + note.duration) * secondsPerTick > duration + 0.001) fail('音符超出原音频时长');
  }
  for (const field of ['pitchDeviation','dynamics']) for (const p of plan.parts[0][field] ?? []) {
    if (p.timeMs > duration*1000+0.001) fail(`${field} 超出原音频时长`);
  }
  // Preserve display text separately from the voicebank's literal synthesis aliases.
  const lyrics = notes.filter((n) => n.lyric.trim().toUpperCase() !== 'R' && n.text?.trim()).map((n) => {
    const start = (n.startTick ?? Math.round(n.startBeats * TICKS_PER_BEAT)) * secondsPerTick;
    const end = start + (n.durationTicks ?? Math.round(n.durationBeats * TICKS_PER_BEAT)) * secondsPerTick;
    return { text: n.text.trim(), start, end, words: [{ w: n.text.trim(), start, end }] };
  }).sort((a, b) => a.start - b.start);
  const stamp = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  return { plan: structuredClone(plan), ustxText, lyrics: { timingSource: 'score', humanConfirmed: false, lines: lyrics },
    lrc: lyrics.map((line) => `[${stamp(line.start)}]${line.text}`).join('\n') + '\n' };
}


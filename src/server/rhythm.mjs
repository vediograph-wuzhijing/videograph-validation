// rhythm.mjs — LLM-AE 的“耳朵和尺子”（AE-01 / AE-04）：纯函数，无 I/O。
// 输入是工程的 song（toFullSong 格式：beats/downbeats/kick/snare/rms…/envFps/sections/lines），
// 输出给 LLM 读的文本节奏表，以及画面运动对照音乐的节奏报告。

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const median = (values) => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (values) => { const list = values.filter(finite); return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0; };
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : 0;
const isCjk = (text) => /[　-鿿＀-￯]/.test(text);
const pad = (value, width) => { const text = String(value); return text + ' '.repeat(Math.max(0, width - [...text].reduce((sum, ch) => sum + (isCjk(ch) ? 2 : 1), 0))); };
const LEVEL_GLYPH = ['·', '▁', '▃', '▅', '▆', '█'];

/** 节奏网格：以下拍分小节；无下拍时每 4 拍一小节；无拍点时按 2 秒切块并标注。 */
export function barGrid(song) {
  const duration = song.duration;
  const beats = (song.beats ?? []).filter(finite).sort((a, b) => a - b);
  let downbeats = (song.downbeats ?? []).filter(finite).sort((a, b) => a - b);
  let grid = 'downbeats';
  if (!downbeats.length && beats.length) { downbeats = beats.filter((_, index) => index % 4 === 0); grid = 'beats/4'; }
  if (!downbeats.length) { downbeats = []; for (let t = 0; t < duration; t += 2) downbeats.push(t); grid = 'blocks-2s'; }
  // 弱起：首个下拍前不足 0.4 小节的零头并入第 1 小节，否则单列为“弱起”（序号 0）。
  const barLength = median(downbeats.slice(1).map((t, i) => t - downbeats[i])) || 2;
  const pickup = downbeats[0] > 0.4 * barLength;
  const starts = pickup ? [0, ...downbeats] : [0, ...downbeats.slice(1)];
  const bars = [];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index], end = Math.min(duration, starts[index + 1] ?? duration);
    if (end - start < 1e-6) continue;
    bars.push({ index: bars.length + (pickup ? 0 : 1), start, end, pickup: pickup && index === 0,
      beats: beats.filter((t) => t >= start - 1e-6 && t < end - 1e-6) });
  }
  return { grid, bars };
}

/** 包络在时间 t 的值（线性插值）。 */
export function envelopeAt(song, key, t) {
  const env = song[key];
  if (!Array.isArray(env) || !env.length) return null;
  const x = t * (song.envFps ?? 30), i = Math.floor(x), f = x - i;
  const a = env[Math.max(0, Math.min(env.length - 1, i))], b = env[Math.max(0, Math.min(env.length - 1, i + 1))];
  return a + (b - a) * f;
}
function envelopeMean(song, key, start, end) {
  const env = song[key];
  if (!Array.isArray(env) || !env.length) return null;
  const fps = song.envFps ?? 30;
  const from = Math.max(0, Math.floor(start * fps)), to = Math.min(env.length, Math.max(from + 1, Math.ceil(end * fps)));
  return mean(env.slice(from, to));
}
const onsetList = (song, key, min = 0.3) => (song[key] ?? []).map((entry) => Array.isArray(entry) ? { t: entry[0], s: entry[1] ?? 1 } : { t: entry, s: 1 }).filter((entry) => finite(entry.t) && entry.s >= min);

/** 每小节音乐能量 1–5（全曲分位数）；没有 rms 时为 null。 */
function audioLevels(song, bars) {
  const values = bars.map((bar) => envelopeMean(song, 'rms', bar.start, bar.end));
  if (values.some((value) => value === null)) return bars.map(() => null);
  // 以全曲小节能量的 p5–p95 为满量程分 5 级（比分位数稳：两档响度的歌不会被硬拆成 5 级）。
  const sorted = [...values].sort((a, b) => a - b);
  const low = quantile(sorted, 0.05), high = quantile(sorted, 0.95);
  if (high - low < 1e-9) return values.map(() => 3);
  return values.map((value) => Math.max(1, Math.min(5, 1 + Math.floor((value - low) / (high - low) * 5))));
}

/** 小节内鼓点型：每拍 2 格，K=kick S=snare X=同时 .=无；拍与拍之间空格分隔。 */
function drumPattern(bar, kicks, snares) {
  const edges = bar.beats.length ? [...bar.beats.filter((t) => t > bar.start + 1e-3), bar.end] : [];
  const beatStarts = bar.beats.length ? [bar.start, ...edges.slice(0, -1)] : Array.from({ length: 4 }, (_, i) => bar.start + (bar.end - bar.start) * i / 4);
  const beatEnds = bar.beats.length ? edges : beatStarts.map((_, i) => bar.start + (bar.end - bar.start) * (i + 1) / 4);
  return beatStarts.map((start, beat) => {
    const end = beatEnds[beat], half = (start + end) / 2;
    return [[start, half], [half, end]].map(([from, to]) => {
      const k = kicks.some((o) => o.t >= from - 0.02 && o.t < to - 0.02), s = snares.some((o) => o.t >= from - 0.02 && o.t < to - 0.02);
      return k && s ? 'X' : k ? 'K' : s ? 'S' : '.';
    }).join('');
  }).join(' ');
}

function barWords(song, bar) {
  const words = (song.lines ?? []).flatMap((line) => line.words ?? []).filter((word) => word.start >= bar.start - 1e-3 && word.start < bar.end - 1e-3).map((word) => word.w);
  if (words.length) { const text = words.join(words.some(isCjk) ? '' : ' '); return text.length > 44 ? text.slice(0, 43) + '…' : text; }
  if ((song.lines ?? []).some((line) => line.start < bar.end && line.end > bar.start)) return '～（拖音）';
  const vocal = envelopeMean(song, 'vocal', bar.start, bar.end);
  return vocal !== null && vocal > 0.3 ? '（人声，无词）' : '—';
}

/** 歌曲时间 t 对应的“小节.拍”与事件标记（filmstrip 标签用）。 */
export function beatLabel(song, t, tolerance = 1 / 30) {
  const { bars } = barGrid(song);
  const bar = bars.find((entry) => t >= entry.start - 1e-6 && t < entry.end) ?? bars[bars.length - 1];
  const beatIndex = bar ? bar.beats.filter((b) => b <= t + 1e-6).length : 0;
  const near = (list) => list.some((value) => Math.abs((value.t ?? value) - t) <= tolerance);
  const marks = [];
  if (near(song.downbeats ?? [])) marks.push('●下拍'); else if (near(song.beats ?? [])) marks.push('•拍');
  if (near(onsetList(song, 'kick', 0.3))) marks.push('K');
  if (near(onsetList(song, 'snare', 0.3))) marks.push('S');
  const word = (song.lines ?? []).flatMap((line) => line.words ?? []).find((entry) => t >= entry.start && t < entry.end)?.w;
  return { bar: bar?.index ?? 0, beat: Math.max(1, beatIndex), marks, word: word ?? null, text: `${t.toFixed(2)}s  ${bar?.index ?? 0}.${Math.max(1, beatIndex)}${marks.length ? '  ' + marks.join(' ') : ''}${word ? `  “${word}”` : ''}` };
}

/**
 * AE-01 节奏表：给 LLM 读的按小节文本。shots/transitions 可选，用来标出现有切点。
 * 返回 { text, bars: [{ index, start, end, section, energy, drums, words, marks }] }。
 */
export function cueSheet(song, { start = 0, end = Infinity, shots = [], transitions = [] } = {}) {
  if (!song || !finite(song.duration)) throw new Error('工程没有可用的音乐分析（song）');
  const { grid, bars } = barGrid(song);
  const levels = audioLevels(song, bars);
  const kicks = onsetList(song, 'kick'), snares = onsetList(song, 'snare');
  const sections = song.sections ?? [];
  const sectionOf = (t) => sections.findIndex((section) => t >= section.start - 0.05 && t < section.end - 0.05);
  const rows = bars.map((bar, i) => {
    const sectionIndex = sectionOf(bar.start);
    const section = sections[sectionIndex];
    const inSection = section ? bars.filter((other) => sectionOf(other.start) === sectionIndex && other.start <= bar.start).length : 0;
    const total = section ? bars.filter((other) => sectionOf(other.start) === sectionIndex).length : 0;
    const marks = [];
    const level = levels[i], previous = levels[i - 1];
    if (level !== null && previous != null && level - previous >= 2) marks.push('↑↑爆发');
    if (level !== null && previous != null && previous - level >= 2) marks.push('↓↓回落');
    if (i >= 2 && level !== null && levels[i - 2] !== null && levels[i - 2] < previous && previous < level) marks.push('⇗蓄力');
    shots.forEach((shot, index) => {
      if (index > 0 && shot.start >= bar.start - 1e-3 && shot.start < bar.end - 1e-3) {
        const incoming = transitions.find((transition) => transition.toShotId === shot.id);
        marks.push(`✂${index + 1}${incoming && incoming.mode && incoming.mode !== 'cut' ? `(${incoming.mode})` : ''}@${shot.start.toFixed(2)}`);
      }
    });
    return { index: bar.index, start: bar.start, end: bar.end, pickup: bar.pickup, section: section ? `${inSection === 1 ? '▶' : ' '}${section.name} ${inSection}/${total}` : '—',
      energy: level, drums: drumPattern(bar, kicks, snares), words: barWords(song, bar), marks };
  }).filter((row) => row.end > start && row.start < end);
  const header = [
    `节奏表 · ${song.song ?? '未命名'} · ${finite(song.bpm) ? song.bpm.toFixed(1) + ' BPM' : '变速/未知 BPM'} · ${Math.max(0, start).toFixed(2)}–${Math.min(song.duration, end).toFixed(2)}s · ${rows.length} 小节` +
      (grid === 'downbeats' ? '' : grid === 'beats/4' ? '（无下拍数据：按每 4 拍推算小节，低置信）' : '（无拍点数据：按 2 秒分块，不是真实小节）'),
    '图例：能量 1–5 = 小节 rms 在全曲 p5–p95 范围内的位置；鼓点每拍 2 格 K=kick S=snare X=同时 .=无；▶=段落首小节；↑↑/↓↓=能量突变；⇗=连续上升（蓄力）；✂n=第 n 镜头切点',
    '用法：大动作（切、爆、换色、砸落）落在 ▶/↑↑/下拍 K 上；⇗ 处蓄力；↓↓ 与低能量处留白；不要全片同一强度。',
    '',
    `${pad('小节', 6)}${pad('时间', 8)}${pad('段落', 16)}${pad('能量', 6)}${pad('鼓点', 22)}${pad('歌词', 30)}标记`,
  ];
  const lines = rows.map((row) => `${pad(row.pickup ? '弱起' : row.index, 6)}${pad(row.start.toFixed(2), 8)}${pad(row.section, 16)}${pad(row.energy === null ? '?' : `${LEVEL_GLYPH[row.energy]}${row.energy}`, 6)}${pad(row.drums, 22)}${pad(row.words, 30)}${row.marks.join(' ')}`);
  const visibleSections = sections.filter((section) => section.end > start && section.start < end);
  const summary = visibleSections.length ? ['', '段落：' + visibleSections.map((section) => {
    const own = rows.filter((row) => row.start >= section.start - 0.05 && row.start < section.end - 0.05 && row.energy !== null);
    return `${section.name} ${section.start.toFixed(1)}–${section.end.toFixed(1)}s(均能量 ${own.length ? mean(own.map((row) => row.energy)).toFixed(1) : '?'})`;
  }).join(' | ')] : [];
  return { text: [...header, ...lines, ...summary].join('\n'), grid, bars: rows };
}

// ---------------------------------------------------------------------- AE-04 节奏报告

/** 指标算法版本：改阈值/规则时递增，渲染进程据此重算报告（采样帧缓存不受影响）。 */
export const RHYTHM_VERSION = 'rhythm-v7';

/**
 * 画面运动等级 1–5（小节内帧间平均灰度差，0..1；64×36、每格 8×8 子采样，15–30fps）。
 * 阈值 = pdoom 参考复现片（公认的好作品）全片小节运动的 p20/p40/p60/p80，见 ROADMAP AE-04 基准记录：
 * 也就是说，参考片自身的五个等级大致各占 1/5。等级 1 ≈ 接近静止，等级 5 ≈ 参考片里最激烈的那 1/5。
 */
export const VISUAL_THRESHOLDS = [0.014, 0.021, 0.033, 0.049];
/**
 * 相对运动等级（rhythm-v6 起用于“画面”列与死区/过忙判断）：小节运动 ÷ 画面墨量（ink，帧内像素偏离本帧中位亮度的平均量）。
 * 含义是“可见内容里有多大比例在变”，细线/小主体的构图不会因为画面暗、线条细被判成静止。
 * 阈值同样取 pdoom 参考片全片小节相对运动的五分位（见 ROADMAP AE-04 校准记录）；ink 低于 INK_FLOOR 的近黑画面按 INK_FLOOR 计，避免除零放大。
 */
export const REL_THRESHOLDS = [0.24, 0.40, 0.51, 0.73];
export const INK_FLOOR = 0.01;
const levelOf = (value, cuts) => 1 + cuts.filter((cut) => value > cut).length;
const visualLevel = (motion) => levelOf(motion, VISUAL_THRESHOLDS);

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
function spearman(a, b) {
  const rank = (values) => { const order = values.map((value, index) => [value, index]).sort((x, y) => x[0] - y[0]); const ranks = []; order.forEach(([, index], r) => { ranks[index] = r; }); return ranks; };
  return pearson(rank(a), rank(b));
}

/** 画面运动峰：局部极大且高于稳健阈值（中位数 + 3·MAD），相邻 2 帧内只留最高者。 */
export function motionPeaks(times, motion) {
  const values = motion.map((value) => finite(value) ? value : 0);
  const med = median(values), mad = median(values.map((value) => Math.abs(value - med)));
  const threshold = Math.max(med + 3 * 1.4826 * mad, med * 1.5, 0.004);
  const peaks = [];
  for (let i = 1; i < values.length; i++) {
    const value = values[i];
    if (value < threshold || value < values[i - 1] || value < (values[i + 1] ?? 0)) continue;
    const last = peaks[peaks.length - 1];
    if (last && i - last.i <= 2) { if (value > last.value) peaks[peaks.length - 1] = { i, t: times[i], value }; continue; }
    peaks.push({ i, t: times[i], value });
  }
  return { threshold, peaks };
}

/**
 * AE-04：画面运动 vs 音乐。series = { fps, t[], motion[], luma[] }（motion[i] 为第 i 帧与上一帧的平均灰度差，0..1）。
 * 返回 { text, metrics, bars, chart }，chart 是给渲染页画对照图的数据。
 */
export function analyzeRhythm(song, series, { shots = [], label = '' } = {}) {
  const { fps, t: times, motion, luma } = series;
  const ink = Array.isArray(series.ink) && series.ink.length === times.length ? series.ink : null;
  // 等级用 1/15 秒间隔的运动（与参考片校准口径一致）；缺省回退相邻帧运动。
  const levelMotion = Array.isArray(series.levelMotion) && series.levelMotion.length === times.length ? series.levelMotion : motion;
  if (!times.length) throw new Error('没有采样帧');
  const start = times[0], end = times[times.length - 1] + 1 / fps;
  const tolerance = Math.max(2.5 / fps, 0.08);
  const { peaks, threshold } = motionPeaks(times, motion);
  // 首帧没有上一帧可比，落在首帧的事件不计入命中统计。
  const inRange = (t) => t >= start + 0.5 / fps && t < end;
  const events = {
    downbeat: (song.downbeats ?? []).filter(inRange),
    kick: onsetList(song, 'kick', 0.5).map((o) => o.t).filter(inRange),
    snare: onsetList(song, 'snare', 0.5).map((o) => o.t).filter(inRange),
    beat: (song.beats ?? []).filter(inRange),
  };
  const nearestPeak = (t) => peaks.reduce((best, peak) => (!best || Math.abs(peak.t - t) < Math.abs(best.t - t) ? peak : best), null);
  const hits = Object.fromEntries(Object.entries(events).map(([name, list]) => {
    const offsets = list.map((t) => { const peak = nearestPeak(t); return peak && Math.abs(peak.t - t) <= tolerance ? peak.t - t : null; });
    const matched = offsets.filter((value) => value !== null);
    return [name, { events: list.length, hit: matched.length, rate: list.length ? matched.length / list.length : null, medianOffsetMs: matched.length ? Math.round(median(matched) * 1000) : null }];
  }));
  // “在拍上”= 靠近拍、鼓点或唱词起点（歌词驱动的画面以词起点为节奏锚，见 shotcraft 法则 2）。
  const wordStarts = (song.lines ?? []).flatMap((line) => line.words ?? []).map((word) => word.start).filter(finite);
  const grid = [...events.beat, ...onsetList(song, 'kick', 0.3).map((o) => o.t), ...onsetList(song, 'snare', 0.3).map((o) => o.t), ...wordStarts];
  const onGrid = peaks.filter((peak) => grid.some((t) => Math.abs(t - peak.t) <= tolerance)).length;

  // 音频起音强度（drums 包络优先，其次 rms）的正向差分，对照画面运动做相关与最佳偏移。
  const envKey = Array.isArray(song.drums) && song.drums.length ? 'drums' : Array.isArray(song.rms) && song.rms.length ? 'rms' : null;
  const onset = envKey ? times.map((t) => Math.max(0, (envelopeAt(song, envKey, t) ?? 0) - (envelopeAt(song, envKey, t - 1 / fps) ?? 0))) : null;
  const level = envKey ? times.map((t) => envelopeAt(song, 'rms', t) ?? envelopeAt(song, envKey, t) ?? 0) : null;
  let correlation = null;
  if (onset) {
    const at = (lag) => pearson(motion.slice(Math.max(0, lag), motion.length + Math.min(0, lag)).map((v) => v ?? 0), onset.slice(Math.max(0, -lag), onset.length - Math.max(0, lag)));
    const lags = [-3, -2, -1, 0, 1, 2, 3].map((lag) => ({ lag, r: at(lag) }));
    const best = lags.reduce((a, b) => (b.r > a.r ? b : a));
    correlation = { r0: +lags[3].r.toFixed(3), best: { lagFrames: best.lag, lagMs: Math.round(best.lag * 1000 / fps), r: +best.r.toFixed(3) } };
  }

  // 每小节：音乐能量（全曲分位）vs 画面运动等级。
  const { bars: allBars } = barGrid(song);
  const audio = audioLevels(song, allBars);
  const bars = allBars.map((bar, index) => ({ bar, audio: audio[index] })).filter(({ bar }) => bar.end > start && bar.start < end).map(({ bar, audio: audioLevel }) => {
    const own = times.map((t, i) => (t >= bar.start && t < bar.end ? levelMotion[i] : null)).filter(finite);
    const motionMean = mean(own);
    const inkMean = ink ? mean(times.map((t, i) => (t >= bar.start && t < bar.end ? ink[i] : null)).filter(finite)) : null;
    const rel = inkMean === null ? null : motionMean / Math.max(inkMean, INK_FLOOR);
    const downbeat = events.downbeat.find((t) => t >= bar.start - 1e-3 && t < bar.end - 1e-3);
    const downbeatHit = downbeat === undefined ? null : (() => { const peak = nearestPeak(downbeat); return !!peak && Math.abs(peak.t - downbeat) <= tolerance; })();
    return { index: bar.index, start: bar.start, end: bar.end, audio: audioLevel, visual: !own.length ? null : rel === null ? visualLevel(motionMean) : levelOf(rel, REL_THRESHOLDS), absVisual: own.length ? visualLevel(motionMean) : null,
      motion: +motionMean.toFixed(4), ink: inkMean === null ? null : +inkMean.toFixed(4), rel: rel === null ? null : +rel.toFixed(4), downbeatHit };
  });
  const runs = (predicate, minLength) => {
    const found = []; let current = [];
    for (const bar of [...bars, null]) {
      if (bar && predicate(bar)) { current.push(bar); continue; }
      if (current.length >= minLength) found.push({ from: current[0].start, to: current[current.length - 1].end, bars: current.map((entry) => entry.index) });
      current = [];
    }
    return found;
  };
  const deadZones = runs((bar) => bar.audio !== null && bar.audio >= 4 && bar.visual !== null && bar.visual <= 1, 2);
  const busyZones = runs((bar) => bar.audio !== null && bar.audio <= 1 && bar.visual !== null && bar.visual >= 5, 4);
  const flatZones = runs((bar) => bar.visual !== null && bar.downbeatHit === false && bar.audio !== null && bar.audio >= 3, 8);

  // 段落能量跟随：各段音乐均能量 vs 画面均运动的秩相关（≥3 段才有意义）。
  const sections = (song.sections ?? []).filter((section) => section.end > start && section.start < end);
  const sectionStats = sections.map((section) => {
    const idx = times.map((t, i) => (t >= section.start && t < section.end ? i : -1)).filter((i) => i >= 0);
    return { name: section.name, start: section.start, end: section.end, audio: level ? +mean(idx.map((i) => level[i])).toFixed(4) : null, motion: +mean(idx.map((i) => motion[i])).toFixed(4) };
  }).filter((entry) => entry.motion > 0 || entry.audio);
  const sectionFollow = sectionStats.length >= 3 && sectionStats.every((entry) => entry.audio !== null) ? +spearman(sectionStats.map((s) => s.audio), sectionStats.map((s) => s.motion)).toFixed(3) : null;

  // 闪烁风险（近似 WCAG 2.3.1 一般闪光）：全画面平均**线性相对亮度**相反方向 ≥0.1、且较暗一侧 <0.8 的变化成对计为一次闪光，
  // 统计任意 1 秒窗口的最大次数。只看全画面平均，局部大面积闪光可能漏报，不能代替正式的光敏检测。
  const transitionsLuma = [];
  for (let i = 1; i < luma.length; i++) {
    const delta = luma[i] - luma[i - 1];
    if (Math.abs(delta) >= 0.1 && Math.min(luma[i], luma[i - 1]) < 0.8) transitionsLuma.push({ t: times[i], sign: Math.sign(delta) });
  }
  const flashes = [];
  for (let i = 1; i < transitionsLuma.length; i++) if (transitionsLuma[i].sign !== transitionsLuma[i - 1].sign) flashes.push(transitionsLuma[i].t);
  // 持续脉动：按整秒分桶，统计“这一秒内 ≥2 次全画面明暗交替”的秒数与最长连续段（低于闪烁风险阈值，但长时间如此观感疲劳）。
  const flashBuckets = new Map();
  for (const t of flashes) flashBuckets.set(Math.floor(t), (flashBuckets.get(Math.floor(t)) ?? 0) + 1);
  let pulseSeconds = 0, pulseRun = 0, run = 0;
  for (let second = Math.floor(start); second <= Math.floor(end); second++) {
    if ((flashBuckets.get(second) ?? 0) >= 2) { pulseSeconds++; run++; pulseRun = Math.max(pulseRun, run); } else run = 0;
  }
  let maxFlashPerSecond = 0, flashAt = null;
  for (let i = 0; i < flashes.length; i++) {
    const count = flashes.filter((t) => t >= flashes[i] && t < flashes[i] + 1).length;
    if (count > maxFlashPerSecond) { maxFlashPerSecond = count; flashAt = flashes[i]; }
  }

  // 切点对齐：镜头起点距最近下拍/拍。
  const cutStats = shots.filter((shot) => shot.start > start + 1e-3 && shot.start < end).map((shot) => {
    const nearest = (list) => list.reduce((best, t) => Math.min(best, Math.abs(t - shot.start)), Infinity);
    return { shotId: shot.id, t: shot.start, toDownbeatMs: Math.round(nearest(song.downbeats ?? []) * 1000), toBeatMs: Math.round(nearest(song.beats ?? []) * 1000) };
  });

  const metrics = {
    range: { start: +start.toFixed(3), end: +end.toFixed(3) }, sampleFps: fps, frames: times.length, toleranceMs: Math.round(tolerance * 1000),
    motion: { median: +median(motion).toFixed(4), peakThreshold: +threshold.toFixed(4), peaks: peaks.length, peaksPerSecond: +(peaks.length / Math.max(1e-6, end - start)).toFixed(2), peaksOnGrid: peaks.length ? +(onGrid / peaks.length).toFixed(3) : null },
    hits, correlation, sectionFollow, sections: sectionStats, deadZones, busyZones, flatZones,
    flash: { maxPerSecond: maxFlashPerSecond, at: flashAt, risk: maxFlashPerSecond > 3, pulseSeconds, pulseRun }, cuts: cutStats,
  };

  const pct = (value) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);
  // 发现分两类（按 pdoom 参考片校准，见 ROADMAP AE-04）：「问题」是参考好作品里不出现、几乎总该修的
  // （离拍、系统偏移、切在拍外）以及安全问题（闪烁）；「风格提示」在参考片里也会出现
  // （死区式的克制、连续运动段不跟拍、下拍不都砸），只提醒确认是否有意为之。
  const findings = [], hints = [];
  if (metrics.motion.peaksOnGrid !== null && metrics.motion.peaksOnGrid < 0.6 && peaks.length >= 4) findings.push(`画面运动峰只有 ${pct(metrics.motion.peaksOnGrid)} 落在拍/鼓点/词起点上：大量离拍事件，节奏感会显得乱（参考片全片约 94%）。`);
    if (hits.downbeat.medianOffsetMs !== null && hits.downbeat.hit >= 3 && Math.abs(hits.downbeat.medianOffsetMs) >= 50) findings.push(`画面相对下拍系统性${hits.downbeat.medianOffsetMs > 0 ? '滞后' : '超前'} ${Math.abs(hits.downbeat.medianOffsetMs)}ms：冲击应在拍点帧起跳（脉冲衰减，不要缓入）。`);
  if (correlation && correlation.best.lagFrames !== 0 && correlation.best.r >= 0.2 && correlation.best.r - correlation.r0 > 0.1) findings.push(`画面与鼓点包络在偏移 ${correlation.best.lagMs}ms 时明显更相关（r ${correlation.r0}→${correlation.best.r}）：整体时序有系统偏差。`);
  if (metrics.flash.risk) findings.push(`⚠ 闪烁风险：${flashAt.toFixed(2)}s 起 1 秒内 ${maxFlashPerSecond} 次全画面亮度闪变（>3 次/秒，光敏风险）：降低闪白幅度/面积或放慢频率；如确需保留，导出前告知人。`);
  for (const cut of cutStats) if (cut.toBeatMs > 1000 / fps + 1) findings.push(`切点 ${cut.shotId}@${cut.t.toFixed(2)}s 离最近拍 ${cut.toBeatMs}ms：切在拍外。`);
  const loudDownbeats = bars.filter((bar) => bar.audio !== null && bar.audio >= 4 && bar.downbeatHit !== null);
  const loudRate = loudDownbeats.length ? loudDownbeats.filter((bar) => bar.downbeatHit).length / loudDownbeats.length : null;
  metrics.hits.loudDownbeatRate = loudRate === null ? null : +loudRate.toFixed(3);
  if (loudRate !== null && loudDownbeats.length >= 4 && loudRate < 0.25) hints.push(`高能量小节的下拍只有 ${pct(loudRate)} 有画面峰：响的段落可能缺少重音冲击（参考片全片下拍命中约 1/3，不需要每拍都砸）。`);
  for (const zone of deadZones) hints.push(`死区 ${zone.from.toFixed(2)}–${zone.to.toFixed(2)}s（小节 ${zone.bars[0]}–${zone.bars[zone.bars.length - 1]}）：音乐高能量但画面几乎静止——若是刻意的反差（如副歌前的克制）可保留，否则让镜头里的主体或运镜动起来（人物动作、推移、换景、层次变化）；不要用整帧闪白、震动或逐拍推镜去填，那只会让数字好看、观感变差。`);
  for (const zone of busyZones) hints.push(`${zone.from.toFixed(2)}–${zone.to.toFixed(2)}s 音乐最安静、画面却在最激烈的一档：确认是否有意（开场钩子可以），否则留出呼吸。`);
  for (const zone of flatZones) hints.push(`连续 ${zone.bars.length} 小节下拍无明显画面峰（${zone.from.toFixed(2)}–${zone.to.toFixed(2)}s）：若是刻意的连续运动可忽略，否则在少数重音小节的下拍安排镜头内的落点（动作到位、切入、换景）；不必每个下拍都有，也不要用整帧闪白或震动代替。`);
  if (pulseSeconds >= 8 && pulseSeconds / Math.max(1, end - start) >= 0.2) hints.push(`全片有约 ${pulseSeconds} 秒在持续整帧明暗脉动（每秒 ≥2 次，最长连续 ${pulseRun} 秒）：长时间随拍闪白/推镜/震动容易让人疲劳，把整帧冲击留给少数重音，其余用镜头内的动作表达节奏。`);
  if (sectionFollow !== null && sectionFollow < -0.3) hints.push(`段落能量跟随 ${sectionFollow}（反向）：画面越到安静段越激烈，确认是否有意。`);
  if (!findings.length) findings.push('未发现需要修的节奏问题（指标只是尺子，审美仍由人判断）。');

  const table = bars.map((bar) => `${pad(bar.index, 5)}${pad(bar.start.toFixed(2), 8)}${pad(bar.audio === null ? '?' : LEVEL_GLYPH[bar.audio] + bar.audio, 6)}${pad(bar.visual === null ? '?' : LEVEL_GLYPH[bar.visual] + bar.visual, 6)}${bar.downbeatHit === null ? '' : bar.downbeatHit ? '✓' : '✗'}`);
  const text = [
    `节奏报告${label && !/^[\d.]+–[\d.]+s$/.test(label) ? ' · ' + label : ''} · ${start.toFixed(2)}–${end.toFixed(2)}s · 采样 ${fps}fps × ${times.length} 帧 · 命中容差 ±${metrics.toleranceMs}ms`,
    `命中率：下拍 ${pct(hits.downbeat.rate)}（${hits.downbeat.hit}/${hits.downbeat.events}，中位偏移 ${hits.downbeat.medianOffsetMs ?? '—'}ms；高能量小节 ${pct(metrics.hits.loudDownbeatRate)}） · 强 kick ${pct(hits.kick.rate)} · 强 snare ${pct(hits.snare.rate)} · 全部拍 ${pct(hits.beat.rate)}`,
    `画面运动：中位 ${metrics.motion.median} · 峰 ${peaks.length} 个（${metrics.motion.peaksPerSecond}/s，${pct(metrics.motion.peaksOnGrid)} 在拍/鼓点/词起点上）` + (correlation ? ` · 与鼓点相关 r=${correlation.r0}（最佳偏移 ${correlation.best.lagMs}ms r=${correlation.best.r}）` : ''),
    `段落跟随：${sectionFollow ?? '—'} · 闪烁：最多 ${maxFlashPerSecond} 次/秒${metrics.flash.risk ? ' ⚠' : ''}`,
    '',
    '问题（通常该修）：',
    ...findings.map((finding) => `- ${finding}`),
    ...(hints.length ? ['', '风格提示（确认是否有意）：', ...hints.map((hint) => `- ${hint}`)] : []),
    '',
    '逐小节（音乐能量 vs 画面运动等级 1–5；✓/✗ = 下拍是否有画面峰）：',
    `${pad('小节', 5)}${pad('时间', 8)}${pad('音乐', 6)}${pad('画面', 6)}下拍`,
    ...table,
  ].join('\n');
  const chart = { t: times, motion, audio: onset ? level : null, downbeats: events.downbeat, peaks: peaks.map((peak) => peak.t), cuts: shots.filter((shot) => shot.start > start && shot.start < end).map((shot) => shot.start), start, end, title: `画面运动（橙）vs 音乐能量（灰）· 竖线=下拍 · 红点=画面峰 · 虚线=切点${label ? ' · ' + label : ''}` };
  return { text, metrics, bars, chart };
}

// gray 为等尺寸 Uint8Array 灰度帧序列；跨镜头处与上一帧比较照常进行（切镜本身就是画面事件）。
const LINEAR = Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
/** 帧间运动（灰度码值差，0..1）与平均线性相对亮度（闪光判断用，0..1）。 */
/** stride：等级用运动按 1/15 秒间隔取差（stride = 采样帧率/15），使不同采样帧率的等级可比；峰值检测仍用相邻帧。 */
export function motionSeries(frames, stride = 1) {
  const motion = [], luma = [], ink = [], levelMotion = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i], previous = frames[i - 1];
    let sum = 0, diff = 0;
    for (let p = 0; p < frame.length; p++) { sum += LINEAR[frame[p]]; if (previous) diff += Math.abs(frame[p] - previous[p]); }
    luma.push(sum / frame.length);
    motion.push(previous ? diff / frame.length / 255 : 0);
    const back = frames[i - stride];
    if (stride === 1) levelMotion.push(motion[i]);
    else { let d = 0; if (back) for (let p = 0; p < frame.length; p++) d += Math.abs(frame[p] - back[p]); levelMotion.push(back ? d / frame.length / 255 : null); }
    // 墨量：像素偏离本帧中位亮度的平均量（背景近似为中位数）；用直方图求中位数，O(n)。
    const histogram = new Uint32Array(256);
    for (let p = 0; p < frame.length; p++) histogram[frame[p]]++;
    let count = 0, middle = 0;
    for (; middle < 256; middle++) { count += histogram[middle]; if (count * 2 >= frame.length) break; }
    let spread = 0;
    for (let p = 0; p < frame.length; p++) spread += Math.abs(frame[p] - middle);
    ink.push(spread / frame.length / 255);
  }
  return { motion, luma, ink, levelMotion };
}

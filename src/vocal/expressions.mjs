// Units live here: local bend y = 10 cents, pitd = cents, dyn = 0.1 dB.
// No file/process dependencies; used by serialization, synthesis and measured reports.
import { UstxError } from './errors.mjs';
export const PITCH_TICKS = 5;
export const pitchCadenceMs = (tempo) => 60000 / tempo / 480 * PITCH_TICKS;
export const SHAPES = ['io', 'l', 'lin', 'i', 'o', 'sp'];
const fail = (message) => { throw new UstxError(message); };
export function range(value, lo, hi, label) {
  if (!Number.isFinite(value) || value < lo || value > hi)
    fail(`${label} 必须在 ${lo}..${hi}（有限数字）`);
  return value;
}
export function validatePoints(points, { x = 'x', y = 'y', minX = -10000, maxX = 3600000, minY = -120, maxY = 120, label = 'curve', limit = 360002, allowShape = true } = {}) {
  if (!Array.isArray(points) || !points.length || points.length > limit)
    fail(`${label} 必须为非空数组，最多 ${limit} 点`);
  let previous = -Infinity;
  for (const p of points) {
    if (!p || typeof p !== 'object' || Array.isArray(p))
      fail(`${label} 点必须是对象`);
    if (Object.keys(p).some(k => ![x, y, ...(allowShape ? ['shape'] : [])].includes(k)))
      fail(`${label} 包含不支持的点字段`);
    range(p[x], minX, maxX, `${label}.${x}`);
    range(p[y], minY, maxY, `${label}.${y}`);
    if (p[x] <= previous)
      fail(`${label}.${x} 必须严格递增`);
    if (p.shape !== undefined && !SHAPES.includes(p.shape))
      fail(`${label}.shape 非法`);
    previous = p[x];
  }
}
export function samplePoints(points, time, x = 'x', y = 'y', shape = true) {
  if (!points?.length)
    return 0;
  if (time <= points[0][x])
    return points[0][y];
  let lo = 0, hi = points.length - 1;
  if (time >= points[hi][x])
    return points[hi][y];
  while (hi - lo > 1) {
    const mid = (hi + lo) >> 1;
    if (points[mid][x] <= time)
      lo = mid;
    else
      hi = mid;
  }
  let u = (time - points[lo][x]) / (points[hi][x] - points[lo][x]);
  if (shape) {
    const type = points[lo].shape ?? 'lin';
    if (type === 'i')
      u = 1 - Math.cos(u * Math.PI / 2);
    else if (type === 'o')
      u = Math.sin(u * Math.PI / 2);
    else if (type === 'io' || (type === 'sp' && points.length === 2))
      u = (1 - Math.cos(u * Math.PI)) / 2;
    else if (type === 'sp') {
      // Nonuniform Catmull-Rom/Hermite: stable local spline, endpoint tangents one-sided.
      const a = points[Math.max(0, lo - 1)], b = points[Math.min(points.length - 1, hi + 1)];
      const span = points[hi][x] - points[lo][x];
      const m0 = (points[hi][y] - a[y]) / (points[hi][x] - a[x]) * span;
      const m1 = (b[y] - points[lo][y]) / (b[x] - points[lo][x]) * span;
      return (2 * u ** 3 - 3 * u ** 2 + 1) * points[lo][y] + (u ** 3 - 2 * u ** 2 + u) * m0
        + (-2 * u ** 3 + 3 * u ** 2) * points[hi][y] + (u ** 3 - u ** 2) * m1;
    }
  }
  return points[lo][y] * (1 - u) + points[hi][y] * u;
}
export function vibratoCents(v, timeMs, durationMs) {
  if (!v?.length || timeMs < 0 || timeMs >= durationMs)
    return 0;
  const span = durationMs * v.length / 100, start = durationMs - span;
  const elapsed = timeMs - start;
  if (elapsed < 0)
    return 0;
  const fadeIn = span * (v.in ?? 10) / 100, fadeOut = span * (v.out ?? 10) / 100;
  const gain = Math.min(1, fadeIn ? elapsed / fadeIn : 1, fadeOut ? (durationMs - timeMs) / fadeOut : 1);
  return (Math.sin(2 * Math.PI * (elapsed / (v.period ?? 175) + (v.shift ?? 0) / 100)) * (v.depth ?? 25) + (v.depth ?? 25) * (v.drift ?? 0) / 100) * Math.max(0, gain);
}
export function curvePoints(part, abbr, msPerTick) {
  const curve = (part.curves ?? []).find((c) => c.abbr === abbr);
  return curve ? curve.xs.map((x, i) => ({ x: (part.position + x) * msPerTick, y: curve.ys[i] })) : [];
}
export function expressionValue(note, abbr, fallback) {
  return (note.phoneme_expressions ?? []).find((e) => e.index === 0 && e.abbr === abbr)?.value ?? fallback;
}
export function createPitchModel(part, tempo) {
  const msPerTick = 60000 / tempo / 480;
  const notes = part.notes.map((note, sourceIndex) => ({ note, sourceIndex })).filter(({ note }) => note.lyric.trim().toUpperCase() !== 'R').map(({ note, sourceIndex }) => ({
    sourceIndex,
    note, start: (part.position + note.position) * msPerTick, end: (part.position + note.position + note.duration) * msPerTick,
    points: (note.pitch?.data ?? []).map((p) => ({ ...p, y: p.y * 10 })),
  }));
  for (let i = 0; i < notes.length; i++) {
    const current = notes[i], previous = notes[i - 1];
    if (current.note.pitch?.snap_first && current.points.length && previous && Math.abs(previous.end - current.start) < 0.001) {
      current.points[0].y = (previous.note.tone - current.note.tone) * 100;
    }
  }
  const pitd = curvePoints(part, 'pitd', msPerTick);
  notes.forEach((note, index) => { note.index = index; });
  function baseAt(time) {
    if (!notes.length)
      return null;
    let lo = 0, hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].start <= time)
        lo = mid + 1;
      else
        hi = mid;
    }
    return notes[Math.max(0, lo - 1)];
  }
  function centsAt(time, deviation = true) {
    const base = baseAt(time);
    if (!base)
      return null;
    let pitch = base.note.tone * 100 + vibratoCents(base.note.vibrato, time - base.start, base.end - base.start);
    // Bends of the next note extend into the previous note's preutter segment.
    const idx = base.index;
    const next = notes[idx + 1];
    const current = next && next.points.length && (time >= base.end || (time >= next.start + next.points[0].x && time <= next.start + next.points.at(-1).x)) ? next : base;
    if (current.points.length && (current === base || time >= base.end || Math.abs(base.end - current.start) < 0.001))
      pitch = current.note.tone * 100 + samplePoints(current.points, time - current.start)
        + vibratoCents(base.note.vibrato, time - base.start, base.end - base.start);
    return pitch + (deviation ? samplePoints(pitd, time) : 0);
  }
  return { notes, pitd, msPerTick, centsAt, baseAt, cadenceMs: pitchCadenceMs(tempo) };
}

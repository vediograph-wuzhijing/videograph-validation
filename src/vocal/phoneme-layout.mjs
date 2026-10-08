// One explicit oto alias per note; no automatic phonemizer. Plan all neighbours
// before resampling so short-note preutter and tail regions share one timeline.
import { expressionValue, samplePoints } from './expressions.mjs';
export function layoutPhonemes(part, tempo, bank) {
  const msPerTick = 60000 / tempo / 480, layouts = [];
  for (const [index, note] of part.notes.entries()) {
    if (note.lyric.trim().toUpperCase() === 'R')
      continue;
    const found = bank.findAlias(note.lyric.trim());
    if (!found)
      throw new Error(`声库没有别名 "${note.lyric}"（notes[${index}]）；请用真实 oto 别名，例如 ${bank.entries.slice(0, 12).map(e => e.alias).join('、')}`);
    const velocity = expressionValue(note, 'vel', 100), stretch = 2 ** (1 - velocity / 100);
    const rawLeading = Math.max(0, found.entry.preutter) * stretch;
    let preutter = rawLeading, overlap = found.entry.overlap * stretch;
    const start = (part.position + note.position) * msPerTick, duration = note.duration * msPerTick, previous = layouts.at(-1);
    const adjacent = previous && Math.abs(start - previous.end) < 0.001;
    if (previous) {
      let limit = preutter, gap = start - previous.end;
      if (adjacent) {
        if (overlap > 0 && preutter - overlap > previous.duration / 2)
          limit = Math.min(limit, previous.duration / 2 / (preutter - overlap) * preutter);
        limit = Math.min(limit, previous.duration);
        if (previous.preutter < 5)
          limit = Math.min(limit, Math.max(0, previous.duration + previous.preutter - 5));
      }
      else if (gap < preutter)
        limit = Math.max(0, gap);
      if (preutter > limit) {
        overlap *= preutter ? limit / preutter : 0;
        preutter = limit;
      }
      if (overlap < 0)
        overlap = Math.max(overlap, Math.min(0, 35 - previous.duration + preutter));
      if (previous.duration - preutter < 5)
        overlap = Math.max(overlap, 5 - (previous.duration - preutter));
      previous.tailIntrude = adjacent ? Math.max(preutter, preutter - overlap) : 0;
      previous.tailOverlap = adjacent ? Math.max(0, overlap) : 0;
    }
    layouts.push({ index, note, ...found, start, end: start + duration, duration, velocity, rawLeading, preutter, overlap,
      adjacent: Boolean(adjacent), tailIntrude: 0, tailOverlap: 0, skipOver: Math.max(0, rawLeading - preutter) });
  }
  for (const l of layouts) {
    const end = l.duration - l.tailIntrude + l.tailOverlap;
    const fadeIn = l.adjacent && l.overlap > 0 ? l.overlap : 5;
    const fadeOut = l.tailOverlap > 0 ? l.tailOverlap : 35;
    const vol = expressionValue(l.note, 'vol', 100), atk = expressionValue(l.note, 'atk', 100), dec = expressionValue(l.note, 'dec', 0);
    const p1 = Math.min(end, Math.max(-l.preutter + 5, -l.preutter + fadeIn));
    const p2 = Math.min(end, Math.max(0, p1));
    const p3 = Math.max(p2, end - fadeOut);
    // A custom envelope replaces attack/decay, but per-note volume still applies.
    // Adapt each side of the onset to the neighbour-adjusted physical span.
    l.envelope = l.note.videograph_envelope
      ? l.note.videograph_envelope.map(p => ({
        x: p.x < 0 ? Math.max(-l.preutter, p.x * l.preutter / Math.max(1, -l.note.videograph_envelope[0].x))
          : p.x * end / l.note.videograph_envelope.at(-1).x,
        y: p.y * vol / 100,
      }))
      : [{ x: -l.preutter, y: 0 }, { x: p1, y: atk * vol / 100 }, { x: p2, y: vol }, { x: p3, y: vol * (1 - dec / 100) }, { x: end, y: 0 }];
    l.envelope[0] = { ...l.envelope[0], x: -l.preutter };
    l.envelope[4] = { ...l.envelope[4], x: end };
    l.length = end + l.preutter;
  }
  return layouts;
}
export function applyEnvelope(samples, layout, dynamics, sampleRate = 44100) {
  const output = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const local = i * 1000 / sampleRate - layout.preutter;
    const db = samplePoints(dynamics, layout.start + local) * 0.1;
    const gain = db <= -24 ? 0 : 10 ** (db / 20);
    output[i] = samples[i] * Math.max(0, samplePoints(layout.envelope, local, 'x', 'y', false)) / 100 * gain;
  }
  return output;
}

// Measured monophonic F0, separate from score inference. FFT-accelerated YIN
// rejects silence/noise; unvoiced points stay null, never fabricated as score F0.
import { resampleLinear } from './wav.mjs';
import { parseYaml } from './yaml-lite.mjs';
import { buildUstx } from './ustx.mjs';
import { createPitchModel, range } from './expressions.mjs';
import { UstxError } from './errors.mjs';
const RATE = 8000, WINDOW = 512, FFT_SIZE = 1024;
export function fft(real, imag, inverse = false) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1)
      j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / len, ar = Math.cos(angle), ai = Math.sin(angle);
    for (let at = 0; at < n; at += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = at + j, b = a + len / 2, br = real[b] * wr - imag[b] * wi, bi = real[b] * wi + imag[b] * wr;
        real[b] = real[a] - br;
        imag[b] = imag[a] - bi;
        real[a] += br;
        imag[a] += bi;
        const next = wr * ar - wi * ai;
        wi = wr * ai + wi * ar;
        wr = next;
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
}
export function measureF0(samples, sampleRate, { hopMs = 10, minHz = 65, maxHz = 1100, minConfidence = 0.85, signal } = {}) {
  range(hopMs, 5, 100, 'hopMs');
  range(minHz, 50, 500, 'minHz');
  range(maxHz, minHz + 1, 1500, 'maxHz');
  range(minConfidence, 0.5, 0.99, 'minConfidence');
  const audio = resampleLinear(samples, sampleRate, RATE), hop = Math.max(1, Math.round(hopMs * RATE / 1000));
  const real = new Float64Array(FFT_SIZE), imag = new Float64Array(FFT_SIZE), energy = new Float64Array(WINDOW + 1), cmnd = new Float64Array(WINDOW);
  const minLag = Math.max(2, Math.floor(RATE / maxHz)), maxLag = Math.min(WINDOW / 2, Math.ceil(RATE / minHz));
  const frames = [];
  for (let center = WINDOW / 2; center + WINDOW / 2 <= audio.length; center += hop) {
    signal?.throwIfAborted();
    real.fill(0);
    imag.fill(0);
    let mean = 0;
    const start = center - WINDOW / 2;
    for (let i = 0; i < WINDOW; i++)
      mean += audio[start + i];
    mean /= WINDOW;
    energy[0] = 0;
    for (let i = 0; i < WINDOW; i++) {
      real[i] = audio[start + i] - mean;
      energy[i + 1] = energy[i] + real[i] ** 2;
    }
    const rms = Math.sqrt(energy[WINDOW] / WINDOW);
    let hz = null, confidence = 0;
    if (rms >= 0.003) {
      fft(real, imag);
      for (let i = 0; i < FFT_SIZE; i++) {
        real[i] = real[i] ** 2 + imag[i] ** 2;
        imag[i] = 0;
      }
      fft(real, imag, true);
      let running = 0;
      for (let lag = 1; lag <= maxLag + 1; lag++) {
        const d = Math.max(0, energy[WINDOW - lag] + energy[WINDOW] - energy[lag] - 2 * real[lag]);
        running += d;
        cmnd[lag] = running ? d * lag / running : 1;
      }
      let best = null;
      // First qualifying local minimum avoids a lower-frequency octave preference.
      for (let lag = minLag; lag <= maxLag; lag++)
        if (cmnd[lag] < 1 - minConfidence) {
          while (lag < maxLag && cmnd[lag + 1] < cmnd[lag])
            lag++;
          best = lag;
          break;
        }
      if (best !== null) {
        const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1], denom = a - 2 * b + c;
        const refined = best + (denom ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * denom))) : 0);
        const candidate = RATE / refined;
        if (candidate >= minHz && candidate <= maxHz) {
          hz = candidate;
          confidence = Math.max(0, Math.min(1, 1 - b));
        }
      }
    }
    frames.push({ timeMs: center / RATE * 1000, hz, confidence, rms });
  }
  return { schema: 'vocal-f0/v1', method: 'FFT-YIN', analysisRate: RATE, windowMs: WINDOW / RATE * 1000, hopMs, minHz, maxHz, minConfidence,
    durationMs: samples.length / sampleRate * 1000, frames };
}
const quantile = (values, q) => { if (!values.length)
  return null; const a = [...values].sort((a, b) => a - b); return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))]; };
const hzOf = (cents) => 440 * 2 ** ((cents - 6900) / 1200);
const centsOf = (hz) => 6900 + 1200 * Math.log2(hz / 440);
function modulation(frames) {
  if (frames.length < 20 || frames.at(-1).timeMs - frames[0].timeMs < 400)
    return null;
  const offsets = frames.map(f => f.scoreErrorCents), mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  const times = frames.map(f => f.timeMs / 1000), meanTime = times.reduce((a, b) => a + b, 0) / times.length;
  const slope = times.reduce((sum, t, i) => sum + (t - meanTime) * (offsets[i] - mean), 0) / times.reduce((sum, t) => sum + (t - meanTime) ** 2, 0);
  const residual = offsets.map((v, i) => v - mean - slope * (times[i] - meanTime));
  let best = { rateHz: null, depthCents: 0 };
  for (let rate = 3; rate <= 12; rate += 0.1) {
    let re = 0, im = 0;
    for (let i = 0; i < frames.length; i++) {
      const phase = 2 * Math.PI * rate * times[i];
      re += residual[i] * Math.cos(phase);
      im += residual[i] * Math.sin(phase);
    }
    const depth = 2 * Math.hypot(re, im) / frames.length;
    if (depth > best.depthCents)
      best = { rateHz: Math.round(rate * 10) / 10, depthCents: depth };
  }
  return best.depthCents >= 3 ? best : null;
}
export function pitchReport(wav, ustxText, { signal, ...options } = {}) {
  const project = parseYaml(ustxText), model = createPitchModel(project.voice_parts[0], project.tempos[0].bpm);
  const measurement = measureF0(wav.samples, wav.sampleRate, { ...options, signal });
  const noteFrames = new Map(model.notes.map(n => [n.sourceIndex, []]));
  for (const f of measurement.frames) {
    const n = model.baseAt(f.timeMs), within = n && f.timeMs >= n.start && f.timeMs < n.end;
    f.noteIndex = within ? n.sourceIndex : null;
    f.scoreHz = within ? hzOf(n.note.tone * 100) : null;
    f.expectedHz = within ? hzOf(model.centsAt(f.timeMs)) : null;
    f.errorCents = f.hz && within ? centsOf(f.hz) - model.centsAt(f.timeMs) : null;
    f.scoreErrorCents = f.hz && within ? centsOf(f.hz) - n.note.tone * 100 : null;
    if (within)
      noteFrames.get(n.sourceIndex).push(f);
  }
  const notes = model.notes.map(n => {
    const frames = noteFrames.get(n.sourceIndex), voiced = frames.filter(f => f.hz !== null);
    const stable = voiced.filter(f => f.timeMs >= n.start + Math.min(35, (n.end - n.start) / 4) && f.timeMs <= n.end - 20);
    return { index: n.sourceIndex, lyric: n.note.lyric, tone: n.note.tone, startMs: n.start, endMs: n.end,
      voicedCoverage: frames.length ? voiced.length / frames.length : 0, measuredHzMedian: quantile(stable.map(f => f.hz), 0.5),
      medianTargetErrorCents: quantile(stable.map(f => f.errorCents), 0.5), p95AbsTargetErrorCents: quantile(stable.map(f => Math.abs(f.errorCents)), 0.95),
      expectedVibratoRateHz: n.note.vibrato?.length ? 1000 / (n.note.vibrato.period ?? 175) : null, measuredModulation: modulation(stable) };
  });
  const voiced = measurement.frames.filter(f => f.errorCents !== null);
  return { ...measurement, schema: 'vocal-pitch-report/v1', timingSource: 'measured', notes,
    summary: { voicedFrames: voiced.length, scoredFrames: measurement.frames.filter(f => f.expectedHz !== null).length,
      medianAbsTargetErrorCents: quantile(voiced.map(f => Math.abs(f.errorCents)), 0.5), p95AbsTargetErrorCents: quantile(voiced.map(f => Math.abs(f.errorCents)), 0.95) },
    limitations: ['仅适用于单声部干轨；伴奏/复音、气声和辅音可能无法测量或出现倍频错误', '64ms分析窗会平滑快速滑音和颤音；null表示未可靠测出，不等于唱准', '起伏估计限于3..12Hz、至少400ms且幅度>=3音分；它不单独判定颤音音色', '这是技术诊断，不代替人工试听或演唱质量判断'] };
}
export function simplifyPitchCurve(points, toleranceCents = 2) {
  range(toleranceCents, 0, 20, 'toleranceCents');
  if (points.length <= 2 || toleranceCents === 0)
    return points;
  // Silence boundaries are exact anchors: simplification cannot carry a bend
  // across an unvoiced gap, even when its amplitude is below the tolerance.
  // Cap each RDP interval to bound work for long noisy recordings.
  const anchors = [0, ...points.flatMap((p, i) => (p.cents === 0 || i % 256 === 0) && i > 0 && i < points.length - 1 ? [i] : []), points.length - 1];
  const keep = new Set(anchors), stack = anchors.slice(1).map((b, i) => [anchors[i], b]);
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = toleranceCents, index = -1;
    for (let i = a + 1; i < b; i++) {
      const u = (points[i].timeMs - points[a].timeMs) / (points[b].timeMs - points[a].timeMs);
      const error = Math.abs(points[i].cents - (points[a].cents * (1 - u) + points[b].cents * u));
      if (error > max) {
        max = error;
        index = i;
      }
    }
    if (index >= 0) {
      keep.add(index);
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep.has(i));
}
export function extractReferencePitch(wav, plan, { offsetMs = 0, maxDeviationCents = 600, toleranceCents = 2, signal, ...options } = {}) {
  range(offsetMs, -3600000, 3600000, 'offsetMs');
  range(maxDeviationCents, 1, 1200, 'maxDeviationCents');
  const project = buildUstx(plan), part = project.voice_parts[0];
  if (project.voice_parts.length !== 1)
    throw new UstxError('reference pitch requires one part');
  const model = createPitchModel(part, project.tempos[0].bpm), measurement = measureF0(wav.samples, wav.sampleRate, { ...options, signal });
  const curve = [], diagnostics = [];
  let previousVoiced = false, accepted = 0;
  const scoreEnd = model.notes.at(-1)?.end ?? 0;
  const push = (timeMs, cents) => { if (timeMs < 0)
    return; timeMs = Math.min(timeMs, scoreEnd); const point = { timeMs, cents: Math.round(cents) }; if (curve.at(-1)?.timeMs === timeMs)
    curve[curve.length - 1] = point;
  else
    curve.push(point); };
  for (const f of measurement.frames) {
    const t = f.timeMs + offsetMs, n = model.baseAt(t), within = n && t >= n.start && t < n.end;
    const deviation = f.hz && within ? centsOf(f.hz) - model.centsAt(t, false) : null;
    const reliable = deviation !== null && Math.abs(deviation) <= maxDeviationCents;
    if (reliable) {
      if (!previousVoiced)
        push(Math.max(0, t - measurement.hopMs), 0);
      push(t, deviation);
      accepted++;
    }
    else {
      if (previousVoiced)
        push(t, 0);
      if (within)
        diagnostics.push({ timeMs: t, reason: f.hz === null ? 'unvoiced-or-low-confidence' : 'outside-deviation-limit', hz: f.hz, deviationCents: deviation });
    }
    previousVoiced = reliable;
  }
  if (previousVoiced)
    push(measurement.frames.at(-1).timeMs + offsetMs + measurement.hopMs, 0);
  if (!accepted)
    throw new UstxError('参考音频没有可靠的乐谱内基频；请提供已分离的单声部人声并核对 offsetMs/音域');
  const result = structuredClone(plan);
  result.parts[0].pitchDeviation = simplifyPitchCurve(curve, toleranceCents);
  return { plan: result, report: { ...measurement, schema: 'vocal-reference-pitch/v1', offsetMs, maxDeviationCents, acceptedFrames: accepted,
      curvePoints: result.parts[0].pitchDeviation.length, toleranceCents, diagnostics, timingSource: 'measured-reference', limitations: ['输入必须是已分离的单声部人声；不做源分离或自动时间对齐', '拒绝低置信度/超出范围的帧并退回原乐谱，不插值穿越无声区域', '仍需试听及核验倍频、起点偏移与分离伪影'] } };
}

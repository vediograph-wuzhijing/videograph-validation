import { fft } from './pitch-analysis.mjs';
import { UstxError } from './errors.mjs';
const edges = [0, 200, 500, 2000, 4000, 8000, 16000, 24000];
const db = power => power > 1e-16 ? 10 * Math.log10(power) : null;
export function bandEnergy(audio) {
    if (!audio?.samples?.length || !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0)
        throw new UstxError('频段报告需要有效音频');
    const n = 4096, real = new Float64Array(n), imag = new Float64Array(n), sums = Array(edges.length - 1).fill(0);
    const window = Float64Array.from({ length: n }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (n - 1)));
    const scale = n * window.reduce((s, w) => s + w * w, 0);
    let frames = 0, peak = 0, rms = 0;
    for (const s of audio.samples) {
        if (!Number.isFinite(s))
            throw new UstxError('音频含非有限采样');
        peak = Math.max(peak, Math.abs(s));
        rms += s * s;
    }
    // At most 6000 independent windows; evenly sample long songs without allocating
    // a spectrogram. Hann/Parseval calibration reports integrated band RMS dBFS.
    const step = Math.max(n, Math.ceil(audio.samples.length / 6000));
    for (let at = 0; at < audio.samples.length; at += step) {
        real.fill(0);
        imag.fill(0);
        for (let i = 0; i < n; i++)
            real[i] = (audio.samples[at + i] ?? 0) * window[i];
        fft(real, imag);
        frames++;
        let band = 0;
        for (let k = 0; k <= n / 2; k++) {
            const hz = k * audio.sampleRate / n;
            while (band < sums.length - 1 && hz >= edges[band + 1])
                band++;
            sums[band] += (real[k] ** 2 + imag[k] ** 2) * (k === 0 || k === n / 2 ? 1 : 2) / scale;
        }
    }
    return { sampleRate: audio.sampleRate, duration: audio.samples.length / audio.sampleRate, channels: audio.channels, downmix: 'arithmetic-mono', frames, peak, rmsDbFS: db(rms / audio.samples.length), bands: sums.map((p, i) => ({ lowHz: edges[i], highHz: Math.min(edges[i + 1], audio.sampleRate / 2), dbFS: edges[i] >= audio.sampleRate / 2 ? null : db(p / frames) })) };
}
export function compareBands(vocal, reference) {
    const measured = bandEnergy(vocal), target = reference ? bandEnergy(reference) : null;
    return { schema: 'vocal-bands/v1', method: '4096-point Hann FFT; integrated RMS dBFS; whole-track mono downmix', measured, reference: target,
        differences: target ? measured.bands.map((b, i) => ({ lowHz: b.lowHz, highHz: b.highHz, deltaDb: b.dbFS === null || target.bands[i].dbFS === null ? null : b.dbFS - target.bands[i].dbFS })) : null,
        note: '比较包含音量及静音比例的影响；应使用相同歌曲时间范围的分离人声。零能量为 null，不当作一致。' };
}

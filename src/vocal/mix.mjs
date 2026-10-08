// Explicit opt-in DSP. Existing plans retain their gain + limiter mix.
import { UstxError } from './errors.mjs';
import { range } from './expressions.mjs';
const keys = (object, allowed, label) => {
    if (!object || typeof object !== 'object' || Array.isArray(object))
        throw new UstxError(`${label} 必须是对象`);
    const unknown = Object.keys(object).filter(k => !allowed.includes(k));
    if (unknown.length)
        throw new UstxError(`${label} 不支持 ${unknown.join(',')}`);
};
export function normalizeMix(mix = {}) {
    keys(mix, ['backingGain', 'vocalGain', 'processing'], 'mix');
    const result = { backingGain: range(mix.backingGain ?? 0.7, 0, 2, 'backingGain'), vocalGain: range(mix.vocalGain ?? 1, 0, 2, 'vocalGain') };
    if (!result.backingGain && !result.vocalGain)
        throw new UstxError('不能将两条音轨同时静音');
    if (mix.processing === undefined)
        return result;
    keys(mix.processing, ['eq', 'compressor', 'reverb', 'exciter', 'saturation', 'doubling'], 'processing');
    const { eq = {}, compressor = {}, reverb = {} } = mix.processing;
    keys(eq, ['lowCutHz', 'lowGainDb', 'midHz', 'midGainDb', 'highGainDb'], 'eq');
    keys(compressor, ['thresholdDb', 'ratio', 'attackMs', 'releaseMs', 'makeupDb'], 'compressor');
    keys(reverb, ['wet', 'decayMs', 'roomSize', 'damping'], 'reverb');
    result.processing = {
        eq: { lowCutHz: range(eq.lowCutHz ?? 80, 20, 400, 'lowCutHz'), lowGainDb: range(eq.lowGainDb ?? -2, -12, 12, 'lowGainDb'), midHz: range(eq.midHz ?? 2500, 300, 6000, 'midHz'), midGainDb: range(eq.midGainDb ?? 1, -12, 12, 'midGainDb'), highGainDb: range(eq.highGainDb ?? 0, -12, 12, 'highGainDb') },
        compressor: { thresholdDb: range(compressor.thresholdDb ?? -18, -60, 0, 'thresholdDb'), ratio: range(compressor.ratio ?? 3, 1, 20, 'ratio'), attackMs: range(compressor.attackMs ?? 8, 0.1, 2000, 'attackMs'), releaseMs: range(compressor.releaseMs ?? 100, 1, 9000, 'releaseMs'), makeupDb: range(compressor.makeupDb ?? 0, 0, 24, 'makeupDb') },
        reverb: { wet: range(reverb.wet ?? 0.15, 0, 0.6, 'wet'), decayMs: range(reverb.decayMs ?? 650, 100, 2000, 'decayMs'), roomSize: range(reverb.roomSize ?? 1, 0.5, 2, 'roomSize'), damping: range(reverb.damping ?? 0.35, 0, 0.95, 'damping') },
    };
    const { exciter = {}, saturation = {}, doubling = {} } = mix.processing;
    keys(exciter, ['amount', 'frequencyHz', 'drive'], 'exciter');
    keys(saturation, ['amount', 'drive'], 'saturation');
    keys(doubling, ['wet', 'delayMs', 'depthMs', 'rateHz'], 'doubling');
    result.processing.exciter = { amount: range(exciter.amount ?? 0, 0, .5, 'exciter.amount'), frequencyHz: range(exciter.frequencyHz ?? 3500, 1000, 10000, 'exciter.frequencyHz'), drive: range(exciter.drive ?? 2, 1, 8, 'exciter.drive') };
    result.processing.saturation = { amount: range(saturation.amount ?? 0, 0, 1, 'saturation.amount'), drive: range(saturation.drive ?? 2, 1, 8, 'saturation.drive') };
    result.processing.doubling = { wet: range(doubling.wet ?? 0, 0, .5, 'doubling.wet'), delayMs: range(doubling.delayMs ?? 18, 5, 50, 'doubling.delayMs'), depthMs: range(doubling.depthMs ?? 2, 0, 4, 'doubling.depthMs'), rateHz: range(doubling.rateHz ?? .5, .05, 3, 'doubling.rateHz') };
    return result;
}
export function colorVocal(samples, sampleRate, processing, { signal } = {}) {
    const result = new Float32Array(samples.length), e = processing.exciter, s = processing.saturation;
    const alpha = Math.exp(-2 * Math.PI * e.frequencyHz / sampleRate);
    let priorInput = 0, high = 0;
    const saturate = (x, drive) => Math.tanh(x * drive) / drive;
    for (let i = 0; i < samples.length; i++) {
        if (i % 16384 === 0)
            signal?.throwIfAborted();
        const dry = samples[i];
        high = alpha * (high + dry - priorInput);
        priorInput = dry;
        const harmonic = saturate(high, e.drive) - high;
        const colored = dry + harmonic * e.amount;
        result[i] = colored * (1 - s.amount) + saturate(colored, s.drive) * s.amount;
    }
    return result;
}
export function doubleVocal(channels, sampleRate, options, { signal } = {}) {
    if (!options.wet)
        return channels;
    const result = channels.map(() => new Float32Array(channels[0].length));
    for (let ch = 0; ch < 2; ch++)
        for (let i = 0; i < result[ch].length; i++) {
            if (i % 16384 === 0)
                signal?.throwIfAborted();
            const delay = (options.delayMs + Math.sin(i / sampleRate * options.rateHz * Math.PI * 2 + ch * Math.PI) * options.depthMs) * sampleRate / 1000;
            const at = i - delay, lo = Math.floor(at), fraction = at - lo;
            const delayed = lo >= 0 ? (channels[ch][lo] ?? 0) * (1 - fraction) + (channels[ch][lo + 1] ?? 0) * fraction : 0;
            result[ch][i] = channels[ch][i] * (1 - options.wet) + delayed * options.wet;
        }
    return result;
}
export function vocalFilter(processing) {
    if (!processing)
        return 'anull';
    const { eq: e, compressor: c } = processing;
    return [`highpass=f=${e.lowCutHz}`, `equalizer=f=200:t=q:w=0.7:g=${e.lowGainDb}`, `equalizer=f=${e.midHz}:t=q:w=1:g=${e.midGainDb}`, `equalizer=f=8000:t=q:w=0.7:g=${e.highGainDb}`,
        `acompressor=threshold=${10 ** (c.thresholdDb / 20)}:ratio=${c.ratio}:attack=${c.attackMs}:release=${c.releaseMs}:makeup=${10 ** (c.makeupDb / 20)}`].join(',');
}
export function roomReverb(samples, sampleRate, options, { signal } = {}) {
    const { wet, decayMs, roomSize, damping } = options;
    const length = samples.length + (wet ? Math.ceil(decayMs / 1000 * sampleRate) : 0);
    const channels = [new Float32Array(length), new Float32Array(length)];
    for (let channel = 0; channel < 2; channel++) {
        const combs = [29.7, 37.1, 41.1, 43.7].map(ms => {
            const delay = Math.max(1, Math.round((ms * roomSize + channel * 0.83) * sampleRate / 1000));
            return { buffer: new Float32Array(delay), at: 0, filter: 0, feedback: 10 ** (-3 * delay / (sampleRate * decayMs / 1000)) };
        });
        const allpasses = [5, 1.7].map(ms => ({ buffer: new Float32Array(Math.round((ms + channel * 0.31) * sampleRate / 1000)), at: 0 }));
        for (let i = 0; i < length; i++) {
            if (i % 16384 === 0)
                signal?.throwIfAborted();
            const dry = samples[i] ?? 0;
            let diffuse = 0;
            for (const c of combs) {
                const delayed = c.buffer[c.at];
                c.filter = delayed * (1 - damping) + c.filter * damping;
                c.buffer[c.at] = dry + c.filter * c.feedback;
                c.at = (c.at + 1) % c.buffer.length;
                diffuse += delayed / 4;
            }
            for (const a of allpasses) {
                const delayed = a.buffer[a.at], value = -diffuse + delayed;
                a.buffer[a.at] = diffuse + delayed * 0.5;
                a.at = (a.at + 1) % a.buffer.length;
                diffuse = value;
            }
            channels[channel][i] = dry * (1 - wet) + diffuse * wet;
        }
    }
    return channels;
}

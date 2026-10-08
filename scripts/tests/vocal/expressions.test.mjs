import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareVocalPlan, normalizeMix } from '../../../src/vocal/plan.mjs';
import { buildUstx, serializeUstx, validateUstxText } from '../../../src/vocal/ustx.mjs';
import { createPitchModel, samplePoints, pitchCadenceMs, vibratoCents } from '../../../src/vocal/expressions.mjs';
import { measureF0, pitchReport, extractReferencePitch, simplifyPitchCurve } from '../../../src/vocal/pitch-analysis.mjs';
import { layoutPhonemes, applyEnvelope } from '../../../src/vocal/phoneme-layout.mjs';
import { vocalFilter, roomReverb } from '../../../src/vocal/mix.mjs';
import { buildResamplerArgs } from '../../../src/vocal/resampler.mjs';
import { renderUstx } from '../../../src/vocal/render.mjs';
import { writeWavMono16, writeWavStereoFloat32, readWav } from '../../../src/vocal/wav.mjs';
const RATE = 44100;
const single = (changes = {}) => ({ tempo: 120, tracks: [{}], parts: [{ notes: [{ lyric: 'a', tone: 69, startBeats: 0, durationBeats: 4, snapFirst: false, ...changes }] }] });
function signalWave(seconds, frequency, amplitude = 0.3) {
  let phase = 0;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => { phase += 2 * Math.PI * (typeof frequency === 'function' ? frequency(i / RATE) : frequency) / RATE; return Math.sin(phase) * amplitude; });
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
test('absolute pitd can begin at zero even when a high-tempo part starts late in a one-hour score', () => {
  const p=single({startBeats:50000,durationBeats:1});p.tempo=1000;
  p.parts[0].pitchDeviation=[{timeMs:0,cents:0},{timeMs:3000060,cents:100}];
  assert.ok(prepareVocalPlan(p,3600).ustxText.includes('pitd'));
});
test('linear API curves serialize to OpenUtau l and preserve external l interpolation', () => {
  const u = buildUstx(single({ pitchCurve: [{ x: -40, y: -10, shape: 'lin' }, { x: 40, y: 10, shape: 'l' }], snapFirst: false }));
  assert.equal(u.voice_parts[0].notes[0].pitch.data[0].shape, 'l');
  assert.ok(validateUstxText(serializeUstx(u)).ok);
  assert.equal(createPitchModel(u.voice_parts[0], 120).centsAt(0), 6900);
});
test('reference curve simplification preserves silence anchors and bounds interpolation error', () => {
  const points = Array.from({ length: 1000 }, (_, i) => ({ timeMs: i * 10, cents: i > 400 && i < 600 ? 0 : Math.round(50 + 40 * Math.sin(i * .07)) }));
  const simplified = simplifyPitchCurve(points, 2);
  assert.ok(simplified.length < points.length / 2);
  for (const p of points)
    assert.ok(Math.abs(samplePoints(simplified, p.timeMs, 'timeMs', 'cents', false) - p.cents) <= 2.000001);
  assert.equal(samplePoints(simplified, 5000, 'timeMs', 'cents', false), 0);
});
test('DSP float intermediates preserve headroom and reject nonfinite values', t => {
  const root = mkdtempSync(join(tmpdir(), 'videograph-dsp-float-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'stereo.wav');
  writeWavStereoFloat32(path, [Float32Array.of(2, -2), Float32Array.of(2, -2)]);
  assert.deepEqual([...readWav(path).samples], [2, -2]);
  assert.throws(() => writeWavStereoFloat32(path, [Float32Array.of(NaN), Float32Array.of(0)]), /nonfinite/);
});
test('measured note indices retain explicit rests in the source score', () => {
  const p = single({ lyric: 'R', durationBeats: 1 });
  p.parts[0].notes.push({ lyric: 'a', tone: 69, startBeats: 1, durationBeats: 2 });
  const report = pitchReport({ samples: signalWave(1.5, 440), sampleRate: RATE }, serializeUstx(buildUstx(p)));
  assert.equal(report.notes[0].index, 1);
  assert.ok(report.frames.filter(f => f.timeMs < 500).every(f => f.noteIndex === null));
});
test('a continuous pitch ramp is not misreported as periodic vibrato', () => {
  const p = single({ pitchCurve: [{ x: 0, y: 0, shape: 'l' }, { x: 2000, y: 40 }], snapFirst: false });
  const report = pitchReport({ samples: signalWave(2, t => 440 * 2 ** (200 * t / 1200)), sampleRate: RATE }, serializeUstx(buildUstx(p)));
  assert.equal(report.notes[0].measuredModulation, null);
});
test('expressions serialize absolute pitd/dyn time into USTX part-relative ticks without changing lyric timing', () => {
  const p = single({ startBeats: 1, durationBeats: 2, volume: 70, velocity: 110, pitchCurve: [{ x: -60, y: -10 }, { x: 100, y: 0 }], vibrato: { length: 60, period: 200, depth: 40 } });
  p.parts[0].pitchDeviation = [{ timeMs: 0, cents: 0 }, { timeMs: 500, cents: 100 }];
  p.parts[0].dynamics = [{ timeMs: 0, db: -12 }, { timeMs: 1000, db: 0 }];
  const result = prepareVocalPlan(p, 2), u = buildUstx(p), part = u.voice_parts[0];
  assert.deepEqual(part.curves[0], { abbr: 'pitd', xs: [-480, 0], ys: [0, 100] });
  assert.deepEqual(part.curves[1].ys, [-120, 0]);
  assert.equal(part.notes[0].phoneme_expressions[0].value, 70);
  assert.ok(validateUstxText(result.ustxText).ok);
});
test('pitch sampling uses 5 ticks, applies cents units, ramps before onset and covers contiguous-note boundary', () => {
  assert.equal(pitchCadenceMs(160), 3.90625);
  const p = single({ tone: 60, startBeats: 0, durationBeats: 1 });
  p.parts[0].notes.push({ lyric: 'a', tone: 62, startBeats: 1, durationBeats: 1, pitchCurve: [{ x: -100, y: -20, shape: 'lin' }, { x: 100, y: 0 }], snapFirst: false });
  p.parts[0].pitchDeviation = [{ timeMs: 0, cents: 10 }, { timeMs: 1000, cents: 10 }];
  const model = createPitchModel(buildUstx(p).voice_parts[0], 120);
  assert.equal(model.centsAt(450), 6060);
  assert.equal(model.centsAt(500), 6110);
  assert.equal(model.centsAt(550), 6160);
  assert.ok(Math.abs(model.centsAt(499.999) - model.centsAt(500.001)) < 0.01);
  for (const shape of ['lin', 'i', 'o', 'io', 'sp']) {
    assert.equal(samplePoints([{ x: 0, y: 0, shape }, { x: 100, y: 100 }], 0), 0);
    assert.equal(samplePoints([{ x: 0, y: 0, shape }, { x: 100, y: 100 }], 100), 100);
  }
});
test('vibrato percent, period, depth and ramps combine with part pitch deviation', () => {
  const v = { length: 50, period: 200, depth: 40, in: 20, out: 20 };
  assert.equal(vibratoCents(v, 900, 2000), 0);
  assert.equal(vibratoCents(v, 1000, 2000), 0);
  assert.ok(Math.abs(vibratoCents(v, 1250, 2000) - 40) < 1e-8);
  assert.equal(vibratoCents(v, 2000, 2000), 0);
  const p = single({ vibrato: v });
  p.parts[0].pitchDeviation = [{ timeMs: 0, cents: 100 }, { timeMs: 2000, cents: 100 }];
  assert.ok(Math.abs(createPitchModel(buildUstx(p).voice_parts[0], 120).centsAt(1250) - 7040) < 1e-6);
});
test('external USTX and plans reject bad curve units/order/ranges, unsupported expressions and invalid envelope', () => {
  for (const bad of [NaN, Infinity, 150])
    assert.throws(() => prepareVocalPlan(single({ pitchCurve: [{ x: 0, y: bad }] }), 2));
  assert.throws(() => prepareVocalPlan(single({ vibrato: { length: Infinity } }), 2));
  assert.throws(() => prepareVocalPlan(single({ volume: -1 }), 2));
  const p = single();
  p.parts[0].pitchDeviation = [{ timeMs: 3000, cents: 0 }];
  assert.throws(() => prepareVocalPlan(p, 2), /超出/);
  const u = buildUstx(single());
  u.voice_parts[0].curves = [{ abbr: 'pitd', xs: [0, 1], ys: [0] }];
  assert.ok(!validateUstxText(serializeUstx(u)).ok);
  const q = single({ envelope: [{ x: 0, y: 1 }, { x: 1, y: 2 }] });
  assert.throws(() => prepareVocalPlan(q, 2), /5点|首尾/);
});
test('classic bends use !tempo and int12 while flat legacy notes retain 11 arguments', () => {
  const item = { inputWav: 'a.wav', outputWav: 'b.wav', tone: 60, tempo: 160, contract: 'classic', pitches: [0, 0] };
  assert.equal(buildResamplerArgs(item).length, 11);
  const args = buildResamplerArgs({ ...item, pitches: [-100, 20] });
  assert.equal(args.length, 13);
  assert.equal(args[11], '!160');
});
test('160 BPM short notes constrain consonant lead, overlap tails, trim silence gaps and build five-point envelopes', () => {
  const p = single({ durationBeats: .5 });
  p.tempo = 160;
  p.parts[0].notes.push({ lyric: 'a', tone: 69, startBeats: .5, durationBeats: .5 }, { lyric: 'a', tone: 69, startBeats: 2, durationBeats: .5 });
  const bank = { findAlias: () => ({ entry: { preutter: 300, overlap: 100, consonant: 80 }, wav: 'a.wav' }) };
  const l = layoutPhonemes(buildUstx(p).voice_parts[0], 160, bank);
  assert.ok(l[1].preutter <= 187.5);
  assert.ok(l[1].skipOver > 0);
  assert.equal(l[0].tailIntrude, l[1].preutter);
  assert.equal(l[1].tailIntrude, 0);
  assert.equal(l[2].adjacent, false);
  assert.ok(l.every(n => n.envelope.length === 5 && n.envelope[0].y === 0 && n.envelope.at(-1).y === 0));
  const out = applyEnvelope(new Float32Array(44100).fill(1), { start: 0, preutter: 0, envelope: [{ x: 0, y: 0 }, { x: 5, y: 50 }, { x: 10, y: 50 }, { x: 990, y: 50 }, { x: 1000, y: 0 }] }, [{ x: 0, y: -60 }]);
  assert.ok(Math.abs(out[10000] - 0.5 * 10 ** (-6 / 20)) < 1e-6);
  assert.equal(out[0], 0);
  assert.ok(out.at(-1) < .001);
});
test('measured F0 detects known offsets, harmonic-rich fundamental, silence and vibrato independently of score', () => {
  const hz = 440 * 2 ** (100 / 1200), audio = signalWave(2, hz);
  const measured = measureF0(audio, RATE);
  const voiced = measured.frames.filter(f => f.hz !== null);
  assert.ok(voiced.length > 170);
  assert.ok(Math.abs(median(voiced.map(f => f.hz)) - hz) < 2);
  assert.ok(measureF0(new Float32Array(RATE), RATE).frames.every(f => f.hz === null));
  const rich = signalWave(1, 220);
  const overtone = signalWave(1, 440, .5);
  for (let i = 0; i < rich.length; i++)
    rich[i] += overtone[i];
  assert.ok(Math.abs(median(measureF0(rich, RATE).frames.filter(f => f.hz).map(f => f.hz)) - 220) < 2);
  const plan = single({ vibrato: { length: 100, period: 200, depth: 40, in: 0, out: 0 } });
  const wave = signalWave(2, t => 440 * 2 ** (40 * Math.sin(2 * Math.PI * 5 * t) / 1200));
  const report = pitchReport({ samples: wave, sampleRate: RATE }, serializeUstx(buildUstx(plan)));
  assert.ok(report.summary.medianAbsTargetErrorCents < 6, JSON.stringify(report.summary));
  assert.ok(Math.abs(report.notes[0].measuredModulation.rateHz - 5) < .2);
  assert.ok(report.notes[0].measuredModulation.depthCents > 30);
  const wrong = pitchReport({ samples: audio, sampleRate: RATE }, serializeUstx(buildUstx(single())));
  assert.ok(wrong.notes[0].medianTargetErrorCents > 90);
  assert.equal(wrong.timingSource, 'measured');
});
test('reference extraction preserves rest/low-confidence gaps, applies explicit offset and does not double local vibrato', () => {
  const plan = single({ vibrato: { length: 100, period: 200, depth: 40, in: 0, out: 0 } });
  const samples = signalWave(2, t => 440 * 2 ** ((100 + 40 * Math.sin(2 * Math.PI * 5 * t)) / 1200));
  samples.fill(0, Math.round(.7 * RATE), Math.round(1.1 * RATE));
  const result = extractReferencePitch({ samples, sampleRate: RATE }, plan);
  assert.ok(result.report.acceptedFrames > 100);
  assert.ok(result.report.diagnostics.some(d => d.reason === 'unvoiced-or-low-confidence'));
  const curve = result.plan.parts[0].pitchDeviation;
  assert.ok(curve.some(p => p.cents === 0 && p.timeMs > .7 * 1000 && p.timeMs < 1.1 * 1000));
  assert.ok(Math.abs(median(curve.filter(p => p.cents !== 0).map(p => p.cents)) - 100) < 6);
  assert.equal(plan.parts[0].pitchDeviation, undefined);
  assert.throws(() => extractReferencePitch({ samples: new Float32Array(RATE), sampleRate: RATE }, single()), /没有可靠/);
  assert.throws(() => measureF0(samples, RATE, { minConfidence: NaN }));
  const c = new AbortController();
  c.abort();
  assert.throws(() => measureF0(samples, RATE, { signal: c.signal }), /abort/i);
});
test('optional EQ/compression parameters are bounded and room reverb yields finite distinct stereo tails', () => {
  assert.deepEqual(normalizeMix(), { backingGain: .7, vocalGain: 1 });
  const config = normalizeMix({ processing: {} }).processing;
  assert.match(vocalFilter(config), /acompressor/);
  assert.match(vocalFilter(config), /highpass/);
  assert.throws(() => normalizeMix({ processing: { reverb: { wet: 1 } } }));
  assert.throws(() => normalizeMix({ processing: { compressor: { ratio: Infinity } } }));
  const impulse = new Float32Array(4410);
  impulse[0] = 1;
  const [left, right] = roomReverb(impulse, RATE, config.reverb);
  assert.equal(left.length, right.length);
  assert.ok(left.length > impulse.length);
  assert.ok(left.subarray(impulse.length).some(v => Math.abs(v) > .00001));
  assert.notDeepEqual(left, right);
  assert.ok(left.every(Number.isFinite));
});
test('rendered bend data includes negative preutter, measured report and selective pitch/volume cache invalidation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'videograph-expression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bank = join(root, 'bank');
  mkdirSync(bank);
  writeWavMono16(join(bank, 'a.wav'), signalWave(.3, 440));
  writeFileSync(join(bank, 'oto.ini'), 'a.wav=a,0,20,-100,80,30\n');
  const stub = join(root, 'resampler.mjs'), wavModule = new URL('../../../src/vocal/wav.mjs', import.meta.url).href;
  writeFileSync(stub, `import {writeFileSync} from 'node:fs';import {writeWavMono16} from ${JSON.stringify(wavModule)};
const a=process.argv.slice(2),chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',p=[];
for(let i=0;i<(a[12]?.length??0);){if(a[12][i]==='#'){let end=a[12].indexOf('#',i+1);p.push(...Array(Number(a[12].slice(i+1,end))).fill(p.at(-1)));i=end+1;}else{let n=chars.indexOf(a[12][i])*64+chars.indexOf(a[12][i+1]);p.push(n>=2048?n-4096:n);i+=2;}}
let phase=0;const tempo=Number(a[11]?.slice(1)??120),step=60000/tempo/480*5;
writeWavMono16(a[1],Float32Array.from({length:Math.round(Number(a[6])*44.1)},(_,i)=>{let cents=p[Math.min(p.length-1,Math.floor(i/44.1/step))]??0;phase+=2*Math.PI*440*2**(cents/1200)/44100;return Math.sin(phase)*.3;}));writeFileSync(a[1]+'.args.json',JSON.stringify(a));`);
  const plan = single({ startBeats: 1, durationBeats: 2, pitchCurve: [{ x: -100, y: 10, shape: 'lin' }, { x: 1000, y: 10 }], snapFirst: false });
  const opts = { resampler: [process.execPath, stub], voicebankDir: bank, workDir: join(root, 'notes'), cacheDir: join(root, 'cache'), outWav: join(root, 'vocal.wav') };
  const first = await renderUstx({ ...opts, ustxText: serializeUstx(buildUstx(plan)) });
  assert.equal(first.cacheSummary.misses, 1);
  assert.ok(first.pitchQuality.summary.medianAbsTargetErrorCents < 3, JSON.stringify(first.pitchQuality));
  const args = JSON.parse(readFileSync(join(opts.workDir, 'note-0000.wav.args.json')));
  assert.equal(args[11], '!120');
  assert.equal(first.phonemeLayout[0].preutterMs, 80);
  assert.equal(JSON.parse(readFileSync(first.pitchReportPath)).timingSource, 'measured');
  plan.parts[0].notes[0].volume = 50;
  assert.equal((await renderUstx({ ...opts, ustxText: serializeUstx(buildUstx(plan)) })).cacheSummary.hits, 1);
  plan.parts[0].pitchDeviation = [{ timeMs: 0, cents: 50 }, { timeMs: 2000, cents: 50 }];
  assert.equal((await renderUstx({ ...opts, ustxText: serializeUstx(buildUstx(plan)) })).cacheSummary.misses, 1);
});

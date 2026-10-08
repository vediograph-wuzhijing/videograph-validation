// Optional real-bank audit. No bundled samples, no writes to everyday projects.
// Run: node scripts/vocal-pitch-audit.mjs [--alias oto-alias]
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/vocal/config.mjs';
import { loadVoicebank } from '../src/vocal/oto.mjs';
import { buildUstx, serializeUstx } from '../src/vocal/ustx.mjs';
import { renderUstx } from '../src/vocal/render.mjs';
import { extractReferencePitch } from '../src/vocal/pitch-analysis.mjs';
import { readWav } from '../src/vocal/wav.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = resolveConfig({ projectRoot: root });
const missing = config.missing.filter(key => key !== 'openutauHome');
assert.equal(missing.length, 0, `缺配置：${missing.join(', ')}，见 docs/VOCAL.md`);
const bank = loadVoicebank(config.sources.voicebankDir.value);
const aliasIndex = process.argv.indexOf('--alias');
const lyric = aliasIndex >= 0 ? process.argv[aliasIndex + 1] : ['あ', '- あ'].find(alias => bank.findAlias(alias));
assert.ok(lyric && bank.findAlias(lyric), '请用 --alias 指定声库内可持续发声的元音 oto 别名');
const out = join(root, '.cache/vocal-pitch-audit');
mkdirSync(out, { recursive: true });
const plan = () => ({ name: '实测调音验收', tempo: 160, tracks: [{}], parts: [{ notes: [
  { lyric, tone: 69, startBeats: 1, durationBeats: 6, snapFirst: false },
] }] });
const variants = { flat: plan(), bend: plan(), vibrato: plan(), pitd: plan(), fast: plan() };
variants.bend.parts[0].notes[0].pitchCurve = [{ x: -120, y: 20, shape: 'lin' }, { x: 2250, y: 20 }];
variants.vibrato.parts[0].notes[0].vibrato = { length: 100, period: 200, depth: 45, in: 10, out: 10 };
variants.pitd.parts[0].pitchDeviation = [{ timeMs: 0, cents: 100 }, { timeMs: 2625, cents: 100 }];
variants.fast.parts[0].notes = [60, 62, 64, 67, 65, 64].map((tone, i) => ({ lyric, tone, startBeats: 1 + i * .5, durationBeats: .5 }));
async function render(name, score) {
  const ustxText = serializeUstx(buildUstx(score));
  writeFileSync(join(out, `${name}.ustx`), ustxText);
  const result = await renderUstx({ ustxText, resampler: config.sources.resampler.value,
    contract: config.sources.resamplerContract.value, voicebank: bank,
    outWav: join(out, `${name}.wav`), workDir: join(out, name), cacheDir: join(out, 'cache') });
  console.log(`${name}: ${JSON.stringify(result.pitchQuality.summary)}`);
  return { quality: result.pitchQuality, layout: result.phonemeLayout, stemGain: result.stemGain };
}
const results = {};
for (const [name, score] of Object.entries(variants)) results[name] = await render(name, score);
const flatHz = results.flat.quality.notes[0].measuredHzMedian;
assert.ok(flatHz > 0 && results.flat.quality.notes[0].voicedCoverage > .8, '基准元音没有可靠 F0');
for (const [name, cents] of [['bend', 200], ['pitd', 100]]) {
  const hz = results[name].quality.notes[0].measuredHzMedian;
  assert.ok(hz > 0 && Math.abs(1200 * Math.log2(hz / flatHz) - cents) < 30, `${name} 的实测音高偏移未生效`);
}
const modulation = results.vibrato.quality.notes[0].measuredModulation;
assert.ok(modulation && Math.abs(modulation.rateHz - 5) < .4 && modulation.depthCents > 25, '5Hz 颤音未可靠测出');
assert.ok(results.fast.quality.notes.every(note => note.voicedCoverage > .4), '短音符可靠覆盖不足');
const extracted = extractReferencePitch(readWav(join(out, 'vibrato.wav')), plan());
writeFileSync(join(out, 'extracted-plan.json'), JSON.stringify(extracted.plan, null, 2));
writeFileSync(join(out, 'extracted-report.json'), JSON.stringify(extracted.report));
results.transferred = await render('transferred', extracted.plan);
const transferred = results.transferred.quality.notes[0].measuredModulation;
assert.ok(transferred && Math.abs(transferred.rateHz - 5) < .5 && transferred.depthCents > 20, '参考 pitd 未保留实测颤音');
writeFileSync(join(out, 'report.json'), JSON.stringify({ bank: bank.name, lyric, results, humanAccepted: false }, null, 2));
console.log(`PASS: ${join(out, 'report.json')}（技术验证，仍需人工试听）`);

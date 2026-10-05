// AE-01/04 纯函数测试：节奏表与节奏报告指标（合成数据，不启服务、不开浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { barGrid, cueSheet, beatLabel, analyzeRhythm, motionPeaks, motionSeries } from '../../../src/server/rhythm.mjs';

// 120 BPM、4/4、16 小节（32s）；kick 在每拍、snare 在 2/4 拍；前 8 小节安静、后 8 小节响。
export function syntheticSong({ bars = 16, quietBars = 8 } = {}) {
  const beats = [], downbeats = [], kick = [], snare = [];
  for (let bar = 0; bar < bars; bar++) for (let beat = 0; beat < 4; beat++) {
    const t = bar * 2 + beat * 0.5;
    beats.push(t);
    if (beat === 0) downbeats.push(t);
    if (bar >= quietBars) { kick.push([t, beat === 0 ? 0.9 : 0.6]); if (beat % 2 === 1) snare.push([t, 0.7]); }
  }
  const envFps = 30, duration = bars * 2, frames = duration * envFps;
  const rms = Array.from({ length: frames }, (_, i) => (i / envFps >= quietBars * 2 ? 0.8 : 0.1) + 0.02 * Math.sin(i));
  const drums = Array.from({ length: frames }, (_, i) => { const t = i / envFps; if (t < quietBars * 2) return 0; const phase = (t % 0.5) / 0.5; return Math.exp(-phase * 8); });
  return { song: 'synthetic', bpm: 120, duration, envFps, beats, downbeats, kick, snare, rms, drums, low: rms, mid: rms, high: rms, vocal: rms.map(() => 0),
    sections: [{ name: 'verse', start: 0, end: quietBars * 2 }, { name: 'chorus', start: quietBars * 2, end: duration }],
    lines: [{ text: 'hello bright world', start: 0.5, end: 3, words: [{ w: 'hello', start: 0.5, end: 1 }, { w: 'bright', start: 1, end: 2 }, { w: 'world', start: 2, end: 3 }] }] };
}

/** 合成画面运动：在给定时刻（加偏移）出现尖峰，其余为低噪声。 */
function syntheticSeries(song, { fps = 30, events = song.downbeats, offset = 0, base = 0.003, peak = 0.08, from = 0, to = song.duration } = {}) {
  const t = [], motion = [], luma = [];
  for (let n = Math.ceil(from * fps); n < to * fps; n++) {
    const time = n / fps;
    t.push(time);
    const hit = events.some((event) => Math.abs(time - (event + offset)) < 0.5 / fps);
    motion.push(hit ? peak : base + 0.0005 * ((n * 7919) % 5));
    luma.push(0.3);
  }
  return { fps, t, motion, luma };
}

test('barGrid：下拍分小节；无下拍按 4 拍；无拍点按 2 秒块', () => {
  const song = syntheticSong();
  assert.equal(barGrid(song).bars.length, 16);
  assert.equal(barGrid(song).grid, 'downbeats');
  assert.equal(barGrid({ ...song, downbeats: [] }).grid, 'beats/4');
  assert.equal(barGrid({ ...song, downbeats: [] }).bars.length, 16);
  const blocks = barGrid({ duration: 7, beats: [], downbeats: [] });
  assert.equal(blocks.grid, 'blocks-2s');
  assert.deepEqual(blocks.bars.map((bar) => bar.start), [0, 2, 4, 6]);
});

test('cueSheet：能量分级、鼓点型、段首、能量突变、歌词与切点标记', () => {
  const song = syntheticSong();
  const sheet = cueSheet(song, { shots: [{ id: 'a', start: 0 }, { id: 'b', start: 16 }], transitions: [{ toShotId: 'b', mode: 'dissolve' }] });
  assert.equal(sheet.bars.length, 16);
  const quiet = sheet.bars[0], loud = sheet.bars[8];
  assert.ok(loud.energy > quiet.energy, '响的段落能量更高');
  assert.equal(quiet.drums, '.. .. .. ..');
  assert.equal(loud.drums, 'K. X. K. X.');
  assert.match(loud.section, /▶chorus 1\/8/);
  assert.ok(loud.marks.includes('↑↑爆发'));
  assert.ok(loud.marks.some((mark) => mark.startsWith('✂2(dissolve)')));
  assert.equal(quiet.words, 'hello bright');
  assert.match(sheet.text, /节奏表 · synthetic · 120\.0 BPM/);
  assert.equal(cueSheet(song, { start: 4, end: 8 }).bars.length, 2, '按时间段截取');
});

test('cueSheet：器乐工程不出现歌词；无分析时报错', () => {
  const song = { ...syntheticSong(), lines: [] };
  assert.ok(cueSheet(song).bars.every((bar) => !/hello/.test(bar.words)));
  assert.throws(() => cueSheet(null), /没有可用的音乐分析/);
});

test('cueSheet：参考工程真实数据可读（中文表头、87 小节左右、副歌段首）', () => {
  const song = JSON.parse(readFileSync(fileURLToPath(new URL('../../../src/song/data/full-song.json', import.meta.url)), 'utf8'));
  const sheet = cueSheet(song);
  assert.ok(sheet.bars.length >= 80 && sheet.bars.length <= 95, `小节数 ${sheet.bars.length}`);
  assert.ok(sheet.bars.some((bar) => /▶chorus1/.test(bar.section)));
  assert.ok(sheet.text.length < 20000, '全片节奏表应能一次读完');
});

test('beatLabel：下拍与 kick 标记、正在唱的词', () => {
  const song = syntheticSong();
  const label = beatLabel(song, 16, 1 / 60);
  assert.equal(label.bar, 9);
  assert.ok(label.marks.includes('●下拍') && label.marks.includes('K'));
  assert.equal(beatLabel(song, 1.2).word, 'bright');
});

test('analyzeRhythm：画面峰对齐下拍 → 命中率 100%、无系统偏移', () => {
  const song = syntheticSong();
  const report = analyzeRhythm(song, syntheticSeries(song));
  assert.equal(report.metrics.hits.downbeat.rate, 1);
  assert.equal(report.metrics.hits.downbeat.medianOffsetMs, 0);
  assert.equal(report.metrics.motion.peaksOnGrid, 1);
  assert.match(report.text, /下拍 100%/);
});

test('analyzeRhythm：画面整体滞后 133ms → 命中率低并报告滞后', () => {
  const song = syntheticSong();
  const report = analyzeRhythm(song, syntheticSeries(song, { offset: 4 / 30 }));
  assert.ok(report.metrics.hits.downbeat.rate < 0.2, `rate ${report.metrics.hits.downbeat.rate}`);
  const late = analyzeRhythm(song, syntheticSeries(song, { offset: 2 / 30 }));
  assert.ok(late.metrics.hits.downbeat.medianOffsetMs >= 50, '±容差内的滞后要报出偏移');
  assert.match(late.text, /滞后/);
});

test('analyzeRhythm：响段画面静止 → 死区；连续下拍无反应 → 匀速漂移', () => {
  const song = syntheticSong();
  const series = syntheticSeries(song, { events: [], base: 0.0002 });
  const report = analyzeRhythm(song, series);
  assert.ok(report.metrics.deadZones.length >= 1, '响段（第 9–16 小节）应判为死区');
  assert.ok(report.metrics.deadZones[0].from >= 15.9);
  assert.ok(report.metrics.flatZones.length >= 1);
  assert.match(report.text, /死区/);
});

test('analyzeRhythm：安静段画面持续激烈 → 过忙；段落跟随为负', () => {
  const song = syntheticSong({ bars: 16, quietBars: 8 });
  const series = syntheticSeries(song, { events: [] });
  series.motion = series.t.map((t) => (t < 16 ? 0.06 : 0.003));
  const report = analyzeRhythm(song, series);
  assert.ok(report.metrics.busyZones.length >= 1);
});

test('analyzeRhythm：每秒 >3 次全画面明暗交替 → 闪烁风险', () => {
  const song = syntheticSong();
  const series = syntheticSeries(song);
  series.luma = series.t.map((t, i) => (Math.floor(i / 3) % 2 ? 0.9 : 0.1)); // 30fps 每 3 帧翻转 = 5 次/秒
  const report = analyzeRhythm(song, series);
  assert.equal(report.metrics.flash.risk, true);
  assert.match(report.text, /闪烁风险/);
});

test('analyzeRhythm：长时间每秒一闪（低于光敏阈值）→ 持续整帧脉动提示，不算闪烁风险', () => {
  const song = syntheticSong();
  const series = syntheticSeries(song);
  series.luma = series.t.map((t) => (t % 1 < 0.2 ? 0.9 : 0.3)); // 每秒亮一下：每秒 2 次明暗交替
  const report = analyzeRhythm(song, series);
  assert.equal(report.metrics.flash.risk, false);
  assert.ok(report.metrics.flash.pulseSeconds >= 24, `pulseSeconds=${report.metrics.flash.pulseSeconds}`);
  assert.match(report.text, /持续整帧明暗脉动/);
  const calm = analyzeRhythm(song, syntheticSeries(song));
  assert.equal(calm.metrics.flash.pulseSeconds, 0);
  assert.doesNotMatch(calm.text, /持续整帧明暗脉动/);
});

test('analyzeRhythm：死区提示引导镜头内运动，不引导整帧闪白/震动', () => {
  const song = syntheticSong();
  const report = analyzeRhythm(song, syntheticSeries(song, { events: [] }));
  assert.match(report.text, /死区/);
  assert.match(report.text, /不要用整帧闪白、震动或逐拍推镜去填/);
});

test('analyzeRhythm：切点离拍会被指出；局部时间段只统计段内事件', () => {
  const song = syntheticSong();
  const report = analyzeRhythm(song, syntheticSeries(song, { from: 16, to: 24 }), { shots: [{ id: 'a', start: 0 }, { id: 'b', start: 17.25 }] });
  assert.equal(report.metrics.hits.downbeat.events, 3, '16s 是采样首帧（无上一帧可比），不计入');
  assert.equal(report.metrics.cuts[0].toBeatMs, 250);
  assert.match(report.text, /切在拍外/);
});

test('motionSeries / motionPeaks：帧差与稳健阈值', () => {
  const a = new Uint8Array(16).fill(0), b = new Uint8Array(16).fill(255);
  const { motion, luma } = motionSeries([a, a, b, b]);
  assert.deepEqual(motion, [0, 0, 1, 0]);
  assert.deepEqual(luma, [0, 0, 1, 1]);
  const { peaks } = motionPeaks([0, 1, 2, 3, 4, 5], [0.001, 0.001, 0.2, 0.19, 0.001, 0.001]);
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0].t, 2);
});

test('闪烁按线性亮度：暗部明暗交替（码值 20↔70）不算闪光，黑白交替才算', () => {
  const song = syntheticSong();
  const frames = (low, high) => Array.from({ length: 60 }, (_, i) => new Uint8Array(16).fill(Math.floor(i / 3) % 2 ? high : low));
  const dark = motionSeries(frames(20, 70));
  const bright = motionSeries(frames(0, 255));
  const t = Array.from({ length: 60 }, (_, i) => 16 + i / 30);
  assert.equal(analyzeRhythm(song, { fps: 30, t, ...dark }).metrics.flash.risk, false);
  assert.equal(analyzeRhythm(song, { fps: 30, t, ...bright }).metrics.flash.risk, true);
});

test('相对运动：细线小主体与粗大主体做同比例运动，相对等级一致（不因构图稀疏被判静止）', () => {
  const song = syntheticSong();
  const make = (width) => Array.from({ length: 60 }, (_, i) => {
    const frame = new Uint8Array(64 * 36);
    const x0 = 10 + (i % 2) * width; // 每帧主体平移自身宽度
    for (let y = 10; y < 26; y++) for (let x = x0; x < x0 + width; x++) frame[y * 64 + x] = 220;
    return frame;
  });
  const thin = motionSeries(make(2)), bold = motionSeries(make(16));
  assert.ok(bold.motion[5] > thin.motion[5] * 5, '绝对运动随主体面积变化');
  const t = Array.from({ length: 60 }, (_, i) => 16 + i / 30);
  const relOf = (s) => analyzeRhythm(song, { fps: 30, t, ...s }).bars.find((bar) => bar.rel !== null).rel;
  assert.ok(Math.abs(relOf(thin) - relOf(bold)) / relOf(bold) < 0.35, `相对运动应接近：${relOf(thin)} vs ${relOf(bold)}`);
});

test('等级运动按 1/15 秒间隔取差：30fps 连续运动的等级运动约为相邻帧差的 2 倍', () => {
  // 宽 8px 的亮条每帧右移 1px：相邻帧差 2 列，间隔 2 帧差 4 列。
  const frames = Array.from({ length: 30 }, (_, i) => { const f = new Uint8Array(64 * 36); for (let y = 0; y < 36; y++) for (let x = 10 + i; x < 18 + i; x++) f[y * 64 + x] = 200; return f; });
  const s1 = motionSeries(frames, 1), s2 = motionSeries(frames, 2);
  assert.deepEqual(s1.levelMotion, s1.motion);
  assert.equal(s2.levelMotion[1], null);
  assert.ok(Math.abs(s2.levelMotion[10] / s2.motion[10] - 2) < 1e-9);
});

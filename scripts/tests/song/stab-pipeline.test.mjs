// STAB-01 歌曲流水线回归：空鼓点通道、对齐兜底产物过契约、零长度镜头拒绝、重复歌词行、分析器超时。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateAnalysis } from '../../../src/song/contract.mjs';
import { cutFromAnchor, validatePlan } from '../../../src/song/planner.mjs';
import { runAnalysis } from '../../../src/song/analyzer-runner.mjs';
import { lintSceneCode } from '../../../src/song/scene-lint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'videograph-song-stab-'));
after(() => rmSync(work, { recursive: true, force: true }));
const prov = () => ({ tool: 'test', version: '1', startedAt: 0, confidence: 0.9 });
const beats = Array.from({ length: 21 }, (_, i) => i * 0.5);
function raw(lines) {
  return {
    schema: 'videograph-analysis/v2',
    audio: { hash: 'a'.repeat(64), duration: 10, sampleRate: 44100, channels: 2, decoderOffset: 0 },
    rhythm: { bpm: 120, beats, downbeats: beats.filter((_, i) => i % 4 === 0), meter: 4, confidence: 0.9 },
    sections: [{ start: 0, end: 10, name: 'verse' }],
    envelopes: { frameRate: 100, rms: Array.from({ length: 1001 }, () => 0.5) },
    onsets: { kick: [], snare: [[1.5, 0.7]], hat: [], vocal: [] },
    ...(lines ? { lyrics: { language: 'zh', textSource: 'user', humanConfirmed: true, lines } } : {}),
    overrides: [],
    provenance: { audio: prov(), rhythm: prov(), sections: prov(), envelopes: prov(), onsets: prov(), ...(lines ? { lyrics: prov() } : {}) },
  };
}

test('无鼓/清唱：onsets 空通道合法', () => {
  const analysis = validateAnalysis(raw());
  assert.deepEqual(analysis.onsets.kick, []);
  assert.equal(analysis.onsets.snare.length, 1);
});

test('beats 越过时长被拒绝', () => {
  const bad = raw();
  bad.rhythm.beats = [...beats, 12];
  assert.throws(() => validateAnalysis(bad), /越过音频时长/);
});

test('对齐兜底形状（行界内插、按字摊开、conf 0.3）通过契约', () => {
  // 与 analyzer/analyze.py fill_unaligned_lines 的输出一致：第 2 行对齐失败，夹在第 1、3 行之间摊开。
  const lines = [
    { text: '第一句', start: 1, end: 2, words: [{ w: '第', start: 1, end: 1.3 }, { w: '一', start: 1.3, end: 1.6 }, { w: '句', start: 1.6, end: 2 }] },
    { text: '第二句', start: 2, end: 5, fallback: true, words: [{ w: '第', start: 2, end: 3, conf: 0.3 }, { w: '二', start: 3, end: 4, conf: 0.3 }, { w: '句', start: 4, end: 5, conf: 0.3 }] },
    { text: '第三句', start: 5, end: 6, words: [{ w: '第三句', start: 5, end: 6 }] },
  ];
  const analysis = validateAnalysis(raw(lines));
  assert.equal(analysis.lyrics.lines.length, 3);
});

const repeated = () => validateAnalysis(raw([
  { text: '副歌', start: 2, end: 3, words: [{ w: '副歌', start: 2, end: 3 }] },
  { text: '主歌', start: 4, end: 5, words: [{ w: '主歌', start: 4, end: 5 }] },
  { text: '副歌', start: 6, end: 7, words: [{ w: '副歌', start: 6, end: 7 }] },
]));

test('重复歌词行：未指定 occurrence 报错；occurrence / lineIndex 命中第二遍', () => {
  const analysis = repeated();
  assert.throws(() => cutFromAnchor(analysis, { lineText: '副歌' }), /出现 2 次/);
  assert.equal(cutFromAnchor(analysis, { lineText: '副歌', occurrence: 2 }, { fps: 30 }), 6);
  assert.equal(cutFromAnchor(analysis, { lineIndex: 2 }, { fps: 30 }), 6);
  assert.throws(() => cutFromAnchor(analysis, { lineText: '副歌', occurrence: 3 }), /没有第 3 次/);
  assert.throws(() => cutFromAnchor(analysis, { lineIndex: 9 }), /不存在/);
});

test('validatePlan 拒绝落在曲尾的切点（零长度镜头）', () => {
  const analysis = repeated();
  assert.throws(() => validatePlan([{ t: 0 }, { t: 10 }], analysis, { fps: 30 }), /不足一帧/);
  const { shots } = validatePlan([{ t: 0 }, { lineIndex: 2 }], analysis, { fps: 30 });
  assert.deepEqual(shots.map((shot) => [shot.start, shot.end]), [[0, 6], [6, 10]]);
});

test('scene-lint：转义引号与模板字符串字面量也被检查', () => {
  const analysis = repeated();
  assert.equal(lintSceneCode("ly.get('don\\'t stop')", analysis).ok, false);
  assert.equal(lintSceneCode('ly.get(`不存在`)', analysis).ok, false);
  assert.equal(lintSceneCode('ly.get(`副歌`)', analysis).ok, true);
  assert.equal(lintSceneCode('ly.get(`${name}`)', analysis).ok, true, '含插值无法静态检查，放行');
});

test('分析器卡死：超时后结束进程并给出清晰错误', async () => {
  const audio = join(work, 'song.mp3');
  writeFileSync(audio, 'fake');
  const started = Date.now();
  await assert.rejects(() => runAnalysis({ audioPath: audio, stages: ['t0', 't1'], python: process.execPath, t3Python: process.execPath,
    analyzerScript: join(here, 'fixtures', 'stub_hang.mjs'), cacheRoot: join(work, 'cache'), timeoutMs: 800 }), /超时/);
  assert.ok(Date.now() - started < 10000);
});

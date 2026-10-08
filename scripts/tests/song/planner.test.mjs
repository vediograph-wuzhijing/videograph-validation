// SONG-04 规划器测试：通用切点、锚点推导、词中间拒绝、覆盖校验、兜底规划。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysis, SongError } from '../../../src/song/contract.mjs';
import { candidateCutPoints, cutFromAnchor, validatePlan, planFromSections, DEFAULT_SHOT_RANGE } from '../../../src/song/planner.mjs';

const prov = () => ({ tool: 'test', version: '1', startedAt: 0, confidence: 0.9 });
function fixture() {
  const beats = Array.from({ length: 21 }, (_, i) => i * 0.5);           // 0..10s，2 秒一小节
  return validateAnalysis({
    schema: 'videograph-analysis/v2',
    audio: { hash: 'a'.repeat(64), duration: 10, sampleRate: 44100, channels: 2, decoderOffset: 0 },
    rhythm: { bpm: 120, beats, downbeats: beats.filter((_, i) => i % 4 === 0), meter: 4, confidence: 0.9 },
    sections: [{ start: 0, end: 4, name: 'intro' }, { start: 4, end: 10, name: 'verse1' }],
    envelopes: { frameRate: 100, rms: Array.from({ length: 1001 }, (_, i) => Math.min(1, i / 1000)), low: Array.from({ length: 1001 }, (_, i) => Math.min(1, i / 2000)), mid: Array.from({ length: 1001 }, (_, i) => Math.min(1, i / 1500)), high: Array.from({ length: 1001 }, (_, i) => Math.min(1, i / 3000)) },
    onsets: { kick: [[0.5, 0.8]], snare: [[1.5, 0.7]], hat: [[0.25, 0.3]], vocal: [[2, 0.5]] },
    lyrics: {
      language: 'zh', textSource: 'user', humanConfirmed: true,
      lines: [
        { text: '第一句歌词', start: 2, end: 4, words: [{ w: '第一句', start: 2, end: 3 }, { w: '歌词', start: 3, end: 4 }] },
        { text: '第二句歌词', start: 6, end: 8, words: [{ w: '第二句', start: 6, end: 7 }, { w: '歌词', start: 7, end: 8 }] },
      ],
    },
    overrides: [],
    provenance: { audio: prov(), rhythm: prov(), sections: prov(), envelopes: prov(), onsets: prov(), lyrics: prov() },
  });
}

test('锚定行切点 = 行首词前最近拍，量化到帧', () => {
  const analysis = fixture();
  assert.equal(cutFromAnchor(analysis, { lineText: '第二句歌词' }, { fps: 30 }), 6.0);
});
test('切点避让上一个词的尾巴，不落词中间', () => {
  const analysis = fixture();
  // 手工构造：前一个词拖到 6.4s（覆盖拍 6.0），锚定行 8s 起 → 6.0 在词中 → 回退 5.5
  analysis.lyrics.lines[0].words[1].end = 6.4;
  const cut = cutFromAnchor(analysis, { lineText: '第二句歌词' }, { fps: 30 });
  assert.equal(cut, 3.0, '连续回退直到不在任何词中间（上一个词被人为拖长到 6.4s）');
});
test('未知锚定行、越界 t、词中间 t 拒绝', () => {
  const analysis = fixture();
  assert.throws(() => cutFromAnchor(analysis, { lineText: '不存在的句子' }), /不存在/);
  assert.throws(() => cutFromAnchor(analysis, { t: 99 }), /越界/);
  assert.throws(() => cutFromAnchor(analysis, { t: 2.5 }), /词的中间/);
  assert.throws(() => cutFromAnchor(analysis, {}), /lineText\/sectionIndex\/t/);
  assert.throws(() => cutFromAnchor(analysis, {t:NaN}), /有限数字/);
  assert.throws(() => cutFromAnchor(analysis, {t:Infinity}), /有限数字/);
});
test('持续段/警告策略保留真实词时序；词起音附近仍拒绝 sustain',()=>{
  const analysis=fixture(), original=structuredClone(analysis.lyrics);
  assert.equal(cutFromAnchor(analysis,{t:2.5,cutPolicy:'sustain'}),2.5);
  assert.throws(()=>cutFromAnchor(analysis,{t:2.03,cutPolicy:'sustain'}),/词的中间/);
  const plan=validatePlan([{t:0},{t:2.5,cutPolicy:'warn'},{t:6}],analysis);
  assert.ok(plan.warnings.some(w=>w.includes('持续段')));
  assert.deepEqual(analysis.lyrics,original);
});
test('候选切点集合：行切点 + 段落边界 + 不在词中的小节线，升序', () => {
  const analysis = fixture();
  const candidates = candidateCutPoints(analysis, { fps: 30 });
  assert.equal(candidates[0], 0);
  assert.ok(candidates.includes(2.0), '行首切点 2.0s 在候选中');
  assert.ok(candidates.includes(4.0), '段落边界 4.0s 在候选中');
  assert.ok(!candidates.includes(2.5), '词中间的 2.5s 不在候选中');
  for (let i = 1; i < candidates.length; i++) assert.ok(candidates[i] > candidates[i - 1]);
});
test('validatePlan：锚点推导时间、覆盖全曲、强制首刀为 0', () => {
  const analysis = fixture();
  const { shots, warnings } = validatePlan([
    { id: 'open', title: '开场', sectionIndex: 0 },
    { lineText: '第一句歌词' },
    { lineText: '第二句歌词' },
  ], analysis, { fps: 30 });
  assert.deepEqual(shots.map((shot) => shot.start), [0, 2.0, 6.0]);
  assert.equal(shots[shots.length - 1].end, 10);
  assert.equal(shots[0].status, 'needs-generation');
  assert.equal(shots[0].source, 'ai-original');
  assert.ok(!warnings.some((warning) => warning.includes('强制为 0')), '首锚点本来就是 0 时无需告警');
  assert.equal(new Set(shots.map((shot) => shot.id)).size, shots.length);
});
test('validatePlan 拒绝：单镜头、不递增、重复 id', () => {
  const analysis = fixture();
  assert.throws(() => validatePlan([{ lineText: '第一句歌词' }], analysis), /至少需要 2 个/);
  assert.throws(() => validatePlan([{ sectionIndex: 0 }, { lineText: '第一句歌词' }, { lineText: '第一句歌词' }], analysis), /递增/, '非首刀相同锚点必须拒绝');
  assert.throws(() => validatePlan([{ id: 'x', sectionIndex: 0 }, { id: 'x', lineText: '第一句歌词' }], analysis), /重复/);
  assert.throws(() => validatePlan([{ sectionIndex: 5 }, { lineText: '第一句歌词' }], analysis), /段落不存在/);
});
test('时长边界只告警不拒绝；帧量化生效', () => {
  const analysis = fixture();
  const plan = [{ sectionIndex: 0 }, { t: 1.0 }, { lineText: '第一句歌词' }, { lineText: '第二句歌词' }];
  const { shots, warnings } = validatePlan(plan, analysis, { fps: 30 });
  assert.equal(shots[1].start, 1.0);
  assert.ok(warnings.some((warning) => warning.includes('低于建议下限')));
  for (const shot of shots) {
    assert.equal(Math.round(shot.start * 30), shot.start * 30, '切点量化到 1/30 帧');
    assert.equal(Math.round(shot.end * 30), shot.end * 30, '结束点量化到 1/30 帧');
  }
});
test('兜底规划：每段一镜、标记 fallback-deterministic', () => {
  const analysis = fixture();
  const { shots, warnings } = planFromSections(analysis, { fps: 30 });
  assert.equal(shots.length, 2);
  assert.equal(shots[0].source, 'fallback-deterministic');
  assert.equal(shots[0].start, 0);
  assert.equal(shots[1].end, 10);
  assert.ok(shots.every((shot) => shot.prompt.includes('非 AI 创作')));
});

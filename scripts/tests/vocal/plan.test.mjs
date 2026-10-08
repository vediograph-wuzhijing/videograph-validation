import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVocalPlan, normalizeMix } from '../../../src/vocal/plan.mjs';
import { selectedAudio } from '../../../src/server/audio-track.mjs';
import { authorizeMutation } from '../../../src/server/auth.mjs';
const plan = { tempo: 120, tracks: [{}], parts: [{ notes: [
  { lyric: 'a', text: '你好', pitch: 'C4', startBeats: 1, durationBeats: 1 },
  { lyric: 'R', pitch: 'C4', startBeats: 2, durationBeats: 1 },
  { lyric: 'i', text: '世界', pitch: 'D4', startBeats: 3, durationBeats: 1 },
] }] };
test('歌词显示文本与发音别名分离，乐谱绝对时间和休止符准确', () => {
  const result = prepareVocalPlan(plan, 4);
  assert.equal(result.lyrics.timingSource, 'score');
  assert.deepEqual(result.lyrics.lines.map((l) => [l.text, l.start, l.end]), [['你好', 0.5, 1], ['世界', 1.5, 2]]);
  assert.match(result.ustxText, /lyric: "a"/); assert.match(result.lrc, /\[00:00.50\]你好/);
  assert.equal(plan.parts[0].notes[0].text, '你好');
});
test('不接受超时、重叠、不支持的表达和非有限混音增益', () => {
  assert.throws(() => prepareVocalPlan(plan, 1), /超出/);
  const p = structuredClone(plan); p.parts[0].notes[2].startBeats = 1;
  assert.throws(() => prepareVocalPlan(p, 4), /重叠/);
  const q = structuredClone(plan); q.parts[0].notes[0].vibrato = { length: 50, volLink: 20 };
  assert.throws(() => prepareVocalPlan(q, 4), /volLink/);
  assert.throws(() => normalizeMix({ vocalGain: NaN }), /vocalGain/);
  assert.throws(() => normalizeMix({ backingGain: 0, vocalGain: 0 }), /静音/);
});
test('音轨选择与人工采用闸门', () => {
  const p = { audio: { hash: 'original', engineFile: 'audio/song.wav' } };
  assert.equal(selectedAudio(p).hash, 'original');
  p.vocal = { active: { mixHash: 'mixed', jobId: 'job' } };
  assert.equal(selectedAudio(p).engineFile, 'audio/vocal-mixed.wav');
  for (const action of ['adopt', 'reset']) assert.throws(() => authorizeMutation('mcp', ['projects', 'id', 'vocal', action], {}), /只允许人/);
  authorizeMutation('mcp', ['projects', 'id', 'vocal', 'render'], {});
});

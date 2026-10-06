// ustx 测试：plan → USTX 0.10 数据与文本；结构自检；音名换算；默认值对齐 OpenUtau。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USTX_VERSION, TICKS_PER_BEAT, STANDARD_EXPRESSIONS, PORTAMENTO,
  buildUstx, serializeUstx, validateUstxText, nameToTone, toneToName, UstxError,
} from '../../../src/vocal/ustx.mjs';
import { parseYaml } from '../../../src/vocal/yaml-lite.mjs';

const simplePlan = {
  name: '测试曲',
  tempo: 96,
  tracks: [{ singer: 'test-bank', trackName: '主唱' }],
  parts: [{
    name: 'A 段',
    notes: [
      { lyric: 'ど', pitch: 'C4', startBeats: 0, durationBeats: 0.5 },
      { lyric: 'れ', tone: 62, startBeats: 0.5, durationBeats: 0.5 },
      { lyric: 'み', pitch: 'D4', startBeats: 1, durationBeats: 1, vibrato: { length: 40 } },
    ],
  }],
};

test('音名与 MIDI 编号换算（C4=60，与 OpenUtau MusicMath 一致）', () => {
  assert.equal(nameToTone('C4'), 60);
  assert.equal(nameToTone('A3'), 57);
  assert.equal(nameToTone('A#3'), 58);
  assert.equal(nameToTone('Db5'), 73);
  assert.equal(toneToName(60), 'C4');
  assert.equal(toneToName(57), 'A3');
  assert.equal(toneToName(58), 'A#3');
  assert.equal(toneToName(61), 'C#4');
  assert.throws(() => nameToTone('H4'), UstxError);
  assert.throws(() => nameToTone(128), UstxError);
});

test('buildUstx：顶层结构与标准表情表', () => {
  const project = buildUstx(simplePlan);
  assert.equal(project.ustx_version, USTX_VERSION);
  assert.deepEqual(project.tempos, [{ position: 0, bpm: 96 }]);
  assert.deepEqual(project.time_signatures, [{ bar_position: 0, beat_per_bar: 4, beat_unit: 4 }]);
  assert.equal(project.tracks.length, 1);
  assert.equal(project.tracks[0].singer, 'test-bank');
  assert.equal(project.tracks[0].track_name, '主唱');
  // required 表情齐全，缩写是序列化键（含 mod+）
  for (const abbr of ['dyn', 'pitd', 'clr', 'eng', 'vel', 'vol', 'atk', 'dec', 'gen', 'mod+']) {
    assert.ok(project.expressions[abbr], `缺表情 ${abbr}`);
  }
  assert.equal(project.expressions.length, undefined); // 是映射不是数组
  assert.equal(Object.keys(project.expressions).length, STANDARD_EXPRESSIONS.length);
  assert.equal(project.expressions.gen.flag, 'g');
  assert.equal(project.expressions.vel.defaultValue, 100);
});

test('buildUstx：音符位置相对 part、默认滑音与颤音对齐 OpenUtau 预设', () => {
  const project = buildUstx(simplePlan);
  const part = project.voice_parts[0];
  assert.equal(part.name, 'A 段');
  assert.equal(part.track_no, 0);
  assert.equal(part.position, 0); // 首音符在 0 拍
  const [n1, n2, n3] = part.notes;
  assert.deepEqual([n1.position, n1.duration], [0, 240]);
  assert.equal(n1.tone, 60);
  assert.deepEqual(
    n1.pitch.data,
    [{ x: PORTAMENTO.startMs, y: 0, shape: 'sp' }, { x: PORTAMENTO.lengthMs, y: 0, shape: 'io' }],
  );
  assert.equal(n1.pitch.snap_first, true);
  assert.deepEqual(n1.vibrato, { length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0 });
  assert.equal(n2.tone, 62); // 数字 tone 直通
  assert.deepEqual([n3.position, n3.duration], [480, 480]);
  assert.equal(n3.vibrato.length, 40);
  assert.equal(n3.vibrato.period, 175); // 未指定的参数落默认
  assert.equal(part.duration, 960); // 末音符结束
});

test('buildUstx：绝对起点不落在 0 时 part.position 跟随', () => {
  const project = buildUstx({
    tracks: [{}],
    parts: [{ notes: [{ lyric: 'あ', pitch: 'C4', startBeats: 8, durationBeats: 1 }] }],
  });
  const part = project.voice_parts[0];
  assert.equal(part.position, 8 * TICKS_PER_BEAT);
  assert.deepEqual([part.notes[0].position, part.notes[0].duration], [0, TICKS_PER_BEAT]);
});

test('buildUstx：参数校验给出可定位的错误', () => {
  assert.throws(() => buildUstx({ tracks: [], parts: [{ notes: [] }] }), /tracks/);
  assert.throws(() => buildUstx({ tracks: [{}], parts: [{ notes: [{ lyric: 'あ', pitch: 'C4', startBeats: 0 }] }] }), /时长/);
  assert.throws(() => buildUstx({ tracks: [{}], parts: [{ notes: [{ lyric: 'あ', startBeats: 0, durationBeats: 1 }] }] }), /音高/);
  assert.throws(() => buildUstx({
    tracks: [{}],
    parts: [{ trackNo: 3, notes: [{ lyric: 'あ', pitch: 'C4', startBeats: 0, durationBeats: 1 }] }],
  }), /trackNo/);
  assert.throws(() => buildUstx({
    tracks: [{}],
    parts: [{
      notes: [
        { lyric: 'あ', pitch: 'C4', startBeats: 0, durationBeats: 1 },
        { lyric: 'い', pitch: 'D4', startBeats: 0.5, durationBeats: 1 },
      ],
    }],
  }), /重叠/);
});

test('serializeUstx + validateUstxText：自检通过且往返一致', () => {
  const project = buildUstx(simplePlan);
  const text = serializeUstx(project);
  assert.match(text, /ustx_version: "0\.10"/);
  assert.match(text, /^  mod\+:$/m); // mod+ 键可裸写（块式描述符）
  const verdict = validateUstxText(text);
  assert.deepEqual(verdict, { ok: true, errors: [] });
  assert.deepEqual(parseYaml(text), project);
});

test('validateUstxText：损坏结构逐条报告', () => {
  assert.equal(validateUstxText('a: [1').ok, false);
  const verdict = validateUstxText('ustx_version: "0.9"\ntracks: []\n');
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('ustx_version')));
  assert.ok(verdict.errors.some((e) => e.includes('tempos')));
  assert.ok(verdict.errors.some((e) => e.includes('voice_parts')));
});

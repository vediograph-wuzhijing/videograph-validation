// yaml-lite 测试：USTX 子集的写出与解析（往返、流式映射、嵌套序列、引号策略）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { emitYaml, parseYaml, needsQuote, YamlError } from '../../../src/vocal/yaml-lite.mjs';

test('标量映射与嵌套映射往返', () => {
  const src = {
    name: 'New Project',
    comment: '',
    ustx_version: '0.10',
    key: 0,
    tempo: 120,
    flag_on: true,
    ratio: 0.5,
  };
  const parsed = parseYaml(emitYaml(src));
  assert.deepEqual(parsed, src);
  // 版本号是字符串必须带引号，否则会被当数字解析
  assert.match(emitYaml(src), /ustx_version: "0\.10"/);
});

test('序列项与所属键同缩进（YamlDotNet 风格），首键在 `- ` 之后', () => {
  const src = {
    tempos: [{ position: 0, bpm: 120 }],
    time_signatures: [{ bar_position: 0, beat_per_bar: 4, beat_unit: 4 }],
  };
  const text = emitYaml(src);
  assert.equal(text, [
    'tempos:',
    '- position: 0',
    '  bpm: 120',
    'time_signatures:',
    '- bar_position: 0',
    '  beat_per_bar: 4',
    '  beat_unit: 4',
    '',
  ].join('\n'));
  assert.deepEqual(parseYaml(text), src);
});

test('音符式深嵌套：序列项延续键下再有映射与序列（音高点流式）', () => {
  const src = {
    voice_parts: [{
      name: 'Part 1',
      track_no: 0,
      position: 0,
      duration: 960,
      notes: [{
        position: 0,
        duration: 480,
        tone: 60,
        lyric: 'ら',
        pitch: {
          data: [{ x: -40, y: 0, shape: 'sp' }, { x: 80, y: 0, shape: 'io' }],
          snap_first: true,
        },
        vibrato: { length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0 },
      }],
      curves: [],
    }],
  };
  const parsed = parseYaml(emitYaml(src));
  assert.deepEqual(parsed, src);
  assert.equal(parsed.voice_parts[0].notes[0].pitch.data[0].shape, 'sp');
  assert.equal(parsed.voice_parts[0].notes[0].vibrato.vol_link, 0);
});

test('解析 OpenUtau 实存文件风格的流式音高点和空集合', () => {
  const text = [
    'notes:',
    '- position: 0',
    '  pitch:',
    '    data:',
    '    - {x: -40, y: 0, shape: sp}',
    '    - {x: 80, y: 12, shape: io}',
    '  curves: []',
    '  masked_curves: []',
    'wave_parts: []',
    '',
  ].join('\n');
  const parsed = parseYaml(text);
  assert.deepEqual(parsed.notes[0].pitch.data, [
    { x: -40, y: 0, shape: 'sp' },
    { x: 80, y: 12, shape: 'io' },
  ]);
  assert.deepEqual(parsed.notes[0].curves, []);
  assert.deepEqual(parsed.wave_parts, []);
});

test('引号策略：mod+ 可裸写，特殊字符串必须加引号', () => {
  assert.equal(needsQuote('mod+'), false);
  assert.equal(needsQuote('dynamics (curve)'), false);
  assert.equal(needsQuote(''), true);
  assert.equal(needsQuote('0.10'), true);      // 数字样字符串
  assert.equal(needsQuote('true'), true);       // 布尔样字符串
  assert.equal(needsQuote(' C4'), true);        // 前导空白
  assert.equal(needsQuote('a: b'), true);       // 含 ": "
  assert.equal(needsQuote('a"b'), true);
  const parsed = parseYaml('name: "0.10"\nlyric: ら\nabbr: mod+\n');
  assert.deepEqual(parsed, { name: '0.10', lyric: 'ら', abbr: 'mod+' });
});

test('null 字段省略；注释与空行跳过', () => {
  const parsed = parseYaml([
    '# 顶部注释',
    'a: 1',
    '',
    'b: 2 # 行尾注释',
    'c: "# 不是注释开头"', // 值以 # 开头须引号
  ].join('\n'));
  assert.deepEqual(parsed, { a: 1, b: 2, c: '# 不是注释开头' });
  const emitted = emitYaml({ a: 1, b: null, c: undefined });
  assert.equal(emitted, 'a: 1\n');
});

test('流式映射内的逗号与引号不撕裂', () => {
  const parsed = parseYaml('opts: {name: "a, b", flag: \'\'}\n');
  assert.deepEqual(parsed, { opts: { name: 'a, b', flag: '' } });
});

test('非法输入报 YamlError', () => {
  assert.throws(() => parseYaml('just a scalar line'), YamlError);
  assert.throws(() => parseYaml('a: {x: 1'), YamlError);
});

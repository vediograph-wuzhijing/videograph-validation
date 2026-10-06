// ust / oto 测试：经典 UST 文本、oto.ini 解析、声库扫描与别名索引。全部离线夹具。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUstx, serializeUstx } from '../../../src/vocal/ustx.mjs';
import { ustxTextToUst, ustxToUst } from '../../../src/vocal/ust.mjs';
import { parseOto, findOtoFiles, loadVoicebank, declaredEncoding, decodeBankText } from '../../../src/vocal/oto.mjs';

const work = mkdtempSync(join(tmpdir(), 'videograph-vocal-oto-'));
after(() => rmSync(work, { recursive: true, force: true }));

test('USTX → UST：音符串接、休止补齐、结尾标记', () => {
  const project = buildUstx({
    name: '测试曲',
    tempo: 90,
    tracks: [{}],
    parts: [{
      notes: [
        { lyric: 'ど', pitch: 'C4', startBeats: 1, durationBeats: 0.5 },
        { lyric: 'れ', pitch: 'D4', startBeats: 2, durationBeats: 1 },
      ],
    }],
  });
  const ust = ustxTextToUst(serializeUstx(project), { voiceDir: 'C:/banks/test', projectName: '测试曲' });
  const lines = ust.split('\n');
  assert.equal(lines[0], 'UST Version 0.3.0');
  assert.match(lines[1], /^Setting=Tempo=90!Tracks=1!ProjectName=测试曲!VoiceDir=C:\/banks\/test$/);
  assert.ok(lines.includes('[#0000]'));
  // part.position 自动对齐首音符（startBeats=1），UST 内音符从 0 开始，无前导休止
  const restIndex = lines.indexOf('[#0000]');
  assert.equal(lines[restIndex + 1], 'Length=240');
  assert.equal(lines[restIndex + 2], 'Lyric=ど');
  assert.ok(lines.includes('[#NEXT]'));
  assert.ok(lines.includes('[#TRACKEND]'));
  // 总长度 = 240 + 240 休止（第 2 音符前）+ 480
  const lengths = lines.filter((l) => l.startsWith('Length=')).map((l) => Number(l.slice(7)));
  assert.deepEqual(lengths, [240, 240, 480]);
});

test('USTX → UST：多 part 与空 part 明确拒绝', () => {
  const twoParts = { voice_parts: [{ notes: [{ position: 0, duration: 480, tone: 60, lyric: 'あ' }] }, { notes: [] }] };
  assert.throws(() => ustxToUst(twoParts), /2 个 voice_parts/);
  assert.throws(() => ustxToUst({ voice_parts: [{ notes: [] }] }), /没有音符/);
  assert.throws(() => ustxToUst({}), /voice_parts/);
});

test('parseOto：标准行（wav=别名,5 数）、省略字段与别名、坏行容错', () => {
  const oto = parseOto([
    'a.wav=あ,100,300,-100,50,30',
    'i.wav=い,0,0,0',
    'bad line without equals',
    'u.wav=,10',          // 别名空 → 取文件名去扩展名
    '# 注释行',
    '',
  ].join('\n'));
  assert.deepEqual(oto, [
    { file: 'a.wav', alias: 'あ', offset: 100, consonant: 300, cutoff: -100, preutter: 50, overlap: 30 },
    { file: 'i.wav', alias: 'い', offset: 0, consonant: 0, cutoff: 0, preutter: 0, overlap: 0 },
    { file: 'u.wav', alias: 'u', offset: 10, consonant: 0, cutoff: 0, preutter: 0, overlap: 0 },
  ]);
});

test('loadVoicebank：多级 oto 扫描、别名字典、重复告警、findAlias 给出 wav 绝对路径', () => {
  const bankDir = join(work, 'bank');
  mkdirSync(join(bankDir, 'sub'), { recursive: true });
  writeFileSync(join(bankDir, 'character.txt'), 'name=テスト音源\nimage=bitmap.bmp\n', 'utf8');
  writeFileSync(join(bankDir, 'oto.ini'), 'a.wav=あ,100,300,-100,50,30\n', 'utf8');
  writeFileSync(join(bankDir, 'sub', 'oto.ini'), 'dup.wav=あ\ni.wav=い\n', 'utf8');

  const bank = loadVoicebank(bankDir);
  assert.equal(bank.name, 'テスト音源');
  assert.equal(bank.entries.length, 3);
  assert.equal(bank.byAlias.size, 2); // 「あ」重复取首个
  assert.ok(bank.warnings.some((w) => w.includes('别名重复')));
  const hit = bank.findAlias('あ');
  assert.equal(hit.entry.offset, 100);
  assert.equal(hit.wav, join(bankDir, 'a.wav')); // 首个来自根 oto.ini
  assert.equal(bank.findAlias('い').wav, join(bankDir, 'sub', 'i.wav'));
  assert.equal(bank.findAlias('不存在'), null);
});

test('loadVoicebank：目录与 oto 缺失给出可操作报错', () => {
  assert.throws(() => loadVoicebank(join(work, '不存在')), /声库目录不存在/);
  const empty = join(work, 'empty');
  mkdirSync(empty);
  assert.throws(() => loadVoicebank(empty), /oto\.ini/);
});

test('findOtoFiles：隐藏目录跳过、深度防御', () => {
  const root = join(work, 'scan');
  mkdirSync(join(root, '.git', 'fake'), { recursive: true });
  writeFileSync(join(root, '.git', 'fake', 'oto.ini'), 'x=x.wav\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'OTO.INI'), 'y=y.wav\n'); // 大小写不敏感
  const found = findOtoFiles(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].dir, join(root, 'sub'));
});

test('Shift-JIS 声库：character.yaml 声明编码生效，别名不乱码', () => {
  const bankDir = join(work, 'sjis-bank');
  mkdirSync(bankDir, { recursive: true });
  // 手工构造 Shift-JIS 字节：あ=82A0 い=82A2 ん=82F1（别名在 `=` 右侧）
  const sjis = (bytes) => Buffer.from(bytes);
  writeFileSync(join(bankDir, 'oto.ini'), Buffer.concat([
    Buffer.from('a.wav='), sjis([0x82, 0xa0]), Buffer.from(',100,50,-80,40,20\r\n'),
    Buffer.from('i.wav='), sjis([0x82, 0xa2]), Buffer.from(',90,40,-70,30,15\r\n'),
    Buffer.from('n.wav='), sjis([0x82, 0xf1]), Buffer.from('\r\n'),
  ]));
  writeFileSync(join(bankDir, 'character.yaml'), 'name: SJIS音源\ntext_file_encoding: shift-jis\n', 'utf8');

  assert.equal(declaredEncoding(bankDir), 'shift-jis');
  const bank = loadVoicebank(bankDir);
  assert.equal(bank.name, 'SJIS音源');
  assert.deepEqual([...bank.byAlias.keys()].sort(), ['い', 'ん', 'あ'].sort());
  assert.ok(bank.byAlias.has('あ'));
  assert.equal(bank.byAlias.get('あ').offset, 100);
});

test('decodeBankText：无声明时 UTF-8 严格解码失败自动退 Shift-JIS', () => {
  const sjisKana = Buffer.from([0x82, 0xa0]); // あ
  assert.equal(decodeBankText(sjisKana, null), 'あ');
  assert.equal(decodeBankText(sjisKana, 'shift-jis'), 'あ');
  assert.equal(decodeBankText(Buffer.from('あ', 'utf8'), null), 'あ');
});

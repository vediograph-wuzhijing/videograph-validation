// ust / oto 测试：经典 UST 文本、oto.ini 解析、声库扫描与别名索引。全部离线夹具。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUstx, serializeUstx } from '../../../src/vocal/ustx.mjs';
import { ustxTextToUst, ustxToUst } from '../../../src/vocal/ust.mjs';
import { parseOto, findOtoFiles, loadVoicebank } from '../../../src/vocal/oto.mjs';

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

test('parseOto：标准行、省略字段、坏行容错', () => {
  const oto = parseOto([
    'あ = a.wav,100,300,200,-100,50,30',
    'い=i.wav,0,0,0',
    'bad line without equals',
    'う=u.wav',
    '# 注释行',
    '',
  ].join('\n'));
  assert.deepEqual(oto, [
    { alias: 'あ', file: 'a.wav', offset: 100, consonant: 300, blank: 200, cutoff: -100, preutter: 50, overlap: 30 },
    { alias: 'い', file: 'i.wav', offset: 0, consonant: 0, blank: 0, cutoff: 0, preutter: 0, overlap: 0 },
    { alias: 'う', file: 'u.wav', offset: 0, consonant: 0, blank: 0, cutoff: 0, preutter: 0, overlap: 0 },
  ]);
});

test('loadVoicebank：多级 oto 扫描、别名字典、重复告警、findAlias 给出 wav 绝对路径', () => {
  const bankDir = join(work, 'bank');
  mkdirSync(join(bankDir, 'sub'), { recursive: true });
  writeFileSync(join(bankDir, 'character.txt'), 'name=テスト音源\nimage=bitmap.bmp\n', 'utf8');
  writeFileSync(join(bankDir, 'oto.ini'), 'あ = a.wav,100,300,200,-100,50,30\n', 'utf8');
  writeFileSync(join(bankDir, 'sub', 'oto.ini'), 'あ=dup.wav\nい=i.wav\n', 'utf8');

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

// render 端到端测试：假重采样器走完整管线（USTX → 别名查找 → 契约调用 → 重叠相加 → WAV）。
// 假重采样器按 13 参契约写 WAV 并旁路记录参数，测试断言契约形状；全部离线、全部临时目录。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUstx, serializeUstx, STANDARD_EXPRESSIONS } from '../../../src/vocal/ustx.mjs';
import { emitYaml } from '../../../src/vocal/yaml-lite.mjs';
import { buildResamplerArgs } from '../../../src/vocal/resampler.mjs';
import { loadVoicebank } from '../../../src/vocal/oto.mjs';
import { renderUstx } from '../../../src/vocal/render.mjs';
import { writeWavMono16, readWav } from '../../../src/vocal/wav.mjs';
import { encodePitchesInt12 } from '../../../src/vocal/resampler.mjs';

const work = mkdtempSync(join(tmpdir(), 'videograph-vocal-render-'));
after(() => rmSync(work, { recursive: true, force: true }));

// 假重采样器：契约第 7 参是 durRequired（ms），写出对应长度的正弦 WAV；参数落 sidecar JSON。
const stubPath = join(work, 'fake-resampler.mjs');
writeFileSync(stubPath, `
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
const [input, output, toneName, velocity, flags, offset, duration, consonant, cutoff, volume, modulation, tempoMark, pitches] = a;
const ms = Math.max(1, parseInt(duration, 10) || 1);
const frames = Math.round(44100 * ms / 1000);
const buf = Buffer.alloc(44 + frames * 2);
buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + frames * 2, 4); buf.write('WAVE', 8, 'ascii');
buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(88200, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36, 'ascii'); buf.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 44100) * 16000), 44 + i * 2);
writeFileSync(output, buf);
writeFileSync(output + '.args.json', JSON.stringify({
  input, output, toneName, velocity, flags, offset, duration, consonant, cutoff, volume, modulation,
  tempoMark, pitches, pitchesLen: pitches?.length ?? 0,
}));
`, 'utf8');

function makeBank() {
  const bankDir = join(work, 'bank');
  mkdirSync(bankDir, { recursive: true });
  writeWavMono16(join(bankDir, 'a.wav'), sine(0.4, 220));
  writeWavMono16(join(bankDir, 'i.wav'), sine(0.4, 330));
  writeFileSync(join(bankDir, 'character.txt'), 'name=テスト音源\n', 'utf8');
  writeFileSync(join(bankDir, 'oto.ini'), 'a.wav=あ,100,300,-100,50,30\ni.wav=い,80,250,-80,40,20\n', 'utf8');
  return bankDir;
}

function sine(seconds, hz) {
  const n = Math.round(44100 * seconds);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * hz * i / 44100) * 0.8;
  return s;
}

const plan = {
  name: '端到端',
  tempo: 120, // 一拍 500ms
  tracks: [{ singer: 'テスト音源' }],
  parts: [{
    notes: [
      { lyric: 'あ', pitch: 'C4', startBeats: 0, durationBeats: 0.5 },
      { lyric: 'い', pitch: 'D4', startBeats: 0.5, durationBeats: 0.5 },
      { lyric: 'R', pitch: 'C4', startBeats: 1, durationBeats: 0.25 },
      { lyric: 'あ', pitch: 'G4', startBeats: 1.25, durationBeats: 1 },
    ],
  }],
};

test('encodePitchesInt12：游程压缩 + 解码往返（含负数回绕与极值）', () => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // 独立解码器：pair → 12-bit 无符号 → 有符号；#n# 表示前一个 pair 再重复 n 次（新值紧跟其后）
  const decode = (s) => {
    const values = [];
    let lastPair = null;
    let i = 0;
    while (i < s.length) {
      if (s[i] === '#') {
        const end = s.indexOf('#', i + 1);
        const run = parseInt(s.slice(i + 1, end), 10);
        for (let k = 0; k < run; k++) values.push(lastPair);
        i = end + 1;
      } else {
        lastPair = s.slice(i, i + 2);
        values.push(lastPair);
        i += 2;
      }
    }
    return values.map((pair) => {
      const v = ALPHABET.indexOf(pair[0]) * 64 + ALPHABET.indexOf(pair[1]);
      return v >= 2048 ? v - 4096 : v;
    });
  };
  assert.equal(encodePitchesInt12([0]), 'AA');
  assert.equal(encodePitchesInt12([0, 0, 0]), 'AA#2#');
  const samples = [0, 0, 100, 100, -50, 0, 2047, -2048, -2048];
  assert.deepEqual(decode(encodePitchesInt12(samples)), samples);
  assert.deepEqual(decode(encodePitchesInt12([0, 0, 0])), [0, 0, 0]);
  assert.equal(encodePitchesInt12([]), '');
});

test('buildResamplerArgs：classic 11 参 / openutau 13 参（!tempo + base64 音高）', () => {
  const item = {
    inputWav: 'in.wav', outputWav: 'out.wav', tone: 60, velocity: 100, flags: '',
    offsetMs: 10, durationMs: 290, consonantMs: 30, cutoffMs: -80, volume: 100,
    modulation: 0, tempo: 120, pitches: [0, 0, 0], contract: 'classic',
  };
  const classic = buildResamplerArgs(item);
  assert.equal(classic.length, 11);
  assert.equal(classic[2], 'C4');
  assert.equal(classic[6], '290');
  assert.equal(classic[8], '-80');
  const openutau = buildResamplerArgs({ ...item, contract: 'openutau' });
  assert.equal(openutau.length, 13);
  assert.equal(openutau[11], '!120');
  assert.equal(openutau[12], encodePitchesInt12([0, 0, 0]));
});

test('端到端：假重采样器契约形状与产物时长', async () => {
  const bankDir = makeBank();
  const bank = loadVoicebank(bankDir);
  const outWav = join(work, 'out', 'vocal.wav');
  const result = await renderUstx({
    ustxText: serializeUstx(buildUstx(plan)),
    resampler: ['node', stubPath],
    outWav,
    voicebank: bank,
    workDir: join(work, 'work'),
  });
  assert.equal(result.noteCount, 3);           // R 休止被跳过
  assert.equal(result.skippedCount, 1);
  assert.equal(result.tempo, 120);
  assert.ok(existsSync(outWav), '成品 WAV 存在');

  // 契约：第 1 个音符 あ，durRequired = 250ms(0.5拍) + overlap 30 + 余量 10 = 290
  const call1 = JSON.parse(readFileSync(join(work, 'work', 'note-0000.wav.args.json'), 'utf8'));
  assert.equal(call1.toneName, 'C4');
  assert.equal(call1.velocity, '100');
  assert.equal(call1.offset, '100');
  assert.equal(call1.duration, '350'); // durRequired = max(250, consonant 300) → 50ms 网格取整 350
  assert.equal(call1.consonant, '300');
  assert.equal(call1.cutoff, '-100');
  assert.equal(call1.volume, '100');
  assert.equal(call1.tempoMark, undefined); // classic 契约（默认）：没有 tempo 段
  assert.equal(call1.pitchesLen, 0);        // 平直音高省略音高弯曲参（桩对缺参记 0）
  assert.ok(call1.input.endsWith('a.wav'));

  // 产物：末音符起点 = 1.25拍*500 - preutter50 = 575ms；durRequired = max(500,300) → 网格取整 550ms
  const wav = readWav(outWav);
  assert.equal(wav.sampleRate, 44100);
  assert.equal(wav.channels, 1);
  const expected = Math.round(1125 * 44100 / 1000);
  assert.ok(Math.abs(wav.samples.length - expected) < expected * 0.02, `时长 ${wav.samples.length} ≈ ${expected}`);
  // 有真实音频内容（正弦），不是全静音
  const peak = wav.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak > 0.1, `峰值 ${peak} > 0.1`);
});

test('渲染缓存：同参数第二次渲染全部命中，不再调用重采样器', async () => {
  const bank = loadVoicebank(makeBank());
  const ustxText = serializeUstx(buildUstx(plan));
  const cacheDir = join(work, 'note-cache');
  const first = await renderUstx({
    ustxText, resampler: ['node', stubPath], outWav: join(work, 'cache1.wav'),
    voicebank: bank, workDir: join(work, 'cwork1'), cacheDir,
  });
  assert.deepEqual(first.cacheSummary, { hits: 0, misses: 3 });
  const cachedFiles = readdirSync(cacheDir).filter((f) => f.startsWith('res-'));
  assert.equal(cachedFiles.length, 3);
  const second = await renderUstx({
    ustxText, resampler: ['node', stubPath], outWav: join(work, 'cache2.wav'),
    voicebank: bank, workDir: join(work, 'cwork2'), cacheDir,
  });
  assert.deepEqual(second.cacheSummary, { hits: 3, misses: 0 });
  // 两次产物逐字节一致（缓存复用不改变结果）
  assert.deepEqual(
    readFileSync(join(work, 'cache1.wav')),
    readFileSync(join(work, 'cache2.wav')),
  );
  // 换 tempo 改变 !tempo/音高采样参数 → openutau 契约下会换键；classic 下 tempo 不入参，仍命中
  const higherTempo = serializeUstx(buildUstx({ ...plan, tempo: 121 }));
  const third = await renderUstx({
    ustxText: higherTempo, resampler: ['node', stubPath], outWav: join(work, 'cache3.wav'),
    voicebank: bank, workDir: join(work, 'cwork3'), cacheDir,
  });
  assert.deepEqual(third.cacheSummary, { hits: 3, misses: 0 }); // classic 契约无 tempo 段，键不变
});

test('端到端：未知别名给出可操作报错（含别名样例）', async () => {
  const bank = loadVoicebank(makeBank());
  const bad = buildUstx({
    tracks: [{}],
    parts: [{ notes: [{ lyric: 'ノ', pitch: 'C4', startBeats: 0, durationBeats: 1 }] }],
  });
  await assert.rejects(
    () => renderUstx({
      ustxText: serializeUstx(bad),
      resampler: ['node', stubPath],
      outWav: join(work, 'bad.wav'),
      voicebank: bank,
      workDir: join(work, 'work2'),
    }),
    (err) => /没有别名 "ノ"/.test(err.message) && /あ/.test(err.message),
  );
});

test('端到端：多 part、缺 resampler、全休止均被拒绝', async () => {
  const bank = loadVoicebank(makeBank());
  // 合法的双 part USTX（过结构自检，命中 M1 单 part 限制）
  const minimalNote = (position) => ({
    position, duration: 480, tone: 60, lyric: 'あ',
    pitch: { data: [{ x: 0, y: 0, shape: 'io' }], snap_first: true },
    vibrato: { length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0 },
  });
  const multi = {
    ustx_version: '0.10',
    tempos: [{ position: 0, bpm: 120 }],
    time_signatures: [{ bar_position: 0, beat_per_bar: 4, beat_unit: 4 }],
    tracks: [{ singer: 'テスト音源' }],
    expressions: Object.fromEntries(STANDARD_EXPRESSIONS.map((e) => [e.abbr, e])),
    voice_parts: [
      { track_no: 0, position: 0, duration: 480, notes: [minimalNote(0)] },
      { track_no: 0, position: 960, duration: 480, notes: [minimalNote(0)] },
    ],
  };
  await assert.rejects(() => renderUstx({
    ustxText: emitYaml(multi), resampler: ['node', stubPath], outWav: 'x.wav',
    voicebank: bank, workDir: join(work, 'w3'),
  }), /单 voice_part/);

  const ustx = serializeUstx(buildUstx(plan));
  await assert.rejects(() => renderUstx({
    ustxText: ustx, resampler: null, outWav: 'x.wav', voicebank: bank, workDir: join(work, 'w4'),
  }), /重采样器/);

  const restOnly = buildUstx({
    tracks: [{}],
    parts: [{ notes: [{ lyric: 'R', pitch: 'C4', startBeats: 0, durationBeats: 1 }] }],
  });
  await assert.rejects(() => renderUstx({
    ustxText: serializeUstx(restOnly), resampler: ['node', stubPath], outWav: 'x.wav',
    voicebank: bank, workDir: join(work, 'w5'),
  }), /没有可渲染的音符/);
});

// CLI 测试：真实进程调用 src/vocal/cli.mjs，断言退出码与产物（check/make-ustx/check-ustx/make-ust/render）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeWavMono16 } from '../../../src/vocal/wav.mjs';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'vocal', 'cli.mjs');
const work = mkdtempSync(join(tmpdir(), 'videograph-vocal-cli-'));
after(() => rmSync(work, { recursive: true, force: true }));

// 干净环境：擦掉本机可能存在的 vocal 配置变量，但保留 Windows 子进程所需的系统变量
const cleanEnv = (() => {
  const e = { ...process.env };
  delete e.VIDEOGRAPH_OPENUTAU_HOME;
  delete e.VIDEOGRAPH_OPENUTAU_RESAMPLER;
  delete e.VIDEOGRAPH_VOICEBANK_DIR;
  return e;
})();

const run = async (cliArgs, extraEnv = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...cliArgs], {
      cwd: work,
      env: { ...cleanEnv, ...extraEnv },
      encoding: 'utf8',
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message) };
  }
};

// 假重采样器：与 render.test.mjs 同款契约桩
const stubPath = join(work, 'stub.mjs');
writeFileSync(stubPath, `
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
const [input, output, , , , , duration] = a;
const ms = Math.max(1, parseInt(duration, 10) || 1);
const frames = Math.round(44100 * ms / 1000);
const buf = Buffer.alloc(44 + frames * 2);
buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + frames * 2, 4); buf.write('WAVE', 8, 'ascii');
buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(88200, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36, 'ascii'); buf.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * i / 44100) * 14000), 44 + i * 2);
writeFileSync(output, buf);
`, 'utf8');

const plan = {
  name: 'CLI 测试',
  tempo: 120,
  tracks: [{ singer: 'CLI 音源' }],
  parts: [{
    notes: [
      { lyric: 'あ', pitch: 'C4', startBeats: 0, durationBeats: 1 },
      { lyric: 'い', pitch: 'D4', startBeats: 1, durationBeats: 1 },
    ],
  }],
};
const planPath = join(work, 'plan.json');
writeFileSync(planPath, JSON.stringify(plan), 'utf8');

test('check --json：无配置时退出码 2，报告缺项与配置示例，且不泄露真实路径', async () => {
  const { code, stdout } = await run(['check', '--json']);
  assert.equal(code, 2);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, false);
  assert.ok(report.missing.includes('resampler'));
  assert.ok(report.missing.includes('voicebankDir'));
  assert.ok(report.example.env.VIDEOGRAPH_OPENUTAU_RESAMPLER);
  assert.equal(JSON.stringify(report).includes('Martis'), false);
});

test('make-ustx → check-ustx → make-ust：全链退出码与产物', async () => {
  const ustxPath = join(work, 'song.ustx');
  const made = await run(['make-ustx', '--plan', planPath, '--out', ustxPath, '--json']);
  assert.equal(made.code, 0, made.stderr);
  assert.equal(JSON.parse(made.stdout).notes, 2);
  assert.ok(existsSync(ustxPath));

  const checked = await run(['check-ustx', '--ustx', ustxPath, '--json']);
  assert.equal(checked.code, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).ok, true);

  const ustPath = join(work, 'song.ust');
  const ust = await run(['make-ust', '--ustx', ustxPath, '--out', ustPath]);
  assert.equal(ust.code, 0, ust.stderr);
  const ustText = readFileSync(ustPath.replace('.ustx', '.ust'), 'utf8');
  assert.match(ustText, /Lyric=あ/);

  const bad = await run(['check-ustx', '--ustx', planPath, '--json']); // 拿 plan JSON 冒充 USTX
  assert.equal(bad.code, 3);
});

test('render：--resampler argv 数组 + --bank 走通，退出码 0', async () => {
  const bankDir = join(work, 'bank');
  mkdirSync(bankDir, { recursive: true });
  const tone = new Float32Array(44100).map((_, i) => Math.sin(2 * Math.PI * 220 * i / 44100) * 0.8);
  writeWavMono16(join(bankDir, 'a.wav'), tone);
  writeWavMono16(join(bankDir, 'i.wav'), tone);
  writeFileSync(join(bankDir, 'character.txt'), 'name=CLI 音源\n', 'utf8');
  writeFileSync(join(bankDir, 'oto.ini'), 'あ=a.wav,100,300,200,-100,50,30\nい=i.wav,100,300,200,-100,50,30\n', 'utf8');

  const ustxPath = join(work, 'song.ustx');
  await run(['make-ustx', '--plan', planPath, '--out', ustxPath]);
  const outWav = join(work, 'cli-vocal.wav');
  const { code, stdout, stderr } = await run([
    'render', '--ustx', ustxPath, '--out', outWav, '--json',
    '--bank', bankDir,
    '--resampler', JSON.stringify(['node', stubPath]),
    '--work-dir', join(work, 'cli-work'),
  ]);
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.noteCount, 2);
  assert.equal(report.bank.name, 'CLI 音源');
  assert.ok(existsSync(outWav));
});

test('render：缺配置退出码 2；未知命令退出码 3', async () => {
  const ustxPath = join(work, 'song.ustx');
  const { code, stderr } = await run(['render', '--ustx', ustxPath, '--out', join(work, 'x.wav'), '--json']);
  assert.equal(code, 2);
  assert.match(stderr, /配置缺失/);
  const unknown = await run(['nope']);
  assert.equal(unknown.code, 3);
});

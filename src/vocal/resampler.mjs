// resampler.mjs — 经典重采样器命令行契约调用（VOCAL-M1）。
// 契约对齐 openutau/OpenUtau Classic/ExeResampler.cs（2026-10-06 核对）：
//   <input> <output> <音名> <velocity> <flags> <offset> <durRequired> <consonant> <cutoff> <volume> <modulation> !<tempo> <base64pitches>
// 音名 = MusicMath.GetToneName（C4=60）；base64pitches = int12 音分数组（Base64.Base64EncodeInt12，带 `#次数#` 游程压缩）。
// resampler 配置：exe 路径字符串，或 argv 头数组（["node","stub.mjs"]，包装脚本/测试用）。
// 坑位备忘：.bat/.cmd 不能被 execFile 直接执行，请用 exe 或 argv 头数组包一层。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { toneToName } from './ustx.mjs';

const PITCH_CADENCE_MS = 5; // 音高数组采样密度（与 OpenUtau 渲染粒度一致的近似，M2 精确对齐）

/** Base64.Base64EncodeInt12 的 Node 实现：12-bit 有符号 → 两个 base64 字符 + `#次数#` 游程压缩。 */
export function encodePitchesInt12(pitches) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const encodeOne = (value) => {
    let v = Math.round(value);
    if (!Number.isFinite(v)) v = 0;
    v = Math.max(-2048, Math.min(2047, v));
    if (v < 0) v += 4096;
    return ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63];
  };
  let out = '';
  let last = null;
  let dups = 0;
  for (const p of pitches) {
    const b = encodeOne(p);
    if (last === b) dups++;
    else if (dups === 0) out += b;
    else { out += `#${dups}#${b}`; dups = 0; }
    last = b;
  }
  if (dups !== 0) out += `#${dups}#`;
  return out;
}

/** 平直音高 → 全 0 音分数组（M1 无音高曲线渲染时的近似；pitchCurve 支持属 M2）。 */
export function flatPitches(durationMs, cadenceMs = PITCH_CADENCE_MS) {
  return new Array(Math.max(1, Math.ceil(durationMs / cadenceMs) + 1)).fill(0);
}

/**
 * 按契约调用一次重采样器。
 * item: { resampler, inputWav, outputWav, tone, velocity=100, flags='', offsetMs=0,
 *         durationMs=0, consonantMs=0, cutoffMs=0, volume=100, modulation=0, tempo=120, pitches=[] }
 * 输出文件不存在视为失败（契约要求重采样器写出文件）。
 */
export function callResampler(item, { timeoutMs = 120_000 } = {}) {
  const args = [
    item.inputWav,
    item.outputWav,
    item.tone < 0 ? '' : toneToName(item.tone),
    String(item.velocity ?? 100),
    item.flags ?? '',
    String(Math.round(item.offsetMs ?? 0)),
    String(Math.round(item.durationMs ?? 0)),
    String(Math.round(item.consonantMs ?? 0)),
    String(Math.round(item.cutoffMs ?? 0)),
    String(Math.round(item.volume ?? 100)),
    String(Math.round(item.modulation ?? 0)),
    `!${item.tempo ?? 120}`,
    encodePitchesInt12(item.pitches ?? []),
  ];
  const argvHead = Array.isArray(item.resampler) ? item.resampler : [item.resampler];
  return new Promise((resolve, reject) => {
    execFile(argvHead[0], [...argvHead.slice(1), ...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`重采样器执行失败（${argvHead.join(' ')}）：${err.message}\nstdout: ${stdout ?? ''}\nstderr: ${stderr ?? ''}`));
        return;
      }
      if (!existsSync(item.outputWav)) {
        reject(new Error(`重采样器未产出输出文件 ${item.outputWav}\nstdout: ${stdout ?? ''}\nstderr: ${stderr ?? ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

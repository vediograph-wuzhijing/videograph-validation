// wav.mjs — 16-bit PCM WAV 读写（VOCAL-M1）。M1 管线内部统一 44100Hz 单声道；
// 读入兼容多声道与 24/32f（混到 mono），写出固定 mono 16-bit（与 OpenUtau Wave.WriteMono16Wav 一致）。
import { readFileSync, writeFileSync } from 'node:fs';
import { UstxError } from './ustx.mjs';

const fail = (message) => { throw new UstxError(message); };

const SAMPLE_RATE = 44100;

function findChunk(view, fourcc, startOffset) {
  let offset = startOffset;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    const size = view.getUint32(offset + 4, true);
    if (id === fourcc) return { offset: offset + 8, size };
    offset += 8 + size + (size % 2); // chunk 按 2 字节对齐
  }
  return null;
}

/**
 * 读 WAV → { sampleRate, channels, samples: Float32Array }（样本归一到 [-1, 1]，多声道已混单声道）。
 * 支持 PCM 8/16/24/32int 与 32f；其他格式明确报错。
 */
export function readWav(path) {
  const buffer = readFileSync(path);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.length < 44
    || String.fromCharCode(...buffer.subarray(0, 4)) !== 'RIFF'
    || String.fromCharCode(...buffer.subarray(8, 12)) !== 'WAVE') {
    fail(`不是 WAV 文件: ${path}`);
  }
  const fmt = findChunk(view, 'fmt ', 12);
  if (!fmt || fmt.size < 16) fail(`WAV 缺 fmt 块: ${path}`);
  const audioFormat = view.getUint16(fmt.offset, true);
  const channels = view.getUint16(fmt.offset + 2, true);
  const sampleRate = view.getUint32(fmt.offset + 4, true);
  const bitsPerSample = view.getUint16(fmt.offset + 14, true);
  const data = findChunk(view, 'data', 12);
  if (!data) fail(`WAV 缺 data 块: ${path}`);

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(data.size / (bytesPerSample * channels));
  const samples = new Float32Array(frameCount);
  let dataOffset = data.offset;
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const pos = dataOffset + (i * channels + ch) * bytesPerSample;
      let v = 0;
      if (audioFormat === 3 && bitsPerSample === 32) v = view.getFloat32(pos, true);
      else if (bitsPerSample === 8) v = (view.getUint8(pos) - 128) / 128;
      else if (bitsPerSample === 16) v = view.getInt16(pos, true) / 32768;
      else if (bitsPerSample === 24) {
        const b0 = view.getUint8(pos), b1 = view.getUint8(pos + 1), b2 = view.getUint8(pos + 2);
        let int24 = (b2 << 16) | (b1 << 8) | b0;
        if (int24 & 0x800000) int24 -= 0x1000000;
        v = int24 / 8388608;
      } else if (bitsPerSample === 32) v = view.getInt32(pos, true) / 2147483648;
      else fail(`不支持的位深 ${bitsPerSample}: ${path}`);
      sum += v;
    }
    samples[i] = sum / channels;
  }
  return { sampleRate, channels, samples };
}

/** 写 16-bit 单声道 WAV。 */
export function writeWavMono16(path, samples, sampleRate = SAMPLE_RATE) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  writeFileSync(path, buffer);
  return { path, sampleRate, channels: 1, samples: samples.length };
}

/** 简单线性重采样（M1 兜底；重采样器输出统一 44100 时不会走到）。 */
export function resampleLinear(samples, fromRate, toRate = SAMPLE_RATE) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.round(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    out[i] = (samples[i0] ?? 0) * (1 - frac) + (samples[i0 + 1] ?? 0) * frac;
  }
  return out;
}

export const WAV_SAMPLE_RATE = SAMPLE_RATE;

// wavtool.mjs — 片段拼接：重叠相加 + 线性交叠淡化（VOCAL-M1）。
// 参考实现：openutau/OpenUtau Classic/SharpWavtool.cs 的 simple 模式（无相位补偿）。
// 语义：片段放在 (音符起点 - preutter) 处；相邻片段在 overlap 区间交叠，线性淡入淡出压 clicks。
// 相位精确对齐（head/tail window、correction）属 M2——M1 只保证位置与时长正确、交叠不爆音。

/**
 * segments: [{ samples: Float32Array, startSample: int, fadeInSamples?: int, fadeOutSamples?: int }]
 * 返回拼好的 Float32Array（44100Hz 单声道语义由调用方约定）。
 */
export function concatenate(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return new Float32Array(0);
  const total = segments.reduce((max, s) => Math.max(max, s.startSample + s.samples.length), 0);
  const out = new Float32Array(total);
  for (const segment of segments) {
    const fadeIn = Math.max(0, segment.fadeInSamples ?? 0);
    const fadeOut = Math.max(0, segment.fadeOutSamples ?? 0);
    const n = segment.samples.length;
    for (let i = 0; i < n; i++) {
      let gain = 1;
      if (fadeIn > 0 && i < fadeIn) gain *= i / fadeIn;
      if (fadeOut > 0 && i >= n - fadeOut) gain *= (n - i) / fadeOut;
      out[segment.startSample + i] += segment.samples[i] * gain;
    }
  }
  return out;
}

/** 休止段清零辅助：返回长度 length 的静音段。 */
export function silence(length) {
  return new Float32Array(Math.max(0, length));
}

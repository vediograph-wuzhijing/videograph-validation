// @ts-check
// Clip temporal taps to the frame's hard-cut interval. Non-cut transitions stay continuous.
/** @typedef {{ id: string, start: number, end: number }} ShotWindow */
/** @typedef {{ toShotId: string, mode?: string, duration?: number }} CutTransition */
/** @param {ReadonlyArray<ShotWindow>} shots @param {ReadonlyArray<CutTransition>} [transitions] @param {number} [fps] */
export function hardCutBounds(shots, transitions = [], fps = 30) {
  /** @param {number} t */
  const align = (t) => Math.round(t * fps) / fps;
  const ordered = [...shots].sort((a, b) => a.start - b.start);
  const bounds = [Math.max(0, align(ordered[0]?.start ?? 0))];
  for (const shot of ordered.slice(1)) {
    const incoming = transitions.find((t) => t.toShotId === shot.id);
    if (!incoming || incoming.mode === 'cut' || incoming.duration === 0) bounds.push(align(shot.start));
  }
  bounds.push(align(Math.max(0, ...shots.map((s) => s.end))));
  return [...new Set(bounds)].sort((a, b) => a - b);
}
/** @param {number} frameTime @param {number} sampleTime @param {ReadonlyArray<number>} boundaries */
export function clampShutterSample(frameTime, sampleTime, boundaries) {
  if (boundaries.length < 2) return Math.max(0, sampleTime);
  let lo = 0, hi = boundaries.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (boundaries[mid] <= frameTime + 1e-10) lo = mid; else hi = mid; }
  return Math.max(boundaries[lo], Math.min(sampleTime, boundaries[hi] - 1e-9));
}
/** @param {string} code @param {ReadonlyArray<number>} bounds */
export function patchEngineShutter(code, bounds) {
  const tap = 'const res = this.composite(Math.max(0, t + dt * shutter * u), step, seeked && k === 0);';
  const state = 'let nearest = Infinity;';
  if (!code.includes(tap) || !code.includes(state)) throw new Error('引擎子帧接口不兼容：无法安装硬切边界保护');
  // Repeated clamped taps must not advance stateful simulations at the same time.
  const replacement = `const vgTap = vgClampShutterSample(t, t + dt * shutter * u, ${JSON.stringify(bounds)});
        const vgStep = vgPreviousTap !== undefined && Math.abs(vgTap - vgPreviousTap) < 1e-10 ? 0 : step;
        vgPreviousTap = vgTap;
        const res = this.composite(vgTap, vgStep, seeked && k === 0);`;
  return `${code.replace(state, `${state}\nlet vgPreviousTap;`).replace(tap, replacement)}\nconst vgClampShutterSample = ${clampShutterSample.toString()};\n`;
}

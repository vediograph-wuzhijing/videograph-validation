import test from 'node:test';
import assert from 'node:assert/strict';
import { hardCutBounds, clampShutterSample, patchEngineShutter } from '../../../src/server/shutter.mjs';

test('33个硬切在1/4/12采样及不同shutter下不混入相邻镜头', () => {
  const fps = 30, shots = Array.from({ length: 34 }, (_, i) => ({ id: String(i), start: i, end: i + 1 }));
  const bounds = hardCutBounds(shots, [], fps);
  for (let cut = 1; cut <= 33; cut++) for (const n of [1, 4, 12]) for (const shutter of [0.5, 1]) for (const t of [cut - 1 / fps, cut, cut + 1 / fps]) {
    const expected = Math.floor(t + 1e-10);
    for (let k = 0; k < n; k++) {
      const sample = clampShutterSample(t, t + shutter / fps * ((k + 0.5) / n - 0.5), bounds);
      assert.equal(Math.floor(sample), expected, `cut=${cut} samples=${n} t=${t} tap=${sample}`);
    }
  }
});
test('dissolve/wipe期间保留跨边界时间采样，普通帧也不改变采样', () => {
  const shots = [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 1, end: 2 }, { id: 'c', start: 2, end: 3 }];
  for (const mode of ['dissolve', 'wipe']) {
    const bounds = hardCutBounds(shots, [{ toShotId: 'b', mode, duration: 0.3 }]);
    assert.equal(clampShutterSample(1, 0.99, bounds), 0.99);
    assert.equal(clampShutterSample(1.5, 1.49, bounds), 1.49);
    assert.ok(clampShutterSample(2, 1.99, bounds) >= 2);
  }
});
test('不兼容的引擎明确报错，不能静默漏装补丁', () => {
  assert.throws(() => patchEngineShutter('unknown engine', [0, 1]), /不兼容/);
});

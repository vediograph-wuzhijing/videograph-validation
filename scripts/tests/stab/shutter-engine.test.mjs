// GPU/reference-engine regression: actual colour output and temporal taps around 33 cuts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startReferenceServer } from '../../../src/server/reference-server.mjs';
import { browserPath, angleArgs } from '../../../src/server/browser.mjs';

test('真实引擎33个cut：1/4/12子帧输出无跨镜叠影；dissolve仍可混合', { timeout: 180000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'videograph-shutter-')), reference = resolve('..', 'pdoom-video');
  let server, browser;
  try {
    mkdirSync(join(root, 'app/src/scenes'), { recursive: true });
    cpSync(join(reference, 'app/src/engine'), join(root, 'app/src/engine'), { recursive: true });
    cpSync(join(reference, 'app/public'), join(root, 'app/public'), { recursive: true });
    cpSync(join(reference, 'data'), join(root, 'data'), { recursive: true });
    copyFileSync(join(reference, 'app/src/main.ts'), join(root, 'app/src/main.ts'));
    copyFileSync(join(reference, 'app/index.html'), join(root, 'app/index.html'));
    writeFileSync(join(root, 'app/src/timeline.ts'), 'export function makeTimeline() { return []; }');
    for (const [name, colour] of [['red', [0.4, 0, 0]], ['blue', [0, 0, 0.4]]]) writeFileSync(join(root, `app/src/scenes/${name}.ts`), `
      import {Scene} from '../engine/scene'; import {clearRT} from '../engine/gl';
      export default class extends Scene { render(f,out) { clearRT(this.ctx.renderer,out,${JSON.stringify(colour)}); return {bloom:0,halation:0,grain:0,ca:0,vignette:0,hud:0}; } }`);
    const shots = Array.from({ length: 34 }, (_, i) => ({ id: String(i), start: i, end: i + 1, module: i % 2 ? 'blue' : 'red' }));
    server = await startReferenceServer({ root, shots, fps: 30 });
    browser = await chromium.launch({ headless: true, executablePath: browserPath(), args: [...angleArgs(), '--ignore-gpu-blocklist'] });
    const page = await browser.newPage();
    await page.goto(server.url + '/?export=1');
    await page.waitForFunction(() => window.__pdoom?.ready || window.__pdoom?.error, { timeout: 45000 });
    const results = await page.evaluate(async () => {
      const { engine, width, height } = window.__pdoom, output = [];
      let taps = []; const original = engine.composite.bind(engine);
      engine.composite = (...args) => { taps.push({ time: args[0], dt: args[1] }); return original(...args); };
      for (let cut = 1; cut <= 33; cut++) for (const t of [cut - 1 / 30, cut, cut + 1 / 30]) for (const samples of [1, 4, 12]) {
        taps = []; engine.render(t, 1 / 30, false, samples, 1);
        const px = await engine.readPixelsAsync(), offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
        output.push({ cut, t, samples, taps, pixel: Array.from(px.subarray(offset, offset + 4)) });
      }
      return { output, errors: window.__pdoom.errors };
    });
    assert.deepEqual(results.errors, []);
    for (const row of results.output) {
      const shot = Math.floor(row.t + 1e-10), dominant = shot % 2 ? 2 : 0, other = shot % 2 ? 0 : 2;
      assert.ok(row.pixel[dominant] > 100 && row.pixel[other] < 3, JSON.stringify(row));
      assert.ok(row.taps.every(({ time }) => time >= shot && time < shot + 1), JSON.stringify(row));
      for (let i = 1; i < row.taps.length; i++) if (row.taps[i].time === row.taps[i - 1].time) assert.equal(row.taps[i].dt, 0, '重复边界子帧不能重复推进stateful场景');
    }
    await server.close(); server = await startReferenceServer({ root, shots: shots.slice(0, 2), transitions: [{ id: 'd', fromShotId: '0', toShotId: '1', mode: 'dissolve', duration: 0.5, easing: 'linear' }], fps: 30 });
    await page.goto(server.url + '/?export=1');
    await page.waitForFunction(() => window.__pdoom?.ready || window.__pdoom?.error);
    const blend = await page.evaluate(async () => {
      const { engine, width, height } = window.__pdoom; engine.render(1.25, 1 / 30, false, 12, 1);
      const px = await engine.readPixelsAsync(), offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
      return Array.from(px.subarray(offset, offset + 4));
    });
    assert.ok(blend[0] > 50 && blend[2] > 50, `dissolve remains blended: ${blend}`);
  } finally {
    await browser?.close(); await server?.close(); rmSync(root, { recursive: true, force: true });
  }
});

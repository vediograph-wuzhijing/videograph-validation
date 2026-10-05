// preview-worker.mjs — 特效箱的无头渲染：帧序列图（effect_preview / 示例脚本）与质量闸门（check-box）。
// 起一个只服务 runtime.mjs 的临时本机 HTTP 服务 + 无头 Edge；同一份 src/fx/runtime.mjs 也被审阅室前端使用。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserPath, angleArgs } from '../browser.mjs';
import { withTimeout } from '../render-cache.mjs';

const runtimePath = fileURLToPath(new URL('../../fx/runtime.mjs', import.meta.url));
const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><script type="module">
import * as fx from '/runtime.mjs'; window.__fx = fx; window.__fxReady = true;
</script></body>`;

export async function withFxBrowser(work, { timeoutMs = 180000 } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/runtime.mjs') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(readFileSync(runtimePath)); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: browserPath(), args: [...angleArgs(), '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__fxReady === true, null, { timeout: 30000 });
    // GLSL 把 GPU 卡死时 evaluate 可能不返回：整体超时后关浏览器，MCP 调用不会永久挂住。
    return await withTimeout(work(page), timeoutMs, () => { void browser.close(); return new Error(`特效预览 ${Math.round(timeoutMs / 1000)} 秒内未完成（着色器可能卡住 GPU）`); });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 页面内：渲染一个动效的若干帧并拼成网格（标注时间与拍相位），返回 PNG base64。 */
async function pageFilmstrip({ effect, values, source, toSource, times, width, columns, title }) {
  const fx = window.__fx;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = Math.round(width * 9 / 16);
  const previewer = new fx.EffectPreviewer(canvas);
  const labelH = 22, gap = 6, header = 30;
  const rows = Math.ceil(times.length / columns);
  const sheet = document.createElement('canvas');
  sheet.width = columns * width + (columns + 1) * gap;
  sheet.height = header + rows * (canvas.height + labelH + gap) + gap;
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#111317'; ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.fillStyle = '#eceef2'; ctx.font = '15px "Microsoft YaHei", sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText(title, gap + 4, header / 2 + 2);
  times.forEach((t, i) => {
    const progress = effect.kind === 'transition' ? i / Math.max(1, times.length - 1) : undefined;
    previewer.render(effect, { values, t, source, toSource, progress });
    const x = gap + (i % columns) * (width + gap), y = header + gap + Math.floor(i / columns) * (canvas.height + labelH + gap);
    ctx.drawImage(canvas, x, y);
    const clock = fx.beatClock(t);
    ctx.fillStyle = clock.beat < 0.12 ? '#f3b04a' : '#9aa0aa'; ctx.font = '12px Consolas, monospace'; ctx.textBaseline = 'top';
    ctx.fillText(progress !== undefined ? `progress ${progress.toFixed(2)}` : `${t.toFixed(2)}s  拍相位 ${clock.beat.toFixed(2)}${clock.beat < 0.12 ? ' ●鼓点' : ''}`, x + 2, y + canvas.height + 4);
  });
  return sheet.toDataURL('image/png').split(',')[1];
}

/** 页面内：质量闸门。编译、渲染合理性（非全黑/非 NaN/与原图有差异）、2 秒内闪烁频率。 */
async function pageCheck({ effect }) {
  const fx = window.__fx;
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const result = { id: effect.id, ok: true, problems: [] };
  let previewer;
  try { previewer = new fx.EffectPreviewer(canvas); previewer.compile(effect); }
  catch (error) { return { ...result, ok: false, problems: [String(error.message ?? error)] }; }
  const gl = previewer.gl, px = new Uint8Array(320 * 180 * 4);
  const stats = () => { gl.readPixels(0, 0, 320, 180, gl.RGBA, gl.UNSIGNED_BYTE, px); let sum = 0, sq = 0; for (let i = 0; i < px.length; i += 4) { const l = (px[i] * .2126 + px[i + 1] * .7152 + px[i + 2] * .0722) / 255; sum += l; sq += l * l; } const n = px.length / 4; return { mean: sum / n, std: Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) }; };
  // 与“无效果”对比：同一帧的原图
  const identity = { id: '__identity', kind: 'post', params: {}, glsl: 'vec4 effect(vec2 uv) { return srcTex(uv); }' };
  const sources = effect.kind === 'transition' ? ['type'] : ['type', 'scene', 'shapes', 'portrait'];
  let differs = false;
  for (const source of sources) {
    // 转场取 25%/50%/75% 三个进度里最“有内容”的一帧（中途黑场是合法设计）
    let a = { mean: 0, std: 0 }, sample;
    for (const progress of effect.kind === 'transition' ? [0.25, 0.5, 0.75] : [undefined]) {
      previewer.render(effect, { t: 1.0, source, toSource: 'shapes', progress });
      const s = stats();
      if (!sample || s.std > a.std) { a = s; sample = px.slice(); }
    }
    if (!Number.isFinite(a.mean)) result.problems.push(`${source}: 输出含 NaN`);
    if (a.mean < 0.01 && a.std < 0.005) result.problems.push(`${source}: 输出几乎全黑`);
    if (a.mean > 0.995 && a.std < 0.005) result.problems.push(`${source}: 输出几乎全白`);
    previewer.render(identity, { t: 1.0, source });
    gl.readPixels(0, 0, 320, 180, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let diff = 0; for (let i = 0; i < px.length; i += 16) diff += Math.abs(px[i] - sample[i]); if (diff / (px.length / 16) > 2) differs = true;
  }
  if (!differs && effect.kind !== 'transition') result.problems.push('默认参数下与原图几乎无差别（若是纯节拍绑定动效，至少要在鼓点帧可见）');
  // 闪烁：2 秒 30fps 的全画面平均亮度，相反方向 ≥0.1（线性亮度近似）的变化成对计一次
  const lin = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const lumas = [];
  for (let f = 0; f < 60; f++) { previewer.render(effect, { t: 2 + f / 30, source: 'type', progress: effect.kind === 'transition' ? f / 59 : undefined }); lumas.push(lin(stats().mean)); }
  let last = 0, flashes = 0;
  for (let i = 1; i < lumas.length; i++) { const d = lumas[i] - lumas[i - 1]; if (Math.abs(d) >= 0.1) { const s = Math.sign(d); if (last && s !== last) flashes++; last = s; } }
  if (flashes / 2 > 3) result.problems.push(`闪烁 ${flashes / 2} 次/秒 > 3（光敏风险）`);
  result.flashesPerSecond = flashes / 2;
  result.ok = result.problems.length === 0;
  return result;
}

export async function renderFilmstrip(page, effect, { values = {}, source = 'type', toSource = 'scene', frames = 8, start = 0, duration = 2, width = 320, columns = 4 } = {}) {
  const times = Array.from({ length: frames }, (_, i) => start + (duration * i) / Math.max(1, frames - 1));
  return page.evaluate(pageFilmstrip, { effect, values, source, toSource, times, width, columns: Math.min(columns, frames), title: `${effect.name} · ${effect.id}${effect.kind === 'transition' ? ' · 转场' : ''}` });
}
export const checkEffect = (page, effect) => page.evaluate(pageCheck, { effect });

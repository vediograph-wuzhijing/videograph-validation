// media.mjs — AIGC 媒体 API 客户端（OpenAI Next 兼容：生图 / 参考图编辑 / Seedance 图生视频 / 语音合成）。
// 密钥读【当前工作目录】的 .env（CREDIT_MEDIA_API_KEY=… / API_BASE=…），不写进代码与日志；工作目录不要放在 git 仓库里。
// 每次请求与结果登记到 log/requests.jsonl（不含密钥），便于复查与复现。
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';

if (!existsSync('.env')) throw new Error('当前工作目录没有 .env：写入 CREDIT_MEDIA_API_KEY=… 与 API_BASE=… 后再运行（工作目录不要放在 git 仓库里）');
// 按首个 = 切分：base64 密钥、带查询参数的 URL 里的 = 不能丢。
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]; }));
const BASE = env.API_BASE, KEY = env.CREDIT_MEDIA_API_KEY;
if (!BASE || !KEY) throw new Error('.env 缺少 API_BASE 或 CREDIT_MEDIA_API_KEY');
const VIDEO_POLL_MS = 30 * 60 * 1000;
mkdirSync('log', { recursive: true });
const log = (o) => appendFileSync('log/requests.jsonl', JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, { timeout = 600000, raw = false } = {}) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${KEY}`, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    if (raw) { if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 400)}`); return Buffer.from(await res.arrayBuffer()); }
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400)}`);
    return data;
  } finally { clearTimeout(tm); }
}
/** 下载生成结果；非 2xx（CDN 错误页、链接过期）直接报错，避免写出一个之后永远不会重生成的假文件。 */
async function download(url, out) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${String(url).slice(0, 120)}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}
async function save(item, out) {
  mkdirSync(dirname(out), { recursive: true });
  if (item.b64_json) writeFileSync(out, Buffer.from(item.b64_json, 'base64'));
  else if (item.url) await download(item.url, out);
  else throw new Error('无图片数据：' + JSON.stringify(item).slice(0, 200));
  return out;
}
const b64img = (p) => `data:image/${p.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(p).toString('base64')}`;

/** 文生图；refs 有值时走 /v1/images/edits（参考图保持角色一致） */
export async function image({ prompt, out, model = 'gpt-image-2', size = '1536x1024', refs = [], quality }) {
  if (existsSync(out)) return out;
  const t0 = Date.now();
  let data;
  if (refs.length) {
    const fd = new FormData();
    fd.append('model', model); fd.append('prompt', prompt); fd.append('size', size); if (quality) fd.append('quality', quality);
    for (const r of refs) fd.append('image[]', new Blob([readFileSync(r)], { type: r.endsWith('.png') ? 'image/png' : 'image/jpeg' }), basename(r));
    data = await call('POST', '/v1/images/edits', fd);
  } else data = await call('POST', '/v1/images/generations', { model, prompt, size, n: 1, ...(quality ? { quality } : {}) });
  await save(data.data[0], out);
  log({ kind: 'image', model, size, refs, out, prompt, seconds: Math.round((Date.now() - t0) / 1000) });
  return out;
}

/** Seedance 图生视频：首帧图 + 文本，提交后轮询 */
export async function video({ prompt, out, first, last, model = 'doubao-seedance-2-0-260128', duration = 5, ratio = '16:9', resolution = '1080p', audio = false }) {
  if (existsSync(out)) return out;
  const content = [{ type: 'text', text: prompt }];
  if (first) content.push({ type: 'image_url', image_url: { url: b64img(first) }, role: 'first_frame' });
  if (last) content.push({ type: 'image_url', image_url: { url: b64img(last) }, role: 'last_frame' });
  const t0 = Date.now();
  const task = await call('POST', '/seedance/api/v3/contents/generations/tasks', { model, content, duration, ratio, resolution, generate_audio: audio, watermark: false });
  const id = task.id ?? task.task_id ?? task.data?.id;
  if (!id) throw new Error('视频任务提交后没有返回任务 ID：' + JSON.stringify(task).slice(0, 300));
  log({ kind: 'video-submit', model, id, out, prompt, first, last, duration, resolution });
  while (Date.now() - t0 < VIDEO_POLL_MS) {
    await sleep(8000);
    const r = await call('GET', `/seedance/api/v3/contents/generations/tasks/${id}`);
    const st = r.status ?? r.data?.status;
    if (st === 'succeeded') {
      const url = r.content?.video_url ?? r.data?.content?.video_url;
      await download(url, out);
      log({ kind: 'video-done', id, out, seconds: Math.round((Date.now() - t0) / 1000), usage: r.usage });
      return out;
    }
    if (st === 'failed' || st === 'cancelled' || st === 'expired') { log({ kind: 'video-fail', id, out, error: r.error ?? r }); throw new Error(`视频任务 ${id} ${st}: ${JSON.stringify(r.error ?? r).slice(0, 300)}`); }
    if (st !== undefined && !['queued', 'running', 'pending', 'processing', 'submitted'].includes(st)) { log({ kind: 'video-unknown', id, out, status: st }); throw new Error(`视频任务 ${id} 返回未知状态 ${JSON.stringify(st)}；稍后用 resumeVideos() 续取`); }
  }
  throw new Error(`视频任务 ${id} 超过 ${VIDEO_POLL_MS / 60000} 分钟未完成；任务已登记，稍后用 resumeVideos() 续取，不要重新提交`);
}

/** 语音合成（OpenAI 兼容 /v1/audio/speech） */
export async function speech({ text, out, model = 'qwen3-tts-flash', voice = 'Ethan', format = 'wav', instructions }) {
  if (existsSync(out)) return out;
  const buf = await call('POST', '/v1/audio/speech', { model, input: text, voice, response_format: format, ...(instructions ? { instructions } : {}) }, { raw: true });
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, buf);
  log({ kind: 'speech', model, voice, out, text });
  return out;
}

export { call };

/** 续取：按 log/requests.jsonl 里已提交但本地缺文件的视频任务逐个轮询下载（密钥失效、进程中断后用，避免重复提交扣费） */
export async function resumeVideos() {
  if (!existsSync('log/requests.jsonl')) return [];
  const subs = readFileSync('log/requests.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'video-submit');
  const latest = new Map(); for (const s of subs) latest.set(s.out, s.id);
  const done = [];
  await Promise.all([...latest].filter(([out]) => !existsSync(out)).map(async ([out, id]) => {
    for (let k = 0; k < 150; k++) {
      const r = await call('GET', `/seedance/api/v3/contents/generations/tasks/${id}`);
      const st = r.status ?? r.data?.status;
      if (st === 'succeeded') { await download(r.content?.video_url ?? r.data?.content?.video_url, out); log({ kind: 'video-resumed', id, out }); done.push(out); return; }
      if (['failed', 'cancelled', 'expired'].includes(st)) { log({ kind: 'video-fail', id, out, error: r.error ?? st }); return; }
      await sleep(8000);
    }
  }));
  return done;
}

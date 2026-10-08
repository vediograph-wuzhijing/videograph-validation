// render-cache.mjs — 渲染进程用的纯工具：超时、原子写、分段缓存键的组成与未命中原因。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, parse, relative } from 'node:path';
import { renameRetrySync } from '../platform/files.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** 到时就调用 onTimeout（负责关掉卡住的浏览器）并以它返回的错误拒绝；原 promise 之后的结果被忽略。 */
export function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 单帧预算（VIDEOGRAPH_EVAL_TIMEOUT_MS，默认 2 秒）× 帧数，下限 60 秒。 */
export function evalBudget(frames, perFrame = Number(process.env.VIDEOGRAPH_EVAL_TIMEOUT_MS) || 2000) {
  return Math.max(60000, Math.ceil(frames) * perFrame);
}

/** Windows 上目标文件正被读取（播放、杀毒扫描）时 rename 会短暂报 EPERM/EBUSY：退避重试。 */
export const renameRetry = renameRetrySync;
export function writeAtomic(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, data); renameRetry(temporary, path); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

/**
 * 镜头专属素材指纹：engine/app/public 下名为镜头 id 的目录（帧序列等），以及文件名为 `<id>.*` 或 `*-<id>.*` 的文件。
 * 只看相对路径、大小与 mtime（不读内容，帧序列可能有上千张）。没有专属素材返回 null。
 */
export function shotAssetIndex(engineDir) {
  const root = join(engineDir, 'app/public');
  const byShot = new Map();
  const add = (id, path) => { if (!byShot.has(id)) byShot.set(id, []); byShot.get(id).push(path); };
  const walk = (dir, owners) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, [...owners, entry.name]);
      else {
        const stem = parse(entry.name).name;
        const ids = new Set([...owners, stem, stem.includes('-') ? stem.slice(stem.lastIndexOf('-') + 1) : null].filter(Boolean));
        for (const id of ids) add(id, path);
      }
    }
  };
  if (existsSync(root)) walk(root, []);
  return (shotId) => {
    const files = byShot.get(shotId);
    if (!files) return null;
    return sha256(files.sort().map((path) => { const stat = statSync(path); return `${relative(root, path).replace(/\\/g, '/')}:${stat.size}:${stat.mtimeMs}`; }).join('\n'));
  };
}

/** 分段缓存键的组成：每项都是短哈希/值，键 = 整体哈希；未命中时逐项比对就是原因。 */
export function segmentParts({ engine, host, browser, code, dependency, shot, assets, fps, samples, encoder, scope }) {
  return { engine, host, browser, code: sha256(code), dependency: dependency ? sha256(JSON.stringify(dependency)) : null,
    shot: sha256(JSON.stringify({ start: shot.start, end: shot.end, params: shot.params, post: shot.post, effects: shot.effects })),
    assets, fps, samples, encoder, scope };
}
export const segmentKey = (parts) => sha256(JSON.stringify(parts));

/** previous 是上次为该镜头产出分段时的组成；全部相同却未命中说明分段文件缺失或损坏。 */
export function missReason(previous, parts) {
  if (!previous) return ['new'];
  const changed = Object.keys(parts).filter((name) => JSON.stringify(previous[name]) !== JSON.stringify(parts[name]));
  return changed.length ? changed : ['artifact'];
}

export function cacheSummary(reports) {
  const reasons = {};
  for (const report of reports) if (!report.cached) for (const reason of report.missReason ?? []) reasons[reason] = (reasons[reason] ?? 0) + 1;
  return { reused: reports.filter((report) => report.cached).length, rendered: reports.filter((report) => !report.cached).length, reasons };
}

export function readCacheIndex(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

/** 导出前检查：镜头从 0 开始、首尾相接、覆盖到整曲最后一帧；否则拼接出的视频会比音轨短或整体错位。 */
export function assertCoverage(shots, fps, totalFrames) {
  const frame = (t) => Math.round(t * fps);
  if (!shots.length) throw new Error('没有可渲染镜头');
  if (frame(shots[0].start) !== 0) throw new Error(`首个镜头 ${shots[0].id} 不从 0 秒开始（${shots[0].start}s），导出会与音轨错位`);
  for (let i = 1; i < shots.length; i++) {
    if (frame(shots[i].start) !== frame(shots[i - 1].end)) throw new Error(`镜头 ${shots[i - 1].id} 与 ${shots[i].id} 之间不连续（${shots[i - 1].end}s → ${shots[i].start}s）`);
  }
  const last = shots[shots.length - 1];
  if (frame(last.end) !== totalFrames) throw new Error(`最后一个镜头 ${last.id} 结束于第 ${frame(last.end)} 帧，整曲共 ${totalFrames} 帧；请让镜头覆盖整首音频`);
}

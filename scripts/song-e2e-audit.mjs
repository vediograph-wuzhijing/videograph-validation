// song-e2e-audit.mjs — SONG-06 第 1 项：任意音频 → 分析 → 确认 → 规划 → 3 镜头源码 → 校验 → 导出 → 缓存复用。
// 全程走 MCP 工具函数（callProjectTool），在独立服务实例/工程目录/令牌上运行，不碰日常服务。
// 需要：分析器 Python 环境（analyzer/environment.md）、Edge、ffmpeg/ffprobe。
// 运行：node --experimental-strip-types --no-warnings scripts/song-e2e-audit.mjs <audio.wav|mp3> [--keep]
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { freePort } from './tests/helpers/free-port.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const audioPath = resolve(process.argv[2] ?? join(root, '.cache/e2e-song/click132.wav'));
if (!existsSync(audioPath)) throw new Error(`音频不存在：${audioPath}`);
const work = join(root, '.cache/e2e-song/run');
if (!process.argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const port = Number(process.env.SONG_E2E_PORT) || await freePort();
Object.assign(process.env, {
  VIDEOGRAPH_SERVICE_PORT: String(port), VIDEOGRAPH_SERVICE_URL: `http://127.0.0.1:${port}`,
  VIDEOGRAPH_SERVICE_TOKEN_FILE: join(work, 'service-token'), VIDEOGRAPH_PROJECTS: join(work, 'projects'),
});
const { callProjectTool } = await import('../src/server/mcp-tools.ts');
const call = (name, args = {}) => callProjectTool(name, args);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

const service = spawn(process.execPath, ['src/server/index.mjs'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let serviceLog = '';
service.stdout.on('data', (chunk) => { serviceLog += chunk; });
service.stderr.on('data', (chunk) => { serviceLog += chunk; });
const timings = {};
const step = async (name, fn) => { const started = Date.now(); const result = await fn(); timings[name] = (Date.now() - started) / 1000; return result; };

async function waitFor(fn, { timeout, interval = 1000, label }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${label} 超时`);
    await sleep(interval);
  }
}
async function job(projectId, started, timeout = 600000) {
  const done = await waitFor(async () => { const current = await call('project_job_get', { projectId, jobId: started.id }); return ['done', 'error', 'cancelled'].includes(current.status) && current; }, { timeout, label: `任务 ${started.kind}` });
  if (done.status !== 'done') throw new Error(`任务 ${done.kind} ${done.status}: ${done.error}`);
  return done;
}
async function rejects(promise, pattern, label) {
  await assert.rejects(promise, pattern, label);
  log('✓ 拒绝', label);
}
function pcm(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb);
}
// 每个镜头一份可区分的真实场景源码（以通用模板为起点，换主色与标题文字）。
const sceneCode = (template, index, title) => template
  .replace('c.strokeStyle = HEX.signal;', `c.strokeStyle = ${JSON.stringify(['#FF4D12', '#3CC8FF', '#D8FF3C'][index % 3])};`)
  .replace("    comp.draw(renderer, L.upload(), out);", `    c.font = font(F.mono(400), 28); c.fillStyle = HEX.ash; c.textBaseline = 'top';\n    c.fillText(${JSON.stringify(`SHOT ${index + 1} · ${title}`)} + '  beat ' + f.beat.toFixed(2), 96, 96);\n    comp.draw(renderer, L.upload(), out);`);

try {
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, { timeout: 20000, interval: 300, label: '服务启动' });
  log('服务就绪', port);

  const created = await step('create', () => call('project_create_from_audio', { audioPath, name: 'SONG-06 click track', stages: ['t0', 't1'] }));
  const projectId = created.id;
  assert.equal(created.status, 'analysis-pending');
  assert.equal(created.audio.engineFile.startsWith('audio/song'), true);
  log('建工程', projectId);
  await rejects(call('project_plan_submit', { projectId, expectedInputRevision: created.revision }), /analysis-confirmed/, '分析未确认时规划');

  const analyzed = await step('analysis', () => waitFor(async () => { const project = await call('project_get', { projectId }); if (project.status === 'analysis-failed') throw new Error(project.analysis.error); return project.status === 'analysis-draft' && project; }, { timeout: 900000, interval: 3000, label: '分析' }));
  assert.equal(analyzed.analysis.source, 'analyzer');
  assert.equal(analyzed.analysis.instrumental, true);
  const analysis = await call('song_analysis_get', { projectId, layers: ['audio', 'rhythm', 'sections', 'lyrics'] });
  assert.equal(analysis.data.lyrics, undefined, '无歌词音频不得出现任何歌词（不套用旧工程）');
  const { bpm, beats, downbeats } = analysis.data.rhythm;
  log(`分析：bpm ${bpm.toFixed(2)}，${beats.length} 拍 / ${downbeats.length} 下拍，${analysis.data.sections.length} 段，时长 ${analysis.data.audio.duration}s`);
  assert.ok(Math.abs(bpm - 132) <= 0.5, `bpm 误差过大：${bpm}`);
  const windowed = await call('song_analysis_get', { projectId, startTime: 5, endTime: 10, layers: ['rhythm'] });
  assert.ok(windowed.data.rhythm.beats.every((t) => t >= 5 && t < 10) && windowed.data.rhythm.beats.length > 0, '时间段过滤（GET 查询参数）');
  assert.equal(windowed.data.audio, undefined, '只返回请求的层');

  const confirmed = await call('song_analysis_confirm', { projectId });
  assert.equal(confirmed.status, 'analysis-confirmed');
  assert.equal(confirmed.analysis.confirmedBy, 'mcp');
  log('agent 确认分析 ✓ confirmedBy=mcp');

  const cuts = [0, downbeats[4], downbeats[8]];
  const planned = await step('plan', () => call('project_plan_submit', { projectId, expectedInputRevision: confirmed.revision, reasoning: 'SONG-06 验收：按 4 小节切三镜',
    plan: cuts.map((t, index) => ({ t, id: `s${index + 1}`, title: ['起', '承', '合'][index], prompt: `验收镜头 ${index + 1}：节拍框随拍呼吸。` })) }));
  assert.equal(planned.status, 'planned');
  assert.equal(planned.shots.length, 3);
  assert.equal(planned.transitions.length, 2);
  assert.equal(planned.shots.at(-1).end, analysis.data.audio.duration);
  log('规划：', planned.shots.map((shot) => `${shot.id} ${shot.start.toFixed(3)}–${shot.end.toFixed(3)}`).join(' | '));
  await rejects(call('project_render', { projectId }), /needs-generation|尚未生成/, '镜头未生成时导出');

  await step('generate+validate', async () => {
    for (const [index, shot] of planned.shots.entries()) {
      const source = await call('project_shot_source', { projectId, shotId: shot.id });
      assert.equal(source.template, true);
      const submitted = await call('project_shot_submit', { projectId, shotId: shot.id, expectedInputRevision: source.shot.inputRevision, code: sceneCode(source.code, index, shot.title), summary: `验收场景 ${index + 1}` });
      assert.equal(submitted.shots.find((entry) => entry.id === shot.id).status, 'needs-validation');
      const validated = await job(projectId, await call('project_validate', { projectId, shotId: shot.id }));
      log(`校验 ${shot.id} ✓`, validated.result.reports[0].thumb);
    }
  });
  const ready = await call('project_get', { projectId });
  assert.ok(ready.shots.every((shot) => shot.status === 'ready'), '三个镜头均 ready');

  const exported = await step('export', async () => job(projectId, await call('project_render', { projectId }), 900000));
  const file = join(process.env.VIDEOGRAPH_PROJECTS, projectId, exported.result.file);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,nb_read_frames,r_frame_rate:format=duration', '-of', 'json', file]).toString());
  const video = probe.streams.find((stream) => stream.codec_type === 'video'), audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  const expectedFrames = Math.round(analysis.data.audio.duration * 30);
  log(`导出：${video.codec_name} ${video.nb_read_frames} 帧 @${video.r_frame_rate}，音轨 ${audio?.codec_name}，时长 ${probe.format.duration}s（期望 ${expectedFrames} 帧）`);
  assert.equal(Number(video.nb_read_frames), exported.result.frames);
  assert.ok(Math.abs(exported.result.frames - expectedFrames) <= 1, '帧数与歌曲时长一致');
  assert.ok(audio, '有音轨');
  const corr = correlation(pcm(file), pcm(audioPath));
  log(`导出音轨与源音频零偏移相关系数 ${corr.toFixed(6)}`);
  assert.ok(corr >= 0.999, `相关系数不足：${corr}`);

  const again = await step('export-cached', async () => job(projectId, await call('project_render', { projectId }), 900000));
  const hits = again.result.reports.filter((report) => report.cached).length;
  log(`二次导出缓存命中 ${hits}/${again.result.reports.length}`);
  assert.equal(hits, 3);

  console.log(JSON.stringify({ ok: true, projectId, bpm, beats: beats.length, downbeats: downbeats.length, shots: planned.shots.map(({ id, start, end }) => ({ id, start, end })), frames: exported.result.frames, correlation: corr, cacheHits: hits, timings }, null, 2));
} catch (error) {
  console.error('✖ 验收失败：', error);
  console.error('--- 服务日志（末尾）---\n' + serviceLog.slice(-4000));
  process.exitCode = 1;
} finally {
  service.kill();
}

// render-worker.mjs — 独立进程：冻结工程版本、逐帧渲染、分段缓存、整曲封装。
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startReferenceServer, hostRuntimeSource, HOST_PATCH_VERSION } from './reference-server.mjs';
import { projectDir, readJob, saveJob, mutateProject, sha256, productRoot } from './project-store.mjs';
import { normalizeProject, transitionPair, transitionWindow, transitionConfig } from './transitions.mjs';
import { withTimeout, evalBudget, writeAtomic, renameRetry, shotAssetIndex, segmentParts, segmentKey, missReason, cacheSummary, readCacheIndex, assertCoverage } from './render-cache.mjs';
import { analyzeRhythm, beatLabel, motionSeries, RHYTHM_VERSION } from './rhythm.mjs';
import { pageSample, pageComposeGrid, pageDrawChart } from './ae-page.mjs';
import { browserPath, angleArgs } from './browser.mjs';

const [projectId, jobId] = process.argv.slice(2);
const job = readJob(projectId, jobId);
const frozen = normalizeProject(job.input.project);
const dir = projectDir(projectId);
const controller = new AbortController();
process.on('message', (message) => { if (message === 'cancel') controller.abort(); });
process.on('disconnect', () => controller.abort());
const signal = controller.signal;
let browser;
let server;
let frameSocket;
let frameToken = null;
let lastSave = 0;
// LLM 写的场景可能死循环：page.evaluate 永不返回会把渲染进程和服务的任务队列一起挂住。
// 超时直接关浏览器（不 abort：任务应记为 error 而不是 cancelled）。
function evaluate(page, fn, arg, { frames = 1, label = '' } = {}) {
  const ms = evalBudget(frames);
  return withTimeout(page.evaluate(fn, arg), ms, () => {
    void browser?.close();
    return new Error(`${label || '渲染页'}：${Math.round(ms / 1000)} 秒内没有返回，场景代码可能死循环或卡住（可用 VIDEOGRAPH_EVAL_TIMEOUT_MS 调整单帧预算）`);
  });
}
function progress(detail, value) {
  job.detail = detail; job.progress = value;
  if (Date.now() - lastSave > 500 || value === 1) { saveJob(projectId, job); lastSave = Date.now(); }
}
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';

async function runFfmpeg(args) {
  signal.throwIfAborted();
  const process = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
  let stderr = '';
  process.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  const [code] = await once(process, 'close');
  if (code !== 0) throw new Error(`ffmpeg exit ${code}: ${stderr}`);
}

async function renderSegment(page, shot, output, fps, samples, doneFrames, totalFrames) {
  signal.throwIfAborted();
  const first = Math.round(shot.start * fps), last = Math.round(shot.end * fps), count = last - first;
  const width = 1920, height = 1080;
  const encoder = spawn(ffmpeg, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0',
    '-an', '-vf', 'vflip,scale=out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '', failure;
  encoder.stderr.on('data', (data) => { stderr = (stderr + data).slice(-6000); });
  encoder.stdin.on('error', (error) => { failure = error; });
  encoder.on('error', (error) => { failure = error; });
  const encoderExit = new Promise((resolve) => encoder.on('close', (code) => resolve(code)));
  // ffmpeg 阻塞在读 stdin 时会忽略 SIGTERM：关闭 stdin 并直接 SIGKILL，保证取消/失败后编码器一定退出
  // （否则编码器与管道会把渲染进程挂住，服务的任务队列随之卡死）。半成品写在临时文件里，不会进入分段缓存。
  const stopEncoder = () => { encoder.stdin.destroy(); if (encoder.exitCode === null && encoder.signalCode === null) encoder.kill('SIGKILL'); };
  const token = randomUUID();
  frameToken = token;
  const socket = frameSocket;
  let received = 0;
  let chain = Promise.resolve();
  const onConnection = (ws) => {
    ws.on('message', (buffer, binary) => {
      chain = chain.then(async () => {
        signal.throwIfAborted();
        if (!binary || buffer.length !== width * height * 4 || received >= count) throw new Error('unexpected frame payload');
        if (!encoder.stdin.write(buffer)) await once(encoder.stdin, 'drain');
        received++;
        ws.send(String(received));
        progress(`渲染 ${shot.title} · ${received}/${count} 帧`, (doneFrames + received) / totalFrames);
      }).catch((error) => { failure = error; ws.terminate(); stopEncoder(); void page.close(); });
    });
  };
  socket.on('connection', onConnection);
  const cancel = () => { for (const ws of socket.clients) ws.terminate(); stopEncoder(); void page.close(); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await evaluate(page, (options) => window.__pdoom.stream(options), { from: first / fps, to: last / fps, fps, samples, shutter: 0.2, inflight: 2, ws: `ws://127.0.0.1:${socket.address().port}/${token}` },
      { frames: count * Math.max(1, typeof samples === 'number' ? samples : 4), label: `${shot.id} 分段渲染` });
    await chain;
    const deadline = Date.now() + 30000;
    while (received < count && !failure && Date.now() < deadline) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await chain;
    }
    if (failure) throw failure;
    if (received !== count) throw new Error(`frame count mismatch: ${received}/${count}`);
    encoder.stdin.end();
    const code = await encoderExit;
    if (code !== 0) throw new Error(`encoder exit ${code}: ${stderr}`);
  } finally {
    signal.removeEventListener('abort', cancel);
    socket.off('connection', onConnection);
    frameToken = null;
    for (const ws of socket.clients) ws.terminate();
    if (encoder.exitCode === null) stopEncoder();
  }
}

// 在渲染页内把 PNG 缩放到目标宽度：不引入 ffmpeg 依赖，真实引擎与测试夹具引擎同样适用。
async function scalePng(page, base64, width) {
  if (!width) return base64;
  return evaluate(page, async ({ base64, width }) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    if (bitmap.width === width) { bitmap.close(); return base64; }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/png').split(',')[1];
  }, { base64, width }, { label: '缩放静帧' });
}

try {
  job.status = 'running'; job.startedAt = Date.now(); saveJob(projectId, job);
  for (const [pkg, version] of Object.entries(frozen.dependencies)) {
    const actual = JSON.parse(readFileSync(join(productRoot, `node_modules/${pkg}/package.json`), 'utf8')).version;
    if (actual !== version) throw new Error(`引擎依赖版本改变：${pkg} 需要 ${version}，当前 ${actual}`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'engine-manifest.json'), 'utf8'));
  for (const [path, hash] of manifest.files) {
    if (sha256(readFileSync(join(dir, 'engine', path))) !== hash) throw new Error(`引擎快照被外部修改：${path}；请重新导入或通过镜头源码工具创建新版本。`);
  }
  // 只哈希真正注入渲染页的宿主代码与补丁版本；整份 reference-server/transitions 源码任何无关改动都会让全片分段缓存失效。
  const hostHash = sha256(`${HOST_PATCH_VERSION}\n${hostRuntimeSource()}`);
  const fps = job.input.fps ?? frozen.output.fps;
  const samples = job.input.samples ?? frozen.output.samples;
  let shots = frozen.shots.map((shot) => ({ ...shot, start: Math.round(shot.start * fps) / fps, end: Math.round(shot.end * fps) / fps }));
  let transitions = frozen.transitions;
  const stillsInput = job.input.stills ?? null;
  if (stillsInput?.version === 'before-feedback') {
    // 修改前版本以 reviewBaseline 为唯一事实：快照没有的字段不保留候选值（与 preview 的回放口径一致）。
    const target = stillsInput.targetKind === 'shot' ? frozen.shots.find((entry) => entry.id === stillsInput.targetId) : frozen.transitions.find((entry) => entry.id === stillsInput.targetId);
    if (!target) throw new Error('stills 目标不存在');
    if (!target.reviewBaseline) throw new Error('没有可比较的修改前版本');
    if (stillsInput.targetKind === 'transition') {
      transitions = frozen.transitions.map((entry) => entry.id === target.id ? { ...entry, ...structuredClone(target.reviewBaseline) } : entry);
      const sources = target.reviewBaselineSources ?? {};
      shots = shots.map((shot) => shot.id === target.fromShotId && sources.left ? { ...shot, ...structuredClone(sources.left) }
        : shot.id === target.toShotId && sources.right ? { ...shot, ...structuredClone(sources.right) } : shot);
    } else shots = shots.map((shot) => shot.id === target.id ? { ...shot, ...structuredClone(target.reviewBaseline) } : shot);
  }
  frameSocket = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1920 * 1080 * 4 + 1024,
    verifyClient: ({ req, origin }) => frameToken !== null && req.url === `/${frameToken}` && origin === server?.url });
  await once(frameSocket, 'listening');
  server = await startReferenceServer({ root: join(dir, 'engine'), shots, transitions, fps, audioFile: frozen.audio.engineFile, framePort: frameSocket.address().port });
  browser = await chromium.launch({ headless: true, executablePath: browserPath(),
    args: [...angleArgs(), '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling'] });
  signal.addEventListener('abort', () => { void browser?.close(); }, { once: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  let browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  await page.route('**/*', (route) => route.request().url().startsWith(server.url + '/') ? route.continue() : route.abort());
  async function loadShot(shot, previous) {
    browserErrors = [];
    const index = shots.findIndex((entry) => entry.id === shot.id);
    const previousId = previous?.id ?? (samples > 1 ? shots[index - 1]?.id : undefined);
    const only = [previousId, shot.id].filter(Boolean).join(',');
    await page.goto(`${server.url}/?export=1&only=${encodeURIComponent(only)}`);
    await page.waitForFunction(() => window.__pdoom?.ready || window.__pdoom?.error, null, { timeout: 120000 });
    const error = await evaluate(page, () => window.__pdoom.error || window.__pdoom.errors.join('\n'), undefined, { label: `${shot.id} 加载` });
    if (error) throw new Error(error);
  }
  // FB-03 stills：用与导出相同的引擎/加载路径渲染指定时间点；缓存键 = 版本输入 + t + 宽度。
  async function runStills() {
    const target = stillsInput.targetKind === 'shot' ? shots.find((entry) => entry.id === stillsInput.targetId) : transitions.find((entry) => entry.id === stillsInput.targetId);
    if (!target) throw new Error('stills 目标不存在');
    const pair = stillsInput.targetKind === 'transition' ? transitionPair({ ...frozen, shots }, target) : null;
    const incoming = pair ? null : transitions.find((entry) => entry.toShotId === target.id && entry.mode !== 'cut');
    const previous = incoming ? transitionPair({ ...frozen, shots }, incoming).left : null;
    // stills 不看 needs-generation：意见加入就会把镜头标为待改写，但当前源码仍可渲染，
    // agent 恰恰要在改写前看到锚点处的现状；模块文件缺失会在 readCode/loadShot 处自然报错。
    // 转场静帧必须显式加载出镜侧（与镜头/帧序列路径一致）；只靠依赖注入时出镜侧会渲染错误（2026-10-02 修复）。
    await loadShot(pair ? pair.right : target, pair ? pair.left : previous);
    const readCode = (shot) => readFileSync(join(dir, `engine/app/src/scenes/${shot.module}.ts`), 'utf8');
    const dependency = incoming ? { config: transitionConfig(incoming), from: { start: previous.start, end: previous.end, params: previous.params, post: previous.post, effects: previous.effects, code: readCode(previous) } } : null;
    const artifactHash = (relative) => sha256(readFileSync(join(dir, relative)));
    const images = [];
    for (const [index, t] of stillsInput.times.entries()) {
      const time = Math.round(t * 1000) / 1000;
      const key = sha256(JSON.stringify({ engine: frozen.engineHash, hostHash, browser: browser.version(),
        code: pair ? `${readCode(pair.left)}\n${readCode(pair.right)}` : readCode(target), dependency,
        config: pair ? transitionConfig(target) : null, scope: 'stills-v2', version: stillsInput.version,
        target: pair ? { start: pair.left.start, end: pair.right.end } : { start: target.start, end: target.end, params: target.params, post: target.post, effects: target.effects },
        t: time, width: stillsInput.width }));
      const file = join(dir, 'artifacts', `${key}.png`);
      if (!existsSync(file)) {
        mkdirSync(join(dir, 'artifacts'), { recursive: true });
        await evaluate(page, (t) => window.__pdoom.still(t, 1, .2), time, { label: `${stillsInput.targetId} 静帧 ${time}s` });
        const png = await scalePng(page, await evaluate(page, () => window.__pdoom.png(), undefined, { label: `${stillsInput.targetId} 截图` }), stillsInput.width);
        writeAtomic(file, Buffer.from(png, 'base64'));
      }
      images.push({ t: time, file: `artifacts/${key}.png`, contentHash: artifactHash(`artifacts/${key}.png`) });
      progress(`静帧 ${time.toFixed(3)}s · ${index + 1}/${stillsInput.times.length}`, (index + 1) / stillsInput.times.length);
    }
    const errors = await evaluate(page, () => window.__pdoom.errors, undefined, { label: stillsInput.targetId });
    if (errors.length || browserErrors.length) throw new Error(`${stillsInput.targetId}: ${[...errors, ...browserErrors].join('\n')}`);
    job.result = { revision: frozen.revision, stills: { ...stillsInput, images } };
  }

  // AE-02/03/04：filmstrip / contact-sheet / rhythm。只读分析任务：不改工程状态，产物按内容寻址缓存。
  async function runAe() {
    const input = job.input.ae;
    const readCode = (shot) => readFileSync(join(dir, `engine/app/src/scenes/${shot.module}.ts`), 'utf8');
    const incomingOf = (shot) => transitions.find((entry) => entry.toShotId === shot.id && entry.mode !== 'cut') ?? null;
    const previousOf = (shot) => { const incoming = incomingOf(shot); return incoming ? transitionPair({ ...frozen, shots }, incoming).left : null; };
    const shotKey = (shot) => {
      if (!shot.module) return { id: shot.id, missing: true };
      const incoming = incomingOf(shot), previous = previousOf(shot);
      return { id: shot.id, code: readCode(shot), start: shot.start, end: shot.end, params: shot.params, post: shot.post, effects: shot.effects,
        incoming: incoming ? { config: transitionConfig(incoming), from: previous?.module ? readCode(previous) : null } : null };
    };
    // ae-page.mjs 的采样/拼图算法就是这些产物的输入，改它必须让缓存失效。
    const aeHash = sha256(readFileSync(new URL('./ae-page.mjs', import.meta.url)));
    const keyFor = (involved) => sha256(JSON.stringify({ engine: frozen.engineHash, hostHash, aeHash, browser: browser.version(), scope: `ae-${job.kind}`, input, shots: involved.map(shotKey), version: 'ae-v2' }));
    const shotAt = (t) => shots.find((shot) => t >= shot.start - 1e-6 && t < shot.end - 1e-6) ?? shots[shots.length - 1];
    const ensureModule = (shot) => { if (!shot.module) throw new Error(`${shot.id} 还没有源码：先 project_shot_submit`); };
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    const save = (key, png) => { writeAtomic(join(dir, 'artifacts', `${key}.png`), Buffer.from(png, 'base64')); return `artifacts/${key}.png`; };
    const sampleShot = (shot, options) => evaluate(page, pageSample, options, { frames: options.times.length, label: `${shot.id} 采样` });
    const compose = (fn, arg) => evaluate(page, fn, arg, { label: '拼图' });
    const groups = (times) => {
      const map = new Map();
      for (const t of times) { const shot = shotAt(t); if (!map.has(shot.id)) map.set(shot.id, { shot, times: [] }); map.get(shot.id).times.push(t); }
      return [...map.values()];
    };
    const checkErrors = (sample, shot) => {
      if (sample.errors.length || browserErrors.length) throw new Error(`${shot.id}: ${[...sample.errors, ...browserErrors].join('\n')}`);
    };

    if (job.kind === 'filmstrip') {
      const key = keyFor(groups(input.times).map((group) => group.shot));
      if (!existsSync(join(dir, 'artifacts', `${key}.png`))) {
        const tiles = [];
        let done = 0;
        for (const { shot, times } of groups(input.times)) {
          ensureModule(shot);
          await loadShot(shot, previousOf(shot));
          const sample = await sampleShot(shot, { times, sequential: false, thumbWidth: input.thumbWidth });
          checkErrors(sample, shot);
          const index = shots.indexOf(shot) + 1;
          times.forEach((t, i) => {
            const label = beatLabel(frozen.song, t, 0.5 / fps);
            tiles.push({ png: sample.thumbs[i], accent: label.marks.some((mark) => mark.startsWith('●')), lines: [label.text, `#${index} ${shot.title ?? shot.id}`] });
          });
          done += times.length;
          progress(`帧序列 ${done}/${input.times.length}`, done / input.times.length);
        }
        save(key, await compose(pageComposeGrid, { tiles, columns: input.columns, tileWidth: input.thumbWidth, title: `帧序列 · ${input.label} · ${input.times.length} 帧 · 橙框=下拍` }));
      }
      job.result = { revision: frozen.revision, images: [{ file: `artifacts/${key}.png`, kind: 'filmstrip', contentHash: sha256(readFileSync(join(dir, 'artifacts', `${key}.png`))) }], times: input.times,
        labels: input.times.map((t) => beatLabel(frozen.song, t, 0.5 / fps).text) };
      return;
    }

    if (job.kind === 'contact-sheet') {
      const key = keyFor(shots);
      if (!existsSync(join(dir, 'artifacts', `${key}.png`))) {
        const tiles = [];
        for (const [index, shot] of shots.entries()) {
          const section = (frozen.song.sections ?? []).find((entry) => shot.start >= entry.start - 0.05 && shot.start < entry.end - 0.05)?.name ?? '';
          const head = `#${index + 1} ${shot.title ?? shot.id}`, sub = `${shot.start.toFixed(1)}–${shot.end.toFixed(1)}s ${section} ${shot.status ?? ''}`;
          const times = input.ratios.map((ratio) => Math.min(shot.end - 1 / fps, shot.start + (shot.end - shot.start) * ratio));
          if (!shot.module) { for (const _ of times) tiles.push({ placeholder: '未生成源码', lines: [head, sub] }); continue; }
          await loadShot(shot, previousOf(shot));
          const sample = await sampleShot(shot, { times, sequential: false, thumbWidth: input.thumbWidth });
          checkErrors(sample, shot);
          sample.thumbs.forEach((png) => tiles.push({ png, lines: [head, sub] }));
          progress(`全片缩略图 ${index + 1}/${shots.length}`, (index + 1) / shots.length);
        }
        save(key, await compose(pageComposeGrid, { tiles, columns: input.columns, tileWidth: input.thumbWidth, title: `全片缩略图 · ${shots.length} 镜头 · 每镜 ${input.ratios.length} 帧（${input.ratios.join('/')}）` }));
      }
      job.result = { revision: frozen.revision, images: [{ file: `artifacts/${key}.png`, kind: 'contact-sheet', contentHash: sha256(readFileSync(join(dir, 'artifacts', `${key}.png`))) }],
        shots: shots.map((shot, index) => ({ index: index + 1, id: shot.id, title: shot.title, start: shot.start, end: shot.end, status: shot.status })) };
      return;
    }

    // rhythm：按 sampleFps 顺序渲染（有状态场景正确），64×36 灰度帧算运动与亮度。
    const sampleFps = input.sampleFps;
    const first = Math.ceil(input.start * sampleFps - 1e-6), last = Math.floor(input.end * sampleFps - 1e-6);
    const times = [];
    for (let n = first; n <= last; n++) times.push(n / sampleFps);
    // 采样帧（64×36 灰度）按渲染输入缓存；指标算法升级（RHYTHM_VERSION）时只重算报告，不重新渲染。
    const framesKey = keyFor(groups(times).map((group) => group.shot));
    const framesFile = join(dir, 'artifacts', `${framesKey}.gray`);
    let frames = [];
    if (existsSync(framesFile)) {
      const bytes = readFileSync(framesFile), size = 64 * 36;
      for (let offset = 0; offset < bytes.length; offset += size) frames.push(new Uint8Array(bytes.subarray(offset, offset + size)));
    }
    if (frames.length !== times.length) {
      frames = [];
      for (const { shot, times: own } of groups(times)) {
        ensureModule(shot);
        await loadShot(shot, previousOf(shot));
        for (let offset = 0; offset < own.length; offset += 60) {
          // 每段第一帧 seek，其余连续渲染；分块只是为了进度与单次 evaluate 体积。
          const chunk = own.slice(offset, offset + 60);
          const sample = await sampleShot(shot, { times: chunk, sequential: true, seekFirst: offset === 0, dt: 1 / sampleFps, gray: { w: 64, h: 36 } });
          checkErrors(sample, shot);
          for (const gray of sample.grays) frames.push(new Uint8Array(Buffer.from(gray, 'base64')));
          progress(`节奏采样 ${frames.length}/${times.length} 帧`, frames.length / times.length * 0.97);
        }
      }
      writeAtomic(framesFile, Buffer.concat(frames.map((frame) => Buffer.from(frame))));
    }
    const { motion, luma, ink, levelMotion } = motionSeries(frames, Math.max(1, Math.round(sampleFps / 15)));
    const analysis = analyzeRhythm(frozen.song, { fps: sampleFps, t: times, motion, luma, ink, levelMotion }, { shots, label: input.label });
    const key = sha256(`${framesKey}:${RHYTHM_VERSION}`);
    if (!existsSync(join(dir, 'artifacts', `${key}.png`))) save(key, await compose(pageDrawChart, analysis.chart));
    writeAtomic(join(dir, 'artifacts', `${key}.json`), JSON.stringify({ text: analysis.text, metrics: analysis.metrics, bars: analysis.bars }));
    job.result = { revision: frozen.revision, text: analysis.text, metrics: analysis.metrics, images: [{ file: `artifacts/${key}.png`, kind: 'rhythm-chart', contentHash: sha256(readFileSync(join(dir, 'artifacts', `${key}.png`))) }], report: `artifacts/${key}.json` };
  }


  if (job.kind === 'stills') {
    await runStills();
  } else if (['filmstrip', 'contact-sheet', 'rhythm'].includes(job.kind)) {
    await runAe();
  } else {
  const targetTransition = job.kind === 'validate-transition' ? frozen.transitions.find((entry) => entry.id === job.input.transitionId) : null;
  if (job.kind === 'validate-transition' && !targetTransition) throw new Error('转场不存在');
  const wanted = targetTransition ? shots.filter((shot) => shot.id === targetTransition.toShotId) : job.kind === 'validate' ? shots.filter((shot) => shot.id === job.input.shotId) : shots;
  if (!wanted.length) throw new Error('没有可渲染镜头');
  const total = Math.round(frozen.song.duration * fps);
  if (job.kind === 'export') assertCoverage(shots, fps, total);
  const frameCount = (shot) => Math.round(shot.end * fps) - Math.round(shot.start * fps);
  const assetsOf = shotAssetIndex(join(dir, 'engine'));
  const cacheIndexFile = join(dir, 'artifacts', 'cache-index.json');
  const cacheIndex = readCacheIndex(cacheIndexFile);
  const browserVersion = browser.version();
  let doneFrames = 0;
  const segments = [], reports = [];
  for (const shot of wanted) {
    signal.throwIfAborted();
    if (shot.status === 'needs-generation') throw new Error(`${shot.id} 提示词已修改，请先通过 MCP 提交对应源码`);
    const code = readFileSync(join(dir, `engine/app/src/scenes/${shot.module}.ts`), 'utf8');
    const incoming = targetTransition ?? frozen.transitions.find((entry) => entry.toShotId === shot.id && entry.mode !== 'cut');
    if (incoming?.status === 'needs-generation') throw new Error(`${incoming.id} 有新的转场指导，尚未配置效果`);
    const previous = incoming ? transitionPair({ ...frozen, shots }, incoming).left : null;
    if (previous?.status === 'needs-generation') throw new Error(`${previous.id} 尚未完成改写，不能验证相邻转场`);
    const dependency = incoming ? { config: transitionConfig(incoming), from: { start: previous.start, end: previous.end, params: previous.params, post: previous.post, effects: previous.effects,
      code: readFileSync(join(dir, `engine/app/src/scenes/${previous.module}.ts`), 'utf8') } } : null;
    // 前一镜头只在有入场转场时进入键（转场窗口内会渲染它）；硬切镜头互不影响缓存。
    const parts = segmentParts({ engine: frozen.engineHash, host: hostHash, browser: browserVersion, code, dependency, shot, assets: assetsOf(shot.id),
      fps, samples, encoder: 'x264-crf18-veryfast-bt709-v1', scope: targetTransition ? 'transition' : 'shot' });
    const key = segmentKey(parts);
    const publishValidation = (validation) => mutateProject(projectId, undefined, (project) => {
      const current = project.shots.find((entry) => entry.id === shot.id);
      const currentTransition = incoming ? project.transitions.find((entry) => entry.id === incoming.id) : null;
      const currentPrevious = previous ? project.shots.find((entry) => entry.id === previous.id) : null;
      if (current?.inputToken !== shot.inputToken || (incoming && (currentTransition?.inputToken !== incoming.inputToken || currentPrevious?.inputToken !== previous.inputToken))) return project;
      if (targetTransition) {
        currentTransition.validation = { ...validation, inputToken: incoming.inputToken, leftInputToken: previous.inputToken, rightInputToken: shot.inputToken };
        currentTransition.status = 'ready';
      } else { current.validation = validation; current.status = 'ready'; }
      return project;
    });
    const file = join(dir, 'artifacts', `${key}.mp4`);
    const meta = join(dir, 'artifacts', `${key}.json`);
    const metaData = existsSync(file) && existsSync(meta) ? JSON.parse(readFileSync(meta, 'utf8')) : null;
    const cached = metaData !== null && metaData.frames === frameCount(shot) && metaData.hash === sha256(readFileSync(file));
    const indexKey = targetTransition ? `transition:${targetTransition.id}` : shot.id;
    if (job.kind === 'export' && cached) {
      const validation = { samples: 5, inputToken: shot.inputToken, key, thumb: `${key}.png`, checkedAt: Date.now(), cached: true };
      publishValidation(validation);
      doneFrames += frameCount(shot);
      segments.push(file); reports.push({ shotId: shot.id, cached: true, key });
      cacheIndex[indexKey] = parts;
      progress(`复用 ${shot.title}`, doneFrames / total);
      continue;
    }
    const reason = job.kind === 'export' ? missReason(cacheIndex[indexKey], parts) : undefined;
    await loadShot(shot, previous);
    const window = targetTransition ? transitionWindow({ ...frozen, shots }, targetTransition, fps) : null;
    const sampleTimes = window ? (window.frames ? [window.start - 1 / fps, window.start, (window.start + window.end) / 2, window.end, window.end + 1 / fps]
      : [-2, -1, 0, 1, 2].map((frame) => window.start + frame / fps)).map((t) => Math.max(previous.start, Math.min(shot.end - 1 / fps, t)))
      : [0, .25, .45, .75, .99].map((ratio) => shot.start + (shot.end - shot.start) * ratio);
    for (const t of sampleTimes) await evaluate(page, (t) => window.__pdoom.still(t, 1, .2), t, { label: `${shot.id} 抽检 ${t.toFixed(3)}s` });
    const errors = await evaluate(page, () => window.__pdoom.errors, undefined, { label: shot.id });
    if (errors.length || browserErrors.length) throw new Error(`${shot.id}: ${[...errors, ...browserErrors].join('\n')}`);
    const previewTime = window ? (window.start + window.end) / 2 : shot.start + (shot.end - shot.start) * .45;
    await evaluate(page, (t) => window.__pdoom.still(t, 1, 0.2), previewTime, { label: `${shot.id} 缩略图` });
    const png = await evaluate(page, () => window.__pdoom.png(), undefined, { label: `${shot.id} 截图` });
    const thumb = `${key}.png`;
    writeAtomic(join(dir, 'artifacts', thumb), Buffer.from(png, 'base64'));
    const validation = { samples: 5, times: sampleTimes, inputToken: shot.inputToken, key, thumb, checkedAt: Date.now() };
    publishValidation(validation);
    if (job.kind === 'export') {
      const temporary = join(dir, 'artifacts', `${key}-${jobId}.tmp.mp4`);
      try {
        await renderSegment(page, shot, temporary, fps, samples, doneFrames, total);
        const renderErrors = await evaluate(page, () => window.__pdoom.errors, undefined, { label: shot.id });
        if (renderErrors.length || browserErrors.length) throw new Error(`${shot.id}: ${[...renderErrors, ...browserErrors].join('\n')}`);
        renameRetry(temporary, file);
      } finally { rmSync(temporary, { force: true }); }
      writeAtomic(meta, JSON.stringify({ hash: sha256(readFileSync(file)), frames: frameCount(shot), key }));
      segments.push(file);
      doneFrames += frameCount(shot);
      cacheIndex[indexKey] = parts;
      writeAtomic(cacheIndexFile, JSON.stringify(cacheIndex));
    }
    reports.push({ shotId: shot.id, ...(targetTransition ? { transitionId: targetTransition.id } : {}), cached: false, ...(reason ? { missReason: reason } : {}), ...validation });
  }
  if (job.kind === 'export') {
    if (doneFrames !== total) throw new Error(`分段合计 ${doneFrames} 帧，整曲应为 ${total} 帧；已停止合成以免音画不同步`);
    writeAtomic(cacheIndexFile, JSON.stringify(cacheIndex));
    const outDir = join(dir, 'exports', jobId); mkdirSync(outDir, { recursive: true });
    const list = join(outDir, 'segments.txt');
    writeFileSync(list, segments.map((path) => `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const output = join(outDir, 'pv.mp4');
    progress('合成全片并封装完整 BGM…', 0.99);
    await runFfmpeg(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', join(dir, 'engine', frozen.audio.engineFile ?? 'audio/pdoom.mp3'),
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-af', 'apad', '-t', String(total / fps), '-movflags', '+faststart', output]);
    job.result = { file: `exports/${jobId}/pv.mp4`, frames: total, seconds: total / fps, fps, samples, revision: frozen.revision, transitions: frozen.transitions.map(({ id, fromShotId, toShotId, mode, duration, easing, direction }) => ({ id, fromShotId, toShotId, mode, duration, easing, direction })), reports, cacheSummary: cacheSummary(reports) };
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ ...job.result, engineHash: frozen.engineHash, audioHash: frozen.audio.hash, credits: frozen.credits }, null, 2));
  } else if (!['stills', 'filmstrip', 'contact-sheet', 'rhythm'].includes(job.kind)) job.result = { revision: frozen.revision, reports };
  }
  job.status = 'done'; job.finishedAt = Date.now(); progress('完成', 1);
} catch (error) {
  job.status = signal.aborted ? 'cancelled' : 'error'; job.error = String(error).slice(0, 12000); job.finishedAt = Date.now(); saveJob(projectId, job);
  console.error(job.error);
} finally {
  await browser?.close();
  await server?.close();
  frameSocket?.close();
  if (process.connected) process.disconnect();
}

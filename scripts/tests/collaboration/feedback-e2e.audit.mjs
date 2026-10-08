// feedback-e2e.audit.mjs — FB-04 端到端验收：人（无头 Edge）与 agent（真实 MCP stdio）在同一工程上的完整意见闭环。
// 夹具：独立 VIDEOGRAPH_PROJECTS 临时目录、独立端口与令牌，从参考 BGM 建工程（字节指纹 → 参考导入，真引擎）。
// 主线：带锚点意见 → MCP inbox/stills → 提问 → 人回复 → 改写+feedbackResponses → 校验 → 导出拦截(409)
//       → 人拒绝（旧候选不可接受）→ 再改写 → 过期版本接受 409 → 并排对比后采用 → 导出放行 + 清单记录新版本
//       → 词起点帧逐像素对比证明保留项（歌词时序）未变。
// 运行：node scripts/tests/collaboration/feedback-e2e.audit.mjs（需要本机 Edge 与 GPU；约 10–20 分钟）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createStreamProject } from './helpers-fb04.mjs';
import { browserPath, angleArgs } from '../../../src/server/browser.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const referenceBgm = join(root, '../pdoom-video/audio/pdoom.mp3');
// 夹具必须放仓库 .cache 下（.gitignore 已覆盖）：vite 预览服务的 fs.allow 对系统 Temp 路径
// 下的文件不生效——真引擎 fetch /data/lyrics.json 会被 SPA 回退成 index.html（A/B 实测，
// 见 ROADMAP FB-04 备注）；FB-02/03 的夹具引擎不 fetch 数据文件所以没踩到。
const tmp = join(root, `.cache/fb04-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
const projects = join(tmp, 'projects');
const tokenFile = join(tmp, 'service-token');
let servicePort = Number(process.env.FB04_SERVICE_PORT) || 6340 + Math.floor(Math.random() * 60);
let studioPort = Number(process.env.FB04_STUDIO_PORT) || 6640 + Math.floor(Math.random() * 60);
let serviceBase = `http://127.0.0.1:${servicePort}`;
let studioBase = `http://127.0.0.1:${studioPort}`;
const EDGE = browserPath();
const log = (message) => console.log(`[fb04 ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${message}`);
const t0 = Date.now();
let service, vite, browser, client, projectId;
const results = {};

async function http(path, body, options = {}) {
  const { token } = await (await fetch(serviceBase + '/session', { headers: { origin: studioBase } })).json();
  const response = await fetch(serviceBase + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (options.expectError) return { status: response.status, data };
  assert.ok(response.ok, `${path} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function invoke(name, args, expectError = false) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  if (expectError) { assert.equal(response.isError, true, `应为错误：${name}`); return text; }
  if (response.isError) throw new Error(`${name}: ${text}`);
  const structured = response.structuredContent ?? JSON.parse(response.content.find((item) => item.type === 'text').text);
  return { value: structured, images: response.content.filter((item) => item.type === 'image') };
}

async function waitJob(forProject, jobId, { timeout = 600000, label = jobId } = {}) {
  const deadline = Date.now() + timeout;
  let last = '';
  for (;;) {
    const { value: job } = await invoke('project_job_get', { projectId: forProject, jobId });
    if (job.detail && job.detail !== last) { last = job.detail; log(`${label}: ${job.detail}`); }
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} 超时：${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

/** 在浏览器页里解码两张 PNG 并按掩码统计差异像素（引擎是确定性渲染：同 t 除被改元素外应逐像素一致）。 */
async function diffStills(page, forProject, fileA, fileB, mask) {
  const a = readFileSync(join(projects, forProject, fileA)).toString('base64');
  const b = readFileSync(join(projects, forProject, fileB)).toString('base64');
  return page.evaluate(async ({ a, b, mask }) => {
    const load = async (base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const width = bitmap.width, height = bitmap.height;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return { data: ctx.getImageData(0, 0, width, height).data, w: width, h: height };
    };
    const [A, B] = await Promise.all([load(a), load(b)]);
    if (A.w !== B.w || A.h !== B.h) throw new Error(`尺寸不同：${A.w}x${A.h} vs ${B.w}x${B.h}`);
    const k = A.w / 1920; // 掩码以 1920×1080 为基准
    const inBox = (x, y) => x >= mask.x0 * k && x <= mask.x1 * k && y >= mask.y0 * k && y <= mask.y1 * k;
    let inside = 0, outside = 0, insideTotal = 0;
    for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
      const i = (y * A.w + x) * 4;
      const differs = Math.abs(A.data[i] - B.data[i]) > 8 || Math.abs(A.data[i + 1] - B.data[i + 1]) > 8 || Math.abs(A.data[i + 2] - B.data[i + 2]) > 8;
      if (!differs) continue;
      if (inBox(x, y)) inside++; else outside++;
    }
    insideTotal = Math.round((mask.x1 - mask.x0) * k) * Math.round((mask.y1 - mask.y0) * k);
    return { w: A.w, h: A.h, inside, outside, insideTotal };
  }, { a, b, mask });
}

// loss 场景 drawServantBoss 的终端回显行 typed(wNow, 150, 168, …)：左上角一块，与 SERVANT/BOSS 卡拉OK字形不重叠。
// 这是"参考引擎夹具知识"（同 BUG-01 教训的反面：真实引擎的画面断言必然绑定参考工程内容），改动场景需同步这里。
const TERMINAL_MASK = { x0: 110, y0: 115, x1: 520, y1: 205 };
// 微型夹具的字幕带：底部 22%（helpers-fb04 的场景把逐词卡拉OK画在 H*.86，色条在中上部，互不重叠）。
const SUBTITLE_BAND_MASK = { x0: 0, y0: 850, x1: 1920, y1: 1080 };

try {
  mkdirSync(projects, { recursive: true });
  assert.ok(existsSync(referenceBgm), `参考 BGM 不存在：${referenceBgm}`);

  // ---- 1. 独立实例：service + vite。vite 偶发静默不监听（9 轮实测 2 次），失败整组换端口重试一次。
  const boot = async (ports) => {
    vite?.kill(); service?.kill();
    servicePort = ports.service; studioPort = ports.studio;
    serviceBase = `http://127.0.0.1:${servicePort}`;
    studioBase = `http://127.0.0.1:${studioPort}`;
    log(`启动独立 service 与 vite dev server（service :${servicePort} · studio :${studioPort}）`);
    service = spawn(process.execPath, ['--no-warnings', 'src/server/index.mjs'], { cwd: root, stdio: 'pipe',
      env: { ...process.env, VIDEOGRAPH_SERVICE_PORT: String(servicePort), VIDEOGRAPH_PROJECTS: projects, VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile,
        VIDEOGRAPH_STUDIO_ORIGINS: `${serviceBase},${studioBase},http://localhost:${studioPort}` } });
    let serviceOut = '';
    service.stdout?.on('data', (chunk) => { serviceOut += chunk; });
    service.stderr?.on('data', (chunk) => { serviceOut += chunk; });
    for (let i = 0; i < 100 && !existsSync(tokenFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(existsSync(tokenFile), `工程服务未启动：${serviceOut.slice(-400)}`);
    // --host 127.0.0.1 必须显式：localhost 在本机偶发绑到 ::1，探测走 IPv4 会被拒（实测 10 轮 3 次）。
    vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--port', String(studioPort), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'pipe',
      env: { ...process.env, VITE_VIDEOGRAPH_SERVICE_URL: serviceBase } });
    let viteOut = '';
    vite.stdout?.on('data', (chunk) => { viteOut += chunk; });
    vite.stderr?.on('data', (chunk) => { viteOut += chunk; });
    let firstError = '';
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${studioBase}/`)).ok) return; } catch (error) {
        if (!firstError) firstError = `${error.cause?.code ?? error.code ?? error.message} @ ${Date.now() - t0}ms`;
        if (i === 30 || i === 80) log(`vite 探测持续失败：${error.cause?.code ?? error.code ?? error.message}`);
      }
      if (vite.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`vite dev server 未启动（studio :${studioPort}，首个错误: ${firstError || 'n/a'}）输出尾部: ${viteOut.slice(-600)}`);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await boot({ service: servicePort, studio: studioPort + attempt }); break; }
    catch (error) {
      if (attempt === 1) throw error;
      console.error(`实例启动失败，换端口重试：${error.message}`);
    }
  }

  // ---- 2. 从参考 BGM 建工程（字节指纹 → 参考导入，不进入新歌分析状态机）
  log('从参考 BGM 建工程（指纹导入）');
  const created = await http('/projects', { audioPath: referenceBgm, name: 'FB-04 端到端验收' });
  projectId = created.id;
  assert.equal(created.analysis.source, 'fingerprint-cache', '参考 BGM 应命中指纹导入');
  assert.equal(created.shots.length, 22, '参考工程应有 22 个镜头');
  assert.equal(created.transitions.length, 21, '参考工程应有 21 个转场节点');
  assert.ok(created.song.lines.some((line) => line.words?.length > 1), '分析数据应含词级歌词');
  const audioHash = createHash('sha256').update(readFileSync(referenceBgm)).digest('hex');
  assert.equal(created.audio.hash, audioHash);
  const shot = created.shots.find((entry) => entry.id === 'loss');
  assert.ok(shot && shot.end - shot.start > 4, `loss 镜头窗口过窄：${shot?.start}–${shot?.end}`);
  const baselineShots = Object.fromEntries(created.shots.map((entry) => [entry.id, { module: entry.module, inputRevision: entry.inputRevision, codeHash: entry.codeHash }]));
  results.import = { shots: created.shots.length, transitions: created.transitions.length };

  // 歌词时序断言的三个词起点：'now I'm your servant and you're my boss' 行（scene loss 的 L2）
  const l2 = created.song.lines.find((line) => /servant/.test(line.text));
  assert.ok(l2, '未找到 servant 歌词行');
  const wordTimes = ['now', 'servant', 'and'].map((w) => {
    const word = l2.words.find((entry) => entry.w.toLowerCase() === w);
    assert.ok(word, `歌词行缺词 ${w}`);
    return Math.round((word.start + 0.12) * 1000) / 1000;
  });
  assert.ok(wordTimes.every((t) => t >= shot.start && t < shot.end), '词起点应落在 loss 窗口内');

  // ---- 3. 人（浏览器）：选中镜头 → 预览 → 播放 → 定位锚点 → 带保留项的意见
  log('浏览器：添加带时间锚点与保留项的意见');
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--autoplay-policy=no-user-gesture-required', ...angleArgs()] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const pageErrors = [];
  const consoleTail = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { consoleTail.push(`[${message.type()}] ${message.text()}`); if (consoleTail.length > 40) consoleTail.shift(); });
  page.on('requestfailed', (request) => consoleTail.push(`[requestfailed] ${request.url().slice(0, 160)} ${request.failure()?.errorText}`));
  await page.goto(`${studioBase}/?view=project&project=${projectId}`);
  await page.locator('.project-shot-list button', { hasText: shot.title }).click();
  await page.getByRole('button', { name: '预览此镜头', exact: true }).click();
  const player = page.frameLocator('iframe[title="真实镜头播放器"]');
  try {
    await page.locator('iframe[title="真实镜头播放器"]').waitFor({ timeout: 30000 });
    log(`预览 iframe src: ${await page.locator('iframe[title="真实镜头播放器"]').getAttribute('src')}`);
    await player.locator('#info').filter({ hasText: /\d\.\d\ds/ }).waitFor({ timeout: 180000 });
  } catch (error) {
    const debug = join(root, '.cache/fb04-debug.png');
    await page.screenshot({ path: debug, fullPage: false }).catch(() => {});
    const infoText = await player.locator('#info').textContent().catch(() => '(no #info)');
    const errorBanner = await page.locator('.project-error').textContent().catch(() => '(no banner)');
    throw new Error(`预览未走秒：${error.message}\n#info="${infoText}"\nbanner="${errorBanner}"\nconsole 尾部:\n${consoleTail.join('\n')}\n截图: ${debug}`);
  }
  await player.locator('#c').click();
  await page.waitForTimeout(1300);
  const composer = page.locator('.project-inspector .fb-composer');
  await composer.getByRole('button', { name: '定位到当前预览时间' }).click();
  await composer.locator('.fb-chip:has-text("s")').first().waitFor({ timeout: 5000 });
  await composer.getByLabel(`${shot.title}的修改意见`).fill('终端回显行太抢戏，缩小一号');
  await composer.getByRole('button', { name: '+ 歌词时序' }).click();
  await composer.getByRole('button', { name: '添加意见，只修改此镜头' }).click();
  await page.locator('.fb-note').first().waitFor({ timeout: 10000 });
  let project = await http(`/projects/${projectId}`);
  const note = project.shots.find((entry) => entry.id === 'loss').feedback[0];
  assert.ok(note.anchor.t > shot.start && note.anchor.t < shot.end, `锚点应来自播放器且落在窗口内：${note.anchor.t}`);
  assert.deepEqual(note.preserve, ['歌词时序']);
  assert.equal(note.author, 'human');
  results.anchoredFeedback = { t: note.anchor.t, preserve: note.preserve };

  await page.reload();
  await page.locator('.project-shot-list button', { hasText: shot.title }).click();
  await page.locator('.fb-note').first().waitFor({ timeout: 30000 });
  assert.match(await page.locator('.fb-note p').first().textContent(), /终端回显行/);
  results.survivesReload = true;

  // ---- 4. agent（真实 MCP stdio）：inbox → stills → 提问；人回复
  log('MCP：inbox / stills / ask；浏览器回复澄清');
  client = new Client({ name: 'videograph-fb04-audit', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--experimental-strip-types', '--no-warnings', 'src/pdoom/mcp-server.ts'], cwd: root, stderr: 'pipe',
    env: { ...process.env, VIDEOGRAPH_SERVICE_URL: serviceBase, VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile, VIDEOGRAPH_PROJECTS: projects } }));
  const inbox = (await invoke('project_feedback_inbox', { projectId, status: 'pending' })).value;
  const item = inbox.items.find((entry) => entry.note.id === note.id);
  assert.ok(item, 'inbox 应包含新意见');
  assert.equal(item.targetKind, 'shot');
  assert.match(item.nextStep, /project_shot_submit/);
  const stillsJob = await waitJob(projectId, (await invoke('project_stills', { projectId, shotId: 'loss', times: [note.anchor.t], width: 480 })).value.id, { label: 'stills 锚点', timeout: 240000 });
  assert.equal(stillsJob.status, 'done', stillsJob.error);
  const anchorPng = join(projects, projectId, stillsJob.result.stills.images[0].file);
  assert.equal(readFileSync(anchorPng).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'stills 产物应为 PNG');
  const jobAgain = await invoke('project_job_get', { projectId, jobId: stillsJob.id });
  assert.ok(jobAgain.images.length >= 1, '完成的 stills 任务应以 image 内容返回');

  const asked = (await invoke('project_feedback_ask', { projectId, targetKind: 'shot', targetId: 'loss', feedbackId: note.id, question: '缩小是只针对终端回显行，还是整段文字层级？' })).value;
  assert.equal(asked.shots.find((entry) => entry.id === 'loss').feedback[0].status, 'needs-clarification');
  await page.locator('.fb-note[data-status="needs-clarification"]').waitFor({ timeout: 15000 });
  await page.getByLabel('回复 AI 的澄清问题').fill('只是终端回显那一行，SERVANT/BOSS 的大字别动');
  await page.getByRole('button', { name: '发送回复，意见回到待处理' }).click();
  await page.locator('.fb-note[data-status="pending"]').waitFor({ timeout: 15000 });
  project = await http(`/projects/${projectId}`);
  const noteAfterReply = project.shots.find((entry) => entry.id === 'loss').feedback[0];
  assert.equal(noteAfterReply.status, 'pending');
  assert.match(noteAfterReply.thread.at(-1).text, /SERVANT/);
  results.clarification = true;

  // ---- 5. 改写前基线：三个词起点帧（修改前版本，后续逐像素对比用）
  log('渲染词起点基线静帧（修改前）');
  const baselineWords = await waitJob(projectId, (await invoke('project_stills', { projectId, shotId: 'loss', times: wordTimes, width: 960 })).value.id, { label: 'stills 词起点基线', timeout: 300000 });
  assert.equal(baselineWords.status, 'done', baselineWords.error);
  const baselineFiles = baselineWords.result.stills.images.map((image) => image.file);

  // ---- 6. agent 改写 + 逐条响应 + 校验；断言只动目标镜头
  log('MCP：读取源码 → 外科式改写 → submit(feedbackResponses) → validate');
  const source = (await invoke('project_shot_source', { projectId, shotId: 'loss' })).value;
  const originalCode = source.code;
  const needle = 'typed(wNow, 150, 168, 36';
  assert.ok(originalCode.includes(needle), 'loss 源码缺少预期的改写锚点（参考引擎内容漂移？）');
  const editedCode = originalCode.replace(needle, 'typed(wNow, 150, 168, 24');
  assert.notEqual(originalCode, editedCode);
  const revisionBeforeSubmit = (await http(`/projects/${projectId}`)).shots.find((entry) => entry.id === 'loss').inputRevision;
  const submitted = (await invoke('project_shot_submit', { projectId, shotId: 'loss', expectedInputRevision: revisionBeforeSubmit, code: editedCode,
    summary: '终端回显行 36→24 号字，SERVANT/BOSS 大字与卡拉OK时序不动',
    feedbackResponses: [{ feedbackId: note.id, outcome: 'addressed', how: 'typed(wNow) 字号 36→24；歌词字形与时序零改动' }] })).value;
  const responded = submitted.shots.find((entry) => entry.id === 'loss').feedback[0];
  assert.equal(responded.status, 'responded');
  assert.equal(responded.response.outcome, 'addressed');
  assert.match(responded.response.how, /36→24/);
  project = await http(`/projects/${projectId}`);
  const afterSubmit = Object.fromEntries(project.shots.map((entry) => [entry.id, { module: entry.module, inputRevision: entry.inputRevision, codeHash: entry.codeHash }]));
  for (const [id, before] of Object.entries(baselineShots)) {
    if (id === 'loss') continue;
    assert.deepEqual(afterSubmit[id], before, `镜头 ${id} 不应被改动`);
  }
  assert.notEqual(afterSubmit.loss.module, 'loss', '提交应产生新的不可变模块文件名');
  assert.notEqual(afterSubmit.loss.codeHash, baselineShots.loss.codeHash ?? undefined, '目标镜头 codeHash 应改变');
  results.isolatedRewrite = true;

  const validate = await waitJob(projectId, (await invoke('project_validate', { projectId, shotId: 'loss' })).value.id, { label: 'validate', timeout: 300000 });
  assert.equal(validate.status, 'done', validate.error);

  // ---- 7. 导出拦截：存在未接受意见 → 409
  const blocked = await http('/projects/' + projectId + '/render', {}, { expectError: true });
  assert.equal(blocked.status, 409, `未接受意见时导出应 409：${JSON.stringify(blocked.data)}`);
  assert.match(String(blocked.data.error), /未接受/);
  results.exportBlocked = true;

  // ---- 8. 人拒绝候选：恢复修改前版本；旧候选不可被接受
  log('浏览器：拒绝候选 → 恢复修改前版本');
  project = await http(`/projects/${projectId}`);
  const lossNow = project.shots.find((entry) => entry.id === 'loss');
  await page.locator('.project-shot-list button', { hasText: shot.title }).click();
  await page.getByRole('button', { name: '不采用候选，恢复修改前版本' }).click();
  await page.locator('.fb-note[data-status="pending"]').waitFor({ timeout: 15000 });
  project = await http(`/projects/${projectId}`);
  const afterReject = project.shots.find((entry) => entry.id === 'loss');
  assert.equal(afterReject.source, 'reference-import', '拒绝后应恢复参考源码');
  assert.equal(afterReject.module, 'loss', '拒绝后应恢复原模块映射');
  assert.equal(afterReject.codeHash, undefined, '拒绝后候选 codeHash 应清除');
  assert.equal(afterReject.feedback[0].status, 'pending', '拒绝后意见回到待处理');
  assert.ok(afterReject.feedback[0].responseHistory?.length >= 1, '被作废的响应应进入意见的 responseHistory');
  const staleAccept = await http(`/projects/${projectId}/shots/loss/accept-feedback`, { expectedInputRevision: afterReject.inputRevision, feedbackIds: [note.id] }, { expectError: true });
  assert.equal(staleAccept.status, 409, '拒绝后旧候选不可被接受');
  results.rejectRestores = true;

  // ---- 9. agent 再次改写（新候选）→ 校验；过期版本接受 409
  log('MCP：重新提交候选并校验');
  project = await http(`/projects/${projectId}`);
  const revision2 = project.shots.find((entry) => entry.id === 'loss').inputRevision;
  await invoke('project_shot_submit', { projectId, shotId: 'loss', expectedInputRevision: revision2, code: editedCode,
    summary: '同一改写的新候选', feedbackResponses: [{ feedbackId: note.id, outcome: 'addressed', how: 'typed(wNow) 字号 36→24' }] });
  const staleRevisionAccept = await http(`/projects/${projectId}/shots/loss/accept-feedback`, { expectedInputRevision: revision2, feedbackIds: [note.id] }, { expectError: true });
  assert.equal(staleRevisionAccept.status, 409, '提交后版本已变，旧版本号接受必须 409');
  await waitJob(projectId, (await invoke('project_validate', { projectId, shotId: 'loss' })).value.id, { label: 'validate#2', timeout: 300000 });
  project = await http(`/projects/${projectId}`);
  assert.equal(project.shots.find((entry) => entry.id === 'loss').status, 'ready');
  results.staleAccept409 = true;

  // ---- 10. 修改前版本仍可预览；人并排对比后采用
  log('浏览器：并排对比 → 采用');
  const beforePreview = await http(`/projects/${projectId}/preview`, { shotId: 'loss', version: 'before-feedback' });
  assert.ok(beforePreview.url, '修改前版本预览应可用');
  project = await http(`/projects/${projectId}`);
  await page.locator('.project-shot-list button', { hasText: shot.title }).click();
  await page.getByRole('button', { name: '并排对比，采用或拒绝' }).click();
  const modal = page.locator('.fb-compare-modal');
  await modal.waitFor({ timeout: 15000 });
  await modal.locator('.fb-compare-column[data-version="current"] img').waitFor({ timeout: 240000 });
  await modal.locator('.fb-compare-column[data-version="before-feedback"] img').waitFor({ timeout: 240000 });
  assert.notEqual(await modal.locator('.fb-compare-column[data-version="current"] img').getAttribute('src'),
    await modal.locator('.fb-compare-column[data-version="before-feedback"] img').getAttribute('src'), '两列应为不同版本产物');
  await modal.getByLabel('我已检查当前候选').check();
  await modal.getByRole('button', { name: /我已对比，采用这个修改/ }).click();
  await modal.waitFor({ state: 'hidden', timeout: 30000 });
  project = await http(`/projects/${projectId}`);
  const lossFinal = project.shots.find((entry) => entry.id === 'loss');
  assert.equal(lossFinal.feedback[0].status, 'accepted', '采用后意见应为 accepted');
  assert.equal(lossFinal.source, 'mcp-authored');
  results.adopted = true;

  // ---- 11. 导出放行：参考工程 156s 全片渲染过重（HTTP 只许 fps 24/30/60，3759 帧），
  //      这里以「202 受理 + 立即取消」证明意见接受后导出闸门放行；完整导出与清单断言在微型工程（步骤 13）。
  log('HTTP：导出受理（202）→ 取消，验证放行');
  const releaseJob = await http(`/projects/${projectId}/render`, { fps: 24 });
  assert.equal(releaseJob.status, 'queued', '采用后导出应被受理');
  await http(`/projects/${projectId}/jobs/${releaseJob.id}/cancel`, {});
  // 任务可能在取消到达前已被派发：进程侧异步中止，轮询到终态为止。
  let cancelledJob = null;
  for (let i = 0; i < 40; i++) {
    cancelledJob = await http(`/projects/${projectId}/jobs/${releaseJob.id}`);
    if (['cancelled', 'error'].includes(cancelledJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(cancelledJob.status, 'cancelled', `取消后任务应为 cancelled（得到 ${cancelledJob.status}）`);
  results.exportGateOpen = true;

  // ---- 12. 保留项（歌词时序）逐像素证明：改写后当前版本 vs 修改前基线，三个词起点帧
  log('逐像素对比词起点帧（保留项验证）');
  const currentWords = await waitJob(projectId, (await invoke('project_stills', { projectId, shotId: 'loss', times: wordTimes, width: 960 })).value.id, { label: 'stills 词起点当前', timeout: 300000 });
  assert.equal(currentWords.status, 'done', currentWords.error);
  const currentFiles = currentWords.result.stills.images.map((image) => image.file);
  const wordPage = await browser.newPage();
  const comparisons = [];
  for (const [index, t] of wordTimes.entries()) {
    const diff = await diffStills(wordPage, projectId, baselineFiles[index], currentFiles[index], TERMINAL_MASK);
    comparisons.push({ t, ...diff });
    assert.ok(diff.inside > 50, `t=${t}：终端行区域应有可见差异（inside=${diff.inside}）`);
    assert.ok(diff.outside / (diff.w * diff.h) <= 0.003, `t=${t}：掩码外应逐像素一致（outside=${diff.outside}，${((diff.outside / (diff.w * diff.h)) * 100).toFixed(4)}%）——歌词时序/卡拉OK状态不得变化`);
  }
  await wordPage.close();
  results.lyricTiming = comparisons;
  assert.deepEqual(pageErrors, [], '页面不应有未捕获错误');

  // ---- 13. 微型工程：完整导出 + 导出清单记录新版本 + 二次导出全缓存命中
  //      （浏览器人机流程已在参考工程全程验证；此处走同一 HTTP/MCP 契约，见 ui-feedback.audit 的等价性验收。）
  log('微型工程：意见闭环 → 完整导出（8s×24fps）→ 清单/缓存断言');
  const microId = createStreamProject(projects, referenceBgm);
  const microBefore = await http(`/projects/${microId}`);
  const microLyricsBefore = JSON.stringify(microBefore.song.lines);
  const microShotA0 = microBefore.shots.find((entry) => entry.id === 'a');
  await http(`/projects/${microId}/shots/a/feedback`, { text: '色条换个冷色', anchor: { t: 1.5 }, preserve: ['歌词时序'], expectedInputRevision: microShotA0.inputRevision });
  const microNote = (await http(`/projects/${microId}`)).shots.find((entry) => entry.id === 'a').feedback[0];
  assert.equal(microNote.anchor.t, 1.5);
  const microSource = (await invoke('project_shot_source', { projectId: microId, shotId: 'a' })).value;
  assert.ok(microSource.code.includes('const HUE = 18;'), '微型场景缺少 HUE 锚点');
  await invoke('project_shot_submit', { projectId: microId, shotId: 'a', expectedInputRevision: microSource.shot.inputRevision,
    code: microSource.code.replace('const HUE = 18;', 'const HUE = 205;'), summary: '色条 18→205',
    feedbackResponses: [{ feedbackId: microNote.id, outcome: 'addressed', how: 'HUE 18→205，字幕带不动' }] });
  await waitJob(microId, (await invoke('project_validate', { projectId: microId, shotId: 'a' })).value.id, { label: 'micro validate', timeout: 240000 });
  const microReady = await http(`/projects/${microId}`);
  const microShotA = microReady.shots.find((entry) => entry.id === 'a');
  await http(`/projects/${microId}/shots/a/accept-feedback`, { expectedInputRevision: microShotA.inputRevision, feedbackIds: [microNote.id] });
  const microAccepted = await http(`/projects/${microId}`);
  assert.equal(microAccepted.shots.find((entry) => entry.id === 'a').feedback[0].status, 'accepted');
  assert.equal(JSON.stringify(microAccepted.song.lines), microLyricsBefore, '整个闭环不得改动歌词数据');

  const microExport = await waitJob(microId, (await http(`/projects/${microId}/render`, {})).id, { label: 'micro export', timeout: 600000 });
  assert.equal(microExport.status, 'done', microExport.error);
  const microManifest = JSON.parse(readFileSync(join(projects, microId, microExport.result.file, '..', 'manifest.json'), 'utf8'));
  // 清单记录的是入队时冻结的版本（导出发布校验还会再递增工程版本），应等于采用后入队那一刻的 revision。
  assert.equal(microManifest.revision, microAccepted.revision, '导出清单应记录采用后的工程版本');
  assert.equal(microManifest.frames, Math.round(8 * 24), '帧数应为 曲长×fps（8s×24）');
  assert.equal(microManifest.audioHash, audioHash, '清单应记录 BGM 指纹');
  assert.equal(microManifest.reports.length, 2);
  assert.ok(microManifest.reports.every((entry) => !entry.cached && entry.key), '首次导出两个镜头都应有新渲染分段');
  const microAgain = await waitJob(microId, (await http(`/projects/${microId}/render`, {})).id, { label: 'micro export#2', timeout: 600000 });
  assert.equal(microAgain.status, 'done', microAgain.error);
  assert.ok(microAgain.result.reports.every((entry) => entry.cached), '二次导出应全部命中分段缓存');

  const microPage = await browser.newPage();
  const microWords = microBefore.song.lines[0].words.map((word) => Math.round((word.start + .1) * 1000) / 1000);
  const microBaseline = await waitJob(microId, (await invoke('project_stills', { projectId: microId, shotId: 'a', times: microWords, version: 'before-feedback', width: 960 })).value.id, { label: 'micro stills before', timeout: 240000 });
  const microCurrent = await waitJob(microId, (await invoke('project_stills', { projectId: microId, shotId: 'a', times: microWords, width: 960 })).value.id, { label: 'micro stills current', timeout: 240000 });
  const microComparisons = [];
  for (const [index, t] of microWords.entries()) {
    const diff = await diffStills(microPage, microId, microBaseline.result.stills.images[index].file, microCurrent.result.stills.images[index].file, SUBTITLE_BAND_MASK);
    microComparisons.push({ t, ...diff });
    assert.ok(diff.inside / (diff.w * diff.h) <= 0.001, `micro t=${t}：字幕带应逐像素一致（inside=${diff.inside}）——歌词时序未变`);
    assert.ok(diff.outside > 200, `micro t=${t}：色条区域应可见变化（outside=${diff.outside}）`);
  }
  await microPage.close();
  results.micro = { manifest: { revision: microManifest.revision, frames: microManifest.frames }, secondRunAllCached: true, lyricTiming: microComparisons };

  log('微型工程：只改镜头 a → 导出验证只重渲一镜');
  const latest = (await invoke('project_shot_source', { projectId: microId, shotId: 'a' })).value;
  await invoke('project_shot_submit', { projectId: microId, shotId: 'a', expectedInputRevision: latest.shot.inputRevision,
    code: latest.code.replace('const HUE = 205;', 'const HUE = 110;'), summary: 'incremental render cache regression' });
  await waitJob(microId, (await invoke('project_validate', { projectId: microId, shotId: 'a' })).value.id, { label: 'micro incremental validate' });
  const changed = await waitJob(microId, (await http(`/projects/${microId}/render`, {})).id, { label: 'micro export#3' });
  assert.equal(changed.status, 'done', changed.error);
  assert.equal(changed.result.cacheSummary.rendered, 1);
  assert.equal(changed.result.cacheSummary.reused, 1);
  const changedReport = changed.result.reports.find((entry) => !entry.cached);
  assert.ok(changedReport.missReason.includes('code'), JSON.stringify(changedReport));
  results.micro.incrementalCache = changed.result.cacheSummary;

  console.log(JSON.stringify({ ok: true, projectId, microId, servicePort, studioPort, ...results }, null, 2));
  console.log(`FB-04 端到端验收全绿，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  rmSync(tmp, { recursive: true, force: true });
} catch (error) {
  console.error(`（失败：临时现场保留在 ${tmp} 供排查）`);
  throw error;
} finally {
  await client?.close().catch(() => {});
  await browser?.close().catch(() => {});
  vite?.kill();
  service?.kill();
}

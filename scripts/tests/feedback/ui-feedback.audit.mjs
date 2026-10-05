// ui-feedback.audit.mjs — FB-02 验收：无头 Edge + 独立临时工程目录 + 独立端口服务 + 独立 dev server。
// 覆盖：添加带锚点/保留项意见（时间来自预览播放器 postMessage）→ 刷新后仍在 → 回复澄清 → 对比后采用。
// 运行：node scripts/tests/feedback/ui-feedback.audit.mjs（引擎为 helpers.mjs 的 canvas 2D 夹具，见 ROADMAP FB-02 备注）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createFixtureProject, fixtureScene } from './helpers.mjs';
import { freePort } from '../helpers/free-port.mjs';
import { browserPath, angleArgs } from '../../../src/server/browser.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'videograph-fb02-ui-'));
const projects = join(tmp, 'projects');
const tokenFile = join(tmp, 'service-token');
const servicePort = await freePort();
const studioPort = await freePort();
const serviceBase = `http://127.0.0.1:${servicePort}`;
const studioBase = `http://127.0.0.1:${studioPort}`;
let service, vite, browser;
const results = {};

async function http(path, body, token) {
  const response = await fetch(serviceBase + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.ok(response.ok, `${path} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

try {
  mkdirSync(projects, { recursive: true });
  const projectId = createFixtureProject(projects);
  service = spawn(process.execPath, ['--no-warnings', 'src/server/index.mjs'], { cwd: root, stdio: 'pipe',
    env: { ...process.env, VIDEOGRAPH_SERVICE_PORT: String(servicePort), VIDEOGRAPH_PROJECTS: projects, VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile,
      VIDEOGRAPH_STUDIO_ORIGINS: `${serviceBase},${studioBase},http://localhost:${studioPort}` } });
  for (let i = 0; i < 100 && !existsSync(tokenFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(existsSync(tokenFile), '工程服务未启动');
  const token = readFileSync(tokenFile, 'utf8');
  vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--port', String(studioPort), '--strictPort'], { cwd: root, stdio: 'pipe',
    env: { ...process.env, VITE_VIDEOGRAPH_SERVICE_URL: serviceBase } });
  for (let i = 0; i < 150; i++) {
    try { const probe = await fetch(`${studioBase}/`); if (probe.ok) break; } catch { /* 等待 dev server 就绪 */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(i < 149, 'vite dev server 未启动');
  }

  browser = await chromium.launch({ headless: true, executablePath: browserPath(), args: ['--autoplay-policy=no-user-gesture-required', ...angleArgs()] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${studioBase}/?view=project&project=${projectId}`);
  await page.waitForSelector('.project-inspector .fb-composer', { timeout: 60000 });
  const composer = page.locator('.project-inspector .fb-composer');

  // 1. 打开预览 → 等夹具引擎模块就绪 → 播放 → 播放器广播时间 → 定位到当前预览时间。
  await page.getByRole('button', { name: '预览此镜头', exact: true }).click();
  const player = page.frameLocator('iframe[title="真实镜头播放器"]');
  await player.locator('body.vg-ready').waitFor({ timeout: 60000 });
  await player.locator('#c').click();
  await page.waitForTimeout(1100);
  const locate = composer.getByRole('button', { name: '定位到当前预览时间' });
  await locate.waitFor({ state: 'visible', timeout: 20000 });
  await assert.doesNotReject(() => locate.click(), '时间未广播或按钮不可用');
  await composer.locator('.fb-chip:has-text("s")').first().waitFor({ timeout: 5000 });

  // 2. 填写正文 / 元素 / 保留项并提交。
  await composer.getByLabel('火花窗口的修改意见').fill('火花再亮一点');
  await composer.getByLabel('选择火花窗口的歌词元素').selectOption('el-spark');
  await composer.getByRole('button', { name: '+ 歌词时序' }).click();
  await composer.getByRole('button', { name: '添加意见，只修改此镜头' }).click();
  await page.waitForSelector('.fb-note', { timeout: 10000 });
  let project = await http(`/projects/${projectId}`, undefined, token);
  const note = project.shots[0].feedback[0];
  assert.ok(note.anchor.t > 0 && note.anchor.t < 4, `时间锚点应来自播放器（得到 ${note.anchor.t}）`);
  assert.equal(note.anchor.lyricElementId, 'el-spark');
  assert.equal(note.anchor.aspect, undefined);
  assert.deepEqual(note.preserve, ['歌词时序']);
  assert.equal(note.author, 'human');
  results.anchoredFeedback = note.anchor;

  // 3. 刷新后意见仍在。
  await page.reload();
  await page.waitForSelector('.fb-note', { timeout: 30000 });
  assert.match(await page.locator('.fb-note p').first().textContent(), /火花再亮一点/);
  results.survivesReload = true;

  // 4. agent 提问（走 MCP 同一 HTTP 契约）→ 人在界面回复。
  project = await http(`/projects/${projectId}/shots/a/feedback/${note.id}/ask`, { question: '亮到什么程度？' }, token);
  assert.equal(project.shots[0].feedback[0].status, 'needs-clarification');
  await page.locator('.fb-note[data-status="needs-clarification"]').waitFor({ timeout: 10000 });
  await page.getByLabel('回复 AI 的澄清问题').fill('和信号橙一样亮');
  await page.getByRole('button', { name: '发送回复，意见回到待处理' }).click();
  await page.locator('.fb-note[data-status="pending"]').waitFor({ timeout: 10000 });
  project = await http(`/projects/${projectId}`, undefined, token);
  assert.equal(project.shots[0].feedback[0].status, 'pending');
  assert.match(project.shots[0].feedback[0].thread[1].text, /信号橙/);
  results.clarificationReplied = true;

  // 5. agent 改写 + 校验（真实渲染进程与夹具引擎）→ 界面进入待确认。
  project = await http(`/projects/${projectId}/shots/a/source`, { expectedInputRevision: project.shots[0].inputRevision,
    code: fixtureScene(320), summary: 'audit 改写', author: 'mcp',
    feedbackResponses: [{ feedbackId: note.id, how: '色相 18→320 并提亮' }] }, token);
  assert.equal(project.shots[0].feedback[0].response.how, '色相 18→320 并提亮');
  const validate = await http(`/projects/${projectId}/validate`, { shotId: 'a' }, token);
  for (let i = 0; i < 120; i++) {
    const job = await http(`/projects/${projectId}/jobs/${validate.id}`, undefined, token);
    if (job.status === 'done') break;
    if (job.status === 'error' || job.status === 'cancelled') throw new Error(job.error);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.ok(i < 119, '校验任务超时');
  }
  project = await http(`/projects/${projectId}`, undefined, token);
  assert.equal(project.shots[0].status, 'ready');

  // 6. 并排对比：静帧两列 → 双播放器 → 确认后采用。
  const openCompare = page.getByRole('button', { name: '并排对比，采用或拒绝' });
  await openCompare.waitFor({ timeout: 15000 });
  await openCompare.click();
  const modal = page.locator('.fb-compare-modal');
  await modal.waitFor({ timeout: 10000 });
  // 两列各是一个 stills 任务，服务按队列串行渲染；逐列等待，超时给足。
  await modal.locator('.fb-compare-column[data-version="current"] img').waitFor({ timeout: 90000 });
  await modal.locator('.fb-compare-column[data-version="before-feedback"] img').waitFor({ timeout: 90000 });
  assert.equal(await modal.locator('.fb-compare-column[data-version="current"] img').count(), 1, '当前候选列应有静帧');
  assert.equal(await modal.locator('.fb-compare-column[data-version="before-feedback"] img').count(), 1, '修改前列应有静帧');
  const currentSrc = await modal.locator('.fb-compare-column[data-version="current"] img').getAttribute('src');
  const beforeSrc = await modal.locator('.fb-compare-column[data-version="before-feedback"] img').getAttribute('src');
  assert.notEqual(currentSrc, beforeSrc, '两列应是不同版本的产物');
  assert.match(String(currentSrc), /artifacts\//);
  await modal.getByRole('tab', { name: '双播放器' }).click();
  await modal.locator('iframe[title="当前候选播放器"]').waitFor({ timeout: 20000 });
  await modal.locator('iframe[title="修改前播放器"]').waitFor({ timeout: 20000 });
  await modal.getByRole('tab', { name: '静帧对比' }).click();
  await modal.locator('.fb-compare-column img').first().waitFor({ timeout: 20000 });
  await modal.getByLabel('我已检查当前候选').check();
  await modal.getByRole('button', { name: /采用这个修改/ }).click();
  await modal.waitFor({ state: 'hidden', timeout: 15000 });
  project = await http(`/projects/${projectId}`, undefined, token);
  assert.equal(project.shots[0].feedback[0].status, 'accepted', '采用后意见应为 accepted');
  assert.deepEqual(errors, []);
  results.compareAdopted = true;
  console.log(JSON.stringify({ ok: true, projectId, ...results, errors }, null, 2));
} finally {
  await browser?.close();
  vite?.kill();
  service?.kill();
  rmSync(tmp, { recursive: true, force: true });
}

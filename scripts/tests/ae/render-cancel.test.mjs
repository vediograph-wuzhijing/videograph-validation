// 回归：导出渲染中途取消后，分段编码器（ffmpeg，读 stdin）必须随取消退出、渲染进程结束，后续任务不被卡住。
// 夹具引擎为 feedback/helpers.mjs 的 canvas 2D 小引擎；samples=12 拉长渲染，保证取消时编码器正在等帧。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixtureProject } from '../feedback/helpers.mjs';
import { freePort } from '../helpers/free-port.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'videograph-cancel-'));
const projects = join(tmp, 'projects');
const tokenFile = join(tmp, 'service-token');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let service, client, projectId;

async function invoke(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const texts = response.content.filter((item) => item.type === 'text').map((item) => item.text);
  if (response.isError) throw new Error(texts.join('\n'));
  return JSON.parse(texts[0]);
}

before(async () => {
  mkdirSync(projects, { recursive: true });
  projectId = createFixtureProject(projects, { name: 'cancel fixture' });
  service = spawn(process.execPath, ['--no-warnings', 'src/server/index.mjs'], { cwd: root, stdio: 'pipe',
    env: { ...process.env, VIDEOGRAPH_SERVICE_PORT: String(port), VIDEOGRAPH_PROJECTS: projects, VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile, VIDEOGRAPH_STUDIO_ORIGINS: `http://127.0.0.1:${port}` } });
  for (let i = 0; i < 100 && !existsSync(tokenFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!existsSync(tokenFile)) throw new Error('工程服务未启动');
  client = new Client({ name: 'videograph-cancel-audit', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', 'src/pdoom/mcp-server.ts'], cwd: root,
    env: { ...process.env, VIDEOGRAPH_SERVICE_URL: base, VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile, VIDEOGRAPH_PROJECTS: projects }, stderr: 'pipe' }));
});
after(async () => {
  await client?.close().catch(() => {});
  service?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test('project_job_cancel：导出渲染中途取消后，编码器随之退出，后续任务继续执行', async () => {
  const render = await invoke('project_render', { projectId, fps: 30, samples: 12 });
  let job = render;
  for (let i = 0; i < 400; i++) {
    job = await invoke('project_job_get', { projectId, jobId: render.id });
    if (job.status === 'running' && job.progress > 0) break;
    if (['done', 'error', 'cancelled'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(job.status, 'running', `导出应已进入逐帧渲染：${JSON.stringify(job).slice(0, 300)}`);
  await invoke('project_job_cancel', { projectId, jobId: render.id });
  const cancelled = await invoke('project_job_get', { projectId, jobId: render.id, waitSeconds: 20 });
  assert.equal(cancelled.status, 'cancelled');
  // 渲染进程若因编码器未退出而挂住，下面的只读任务会一直排队
  const sheet = await invoke('project_contact_sheet', { projectId, waitSeconds: 45 });
  assert.equal(sheet.status, 'done', `取消后队列应继续：${JSON.stringify(sheet).slice(0, 300)}`);
});

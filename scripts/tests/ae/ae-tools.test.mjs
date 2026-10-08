// AE-01～06 端到端：真实 stdio MCP + 独立端口工程服务 + 渲染进程（无头 Edge）+ 临时工程目录。
// 引擎为 feedback/helpers.mjs 的 canvas 2D 夹具；镜头 a 换成“下拍闪白”场景，节奏报告必须测出下拍命中。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixtureProject } from '../feedback/helpers.mjs';
import { freePort } from '../helpers/free-port.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'videograph-ae-'));
const projects = join(tmp, 'projects');
const tokenFile = join(tmp, 'service-token');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let service, client, projectId;

// 下拍（每 2 秒）闪白 3 帧，其余时间是缓慢移动的小方块：运动峰只出现在下拍。
const pulseScene = `export default class PulseScene {
  render(f, out) {
    const phase = f.t % 2;
    out.fillStyle = phase < 0.1 ? '#f4f1ea' : '#15171c';
    out.fillRect(0, 0, f.W, f.H);
    out.fillStyle = '#ff4d12';
    out.fillRect(40 + (f.t * 20) % 400, f.H * 0.45, 60, 60);
  }
}
`;

function fixtureSong() {
  const beats = [], downbeats = [], kick = [], snare = [];
  for (let t = 0; t < 8 - 1e-9; t += 0.5) { beats.push(t); if (t % 2 === 0) { downbeats.push(t); kick.push([t, 0.9]); } else if (t % 1 === 0) snare.push([t, 0.7]); }
  const rms = Array.from({ length: 240 }, (_, i) => 0.3 + 0.4 * Math.exp(-((i / 30) % 2) * 3));
  return { song: 'ae fixture', bpm: 120, duration: 8, envFps: 30, beats, downbeats, kick, snare, rms, drums: rms, low: rms, mid: rms, high: rms, vocal: rms.map(() => 0),
    sections: [{ name: 'verse', start: 0, end: 4 }, { name: 'chorus', start: 4, end: 8 }],
    lines: [{ lineIndex: 0, text: 'sparks fly tonight', start: 0.5, end: 3.5, words: [{ w: 'sparks', start: 0.5, end: 1.1 }, { w: 'fly', start: 1.1, end: 1.6 }, { w: 'tonight', start: 1.6, end: 3.5 }] }] };
}

async function invoke(name, args, expectError = false) {
  const response = await client.callTool({ name, arguments: args });
  const texts = response.content.filter((item) => item.type === 'text').map((item) => item.text);
  if (expectError) { assert.equal(response.isError, true, texts.join('\n')); return texts.join('\n'); }
  if (response.isError) throw new Error(texts.join('\n'));
  return { value: JSON.parse(texts[0]), text: texts[1] ?? null, images: response.content.filter((item) => item.type === 'image') };
}
const pngWidth = (base64) => Buffer.from(base64, 'base64').readUInt32BE(16);

before(async () => {
  mkdirSync(projects, { recursive: true });
  projectId = createFixtureProject(projects, { name: 'ae fixture' });
  writeFileSync(join(projects, projectId, 'engine/app/src/scenes/pulse.ts'), pulseScene);
  const db = new DatabaseSync(join(projects, projectId, 'project.sqlite'));
  const project = JSON.parse(db.prepare('SELECT data FROM project WHERE id=1').get().data);
  project.song = fixtureSong();
  project.shots[0].module = 'pulse';
  db.prepare('UPDATE project SET data=? WHERE id=1').run(JSON.stringify(project));
  db.close();
  service = spawn(process.execPath, ['--no-warnings', 'src/server/index.mjs'], { cwd: root, stdio: 'pipe',
    env: { ...process.env, VIDEOGRAPH_SERVICE_PORT: String(port), VIDEOGRAPH_PROJECTS: projects, VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile, VIDEOGRAPH_STUDIO_ORIGINS: `http://127.0.0.1:${port}` } });
  for (let i = 0; i < 100 && !existsSync(tokenFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!existsSync(tokenFile)) throw new Error('工程服务未启动');
  client = new Client({ name: 'videograph-ae-audit', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', 'src/pdoom/mcp-server.ts'], cwd: root,
    env: { ...process.env, VIDEOGRAPH_SERVICE_URL: base, VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile, VIDEOGRAPH_PROJECTS: projects }, stderr: 'pipe' }));
});
after(async () => {
  await client?.close().catch(() => {});
  service?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test('注册：server 名、AE 工具、resources 与 prompts', async () => {
  assert.equal(client.getServerVersion()?.name, 'videograph');
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['song_cue_sheet', 'project_filmstrip', 'project_contact_sheet', 'project_rhythm_report', 'craft_guide', 'project_shot_submit']) assert.ok(names.includes(name), `${name} 未注册`);
  const resources = (await client.listResources()).resources.map((resource) => resource.uri);
  assert.ok(resources.includes('videograph://docs/mcp-guide'));
  assert.ok(resources.includes('videograph://skills/shotcraft/references/transitions.md'));
  assert.ok(resources.includes('videograph://skills/videograph-create/SKILL.md'));
  assert.ok(resources.includes('videograph://skills/videograph-create/aesthetic-review.md'));
  assert.ok(names.includes('project_director_next'));
  assert.ok(names.includes('song_analysis_patch'));
  const guide = await client.readResource({ uri: 'videograph://skills/shotcraft/SKILL.md' });
  assert.match(guide.contents[0].text, /五条通用法则/);
  const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
  assert.deepEqual(prompts.sort(), ['design_rhythm', 'direct_video', 'respond_to_feedback']);
  const prompt = await client.getPrompt({ name: 'respond_to_feedback', arguments: { projectId } });
  assert.match(prompt.messages[0].content.text, /project_feedback_inbox|收件箱/);
  assert.match(prompt.messages[0].content.text, /AI 不能接受意见/);
});

test('craft_guide：按 topic/query 返回技法节选（不需要工程服务）', async () => {
  const { value, text } = await invoke('craft_guide', { topic: 'transitions', query: 'handshake' });
  assert.equal(value.file, 'references/transitions.md');
  assert.match(text, /handshake/);
  assert.ok(text.length <= 12000);
});

test('song_cue_sheet：小节文本节奏表，含段首、鼓点、歌词与切点', async () => {
  const { value, text } = await invoke('song_cue_sheet', { projectId });
  assert.equal(value.bars, 4);
  assert.match(text, /▶chorus 1\/2/);
  assert.match(text, /K\. \.\. S\. \.\./); // kick 在第 1 拍、snare 在第 3 拍
  assert.match(text, /sparks fly tonight/);
  assert.match(text, /✂2@4\.00/);
});

test('project_filmstrip：around 下拍 ±3 帧，单张网格图', async () => {
  const { value, images } = await invoke('project_filmstrip', { projectId, around: 2, frames: 3, thumbWidth: 240, waitSeconds: 50 });
  assert.equal(value.status, 'done', value.error);
  assert.equal(value.result.times.length, 7);
  assert.match(value.result.labels[3], /2\.00s {2}2\.1 {2}●下拍 K/);
  assert.equal(images.length, 1);
  assert.equal(pngWidth(images[0].data), 6 * 240 + 7 * 6, '6 列 × 240px + 间距');
});

test('project_contact_sheet：全片每镜头一帧', async () => {
  const { value, images } = await invoke('project_contact_sheet', { projectId, waitSeconds: 50 });
  assert.equal(value.status, 'done', value.error);
  assert.equal(value.result.shots.length, 2);
  assert.equal(images.length, 1);
});

test('project_contact_sheet：指定跨镜头时间，保持输入顺序与标签', async () => {
  const selections = [{shotId:'b',t:5.25},{shotId:'a',t:1.25},{shotId:'b',t:6.5}];
  const { value, images } = await invoke('project_contact_sheet', {projectId,selections,waitSeconds:50});
  assert.equal(value.status,'done',value.error);
  assert.deepEqual(value.result.selections, selections);
  assert.deepEqual(value.result.shots.map(s=>s.id), ['b','a','b']);
  assert.equal(images.length,1);
});

test('project_rhythm_report：下拍闪白镜头命中下拍；全片报告与对照图', async () => {
  const shot = await invoke('project_rhythm_report', { projectId, shotId: 'a', waitSeconds: 50 });
  assert.equal(shot.value.status, 'done', shot.value.error);
  assert.equal(shot.value.result.metrics.hits.downbeat.rate, 1, shot.text);
  assert.equal(shot.value.result.metrics.flash.risk, false);
  assert.match(shot.text, /节奏报告 · 镜头 a/);
  assert.equal(shot.images.length, 1);

  const whole = await invoke('project_rhythm_report', { projectId, sampleFps: 15, waitSeconds: 50 });
  assert.equal(whole.value.status, 'done', whole.value.error);
  const metrics = whole.value.result.metrics;
  assert.equal(metrics.frames, 120);
  assert.ok(metrics.hits.downbeat.rate < 1, '镜头 b 没有下拍反应，全片命中率应下降');
  assert.ok(metrics.cuts.some((cut) => cut.shotId === 'b' && cut.toDownbeatMs === 0));
  assert.match(whole.text, /逐小节/);

  const cached = await invoke('project_rhythm_report', { projectId, shotId: 'a', waitSeconds: 50 });
  assert.equal(cached.value.result.report, shot.value.result.report, '相同输入命中缓存');
});

test('project_job_get waitSeconds：阻塞到任务结束', async () => {
  const { value: queued } = await invoke('project_filmstrip', { projectId, shotId: 'b', waitSeconds: 0 });
  assert.equal(queued.status, 'queued');
  const { value } = await invoke('project_job_get', { projectId, jobId: queued.id, waitSeconds: 50 });
  assert.equal(value.status, 'done', value.error);
});

test('参数校验：帧数上限、越界时间、未知镜头', async () => {
  assert.match(await invoke('project_filmstrip', { projectId, sampleFps: 30, waitSeconds: 0 }, true), /超出 1\.\.24/);
  assert.match(await invoke('project_filmstrip', { projectId, shotId: 'a', around: 6, waitSeconds: 0 }, true), /around 必须落在/);
  assert.match(await invoke('project_rhythm_report', { projectId, shotId: 'nope', waitSeconds: 0 }, true), /shot not found/);
  assert.match(await invoke('project_contact_sheet', { projectId, ratios: [0.1, 0.2, 0.3, 0.4], waitSeconds: 0 }, true), /ratios/);
});

// 导演功能端到端：真实 stdio MCP + 独立 HTTP 工程服务 + 临时工程 + 真实渲染任务。
// 夹具只验证协议、版本、任务和媒体管线；不代表 GLM 或人工审美验收。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixtureProject, fixtureScene } from '../feedback/helpers.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'videograph-director-mcp-'));
const projects = join(tmp, 'projects');
const tokenFile = join(tmp, 'service-token');
const port = 6000 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let service;
let client;
let projectId;

const silentWav = join(tmp, 'silence.wav');
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';

function makeSilentAudio() {
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '8', '-c:a', 'pcm_s16le', silentWav], { stdio: 'inherit' });
}

function configureFixture() {
  projectId = createFixtureProject(projects, { name: 'director MCP fixture' });
  const dir = join(projects, projectId);
  mkdirSync(join(dir, 'engine', 'audio'), { recursive: true });
  writeFileSync(join(dir, 'engine', 'audio', 'song.wav'), readFileSync(silentWav));
  const db = new DatabaseSync(join(dir, 'project.sqlite'));
  const project = JSON.parse(db.prepare('SELECT data FROM project WHERE id=1').get().data);
  const beats = Array.from({ length: 16 }, (_, index) => index * 0.5);
  const envelope = Array.from({ length: 240 }, (_, index) => 0.25 + (index % 60) / 240);
  project.status = 'planned';
  project.audio = { name: 'silence.wav', hash: 'd'.repeat(64), engineFile: 'audio/song.wav' };
  project.song = {
    song: 'director fixture', bpm: 120, duration: 8, envFps: 30, beats,
    downbeats: [0, 2, 4, 6], kick: [[0, 1], [2, 1], [4, 1], [6, 1]],
    snare: [[1, 0.8], [3, 0.8], [5, 0.8], [7, 0.8]],
    rms: envelope, drums: envelope, low: envelope, mid: envelope, high: envelope, vocal: envelope.map(() => 0),
    sections: [{ name: 'verse', start: 0, end: 4 }, { name: 'chorus', start: 4, end: 8 }],
    lines: [
      { lineIndex: 0, text: 'sparks become signal', start: 0.5, end: 3.5, words: [{ w: 'sparks', start: 0.5, end: 1.2 }, { w: 'become', start: 1.2, end: 2.1 }, { w: 'signal', start: 2.1, end: 3.5 }] },
      { lineIndex: 1, text: 'light fills the room', start: 4.5, end: 7.5, words: [{ w: 'light', start: 4.5, end: 5.2 }, { w: 'fills', start: 5.2, end: 6.1 }, { w: 'the room', start: 6.1, end: 7.5 }] },
    ],
  };
  project.output = { fps: 30, width: 1920, height: 1080, samples: 1 };
  db.prepare('UPDATE project SET data=? WHERE id=1').run(JSON.stringify(project));
  db.close();
}

async function humanAccept() {
  const { token } = await (await fetch(`${base}/session`, { headers: { origin: base } })).json();
  const revision = (await getProject()).value.revision;
  const response = await fetch(`${base}/projects/${projectId}/director/accept-review`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedProjectRevision: revision }) });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  return JSON.parse(body);
}

async function invoke(name, args, expectError = false) {
  const response = await client.callTool({ name, arguments: args });
  const texts = response.content.filter((item) => item.type === 'text').map((item) => item.text);
  if (expectError) {
    assert.equal(response.isError, true, texts.join('\n'));
    return texts.join('\n');
  }
  if (response.isError) throw new Error(texts.join('\n'));
  return { value: JSON.parse(texts[0]), text: texts[1] ?? null, images: response.content.filter((item) => item.type === 'image') };
}

const next = () => invoke('project_director_next', { projectId });
const getProject = () => invoke('project_get', { projectId, includeAnalysis: true });
const directorBrief = {
  brief: { intent: 'A spark becomes a signal', audience: 'music listeners', mustKeep: ['music timing'], mustAvoid: ['flashing'] },
  style: { medium: 'paper', palette: ['#121212', '#eeeeee'], typography: 'mono', composition: 'one subject', motion: 'beat pulse', motif: 'spark' },
  rhythm: { sections: [{ sectionIndex: 0, energy: 2, intent: 'prepare' }, { sectionIndex: 1, energy: 4, intent: 'release' }], accents: [{ beatIndex: 8, intent: 'reveal' }] },
  shots: [{ shotId: 'a', subject: 'paper spark', action: 'fold', entrance: 'line', exit: 'square' }, { shotId: 'b', subject: 'signal field', action: 'expand', entrance: 'dot', exit: 'fade' }],
  maxRepairs: 1,
};

async function complete(action, attemptToken, jobIds = []) {
  const result = await invoke('project_director_complete', { projectId, actionId: action.id, attemptToken, outcome: 'done', jobIds });
  await next();
  return result.value;
}

async function produce() {
  let interrupted = false;
  for (;;) {
    const current = (await next()).value;
    const action = current.actions.find((item) => item.kind === 'generate' || item.kind === 'transition');
    if (!action) return;
    const claim = await invoke('project_director_claim', { projectId, actionId: action.id, owner: interrupted ? 'resume-owner' : 'director-owner', leaseSeconds: 60 });
    const token = claim.value.operation.attemptToken;
    if (!interrupted) {
      const resumed = (await next()).value;
      assert.ok(resumed.resumable.some((item) => item.actionId === action.id), 'claim 后 next 应暴露可恢复租约');
      interrupted = true;
    }
    const project = (await getProject()).value;
    if (action.kind === 'generate') {
      const shot = project.shots.find((item) => item.id === action.targetId);
      await invoke('project_shot_submit', { projectId, shotId: shot.id, expectedInputRevision: action.expectedInputRevision, code: fixtureScene(25), summary: 'fixture generated scene', attemptToken: token });
    } else {
      const transition = project.transitions.find((item) => item.id === action.targetId);
      await invoke('project_transition_configure', { projectId, transitionId: transition.id, expectedInputRevision: action.expectedInputRevision, config: { mode: 'cut', duration: 0 }, attemptToken: token });
    }
    await complete(action, token);
  }
}

async function getJobResult(jobId) {
  return (await invoke('project_job_get', { projectId, jobId })).value;
}

async function dispatchCurrent(kindSet) {
  const current = (await next()).value;
  const actions = current.actions.filter((item) => kindSet.has(item.kind));
  assert.ok(actions.length > 0, `应存在 ${[...kindSet].join('/')} 待办`);
  // claimDirector serializes leases for one target. Each wave therefore contains
  // at most one action per target, while still exercising real multi-action dispatch.
  let pending = [...actions];
  const completed = [];
  while (pending.length) {
    const wave = [];
    const targets = new Set();
    for (const action of pending) {
      const target = `${action.targetKind}:${action.targetId}`;
      if (!targets.has(target)) { targets.add(target); wave.push(action); }
    }
    const claims = [];
    for (const action of wave) {
      const claim = await invoke('project_director_claim', { projectId, actionId: action.id, owner: `batch-${action.kind}-${action.targetId}`, leaseSeconds: 60 });
      claims.push({ action, token: claim.value.operation.attemptToken });
    }
    const dispatched = await invoke('project_director_dispatch', { projectId, actionIds: claims.map(({ action }) => action.id), attemptTokens: claims.map(({ token }) => token) });
    const repeated = await invoke('project_director_dispatch', { projectId, actionIds: claims.map(({ action }) => action.id), attemptTokens: claims.map(({ token }) => token) });
    assert.ok(repeated.value.jobs.every((job) => job.reused === true), '重复 dispatch 应复用当前版本任务');
    for (const job of dispatched.value.jobs) {
      const done = (await invoke('project_job_get', { projectId, jobId: job.jobId, waitSeconds: 50 })).value;
      assert.equal(done.status, 'done', done.error);
      const entry = claims.find(({ action }) => action.id === job.actionId);
      await complete(entry.action, entry.token, [job.jobId]);
      completed.push(done);
    }
    const completedIds = new Set(wave.map(({ id }) => id));
    pending = pending.filter(({ id }) => !completedIds.has(id));
  }
  return completed;
}

function reviewFromJobs(jobs) {
  const evidence = [];
  for (const job of jobs) {
    const result = job.result ?? {};
    const image = result.stills?.images?.[0] ?? result.images?.[0];
    if (!image?.file) continue;
    evidence.push({ jobId: job.id, file: image.file, ...(image.t !== undefined ? { t: image.t } : {}), observation: `Observed fixture artifact from ${job.kind}` });
  }
  assert.equal(evidence.length, 6, '应有每镜两类和全片两类真实证据');
  return {
    summary: 'Reviewed actual fixture frames and timing evidence; this is a technical fixture check, not aesthetic acceptance.',
    assessments: Object.fromEntries(['composition', 'hierarchy', 'readability', 'semantics', 'rhythm', 'consistency', 'originality'].map((key) => [key, 'Observed sampled fixture frames; human aesthetic review remains separate.'])),
    evidence,
    issues: [],
    protect: ['music timing'],
  };
}

before(async () => {
  mkdirSync(projects, { recursive: true });
  makeSilentAudio();
  configureFixture();
  service = spawn(process.execPath, ['--no-warnings', 'src/server/index.mjs'], {
    cwd: root, stdio: 'pipe',
    env: { ...process.env, VIDEOGRAPH_SERVICE_PORT: String(port), VIDEOGRAPH_PROJECTS: projects, VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile, VIDEOGRAPH_STUDIO_ORIGINS: base, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe },
  });
  for (let i = 0; i < 100 && !existsSync(tokenFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!existsSync(tokenFile)) throw new Error('工程服务未启动');
  client = new Client({ name: 'videograph-director-mcp-audit', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', 'src/pdoom/mcp-server.ts'], cwd: root, env: { ...process.env, VIDEOGRAPH_SERVICE_URL: base, VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile, VIDEOGRAPH_PROJECTS: projects }, stderr: 'pipe' }));
});

after(async () => {
  await client?.close().catch(() => {});
  service?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test('director MCP 从 brief 到导出：租约恢复、批量幂等、真实证据和媒体闭环', async () => {
  const listed = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['project_director_next', 'project_director_submit', 'project_director_claim', 'project_director_complete', 'project_director_dispatch', 'project_review_submit']) assert.ok(listed.includes(name), `${name} 未注册`);

  const initial = (await getProject()).value;
  const submitted = (await invoke('project_director_submit', { projectId, expectedProjectRevision: initial.revision, director: directorBrief })).value;
  assert.equal(submitted.director.version, 1);
  await next();
  await produce();

  const validationJobs = await dispatchCurrent(new Set(['validate', 'validate-transition']));
  assert.equal(validationJobs.length, 3);
  const evidenceJobs = await dispatchCurrent(new Set(['stills', 'filmstrip', 'contact-sheet', 'rhythm']));
  assert.equal(evidenceJobs.length, 6);
  for (const job of evidenceJobs) assert.equal(job.status, 'done');

  const reviewed = await invoke('project_review_submit', { projectId, expectedProjectRevision: (await getProject()).value.revision, review: reviewFromJobs(evidenceJobs) });
  assert.equal(reviewed.value.director.review.assessments.originality.startsWith('Observed'), true);
  await next();

  const exportAction = (await next()).value.actions.find((item) => item.kind === 'export');
  assert.ok(exportAction, '审片后应产生导出待办');
  const denied = await invoke('project_render', { projectId }, true);
  assert.match(denied, /人工接受/);
  await humanAccept();
  const exportClaim = await invoke('project_director_claim', { projectId, actionId: exportAction.id, owner: 'export-owner', leaseSeconds: 60 });
  const exportDispatch = await invoke('project_director_dispatch', { projectId, actionIds: [exportAction.id], attemptTokens: [exportClaim.value.operation.attemptToken] });
  const exportJob = (await invoke('project_job_get', { projectId, jobId: exportDispatch.value.jobs[0].jobId, waitSeconds: 50 })).value;
  assert.equal(exportJob.status, 'done', exportJob.error);
  await complete(exportAction, exportClaim.value.operation.attemptToken, [exportJob.id]);

  const file = join(projects, projectId, exportJob.result.file);
  assert.ok(existsSync(file), `导出文件不存在: ${file}`);
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(video.codec_type, 'video');
  assert.equal(Number(video.nb_read_frames), 240, '8 秒 × 30fps 应有 240 帧');
  assert.equal(audio.codec_type, 'audio');
  assert.ok(Number(audio.duration) >= 7.9, '应包含约 8 秒音轨');
  execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: 'inherit' });
  assert.equal((await next()).value.phase, 'exported');
});

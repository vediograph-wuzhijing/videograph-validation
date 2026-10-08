// Real HTTP + stdio MCP + worker + FFmpeg + frozen MP4. Synthetic bank checks contracts, not timbre.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixtureProject } from '../feedback/helpers.mjs';
import { writeWavMono16, readWav } from '../../../src/vocal/wav.mjs';
import { productionSignature } from '../../../src/server/director.mjs';
import { projectAnalysisFile, projectManifestFile } from '../../../src/server/project-generation.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'videograph-vocal-integration-')), projects = join(tmp, 'projects');
const id = createFixtureProject(projects), dir = join(projects, id), tokenFile = join(tmp, 'token');
const port = 6700 + Math.floor(Math.random() * 300), base = `http://127.0.0.1:${port}`;
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg', bank = join(tmp, 'bank'), stub = join(tmp, 'resampler.mjs');
let service, client, humanToken, mcpToken, log = '';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plan = (pitch = 'C4') => ({ tempo: 120, tracks: [{}], parts: [{ notes: [
  { lyric: 'a', text: '你好', pitch, startBeats: 0.5, durationBeats: 1 },
  { lyric: 'a', text: '世界', pitch: 'D4', startBeats: 2, durationBeats: 1 },
] }] });
async function request(path, body, token = humanToken, status = 200, headers = {}) {
  const response = await fetch(`${base}/projects/${id}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: { projectId: id, ...args } });
  assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text);
}
async function done(job) {
  for (let i = 0; i < 100; i++) {
    const value = await request(`/jobs/${job.id}?wait=2`);
    if (['done', 'error', 'cancelled', 'interrupted'].includes(value.status)) return value;
  }
  throw new Error(`job timed out ${log}`);
}
before(async () => {
  mkdirSync(bank); writeWavMono16(join(bank, 'a.wav'), Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i * .05) * .3));
  writeFileSync(join(bank, 'oto.ini'), 'a.wav=a,0,20,-100,50,20\n'); writeFileSync(join(bank, 'character.txt'), 'name=Integration Bank\n');
  const wavModule = new URL('../../../src/vocal/wav.mjs', import.meta.url).href;
  writeFileSync(stub, `import {writeWavMono16} from ${JSON.stringify(wavModule)};
const a=process.argv.slice(2); await new Promise(r=>setTimeout(r,500));
writeWavMono16(a[1], Float32Array.from({length:Math.round(Number(a[6])*44.1)},(_,i)=>Math.sin(i*.06)*.4));`);
  mkdirSync(join(dir, 'engine/audio'), { recursive: true });
  const main = join(dir, 'engine/app/src/main.ts');
  writeFileSync(main, readFileSync(main, 'utf8') + "\nwindow.fixtureAudio = new Audio('audio/pdoom.mp3');\n");
  const manifestFile = join(dir, 'engine-manifest.json'), manifest = JSON.parse(readFileSync(manifestFile));
  manifest.files = manifest.files.map(([file, sha]) => [file, file === 'app/src/main.ts' ? hash(readFileSync(main)) : sha]);
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const original = join(dir, 'engine/audio/song.wav'); writeWavMono16(original, new Float32Array(44100 * 2));
  const db = new DatabaseSync(join(dir, 'project.sqlite'));
  const p = JSON.parse(db.prepare('SELECT data FROM project').get().data);
  p.audio = { name: 'song.wav', hash: hash(readFileSync(original)), engineFile: 'audio/song.wav' };
  p.song.duration = 2; p.shots[0].end = 1; p.shots[1].start = 1; p.shots[1].end = 2;
  db.prepare('UPDATE project SET data=?').run(JSON.stringify(p)); db.close();
  const env = { ...process.env, VIDEOGRAPH_PROJECTS: projects, VIDEOGRAPH_SERVICE_PORT: String(port), VIDEOGRAPH_SERVICE_URL: base,
    VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile, VIDEOGRAPH_VOICEBANK_DIR: bank,
    VIDEOGRAPH_OPENUTAU_RESAMPLER: JSON.stringify([process.execPath, stub]), VIDEOGRAPH_OPENUTAU_CONTRACT: 'classic' };
  service = spawn(process.execPath, ['src/server/index.mjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', (d) => { log += d; }); service.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await sleep(100); }
  humanToken = (await (await fetch(`${base}/session`, { headers: { origin: 'http://127.0.0.1:5188' } })).json()).token;
  mcpToken = readFileSync(tokenFile, 'utf8').trim();
  client = new Client({ name: 'vocal integration', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', 'src/pdoom/mcp-server.ts'], cwd: root, env }));
});
after(async () => {
  await client?.close();
  if (service && service.exitCode === null) { service.kill(); await new Promise((r) => { service.once('close', r); setTimeout(r, 5000).unref(); }); }
  // Windows file locks can outlive process close briefly.
  rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
});

test('MCP提交 → 后台歌声 → 人工采用 → 预览/冻结导出；画面缓存不因改音轨失效', { timeout: 180000 }, async () => {
  const tools = await client.listTools(); assert.equal(tools.tools.filter((t) => t.name.startsWith('project_vocal_')).length, 6);
  assert.equal((await call('project_vocal_check')).ready, true);
  const baseline = await request('');
  const state = await call('project_vocal_submit', { expectedInputRevision: 0, plan: plan(), mix: { processing: {} } });
  assert.equal(state.inputRevision, 1);
  await request('/vocal', { expectedInputRevision: 0, plan: plan() }, humanToken, 409);
  const job = await done(await call('project_vocal_render', { expectedInputRevision: 1 }));
  assert.equal(job.status, 'done', job.error); assert.equal(job.result.report.cacheSummary.misses, 2);
  assert.equal(job.input, undefined); assert.ok(!JSON.stringify(job).includes(stub));
  const candidate = (await call('project_vocal_get')).candidate;
  assert.equal(candidate.mix.processing.compressor.ratio, 3);
  const pitchResponse = await fetch(`${base}/projects/${id}/files/${candidate.pitchReportFile}`);
  assert.equal(pitchResponse.headers.get('content-type'), 'application/json');
  const pitch = await pitchResponse.json();
  assert.equal(pitch.timingSource, 'measured'); assert.equal(pitch.notes.length, 2);
  assert.ok(pitch.frames.some(f => f.hz !== null));
  assert.ok(candidate.report.pitchQuality.summary.voicedFrames > 0);
  const range = await fetch(`${base}/projects/${id}/files/${candidate.mixFile}`, { headers: { range: 'bytes=0-43' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-type'), 'audio/wav'); assert.equal((await range.arrayBuffer()).byteLength, 44);
  assert.ok(readWav(join(dir, candidate.mixFile)).samples.some((v) => Math.abs(v) > .01));
  const current = await request('');
  await request('/vocal/adopt', { expectedProjectRevision: current.revision, expectedInputRevision: 1, jobId: job.id }, mcpToken, 403);
  await request('/vocal/reset', { expectedProjectRevision: current.revision }, mcpToken, 403);
  await request('/vocal/adopt', { expectedProjectRevision: baseline.revision, expectedInputRevision: 1, jobId: job.id }, humanToken, 409);
  const adopted = await request('/vocal/adopt', { expectedProjectRevision: current.revision, expectedInputRevision: 1, jobId: job.id });
  assert.equal(adopted.engineHash, baseline.engineHash); assert.equal(adopted.audio.hash, baseline.audio.hash);
  assert.deepEqual(adopted.song, baseline.song); assert.notEqual(productionSignature(adopted), productionSignature(current));
  await request('/vocal/lyrics', { expectedProjectRevision: adopted.revision }, humanToken, 409);
  const preview = await request('/preview', {});
  const mainSource = await (await fetch(new URL('/src/main.ts', preview.url))).text();
  assert.match(mainSource, new RegExp(candidate.mixHash));
  const previewAudio = await fetch(new URL(`/audio/vocal-${candidate.mixHash}.wav`, preview.url));
  const previewBytes = Buffer.from(await previewAudio.arrayBuffer());
  assert.equal(previewAudio.status, 200); assert.equal(hash(previewBytes), candidate.mixHash, `preview content-type=${previewAudio.headers.get('content-type')} head=${previewBytes.subarray(0, 100).toString()}`);
  const exported = await done(await request('/render', { fps: 24, samples: 1 }, humanToken, 202));
  assert.equal(exported.status, 'done', exported.error);
  const manifest = JSON.parse(readFileSync(join(dir, 'exports', exported.id, 'manifest.json')));
  assert.equal(manifest.soundtrack.hash, candidate.mixHash); assert.equal(manifest.vocal.jobId, job.id);
  const decoded = join(tmp, 'export-audio.wav');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', join(dir, exported.result.file), '-vn', '-ac', '1', '-c:a', 'pcm_s16le', decoded], { windowsHide: true });
  assert.ok(readWav(decoded).samples.some((v) => Math.abs(v) > .01));
  const reset = await request('/vocal/reset', { expectedProjectRevision: (await request('')).revision });
  assert.equal(reset.vocal.active, null);
  const originalExport = await done(await request('/render', { fps: 24, samples: 1 }, humanToken, 202));
  assert.equal(originalExport.status, 'done', originalExport.error);
  assert.equal(originalExport.result.cacheSummary.reused, 2);
});

test('旧候选不能覆盖改谱；单音符改动复用缓存；取消可运行任务', { timeout: 60000 }, async () => {
  const previous = await call('project_vocal_get');
  const active = await request('/vocal/adopt', { expectedProjectRevision: previous.projectRevision, expectedInputRevision: previous.inputRevision, jobId: previous.candidate.jobId });
  const changed = await call('project_vocal_submit', { expectedInputRevision: previous.inputRevision, plan: plan('E4') });
  assert.equal(changed.active.mixHash, active.vocal.active.mixHash);
  const oldJob = previous.candidate.jobId;
  await request('/vocal/adopt', { expectedProjectRevision: changed.projectRevision, expectedInputRevision: changed.inputRevision, jobId: oldJob }, humanToken, 409);
  const rendered = await done(await call('project_vocal_render', { expectedInputRevision: changed.inputRevision }));
  assert.equal(rendered.status, 'done', rendered.error); assert.equal(rendered.result.report.cacheSummary.hits, 1); assert.equal(rendered.result.report.cacheSummary.misses, 1);
  const next = await call('project_vocal_submit', { expectedInputRevision: changed.inputRevision, plan: plan('F4') });
  const pending = await call('project_vocal_render', { expectedInputRevision: next.inputRevision });
  // Worker is sleeping in the fake external process; editing must invalidate this exact edit revision.
  await sleep(100);
  const latest = await call('project_vocal_submit', { expectedInputRevision: next.inputRevision, plan: plan('G4') });
  const stale = await done(pending); assert.equal(stale.status, 'done', stale.error); assert.equal(stale.result.stale, true);
  assert.equal((await call('project_vocal_get')).candidate, null);
  const cancel = await call('project_vocal_render', { expectedInputRevision: latest.inputRevision });
  const queued = await call('project_vocal_render', { expectedInputRevision: latest.inputRevision });
  await call('project_job_cancel', { jobId: queued.id }); assert.equal((await done(queued)).status, 'cancelled');
  await sleep(150); await call('project_job_cancel', { jobId: cancel.id });
  assert.equal((await done(cancel)).status, 'cancelled');
  assert.equal((await call('project_vocal_get')).candidate, null);
});

test('规划前明确应用乐谱歌词，标记推算来源并要求重新确认', async () => {
  const db = new DatabaseSync(join(dir, 'project.sqlite')), p = JSON.parse(db.prepare('SELECT data FROM project').get().data);
  p.status = 'analysis-confirmed'; p.analysis.confirmedBy = 'human';
  db.prepare('UPDATE project SET data=?').run(JSON.stringify(p)); db.close();
  const prov = { tool: 'fixture', version: '1', startedAt: 0, confidence: 1 };
  const analysis = { schema: 'videograph-analysis/v2', audio: { hash: p.audio.hash, duration: 2, sampleRate: 44100, channels: 1, decoderOffset: 0 },
    rhythm: { bpm: 120, beats: [0, .5, 1, 1.5, 2], downbeats: [0, 2], meter: 4, confidence: 1 },
    sections: [{ name: 'verse', start: 0, end: 2 }], envelopes: { frameRate: 30, rms: new Array(61).fill(0) },
    onsets: { kick: [], snare: [], hat: [], vocal: [] }, overrides: [], provenance: { audio: prov, rhythm: prov, sections: prov, envelopes: prov, onsets: prov } };
  mkdirSync(join(dir, 'analysis'), { recursive: true }); mkdirSync(join(dir, 'engine/data'), { recursive: true });
  writeFileSync(join(dir, 'analysis/analysis-v2.json'), JSON.stringify(analysis));
  await request('/vocal/lyrics', { expectedProjectRevision: p.revision }, mcpToken, 403);
  await request('/vocal/lyrics', { expectedProjectRevision: p.revision - 1 }, humanToken, 409);
  const applied = await request('/vocal/lyrics', { expectedProjectRevision: p.revision });
  assert.equal(applied.status, 'analysis-draft'); assert.equal(applied.analysis.confirmedBy, undefined);
  assert.equal(applied.song.lines[0].text, '你好'); assert.equal(applied.song.lines[0].start, .25);
  const saved = JSON.parse(readFileSync(projectAnalysisFile(dir, applied)));
  assert.equal(saved.lyrics.timingSource, 'score'); assert.equal(saved.provenance.lyrics.params.timingSource, 'score');
  const manifest = JSON.parse(readFileSync(projectManifestFile(dir, applied)));
  assert.ok(!manifest.files.some(([file]) => file.startsWith('audio/vocal-')));
});

test('外部处理人声经 MCP 冻结导入、增强混音、实测报告及人工采用', {timeout:60000}, async()=>{
  const before=await call('project_vocal_get'), external=join(tmp,'external-processed.wav'),reference=join(tmp,'reference-vocal.wav');
  const source=Float32Array.from({length:44100*2},(_,i)=>.2*Math.sin(i/44100*2*Math.PI*440));
  writeWavMono16(external,source);writeWavMono16(reference,Float32Array.from(source,n=>n*.5));
  const imported=await call('project_vocal_import_audio',{expectedInputRevision:before.inputRevision,audioPath:external,referencePath:reference,plan:plan('E4'),mix:{processing:{exciter:{amount:.2},saturation:{amount:.2},doubling:{wet:.2}}}});
  assert.equal(imported.draft.source,'external');assert.equal(imported.active?.jobId,before.active?.jobId);
  // Original bytes can change; the submitted stem must remain immutable.
  writeWavMono16(external,new Float32Array(44100*2));
  const rendered=await done(await call('project_vocal_render',{expectedInputRevision:imported.inputRevision}));
  assert.equal(rendered.status,'done',rendered.error);assert.equal(rendered.result.report.source,'external');
  assert.ok(rendered.result.pitchReportFile);assert.ok(rendered.result.bandReportFile);assert.equal(rendered.result.report.pitchQuality.frames,undefined);
  const bands=await (await fetch(`${base}/projects/${id}/files/${rendered.result.bandReportFile}`)).json();assert.equal(bands.schema,'vocal-bands/v1');assert.ok(bands.reference);assert.ok(bands.differences.some(b=>b.deltaDb!==null));
  const current=await request('');await request('/vocal/adopt',{expectedProjectRevision:current.revision,expectedInputRevision:imported.inputRevision,jobId:rendered.id},mcpToken,403);
  const adopted=await request('/vocal/adopt',{expectedProjectRevision:current.revision,expectedInputRevision:imported.inputRevision,jobId:rendered.id});assert.equal(adopted.vocal.active.jobId,rendered.id);
});

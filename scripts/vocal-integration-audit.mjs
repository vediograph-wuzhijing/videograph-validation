// Optional operator audit: uses YOUR configured voicebank/resampler. All projects stay in .cache.
// Run: node scripts/vocal-integration-audit.mjs (requires local Chromium and FFmpeg).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createFixtureProject } from './tests/feedback/helpers.mjs';
import { writeWavMono16, readWav } from '../src/vocal/wav.mjs';
import { browserPath } from '../src/server/browser.mjs';

const expressive = process.argv.includes('--expressions');
const root = fileURLToPath(new URL('..', import.meta.url)), out = join(root, expressive ? '.cache/vocal-expression-audit' : '.cache/vocal-audit');
mkdirSync(out, { recursive: true });
const projects = join(out, 'projects'), id = createFixtureProject(projects, { name: '歌声接入 · 本机验收' }), dir = join(projects, id);
mkdirSync(join(dir, 'engine/audio'), { recursive: true });
const backing = join(dir, 'engine/audio/song.wav');
writeWavMono16(backing, Float32Array.from({ length: 44100 * 4 }, (_, i) => Math.sin(i * 2 * Math.PI * 220 / 44100) * 0.05));
const db = new DatabaseSync(join(dir, 'project.sqlite')), p = JSON.parse(db.prepare('SELECT data FROM project').get().data);
p.audio = { name: '验收伴奏.wav', hash: createHash('sha256').update(readFileSync(backing)).digest('hex'), engineFile: 'audio/song.wav' };
p.song.duration = 4; p.shots[0].end = 2; p.shots[1].start = 2; p.shots[1].end = 4;
db.prepare('UPDATE project SET data=?').run(JSON.stringify(p)); db.close();
const port = 6774, uiPort = 6775, base = `http://127.0.0.1:${port}`;
const descriptors = [], children = [];
function start(args, env, name) {
  const descriptor = openSync(join(out, `${name}.log`), 'w'); descriptors.push(descriptor);
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', descriptor, descriptor] }); children.push(child); return child;
}
const env = { ...process.env, VIDEOGRAPH_PROJECTS: projects, VIDEOGRAPH_SERVICE_PORT: String(port),
  VIDEOGRAPH_SERVICE_TOKEN_FILE: join(out, 'service-token'), VIDEOGRAPH_STUDIO_ORIGINS: `http://127.0.0.1:${uiPort}`, VITE_VIDEOGRAPH_SERVICE_URL: base };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready(url) { for (let i = 0; i < 150; i++) { try { if ((await fetch(url)).ok) return; } catch {} await pause(100); } throw new Error(`${url} not ready`); }
let browser;
try {
  start(['src/server/index.mjs'], env, 'service'); start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort)], env, 'ui');
  await Promise.all([ready(`${base}/health`), ready(`http://127.0.0.1:${uiPort}`)]);
  const token = (await (await fetch(`${base}/session`, { headers: { origin: `http://127.0.0.1:${uiPort}` } })).json()).token;
  async function api(path, body) {
    const response = await fetch(`${base}/projects/${id}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  }
  const setup = await api('/vocal/check'); assert.ok(setup.ready, setup.error);
  // This optional audit uses the locally configured bank's aliases, never bundles its samples.
  const preferred = ['- あ', 'a s', 'a あ', 'a い', 'i う', 'u え', 'e ん'];
  const aliases = preferred.every((a) => setup.aliases.includes(a)) ? preferred : setup.aliases.slice(0, 7);
  assert.ok(aliases.length);
  const score = { name: '本机声库验收', tempo: 120, tracks: [{}], parts: [{ notes: aliases.map((lyric, i) => ({
    lyric, text: ['あ', 'す', 'あ', 'い', 'う', 'え', 'ん'][i], pitch: ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'A4'][i], startBeats: .5 + i, durationBeats: 1,
  })) }] };
  if (expressive) {
    score.parts[0].pitchDeviation = [{timeMs:0,cents:0},{timeMs:1000,cents:80},{timeMs:3000,cents:0},{timeMs:4000,cents:0}];
    score.parts[0].dynamics = [{timeMs:0,db:-6},{timeMs:2000,db:0},{timeMs:4000,db:-3}];
    score.parts[0].notes.forEach((note,i)=>{
      note.volume=80+i*3;note.velocity=110;
      note.pitchCurve=[{x:-70,y:-8,shape:'lin'},{x:80,y:0,shape:'io'}];
      note.vibrato={length:70,period:200,depth:40,in:10,out:10};
    });
  }
  await api('/vocal', { expectedInputRevision: 0, plan: score, ...(expressive ? {mix:{processing:{}}} : {}) });
  const job = await api('/vocal/render', { expectedInputRevision: 1 });
  let finished;
  for (let i = 0; i < 90; i++) {
    finished = await api(`/jobs/${job.id}?wait=2`);
    if (['done', 'error', 'cancelled', 'interrupted'].includes(finished.status)) break;
    if (i % 5 === 0) console.log(finished.detail);
  }
  assert.equal(finished.status, 'done', finished.error);
  const measured=JSON.parse(readFileSync(join(dir,finished.result.pitchReportFile)));
  assert.equal(measured.timingSource,'measured');assert.equal(measured.notes.length,aliases.length);
  assert.ok(measured.summary.voicedFrames>0);
  if(expressive)assert.ok(finished.result.mix.processing.reverb.wet>0);
  const stem = readWav(join(dir, finished.result.stemFile)), peak = stem.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak > .01, 'real voice is silent');
  browser = await chromium.launch({ headless: true, executablePath: browserPath() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${uiPort}/?view=project&project=${id}`);
  await page.locator('.vocal-panel > summary').click();
  await page.getByRole('button', { name: '检查声库配置' }).click();
  await page.getByRole('button', { name: '采用此混音' }).waitFor();
  const audio = page.locator('audio[aria-label="候选伴奏与人声混音"]');
  await audio.evaluate((node) => { node.preload = 'metadata'; node.load(); });
  await page.waitForFunction(() => Number.isFinite(document.querySelector('audio')?.duration));
  assert.ok(Math.abs(await audio.evaluate((node) => node.duration) - 4) < .05);
  await page.getByText('实测音高质检', { exact: true }).click();
  assert.ok(await page.getByText(/目标曲线误差中位数/).isVisible());
  await page.getByText('人声干轨与文件', { exact: true }).click();
  const reportLink = page.getByRole('link', { name: '实测音高 JSON', exact: true });
  const downloaded = await (await fetch(await reportLink.getAttribute('href'))).json();
  assert.equal(downloaded.schema,'vocal-pitch-report/v1');
  await page.screenshot({ path: join(out, 'desktop-candidate.png'), fullPage: true });
  await page.getByRole('button', { name: '编辑乐谱', exact: true }).click();
  assert.match(await page.locator('#vocal-score').inputValue(), /startBeats/);
  await page.getByRole('button', { name: '关闭编辑' }).click();
  await page.getByRole('button', { name: '采用此混音' }).click();
  await page.getByRole('button', { name: '此候选已采用' }).waitFor();
  const adopted = await api(''); assert.equal(adopted.vocal.active.mixHash, finished.result.mixHash);
  await page.screenshot({ path: join(out, 'desktop-adopted.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(out, 'small-screen.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const report = { projectId: id, bank: setup.bank, notes: finished.result.report.noteCount, peak, stemFile: join(dir, finished.result.stemFile),
    mixFile: join(dir, finished.result.mixFile), pitchReportFile:join(dir,finished.result.pitchReportFile),pitchQuality:finished.result.report.pitchQuality,
    processing:finished.result.mix.processing,expressive,adoptedMixHash: adopted.vocal.active.mixHash, cache: finished.result.report.cacheSummary, uiErrors: errors };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  for (const child of children) {
    if (child.exitCode !== null) continue;
    child.kill(); await new Promise((r) => { child.once('close', r); setTimeout(r, 5000).unref(); });
  }
  descriptors.forEach(closeSync);
}

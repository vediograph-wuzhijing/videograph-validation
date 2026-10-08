// Separate process, frozen input, shared scheduler/cancellation, immutable outputs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJob, saveJobProgress as saveJob, projectDir } from './project-repository.mjs';
import { publishVocalArtifact, attachVocalCandidate } from './vocal-project.mjs';
import { prepareVocalPlan } from '../vocal/plan.mjs';
import { renderUstx } from '../vocal/render.mjs';
import { vocalFilter, roomReverb, normalizeMix, colorVocal, doubleVocal } from '../vocal/mix.mjs';
import { compareBands } from '../vocal/spectrum.mjs';
import { pitchReport } from '../vocal/pitch-analysis.mjs';
import { sha256 } from './project-repository.mjs';
import { readWav, writeWavStereoFloat32 } from '../vocal/wav.mjs';
const [id, jobId] = process.argv.slice(2), job = readJob(id, jobId);
const controller = new AbortController(), signal = controller.signal;
process.on('message', (message) => { if (message === 'cancel')
  controller.abort(); });
process.on('disconnect', () => controller.abort());
const dir = projectDir(id), scratch = join(dir, '.vocal-work');
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, `${jobId}-`));
let lastSave = 0;
const progress = (detail, value) => {
  signal.throwIfAborted();
  job.detail = detail;
  if (value !== undefined)
    job.progress = value;
  if (Date.now() - lastSave > 500) {
    saveJob(id, job);
    lastSave = Date.now();
  }
};
try {
  job.status = 'running';
  job.startedAt = Date.now();
  saveJob(id, job);
  const p = job.input.project, draft = p.vocal.draft, config = job.input.configuration;
  const stemPath = join(work, 'stem.wav'), mixPath = join(work, 'mix.wav');
  let report, pitch;
  if(draft.source==='external') {
    const bytes=readFileSync(join(dir,draft.stem.file));
    if(sha256(bytes)!==draft.stem.hash) throw new Error('导入人声已损坏');
    copyFileSync(join(dir,draft.stem.file),stemPath);
    report={source:'external',sourceHash:draft.stem.sourceHash,offsetMs:draft.stem.offsetMs};
    if(draft.plan) {const measured=pitchReport(readWav(stemPath),prepareVocalPlan(draft.plan,draft.duration).ustxText,{signal});pitch=publishVocalArtifact(id,JSON.stringify(measured),'json');const {frames,...quality}=measured;report.pitchQuality=quality;}
  } else {
  const prepared = prepareVocalPlan(draft.plan, draft.duration);
  report = await renderUstx({ ...config, ustxText: prepared.ustxText, outWav: stemPath, workDir: join(work, 'notes'),
    cacheDir: config.cacheDir ?? join(dir, '.vocal-cache'), signal, log: (line) => progress(line),
    onProgress: (done, total) => progress(`歌声音符 ${done}/${total}`, done / total * 0.85) });
  pitch = publishVocalArtifact(id, readFileSync(report.pitchReportPath), 'json');
  }
  // Explicit gains; no implicit amix attenuation. Fixed original duration, limiter without added latency.
  const mixSettings = normalizeMix(draft.mix), { backingGain, vocalGain } = mixSettings;
  let vocalPath = stemPath;
  if (mixSettings.processing) {
    progress('处理人声 EQ、压缩与房间混响', 0.88);
    const equalized = join(work, 'equalized.wav');
    await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y', '-v', 'error', '-i', stemPath, '-af', vocalFilter(mixSettings.processing), '-ar', '44100', '-ac', '1', '-c:a', 'pcm_f32le', equalized], { windowsHide: true, signal, timeout: 300000, maxBuffer: 1024 * 1024 });
    const audio = readWav(equalized), colored=colorVocal(audio.samples,audio.sampleRate,mixSettings.processing,{signal});
    const room = doubleVocal(roomReverb(colored, audio.sampleRate, mixSettings.processing.reverb, { signal }),audio.sampleRate,mixSettings.processing.doubling,{signal});
    vocalPath = join(work, 'processed-vocal.wav');
    writeWavStereoFloat32(vocalPath, room, audio.sampleRate);
  }
  progress('混合伴奏与人声', 0.9);
  await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y', '-v', 'error',
    '-i', join(dir, 'engine', p.audio.engineFile ?? 'audio/pdoom.mp3'), '-i', vocalPath,
    '-filter_complex', `[0:a]volume=${backingGain},apad[b];[1:a]volume=${vocalGain},apad[v];[b][v]amix=inputs=2:normalize=0,alimiter=limit=0.95:level=false:latency=true[a]`,
    '-map', '[a]', '-t', String(draft.duration), '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', mixPath], { windowsHide: true, signal, timeout: 300000, maxBuffer: 1024 * 1024 });
  signal.throwIfAborted();
  const stem = publishVocalArtifact(id, readFileSync(stemPath), 'wav'), mix = publishVocalArtifact(id, readFileSync(mixPath), 'wav');
  const { outWav, pitchReportPath, ...summary } = report;
  let reference;
  if(draft.reference){const path=join(dir,draft.reference.file);if(sha256(readFileSync(path))!==draft.reference.hash)throw new Error('参考人声已损坏');reference=readWav(path);}
  const bands=compareBands(readWav(vocalPath),reference);
  const bandReport=publishVocalArtifact(id,JSON.stringify(bands),'json');
  job.result = { inputToken: draft.inputToken, mixHash: mix.hash, stemHash: stem.hash, mixFile: mix.file, stemFile: stem.file,
    ustxFile: draft.ustxFile, lrcFile: draft.lrcFile, pitchReportFile: pitch?.file??null, bandReportFile:bandReport.file, lyrics: draft.lyrics, report: {...summary,bands}, mix: mixSettings, timingSource: draft.plan?'score':'external-audio' };
  signal.throwIfAborted();
  job.result.stale = !attachVocalCandidate(id, job);
  job.status = 'done';
  job.progress = 1;
  job.detail = job.result.stale ? '完成；乐谱已改动，此候选不能采用' : '完成，等待试听采用';
}
catch (error) {
  job.status = signal.aborted ? 'cancelled' : 'error';
  job.error = signal.aborted ? undefined : error.message;
  job.detail = signal.aborted ? '已取消歌声渲染' : '歌声渲染失败';
}
finally {
  job.finishedAt = Date.now();
  saveJob(id, job);
  rmSync(work, { recursive: true, force: true });
  if (process.connected)
    process.disconnect();
}

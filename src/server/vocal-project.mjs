import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { join, delimiter, resolve } from 'node:path';
import { readProject, mutateProject, projectDir, sha256, saveJob, readJob } from './project-repository.mjs';
import { ProjectError, requireRevision } from './errors.mjs';
import { prepareVocalPlan, normalizeMix } from '../vocal/plan.mjs';
import { resolveConfig } from '../vocal/config.mjs';
import { loadVoicebank } from '../vocal/oto.mjs';
import { readMidi, midiScore } from '../vocal/midi.mjs';
import { japaneseMora, japaneseAliases } from '../vocal/japanese.mjs';
import { publicJob } from './render-jobs.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { renameRetrySync } from '../platform/files.mjs';

export async function submitExternalVocal(id, expected, options) {
  requireRevision(expected, 'expectedInputRevision');
  const p = readProject(id), duration = p.song?.duration;
  if ((p.vocal?.inputRevision ?? 0) !== expected || !Number.isFinite(duration)) throw new ProjectError('请先完成歌曲分析并重读歌声版本', 409);
  const scratch = join(projectDir(id), '.vocal-work'); mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, 'import-'));
  const normalize = async (path, offsetMs, label) => {
    if (typeof path !== 'string' || !existsSync(path) || !statSync(path).isFile() || statSync(path).size > 300*1024*1024) throw new ProjectError(`${label} 必须是 ≤300 MB 的本地音频文件`);
    if (!Number.isFinite(offsetMs) || offsetMs < 0 || offsetMs >= duration*1000) throw new ProjectError(`${label} offsetMs 必须在歌曲时间范围内`);
    // Freeze bytes before probing/converting, so edits to the original file
    // cannot change the imported candidate after submission.
    const frozen=join(work,`${label}-source`);copyFileSync(path,frozen);
    const probe=await promisify(execFile)(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_entries','format=duration','-of','json',frozen],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
    const seconds=Number(JSON.parse(probe.stdout).format?.duration);
    if(!Number.isFinite(seconds)||seconds<=0||seconds+offsetMs/1000>duration+.1) throw new ProjectError(`${label} 时长超出歌曲；请先裁剪或调整 offsetMs`);
    const output=join(work,`${label}.wav`);
    await promisify(execFile)(process.env.FFMPEG_PATH??'ffmpeg',['-y','-v','error','-i',frozen,'-af',`adelay=${offsetMs}:all=1,apad`,'-t',String(duration),'-ar','44100','-ac','1','-c:a','pcm_f32le',output],{windowsHide:true,timeout:300000,maxBuffer:1024*1024});
    return {...publishVocalArtifact(id,readFileSync(output),'wav'),offsetMs,sourceHash:sha256(readFileSync(frozen)),sourceDuration:seconds};
  };
  try {
    const stem=await normalize(options.audioPath,options.offsetMs??0,'stem');
    const reference=options.referencePath===undefined?null:await normalize(options.referencePath,options.referenceOffsetMs??0,'reference');
    const mix=normalizeMix(options.mix), prepared=options.plan?prepareVocalPlan(options.plan,duration):null;
    const plan=prepared?.plan??null;
    const inputToken=sha256(JSON.stringify({source:'external',stem:stem.hash,reference:reference?.hash,plan,mix,audio:p.audio.hash,duration}));
    const ustx=prepared?publishVocalArtifact(id,prepared.ustxText,'ustx'):null,lrc=prepared?publishVocalArtifact(id,prepared.lrc,'lrc'):null;
    mutateProject(id,undefined,current=>{
      if((current.vocal?.inputRevision??0)!==expected||current.audio.hash!==p.audio.hash||current.song?.duration!==duration) throw new ProjectError('导入期间工程已改变，请重读后导入',409);
      current.vocal={...current.vocal,schema:'vocal/v1',inputRevision:expected+1,candidate:null,draft:{source:'external',stem,reference,plan,mix,inputToken,audioHash:p.audio.hash,duration,ustxFile:ustx?.file??null,lrcFile:lrc?.file??null,lyrics:prepared?.lyrics??null}};
      return current;
    });
    return vocalState(id);
  } catch(error){if(error.name==='UstxError') throw new ProjectError(error.message);throw error;}
  finally{rmSync(work,{recursive:true,force:true,maxRetries:6,retryDelay:100});}
}

export function importVocalMidi(id, options) {
  const p = readProject(id);
  if (typeof options.midiPath !== 'string' || !existsSync(options.midiPath) || !statSync(options.midiPath).isFile() || statSync(options.midiPath).size > 16 * 1024 * 1024) throw new ProjectError('midiPath 必须是 ≤16 MB 本地 MIDI 文件');
  try {
    const midi = readMidi(readFileSync(options.midiPath));
    const lyrics = typeof options.lyrics === 'string' ? japaneseMora(options.lyrics) : options.lyrics;
    const config = resolveConfig({ projectRoot: projectDir(id) });
    const bank = config.sources.voicebankDir ? loadVoicebank(config.sources.voicebankDir.value) : null;
    const result = midiScore(midi, { ...options, lyrics, singer: bank?.name ?? 'voicebank' });
    const aliases = bank ? japaneseAliases(result.plan.parts[0].notes, bank, { mode: options.aliasMode, prefix: options.prefix, suffix: options.suffix }) : { report: { ready: false, error: '未配置声库；无法验证别名' } };
    if (aliases.notes) result.plan.parts[0].notes = aliases.notes;
    prepareVocalPlan(result.plan, p.song?.duration);
    return { ...result, aliasReport: aliases.report, projectRevision: p.revision, expectedInputRevision: p.vocal?.inputRevision ?? 0,
      next: '检查音节、别名及时间后，用 project_vocal_submit 正式提交；不会自动写入或渲染' };
  } catch (error) { if (error.name === 'UstxError') throw new ProjectError(error.message); throw error; }
}

export function vocalState(id) {
  const p = readProject(id);
  return { projectId: id, projectRevision: p.revision, inputRevision: p.vocal?.inputRevision ?? 0, draft: p.vocal?.draft ?? null,
    candidate: p.vocal?.candidate ?? null, active: p.vocal?.active ?? null, timingRule: '歌词时间来自乐谱，未经音频对齐；不会自动替换视频歌词' };
}
export function vocalConfiguration(id) {
  const config = resolveConfig({ projectRoot: projectDir(id) });
  if (!config.sources.resampler || !config.sources.voicebankDir) throw new ProjectError('缺少声库或重采样器；配置 ~/.videograph/vocal.json 或 VIDEOGRAPH_VOICEBANK_DIR / VIDEOGRAPH_OPENUTAU_RESAMPLER', 409);
  const command = Array.isArray(config.sources.resampler.value) ? config.sources.resampler.value[0] : config.sources.resampler.value;
  const candidates = [resolve(command)];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) for (const ext of ['', ...(process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [])]) candidates.push(join(dir, command + ext));
  if (!candidates.some((file) => existsSync(file) && statSync(file).isFile())) throw new ProjectError('配置的重采样器不存在，请检查 resampler 路径或 PATH', 409);
  return { resampler: config.sources.resampler.value, voicebankDir: config.sources.voicebankDir.value,
    contract: config.sources.resamplerContract?.value ?? 'classic', cacheDir: config.sources.cacheDir?.value };
}
export function checkVocal(id) {
  try {
    const config = vocalConfiguration(id), bank = loadVoicebank(config.voicebankDir);
    return { ready: true, bank: bank.name, aliasCount: bank.entries.length, aliases: bank.entries.map((e) => e.alias).slice(0, 1000),
      aliasesTruncated: bank.entries.length > 1000, warnings: bank.warnings, contract: config.contract };
  } catch (error) { return { ready: false, error: error.message }; }
}
export function publishVocalArtifact(id, bytes, extension) {
  const hash = sha256(bytes), dir = join(projectDir(id), 'artifacts');
  mkdirSync(dir, { recursive: true });
  const file = `${hash}.${extension}`, target = join(dir, file);
  if (!existsSync(target)) {
    const temp = `${target}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, bytes); renameRetrySync(temp, target); } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  return { hash, file: `artifacts/${file}` };
}
export function submitVocal(id, expected, plan, mix) {
  requireRevision(expected, 'expectedInputRevision');
  try {
    mutateProject(id, undefined, (p) => {
      if ((p.vocal?.inputRevision ?? 0) !== expected) throw new ProjectError('乐谱已更新，请重读后编辑', 409);
      const prepared = prepareVocalPlan(plan, p.song?.duration), gains = normalizeMix(mix);
      const token = sha256(JSON.stringify({ plan: prepared.plan, mix: gains, audio: p.audio.hash, duration: p.song.duration }));
      const ustx = publishVocalArtifact(id, prepared.ustxText, 'ustx'), lrc = publishVocalArtifact(id, prepared.lrc, 'lrc');
      p.vocal = { ...p.vocal, schema: 'vocal/v1', inputRevision: expected + 1,
        draft: { plan: prepared.plan, mix: gains, inputToken: token, audioHash: p.audio.hash, duration: p.song.duration, ustxFile: ustx.file, lrcFile: lrc.file, lyrics: prepared.lyrics }, candidate: null };
      return p;
    });
  } catch (error) { if (error.name === 'UstxError') throw new ProjectError(error.message); throw error; }
  return vocalState(id);
}
export function createVocalJob(id, expected) {
  requireRevision(expected, 'expectedInputRevision');
  const project = readProject(id), v = project.vocal;
  if (!v?.draft || v.inputRevision !== expected) throw new ProjectError('先提交乐谱并读取当前版本', 409);
  if (v.draft.audioHash !== project.audio.hash || v.draft.duration !== project.song?.duration) throw new ProjectError('音频分析已改变，请重新提交乐谱', 409);
  const configuration = v.draft.source === 'external' ? null : vocalConfiguration(id); // Freeze machine-local configuration; never accept executable paths from tools.
  const job = { id: randomUUID(), projectId: id, kind: 'vocal', status: 'queued', progress: 0, detail: '等待歌声渲染', createdAt: Date.now(),
    input: { project, vocalRevision: expected, configuration } };
  saveJob(id, job);
  return publicJob(job);
}
export function attachVocalCandidate(id, job) {
  let attached = false;
  // Content identity and edit revision both matter, including A → B → A edits.
  try {
    mutateProject(id, undefined, (p) => {
      if (p.vocal?.inputRevision !== job.input.vocalRevision || p.vocal.draft.inputToken !== job.result.inputToken ||
          p.audio.hash !== job.input.project.audio.hash || p.song?.duration !== job.input.project.song?.duration) throw new ProjectError('stale vocal input', 409);
      p.vocal.candidate = { ...job.result, jobId: job.id }; attached = true;
      return p;
    });
  } catch (error) { if (!(error instanceof ProjectError && error.status === 409)) throw error; }
  return attached;
}
export function adoptVocal(id, expectedProjectRevision, expectedInputRevision, jobId) {
  requireRevision(expectedProjectRevision); requireRevision(expectedInputRevision, 'expectedInputRevision');
  const job = readJob(id, jobId);
  mutateProject(id, expectedProjectRevision, (p) => {
    const v = p.vocal, candidate = v?.candidate;
    if (!candidate || v.inputRevision !== expectedInputRevision || candidate.jobId !== jobId || job.status !== 'done' ||
        job.input.vocalRevision !== v.inputRevision || job.result.inputToken !== v.draft.inputToken || candidate.mixHash !== job.result.mixHash ||
        v.draft.audioHash !== p.audio.hash || v.draft.duration !== p.song?.duration) throw new ProjectError('候选已过期或尚未完成，请重读并重新渲染', 409);
    const audio = readFileSync(join(projectDir(id), candidate.mixFile));
    if (sha256(audio) !== candidate.mixHash) throw new ProjectError('候选音轨损坏，请重新渲染', 409);
    const target = join(projectDir(id), 'engine', 'audio', `vocal-${candidate.mixHash}.wav`);
    mkdirSync(join(projectDir(id), 'engine', 'audio'), { recursive: true });
    if (!existsSync(target) || sha256(readFileSync(target)) !== candidate.mixHash) {
      const temp = `${target}.${randomUUID()}.tmp`;
      try { copyFileSync(join(projectDir(id), candidate.mixFile), temp); renameSync(temp, target); }
      finally { if (existsSync(temp)) unlinkSync(temp); }
    }
    v.active = { ...candidate, adoptedAt: Date.now(), adoptedBy: 'human' };
    return p;
  });
  return readProject(id);
}
export function resetVocal(id, expectedProjectRevision) {
  requireRevision(expectedProjectRevision);
  return mutateProject(id, expectedProjectRevision, (p) => { if (p.vocal) p.vocal.active = null; return p; });
}

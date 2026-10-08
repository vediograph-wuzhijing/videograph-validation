import { ProjectError } from '../errors.mjs';
import { publicJob } from '../render-jobs.mjs';

export async function vocalRoutes({ req, res, parts, id, actor, body, json , run }, { renders }) {
  if (parts[2] === 'vocal') {
    if (req.method === 'GET' && parts.length === 3) { json(res, await run('vocalState', [id])); return true; }
    if (req.method === 'GET' && parts.length === 4 && parts[3] === 'check') { json(res, await run('checkVocal', [id])); return true; }
    if (req.method === 'POST' && parts.length <= 4) {
      const input = await body(req);
      if (parts[3] === 'import-midi') { json(res, await run('importVocalMidi', [id, input])); return true; }
      if (parts[3] === 'import-audio') { json(res, await run('submitExternalVocal', [id, input.expectedInputRevision, input])); return true; }
      if (parts.length === 3) { json(res, await run('submitVocal', [id, input.expectedInputRevision, input.plan, input.mix])); return true; }
      if (parts[3] === 'render') { const job = await run('createVocalJob', [id, input.expectedInputRevision]); renders.enqueue({ projectId: id, jobId: job.id, kind: 'vocal' }); json(res, publicJob(job), 202); return true; }
      if (parts[3] === 'adopt') { json(res, await run('adoptVocal', [id, input.expectedProjectRevision, input.expectedInputRevision, input.jobId])); return true; }
      if (parts[3] === 'reset') { json(res, await run('resetVocal', [id, input.expectedProjectRevision])); return true; }
      if (parts[3] === 'lyrics') {
        const project = await run('readProject', [id]), lyrics = project.vocal?.active?.lyrics;
        if (!lyrics?.lines?.length) throw new ProjectError('已采用乐谱没有 text 显示歌词', 409);
        json(res, await run('submitSongLyrics', [id, input.expectedProjectRevision, { lines: lyrics.lines, textSource: 'user', timingSource: 'score' }, actor])); return true;
      }
    }
  }
  return false;
}

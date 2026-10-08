import { ProjectError, requireRevision } from '../errors.mjs';
import { cueSheet } from '../rhythm.mjs';

export async function songRoutes({ req, res, url, parts, id, body, json , run }) {
  if (parts[2] === 'cue-sheet' && req.method === 'GET') {
    const project = await run('readProject', [id]);
    if (!project.song) throw new ProjectError(`工程还在 ${project.status ?? '未知'} 阶段，没有音乐分析`, 409);
    const number = (key) => (url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined);
    const sheet = cueSheet(project.song, { start: number('start') ?? 0, end: number('end') ?? Infinity, shots: project.shots, transitions: project.transitions });
    json(res, { projectId: id, revision: project.revision, text: sheet.text, grid: sheet.grid, bars: sheet.bars.length }); return true;
  }
  if (parts[2] === 'song' && parts[3] === 'analysis' && req.method === 'GET') { json(res, await run('getSongAnalysis', [id, url.searchParams.toString()])); return true; }
  if (parts[2] === 'song' && parts[3] === 'analysis' && parts[4] === 'confirm' && req.method === 'POST') { const input = await body(req); json(res, await run('confirmSongAnalysis', [id, input.author, requireRevision(input.expectedRevision)])); return true; }
  if (parts[2] === 'song' && parts[3] === 'analysis' && parts[4] === 'retry' && req.method === 'POST') { const input = await body(req); json(res, await run('retryAnalysis', [id, requireRevision(input.expectedRevision)])); return true; }
  if (parts[2] === 'song' && parts[3] === 'analysis' && parts[4] === 'patch' && req.method === 'POST') { const input = await body(req); json(res, await run('patchSongAnalysis', [id, input.expectedInputRevision, input.patch, input.author ?? 'human'])); return true; }
  if (parts[2] === 'song' && parts[3] === 'lyrics' && req.method === 'POST') { const input = await body(req); json(res, await run('submitSongLyrics', [id, input.expectedInputRevision, input.lyrics, input.author ?? 'human'])); return true; }
  if (parts[2] === 'plan' && req.method === 'POST') { const input = await body(req); json(res, await run('submitPlan', [id, input.expectedInputRevision, input.plan, input.reasoning, input.author ?? 'human'])); return true; }
  return false;
}

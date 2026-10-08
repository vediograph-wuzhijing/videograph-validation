import { projectsRoot } from '../project-repository.mjs';
import { ProjectError } from '../errors.mjs';
import { decodePath, saveUpload } from '../http.mjs';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';

export async function projectsRoutes({ req, res, url, body, json , run }) {
  if (url.pathname === '/projects' && req.method === 'GET') { json(res, { projects: await run('listProjects', []) }); return true; }
  if (url.pathname === '/projects' && req.method === 'POST') {
    const input = await body(req);
    json(res, await run('createProjectFromAudio', [input.audioPath, input.name, {
      lyricsText: input.lyricsText,
      lrcPath: input.lrcPath,
      language: input.language,
      stages: input.stages,
      allowDuplicate: input.allowDuplicate === true,
      truth:input.truth,author:input.author,
    }]), 201);
    return true;
  }
  if (url.pathname === '/import-audio' && req.method === 'POST') {
    const name = decodePath(String(req.headers['x-file-name'] ?? 'audio.mp3'));
    const ext = extname(name).toLowerCase();
    if (!['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) throw new ProjectError('unsupported audio file');
    const imports = join(projectsRoot, '.imports'); mkdirSync(imports, { recursive: true });
    const temporary = join(imports, randomUUID() + ext);
    try {
      await saveUpload(req, temporary);
      json(res, await run('createProjectFromAudio', [temporary, name.replace(/\.[^.]+$/, '')]), 201);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return true;
  }
  return false;
}

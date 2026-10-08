import { projectDir } from '../project-repository.mjs';
import { ProjectError } from '../errors.mjs';
import { serveFile } from '../media-files.mjs';
import { join, sep } from 'node:path';
import { realpathSync,existsSync } from 'node:fs';

export async function mediaRoutes({ req, res, parts, id }) {
  if (parts[2] === 'files' && req.method === 'GET') {
    const relative = parts.slice(3).join('/');
    if (!/^(artifacts\/[a-f0-9]{64}\.(png|mp4|json|wav|lrc|ustx)|exports\/[a-f0-9-]{36}\/(pv\.mp4|manifest\.json))$/.test(relative)) throw new ProjectError('invalid artifact path');
    const dir=projectDir(id),file=join(dir,relative);
    if(existsSync(file)&&!realpathSync(file).startsWith(realpathSync(dir)+sep)) throw new ProjectError('artifact escapes project root',403);
    serveFile(req, res, file); return true;
  }
  return false;
}

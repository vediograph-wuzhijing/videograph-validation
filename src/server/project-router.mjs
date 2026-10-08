// Ordered feature adapters. The transport layer and runtime do not implement domain commands.
import { safeId } from './project-repository.mjs';
import { projectsRoutes } from './routes/projects.mjs';
import { libraryRoutes } from './routes/library.mjs';
import { vocalRoutes } from './routes/vocal.mjs';
import { directorRoutes } from './routes/director.mjs';
import { jobsRoutes } from './routes/jobs.mjs';
import { songRoutes } from './routes/song.mjs';
import { shotsRoutes } from './routes/shots.mjs';
import { transitionsRoutes } from './routes/transitions.mjs';
import { previewRoutes } from './routes/preview.mjs';
import { mediaRoutes } from './routes/media.mjs';

export function createProjectRouter(services) {
  const projectRoutes = [vocalRoutes, directorRoutes, jobsRoutes, songRoutes, shotsRoutes, transitionsRoutes, previewRoutes, mediaRoutes];
  return async (context) => {
    context = { ...context, run: services.run };
    if (await projectsRoutes(context) || await libraryRoutes(context)) return true;
    const { req, res, parts, json } = context;
    if (parts[0] !== 'projects' || !safeId(parts[1])) return false;
    const id = parts[1];
    if (parts.length === 2 && req.method === 'GET') { json(res, await services.run('readProject', [id])); return true; }
    if (parts[2] === 'version' && parts.length === 3 && req.method === 'GET') { json(res, await services.run('projectVersion', [id])); return true; }
    for (const route of projectRoutes) if (await route({ ...context, id }, services)) return true;
    return false;
  };
}

import { safeId } from '../project-repository.mjs';
import { ProjectError } from '../errors.mjs';

export async function libraryRoutes({ req, res, url, json, run }) {
  if (url.pathname === '/scene-components' && req.method === 'GET') {json(res,await run('sceneComponents',[url.searchParams.get('query')??'']));return true;}
  const component=/^\/scene-components\/([a-z-]+)$/.exec(url.pathname);
  if(component&&req.method==='GET'){json(res,await run('sceneComponent',[component[1]]));return true;}
  if (url.pathname === '/fx/effects' && req.method === 'GET') {
    // 特效箱（审阅室 UI 用）：本仓库动效 + 本机已下载的 gl-transitions；含着色器代码，前端直接在浏览器里实时预览。
    json(res, await run('effectLibrary',[])); return true;
  }
  if (url.pathname === '/feedback' && req.method === 'GET') {
    const projectId = url.searchParams.get('projectId') ?? undefined;
    if (projectId !== undefined && !safeId(projectId)) throw new ProjectError('invalid project id');
    json(res, await run('feedbackInbox',[{ projectId, status: url.searchParams.get('status') ?? 'open',shotId:url.searchParams.get('shotId')??undefined }])); return true;
  }
  return false;
}

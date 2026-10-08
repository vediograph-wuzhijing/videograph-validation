import { createProjectPreview } from '../preview-project.mjs';

export async function previewRoutes({ req, res, parts, id, body, json, run }, { previews }) {
  if (parts[2] === 'draft' && parts.length === 4 && req.method === 'POST') {
    const input = await body(req);
    if (parts[3] === 'check') { json(res, await run('checkSceneDraft',[id,input])); return true; }
    if (parts[3] === 'stills') { json(res, await run('sampleSceneDraft',[id,input])); return true; }
    if (parts[3] === 'preview') {
      const draft = await run('prepareSceneDraft',[id,input]);
      const preview = await previews.get(`draft:${id}:${draft.shot.id}`,JSON.stringify([draft.revision,draft.shot.module,draft.shot.params]),draft.serverOptions);
      json(res,{url:preview.server.url,revision:draft.revision,ephemeral:true,range:{start:draft.shot.start,end:draft.shot.end,only:draft.shot.id}}); return true;
    }
  }
  if (parts[2] !== 'preview' || req.method !== 'POST') return false;
  json(res, await createProjectPreview(previews, id, await body(req),run));
  return true;
}

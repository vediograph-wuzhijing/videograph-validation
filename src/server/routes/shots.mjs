import { safeId } from '../project-repository.mjs';

export async function shotsRoutes({ req, res, parts, id, body, json , run }) {
  if (parts[2] === 'scene-modules' && safeId(parts[3]) && parts.length === 4 && req.method === 'POST') {
    const input = await body(req);
    json(res, await run('submitSceneModule', [id, parts[3], input.expectedProjectRevision, input.code, input.bindings, input.summary, input.author])); return true;
  }
  if (parts[2] === 'shots' && safeId(parts[3])) {
    if (parts[4] === 'lyrics' && req.method === 'GET') { json(res, await run('readShotLyricContext', [id, parts[3]])); return true; }
    if (parts[4] === 'source' && req.method === 'GET') { json(res, await run('readShotSource', [id, parts[3]])); return true; }
    if (parts[4] === 'source' && req.method === 'POST') { const input = await body(req); json(res, await run('submitShotSource', [id, parts[3], input.expectedInputRevision, input.code, input.summary, input.addressedFeedbackIds, input.author, input.feedbackResponses, input.attemptToken])); return true; }
    if (parts[4] === 'feedback' && parts.length === 5 && req.method === 'POST') { const input = await body(req); json(res, await run('addShotFeedback', [id, parts[3], input.expectedInputRevision, { text: input.text, anchor: input.anchor, preserve: input.preserve, author: input.author }])); return true; }
    if (parts[4] === 'feedback' && safeId(parts[5]) && ['ask', 'reply'].includes(parts[6]) && req.method === 'POST') {
      const input = await body(req);
      json(res, parts[6] === 'ask' ? await run('askFeedback', [id, 'shot', parts[3], parts[5], input.question, input.author ?? 'mcp']) : await run('replyFeedback', [id, 'shot', parts[3], parts[5], input.text, input.author ?? 'human'])); return true;
    }
    if (parts[4] === 'reject-feedback' && req.method === 'POST') { const input = await body(req); json(res, await run('rejectShotFeedback', [id, parts[3], input.expectedInputRevision])); return true; }
    if (parts[4] === 'accept-feedback' && req.method === 'POST') { const input = await body(req); json(res, await run('acceptShotFeedback', [id, parts[3], input.expectedInputRevision, input.feedbackIds])); return true; }
    if (parts.length === 4 && req.method === 'POST') { const input = await body(req); json(res, await run('updateShot', [id, parts[3], input.expectedInputRevision, input.patch ?? {}, input.attemptToken, input.author ?? 'human'])); return true; }
  }
  return false;
}

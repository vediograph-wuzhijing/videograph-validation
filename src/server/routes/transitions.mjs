import { safeId } from '../project-repository.mjs';
import { ProjectError } from '../errors.mjs';
import { transitionPair, transitionWindow } from '../transitions.mjs';

export async function transitionsRoutes({ req, res, parts, id, body, json , run }, { enqueue }) {
  if (parts[2] === 'transitions' && safeId(parts[3])) {
    const transitionId = parts[3];
    const project = await run('readProject', [id]);
    const transition = project.transitions.find((entry) => entry.id === transitionId);
    if (!transition) throw new ProjectError('transition not found', 404);
    if (req.method === 'GET' && parts.length === 4) {
      const { left, right } = transitionPair(project, transition);
      json(res, { transition, fromShot: left, toShot: right, window: transitionWindow(project, transition), rule: '过渡位于切点之后，出镜停在末帧，入镜跟随当前歌曲时间；不改变全片时长。' }); return true;
    }
    if (req.method === 'POST') {
      const input = await body(req);
      if (parts[4] === 'config') { json(res, await run('configureTransition', [id, transitionId, input.expectedInputRevision, input.config, input.addressedFeedbackIds, input.author, input.feedbackResponses, input.attemptToken])); return true; }
      if (parts[4] === 'feedback' && parts.length === 5) { json(res, await run('addShotFeedback', [id, transitionId, input.expectedInputRevision, { text: input.text, anchor: input.anchor, preserve: input.preserve, author: input.author }, 'transition'])); return true; }
      if (parts[4] === 'feedback' && safeId(parts[5]) && parts[6] === 'ask') { json(res, await run('askFeedback', [id, 'transition', transitionId, parts[5], input.question, input.author ?? 'mcp'])); return true; }
      if (parts[4] === 'feedback' && safeId(parts[5]) && parts[6] === 'reply') { json(res, await run('replyFeedback', [id, 'transition', transitionId, parts[5], input.text, input.author ?? 'human'])); return true; }
      if (parts[4] === 'accept-feedback') { json(res, await run('acceptShotFeedback', [id, transitionId, input.expectedInputRevision, input.feedbackIds, 'transition'])); return true; }
      if (parts[4] === 'reject-feedback') { json(res, await run('rejectShotFeedback', [id, transitionId, input.expectedInputRevision, 'transition'])); return true; }
      if (parts[4] === 'validate') { json(res, await enqueue(id, 'validate-transition', { transitionId }), 202); return true; }
      if (parts.length === 4) { json(res, await run('updateTransition', [id, transitionId, input.expectedInputRevision, input.patch, input.attemptToken, input.author])); return true; }
    }
  }
  return false;
}

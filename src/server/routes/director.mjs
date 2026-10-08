export async function directorRoutes({ req, res, parts, id, body, json, run }, { renders }) {
  if (parts[2] === 'director') {
    if (req.method === 'GET' && parts.length <= 4) { json(res, await run('getDirector', [id])); return true; }
    if (req.method === 'POST') {
      const input = await body(req);
      if (parts.length === 3) { json(res, await run('submitDirector', [id, input.expectedProjectRevision, input.director, input.author ?? 'mcp'])); return true; }
      if (parts[3] === 'claim') { json(res, await run('claimDirector', [id, input.actionId, input.owner, input.leaseSeconds])); return true; }
      if (parts[3] === 'complete') { json(res, await run('completeDirector', [id, input.actionId, input.attemptToken, input])); return true; }
      if (parts[3] === 'dispatch') {
        const result = await run('dispatchDirector', [id, input.actionIds, input.attemptTokens]);
        for (const job of result.jobs) if (!job.reused) renders.enqueue({projectId:id,jobId:job.jobId});
        json(res, result, 202); return true;
      }
      if (parts[3] === 'review') { json(res, await run('submitReview', [id, input.expectedProjectRevision, input.review])); return true; }
      if (parts[3] === 'accept-review') { json(res, await run('acceptDirectorReview', [id, input.expectedProjectRevision])); return true; }
    }
  }
  return false;
}

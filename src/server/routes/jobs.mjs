import { AE_KINDS, publicJob } from '../render-jobs.mjs';

export async function jobsRoutes({ req, res, url, parts, id, body, json , run }, { enqueue, waitJob, renders }) {
  if (parts[2] === 'jobs' && parts.length <= 4 && req.method === 'GET') {
    const wait = Number(url.searchParams.get('wait') ?? 0);
    if (parts[3]) json(res, publicJob(wait > 0 ? await waitJob(id, parts[3], wait) : await run('readJob', [id, parts[3], { input: false }])));
    else {
      const page = await run('listJobsPage', [id, { limit: Number(url.searchParams.get('limit') ?? 40), cursor: url.searchParams.get('cursor') ?? undefined }]);
      json(res, { ...page, jobs: page.jobs.map(publicJob) });
    }
    return true;
  }
  if (parts[2] === 'jobs' && parts[4] === 'cancel' && parts.length===5 && req.method === 'POST') {
    const job = await run('readJobMetadata', [id, parts[3]]);
    await renders.cancel(id, job);
    json(res, publicJob(await run('readJob', [id, job.id, { input: false }]))); return true;
  }
  if (parts.length===3 && parts[2] === 'validate' && req.method === 'POST') { json(res, await enqueue(id, 'validate', await body(req)), 202); return true; }
  if (parts.length===3 && parts[2] === 'stills' && req.method === 'POST') { json(res, await enqueue(id, 'stills', await body(req)), 202); return true; }
  if (parts.length===3 && AE_KINDS.includes(parts[2]) && req.method === 'POST') { json(res, await enqueue(id, parts[2], await body(req)), 202); return true; }
  if (parts.length===3 && parts[2] === 'render' && req.method === 'POST') { json(res, await enqueue(id, 'export', await body(req)), 202); return true; }
  return false;
}

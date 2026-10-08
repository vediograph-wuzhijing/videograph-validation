import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServiceAuth, authorizeMutation } from '../../../src/server/auth.mjs';
import { readJsonObject, decodePath, publicError, saveUpload } from '../../../src/server/http.mjs';
import { ProjectError } from '../../../src/server/errors.mjs';
import { PreviewPool } from '../../../src/server/preview-pool.mjs';
import { startAnalysisWorker } from '../../../src/server/analysis-jobs.mjs';
import { RenderQueue } from '../../../src/server/render-queue.mjs';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('credentials determine authority; MCP cannot perform human mutations', () => {
  const auth = createServiceAuth(new Set(['http://localhost:5188']));
  const session = auth.session('http://localhost:5188');
  assert.equal(auth.actor(`Bearer ${session.token}`), 'human');
  assert.equal(auth.actor(`Bearer ${auth.mcpToken}`), 'mcp');
  assert.throws(() => auth.session(undefined), (error) => error.status === 403);
  assert.throws(() => auth.actor('Bearer wrong'), (error) => error.status === 401);
  for (const parts of [['projects', 'p', 'director', 'accept-review'], ['projects', 'p', 'shots', 's', 'accept-feedback'], ['projects', 'p', 'transitions', 't', 'reject-feedback'], ['projects', 'p', 'shots', 's', 'feedback', 'f', 'reply']]) {
    assert.throws(() => authorizeMutation('mcp', parts, { author: 'human' }), (error) => error.status === 403);
  }
  for (const locked of [true, false]) assert.throws(() => authorizeMutation('mcp', [], { patch: { locked } }));
  authorizeMutation('mcp', [], { patch: { params: {} } });
});

test('malformed bodies and URL encodings are client errors; internal details stay server-side', async () => {
  for (const body of ['null', '[]', '42', '"x"', '{']) {
    await assert.rejects(readJsonObject(Readable.from([Buffer.from(body)])), (error) => error.status === 400);
  }
  await assert.rejects(readJsonObject(Readable.from([Buffer.alloc(5)]), 4), (error) => error.status === 413);
  assert.throws(() => decodePath('%zz'), (error) => error.status === 400);
  const error = new ProjectError('duplicate', 409, { existingProjects: [{ id: 'p' }] });
  assert.deepEqual(publicError(error), { status: 409, data: { error: 'duplicate', existingProjects: [{ id: 'p' }] } });
});

test('bounded uploads stream bytes and return HTTP 413 without destroying the response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vg-upload-test-'));
  let sequence = 0;
  const server = createServer(async (req, res) => {
    try { await saveUpload(req, join(dir, `upload-${++sequence}`), 16); res.end('saved'); }
    catch (error) { res.statusCode = error.status ?? 500; res.end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(url, { method: 'POST', body: Buffer.alloc(16, 42) });
    assert.equal(ok.status, 200); await ok.text();
    assert.deepEqual(readFileSync(join(dir, 'upload-1')), Buffer.alloc(16, 42));
    const large = await fetch(url, { method: 'POST', body: Buffer.alloc(17) });
    assert.equal(large.status, 413); await large.text();
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent previews share a host; unhealthy hosts are closed and replaced', async () => {
  let created = 0, closed = 0, healthy = true;
  const pool = new PreviewPool({ create: async () => ({ url: `host-${++created}`, healthy: async () => healthy, close: async () => { closed++; } }), limit: 1 });
  const [a, b] = await Promise.all([pool.get('s', 1, {}), pool.get('s', 1, {})]);
  assert.equal(a, b); assert.equal(created, 1);
  healthy = false;
  await pool.get('s', 1, {});
  assert.equal(created, 2); assert.equal(closed, 1);
  healthy = true;
  await pool.get('t', 1, {});
  assert.equal(closed, 2);
  await pool.close(); assert.equal(closed, 3);
  await assert.rejects(pool.get('s', 1, {}), /closed/);
});

test('a failed preview start does not poison later requests', async () => {
  let attempts = 0;
  const pool = new PreviewPool({ create: async () => { if (++attempts === 1) throw new Error('start failed'); return { healthy: async () => true, close: async () => {} }; } });
  await assert.rejects(pool.get('s', 1, {}), /start failed/);
  await pool.get('s', 1, {}); await pool.close();
});

test('analysis worker catches persistence failures, backs off and services another project', async () => {
  const seen = [], errors = [];
  let next;
  const advanced = new Promise((resolve) => { next = resolve; });
  const stop = startAnalysisWorker({ interval: 10,
    list: () => [{ id: 'new', createdAt: 2, status: 'analysis-pending' }, { id: 'old', createdAt: 1, status: 'analysis-pending' }],
    analyze: async (id) => { seen.push(id); if (id === 'old') throw new Error('disk failure'); next(); },
    onError: (error) => errors.push(error),
  });
  try {
    await advanced;
    assert.deepEqual(seen.slice(0, 2), ['old', 'new']); assert.equal(errors.length, 1);
  } finally { stop(); }
});

test('queue advances even when final task persistence fails', async () => {
  const children = [], errors = [];
  const queue = new RenderQueue({
    spawnWorker: () => { const child = new EventEmitter(); children.push(child); return child; },
    readJob: () => { throw new Error('project removed'); }, saveJob: () => {}, onError: (error) => errors.push(error),
  });
  queue.enqueue({ projectId: 'p', jobId: '1' }); queue.enqueue({ projectId: 'p', jobId: '2' });
  children[0].emit('close', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.active.jobId, '2'); assert.equal(errors.length, 1);
  children[1].emit('close', 1); await new Promise(resolve => setImmediate(resolve)); assert.equal(queue.active, null); queue.close();
});

test('stalled worker is stopped and the next task can proceed', async () => {
  let killed;
  const stopped = new Promise((resolve) => { killed = resolve; });
  const jobs = new Map([['1', { id: '1', status: 'running', progress: 0 }], ['2', { id: '2', status: 'running', progress: 0 }]]);
  const children = [];
  const queue = new RenderQueue({ stallMs: 10,
    spawnWorker: () => { const child = new EventEmitter(); child.kill = () => { child.emit('close', 1); killed(); }; children.push(child); return child; },
    readJob: (_, id) => jobs.get(id), saveJob: (_, job) => jobs.set(job.id, job),
  });
  // Keep the event loop alive while awaiting the unref'ed watchdog.
  const deadline = setTimeout(() => {}, 1000);
  try {
    queue.enqueue({ projectId: 'p', jobId: '1' }); queue.enqueue({ projectId: 'p', jobId: '2' });
    await stopped;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(jobs.get('1').status, 'error'); assert.match(jobs.get('1').error, /stalled/);
    assert.equal(queue.active.jobId, '2');
    jobs.get('2').status = 'done'; children[1].emit('close', 0);
  } finally { clearTimeout(deadline); queue.close(); }
});

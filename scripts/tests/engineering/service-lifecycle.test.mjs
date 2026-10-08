import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServiceConfig } from '../../../src/server/service-config.mjs';

const root = mkdtempSync(join(tmpdir(), 'vg-service-lifecycle-'));
process.env.VIDEOGRAPH_PROJECTS = join(root, 'projects');
const { createProjectService } = await import('../../../src/server/service.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));
const config = (name, port = 0) => readServiceConfig({ VIDEOGRAPH_SERVICE_PORT: String(port), VIDEOGRAPH_SERVICE_TOKEN_FILE: join(root, name) });

test('非法端口、来源和任务预算在启动前明确拒绝', () => {
  for (const port of ['', '-1', '1.5', '65536', 'NaN']) assert.throws(() => readServiceConfig({ VIDEOGRAPH_SERVICE_PORT: port }), /PORT/);
  for (const origin of ['', '*', 'https://localhost:5188', 'http://example.com:5188', 'http://localhost:5188/path']) assert.throws(() => readServiceConfig({ VIDEOGRAPH_STUDIO_ORIGINS: origin }));
  for (const budget of ['0', '-1', 'Infinity', 'x']) assert.throws(() => readServiceConfig({ VIDEOGRAPH_JOB_STALL_MS: budget }), /STALL/);
});
test('创建服务不启动进程、不发布令牌，关闭可重复且不可再启动', async () => {
  const service = createProjectService(config('not-started'));
  assert.equal(service.server.listening, false); assert.equal(existsSync(join(root, 'not-started')), false);
  await service.close(); await service.close();
  await assert.rejects(service.start(), /closed/);
});
test('并发start共用实例；占用端口的失败实例不能覆盖凭证；HTTP权限保持', async () => {
  const service = createProjectService(config('active-token'));
  try {
    const [a, b] = await Promise.all([service.start(), service.start()]); assert.equal(a.url, b.url);
    assert.equal((await (await fetch(a.url + '/health')).json()).ok, true);
    assert.equal((await fetch(a.url + '/projects')).status, 401);
    assert.equal((await fetch(a.url + '/session', { headers: { origin: 'http://evil.example' } })).status, 403);
    const session = await (await fetch(a.url + '/session', { headers: { origin: 'http://127.0.0.1:5188' } })).json();
    const headers = { authorization: `Bearer ${session.token}` };
    assert.deepEqual(await (await fetch(a.url + '/projects', { headers })).json(), { projects: [] });
    assert.equal((await fetch(a.url + '/projects/%zz', { headers })).status, 400);
    const token = readFileSync(join(root, 'active-token'), 'utf8');
    const conflict = createProjectService(config('active-token', a.port));
    await assert.rejects(conflict.start(), (error) => error.code === 'EADDRINUSE');
    await conflict.close(); assert.equal(readFileSync(join(root, 'active-token'), 'utf8'), token);
    assert.equal((await fetch(a.url + '/health')).status, 200);
    const sameRoot = createProjectService(config('other-token'));
    await assert.rejects(sameRoot.start(), error => error.status === 409);
    assert.equal(existsSync(join(root, 'other-token')), false);
    await sameRoot.close();
    assert.equal((await fetch(a.url + '/health')).status, 200);
    await service.prepareIdleStop();
    assert.equal((await fetch(a.url + '/projects', { headers })).status, 503);
    await assert.rejects(service.prepareIdleStop(), error => error.status === 409);
  } finally { await service.close(); }
  assert.equal(service.server.listening, false);
});
test('启动途中关闭不会发布凭证或漏出监听端口', async () => {
  const service = createProjectService(config('cancelled-token'));
  const started = assert.rejects(service.start(), /closed/);
  await Promise.all([started, service.close()]);
  assert.equal(service.server.listening, false); assert.equal(existsSync(join(root, 'cancelled-token')), false);
});
test('端口获取后初始化失败也会清理监听器', async () => {
  const cfg = config('token-directory'); mkdirSync(cfg.tokenPath);
  const service = createProjectService(cfg);
  await assert.rejects(service.start());
  assert.equal(service.server.listening, false);
});

// engine-e2e.mjs — 特效箱进真实引擎的端到端验收（独立实例，不碰用户工程）。
// 用法：node scripts/fx/engine-e2e.mjs   （需要 ../pdoom-video 参考仓库与 Edge）
// 步骤：参考 BGM 建工程 → 镜头 1 修改前静帧 → 套用后期栈（Risograph + 拍点推镜）→ 修改后静帧 → 第 1 个切点配 gl-transitions 转场 → 转场中段静帧。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../tests/helpers/free-port.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const work = join(root, '.cache/fx-e2e');
rmSync(work, { recursive: true, force: true }); mkdirSync(join(work, 'projects'), { recursive: true });
const port = await freePort(), base = `http://127.0.0.1:${port}`, tokenFile = join(work, 'token');
const service = spawn(process.execPath, ['--no-warnings', 'src/server/index.mjs'], { cwd: root, stdio: 'inherit',
  env: { ...process.env, VIDEOGRAPH_SERVICE_PORT: String(port), VIDEOGRAPH_PROJECTS: join(work, 'projects'), VIDEOGRAPH_SERVICE_TOKEN_FILE: tokenFile, VIDEOGRAPH_STUDIO_ORIGINS: 'http://127.0.0.1:5388' } });
for (let i = 0; i < 100 && !existsSync(tokenFile); i++) await new Promise((r) => setTimeout(r, 100));
const token = readFileSync(tokenFile, 'utf8');
async function http(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}
async function job(projectId, started) {
  for (;;) {
    const current = await http(`/projects/${projectId}/jobs/${started.id}?wait=50`);
    if (current.status === 'done') return current;
    if (['error', 'cancelled', 'interrupted'].includes(current.status)) throw new Error(`${current.kind} ${current.status}: ${current.error}`);
  }
}
async function still(projectId, body, name) {
  const done = await job(projectId, await http(`/projects/${projectId}/stills`, { width: 960, ...body }));
  const file = done.result.stills.images[0].file;
  copyFileSync(join(work, 'projects', projectId, file), join(work, `${name}.png`));
  return join(work, `${name}.png`);
}
try {
  const project = await http('/projects', { audioPath: resolve(root, '../pdoom-video/audio/pdoom.mp3'), name: 'FX 引擎验收' });
  const shot = project.shots[0];
  const t = +(shot.start + (shot.end - shot.start) * 0.4).toFixed(3);
  const before = await still(project.id, { shotId: shot.id, times: [t] }, '1-before');
  const updated = await http(`/projects/${project.id}/shots/${shot.id}`, { expectedInputRevision: shot.inputRevision, patch: { effects: [{ id: 'riso-two-ink' }, { id: 'beat-zoom-punch' }] } });
  const after = await still(project.id, { shotId: shot.id, times: [t] }, '2-riso');
  const transition = updated.transitions[0];
  const configured = await http(`/projects/${project.id}/transitions/${transition.id}/config`, { expectedInputRevision: transition.inputRevision, config: { mode: 'effect', effectId: 'gl-directionalwarp', duration: 0.6 } });
  const tr = configured.transitions.find((entry) => entry.id === transition.id);
  const right = configured.shots.find((entry) => entry.id === tr.toShotId);
  const mid = await still(project.id, { transitionId: tr.id, times: [+(right.start + 0.3).toFixed(3)] }, '3-transition-mid');
  const validate = await job(project.id, await http(`/projects/${project.id}/validate`, { shotId: shot.id }));
  console.log(JSON.stringify({ ok: true, projectId: project.id, effects: updated.shots[0].effects.map((e) => e.id), transition: { mode: tr.mode, effect: tr.effect?.id }, before, after, mid, validate: validate.status }, null, 2));
} finally { service.kill(); }

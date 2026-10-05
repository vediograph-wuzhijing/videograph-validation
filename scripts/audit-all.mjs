// audit-all.mjs — 全量浏览器回归：对工程工作台跑 project-view-audit。
// 旧演示视图（单镜头工坊 / P(DOOM) 教学 / 创意工作区 / 旧工作流）已随 CLEANUP-01 移除，
// 对应审计脚本一并删除；完整 MCP+GPU 链路另见 transition-integration-audit.mjs。
// 前提：service(5191) 与 dev(5188) 已运行；可用 VIDEOGRAPH_AUDIT_PROJECT 指定工程 id。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const serviceUrl = process.env.VIDEOGRAPH_SERVICE_URL ?? 'http://127.0.0.1:5191';
const studioOrigin = process.env.VIDEOGRAPH_STUDIO_ORIGIN ?? 'http://127.0.0.1:5188';

const session = await fetch(`${serviceUrl}/session`, { headers: { origin: studioOrigin } });
if (!session.ok) throw new Error(`无法获取服务令牌（${session.status}）：请先 npm run service`);
const { token } = await session.json();
const listing = await fetch(`${serviceUrl}/projects`, { headers: { authorization: `Bearer ${token}` } });
if (!listing.ok) throw new Error(`工程列表读取失败（${listing.status}）`);
const { projects } = await listing.json();
// 目标选择：VIDEOGRAPH_AUDIT_PROJECT > VIDEOGRAPH_AUDIT_REFERENCE（默认 ROADMAP §二 点名的参考复现工程）> 第一个工程。
// 不能默认拿"第一个"：它可能是并行会话正在改写的活跃工作区（needs-generation 会让预览按钮禁用）。
const referenceId = process.env.VIDEOGRAPH_AUDIT_REFERENCE ?? '62a1d69e-14a4-4012-984b-d6a18a62a58f';
if (process.env.VIDEOGRAPH_AUDIT_PROJECT && !projects.some((p) => p.id === process.env.VIDEOGRAPH_AUDIT_PROJECT)) {
  throw new Error(`VIDEOGRAPH_AUDIT_PROJECT=${process.env.VIDEOGRAPH_AUDIT_PROJECT} 不在 ${serviceUrl} 的工程列表里`);
}
if (!process.env.VIDEOGRAPH_AUDIT_PROJECT && !projects.some((p) => p.id === referenceId)) {
  console.warn(`参考工程 ${referenceId} 不在本机，改用第一个工程；用 VIDEOGRAPH_AUDIT_PROJECT 或 VIDEOGRAPH_AUDIT_REFERENCE 指定稳定夹具`);
}
const projectId = process.env.VIDEOGRAPH_AUDIT_PROJECT
  ?? (projects.some((p) => p.id === referenceId) ? referenceId : projects[0]?.id);
if (!projectId) throw new Error('服务中没有任何工程；先用界面或 MCP 建工程后再跑审计');

console.log(`project-view-audit → ${projectId}`);
const result = spawnSync(process.execPath, ['scripts/project-view-audit.mjs', projectId], { cwd: root, stdio: 'inherit', timeout: 300000 });
if (result.status !== 0) { console.error(`FAILED: project-view-audit exit ${result.status}`); process.exitCode = 1; }

// FB-04 人机协作端到端：独立实例 + 真实 MCP stdio + 参考工程导入 + 真引擎渲染（约 10–25 分钟，GPU）。
// SKIP_FB04_E2E=1 可跳过（只想快速回归工程视图时）；导出以 fps=4 低速完整成片。
if (process.env.SKIP_FB04_E2E === '1') {
  console.log('SKIP_FB04_E2E=1 → 跳过 feedback-e2e.audit');
} else if (process.exitCode) {
  console.log('前序审计失败 → 跳过 feedback-e2e.audit');
} else {
  console.log('feedback-e2e.audit → FB-04 人机协作端到端（独立实例）');
  const e2e = spawnSync(process.execPath, ['scripts/tests/collaboration/feedback-e2e.audit.mjs'], { cwd: root, stdio: 'inherit', timeout: 2100000 });
  if (e2e.status !== 0) { console.error(`FAILED: feedback-e2e exit ${e2e.status}`); process.exitCode = 1; }
}

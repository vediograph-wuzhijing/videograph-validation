// mcp-director-tools.ts — AI AE 导演/操作层：持久化意图、可恢复待办和版本绑定审片证据。
// MCP 只调用本机工程服务；GLM 负责创作判断，服务负责版本、租约和质量闸门。
import { serviceFetch as request } from './mcp-feedback-tools.ts';

const baseProperties = { projectId: { type: 'string' } };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: { ...baseProperties, ...properties }, required });

export const directorToolDefinitions = [
  { name: 'project_director_get', description: '读取工程级 AI 导演状态：方案、阶段、待办 actions、阻塞、版本签名、审片状态与可恢复操作；不返回整片源码。与 project_director_next 返回同一份当前事实。', inputSchema: schema({}, ['projectId']) },
  { name: 'project_director_next', description: '与 project_director_get 返回同一份导演状态（同一服务端点），用于“接下来做什么”：按 actions 顺序处理，每项带稳定 actionId、目标版本、目标 token、MCP 工具和原因。不把技术通过冒充人工采用。', inputSchema: schema({}, ['projectId']) },
  { name: 'project_director_submit', description: '保存工程级创作简报、风格基准、完整段落节奏目标和逐镜制作 brief。不会直接改镜头；必须带当前工程 expectedProjectRevision。记为 AI 提交。', inputSchema: schema({ expectedProjectRevision: { type: 'integer', minimum: 0 }, director: { type: 'object' } }, ['projectId', 'expectedProjectRevision', 'director']) },
  { name: 'project_director_claim', description: '以短租约 claim 一个当前导演待办，防止多个 GLM 会话同时改同一目标。返回 attemptToken；写镜头/转场时带上它。', inputSchema: schema({ actionId: { type: 'string' }, owner: { type: 'string' }, leaseSeconds: { type: 'integer', minimum: 30, maximum: 900 } }, ['projectId', 'actionId', 'owner']) },
  { name: 'project_director_complete', description: '完成或记录失败的导演待办。必须提供 claim 返回的 attemptToken，并引用真实 jobIds；服务会校验目标版本和任务结果，不能只传 done。', inputSchema: schema({ actionId: { type: 'string' }, attemptToken: { type: 'string' }, outcome: { type: 'string', enum: ['done', 'failed'] }, jobIds: { type: 'array', items: { type: 'string' }, maxItems: 100 }, error: { type: 'string' } }, ['projectId', 'actionId', 'attemptToken', 'outcome']) },
  { name: 'project_director_dispatch', description: '批量入队已 claim 的确定性验证/审片/导出待办（不生成源码，不替代 GLM 创作）。重复调用会复用当前版本的任务。', inputSchema: schema({ actionIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 }, attemptTokens: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 } }, ['projectId', 'actionIds', 'attemptTokens']) },
  { name: 'project_review_submit', description: '提交当前导演方案的证据化 AI 自评，引用真实 stills/filmstrip/contact-sheet/rhythm 任务和 PNG。自评不接受意见、不代替人审美采用。', inputSchema: schema({ expectedProjectRevision: { type: 'integer', minimum: 0 }, review: { type: 'object' } }, ['projectId', 'expectedProjectRevision', 'review']) },
];
export const directorToolNames = new Set(directorToolDefinitions.map((tool) => tool.name));

export async function callDirectorTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = encodeURIComponent(String(args.projectId ?? ''));
  if (name === 'project_director_get' || name === 'project_director_next') return request(`/projects/${id}/director`);
  if (name === 'project_director_submit') return request(`/projects/${id}/director`, { expectedProjectRevision: args.expectedProjectRevision, director: args.director, author: 'mcp' });
  if (name === 'project_director_claim') return request(`/projects/${id}/director/claim`, { actionId: args.actionId, owner: args.owner, leaseSeconds: args.leaseSeconds });
  if (name === 'project_director_complete') return request(`/projects/${id}/director/complete`, { actionId: args.actionId, attemptToken: args.attemptToken, outcome: args.outcome, jobIds: args.jobIds ?? [], error: args.error });
  if (name === 'project_director_dispatch') return request(`/projects/${id}/director/dispatch`, { actionIds: args.actionIds, attemptTokens: args.attemptTokens });
  if (name === 'project_review_submit') return request(`/projects/${id}/director/review`, { expectedProjectRevision: args.expectedProjectRevision, review: args.review });
  throw new Error(`unknown director tool: ${name}`);
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectToolDefinitions, callProjectTool } from '../server/mcp-tools.ts';
import { feedbackToolDefinitions, feedbackToolNames, callFeedbackTool, mcpToolResult, ServiceError } from '../server/mcp-feedback-tools.ts';
import { aeToolDefinitions, aeToolNames, callAeTool } from '../server/mcp-ae-tools.ts';
import { directorToolDefinitions, directorToolNames, callDirectorTool } from '../server/mcp-director-tools.ts';
import { fxToolDefinitions, fxToolNames, callFxTool } from '../server/mcp-fx-tools.ts';
import { vocalToolDefinitions, vocalToolNames, callVocalTool } from '../server/mcp-vocal-tools.ts';
import { workflowToolDefinitions, workflowToolNames, callWorkflowTool } from '../server/mcp-workflow-tools.ts';

// VideoGraph = LLM 的 After Effects：本 server 是 LLM 操作工程的唯一入口（工具定义见 ../server/mcp-*.ts）。
// 旧演示视图的 shot_queue_*、shot_cards_*、pdoom_*、lyric_research_draft 工具已于 CLEANUP-01 移除。

const productRoot = fileURLToPath(new URL('../..', import.meta.url));
// 服务器级说明：所有 MCP 客户端在会话开始时都会拿到，纠正“一说改就新建工程”“改一镜全片重渲”两类误用。
const instructions = [
  'VideoGraph 是 LLM 的 After Effects：你通过这些工具操作本机视频工程，人在审阅室看片、提意见、采用。完整说明见 resource videograph://docs/mcp-guide。',
  '1. 先找已有工程：用户要求修改、继续、重新导出某部片子时，先 project_list（按名称/音频辨认）→ project_get，然后在这个工程上改。只有用户明确要做一部新片才调用 project_create_from_audio；服务对同一音频返回 409 + existingProjects 时改用已有工程。会话里记住并沿用 projectId。',
  '2. 先草稿检查/预览：project_draft_check / preview / stills 不产生修订或任务；满意后正式提交。改一个镜头用 project_shot_submit（从共享模块脱离），共享源码更新用 project_scene_module_submit 一次提交所有显式引用镜头，一个修订；不要循环提交同一份代码。导出缓存按源码哈希 + params + 后期栈 + 素材计算，读取 result.cacheSummary 与 missReason。',
  '3. 硬规则：AI 不能接受/采用意见、不能接受审片、不能解锁镜头或转场；409 时重读最新版本再判断，不要原样重试。',
  '4. 歌声制作：project_vocal_import_midi 生成可核对的假名/声库别名乐谱草稿，或 project_vocal_import_audio 冻结外部处理人声；get → submit → render → project_job_get。实测音高与频段报告不能代替试听。只有人在审阅室采用混音。',
  '5. 检索与协作：先 scene_component_search/get、effect_search/get 检索基础件、特效和转场；project_feedback_inbox 按 projectId/shotId 读意见。project_filmstrip/contact_sheet 检查连续运动与跨镜头联系表。轮询 project_version_get，变化后分页 project_jobs_get；service_health_get 看代码过期及积压。',
  '6. 开工必须读 shotcraft/craft_guide 并检索现有特效和基础件；有参考作品先抽帧看画面和运动，再读实现。每轮先读 project_feedback_inbox(status=open)，仅改变化目标，草稿少量静帧通过后提交，默认 project_filmstrip 做连续帧自查。局部示例：start/end 相差2秒、sampleFps=6、columns=6，约12帧；不要同时传shotId/transitionId，时间从实际事件推导。任务done后实际读图，导出前列明无法验证的播放/聆听等项。详见 craft_guide(topic=pv-production)。',
  '7. OpenUtau/歌声模块是冻结的实验方向，现有模型使用效果尚不可靠；保留既有接口，仅修已确认bug，不主动扩展或重构。技术报告不代表模型可靠制作或人已接受听感。',
].join('\n');
const server = new Server(
  { name: 'videograph', version: '0.2.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions },
);

function textResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...projectToolDefinitions, ...feedbackToolDefinitions, ...aeToolDefinitions, ...directorToolDefinitions, ...fxToolDefinitions, ...vocalToolDefinitions, ...workflowToolDefinitions],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  // FX：在 MCP 进程内执行（按需从上游下载），不需要工程服务；直接返回 MCP content（含案例联系表图片）。
  if (fxToolNames.has(name)) {
    try { return await callFxTool(name, args); }
    catch (error) {
      // 只有网络/下载类错误才提示 GitHub；参数错误（如特效箱里没有某个 id）不该引导去查网络。
      const network = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|TimeoutError|rate limit|github|HTTP 4\d\d|HTTP 5\d\d/i.test(`${String(error)} ${String((error as { cause?: unknown }).cause ?? '')}`);
      return textResult({ error: String(error), ...(network ? { hint: '需要能访问 github.com；GitHub API 匿名限额 60 次/小时，可设置 GITHUB_TOKEN' } : {}) }, true);
    }
  }
  if (workflowToolNames.has(name)) {
    try { const result = await callWorkflowTool(name,args); return 'content' in result ? result : mcpToolResult(result); }
    catch(error) {return textResult({error:error instanceof Error?error.message:String(error),...(error instanceof ServiceError?{status:error.status,...error.details}:{})},true);}
  }
  const call = vocalToolNames.has(name) ? callVocalTool
    : feedbackToolNames.has(name) ? callFeedbackTool
    : aeToolNames.has(name) ? callAeTool
    : directorToolNames.has(name) ? callDirectorTool
    : projectToolDefinitions.some((tool) => tool.name === name) ? callProjectTool : null;
  if (!call) return textResult({ error: `Unknown tool: ${name}` }, true);
  try { return mcpToolResult(await call(name, args), { embedImages: args.embedImages !== false }); }
  catch (error) {
    const details = error instanceof ServiceError ? { status: error.status, ...error.details } : {};
    return textResult({ error: error instanceof Error ? error.message : String(error), ...details }, true);
  }
});

// AE-05：技法库与平台指南作为 MCP resources（只读；不暴露仓库其他文件）。
function resourceList() {
  const entries = [{ uri: 'videograph://docs/mcp-guide', name: 'VideoGraph MCP 使用指南', file: 'docs/MCP-GUIDE.md' },
    { uri: 'videograph://docs/vocal', name: '歌声合成配置、乐谱与工程接入', file: 'docs/VOCAL.md' },
    { uri: 'videograph://skills/shotcraft/SKILL.md', name: 'shotcraft 技法库总览', file: 'skills/shotcraft/SKILL.md' },
    { uri: 'videograph://skills/shotcraft/SOURCES.md', name: 'shotcraft 来源与许可', file: 'skills/shotcraft/SOURCES.md' },
    { uri: 'videograph://skills/videograph-create/SKILL.md', name: 'AI 导演制作与恢复流程', file: '.agents/skills/videograph-create/SKILL.md' },
    { uri: 'videograph://skills/videograph-create/aesthetic-review.md', name: 'AI 导演创作与审片准则', file: '.agents/skills/videograph-create/references/aesthetic-review.md' }];
  for (const file of readdirSync(join(productRoot, 'skills/shotcraft/references')).filter((name) => name.endsWith('.md')).sort()) {
    entries.push({ uri: `videograph://skills/shotcraft/references/${file}`, name: `shotcraft · ${file.replace(/\.md$/, '')}`, file: `skills/shotcraft/references/${file}` });
  }
  // AIGC 电影化短片（外部生图/生视频 + VideoGraph 合成）
  entries.push({ uri: 'videograph://skills/videograph-aigc-film/SKILL.md', name: 'AIGC 电影化短片制作流程', file: '.agents/skills/videograph-aigc-film/SKILL.md' });
  for (const file of readdirSync(join(productRoot, '.agents/skills/videograph-aigc-film/references')).filter((name) => name.endsWith('.md')).sort()) {
    entries.push({ uri: `videograph://skills/videograph-aigc-film/references/${file}`, name: `AIGC 短片 · ${file.replace(/\.md$/, '')}`, file: `.agents/skills/videograph-aigc-film/references/${file}` });
  }
  return entries;
}
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: resourceList().map(({ uri, name }) => ({ uri, name, mimeType: 'text/markdown' })),
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const entry = resourceList().find((item) => item.uri === request.params.uri);
  if (!entry) throw new Error(`unknown resource: ${request.params.uri}`);
  return { contents: [{ uri: entry.uri, mimeType: 'text/markdown', text: readFileSync(join(productRoot, entry.file), 'utf8') }] };
});

// AE-05：标准流程 prompts。正文取自 MCP-GUIDE（单一事实源），避免与指南分叉。
const guideSection = (heading: RegExp) => {
  const guide = readFileSync(join(productRoot, 'docs/MCP-GUIDE.md'), 'utf8');
  const start = guide.search(heading);
  if (start < 0) return '';
  const rest = guide.slice(start);
  const next = rest.slice(3).search(/^## \d/m);
  return next < 0 ? rest : rest.slice(0, next + 3);
};
const prompts = {
  direct_video: {
    description: '从工程意图推进 AI 导演闭环，或恢复中断的制作：下一步、claim、创作、真实审片证据、返工和交付。',
    arguments: [{ name: 'projectId', description: '继续制作的工程 ID', required: true }],
    text: (args: Record<string, string>) => `你是工程 ${args.projectId} 的导演与程序员，使用 project_director_next 获取当前事实和下一步任务。\n` +
      readFileSync(join(productRoot, '.agents/skills/videograph-create/SKILL.md'), 'utf8') +
      '\n服务不调用第二套模型：由你判断、写场景、查看真实图片。不能仅根据节奏指标声称审美通过；人工意见只能由人在界面采用。',
  },
  respond_to_feedback: {
    description: '按标准流程处理人的修改意见：收件箱 → 上下文 → 看画面 → 改写 → 逐条响应 → 验证与自查 → 交给人确认。',
    arguments: [{ name: 'projectId', description: '只处理该工程（可省略，汇总全部工程）', required: false }],
    text: (args: Record<string, string>) => `你是 VideoGraph 的操作者（LLM 的 After Effects）。${args.projectId ? `只处理工程 ${args.projectId}。` : '先用 project_feedback_inbox 汇总所有工程的待处理意见。'}\n\n` +
      `${guideSection(/^## 4\. /m)}\n\n硬规则：AI 不能接受意见；只改意见指向的目标；保留 preserve 列表；意图含糊先 project_feedback_ask。\n` +
      '改完后用 project_filmstrip（around=锚点）看动作、project_rhythm_report（shotId）量节奏，把结论写进 feedbackResponses 的 how。',
  },
  design_rhythm: {
    description: '为一个工程（或一个段落）设计节奏：读节奏表 → 规划切点与重音 → 写镜头 → 用节奏报告与帧序列自查。',
    arguments: [{ name: 'projectId', description: '工程 ID', required: true }, { name: 'section', description: '只看某个段落名（可选）', required: false }],
    text: (args: Record<string, string>) => `为工程 ${args.projectId}${args.section ? ` 的段落「${args.section}」` : ''}设计节奏：\n` +
      '1. song_cue_sheet 读节奏表，标出 ▶段首、↑↑爆发、⇗蓄力、↓↓回落和低能量留白处；不同段落要有强弱反差，不要全片同一强度。\n' +
      '2. 切点放在下拍（K 所在拍）或段首；大变化（切、爆、换色、砸落）落在 ↑↑/下拍 K 上，⇗ 处蓄力，↓↓ 处收住。\n' +
      '3. 场景里所有时间从 beatPhase/barPhase/a.kick 与词起点推导，冲击在拍点帧起跳后用脉冲衰减（halfLife 0.06–0.22s），不要缓入。\n' +
      '4. 提交并 project_validate 后：project_rhythm_report 看下拍命中率、偏移、死区/过忙、闪烁；project_filmstrip around=关键下拍 看起势与衰减；project_contact_sheet 看全片强弱与一致性。\n' +
      '5. 下拍命中率低或偏移 ≥50ms 先修时序再谈风格；闪烁 >3 次/秒必须降低闪白幅度或面积。指标只是尺子，审美由人判断，最后交给人看。\n' +
      '技法：craft_guide({ topic: "effects", query: "节拍" })、craft_guide({ topic: "transitions" })。',
  },
} as const;
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.entries(prompts).map(([name, prompt]) => ({ name, description: prompt.description, arguments: [...prompt.arguments] })),
}));
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const prompt = prompts[request.params.name as keyof typeof prompts];
  if (!prompt) throw new Error(`unknown prompt: ${request.params.name}`);
  const args = (request.params.arguments ?? {}) as Record<string, string>;
  const missing = prompt.arguments.filter((argument) => argument.required && !args[argument.name]?.trim()).map((argument) => argument.name);
  if (missing.length) throw new Error(`prompt ${request.params.name} 缺少必填参数：${missing.join(', ')}`);
  return { description: prompt.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.text(args) } }] };
});

await server.connect(new StdioServerTransport());

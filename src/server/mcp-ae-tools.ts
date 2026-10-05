// mcp-ae-tools.ts — LLM-AE 冲刺（AE-01～05）：节奏表、帧序列、全片缩略图、节奏报告、技法库节选。
// 与其他 MCP 工具一样只是本地工程服务的 HTTP 客户端；渲染类工具入队后可在本次调用内等待结果。
// @ts-ignore — 纯 JS 模块（scripts/skills/craft-excerpt.mjs），无类型声明。
import { craftGuide, CRAFT_TOPICS } from '../../scripts/skills/craft-excerpt.mjs';
import { serviceFetch, embedImagesProperty } from './mcp-feedback-tools.ts';

const waitProperty = { waitSeconds: { type: 'integer', minimum: 0, maximum: 50, description: '本次调用内最多等待渲染完成的秒数（默认 25，上限 50：MCP 客户端常见请求超时为 60 秒，入队耗时会从等待预算中扣除）；超时则返回进行中的 job，再用 project_job_get 的 waitSeconds 等待' }, ...embedImagesProperty };
const rangeProperties = {
  shotId: { type: 'string', description: '只看该镜头的时间窗' },
  transitionId: { type: 'string', description: '看该转场切点前后各 1 秒' },
  start: { type: 'number', description: '歌曲秒数；不给 shotId/transitionId 时使用，缺省为全片' },
  end: { type: 'number' },
};

export const aeToolDefinitions = [
  {
    name: 'song_cue_sheet',
    description: '读取按小节排列的文本节奏表：时间、段落（▶=段首）、音乐能量 1–5、每拍 2 格鼓点型（K/S/X/.）、歌词、能量突变（↑↑/↓↓/⇗蓄力）与现有镜头切点（✂）。规划镜头、设计节拍冲击和转场前先读它；比原始拍点数组更好推理。可按 start/end 截取。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, required: ['projectId'] },
  },
  {
    name: 'project_filmstrip',
    description: '看运动：把一段连续帧拼成一张网格图（≤24 格），每格标时间、小节.拍、下拍/K/S 与正在唱的词，下拍帧橙框。默认在目标时间段均匀取帧；around=t 时取 t 前后各 frames 帧（看冲击的起势与衰减）；sampleFps 指定密度。用真实引擎渲染，返回 MCP 图片。静帧看构图，filmstrip 看动作与节拍。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, ...rangeProperties, around: { type: 'number' }, frames: { type: 'integer', minimum: 1, maximum: 11 }, sampleFps: { type: 'number' }, thumbWidth: { type: 'integer', minimum: 160, maximum: 480 }, columns: { type: 'integer', minimum: 1, maximum: 12 }, ...waitProperty }, required: ['projectId'] },
  },
  {
    name: 'project_contact_sheet',
    description: '看全片：每个镜头取 1–3 帧（ratios，默认 0.45）拼成一张图，标镜头序号/标题/段落/时长/状态；未生成镜头显示占位。用于检查全片一致性、色彩推进、镜头之间是否雷同、段落强弱是否有起伏。返回 MCP 图片。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, ratios: { type: 'array', items: { type: 'number' }, maxItems: 3 }, thumbWidth: { type: 'integer', minimum: 160, maximum: 480 }, columns: { type: 'integer', minimum: 1, maximum: 12 }, ...waitProperty }, required: ['projectId'] },
  },
  {
    name: 'project_rhythm_report',
    description: '量节奏：按 sampleFps 顺序渲染目标时间段，计算画面运动能量与亮度，对照下拍/强 kick/强 snare 给出命中率与中位偏移（正=画面滞后）、与鼓点包络的相关与最佳偏移、离拍画面事件比例、死区（音乐强画面静）、过忙、连续无节拍反应、段落能量跟随、闪烁风险（>3 次/秒）、切点离拍距离，并给出逐小节“音乐能量 vs 画面运动”表和对照图。改完镜头后用它自查；指标是尺子，不代替人的审美。全片约需 1–3 分钟。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, ...rangeProperties, sampleFps: { type: 'integer', minimum: 10, maximum: 60, description: '默认：≤30 秒用工程帧率，更长用 15' }, ...waitProperty }, required: ['projectId'] },
  },
  {
    name: 'craft_guide',
    description: `读取 shotcraft 技法库节选（≤12k 字符）：分镜范式、转场、特效、媒介风格、制片管线、平台用法。topic 省略返回总览（五条通用法则 + 文件地图）；query 按关键词筛选小节。topic 可选：${Object.keys(CRAFT_TOPICS).join(' / ')}。`,
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(CRAFT_TOPICS) }, query: { type: 'string' } } },
  },
];
export const aeToolNames = new Set(aeToolDefinitions.map((tool) => tool.name));

const pick = (args: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));

export async function callAeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === 'craft_guide') return craftGuide({ topic: args.topic, query: args.query });
  const projectId = encodeURIComponent(String(args.projectId ?? ''));
  if (name === 'song_cue_sheet') {
    const query = new URLSearchParams(pick(args, ['start', 'end']) as Record<string, string>);
    return serviceFetch(`/projects/${projectId}/cue-sheet${query.size ? '?' + query : ''}`);
  }
  const kind = { project_filmstrip: 'filmstrip', project_contact_sheet: 'contact-sheet', project_rhythm_report: 'rhythm' }[name];
  if (!kind) throw new Error(`unknown ae tool: ${name}`);
  // 整次调用控制在 MCP 客户端常见的 60 秒超时以内：入队最多 15 秒，等待只用剩余预算。
  const started = Date.now();
  const job = await serviceFetch(`/projects/${projectId}/${kind}`, pick(args, ['shotId', 'transitionId', 'start', 'end', 'around', 'frames', 'sampleFps', 'thumbWidth', 'columns', 'ratios']), 15000);
  const budget = Math.floor(55 - (Date.now() - started) / 1000);
  const wait = Math.min(50, budget, Math.max(0, Number(args.waitSeconds ?? 25)));
  if (wait <= 0) return job;
  return serviceFetch(`/projects/${projectId}/jobs/${encodeURIComponent(String(job.id))}?wait=${wait}`, undefined, (wait + 4) * 1000);
}

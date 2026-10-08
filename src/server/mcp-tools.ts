// mcp-tools.ts — MCP 只作为本地工程服务的入口，不直接写数据库/工程文件。
import { withFeedbackResponsesSchema, serviceFetch, ServiceError } from './mcp-feedback-tools.ts';

const properties = { projectId: { type: 'string' }, shotId: { type: 'string' }, transitionId: { type: 'string' }, expectedInputRevision: { type: 'integer', minimum: 0 }, attemptToken: { type: 'string', description: '导演 claim 返回的 token；镜头 update/submit、转场 configure 时带上，以记录本次操作提交凭据。' } };
const schema = (extra: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: { ...properties, ...extra }, required });
// FB-01 意见锚点参数（人从界面或 agent 代转述时都可携带）。
const anchorSchema = { type: 'object', description: '定位锚点：t/range 落在目标时间窗内；lyricElementId 须存在于当前歌词方案；region 为 0..1 归一化区域', properties: {
  t: { type: 'number' }, range: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
  lyricElementId: { type: 'string' }, region: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
  aspect: { type: 'string', enum: ['composition', 'motion', 'typography', 'color', 'timing', 'lyrics', 'other'] } } };
const preserveSchema = { type: 'array', items: { type: 'string' }, description: '必须保留的内容（≤12 条，每条 ≤300 字）' };
// schema 已去掉 locked，但客户端不一定校验 additionalProperties；锁定只能由人改，这里再拦一次。
const hasLockedKey = (patch: unknown) => !!patch && typeof patch === 'object' && 'locked' in patch;
const allowDuplicateProperty = { type: 'boolean', description: '仅当用户明确要求用同一音频再建一个新工程时为 true；默认遇到已有工程返回 409' };
export const projectToolDefinitions = withFeedbackResponsesSchema([
  { name: 'project_list', description: '列出本地已有的视频工程（id、名称、状态、镜头数、时长、创建时间，按创建时间倒序）。用户要求修改、继续或导出某个片子时，先用它找到已有工程并沿用其 id，不要新建工程。', inputSchema: schema({}, []) },
  { name: 'project_create_from_audio', description: '从本地音频创建新工程；修改已有片子先project_list，重复音频返回409。可选truth直接导入节拍/段落/词级时间并跳过模型；缺失信号层标为中性占位。音频元数据由ffprobe核验，导入为analysis-draft，需确认后规划。没有truth时参考指纹导入或后台自动分析。', inputSchema: schema({ audioPath: { type: 'string' }, name: { type: 'string' },truth:{type:'object',description:'外部rhythm/sections/lyrics等真值，结构见MCP指南'}, lyricsText: { type: 'string', description: '歌词原文（可选，提供后做词级对齐）' }, lrcPath: { type: 'string' }, language: { type: 'string', description: '语言代码，如 zh / en' }, stages: { type: 'array', items: { type: 'string', enum: ['t0', 't1', 't3'] } }, allowDuplicate: allowDuplicateProperty }, ['audioPath']) },
  { name: 'project_create_from_bgm', description: 'project_create_from_audio 的别名（保留兼容）；同样只在用户明确要新工程时调用。', inputSchema: schema({ audioPath: { type: 'string' }, name: { type: 'string' }, allowDuplicate: allowDuplicateProperty }, ['audioPath']) },
  { name: 'song_analysis_get', description: '读取新歌工程的分析（videograph-analysis/v2）。默认层 audio/rhythm/sections/lyrics；envelopes/onsets 需在 layers 中显式请求。可按 startTime/endTime（秒）过滤。返回 inputRevision 供后续写操作。', inputSchema: schema({ startTime: { type: 'number' }, endTime: { type: 'number' }, layers: { type: 'array', items: { type: 'string', enum: ['audio', 'rhythm', 'sections', 'lyrics', 'envelopes', 'onsets'] } } }, ['projectId']) },
  { name: 'song_lyrics_submit', description: '整层替换歌词（v2 结构：{ lines: [{ text, start, end, words: [{ w, start, end }] }] }，时间单位秒），用于修正误听/补词。经契约校验后工程回到 analysis-draft，需再次 song_analysis_confirm。', inputSchema: schema({ lyrics: { type: 'object' } }, ['projectId', 'expectedInputRevision', 'lyrics']) },
  { name: 'song_analysis_confirm', description: '确认分析：analysis-draft → analysis-confirmed，之后才能规划镜头。agent 可调用（记为 confirmedBy: mcp）；调用前先用 song_analysis_get 核对节拍/歌词/段落，明显误听先用 song_lyrics_submit 修正。超过半数歌词行是估算或零时长时返回422，必须先校正时间。', inputSchema: schema({}, ['projectId', 'expectedInputRevision']) },
  { name: 'song_analysis_retry', description: '重新排队 analysis-failed 的新歌分析；失败时不伪造分析结果。', inputSchema: schema({}, ['projectId', 'expectedInputRevision']) },
  { name: 'song_analysis_patch', description: '在规划前以工程版本修正 rhythm 或 sections 整层；成功后回到 analysis-draft，必须重新读取并确认。记为 AI 修正。', inputSchema: schema({ patch: { type: 'object' } }, ['projectId', 'expectedInputRevision', 'patch']) },
  { name: 'project_plan_submit', description: '仅 analysis-confirmed 可用。plan锚点可用lineText/sectionIndex/t，默认strict不切词；cutPolicy=sustain允许长音持续段，warn允许词中切点并记录警告，不缩短歌词。省略plan则每段一镜、标注确定性兜底。成功后planned/needs-generation；project_shot_source返回模板。', inputSchema: schema({ plan: { type: 'array', items: { type: 'object', properties:{lineText:{type:'string'},sectionIndex:{type:'integer',minimum:0},t:{type:'number',minimum:0},title:{type:'string'},prompt:{type:'string'},id:{type:'string'},cutPolicy:{enum:['strict','sustain','warn']}} } }, reasoning: { type: 'string' } }, ['projectId', 'expectedInputRevision']) },
  { name: 'project_get', description: '读取工程、镜头版本与状态、BGM 分析来源；可选返回歌词/节拍分析。', inputSchema: schema({ includeAnalysis: { type: 'boolean' } }, ['projectId']) },
  { name: 'project_shot_lyrics', description: '读取目标镜头窗口内真实词级歌词与已有元素方案。先从歌词分析含义和具象/动作/隐喻元素，再用 project_shot_update 的 lyricPlan 保存引用、解释、视觉处理；引用会被校验。', inputSchema: schema({}, ['projectId', 'shotId']) },
  { name: 'project_shot_source', description: '读取某镜头当前真实 TypeScript 源码及完整原引擎契约（Scene 类、Three.js/GLSL/字体/后期）。修改时保留输入版本并通过 project_shot_submit 提交完整文件。', inputSchema: schema({}, ['projectId', 'shotId']) },
  { name: 'project_shot_update', description: '以版本检查修改单个镜头的标题、提示词、参数或歌词元素方案；只影响这一镜（导出时只有它重渲）。提示词修改后必须重新提交代码。锁定只能由人在界面解除，AI 不能改锁。', inputSchema: schema({ patch: { type: 'object', properties: { title: { type: 'string' }, prompt: { type: 'string' }, params: { type: 'object' }, lyricPlan: { type: 'object', properties: { summary: { type: 'string' }, elements: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, quote: { type: 'string' }, meaning: { type: 'string' }, treatment: { type: 'string' }, kind: { type: 'string', enum: ['entity', 'action', 'metaphor'] }, cueWord: { type: 'string' } }, required: ['name', 'quote', 'meaning', 'treatment'] } } }, required: ['summary', 'elements'] } }, additionalProperties: false } }, ['projectId', 'shotId', 'expectedInputRevision', 'patch']) },
  { name: 'project_shot_submit', description: '把完整场景 TypeScript 源码（不带 markdown 代码围栏）提交给**这一个**镜头；保存不可变新文件并标记待验证，不会覆盖其他镜头或原参考仓库。导出缓存按镜头计（源码哈希+参数+后期栈+镜头素材）：只提交给要改的镜头，其余镜头保持原模块就会命中缓存。多镜都需要同一变更时，用project_scene_module_submit一次发布完整绑定；局部修改保持其他镜头旧版本。AI 不能接受意见：采用/拒绝由人在界面完成。', inputSchema: schema({ code: { type: 'string' }, summary: { type: 'string' }, addressedFeedbackIds: { type: 'array', items: { type: 'string' }, description: '本次源码明确响应的 pending 反馈 ID（兼容参数）；优先用 feedbackResponses 逐条说明。仅标为已响应，必须由用户在界面确认采用。' } }, ['projectId', 'shotId', 'expectedInputRevision', 'code']) },
  { name: 'project_feedback_add', description: '把人的针对性修改意见添加为目标镜头的独立反馈节点，可带 anchor（时间/歌词元素/画面区域/方面）与 preserve（必须保留项）。保留原始 prompt 和修改前版本；只有本镜头待改写。', inputSchema: schema({ text: { type: 'string' }, anchor: anchorSchema, preserve: preserveSchema }, ['projectId', 'shotId', 'expectedInputRevision', 'text']) },
  { name: 'project_shot_effects', description: '设置镜头的特效箱后期栈（按顺序叠加，最多 4 层，空数组清除）：effects: [{ id, params?, bindings? }]。id 来自 effect_search（kind=post），params 覆盖默认值，bindings 覆盖节拍绑定（{ 参数: { to: beat|kick|bar|energy, amount } }）。代码与参数冻结进工程，镜头转为待验证；先 effect_preview 看效果。导演工程需带 attemptToken。', inputSchema: schema({ effects: { type: 'array', maxItems: 4, items: { type: 'object', properties: { id: { type: 'string' }, params: { type: 'object' }, bindings: { type: 'object' } }, required: ['id'] } } }, ['projectId', 'shotId', 'expectedInputRevision', 'effects']) },
  { name: 'project_transition_get', description: '读取相邻镜头之间的转场节点、指导意见、效果配置、前后镜头元素方案和准确时间窗。', inputSchema: schema({}, ['projectId', 'transitionId']) },
  { name: 'project_transition_update', description: '编辑转场指导意图。新的指导标为待配置，不假装效果已改变。锁定只能由人在界面解除，AI 不能改锁。导演工程需带 attemptToken。', inputSchema: schema({ patch: { type: 'object', properties: { intent: { type: 'string' } }, additionalProperties: false } }, ['projectId', 'transitionId', 'expectedInputRevision', 'patch']) },
  { name: 'project_transition_configure', description: '提交转场效果参数：cut/dissolve/wipe/dip/effect、秒数、easing(linear/smooth)、direction(left/right)。mode=effect 时给 effectId（特效箱里的转场，如 gl-directionalwarp，先 effect_search kind=transition 挑选、effect_preview 看效果）与可选 params；代码与参数冻结进工程。过渡在切点后发生，保持全曲时长与歌词时序；新配置需预览验证。AI 不能接受意见：采用/拒绝由人在界面完成。', inputSchema: schema({ config: { type: 'object', properties: { mode: { type: 'string', enum: ['cut', 'dissolve', 'wipe', 'dip', 'effect'] }, duration: { type: 'number', minimum: 0, maximum: 1.5 }, easing: { type: 'string', enum: ['linear', 'smooth'] }, direction: { type: 'string', enum: ['left', 'right'] }, effectId: { type: 'string' }, params: { type: 'object' } }, additionalProperties: false }, addressedFeedbackIds: { type: 'array', items: { type: 'string' } } }, ['projectId', 'transitionId', 'expectedInputRevision', 'config']) },
  { name: 'project_transition_feedback_add', description: '添加只针对该转场的人工修改意见（可带 anchor/preserve），保留之前配置和前后镜头版本；需要明确响应并由人在界面采用。', inputSchema: schema({ text: { type: 'string' }, anchor: anchorSchema, preserve: preserveSchema }, ['projectId', 'transitionId', 'expectedInputRevision', 'text']) },
  { name: 'project_transition_validate', description: '后台抽检转场前、切点、混合中和结束后的五帧；结果绑定转场及两侧镜头版本，不代替审美确认。', inputSchema: schema({}, ['projectId', 'transitionId']) },
  { name: 'project_preview', description: '打开指定工程冻结版本的本机真实引擎预览，返回 URL。可指定 shotId 与 before-feedback 查看修改前版本；供人和 agent 视觉检查，不代表自动认可。', inputSchema: schema({ version: { type: 'string', enum: ['current', 'before-feedback'] } }, ['projectId']) },
  { name: 'project_validate', description: '后台验证指定真实镜头：加载引擎、编译并抽检 5 个时间点，保存静帧与诊断；返回 jobId，通过 project_job_get 查询，不代表逐帧/审美通过。', inputSchema: schema({}, ['projectId', 'shotId']) },
  { name: 'project_render', description: '后台导出完整 PV MP4：冻结版本，按镜头逐帧渲染、复用内容缓存、封装完整 BGM。返回任务，不阻塞 MCP 会话。完成后 result.cacheSummary 给出复用/重渲镜头数与原因，reports[].missReason 说明每个重渲镜头为什么没命中缓存；如实告诉用户。', inputSchema: schema({ fps: { type: 'integer', enum: [24, 30, 60] }, samples: { type: 'integer', enum: [1, 4, 12] } }, ['projectId']) },
  { name: 'project_job_get', description: '查询任务进度/完整结果；省略jobId时分页读取摘要，limit默认40、最多100，返回nextCursor。列表不读冻结工程或完整报告，图片/报告需指定jobId。先用project_version_get检测jobsVersion变化；指定jobId可用waitSeconds≤50等待。', inputSchema: schema({ jobId: { type: 'string' },limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string'}, waitSeconds: { type: 'integer', minimum: 0, maximum: 50 }, embedImages: { type: 'boolean', description: '默认 true：完成的图片以 MCP image 返回（总量约 4MB 封顶）；false 只返回文件路径' } }, ['projectId']) },
  { name: 'project_job_cancel', description: '取消指定排队或正在执行的后台渲染任务。已经完成的产物保留。', inputSchema: schema({ jobId: { type: 'string' } }, ['projectId', 'jobId']) },
]);

export async function callProjectTool(name: string, args: Record<string, unknown>) {
  const id = typeof args.projectId === 'string' ? encodeURIComponent(args.projectId) : '';
  const shotId = typeof args.shotId === 'string' ? encodeURIComponent(args.shotId) : '';
  const transitionId = typeof args.transitionId === 'string' ? encodeURIComponent(args.transitionId) : '';
  let path = `/projects/${id}`;
  let body: unknown;
  if (name === 'project_list') path = '/projects';
  else if (name === 'project_create_from_bgm' || name === 'project_create_from_audio') { path = '/projects'; body = { audioPath: args.audioPath, name: args.name, lyricsText: args.lyricsText, lrcPath: args.lrcPath, language: args.language, stages: args.stages,truth:args.truth, allowDuplicate: args.allowDuplicate === true ? true : undefined }; }
  else if (name === 'song_analysis_get') {
    const query = new URLSearchParams();
    if (args.startTime !== undefined) query.set('startTime', String(args.startTime));
    if (args.endTime !== undefined) query.set('endTime', String(args.endTime));
    if (Array.isArray(args.layers) && args.layers.length) query.set('layers', args.layers.join(','));
    path += `/song/analysis${query.size ? '?' + query : ''}`;
  }
  else if (name === 'song_analysis_confirm') { path += '/song/analysis/confirm'; body = { author: 'mcp', expectedRevision: args.expectedInputRevision }; }
  else if (name === 'song_analysis_retry') { path += '/song/analysis/retry'; body = { expectedRevision: args.expectedInputRevision }; }
  else if (name === 'song_analysis_patch') { path += '/song/analysis/patch'; body = { expectedInputRevision: args.expectedInputRevision, patch: args.patch, author: 'mcp' }; }
  else if (name === 'song_lyrics_submit') { path += '/song/lyrics'; body = { expectedInputRevision: args.expectedInputRevision, lyrics: args.lyrics, author: 'mcp' }; }
  else if (name === 'project_plan_submit') { path += '/plan'; body = { expectedInputRevision: args.expectedInputRevision, plan: args.plan, reasoning: args.reasoning, author: 'mcp' }; }
  else if (name === 'project_shot_lyrics') path += `/shots/${shotId}/lyrics`;
  else if (name === 'project_shot_source') path += `/shots/${shotId}/source`;
  else if (name === 'project_shot_update') { if (hasLockedKey(args.patch)) throw new Error('AI 不能修改锁定状态：锁定/解锁由人在审阅室完成'); path += `/shots/${shotId}`; body = { expectedInputRevision: args.expectedInputRevision, patch: args.patch, attemptToken: args.attemptToken, author: 'mcp' }; }
  else if (name === 'project_shot_submit') { path += `/shots/${shotId}/source`; body = { expectedInputRevision: args.expectedInputRevision, code: args.code, summary: args.summary, addressedFeedbackIds: args.addressedFeedbackIds, feedbackResponses: args.feedbackResponses, attemptToken: args.attemptToken, author: 'mcp' }; }
  else if (name === 'project_feedback_add') { path += `/shots/${shotId}/feedback`; body = { expectedInputRevision: args.expectedInputRevision, text: args.text, anchor: args.anchor, preserve: args.preserve, author: 'mcp' }; }
  else if (name === 'project_shot_effects') { path += `/shots/${shotId}`; body = { expectedInputRevision: args.expectedInputRevision, patch: { effects: args.effects }, attemptToken: args.attemptToken, author: 'mcp' }; }
  else if (name === 'project_transition_get') path += `/transitions/${transitionId}`;
  else if (name === 'project_transition_update') { if (hasLockedKey(args.patch)) throw new Error('AI 不能修改锁定状态：锁定/解锁由人在审阅室完成'); path += `/transitions/${transitionId}`; body = { expectedInputRevision: args.expectedInputRevision, patch: args.patch, attemptToken: args.attemptToken, author: 'mcp' }; }
  else if (name === 'project_transition_configure') { path += `/transitions/${transitionId}/config`; body = { expectedInputRevision: args.expectedInputRevision, config: args.config, addressedFeedbackIds: args.addressedFeedbackIds, feedbackResponses: args.feedbackResponses, attemptToken: args.attemptToken, author: 'mcp' }; }
  else if (name === 'project_transition_feedback_add') { path += `/transitions/${transitionId}/feedback`; body = { expectedInputRevision: args.expectedInputRevision, text: args.text, anchor: args.anchor, preserve: args.preserve, author: 'mcp' }; }
  else if (name === 'project_transition_validate') { path += `/transitions/${transitionId}/validate`; body = {}; }
  else if (name === 'project_preview') { path += '/preview'; body = { shotId: args.shotId, transitionId: args.transitionId, version: args.version }; }
  else if (name === 'project_validate') { path += '/validate'; body = { shotId: args.shotId }; }
  else if (name === 'project_render') { path += '/render'; body = { fps: args.fps, samples: args.samples }; }
  else if (name === 'project_job_get') {
    if(args.jobId) path+=`/jobs/${encodeURIComponent(String(args.jobId))}${Number(args.waitSeconds)>0?`?wait=${Math.min(50,Number(args.waitSeconds))}`:''}`;
    else {const query=new URLSearchParams({limit:String(args.limit??40)});if(args.cursor!==undefined)query.set('cursor',String(args.cursor));path+=`/jobs?${query}`;}
  }
  else if (name === 'project_job_cancel') { path += `/jobs/${encodeURIComponent(String(args.jobId))}/cancel`; body = {}; }
  let result: Record<string, unknown>;
  try { result = await serviceFetch(path, body); }
  catch (error) {
    if (error instanceof ServiceError && error.status === 409 && Array.isArray(error.details.existingProjects)) {
      throw new ServiceError(`${error.message}。这段音频已经有工程，改用已有工程（用其 id 继续 project_get）；只有用户明确要求再建一个新工程时才带 allowDuplicate=true 重试。`, error.status, error.details);
    }
    throw error;
  }
  if (result.song && !args.includeAnalysis) {
    const song = result.song as Record<string, unknown>;
    result.song = { song: song.song, bpm: song.bpm, duration: song.duration, sections: song.sections, note: 'includeAnalysis=true 可读取完整分析' };
  }
  return result;
}

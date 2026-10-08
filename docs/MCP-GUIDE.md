# VideoGraph MCP 使用指南

> 写给通过 MCP 操作 VideoGraph 工程的 agent，以及维护 MCP 的开发者。
> **维护规则：** 新增、删除、改名或改变任何 MCP 工具的参数/语义时，必须在同一提交中更新本文件（工具表 + 相关流程），并更新下方 `toolset` 版本行。`scripts/tests/docs/mcp-guide-sync.test.mjs`（SKILL-01 交付）会检查工具名与本文件一致。
> 本文是已实现工具的契约来源。运行与配置见 [运行手册](OPERATIONS.md)，其他资料见 [文档中心](README.md)；计划与进度只维护 [ROADMAP](../ROADMAP.md)。

toolset: 2026-10-08 · server `videograph` 0.2.0（65 个工具；内容引用与分页任务、后台操作、版本轮询、共享场景、草稿/快速检查、外部真值与持续段切点；歌声表达与实测报告；人工采用保护）· 状态：§3 为已实现工具；0.2.0 冻结验收仍以 ROADMAP 为准。

默认制作纪律：开工先读shotcraft并检索特效/转场与基础件，有参考作品先看抽帧与运动，再读实现；每轮先读意见收件箱、仅提交改过的目标、草稿先行，随后做连续帧自查，导出前列出未验证项。[PV制作流程](../skills/shotcraft/references/pv-production.md)已提供可执行参数与配方，可通过`craft_guide({topic:"pv-production"})`或同名shotcraft reference resource读取。局部2秒约12帧用start/end与sampleFps=6，不同时传shotId/transitionId；采样不等于完整播放或聆听。OpenUtau保留现有入口，实验方向冻结、仅修已确认bug。

> **定位（2026-10-02）：VideoGraph 是 LLM 的 After Effects。** 你（agent）是操作者：建工程、规划、写镜头、调节奏、渲染与自查；人在前端看片、提意见、对比、采用/拒绝。改完不要只看“没有报错”——用 §3「节奏与画面感知」的工具看运动、量节奏、看全片。

> CLEANUP-01（2026-10-01）：旧演示视图（单镜头工坊 / P(DOOM) 教学）的 `shot_queue_*`、`shot_cards_*`、`pdoom_*`、`lyric_research_draft` 工具已随代码一并移除；本指南只覆盖真实工作台的 `project_*` 工具。

## 1. 启动与连接

```sh
npm run service      # 工程服务 127.0.0.1:5191，写 .cache/service-token
npm run mcp          # MCP stdio server（由 MCP 客户端拉起，一般不手动运行；旧名 mcp:pdoom 仍可用）
```

MCP server 只是工程服务的本机客户端：所有 `project_*` 工具经 HTTP + 服务令牌调用 5191，不直接写数据库或工程文件。工具返回“连不上工程服务”或“读不到服务令牌”时，先启动 service。服务返回的错误以 `HTTP <状态码>：…` 开头，并在结果里带 `status` 与服务端附加字段（如 `existingProjects`）；409 表示版本或状态冲突，重读后再判断。

服务器连接时下发 `instructions`（先找已有工程、只改目标镜头、人工闸门三条），内容与本文 §2 硬规则一致。

客户端配置示例（stdio；`<repo>` 换成本仓库的绝对路径。该配置尚未在每种客户端中逐一验证）：

```json
{
  "mcpServers": {
    "videograph": {
      "command": "node",
      "args": ["--experimental-strip-types", "--no-warnings", "<repo>/src/pdoom/mcp-server.ts"],
      "env": {
        "VIDEOGRAPH_SERVICE_URL": "http://127.0.0.1:5191"
      }
    }
  }
}
```

- 并行实例使用独立端口与令牌：同时设置 `VIDEOGRAPH_SERVICE_URL` 和 `VIDEOGRAPH_SERVICE_TOKEN_FILE`，与该实例的 service 一致（见 `.env.example`）。
- 工具列表在客户端会话启动时加载；MCP 代码更新后需重连 MCP 才能看到新工具。
- 渲染类工具可带 `waitSeconds`（≤50）在一次调用内等待结果；上限 50 秒是为了不触发 MCP 客户端常见的 60 秒请求超时，入队耗时会从等待预算中扣除（整次调用 ≤55 秒）。
- 返回图片的工具（stills / filmstrip / contact-sheet / rhythm 及其 `project_job_get`）单次嵌入的 base64 总量约 4MB 封顶，超出的只给 `artifacts/<key>.png` 路径；`embedImages: false` 只返回路径。

## 2. 核心概念

| 概念 | 含义 |
|---|---|
| 镜头 shot | 稳定 `id`、`title`、时间窗 `start/end`（全曲秒）、`prompt`（原始意图）、`params`、`lyricPlan`、`module`（场景源码文件）、`codeHash`、`source`（imported / mcp-authored / human-authored） |
| 转场 transition | 相邻两镜头之间的独立节点：`intent`、`mode`(cut/dissolve/wipe/dip/effect)、`duration`、`easing`、`direction`；`mode: effect` 时另有冻结的特效箱动效 `effect` |
| 工程 `revision` | `project_get`、`project_director_get/next` 返回的工程版本；导演方案与自评写入传 `expectedProjectRevision`。分析 patch、歌词与规划写入则把工程版本传为 `expectedInputRevision` |
| 目标 `inputRevision / inputToken` | 镜头/转场各自的输入版本和唯一 token；目标写入传 `expectedInputRevision`，版本不匹配返回 409。不要把目标版本与工程版本混用 |
| 导演 operation / receipt | action 的 `id` 用作 `actionId`；claim 返回 `operation.attemptToken`。镜头 update 只记录 `cursorToken`，不产生源码 receipt；随后同 token 的 submit 才保存当前目标 `inputToken / codeHash / inputRevision` receipt，complete 不接受无凭据的制作完成声明 |
| `resumable` | get/next 返回当前 active operation 的 `actionId/kind/targetId/owner/attemptToken/leaseExpiresAt/expired/receipt/jobIds`。提交源码后 next 可能只列验证 action，但仍用 resumable 的原 generate operation 完成制作 action；不要丢弃或伪造原 token |
| 版本签名 | 导演 `analysisSignature` 绑定音频与分析；action `scope` 绑定其目标及依赖；自评 `signature` 绑定全片生产输入。`review.current` 由服务比较当前签名，不能自行构造或沿用过期通过结论 |
| 镜头状态 | `imported` 参考导入待验证 → `needs-generation` 待 AI 改写 → `needs-validation` 待验证 → `ready` 已通过 5 帧抽检 |
| 修改意见 feedback | 挂在镜头/转场上的独立记录：`pending` 待 AI 响应 →（可选 `needs-clarification` AI 提问·待人回复 → `pending`）→ `responded` 已响应·待人确认 → `accepted` 人已采用。可带 `anchor`（`t / range / lyricElementId / region / aspect`）、`preserve`（必须保留项）、`thread`（澄清对话）、`response`（`outcome: addressed|partial`、`how`） |
| `reviewBaseline` | 首条未接受意见加入时冻结的“修改前版本”，用于对比与拒绝回滚 |

硬规则：

1. **AI 不能接受意见。** `accepted` 只能由人在界面完成，MCP 没有也不会有接受工具。技术验证通过 ≠ 人满意。
2. 只改目标：`project_shot_submit` 只作用于一个镜头并生成不可变的新源码文件；不要借响应一条意见顺手重写其他镜头。
3. 保留原始意图：不要用 `project_shot_update` 把人的意见写进 `prompt` 覆盖原文；意见本身已单独保存。
4. 锁定的镜头/转场只能由人在界面解锁：MCP 的 update patch 不接受 `locked`，服务端也拒绝 AI 解锁。
5. 时间一律从分析数据推导（词起点、拍点），不在场景代码里硬编码秒数。
6. 有未接受意见或 `needs-generation` 的镜头/转场时，`project_render` 会被拒绝，这是预期行为。
7. **先找已有工程。** 用户说“把 X 改一下”“重新导出”时，先 `project_list` 辨认目标工程并沿用其 id；只有用户明确要新片才建工程。同一音频已有工程时 `project_create_from_audio` 返回 409 与 `existingProjects`，用户确实要新工程才带 `allowDuplicate: true`。
8. **局部修改只重渲局部。** 导出分段缓存按镜头计：该镜源码哈希、`params`、后期栈、时间窗、镜头专属素材（`engine/app/public/**/<shotId>/`），有入场转场时再加上一镜与转场配置；引擎文件、宿主渲染代码、浏览器版本、fps/samples 变化会让全片失效。改一镜只对该镜 submit/update；多镜共用一份场景源码时，局部修改只提交目标镜头；所有使用者都需要同一变更时，用 project_scene_module_submit 一次发布所有绑定，不循环逐镜提交。已有导演方案时逐镜领取租约并在 bindings 中传各自 attemptToken；原 generate operation 用 receipt 分别 complete。导出后用 `result.cacheSummary` 与 `reports[].missReason` 向用户说明哪些镜头重渲及原因。

## 3. 工具参考（已实现）

| 工具 | 参数 | 用途 |
|---|---|---|
| `scene_component_search` | `query?` | 检索相机、投影、世界卡片、海/天空/水下、逐字动画、独立图层 |
| `scene_component_get` | `id` | 获取类型化基础件源码/导出/用法；新工程 import，旧工程内联，不改冻结引擎 |
| `project_vocal_import_midi` | `projectId, midiPath, trackIndex?, channel?, lyrics?, tempo?, aliasMode?, prefix?, suffix?` | 只读 MIDI→乐谱草稿，显式选择单声部；假名配词并验证本机声库 CV/VCV 别名，不自动提交 |
| `project_vocal_import_audio` | `projectId, expectedInputRevision, audioPath, offsetMs?, referencePath?, referenceOffsetMs?, plan?, mix?` | 外部干轨冻结导入，offsetMs 对齐，可带乐谱和参考干轨；渲染后人工采用，频段报告比较实际 dBFS |

0.2 制作迭代先用 `project_draft_check / preview / stills`，满意后再单镜提交或 `project_scene_module_submit`。整批更新须逐镜提供版本与导演租约；局部改写仍只提交目标镜头。联系表可传 `selections: [{shotId,t}]`（最多120项，按输入顺序），或使用原有 ratios，两者不能混用。意见入口 `project_feedback_inbox` 可加 shotId。未连接 MCP 可运行 `node scripts/project-client.mjs tools` 和 `call <toolName> args.json`。

建工程的 `truth` 至少包含 `rhythm: {bpm（可另带 tempoMap）, beats, downbeats, meter}` 和 `sections: [{start,end,name}]`，可含词级 `lyrics`、`envelopes/onsets` 或完整v2字段。实际音频哈希/时长/采样率由服务核验绑定；未提供的信号层为中性占位，不能称作实测。跳过模型不跳过分析确认。规划项可给 `cutPolicy: 'sustain'`（长词持续段）或 `'warn'`（允许词中并给警告），默认strict兼容旧规则；歌词时间不会为切点而缩短。

### 工程

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `project_list` | — | 本地工程列表：`id / name / status / shots / duration / revision / createdAt`（按创建时间倒序）。修改/继续已有片子先用它找回工程 |
| `service_health_get` | — | 健康、运行代码是否过期、数据库大小、任务/操作积压和迁移状态；使用缓存采样，不读任务大行 |
| `project_version_get` | `projectId` | 轻量 `revision / jobsVersion`；改变时再拉工程或最近任务，不轮询整个任务表 |
| `project_scene_module_submit` | `projectId, moduleId, expectedProjectRevision, code, bindings` | 一份源码、一个修订；bindings 含每镜 shotId/expectedInputRevision，可含 params/attemptToken/feedbackResponses。锁定、冲突或授权不符整批回滚；更新共享模块必须包含所有使用者 |
| `project_draft_check` | `projectId, shotId, expectedProjectRevision` | 可选 code/params。类型检查和初始化材料的着色器编译，不出帧、不写任务/修订；render 中才创建的材料需要正式验证，结果明确说明覆盖范围 |
| `project_draft_preview` | `projectId, shotId, expectedProjectRevision` | 可选 code/params，返回真实引擎的临时草稿播放器 URL；不写源码/任务/修订，支持连续运动观察 |
| `project_draft_stills` | `projectId, shotId, expectedProjectRevision` | 可选 code/params/times（镜头内最多12帧）；直接返回有镜头号和时间的临时 PNG 联系表，不建立任务 |
| `project_create_from_audio` | `audioPath` | **新建**工程，只在用户明确要新片时调用。可选 `truth` 跳过自动分析（见上文）；还可选 `name / lyricsText / lrcPath / language / stages`（`t0/t1/t3` 组合，必须含 `t1`）/ `allowDuplicate`。同一音频已有工程时返回 409 与 `existingProjects: [{ id, name, updatedAt }]`，改用已有工程；用户确实要同音频再建一个才传 `allowDuplicate: true`。指纹命中 pdoom-video 原 BGM → 参考导入（行为不变）；否则新歌工程 `analysis-pending`：复制通用引擎（不含绑定原曲歌词的场景），后台自动分析（有 `lyricsText/lrcPath` 才做 t3 歌词对齐），完成后转 `analysis-draft`，失败转 `analysis-failed`（`analysis.error` 说明原因，使用 `song_analysis_retry` 重试） |
| `project_create_from_bgm` | `audioPath` | `project_create_from_audio` 的别名（保留兼容），可选 `name / allowDuplicate` |
| `project_get` | `projectId` | 完整工程：镜头、转场、意见、版本、输出规格。默认只返回歌曲摘要，`includeAnalysis: true` 返回完整词级歌词/节拍/包络 |
| `project_director_get` | `projectId` | 读取导演方案、工程 `revision`、当前 `phase/actions/blockers/review/exportReady/resumable` 与规则。action 的稳定 `id` 用作 claim 的 actionId，含目标版本、scope、工具和原因 |
| `project_director_next` | `projectId` | 与 `project_director_get` 调同一服务端点、返回同一份导演状态；保留为“接下来做什么”的入口名，按 `actions` 顺序推进。analysis/retry/direction/plan action 不能 claim，先直接调用对应工具 |
| `project_director_submit` | `projectId, expectedProjectRevision, director` | 保存 brief/style/rhythm/shots/maxRepairs 并递增导演版本；规划前 shots 可为空，规划后必须补齐每镜 brief。详细结构和全量校验见 §6；记为 author=mcp（不可自选），不直接改镜头 |
| `project_director_claim` | `projectId, actionId, owner, leaseSeconds?` | claim 制作/验证/审片/导出待办；leaseSeconds 为30..900、默认300。同 owner 有效续租返回原 token；返回 `operation.attemptToken`，制作镜头/转场写入时必须携带该 token |
| `project_director_complete` | `projectId, actionId, attemptToken, outcome` | outcome 为 done/failed；可带 jobIds（≤100，默认[]）和 error。校验租约、当前目标、receipt 与真实任务。制作 done 可空 jobs，验证/采样/导出 done 需对应完成 job；failed 必须引用真实失败 job，见 §6 |
| `project_director_dispatch` | `projectId, actionIds, attemptTokens` | 1..100个唯一 actionId，token 数组按位置对应、先 claim；只入队 validate/validate-transition/stills/filmstrip/rhythm/contact-sheet/export，返回 jobs 并复用同版本任务；不创作或提交自评 |
| `project_review_submit` | `projectId, expectedProjectRevision, review` | 提交 summary/七项 assessments/evidence/issues/protect；结构见 §6。真实当前证据覆盖每镜 stills+filmstrip、非硬切转场 filmstrip、全片 contact-sheet+rhythm，且技术验证通过。服务生成 signature；blocking 阻止导出，不接受人工意见 |


### 歌曲分析与规划（SONG-05）

工程状态机：`analysis-pending →（analysis-failed）→ analysis-draft → analysis-confirmed → planned → 正常镜头流程`。参考导入工程没有 `status` 字段，直接是正常镜头流程。新歌工程在 `planned` 之前不能 validate/stills/render。

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `song_analysis_get` | `projectId` | 读取 `videograph-analysis/v2` 分析与 `provenance`、当前 `inputRevision`。默认层 `audio / rhythm / sections / lyrics`；`envelopes / onsets` 体积大，需在 `layers` 中显式请求。可选 `startTime / endTime`（秒）按时间段过滤。无歌词音频没有 `lyrics` 层（不会套用旧工程歌词）；quality含整段估算质量闸门和BPM半速/倍速候选 |
| `song_lyrics_submit` | `projectId, expectedInputRevision, lyrics` | 整层替换歌词：`{ lines: [{ text, start, end, words: [{ w, start, end }] }], language? }`（秒）。经契约校验（时间在曲长内、行按时间排列、词在行内）后刷新引擎数据；工程回到 `analysis-draft`，需再次确认。agent 修正记 `humanConfirmed: false` |
| `song_analysis_confirm` | `projectId, expectedInputRevision` | 确认分析，`analysis-draft → analysis-confirmed`。agent 可调用，记为 `confirmedBy: mcp`；调用前先 `song_analysis_get` 核对，明显误听或节拍偏差先修正；超过半数歌词行是估算/零时长时返回422，先校正时间，不可绕过 |
| `song_analysis_retry` | `projectId, expectedInputRevision` | 仅 `analysis-failed` 可重试，重新排队分析并转 `analysis-pending`；等 `project_get` 返回 draft 或失败。不用于重复启动 pending/draft/planned 工程 |
| `song_analysis_patch` | `projectId, expectedInputRevision, patch` | 仅规划前的 `analysis-draft / analysis-confirmed` 可用；以工程版本整层替换 `patch.rhythm` 和/或 `patch.sections`，不支持局部 bpm/offset 指令或其他层。记为 author=mcp（不可自选）；保留 before/after 数据与来源，刷新引擎数据/指纹，回到 `analysis-draft` 并清除确认，须重读再 confirm |
| `project_plan_submit` | `projectId, expectedInputRevision` | 仅 `analysis-confirmed` 可用。`plan: [{ lineText \| sectionIndex \| t, title?, prompt?, id? }]`：每项是一刀的**锚点**，服务端推导切点（歌词行 → 行首词前最近拍；`t` 量化到帧；默认strict不得切词，可明确cutPolicy=sustain/warn放宽），首刀强制 0、末镜到曲尾；可带 `reasoning`。省略 `plan` → 确定性兜底（每段一镜，`source: fallback-deterministic`，不算 AI 创作）。成功后工程 → `planned`，镜头 `module: null`、`needs-generation`，相邻镜头生成默认硬切转场 |

### 歌声制作（VOCAL 工程接入）

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `project_vocal_get` | `projectId` | 乐谱独立 inputRevision、draft、candidate、active；候选含人声/混音 WAV、USTX、LRC、pitchReportFile 实测逐帧 JSON、乐谱词级时间与缓存报告 |
| `project_vocal_check` | `projectId` | 本机声库、契约与真实 oto 别名（最多 1000 个，超出有标记）；缺配置返回 ready=false，不要求 OpenUtau GUI |
| `project_vocal_submit` | `projectId, expectedInputRevision, plan` | 固定 BPM、单轨单 part、480 tick/拍；note 的 lyric=真实 oto 别名，pitch/tone、startBeats/durationBeats 或 startTick/durationTicks，text 为显示歌词。支持 pitchCurve（x=相对毫秒，y=10音分）、vibrato、volume/velocity/attack/decay/envelope；part.pitchDeviation=[{timeMs,cents}]、dynamics=[{timeMs,db}] 为全曲绝对毫秒。可选 mix 增益与 processing={} 默认 EQ/压缩/立体声混响，详见 VOCAL。保持 active，清候选；拒绝 phonemizer/多轨/未支持表达 |
| `project_vocal_render` | `projectId, expectedInputRevision` | 冻结乐谱/配置并渲染曲线、颤音、包络/力度及混音，返回后台 vocal 任务；用 project_job_get 查询、project_job_cancel 取消。结果 report.pitchQuality 提供实测可靠覆盖、目标音分误差与起伏率/深度，pitchReportFile 含逐帧 JSON；null 不等于唱准。按实际参数复用采样，旧任务 stale=true 不可采用 |

人在审阅室「歌声制作」试听候选后采用；AI 没有采用或恢复音轨权限。原音频保留，视频预览和冻结导出共用已采用混音。仅改变音轨不影响画面分段缓存，但旧审片证据失效。词级时间来自乐谱而非实测；已有视频歌词保持原样，规划前可明确把已采用乐谱歌词送入分析并重新确认。agent 也可用现有 song_lyrics_submit 提交词级时间，并在 lyrics.timingSource 标记 score；provenance.params 同步记录该标记。

从已分离原唱提取 pitd 的本机 CLI 为 `node src/vocal/cli.mjs extract-pitch --audio separated-vocal.wav --plan plan.json --out tuned-plan.json`，再把输出 JSON 用上述 submit/render 工具交给目标声库。它不做源分离或自动时间对齐；单位、offset、混音字段和实测限制以 [歌声手册](VOCAL.md) 为准。CLI 文件访问需要操作者本机文件能力，四个 MCP 工具不接收任意本机路径。

### 镜头

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `project_shot_lyrics` | `projectId, shotId` | 镜头窗口内词级歌词、`instrumental` 标记、已有 `lyricPlan` |
| `project_shot_source` | `projectId, shotId` | `{ shot, code, contract, lyricContext, source }`：当前真实 TS 源码与完整引擎契约（ENGINE.md） |
| `project_shot_update` | `projectId, shotId, expectedInputRevision, patch`（导演制作 action 另必带 `attemptToken`） | patch 仅允许 `title / prompt / params / lyricPlan`（不含 `locked`，AI 不能改锁）。改 `prompt` 或 `lyricPlan` → `needs-generation`；改 `params` → `needs-validation`；三者都会让已响应意见退回 `pending`。只影响这一镜的导出缓存。导演 token 通过 receipt 绑定本次目标提交 |
| `project_shot_submit` | `projectId, shotId, expectedInputRevision, code`（导演制作 action 另必带 `attemptToken`） | 提交**完整**场景文件（无 markdown 围栏）给**这一个**镜头，可带 `summary`、`feedbackResponses: [{ feedbackId, outcome: addressed\|partial, how }]`（优先）或兼容参数 `addressedFeedbackIds`（视为 addressed、how 为空；同 ID 以 feedbackResponses 为准）。生成 `vg-<sha256>` 不可变模块，状态 → `needs-validation`。局部修改只提交目标；共享整体变更用project_scene_module_submit（见§2规则8）。AI 不能接受意见 |
| `project_feedback_add` | `projectId, shotId, expectedInputRevision, text` | 新增镜头意见（≤8000 字符），可带 `anchor`（`t/range/lyricElementId/region/aspect`，服务端校验窗口与元素引用）与 `preserve`（≤12 条），记为 `author: mcp`（代人转述时在正文注明）；首条未接受意见时冻结 `reviewBaseline`；镜头 → `needs-generation` |

`lyricPlan` 结构：`{ summary, elements: [{ name, quote, meaning, treatment, kind?: entity|action|metaphor, cueWord? }] }`。`quote` 必须是本镜头窗口内的真实歌词，`cueWord` 必须在该句中，否则拒绝。有歌词的镜头至少一个元素。

### 转场

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `project_transition_get` | `projectId, transitionId` | 转场节点、意见、配置、前后镜头元素方案、准确时间窗 |
| `project_transition_update` | `projectId, transitionId, expectedInputRevision, patch`（导演工程另必带 `attemptToken`） | patch 仅 `intent`（不含 `locked`，AI 不能改锁）；新 intent → `needs-generation`，需随后 configure。记为 author=mcp |
| `project_transition_configure` | `projectId, transitionId, expectedInputRevision, config`（导演制作 action 另必带 `attemptToken`） | `config: { mode, duration ≤1.5, easing, direction, effectId?, params? }`；`mode` 为 cut/dissolve/wipe/dip/effect，`mode: effect` 时给 `effectId`（特效箱转场）与可选 `params`。可带 `feedbackResponses`（同 `project_shot_submit`）或兼容参数 `addressedFeedbackIds`。过渡在切点后发生，不改全曲时长与歌词时序。AI 不能接受意见 |
| `project_transition_feedback_add` | `projectId, transitionId, expectedInputRevision, text` | 新增转场意见（可带 `anchor/preserve`，锚点窗口为前后镜头合并窗口），同时冻结两侧镜头版本 |
| `project_transition_validate` | `projectId, transitionId` | 后台抽检切点前后 5 帧，返回 job |

### 意见与画面（FB-03）

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `project_feedback_inbox` | — | 可选 `projectId`、`status`（默认 `pending`；`open` 为全部未接受）。agent 的入口：返回每条意见的目标、时间窗、锚点、保留项、上下文摘要与 `nextStep`；不传 projectId 时汇总所有本地工程。AI 不能接受意见 |
| `project_feedback_ask` | `projectId, targetKind, targetId, feedbackId, question` | 意图含糊时向人提问：意见转 `needs-clarification`，人回复后回 `pending`；提问不改输入版本。AI 不能替人回复 |
| `project_stills` | `projectId`（另需 `shotId` 或 `transitionId`） | 可选 `times`（≤6 个、须在目标时间窗内；默认 = 未接受意见锚点 t + 窗口 0/0.5/1）、`version: current\|before-feedback`、`width`（320..1920，默认 960；给自己看建议 ≤1024）、`embedImages`。后台真实引擎渲染静帧，返回 job；完成后 `project_job_get` 以 MCP image 内容（base64 PNG）返回并附 `artifacts/<key>.png` 路径。缓存键 = 版本输入 + t + 宽度。AI 不能接受意见 |

### 预览、验证、导出、任务

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `project_preview` | `projectId` | 可选 `shotId / transitionId / version: current\|before-feedback`。返回本机真实引擎播放器 `url` 与 `range`。供有浏览器能力的人/agent 查看 |
| `project_validate` | `projectId, shotId` | 后台编译 + 5 时间点抽检，返回 job；完成后镜头 `validation.thumb` 指向 `artifacts/<key>.png`（**单张**缩略图） |
| `project_render` | `projectId` | 可选 `fps: 24/30/60`、`samples: 1/4/12`。后台导出完整 MP4，冻结当前版本，按镜头命中分段缓存。完成后 `result.cacheSummary: { reused, rendered, reasons }`（reasons 为未命中原因计数），每个 `reports[]` 带 `cached` 与 `missReason`（数组，取值如 `new / code / shot / assets / dependency / engine / host / browser / fps / samples / encoder`）；如实告诉用户哪些镜头重渲了、为什么 |
| `project_job_get` | `projectId` | 可选 `jobId`；省略则列出最近任务（此时 `waitSeconds` 被忽略）。看 `status / progress / error / result`。带 `jobId` + `waitSeconds`（≤50）则阻塞到任务结束或超时，不用反复轮询；`embedImages: false` 只返回图片路径 |
| `project_job_cancel` | `projectId, jobId` | 取消排队或运行中的任务 |

### 节奏与画面感知（LLM-AE，AE-01～05）

规划镜头前读节奏表；改完镜头后用 filmstrip 看动作、rhythm_report 量节奏、contact_sheet 看全片。filmstrip / contact_sheet / rhythm_report 都是只读后台任务（新歌工程需 `planned`），默认在本次调用内等待 25 秒（`waitSeconds` ≤50），超时返回 job，再用 `project_job_get` 的 `waitSeconds` 等待；完成后以 MCP image 内容返回图片，长文本作为单独一段文本返回。

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `song_cue_sheet` | `projectId` | 按小节的文本节奏表：时间、段落（▶段首）、能量 1–5（小节 rms 在全曲 p5–p95 中的位置）、每拍 2 格鼓点型（`K` kick / `S` snare / `X` 同时 / `.`）、歌词、`↑↑` 爆发 / `↓↓` 回落 / `⇗` 蓄力、现有切点 `✂n(转场)@t`。可选 `start / end`。无下拍按 4 拍推算、无拍点按 2 秒分块（都会在表头注明） |
| `project_filmstrip` | `projectId` | 一段连续帧拼成一张网格图（≤24 格），每格标 `时间 小节.拍 ●下拍 K S “词”`，下拍帧橙框。范围：`shotId` / `transitionId`（切点前后各 1 秒）/ `start,end` / 全片；取帧：默认均匀 6–24 帧、`around: t` + `frames`（前后各 1–11 帧，看冲击起势与衰减）、`sampleFps`。可选 `thumbWidth`（160–480）、`columns`、`waitSeconds`、`embedImages` |
| `project_contact_sheet` | `projectId` | 可指定selections=[{shotId,t}]跨镜头时间点（≤120，保序），或全片每镜头1–3帧（ratios默认[0.45]）拼图，标序号/标题/时间/段落/状态；无源码镜头画占位。看全片一致性、色彩推进、镜头雷同、强弱起伏 |
| `project_rhythm_report` | `projectId` | 顺序渲染目标时间段（范围参数同 filmstrip；`sampleFps` 10–60，默认 ≤30 秒用工程帧率、更长用 15），返回文本报告 + 对照图：下拍/强 kick/强 snare 命中率与中位偏移（正=画面滞后）、高能量小节下拍命中率、画面峰在拍上的比例、与鼓点包络的相关与最佳偏移、死区、闪烁（线性亮度近似 WCAG，>3 次/秒告警）、切点离拍距离、逐小节“音乐能量 vs 画面运动”。报告分「问题（通常该修）」与「风格提示（确认是否有意）」。全片 15fps 约 5–6 分钟（瓶颈是 1080p 真实渲染），优先按镜头/段落跑；采样帧有缓存，同一版本重跑很快 |
| `craft_guide` | — | shotcraft 技法库节选（≤12k 字符）。`topic`：`shots / transitions / effects / media-styles / pipeline / pv-production / platform`，省略为总览；`query` 按关键词筛小节。不需要工程服务 |

**参考基准**（pdoom 参考复现片，公认的好作品；详见 ROADMAP AE-04）：画面峰约 94% 落在拍/鼓点/词起点上（中位偏移 25ms），全片下拍命中约 38%——不需要每个下拍都砸，但大变化应当在拍上；“问题”栏只报出闪烁（终段副歌字块整屏黑白橙交替，7 次/秒），死区与连续不跟拍都归为“风格提示”。画面运动等级 1–5（rhythm-v7 起）用**相对运动** = 小节运动 ÷ 画面墨量（可见内容偏离背景的量），即“可见内容里有多大比例在变”，细线/小主体构图不会因画面稀疏被判静止；运动按 1/15 秒间隔取差，不同采样帧率等级可比。刻度为参考片全片小节相对运动五分位（0.24/0.40/0.51/0.73），3 级 = 参考片中位，参考片自身约 40% 小节低于 3 级——不要要求每个响段小节都 ≥3。报告的逐小节表仍给出绝对运动（`motion`）、墨量（`ink`）与相对值（`rel`）。

**MCP resources（只读 Markdown）**：
- `videograph://docs/mcp-guide`（本文件）
- `videograph://skills/shotcraft/SKILL.md` 与 `videograph://skills/shotcraft/references/<name>.md`
- `videograph://skills/shotcraft/SOURCES.md`（来源与许可）
- `videograph://skills/videograph-create/SKILL.md`（仓库 `.agents/skills/videograph-create/SKILL.md`）
- `videograph://skills/videograph-create/aesthetic-review.md`（仓库该 skill 的 `references/aesthetic-review.md`；URI 不含 references）
- `videograph://skills/videograph-aigc-film/SKILL.md` 与 `videograph://skills/videograph-aigc-film/references/<name>.md`（仓库 `.agents/skills/videograph-aigc-film/`：外部生图/图生视频/TTS 素材 + VideoGraph 合成的 AIGC 电影化短片流程；脚本模板在该 skill 的 `scripts/`，不经 MCP 提供）

**MCP prompts**：`direct_video({ projectId })`（必填工程 ID，读当前 creation skill，引导 next→claim→制作→真实证据→返工/交付；同一 agent 完成，不调用第二套模型）、`respond_to_feedback({ projectId? })`（§4 流程 + 自查要求）、`design_rhythm({ projectId, section? })`（节奏设计与自查流程）。读取 prompt 不是工程写入，也不替代 `project_director_next` 的当前事实与闸门。

产物文件位于 `projects/<projectId>/<file>`（如 `artifacts/<key>.png`、`exports/<jobId>/pv.mp4`），同机 agent 可直接读取 PNG 做视觉检查。

### 特效箱（FX-01/02：LLM 的“效果和预设”）

特效箱 = 本仓库 `effects/box/*.glsl`（原创动效，一个文件一个，编写规范见 `docs/FX-AUTHORING.md` 与样板 `effects/box/riso-two-ink.glsl`）+ 上游 gl-transitions（按需下载、不分发）。动效在预览、校验、导出中是同一份着色器；套用时代码与参数**冻结进工程**，特效箱以后更新不会改变已渲染的镜头（要升级就重新套用）。

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `effect_search` | — | 按风格/用途关键词（risograph、水彩、卡点、glitch、胶片…）、`kind`（`post` 镜头后期 \| `transition` 转场）、`category` 检索，返回卡片：一句话、何时用/别用、参数与默认节拍绑定。查转场时本机没有 gl-transitions 会先按需下载 |
| `effect_get` | `id` | 完整定义：参数规格、节拍绑定、来源与许可、着色器代码、可直接复制的套用调用示例 |
| `effect_preview` | `id` | 在演示素材（`source`: type 文字海报 / scene 风景 / shapes 几何 / portrait 人像剪影）上渲染 4–12 帧帧序列图并返回图片；可带 `params` 比较不同参数。比较 2–3 个候选后再套用 |
| `project_shot_effects` | `projectId, shotId, expectedInputRevision, effects` | 设置镜头后期栈：`[{ id, params?, bindings? }]`，按顺序叠加、最多 4 层、空数组清除；只接受 kind=post。`bindings` 覆盖节拍绑定：`{ 参数: { to: beat\|kick\|bar\|energy, amount } }`（`null` 取消）。镜头转为待验证，导演工程需带 `attemptToken`。套用后用 `project_stills` / `project_filmstrip` 看真实画面、`project_rhythm_report` 看节奏 |

转场动效：`project_transition_configure` 的 `config` 用 `mode: "effect"` + `effectId`（如 `gl-directionalwarp`）+ 可选 `params` 与 `duration`。

无鼓点段落要在某一帧做冲击（弹窗、按钮、落版）时用 `timed-impact`（参数 `atTime` = 歌曲秒，`centerX/centerY` 冲击点，Y 从画面底部算），它不依赖节拍事件。

**选用原则**：一部片的后期风格要统一（同一段落用同一种媒介），节拍冲击类（拍点推镜/震动/RGB 分离）只放在副歌与重音段；不要每个镜头叠满 4 层；转场大多数仍应是节拍硬切，动效转场留给段落交界。

### 案例库与上游来源（FX-00）

这些内容**不随本仓库分发**：`effects/sources.json` 只登记上游仓库、固定 commit、许可与署名；第一次调用时在本机从 GitHub 按固定 commit 下载到 `.cache/fx`，用 git blob 哈希校验，逐文件判定许可（不在白名单的不落盘），之后走缓存。不需要工程服务；首次需要能访问 github.com（API 匿名限额 60 次/小时，可设 `GITHUB_TOKEN`）。

| 工具 | 必填参数 | 作用 / 返回 |
|---|---|---|
| `fx_sources` | — | 登记的来源：仓库、commit、许可状态、署名、第三方素材说明、本机缓存数 |
| `casebook_list` | — | Code Video Casebook 的 31 个真实代码视频案例（id、标题）。做新片前先挑 1–3 个最接近的 |
| `casebook_case` | `caseId` | 案例检索卡（一句话、规格、何时抄、架构、最值得抄的做法、坑、CoExp 行号导读）+ 源码清单 + 20 帧联系表图片 |
| `casebook_search` | `query` | 正则检索，返回 `path:行号:内容`；`scope`：`cards`（默认）/ `coexp` / `source`（必须给 `cases`，按需下载源码）/ `all` |
| `fx_library_search` | `query` | Opus 视频提示词库检索（正则），返回 `来源id:路径:行号: 片段`；来源见 `fx_sources`（kind=prompts）：lemo-opuscar 43 种风格提示词（MIT）、创作者原文提示词与案例合集（MIT / CC BY 4.0，引用的他人提示词权利归原作者）。不给 `sources` 只搜已下载的库；给 `sources:[id]` 按需下载（首次 10–60 秒，超时分次续传）。4 个无许可证的仓库只登记链接、不下载 |
| `fx_library_read` | `source, path` | 读提示词库文件（路径相对该仓库根，如 `styles/watercolor/STYLE.md`），`lines: "起:止"`，单次 ≤12k 字符 |
| `casebook_read` | `path` | 读文件（相对 casebook 根，如 `references/cases/oneink/CoExp.md`、`references/techniques.md`），`lines: "起:止"`，单次 ≤12k 字符 |

**许可与边界**：案例库作者已口头授权使用其自有内容（书面许可待落地，不进入对外发布包）；字体、音乐音效、视频、真人照片等第三方素材不在下载范围。案例里的品牌名、成员信息、二维码属于原项目——参考结构、节奏和做法，做新片时换成用户自己的内容，事实不确定就问人。案例是别的技术栈（Python/Canvas/HyperFrames 等），借思路后按本平台引擎契约重写场景，不要把它们的代码原样塞进镜头。

## 4. 标准流程：响应人的修改意见

```
收件箱找意见 → next/claim → 读上下文 → 看画面（stills）→ 改代码 → 带 attemptToken 提交并逐条声明响应 → complete 制作 → 验证 → 自查 → 交给人确认
```

已有导演方案时，先按 `project_director_next` 的目标制作 action claim；恢复先读 `resumable`。镜头 update 带 `attemptToken` 只记录 `cursorToken`，随后 submit 必须沿用同 token 才形成源码 receipt；转场 configure 直接形成 receipt。源码提交后 next 可能转为验证 action，但仍使用 `resumable` 完成原 generate/transition 制作 action；每次写入后重读 next，不保存旧 actions 做批量依赖。转场依赖前后镜头的当前版本，镜头变更后重读转场 action。没有导演方案的既有工程可继续旧反馈流程，但不能伪称已完成导演 operation；如需导演闭环，先按 §6 建立并补齐方案。

1. **找到待处理意见**：`project_feedback_inbox`（默认 pending；不传 projectId 汇总全部工程）。逐条读 `note.anchor`（定位到哪里）和 `note.preserve`（不能动什么），按 `nextStep` 行动。
2. **读上下文**：对目标镜头调用 `project_shot_lyrics` 与 `project_shot_source`。同时读：原始 `prompt`（不能丢的意图）、意见原文、`reviewBaseline`（修改前版本）、当前 `inputRevision`。
3. **看画面**：`project_stills`（默认时间点即意见锚点；改完再取 `version: before-feedback` 与当前对比同一时间点）。需要动态时用 `project_preview`。不要只凭代码猜效果。
4. **改代码**：在当前源码基础上修改，遵守引擎契约与 shotcraft 技法（见 §7）；只改意见指向的部分，`preserve` 列表（歌词时序、Logo、镜头长度等）保持不变。意图含糊先 `project_feedback_ask` 澄清。
5. **提交**：`project_shot_submit`，`expectedInputRevision` 取刚读到的值，`feedbackResponses: [{ feedbackId, outcome, how }]` 只列这次**真正处理了**的意见（partial 必须写 how），`summary` 写清改了什么。
6. **验证**：`project_validate` → 轮询 `project_job_get` 直到 `done/error`。失败时读 `error`，修正后重新提交（最多两轮，仍失败就停下来报告）。
7. **自查**：读新缩略图 / 重取 stills，确认意见被处理、保留项没坏、其他镜头的 `codeHash` 没变。涉及动作/节奏的意见（`aspect: motion|timing`）再跑 `project_filmstrip`（`around` = 锚点）与 `project_rhythm_report`（`shotId`），把结论写进 `how`。
8. **交接给人**：回复中写明处理了哪些意见、如何处理、哪些没有处理及原因。然后停止：采用或拒绝由人在界面完成（AI 不能接受意见）。

转场意见同理：`project_transition_get` → `project_transition_configure`（优先 `feedbackResponses`；`addressedFeedbackIds` 仅兼容）→ `project_transition_validate` → 切点 stills/filmstrip 与必要的节奏复查 → 交给人确认。

### 恢复与版本绑定

继续已有工程先 `project_list / project_get` 辨认目标，读取分析状态、镜头/转场状态与版本、`project_feedback_inbox({projectId,status:"open"})`、`project_job_get` 的现有任务。从实际未完成环节继续，不重复建工程或重复提交分析/渲染；不要取消或接管别人的任务。409 时重读最新输入并重新判断，不强写、不盲重试。

继续时读取 `project_director_get/next` 的 phase/actions/blockers/review/exportReady 与现有 operations。导演方案/自评使用最新工程 `revision` 作为 `expectedProjectRevision`；目标写入使用目标 `inputRevision` 作为 `expectedInputRevision`。服务生成并比对 analysisSignature、action scope 与自评 signature；记录 `review.current`、目标 inputToken/codeHash、任务 ID 和采样时间/范围，不自行计算签名替代服务。输入变更后，旧验证、图片、节奏报告和 AI 自评不能直接当作新版本通过；恢复会话也必须核对依赖。租约续领/receipt/complete 规则见 §6。

### 新歌流程：从音频到成片

```
create_from_audio → director_next / project_get → song_analysis_get + cue_sheet 核对 →（retry 或整层 patch/lyrics）→ confirm → director_submit（shots 可空）→ plan → director_submit 补齐每镜 brief → next → claim → 镜头/转场写入（attemptToken receipt）→ complete → 验证/审片 dispatch + job_get + complete → review_submit → 消除 blocking / 人工意见交接 → exportReady → claim export → dispatch/render → job_get + complete
```

1. `project_create_from_audio`；用 `project_director_get/next` 恢复事实，轮询 `project_get` 直到 `analysis-draft`（`analysis-failed` 用 `song_analysis_retry`，仅失败状态可重试）。
2. `song_analysis_get` 核对 bpm、下拍、段落、歌词并先读 `song_cue_sheet`。歌词误听用 `song_lyrics_submit` 改；节拍/段落错误在规划前用 `song_analysis_patch` 整层替换 rhythm/sections，随后重新读取、确认；不要把局部 offset 当 patch。
3. `song_analysis_confirm`（agent 确认会留痕 `confirmedBy:mcp`），重读 next；按 direction action 用最新工程 `revision` 调 `project_director_submit` 保存 brief/style/rhythm，规划前 `shots:[]`。再读 next 的 plan action，用最新工程版本 `project_plan_submit`。
4. 规划产生镜头后再次 `project_director_submit` 补齐每个 shot 的 subject/action/entrance/exit 和导演意图；未补齐时 next 会阻塞制作。
5. 对每个制作 action 先 `project_director_claim`。对目标调用 `project_shot_lyrics / project_shot_source`，写 `lyricPlan`、完整场景或转场配置时带 `attemptToken` 和最新目标 `expectedInputRevision`；服务保存 receipt。完成后用真实结果 `project_director_complete`；无 receipt 不能把制作 action 标为 done。
6. claim 确定性 validate/stills/filmstrip/rhythm/contact-sheet/export action 后可 `project_director_dispatch`，按返回 job 用 `project_job_get`，再 complete。每镜必须有 stills+filmstrip，非硬切转场有 filmstrip，全片有 contact-sheet+rhythm；用 `project_review_submit` 写七项 assessments、evidence 和 issues，消除 blocking。自评不等于人工采用，不使用第二套模型。
7. 仅当 `project_director_get/next` 显示 `exportReady:true` 且意见闸门通过，claim export 并 dispatch 或 `project_render`；等待并 complete，核对音轨、时长、接缝和结尾。被闸门拒绝时报告 blocker，不自行解锁或接受意见。

## 5. 常见错误与陷阱

| 现象 | 原因 / 处理 |
|---|---|
| 409 `镜头版本已改变` | 别人或界面刚改过；重新 `project_get` / `project_shot_source` 后基于新版本重做 |
| 二次提交后旧意见变回 `pending` | 每次 submit 都会使旧响应失效（它们针对旧代码）。新提交里要把仍然成立的意见 ID 一并放入 `feedbackResponses` |
| `反馈 ID 必须来自本镜头尚未接受的意见` | ID 拼错、属于其他镜头，或已被接受 |
| 拒绝后镜头是 `needs-generation` | 人拒绝候选会恢复修改前代码，但仍需按意见重新改写 |
| `project_render` 返回 409 | 还有未接受意见、待改写镜头或待配置转场；不要试图绕过 |
| `project_create_from_audio` 返回 409 + `existingProjects` | 这段音频已有工程。用户要改的就是它：用列出的 id 继续；只有用户明确要新工程才带 `allowDuplicate: true` |
| 只改了一镜，导出却全片重渲 | 看 `result.cacheSummary.reasons` 与 `reports[].missReason`：`code` 多半是把共用源码重新提交给了所有镜头；`engine/host/browser` 是引擎快照、渲染宿主代码或浏览器升级，属于预期的全片失效；`fps/samples` 是导出规格变了 |
| 场景运行报错或黑帧 | 先看 `project_job_get` 的 `error`；引擎每帧错误会中止，不会静默黑帧 |
| `project_stills` 对 `needs-generation` 镜头也能出图 | 预期行为：意见加入即标记待改写，但当前源码仍可渲染——agent 改写前正要看锚点处现状 |
| stills 图片内容缺失（只有路径） | MCP 进程的 `VIDEOGRAPH_PROJECTS` 与工程服务不一致，读不到产物文件；对齐 env 后重试 |
| 新歌工程 validate/render 返回 409 `还在 analysis-* 阶段` | 先完成分析确认与 `project_plan_submit` |
| `project_plan_submit` 报“切点落在一个词的中间” | 换用 `lineText` 锚点，或把 `t` 移到拍点/词间隙 |
| 新工具不可见 | MCP 会话需要重连 |

## 6. 导演契约、租约与证据闸门（已实现）

### 导演方案 `director`

```ts
{
  brief: { intent, audience, mustKeep?: string[], mustAvoid?: string[] },
  style: { medium, palette: string[], typography, composition, motion, motif },
  rhythm: {
    sections: [{ sectionIndex, energy, intent }], // energy 整数 1..5
    accents?: [{ beatIndex, intent } 或 { lineIndex, wordIndex, intent }]
  },
  shots?: [{ shotId, subject, action, entrance, exit }],
  maxRepairs?: 0 | 1 | 2
}
```

- `brief.intent` ≤4000 字符，`audience` ≤300；style 文本字段各 ≤1000，palette 非空。`mustKeep/mustAvoid/palette/protect` 为最多20条、每条≤300字符的文本数组。
- 段落目标 1..100 项，必须覆盖本工程全部段落且索引不重复，intent ≤1000。accents 默认空、≤200项，只引用真实拍或词索引，intent ≤500；服务计算 `t`，不能自造绝对时间锚。
- shots 默认空、≤60项，ID 必须存在且不重复，subject/action/entrance/exit 各≤1000。规划前可为空，规划后 next 会要求补齐全部镜头 brief，补齐前不能制作。
- `maxRepairs` 默认2，即初次尝试加最多两次修复；预算耗尽时遵从 blockers，不通过重提方案或换 owner 绕过。重提完整方案会递增 `director.version`，清空 appliedShots/appliedTransitions/operations/review，并保留最多10条方案历史；旧 token 与依赖证据不再有效。

### get / next 与恢复

返回 `{ projectId, revision, director, review, phase, actions, blockers, exportReady, resumable, rule }`。phase 包含 analysis、direction、planning、producing、validating、repairing、reviewing、awaiting-human、export-ready、exported。action 主要字段为 `id/kind/targetKind/targetId/scope/tool/args/reason`，目标动作另有 `expectedInputRevision`，已有 operation 时返回状态、owner、租约、尝试数、jobIds/error；`actions[].id` 才是 claim 的 `actionId`。`resumable` 描述当前 active operation：`actionId/kind/targetId/owner/attemptToken/leaseExpiresAt/expired/receipt/jobIds`。claim 结果中的 `operation.targetToken` 绑定目标 `inputToken`。

分析/retry/direction/plan 不可 claim，直接完成对应分析、方案或规划调用后重读 next。其余 action claim 后按动作执行；不要把 `args.directorBrief` 当作工具入参整体透传。恢复时先 next、再查 `resumable`、已有 job 与 operations，复用同一版本的任务；active prior 即使不在当前 actions 也可由同 owner 按 actionId 续租。旧 action 不在当前列表且无 resumable、租约过期、签名变化或 409 时必须重读，不强行 complete。所有写入后重读 next，不保存旧 actions 做批量依赖。

### claim → 制作 receipt → complete / dispatch

1. `claim` 的 owner 为≤120字符非空文本；租约默认300秒、30..900秒。同一 owner 对有效 claim 再 claim 会续租并返回原 token；另一 owner 会收到409。长任务在到期前续租，不抢占别人任务。
2. 制作 action 的 `project_shot_update`、`project_shot_submit`、`project_transition_configure` **必须带 `attemptToken`**（**已有导演方案的工程，AI 不带 token 的写入一律 409 拒绝**——修复预算用尽时停下等人决定，不能走旧路径绕过；没有导演方案的旧工程不受影响，人在界面的编辑不受限）。每次写入还必须带目标最新 `expectedInputRevision`；token 不能代替并发校验。服务核对操作类型、目标、directorVersion、租约及基线 token；镜头 update 只写 `cursorToken`，同 token 的后续 submit 才记录源码 receipt。每次写入后重读 next，不能依赖保存的旧 actions；转场 action 的依赖包含前后镜头当前版本。
3. `complete` 的制作 done 校验 receipt 与当前目标 token、源码/配置和意见响应；可 `jobIds:[]`，它只表示制作完成。源码 submit 后 next 可能只显示验证 action，使用 get/next 返回的 `resumable` 完成仍 active 的原 generate/transition action。validate/validate-transition done 需当前技术验证及匹配 kind 的已完成 job；审片/导出 action 需对应 done job；review done 需当前自评。`failed` 必须引用当前签名匹配的 error/interrupted/cancelled 真实任务，可附≤2000字符 error，不可虚构失败记录。相同 token 对已 done operation 再 complete 为幂等返回。
4. `dispatch` 只允许 `validate / validate-transition / stills / filmstrip / rhythm / contact-sheet / export`。actionIds 为1..100个唯一ID，attemptTokens 数组同长且逐项对应；全部先 claim。已完成但尚未 complete 的同版本 job 也可复用，返回 `{projectId,jobs:[{actionId,jobId,status,reused}]}`。它不执行分析/方案/规划、源码创作或 AI 自评，也不调用第二套模型；等待 job 完成后逐项 complete。有限修复预算按目标汇总，不因 actionId 或重复 dispatch 分散计算。

### AI 自评 `review`

```ts
{
  summary,
  assessments: { composition, hierarchy, readability, semantics, rhythm, consistency, originality },
  evidence: [{ jobId, file?, t?, observation }],
  issues: [{ severity: "blocking" | "warning" | "intentional", targetId?, t?, detail }],
  protect?: string[]
}
```

summary ≤3000字符；七项 assessments 均为非空观察文本、各≤2000；evidence 1..300项、observation ≤2000；issues 必须为数组（可空）、≤100项、detail ≤2000，targetId 若给出须为现有镜头/转场，t 在曲长内。protect 记录返工时应保留的画面/语义。

证据 job 必须是本工程当前输入签名匹配的 **done** stills/filmstrip/contact-sheet/rhythm，不接受技术验证缩略图、未完成任务或 before-feedback 图作当前证据。file 默认任务首个文件，若指定则必须属于任务、匹配 `artifacts/<64位hash>.png` 且实际存在；t 必须是任务采样时间（一帧容差）或任务覆盖范围内。每镜必须有 stills 与 filmstrip，每个非硬切转场必须有 filmstrip，全片必须有 contact-sheet 与 rhythm；局部节奏诊断是补充，next 的全片 rhythm 待办要求覆盖曲长。

提交前所有目标须当前技术验证通过；服务保存 `signature/by:mcp/submittedAt`，get/next 的 `review.current` 表示是否仍匹配当前生产输入。签名覆盖引擎、音频/分析、输出、导演版本、镜头/转场输入与依赖，不能只比较 codeHash。blocking 会阻止导出并要求返工；有目标的问题返回 repairing action，无目标问题先定位，不能直接抹掉 severity 绕过。warning 或有意设计记 intentional 并说明理由。AI 自评不接受人工反馈；未采用意见、锁定和澄清仍是独立人工闸门。

### 规划前分析修正

`song_analysis_patch` 使用完整 v2 `rhythm` 层和/或 `sections` 数组，不是 JSON merge patch：rhythm 允许 bpm、tempoMap、beatPeriod、beats、downbeats、meter、confidence，必须有完整非空递增拍点/下拍；派生引擎要求恒定 BPM，不支持局部 offset 指令。sections 为完整段落数组（start/end、name/label、confidence），按时间排序不重叠、在曲长内。应从不带时间过滤的 `song_analysis_get` 取得整层再修正，不能把截取数据当全层提交。修改保留 provenance 与 overrides 的 before/after，并刷新引擎指纹；回到 draft 后重读分析/cue sheet、重新确认并更新导演方案。规划后不能 patch 或提交歌词，也不能用 retry 覆盖已规划成果。

## 7. 与 shotcraft skill 的分工

- 本文件：**平台操作**（有哪些工具、状态机、版本规则、流程）。
- shotcraft skill：**创作技法**（分镜范式、转场、特效、媒介风格、卡拉OK/节拍纪律）。源目录在 SKILL-01 完成后为仓库内 `skills/shotcraft/`。
- skill 中的平台说明（`references/platform-videograph.md` 路线 B）以本文件为准；SKILL-01 让同步脚本从本文件生成，避免两份说明分叉。

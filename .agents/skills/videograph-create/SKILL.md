---
name: videograph-create
description: 用 VideoGraph 的 videograph-pdoom MCP 从一首本地音频新建独立工程，分析歌曲、规划分镜、编写真实引擎场景、设计转场、审片并导出 MP4。用户说“让 GLM/ZCode 用 MCP 做视频”“新开一个 PV 工程”“用一首歌创作 MV/音乐视频”时使用；同时按需加载 shotcraft 和审美验收规则。
---

# VideoGraph：从新工程制作视频

只走当前全引擎管线（MCP `project_*`/`song_*`，TypeScript `Scene` 类）；不要使用已移除的工坊 `shot_queue_*`、`shot_cards_*`、`pdoom_*` 或旧工坊指导。先读项目的 `docs/MCP-GUIDE.md`：它是已实现工具参数、版本和状态机的权威来源；`ROADMAP.md` 不属于本流程输入，不能把计划中的工具当成已实现。若 MCP 暴露了 `videograph://skills/shotcraft/SKILL.md` 或相关 references resource，优先读取 resource 的当前内容；resource 与仓库文件不一致时，以当前工程服务响应和 MCP-GUIDE 的已实现契约为准。

## 启动前

1. 明确本地音频路径、工程名及用户提供的歌词/LRC。用户只说“新建工程”而未指明歌曲时，先在用户提供的目录中查找可辨认的音频；找不到就索取路径，候选不唯一时请用户选择。不擅自用参考曲、测试音频或占位路径代建；不得把音频上传到外部服务。
2. 检查本会话是否有 `videograph-pdoom` MCP 工具。如果没有，按 `docs/MCP-GUIDE.md` §1 启动工程服务、核对 MCP 配置并重连会话；不要直接改 SQLite 或绕过 MCP 模拟结果。服务端已有工作要先辨认归属，勿重启别人的实例。
3. 读 `skills/shotcraft/SKILL.md`，按实际创作阶段读取其 `references/shots.md`、`transitions.md`、`media-styles.md`、`effects.md`、`pipeline-playbook.md`。其中 `platform-videograph.md` 若与 MCP-GUIDE 冲突，以 MCP-GUIDE 和当前工具响应为准。若本机安装了 `video-shotcraft`，创作前读它的 `references/aesthetic-rules.md`，终检时读 `references/final-review.md`；只采用可迁移到音乐 PV 的节奏、构图、文字可读性与证据化审片规则，不照搬其中的 Remotion 命令、产品宣传片素材/SFX 规则或固定时长。没有该 skill 时，使用本 skill 的内置审片准则继续。
4. 读本 skill 的 [创作与审片准则](references/aesthetic-review.md)。形成针对这首歌的视觉方向（叙事主线、可见的主角/动作、材质与色彩、排版、能量曲线、镜头接力方式）；不要默认照抄参考工程的黑底橙光、原场景或歌词排版。
5. 开工必须检索`effect_search`的后期与转场、`scene_component_search/get`的基础件，记录选择后再新写代码。有参考片/仓库先抽帧看联系表和关键运动，再读实现；按[PV制作流程](../../../skills/shotcraft/references/pv-production.md)执行。不能把读了文档当成看了参考画面。

## 导演方式与恢复

- **同一个 agent 即导演与操作者**：先定视觉方向、安排逐镜工作、写场景，再用真实画面证据自评。无需第二套模型、额外模型服务或外部 judge；技术验证与指标也不是替代人审美接受的模型。
- **恢复优先于重建**：用户给了工程 ID 或要求继续时，先 `project_get` 与 `project_director_next`；未给 ID 时用 `project_list` 辨认工程，歧义才问用户。读取分析状态、导演版本/operations、镜头/转场当前版本、`resumable`、`project_feedback_inbox({projectId,status:"open"})` 与 `project_job_get` 的现有任务；复用签名仍匹配的成果，不重复建工程、分析、提交或渲染。不要取消或接管不属于自己的任务；同一 owner 对尚有效的 claim 可再次 claim 同一 action 续租并取回原 token；即使 active action 暂不在 actions 列表，也可按 resumable 的 actionId/kind/targetId 续租，过期后重读当前 action 再决定是否重领。
- **按版本绑定工作与证据**：导演方案、自评写入用 `expectedProjectRevision`（get/next 的工程 `revision`）；分析 patch、歌词与 plan 使用工程版本作为 `expectedInputRevision`；镜头/转场写入使用目标 `inputRevision`，不得混用。记录 action `scope`、导演 `analysisSignature`、自评 `signature/current`、目标 `inputToken/codeHash` 与证据任务/采样时间；签名由服务生成和比对，不自造。镜头 update 只留下 cursorToken，submit 才有源码 receipt；提交后 next 变为验证 action 时，仍先用 resumable 完成原制作 action。所有写入后重读 next；转场依赖前后镜头版本，镜头变更后重读转场。输入一变，旧验证/自评不能直接算作新版本通过。409 时重读并重新判断，不盲重试或覆盖别人的修改。
- **导演 MCP 闭环**：使用 `project_director_get/next` 读取当前 `phase/actions/blockers/review/exportReady/resumable`，用 `project_director_submit` 保存工程 brief/style/rhythm/shots，按 actionId claim 后执行；制作镜头/转场时必须带 claim 返回的 `operation.attemptToken`。镜头 update 只记录 cursorToken，随后 submit 才形成 receipt；即使 next 已显示验证 action，也用 resumable 完成原制作 action。`project_director_dispatch` 只批量执行已 claim 的验证、审片和导出，不生成源码、不替代导演判断，所有写入后重读 next。
- **通过 MCP 阅读 skill 与导演 prompt**：读取 `videograph://skills/videograph-create/SKILL.md`、`videograph://skills/videograph-create/aesthetic-review.md`、`videograph://skills/shotcraft/SOURCES.md`；通过 `direct_video({projectId})` 获取恢复/制作指导。prompt 只是当前流程入口，仍以工程返回的 action、版本和闸门为事实。
- **AI 自评与人工采用分离**：`project_review_submit` 只提交当前版本的证据化自评；它不接受意见。版本签名失效、blocking issue、技术验证未完成或人工意见未采用时，不得声称导出可用。

## 导演方案与操作纪律

`project_director_submit({projectId,expectedProjectRevision,director,author?})` 保存完整方案，`author` 默认 `mcp`，不要冒充 `human`：

- `brief: { intent, audience, mustKeep?, mustAvoid? }`，后两项为短文本数组。
- `style: { medium, palette: string[], typography, composition, motion, motif }`；色板非空。
- `rhythm: { sections: [{ sectionIndex, energy, intent }], accents?: [{ beatIndex, intent } 或 { lineIndex, wordIndex, intent }] }`；段落必须覆盖分析得到的全部段落且不重复，`energy` 为整数 1..5。重音用真实拍/词索引，时间由服务推导。
- `shots: [{ shotId, subject, action, entrance, exit }]`；规划前可为空，规划后必须补齐现有全部镜头再制作。
- `maxRepairs` 为 0..2，默认 2。重提方案会增加导演版本、清空 applied 标记/operations/自评，使旧租约和依赖证据失效；恢复时不能用重复 submit 绕过预算或重置进度。

分析、重试、方向、规划 action 不能 claim，先调用对应工具。其余 action 用返回的 `actions[].id` 作为 `actionId`，`project_director_claim({projectId,actionId,owner,leaseSeconds?})` 取得 `operation.attemptToken`（租约默认 300 秒，可设 30..900）。同 owner 可再次 claim 同一 action 续租并返回同 token；active action 即使暂不在 actions 列表，也按 `resumable.actionId/kind/targetId` 续租。只处理未被其他 owner 占用且未耗尽预算的目标；有限修复预算按目标汇总，不因 actionId 或重复 dispatch 分散计算。

镜头 `project_shot_update/submit` 和转场 `project_transition_configure` 必须带该 token；镜头 update 只留下 cursorToken，随后 submit 沿用同 token 才产生 receipt。提交后 next 可能变成验证 action，但仍用 `resumable` 完成原 generate/transition action。制作完成用 `project_director_complete({projectId,actionId,attemptToken,outcome:"done",jobIds:[]})`；它校验 receipt、当前目标及意见响应，不等于验证或人已采用。每次写入后重读 next，不保存旧 actions 做批量依赖；转场依赖前后镜头当前版本，镜头变更后重读转场。

确定性任务 claim 后可 `project_director_dispatch({projectId,actionIds,attemptTokens})`（1..100 项、位置对应）入队 `validate / validate-transition / stills / filmstrip / rhythm / contact-sheet / export`；已完成但尚未 complete 的同版本 job 也可复用。返回 jobs，等待真实任务结束后逐项 complete 并引用 jobIds。自评 action 需 agent 看图后自行 submit，不能 dispatch。`outcome:"failed"` 必须引用当前版本真实 `error/interrupted/cancelled` 任务，可附 `error`；调用报错不等于可虚构失败 job。完成或失败后重读 next，按实际 repair/blocker 推进，预算耗尽交接人处理。

## MCP 执行顺序

1. `project_create_from_audio({audioPath, name, lyricsText?, lrcPath?, language?})` 新建工程。保存返回的 `projectId`。指纹匹配参考 BGM 时会走参考导入，不算真正从零新歌；若目标是全新歌曲，应使用非参考音频并核实工程状态。不要为“新工程”无意重复创建多个工程。
2. 用 `project_get` 等待 `analysis-draft`；若 `analysis-failed`，调用 `song_analysis_retry({projectId})` 重新排队，不能伪造分析结果。用 `song_analysis_get` 核查时长、BPM/下拍、段落、歌词及词级时间。ASR 会误听；有用户歌词/LRC 优先对照。明显错词用 `song_lyrics_submit({projectId, expectedInputRevision, lyrics})` 提交整层歌词；节拍或段落需要改时，规划前用 `song_analysis_patch({projectId,expectedInputRevision,patch:{rhythm?,sections?},author?})` 整层替换，不能提交局部 bpm/offset 或其他分析层。任一修正都会回到 `analysis-draft`，必须重新读取并确认；BPM 倍频、段落或字级时间无法可靠纠正时停下来标注需人工校正。无歌词工程不得复用旧歌词。
3. 核对分析后先读 `song_cue_sheet({projectId})`：按小节查看段落、能量、鼓点、歌词及已有切点，注明推算拍点等数据局限；据此安排蓄力、爆发、留白和转场落点，而非机械每拍切镜。再调用 `song_analysis_confirm({projectId})`，明确这是 MCP/agent 确认而非人工确认。按 `project_director_next` 的 direction action，用工程 `revision` 提交完整导演方案（规划前 `shots:[]`），再重读 next 与工程版本，提交 `project_plan_submit({projectId,expectedInputRevision,plan,reasoning})`：按段落、歌词行或器乐时间锚点设计有变化的镜头；省略 `plan` 只会得到确定性兜底，不得称为 AI 创作。此时导演 `shots` 可以先为空；规划生成镜头后立即补齐导演 brief，再进入制作。
4. claim next 返回的 generate action 后，对目标调用 `project_shot_lyrics` 和 `project_shot_source`，以真实场景源码和引擎契约为准。有歌词时通过 `project_shot_update` 保存 `lyricPlan`（`summary` 与 `elements`；元素含真实歌词 `quote/name/meaning/treatment`，可选 `kind/cueWord`）；器乐段只用音乐结构设计画面。update 与随后 `project_shot_submit` 均带同一次 claim 的 `attemptToken`，每次写后重读目标 `inputRevision`，提交完整 TypeScript 文件（无代码围栏）及真正处理的 `feedbackResponses`。提示词或歌词方案修改后必须重新提交代码。源码由时间和种子确定，避开 `Math.random()`、真实时钟及参考曲字面量歌词。receipt 已生成且意见响应完成后 complete 该制作 action，再重读 next；制作 complete 不代表验证通过。
5. 按 next claim validate action，通过 dispatch 或 `project_validate` 入队，用 `project_job_get` 跟踪到完成，complete 时引用该真实验证 job；已 done 但尚未 complete 的同版本 job 可在重复 dispatch 时复用。失败按当前 next 的修复任务处理。验证只提供一张缩略图；还要用 `project_stills` 获取开头、中段、动作峰值、末尾等时点的真实 PNG 并逐张看。用 `project_filmstrip({projectId,shotId})` 看动作连续性，关键重音用 `around` 与 `frames` 看起势、命中和衰减；`project_preview` 可再检查实际播放。用 `project_rhythm_report({projectId,shotId})` 或段落范围量节奏，定位偏移、死区、过忙和闪烁；区分应修的问题与有意留白等风格提示，不追求每个下拍都命中。修复黑帧、文字遮挡、空洞、无变化及歌词提前高亮；重提交后对新版本复验。五帧技术抽检、连续帧采样和指标都不代表审美通过，不能只看任务状态。
6. claim transition action，`project_transition_get` 后结合 `song_cue_sheet` 决定硬切或 `dissolve/wipe/dip`；即使保留硬切，也要按导演 action 调用 `project_transition_configure` 并带 `attemptToken` 生成 receipt，再 complete。转场服务叙事与音乐，不堆数量。按 next claim validate-transition、验证当前配置和两侧版本，并查看切点前后静帧及 `project_filmstrip({projectId,transitionId})`；非硬切转场必须保留动态证据，涉及节奏时再跑转场 rhythm_report。不提前展示下一镜歌词，不改变总时长。
7. 查 `project_feedback_inbox({projectId, status:"open"})`。清晰的 `pending` 意见要读锚点和保留项、看修改前画面、只改目标，制作 action 的 submit/configure 用 `feedbackResponses` 逐条说明并复验；含糊意见用 `project_feedback_ask` 等待人回复。锁定目标必须等待人解锁，AI 不得自行解锁或接受意见。响应并复验后，`responded` 意见交给人对比采用；仍未接受或待生成目标造成 `project_render` 409 时停在人工审片节点，不绕过闸门。
8. 按 next 领取并完成所有 stills/filmstrip/contact-sheet/rhythm action；用 `project_contact_sheet({projectId})` 看每镜色彩、构图、段落能量和雷同，用全片 `project_rhythm_report` 以及镜头/转场 filmstrip 复核音乐—画面关系。调用 `project_review_submit({projectId,expectedProjectRevision,review})` 时，summary、七项 assessments（composition/hierarchy/readability/semantics/rhythm/consistency/originality）、issues（blocking/warning/intentional）和 protect 必须基于真实证据；evidence 引用当前完成 job 的 `jobId`、可选合法 PNG `file`/采样 `t` 与 observation。必须覆盖每镜 stills+filmstrip、每个非硬切转场 filmstrip、全片 contact-sheet+rhythm。blocking 要返工，风格提示说明为何 intentional；自评是 AI 记录，不是人的接受，也不新增第二套模型。
9. 只有 `project_director_get/next` 显示 `exportReady:true` 且当前 review 无 blocking、技术验证和人工意见闸门均通过后，claim export action，用 `project_director_dispatch` 入队或直接 `project_render`，等待真实 export job，再 complete 并核对 MP4 的帧率、帧数、时长、分辨率、音轨和完整解码。记录工程 ID、输出路径、当前签名、确认者、改动和剩余问题。不能把“代码已提交”“技术验证成功”“AI 自评”“审片通过”“人已接受”“已导出”混为一谈。

## 审美与迭代

每轮先读`project_feedback_inbox({projectId,status:"open"})`，按目标ID/anchor/preserve处理意见，不要求人再口述镜头号。改过的镜头先用草稿少量静帧再正式提交，随后默认取连续帧看运动；约2秒12帧的参数、切点检查和歌词语义配方见[PV制作流程](../../../skills/shotcraft/references/pv-production.md)。只重提交实际改过的目标，复用仍匹配当前签名的任务；导出前将无法看到播放、无法听到音频等未验证项写入当前自评summary或warning，不把静帧抽检称为完整动态接受。OpenUtau/歌声模块已冻结，不主动扩展或优化其调用。

每镜先写一句“观众应看到/感受到什么”，再选手法；一镜一个主角动作，有准备、变化和落点。全片有不同能量层级、清晰的视觉母题和实物/空间/动作，不是一套抽象背景加滚动歌词。让上一镜的形状、运动方向或颜色成为下一镜的入口；硬切也可以是最有力的转场。先看真实画面再调整，最多在同一技术错误上重试两轮；超出后报告具体阻塞。

按 [创作与审片准则](references/aesthetic-review.md) 对每镜和全片做证据化自查，记录有时间点的缺陷与修复。人类审美接受是单独的门槛；不能替人点接受。无法进行实际视觉检查时，明确说明只通过了技术验证，不称为高质量成片。

0.2 大工程迭代：先用 project_draft_check / preview / stills 检查未提交代码，不制造任务/快照。多镜明确共享同一修改时逐镜 claim 最新制作 action，把各自 attemptToken/expectedInputRevision 组成 project_scene_module_submit.bindings，重读工程revision后一次发布；任一锁/冲突整批回滚，按各自receipt分别complete，随后重读next。不能把转场的旧依赖纳入批量。已有歌词/节拍真值可在建工程时传truth跳过模型；超过半数估算歌词不能确认，先校正。MIDI/假名与外部人声通过导入工具生成草稿；仍由人在候选试听后采用。

# platform-videograph.md — VideoGraph 平台适配

平台根目录：本仓库。已实现工具以 `docs/MCP-GUIDE.md` 为准；当前说明从 `docs/README.md` 进入，计划与进度只见 `ROADMAP.md`。
唯一执行管线是**全引擎管线**（旧工坊 mini-engine 队列已随 CLEANUP-01 移除）：

| | 全引擎管线 |
|---|---|
| 入口 | `videograph` MCP（旧名 videograph-pdoom） 的 `project_*` 工具 |
| 场景契约 | **Scene 类**（three.js + GLSL + Canvas2D 分层，pdoom 引擎同源） |
| 工程 | `projects/<uuid>/engine/`（完整引擎拷贝）+ `project.sqlite` + `artifacts/`（验证 png/mp4）+ `exports/` |
| 转场 | 引擎级（参数化配置）+ 镜头自转场 |
| 产物 | 编译+5 帧抽检 → 预览 → 整片 MP4 导出 |

判断方法：会话里挂着 `mcp__videograph__project_*`（或旧名 `mcp__videograph-pdoom__project_*`） 工具且用户在谈某个 PV 工程 → 本路线。

---

## 全引擎管线（videograph MCP）

### 工程结构

```
projects/<uuid>/
  project.sqlite          # 工程状态（镜头/版本/转场/反馈/任务）
  engine/                 # 引擎完整拷贝（app/src/engine|scenes、data、audio、docs）
  artifacts/<hash>.{json,png,mp4}   # 验证抽帧/导出产物
  exports/<uuid>/         # 成片
```

### 场景契约（= pdoom 引擎，与 `engine/docs/ENGINE.md` 一致）

- 文件 `engine/app/src/scenes/<name>.ts`，默认导出 `extends Scene` 的类；
  `render(f: Frame, out)` 必须完全覆盖 out（HalfFloat 线性 HDR），返回 PostOverrides。
- 工具：`FSPass`（全屏 GLSL3，自动前置 GLSL_COMMON：调色板常量/hash/snoise/fbm/SDF/smin/
  hatch/engrave/heat/aaFill/aaStroke/pxLine/heat）、`Layer2D`（Canvas2D 层，`comp.draw` 合成，
  mode normal/add/screen/multiply/max）、`LineBatch`（GPU 胶囊线段 seg2/polyline，1 万–20 万段）、
  `type.ts` 字体（Archivo 可变宽度 62–125/权重 300–900、IBM Plex Mono、Cormorant）、
  `stroke.ts` 单笔画字体、`_motifs.ts` 火花/面具。
- Frame：`f.t/lt/p/a(六路包络+kick/snare/hat/vonset)/beat/beatPhase/bar/under/tin/tout`。
- `effects.md`、`shots.md` 的技法是创作参考，不代表每个手法都能在本工程或当前引擎契约中原样实现；使用前以 `project_shot_source` 返回的真实 `Scene` 契约、可用素材与验证结果为准。范例代码只能迁移思路和已核实的引擎模式，不能承诺完整 AE 图层或效果市场能力。

### 工具链工作流（按序，勿跳步）

<!-- BEGIN:generated-from-MCP-GUIDE (scripts/skills/sync-platform.mjs 自动生成；勿手编) -->

**工具速查（自动生成自 `docs/MCP-GUIDE.md` §3，toolset 2026-10-08；勿手编——更新请跑 `node scripts/skills/sync-platform.mjs`）**

| 工具 | 参数 | 作用 |
|---|---|---|
| `scene_component_search` | `query?` | 检索相机、投影、世界卡片、海/天空/水下、逐字动画、独立图层 |
| `scene_component_get` | `id` | 获取类型化基础件源码/导出/用法；新工程 import，旧工程内联，不改冻结引擎 |
| `project_vocal_import_midi` | `projectId, midiPath, trackIndex?, channel?, lyrics?, tempo… | 只读 MIDI→乐谱草稿，显式选择单声部；假名配词并验证本机声库 CV/VCV 别名，不自动提交 |
| `project_vocal_import_audio` | `projectId, expectedInputRevision, audioPath, offsetMs?, re… | 外部干轨冻结导入，offsetMs 对齐，可带乐谱和参考干轨；渲染后人工采用，频段报告比较实际 dBFS |
| `project_list` | — | 本地工程列表：`id / name / status / shots / duration / revision / createdAt`（按… |
| `service_health_get` | — | 健康、运行代码是否过期、数据库大小、任务/操作积压和迁移状态；使用缓存采样，不读任务大行 |
| `project_version_get` | `projectId` | 轻量 `revision / jobsVersion`；改变时再拉工程或最近任务，不轮询整个任务表 |
| `project_scene_module_submit` | `projectId, moduleId, expectedProjectRevision, code, bindin… | 一份源码、一个修订；bindings 含每镜 shotId/expectedInputRevision，可含 params/attemptTo… |
| `project_draft_check` | `projectId, shotId, expectedProjectRevision` | 可选 code/params。类型检查和初始化材料的着色器编译，不出帧、不写任务/修订；render 中才创建的材料需要正式验证，结果明确说明… |
| `project_draft_preview` | `projectId, shotId, expectedProjectRevision` | 可选 code/params，返回真实引擎的临时草稿播放器 URL；不写源码/任务/修订，支持连续运动观察 |
| `project_draft_stills` | `projectId, shotId, expectedProjectRevision` | 可选 code/params/times（镜头内最多12帧）；直接返回有镜头号和时间的临时 PNG 联系表，不建立任务 |
| `project_create_from_audio` | `audioPath` | **新建**工程，只在用户明确要新片时调用。可选 `truth` 跳过自动分析（见上文）；还可选 `name / lyricsText / l… |
| `project_create_from_bgm` | `audioPath` | `project_create_from_audio` 的别名（保留兼容），可选 `name / allowDuplicate` |
| `project_get` | `projectId` | 完整工程：镜头、转场、意见、版本、输出规格。默认只返回歌曲摘要，`includeAnalysis: true` 返回完整词级歌词/节拍/包络 |
| `project_director_get` | `projectId` | 读取导演方案、工程 `revision`、当前 `phase/actions/blockers/review/exportReady/resu… |
| `project_director_next` | `projectId` | 与 `project_director_get` 调同一服务端点、返回同一份导演状态；保留为“接下来做什么”的入口名，按 `actions` … |
| `project_director_submit` | `projectId, expectedProjectRevision, director` | 保存 brief/style/rhythm/shots/maxRepairs 并递增导演版本；规划前 shots 可为空，规划后必须补齐每镜 … |
| `project_director_claim` | `projectId, actionId, owner, leaseSeconds?` | claim 制作/验证/审片/导出待办；leaseSeconds 为30..900、默认300。同 owner 有效续租返回原 token；返… |
| `project_director_complete` | `projectId, actionId, attemptToken, outcome` | outcome 为 done/failed；可带 jobIds（≤100，默认[]）和 error。校验租约、当前目标、receipt 与真实… |
| `project_director_dispatch` | `projectId, actionIds, attemptTokens` | 1..100个唯一 actionId，token 数组按位置对应、先 claim；只入队 validate/validate-transiti… |
| `project_review_submit` | `projectId, expectedProjectRevision, review` | 提交 summary/七项 assessments/evidence/issues/protect；结构见 §6。真实当前证据覆盖每镜 sti… |
| `song_analysis_get` | `projectId` | 读取 `videograph-analysis/v2` 分析与 `provenance`、当前 `inputRevision`。默认层 `au… |
| `song_lyrics_submit` | `projectId, expectedInputRevision, lyrics` | 整层替换歌词：`{ lines: [{ text, start, end, words: [{ w, start, end }] }], la… |
| `song_analysis_confirm` | `projectId, expectedInputRevision` | 确认分析，`analysis-draft → analysis-confirmed`。agent 可调用，记为 `confirmedBy: m… |
| `song_analysis_retry` | `projectId, expectedInputRevision` | 仅 `analysis-failed` 可重试，重新排队分析并转 `analysis-pending`；等 `project_get` 返回 … |
| `song_analysis_patch` | `projectId, expectedInputRevision, patch` | 仅规划前的 `analysis-draft / analysis-confirmed` 可用；以工程版本整层替换 `patch.rhythm`… |
| `project_plan_submit` | `projectId, expectedInputRevision` | 仅 `analysis-confirmed` 可用。`plan: [{ lineText | sectionIndex | t, title?… |
| `project_vocal_get` | `projectId` | 乐谱独立 inputRevision、draft、candidate、active；候选含人声/混音 WAV、USTX、LRC、pitchRe… |
| `project_vocal_check` | `projectId` | 本机声库、契约与真实 oto 别名（最多 1000 个，超出有标记）；缺配置返回 ready=false，不要求 OpenUtau GUI |
| `project_vocal_submit` | `projectId, expectedInputRevision, plan` | 固定 BPM、单轨单 part、480 tick/拍；note 的 lyric=真实 oto 别名，pitch/tone、startBeats… |
| `project_vocal_render` | `projectId, expectedInputRevision` | 冻结乐谱/配置并渲染曲线、颤音、包络/力度及混音，返回后台 vocal 任务；用 project_job_get 查询、project_job… |
| `project_shot_lyrics` | `projectId, shotId` | 镜头窗口内词级歌词、`instrumental` 标记、已有 `lyricPlan` |
| `project_shot_source` | `projectId, shotId` | `{ shot, code, contract, lyricContext, source }`：当前真实 TS 源码与完整引擎契约（ENGI… |
| `project_shot_update` | `projectId, shotId, expectedInputRevision, patch`（导演制作 acti… | patch 仅允许 `title / prompt / params / lyricPlan`（不含 `locked`，AI 不能改锁）。改 … |
| `project_shot_submit` | `projectId, shotId, expectedInputRevision, code`（导演制作 actio… | 提交**完整**场景文件（无 markdown 围栏）给**这一个**镜头，可带 `summary`、`feedbackResponses: … |
| `project_feedback_add` | `projectId, shotId, expectedInputRevision, text` | 新增镜头意见（≤8000 字符），可带 `anchor`（`t/range/lyricElementId/region/aspect`，服务端… |
| `project_transition_get` | `projectId, transitionId` | 转场节点、意见、配置、前后镜头元素方案、准确时间窗 |
| `project_transition_update` | `projectId, transitionId, expectedInputRevision, patch`（导演工… | patch 仅 `intent`（不含 `locked`，AI 不能改锁）；新 intent → `needs-generation`，需随后… |
| `project_transition_configure` | `projectId, transitionId, expectedInputRevision, config`（导演… | `config: { mode, duration ≤1.5, easing, direction, effectId?, params? }… |
| `project_transition_feedback_add` | `projectId, transitionId, expectedInputRevision, text` | 新增转场意见（可带 `anchor/preserve`，锚点窗口为前后镜头合并窗口），同时冻结两侧镜头版本 |
| `project_transition_validate` | `projectId, transitionId` | 后台抽检切点前后 5 帧，返回 job |
| `project_feedback_inbox` | — | 可选 `projectId`、`status`（默认 `pending`；`open` 为全部未接受）。agent 的入口：返回每条意见的目标… |
| `project_feedback_ask` | `projectId, targetKind, targetId, feedbackId, question` | 意图含糊时向人提问：意见转 `needs-clarification`，人回复后回 `pending`；提问不改输入版本。AI 不能替人回复 |
| `project_stills` | `projectId`（另需 `shotId` 或 `transitionId`） | 可选 `times`（≤6 个、须在目标时间窗内；默认 = 未接受意见锚点 t + 窗口 0/0.5/1）、`version: current… |
| `project_preview` | `projectId` | 可选 `shotId / transitionId / version: current|before-feedback`。返回本机真实引擎播… |
| `project_validate` | `projectId, shotId` | 后台编译 + 5 时间点抽检，返回 job；完成后镜头 `validation.thumb` 指向 `artifacts/<key>.png`… |
| `project_render` | `projectId` | 可选 `fps: 24/30/60`、`samples: 1/4/12`。后台导出完整 MP4，冻结当前版本，按镜头命中分段缓存。完成后 `r… |
| `project_job_get` | `projectId` | 可选 `jobId`；省略则列出最近任务（此时 `waitSeconds` 被忽略）。看 `status / progress / error… |
| `project_job_cancel` | `projectId, jobId` | 取消排队或运行中的任务 |
| `song_cue_sheet` | `projectId` | 按小节的文本节奏表：时间、段落（▶段首）、能量 1–5（小节 rms 在全曲 p5–p95 中的位置）、每拍 2 格鼓点型（`K` kick … |
| `project_filmstrip` | `projectId` | 一段连续帧拼成一张网格图（≤24 格），每格标 `时间 小节.拍 ●下拍 K S “词”`，下拍帧橙框。范围：`shotId` / `tran… |
| `project_contact_sheet` | `projectId` | 可指定selections=[{shotId,t}]跨镜头时间点（≤120，保序），或全片每镜头1–3帧（ratios默认[0.45]）拼图，… |
| `project_rhythm_report` | `projectId` | 顺序渲染目标时间段（范围参数同 filmstrip；`sampleFps` 10–60，默认 ≤30 秒用工程帧率、更长用 15），返回文本报… |
| `craft_guide` | — | shotcraft 技法库节选（≤12k 字符）。`topic`：`shots / transitions / effects / media… |
| `effect_search` | — | 按风格/用途关键词（risograph、水彩、卡点、glitch、胶片…）、`kind`（`post` 镜头后期 | `transition`… |
| `effect_get` | `id` | 完整定义：参数规格、节拍绑定、来源与许可、着色器代码、可直接复制的套用调用示例 |
| `effect_preview` | `id` | 在演示素材（`source`: type 文字海报 / scene 风景 / shapes 几何 / portrait 人像剪影）上渲染 4–… |
| `project_shot_effects` | `projectId, shotId, expectedInputRevision, effects` | 设置镜头后期栈：`[{ id, params?, bindings? }]`，按顺序叠加、最多 4 层、空数组清除；只接受 kind=post… |
| `fx_sources` | — | 登记的来源：仓库、commit、许可状态、署名、第三方素材说明、本机缓存数 |
| `casebook_list` | — | Code Video Casebook 的 31 个真实代码视频案例（id、标题）。做新片前先挑 1–3 个最接近的 |
| `casebook_case` | `caseId` | 案例检索卡（一句话、规格、何时抄、架构、最值得抄的做法、坑、CoExp 行号导读）+ 源码清单 + 20 帧联系表图片 |
| `casebook_search` | `query` | 正则检索，返回 `path:行号:内容`；`scope`：`cards`（默认）/ `coexp` / `source`（必须给 `cases… |
| `fx_library_search` | `query` | Opus 视频提示词库检索（正则），返回 `来源id:路径:行号: 片段`；来源见 `fx_sources`（kind=prompts）：le… |
| `fx_library_read` | `source, path` | 读提示词库文件（路径相对该仓库根，如 `styles/watercolor/STYLE.md`），`lines: "起:止"`，单次 ≤12k… |
| `casebook_read` | `path` | 读文件（相对 casebook 根，如 `references/cases/oneink/CoExp.md`、`references/tech… |

硬规则：AI 不能接受意见。 只改目标：`project_shot_submit` 只作用于一个镜头并生成不可变的新源码文件；不要借响应一条意见顺手重写其他镜头。 保留原始意图：不要用 `project_shot_update` 把人的意见写进 `prompt` 覆盖原文；意见本身已单独保存。 锁定的镜头/转场只能由人在界面解锁：MCP 的 update patch 不接受 `locked`，服务端也拒绝 AI 解锁。 时间一律从分析数据推导（词起点、拍点），不在场景代码里硬编码秒数。 有未接受意见或 `needs-generation` 的镜头/转场时，`project_render` 会被拒绝，这是预期行为。 先找已有工程。 局部修改只重渲局部。
<!-- END:generated-from-MCP-GUIDE -->

新歌创建与分析确认按 `docs/MCP-GUIDE.md` §4 和 `.agents/skills/videograph-create/SKILL.md` 执行；以下是既有工程的逐镜操作，不是另一套工坊队列流程。

1. `project_list` / `project_get` 与 `project_director_get/next`：读工程、导演 phase/actions/blockers 与镜头版本。恢复时查 `project_feedback_inbox` 和 `project_job_get`，复用当前签名匹配的任务与成果，不重复建工程。规划和节奏调整前读 `song_cue_sheet`，先保存导演方案；plan 后补齐每镜制作 brief。制作前 claim 当前 action 并保存 attemptToken，长任务在租约到期前续租。
2. `project_shot_lyrics`：读目标镜头窗口内的**词级歌词**；同时把视觉构思写成 `lyricPlan`
   （summary + elements[]，每个 element = `{kind: entity|action|metaphor, quote, meaning,
   treatment, cueWord?}`——**quote 必须是真实歌词原文，会被校验**），用
   `project_shot_update` 带 claim 的 `attemptToken` 保存，并重读目标版本。先想清楚"这句词怎么变成画面"再动代码；器乐不伪造歌词元素。
3. `project_shot_source`：读该镜头**当前真实 TS 源码 + 完整引擎契约**。改代码基于它，不要凭空写。
4. `project_shot_submit`：提交**完整文件**（不带 markdown 围栏），必须带
   最新目标 `expectedInputRevision` 与 claim 的 `attemptToken`（并发控制；版本/租约不匹配先重读）。保存不可变新版本与真实 receipt，标记待验证；complete 制作 action 不等于验证或人已采用。
   若本次修改响应了 pending 反馈，优先用 `feedbackResponses` 逐条说明 `outcome/how`（partial 必须说明）；`addressedFeedbackIds` 仅保留兼容——这些只是“已响应”记录，**是否采用由用户在界面确认**。
5. `project_validate`：后台编译+抽检 5 帧 → `project_job_get` 查结果（错误/单张缩略图地址）。
   **通过 ≠ 审美通过**——用 `project_stills` 看多个时点，`project_filmstrip` 看连续动作/冲击起落，`project_rhythm_report` 按镜头或段落量节奏；有条件时再用 `project_preview` 播放，`artifacts/` 里的 png 用 Read 看。问题定位并复验，风格提示按设计意图判断，不强求每拍都有画面冲击。
6. claim 转场 action 后，`project_transition_get` 读相邻镜头节点与准确时间窗；`project_transition_configure` 必须带 `attemptToken`，配置 `{mode: cut|dissolve|wipe|dip|effect（effect 另给 effectId/params）, duration ≤1.5s, easing: linear|smooth, direction: left|right}` 并生成 receipt——**新配置需预览验证**。随后 complete 制作 action，再 claim/dispatch `project_transition_validate`，抽检切点前后 5 帧；非硬切必须用 `project_filmstrip({projectId,transitionId})` 留动态证据。指导性意见走 `project_transition_update`（新的指导标为待配置，不会假装效果已变）。
7. 反馈回路：人的修改意见经 `project_feedback_add` 成为独立反馈节点（保留原始 prompt 与修改前版本，只影响目标镜头）；改代码时在 submit/configure 中带上 claim 的 `attemptToken` 和 `feedbackResponses` 并复验。含糊意见先 `project_feedback_ask`，锁定镜头/转场必须等待人解锁（MCP 的 update patch 不接受 locked）；AI 不得自行解锁或替人接受。响应制作 action 后 complete，再按 next 领取修复或验证。
8. 出片前：按 next 领取并 dispatch/完成每镜 stills+filmstrip、非硬切转场 filmstrip、全片 contact-sheet+rhythm；用 `project_review_submit` 写七项 assessments、证据 job/file/t/observation、issues（blocking/warning/intentional）和 protect。记录服务签名与当前输入版本；修改后旧证据不算新版本通过。AI 自评不等于人的采用，不能绕过未接受意见等闸门。只有 `exportReady:true` 才 claim export，dispatch 或 `project_render`（fps 24/30/60，samples 1/4/12）后台导出 MP4 → `project_job_get` → complete，再核对成片音轨、时长和接缝。

### 铁律

- **先找已有工程**：用户要“改一下/继续/重新导出”时先 `project_list` 辨认并沿用原工程 id，不要重新 `project_create_from_audio`；同一音频已有工程时服务返回 409 + `existingProjects`，只有用户明确要新工程才带 `allowDuplicate: true`。
- **改一镜只重渲一镜**：导出分段缓存按镜头计（源码哈希 + params + 后期栈 + 时间窗 + 镜头专属素材）。只对目标镜头 submit/update；多镜共用一份场景源码时，只把新版本提交给要改的镜头，别把共用文件重新提交给所有镜头（那会让全片重渲）。导出后读 `result.cacheSummary` 与 `reports[].missReason` 向用户说明重渲了哪些镜头、为什么。
- 提示词（prompt）修改后**必须重新提交代码**（提示词与代码是一对的）。
- 不覆盖其他镜头、不覆盖原参考实现——submit 只作用于目标镜头且产生新版本。
- 验证/渲染都是后台任务：提交后轮询 `project_job_get`，不要并行提交同一镜头多版本。
- 词/拍时间一律来自 `ctx.lyrics / ctx.audio`（`lyrics.get(文本).words[i].start`、
  `audio.timeOfBeat/beatAt/events`），绝不硬编码秒数——换 BGM/换对齐数据就全崩。

## 数据集

`src/song/data/full-song.json`：`{ song, bpm, duration, envFps, lines[](词级), sections[], beats[],
downbeats[], kick[](强度对), snare[], rms/low/mid/high/vocal/drums[] }`——从 pdoom-video 的
data/*.json 切出，工程服务建工程（指纹导入）时读取。
该文件是参考指纹导入的数据源，不是新歌工程的通用歌词来源。新歌走 `project_create_from_audio` 的独立分析流程，以 `song_analysis_get` 返回的本工程分析和 `project_shot_source` 契约为准；没有歌词时不得套用原曲歌词。

### 导演入口与 skill 读取

同一个 agent 完成导演规划、逐镜执行和证据化自评，不要求第二套模型。当前 MCP resources 可读取 `videograph://docs/mcp-guide`、`videograph://docs/vocal`、`videograph://skills/shotcraft/SKILL.md`、`videograph://skills/shotcraft/SOURCES.md` 与 shotcraft references；制片 skill 和审片准则分别用 `videograph://skills/videograph-create/SKILL.md`、`videograph://skills/videograph-create/aesthetic-review.md`。版本与工具表只维护在 MCP-GUIDE。导演 prompt 为 `direct_video({projectId})`，只提供流程指导，不能替代工程当前事实。

`project_director_get/next` 返回 phase/actions/blockers/review/exportReady 与工程 revision，并返回 active operation 的 `resumable`（actionId/kind/targetId/owner/attemptToken/leaseExpiresAt/expired/receipt/jobIds）。方案、自评使用 `expectedProjectRevision`，目标写入使用目标 `expectedInputRevision`。规划前导演 shots 可空，plan 后用 `project_director_submit` 补齐每镜 subject/action/entrance/exit 再制作。领取 action 的 `id` 作为 actionId，claim 返回 `operation.attemptToken`；镜头 update 只记录 cursorToken，随后 submit 与转场 configure 才形成 receipt，complete 校验真实结果。源码提交后 next 可能只显示验证 action，原制作必须用 resumable 完成；dispatch 只入队已 claim 的确定性验证/审片/export，done 未 complete 的同版本 job 也可复用，不创作源码或调用模型。真实审片证据必须覆盖每镜 stills+filmstrip、非硬切转场 filmstrip、全片 contact-sheet+rhythm，再 `project_review_submit`；签名过期、blocking、技术或人工闸门不通过时不能导出。有限修复预算按目标汇总。分析 retry 仅 failed 状态；patch 仅规划前全层 rhythm/sections，之后需重读确认。完整契约与租约规则见 MCP-GUIDE §6。

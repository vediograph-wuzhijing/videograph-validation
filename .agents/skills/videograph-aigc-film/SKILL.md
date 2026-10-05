---
name: videograph-aigc-film
description: 用外部 AIGC 模型（生图 / 图生视频 / 语音合成）加 VideoGraph 工程制作“全 AIGC 电影化短片”：定角色 → 关键帧 → 图生视频 → 配音配乐 → 在 VideoGraph 引擎里合成手机界面、文字、地图等叠层并走审片与人工意见闭环、导出 MP4。用户给出分镜剧本并提供生图/生视频 API（如 OpenAI Next：gpt-image-2、Seedance、qwen-tts），要求“按剧本生成宣传片/动画短片/二次元画风短片”时使用。纯代码渲染的音乐 PV 用 videograph-create。
---

# VideoGraph：AIGC 电影化短片

一句话：**AI 模型负责画面素材，VideoGraph 负责剪辑、叠层、节奏、审片与导出。** 实战来源：《拾愿长安，愿梦成真》60 秒开篇宣传片（日漫画风，21 镜 / 16 段 AI 视频，2026-10-03）。

先读 `docs/MCP-GUIDE.md`（工程服务与 MCP 的权威契约）。本 skill 的脚本走工程服务 HTTP API（与 MCP `project_*` 工具同一套接口，作者记 `mcp`）；有 MCP 会话时直接用对应工具。

## 开工前（必须先确认）

1. **授权与版权**：真实品牌、真实人物肖像、第三方图片/音乐，没有授权一律不用。用户要做“某品牌广告”时先问用途与授权：作品集样片、有授权素材、或改成虚构品牌——这决定能否出现品牌名与 logo（见 [references/production-rules.md](references/production-rules.md)）。
2. **密钥**：用户在对话里给的 API key 只写进工作目录的 `.env`（`CREDIT_MEDIA_API_KEY`、`API_BASE`），不进代码、日志、任何 git 仓库；交付时提醒用户轮换。
3. **剧本核对**：逐段列出时间码、画面、台词/画外音。剧本自相矛盾（标称时长与时间码不一致、前后文字不一致）时选一个、在交付说明里写明，或一次性问用户。
4. **额度意识**：生视频最贵。先各试 1 张图、1 段视频确认格式与质量，再批量；批量设并发上限（4），每个请求登记到 `log/requests.jsonl`（不含密钥），失败可按任务 ID 续取，避免重复扣费。

## 工作流

```
storyboard（单一事实来源）→ 定妆设定图 → 关键帧（以设定图为参考）→ 图生视频
                         → 配音（TTS）→ 配乐 + 音效 + 避让混音（一条音轨）
→ VideoGraph：建工程（这条音轨）→ 修正节拍/段落 → 规划（每镜一个 t 锚点）
→ 素材进工程（视频转帧序列）→ 场景源码 + params → 验证 → 静帧/联系表/节奏报告自查 → 导出
→ 人在审阅室提意见 → 按意见改（先挂后期栈，再提交源码并声明响应）→ 人采用 → 重新导出（命中分段缓存）
```

1. **分镜表** `storyboard.mjs`：每镜 `id/t/dur/kind/title`；`kind=video` 写 `kf`（关键帧画面）、`refs`（参考角色）、`motion`（运动描述）、`clip`（生成时长）；`kind=engine 类`（手机界面、文字卡、地图、落版）写叠层参数 `ov`；配音 `VO[{t,voice,text}]`、音效 `SFX[{t,kind}]`。脚本自检：首尾相接、总长正确。
2. **定妆设定图**（`chars.mjs`）：每个角色一张“三视图 + 表情”设定稿，白底、无文字。历史人物按史料设定服饰发式与标志物（见 [references/prompts.md](references/prompts.md) 的考据清单）。逐张看图确认后再往下。
3. **关键帧**（`keyframes.mjs`）：`/v1/images/edits` 带设定图做参考，提示里写“人物与参考设定图完全一致”；生成 3:2 再裁 16:9，提示“主体放在 16:9 安全区”。需要后期贴字的物件（愿签、屏幕、地图中央）明确要求“空白、无文字”——文字一律由引擎绘制。
4. **图生视频**（`videos.mjs`）：Seedance 首帧 = 关键帧；提示写清运动与运镜，加“保持首帧人物造型与画风不变、不要出现文字”。抽 4 帧检查人物稳定再批量。
5. **声音**：TTS 逐句生成（并发会触发 429，顺序 + 退避重试）；配乐若音乐 API 不可用，用 numpy 原创合成（按剧本情绪排段落）；音效合成；配音处音乐自动压低；需要“戛然而止”就在音轨里硬切。**音轨先定稿再建工程**——工程时长与切点都从它来。
6. **VideoGraph 工程**：`create`（音频）→ 分析器 BPM 常有八度/相位误差，用已知真值整层 `song_analysis_patch` 修 rhythm 与 sections 后 confirm → `plan`（每镜 `t` 锚点）。**工程只建一次**：建好后把 id 写进工作目录的 `project-id.txt`，之后所有步骤（包括下一轮修改、重新导出）都读它。用户说“把第 N 镜改一下”时继续这个工程，不要重新 `create`；只有音轨本身变了（时长/切点重做）才建新工程，此时服务对同一音频会返回 409 + `existingProjects`，确实要新建才带 `allowDuplicate: true`。
7. **合成**：AI 视频用 ffmpeg 截取本镜时长转 1280×720 帧序列放进工程 `engine/app/public/<proj>/<shot>/`，场景在 `init()` 里预解码、`render()` 按 `f.lt` 取帧（模板 [scripts/clip-scene.ts](scripts/clip-scene.ts)）；缺视频时用关键帧缓推兜底，整片先跑通。叠层、字幕、节拍冲击都在场景里画（细节见 [references/engine-compositing.md](references/engine-compositing.md)）。需要“实感/冲击”时套特效箱后期（`timed-impact` 定时冲击、`bloom-glow`、`light-leak` 等，`project_shot_effects`）。
8. **自查与导出**：`validate` 全绿 → 每镜静帧 → 联系表 + 节奏报告 → 导出 → 每 2 秒抽帧拼带时间码的检查图逐张看（字压脸、对比度、出画、空帧）。按 [references/qc.md](references/qc.md)。
9. **人工意见闭环**：读工程意见（`project_feedback_inbox` 或 `project_get` 的 `feedback`）。只改被点名的镜头；**先挂后期栈（effects/params），再提交源码并带 `feedbackResponses`**——提交后再改镜头会让响应退回 pending。AI 不能采用意见；有未采用意见时导出会被 409 拦截，这是预期，交代用户去审阅室对比并采用，采用后再导出（只重渲改过的镜头）。

## 局部修改只重渲局部

导出分段缓存按镜头计：该镜的**源码哈希** + `params` + 后期栈 + 时间窗 + 镜头专属素材目录（`engine/app/public/<proj>/<shotId>/`）。本流程是“一份通用场景源码按 `params.shot / kind` 分支、提交给所有镜头”，所以：

- **改了共用场景文件后，只给要改的镜头重新提交**：`node pipeline.mjs build s07,s12`（只重建列出的镜头）。不带镜头列表的 `build` 会把新源码提交给全部镜头，每镜源码哈希都变，导出就全片重渲。其他镜头继续用旧模块即可命中缓存（各镜模块各自不可变，互不影响）。
- 能用 `params`（`project_shot_update`）或后期栈（`project_shot_effects`）表达的修改，优先用它们，不动共用源码。
- 只换某镜的帧序列/图片：只更新该镜的 `public/<proj>/<shotId>/` 目录，只有这一镜失效。放在共用位置的素材（字体、公共图）会改变引擎指纹，让全片重渲。
- 导出完成后读 `result.cacheSummary`（复用/重渲镜头数与原因）和 `reports[].missReason`，在交付说明里如实写哪些镜头重渲了、为什么。全片重渲且原因是 `code`，多半是共用源码被提交给了所有镜头。

## 硬规则

- 画面里的中文/品牌/UI 文字全部由引擎绘制，不让生图模型画字。
- 角色一致性靠“设定图做参考”，不要只靠文字描述；每个新关键帧都看一眼人物是否走样。
- 场景是 `f.lt` 的确定性函数；素材只在 `init()` 加载；不用 `Math.random()`。
- 不要为凑节奏报告的数字去挪合理的切点（自由节奏段跟配音与情节走），但“音乐最燃、画面静止”的段落要补随拍运动。
- 交付时区分：已生成 / 已验证 / 等人采用；列出与剧本的差异、失败或替代的环节（例如音乐 API 不可用改为原创合成）、密钥与额度情况。

## 参考

- [references/prompts.md](references/prompts.md)：画风关键词、设定图/关键帧/运动提示模板、历史人物考据清单
- [references/media-api.md](references/media-api.md)：生图、编辑、Seedance、TTS、音乐接口格式，轮询、续取、错误码对策
- [references/engine-compositing.md](references/engine-compositing.md)：帧序列播放、手机屏幕贴合、愿签/地图/落版叠层、字幕、节拍冲击、特效箱用法
- [references/production-rules.md](references/production-rules.md)：授权与版权、密钥、额度、剧本差异、交付说明模板
- [references/qc.md](references/qc.md)：逐阶段检查清单
- [scripts/media.mjs](scripts/media.mjs)：媒体 API 客户端（读 `.env`，请求登记，可续取）
- [scripts/clip-scene.ts](scripts/clip-scene.ts)：AI 视频镜头场景模板（帧序列 + 关键帧兜底 + 字幕）

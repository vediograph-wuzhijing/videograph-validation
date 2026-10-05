# STAB-01 稳定化交接（2026-10-05）

分支 `fix/stab-01`（从 `test/collaboration` @ `73e783f` 切出），**全部改动尚未提交**，57 个文件。
起因：2026-10-05 全面审计（5 个模块并行只读审查），用户要求修 P0/P1/P2，并报告两个使用问题：
① 在终端让 LLM "改某处"，它会新建工程；② 只改一段却全片重渲。

## 当前验证状态（2026-10-05 实测，未提交工作区）

| 检查 | 结果 |
|---|---|
| `npm run build` | ✅ 通过；主包 299KB（原 502KB），StructureView/EffectsBox 已懒加载，无 >500KB 警告 |
| `node --test $(find scripts -name '*.test.mjs' -o -name '*-test.mjs')` | ✅ 184/184（原 167，新增 17） |
| `analyzer/clicktrack_test.py`（videograph-analyzer 环境） | ✅ 128 拍、下拍 32/32 |
| `scripts/tests/collaboration/feedback-e2e.audit.mjs`（FB-04，浏览器+GPU） | ❌ 中途跑过一次失败：`SyntaxError: Unexpected non-whitespace character after JSON at position 1480`，当时服务端改动未完成，**需重跑并排查** |
| `npm run audit`、`ui-feedback.audit`、`transition-integration-audit`、`project-view-audit` | ⬜ 未运行 |
| 真实工程增量导出（验证"改一镜只重渲一镜"） | ⬜ 未运行 |

## 已完成

### 用户报告的两个问题

**① LLM 改东西却新建工程**
- 服务端：`createProjectFromAudio` 发现同音频（字节哈希）已有工程时返回 409，错误体带 `existingProjects:[{id,name,updatedAt}]`；传 `allowDuplicate:true` 才新建（`src/server/project-store.mjs`，`ProjectError` 支持 `details`，`src/server/errors.mjs`）。
- `listProjects` 补 `updatedAt`、`audio:{name,hash(前12位)}`，坏工程跳过不再让列表整体失败。
- MCP：Server 级 `instructions`（先 `project_list` 复用、只有用户明确要求才新建、沿用 projectId）；create 工具描述与 `allowDuplicate` 参数；409 时把 `existingProjects` 交给 LLM（`src/pdoom/mcp-server.ts`、`src/server/mcp-tools.ts`）。
- 技能 `videograph-aigc-film`：工程 id 存 `project-id.txt` 复用。

**② 改一段全片重渲** — 根因有两层：
1. *流程*：AIGC 片（安康/长安等 pipeline）把**一份共享场景源码**提交给所有镜头；`build` 不带镜头列表时全量重提交 → 每镜 codeHash 变 → 全部未命中。本机记录佐证：香水广告两次导出 6/6 镜 codeHash 全变、0 命中。已在 MCP instructions、`project_shot_submit` 描述、MCP-GUIDE §2/§5、shotcraft、videograph-aigc-film 写明：只对目标镜头 `build s07,s12`；优先改 params/后期栈；不要把共享文件重提交给所有镜头。
2. *缓存键*：`hostHash` 原来对 `reference-server.mjs` 等 4 个**整文件**哈希，改这些文件任何无关代码都会全片失效。已收窄为只哈希注入渲染页的运行时代码 + `HOST_PATCH_VERSION`（改引擎补丁逻辑时手动升版本）。镜头素材（`engine/app/public/**` 下以镜头 id 命名的目录/文件，按路径+大小+mtime）进该镜缓存键 → 改某镜素材只失效那一镜（`src/server/render-cache.mjs`、`render-worker.mjs`）。
- 可观测：导出 `job.result.cacheSummary:{reused,rendered,reasons}`，未命中 report 带 `missReason: string[]`（`new/engine/host/browser/code/dependency/shot/assets/fps/samples/encoder/scope/artifact`），记录在 `artifacts/cache-index.json`。前端任务行显示复用/重渲数。
- ⚠️ 缓存键组成变了：**现有工程升级后第一次导出会全部重渲**（`missReason: new`），之后才按镜头命中。

### 渲染管线（Fork B，已完成）
- 所有 `page.evaluate` 加超时（单帧 2s × 帧数，下限 60s，`VIDEOGRAPH_EVAL_TIMEOUT_MS`），场景死循环不再卡死队列。
- 静帧/AE/缩略图/meta 原子写；分段 tmp mp4 失败时清理；Windows rename EPERM/EBUSY 重试。
- 端口冲突根治：去掉 `reservePort`，Vite middlewareMode 挂在自己 `listen(0)` 的 HTTP 上；listen 失败也 close；每实例独立 `cacheDir`，close 时删除。
- `startReferenceServer` 返回 `{url, close(async), healthy()}`（`healthy()` 供 BUG-04 探活）。
- CSP 收窄：不再放行 `ws://127.0.0.1:*`，只放行帧 socket 端口。
- 导出前断言首镜从 0、首尾相接、`doneFrames===total`；缓存/新渲帧数公式统一。
- fetcher：逐文件容错、账本 finally 写并合并、限字节、校验重定向主机；`withFxBrowser` 整体超时；`audioFile` 禁 `..`。

### MCP / 文档 / 技能（Fork C，已完成）
- 去掉 `locked` 参数（AI 不能改锁），`song_analysis_patch`/`project_director_submit` 固定 `author:'mcp'`，`project_transition_update` 带 `author`+`attemptToken`。
- 4 份 HTTP 客户端合并为 `serviceFetch`（`mcp-feedback-tools.ts` 导出）：带 HTTP 状态码、409 提示重读、ECONNREFUSED 原因、token 缺失提示路径。
- AE 等待总预算 ≤55s；图片嵌入总量 ≤4MB，超出返回路径，新增 `embedImages`。
- FX 错误只在网络类时附 GitHub 提示；prompts 校验必填参数。
- MCP server 0.7.0；MCP-GUIDE 修正（转场 effect 模式、configure 参数、`<repo>` 占位等）；shotcraft 1.4.0 并 sync；`mcp-guide-sync` 测试加强（双向工具比对、版本一致、禁止 locked/author:'human'、无工具指向 accept/reject 路由、卫生扫描覆盖 `.agents/skills`）。
- `media.mjs`：`.env` 按首个 `=` 解析、无任务 id 报错、轮询 30 分钟上限、下载检查 `res.ok`+超时；`clip-scene.ts` 缺帧报文件名。README 数字核实（51 工具，特效箱 245 原创 + 125）。

### 分析器 / 歌曲 / 测试卫生（Fork E，已完成）
- 歌词对齐失败的行内插兜底（conf 0.3，`fallbackLines`）、行首单调；契约允许空 onsets 通道。
- 静音/零 flux 不再出 NaN（`allow_nan=False`）；无节拍退到 120BPM 固定网格（置信 0.1，标注 fallback）。
- `analyzer-runner`：超时（`VIDEOGRAPH_ANALYZER_TIMEOUT_MS`，默认 30 分钟，Windows `taskkill /T /F`）、`PYTHONUTF8`、utf8 解码；导出 `killAll()`；解释器按 环境变量→conda 推断→作者机旧路径→PATH 查找。
- `download_models.py` 失败 `sys.exit(1)`；`doctor.py` 统一 models_root、sm120 判断修正；beat_this 优先本地权重；FFMPEG_PATH 支持。
- planner：`lineIndex` / `lineText+occurrence`，重复歌词未指定报错；零长度镜头拒绝。段配额最大余数法；短段合并保证覆盖全曲。
- 测试：`freePort()` 替换随机/固定端口；pdoom 依赖用例加 skip；`audit-all` 参考工程 ID 可配（`VIDEOGRAPH_AUDIT_REFERENCE`）。

### 服务核心（Fork A，**只完成一部分**，被中断）
已落地（`project-store.mjs`、`errors.mjs`）：
- 重复建工程 409 守卫、`listProjects` 坏工程跳过 + 新字段。
- `mutateProject` 只在 BEGIN 成功后 ROLLBACK，保留原始错误。
- revisions 只保留最近 200 条（revision 0 保留）。
- `initProjectDb`（`IF NOT EXISTS` + `PRAGMA user_version=1`）、导出 `hashTree`。
- 拒绝候选/修改前快照补 `effects`/`effect`（审计 P0 #6）。

### 前端（Fork D，**大部分完成**，被中断）
已落地（build 通过）：FeedbackComposer 加 key（P0：草稿不再串到别的镜头）、ErrorBoundary、TransitionInspector 去 `!`、懒加载拆包、EffectsBox 缩略图复用上下文、轮询错误分离、api.ts 超时/非 JSON 处理/类型补全、ReviewCompare 按 inputToken 重置、vite `strictPort`、cacheSummary 显示等。**未逐项核对**，接手时用 `git diff -- src/project src/main.tsx` 对照下方清单。

## 待完成（按优先级）

### 必须先做（阻塞提交）
1. **服务核心剩余项**（全在 `src/server/index.mjs`、`analysis-jobs.mjs`、`director.mjs`、`song-project.mjs`、`transitions.mjs`/`project-store.mjs` 的 `updateTransition`、`brand/*`；都没改）：
   - P0：`analysis-jobs.mjs:12` `void next(run)` 加 `.catch`，首尾 `saveJob` 进 try；`index.mjs:194` `createReadStream().pipe` 改 `stream.pipeline`；渲染子进程 close 回调 try/finally 保证 `active=null; pump()`；`pump` 加无进度看门狗（`VIDEOGRAPH_JOB_STALL_MS`，默认 10 分钟）；`index.mjs` 预览合并 `reviewBaseline` 处确认带上 effects。
   - P1 **令牌拆分**：现在 studio 与 MCP 共用一个 token，`/session` 只看 Origin，`author` 取自请求体，**AI 绕过 MCP 直接调 HTTP 仍能 accept/解锁**。拆为 mcpToken（`.cache/service-token`）与 studioToken（仅 `/session` 下发）；actor 由 token 推导；accept-feedback / reject-feedback / accept-review / 人回复 / `locked:false` 只允许 studio。需同步改 `scripts/tests/feedback/feedback-http.test.mjs`、`director/director-mcp.test.mjs`、`collaboration/feedback-e2e.audit.mjs` 等拿 studio 令牌的方式（`/session` + 合法 Origin）。
   - P1：`updateTransition` 加 `author`/`attemptToken` 并走 `trackDirectorCommit`（MCP 已在发这两个字段，服务端目前忽略）。
   - P1：`submitPlan`、`acceptDirectorReview` 强制整数版本号；`confirmSongAnalysis`/`retryAnalysis` 接受并校验 `expectedRevision`（前端 D 按此字段名传）。
   - P1：`song-project.mjs` `submitSongLyrics`/`patchSongAnalysis` 先校验版本再写文件，409 不留被拒内容；`index.mjs` 启动恢复 queued 按 `createdAt` 升序。
   - BUG-03：`/health` 返回 `bootTime`、`srcMtime`，去掉 `projectsRoot`。BUG-04 服务侧：`previews` Map 存 Promise 单飞、复用前 `healthy()` 探活、close 后立即 delete。
   - shutdown 调用 `killAll()`（`src/song/analyzer-runner.mjs`），取消前判 `child.connected`，退出超时 kill。
   - `song-project.mjs` 改用 `project-store` 导出的 `initProjectDb`/`hashTree`（目前仍是复制的一份）。
   - P2：`body()` 要求普通对象、`decodeURIComponent` 失败 400、非 ProjectError 500 只回通用文案；分析失败写回失败加重试计数/退避；brand 先写库再删 blob、`validation.mjs:28` `&&`→`||`；删 `director.mjs` 未用的 `terminal`；上传音频流式写临时文件。
   - 回归测试：快照回滚 effects、mcp 令牌不能 accept/解锁、缺版本号 400、重复建工程 409/allowDuplicate、`/health` 有 bootTime。
2. **重跑 FB-04**（`node --test scripts/tests/collaboration/feedback-e2e.audit.mjs`），排查 JSON 解析错误（疑为 helpers 解析多段输出），以及 `npm run audit`、`ui-feedback.audit`、`transition-integration-audit`。
3. **前端核对**：确认这些已完成或补上：reply 失败提示与防连点、EffectsBox suggest 防重复与快照 shotId、addFeedback 后不覆盖高级表单草稿、意见 revision 过期的"基于最新版本提交"、接受审片后立即刷新 /director、iframe `sandbox`、`projectFile` 逐段编码、AnalysisCorrector 是否挂载、时间线播放头/跳转锚点、inputToken 变化不强关预览、弹窗 role=dialog/Esc、confirm/retry 传 `expectedRevision`。注意前端改完后需与第 1 步的版本号强制一起联调。
4. **真实增量导出验收**：选一个已有 AIGC 工程，导出两次（第一次会因缓存键变更全量 `new`），只改一镜再导出，确认 `cacheSummary.rendered === 1`、`missReason` 正确。

### 之后
5. 更新 `ROADMAP.md`：0.5.0/47 工具 → 0.7.0/51；BUG-03/04 状态；登记 STAB-01 工作包与本文件。
6. 按工作包拆成小提交（渲染 / MCP+文档 / 分析器 / 服务 / 前端），合并前跑全量。

### 未做且有意跳过
- 段落边界 `p+4` 偏移：无标注数据，无法验证改善，未改。
- envelopes 帧数与时长一致性检查：会打破 `director/song-operations.test.mjs` 夹具，已撤回。
- `clip-scene.ts` 长镜头滑动窗口解码：只加了内存注释。
- `beat_this` 在 py3.9 环境报 `type | None` 不兼容，原本就退回 librosa，与本次无关。
- 浏览器版本保留在缓存键里（可复现性）；浏览器升级会全片重渲，`missReason` 显示 `browser`。

## 注意事项
- `.cache/reference-vite/` 下若有残留实例目录（进程被强杀时），可手动删除。
- 很重的 1080p 场景单帧超过 2s 时，调大 `VIDEOGRAPH_EVAL_TIMEOUT_MS`。
- `_pr2-fix` 工作树（`fix/pr2-followup`）已合入 main，可 `git worktree remove ../_pr2-fix`。
- 外部 pipeline（`../ankang/pipeline.mjs` 等）写死 `F:/aicg` 路径并共享一份源码；它们不在本仓库，未改，按技能新约定使用 `build <镜头列表>`。

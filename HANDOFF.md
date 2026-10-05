# VideoGraph 交接文档（video-graph-demo）

> **最新：2026-10-05 稳定化（STAB-01，分支 `fix/stab-01`，未提交）交接见 [docs/STAB-01-HANDOFF.md](docs/STAB-01-HANDOFF.md)。** 以下为 2026-09-29 的历史说明。

> 写给下一个接手的 AI。用户是中文创作者，协作方式是"你实现 → 自动化验收 → 他看效果给反馈"。
> 本文档截至 2026-09-29 晚，对应工坊版本：多卡规划 + MCP 队列全部落地，验收全绿。

## 1. 这个项目是什么

**一句话**：把 ComfyUI 的"节点连线 + 缓存复用"工作方式，和 [pdoom-video](../pdoom-video)（一支纯代码渲染的 MV，MIT 开源）的"每个镜头是歌曲时间 t 的确定性函数"工程方式组合起来，做一个 **AI 规划、人可干预、逐段渲染的 MV 生产工作台**。

核心工作流（用户定的蓝图，已经实现到第 3 步）：

```
① AI 听全曲分析数据 → 规划出整支片的「镜头卡片带」（每镜头一张卡，含时间窗+提示词）
② 人改任意卡的提示词（或让 AI 改）→ 卡片转「待重算」
③ AI 按卡片提示词写场景代码（draw(ctx, f, api) 纯函数）→ 编译 → 静帧缩略图 → 有声播放 → 导出该段 WebM
④ （未做）离线分段 mp4 导出 + 全片合成
```

设计哲学：**卡片 = 节点 = 有缓存的确定性计算**。改一张卡的提示词只重算一张卡，其余命中缓存。

## 2. 周边工程地图（F:\aicg）

| 目录 | 是什么 | 与本项目关系 |
|---|---|---|
| `video-graph-demo/` | **本项目**。React 19 + @xyflow/react 12 + sucrase，端口 5188 | — |
| `pdoom-video/` | 参考 + 数据源。它的 `data/*.json` 是本项目 full-song.json 的上游；`docs/TREATMENT.md`（风格圣经）、`docs/ENGINE.md`（引擎设计）值得读 | 只读，别改 |
| `world-execute-pv/` | 用户另一个已完成的 Remotion PV 项目 | 无关，别动 |
| `flowvid/` | **已废弃**（用户明确说过不要再碰） | 别动 |
| `ComfyUI/` | 用户下载的 ComfyUI 源码参考 | 只读 |

## 3. 怎么跑

```sh
cd F:\aicg\video-graph-demo
npm run dev            # http://localhost:5188  （?view=shot 直达工坊；?view=pdoom|legacy 其他模式）
npm run build          # tsc -b && vite build
npm run mcp:pdoom      # 启动 MCP stdio server（11 个工具，见 §6）
```

验收（无头 Edge，路径写死在脚本里；每个脚本自证全绿才许交付）：

```sh
node scripts/shot-mcp-audit.mjs    # MCP 队列端到端：入队→(脚本扮演agent)提交→消费→热合并→清理
node scripts/shot-demo-audit.mjs   # 内置路径：参考规划→本地模板生成→dock预览→改提示词
node scripts/mcp-server-test.mjs   # MCP server stdio 协议手测（工具注册/提交写回/非法id拒绝）
node scripts/pdoom-audit.mjs       # P(DOOM) 教学模式回归
node scripts/creative-audit.mjs    # 创意工作区回归
```

**vite.config.ts 改动后必须重启 dev server**（netstat -ano | grep 5188 找 PID → taskkill //F //PID xxx → npm run dev）。这是本项目第一大坑。

## 4. 四个工作模式（顶栏切换）

1. **单镜头工坊**（`?view=shot`）——主战场，其余是演示/教学
2. 创意工作区（LLM 创意→素材→镜头，demo 级）
3. P(DOOM) 教学（11 算子管线示意 + 黑板演示）
4. 镜头 Demo（最早的旧视图）

## 5. 工坊架构（src/shot/）

```
full-song.json   全曲分析数据（204KB）：46行词级歌词/14段落/345beats/87downbeats/kick·snare/30fps六路包络
   │             （由 pdoom-video 的 data/lyrics.json + audio.json 用 python 切出）
engine.ts        契约层。makeFrame(song, window, t, W, H) / makeApi(song, window)；
   │             cutAtLine/afterLine 复刻 pdoom timeline 切点（锚定歌词行首词→吸附之前最近beat）
planner.ts       规划器。builtinPlan()=REFERENCE_PLAN 22条（pdoom真实剪辑+TREATMENT中文压缩提示词）；
   │             llmPlan()=全曲数据+概念→LLM→parsePlanResponse()容错解析（锚定行模糊匹配→秒）
codegen.ts       代码生成。ENGINE_CONTRACT（注入LLM的API文档）+ buildShotMessages() + generateShotScene()
builtinScenes.ts 无LLM时的本地模板：按 hash(id+prompt) 从6种motif(curve/rings/grid/particles/bars/typo)
   │             生成差异化场景，全部含逐词卡拉OK
runtime.ts       沙箱与渲染。makeShotCtx(window)；compileShotScene(sucrase转译，禁外部import)；
   │             renderStill / ShotPlayer(audio.currentTime时基) / exportShotClip(MediaRecorder WebM)；
   │             lintShotCode(静态禁 Math.random/Date.now/fetch/import)
shotNodes.tsx    节点组件：song-context×2、plan-director（规划器）、plan-card（280px紧凑卡）
ShotWorkshop.tsx 工坊主体：卡片带、批量生成、底部dock预览（ReactFlow <Panel>）、MCP轮询器
queue.ts         MCP队列文件协议（node端共享）
```

**场景代码契约**（场景只允许一个导出，运行时提供一切）：

```ts
export function draw(ctx: CanvasRenderingContext2D, f: Frame, api: Api): void
// f: { t 全曲秒, lt 局部秒, p 0..1, W/H 画布, audio{6路包络+beat/downbeat脉冲+beatPhase},
//      lyric.lines 窗口内词级行 }
// api: { palette(墨黑#0A0A0B/骨白#EEE9DF/信号橙#FF4D12 等9色), ease, rng(mulberry32),
//        wordProgress(卡拉OK唯一时间来源), lineCharProgress, pulse, beat/kick/snareEvents }
```

铁律：每帧是 t 的纯函数；卡拉OK未唱30%骨白/正在唱signal橙/唱完bone，绝不跑在人声前；大变化落拍上；布局用 W/H 比例绝不硬编码像素。

**三条生成路径**（generateOne 按 provider 有无自动选择）：
- 有 LLM provider → 直连 API（走 `/llm-proxy`，cachedChat 精确缓存）
- 无 provider → **MCP 队列**（见 §6，等 ZCode agent 生成）
- 兜底 → 「本地模板生成（不等待）」按钮，内置 motif 即时出图

## 6. MCP 队列（"用 MCP 代替 API"，本项目最新特性）

```
浏览器 ──HTTP──> vite 中间件(/queue/*) ──fs──> .queue/ 目录 <──fs── MCP 工具 <──stdio── ZCode agent
```

- `req-<id>.json`：前端写入的请求 `{id, kind:'plan'|'codegen', cardId?, prompt:{system,user}}`（prompt 与直连 API 完全一致）
- `res-<id>.json`：agent 的答案 `{status:'done'|'error', content, model}`；前端 2.5s 轮询取走后 ack 删文件
- `cards.json`：卡片带快照。前端 cards 变化 800ms debounce 保存；agent 改某卡 prompt 后前端每 10s 检查热合并（卡转"待重算"，dock 同步）

vite 中间件：`POST /queue/request`、`GET /queue/poll?ids=`、`POST /queue/ack`、`GET /queue/list`、`GET/POST /queue/state`。

MCP 工具（`npm run mcp:pdoom`，共 11 个）：
- `shot_queue_list / shot_queue_get(id) / shot_queue_submit(id, content) / shot_queue_reject(id, reason)`
- `shot_cards_read / shot_cards_update_prompt(cardId, prompt)`
- 原有：`pdoom_inspect_project / pdoom_run_analysis / pdoom_render / pdoom_blackboard_contract / lyric_research_draft`

**content 格式约定**：plan 请求 = JSON 数组文本（每元素 `{id,title,anchorLine,endLine?,prompt}`）；codegen 请求 = ` ```ts ` 代码块 + 一行 `SUMMARY: <一句话>`。前端用 parsePlanResponse / parseSceneResponse 消费。

**agent 侧用法**（下一个你就是这个 agent）：用户说"处理队列"→ `shot_queue_list` → 逐个 `shot_queue_get` 读提示词 → 你自己生成（plan 按 schema 出 JSON；codegen 按引擎契约写 draw）→ 提交前自查（纯函数、无 import、能 JSON.parse）→ `shot_queue_submit`。前端约 2.5s 内取走。

注意：**MCP 工具集是会话启动时加载的**——改了 mcp-server.ts 后用户需要重连 MCP 才生效。

## 7. 关键坑（血泪，都踩过）

1. **vite.config.ts 变更必须重启 dev server**（新中间件不热载）。
2. **Windows 杀 Vite**：TaskStop 不可靠，用 `netstat -ano | grep 5188` + `taskkill //F //PID`。
3. **React 内联函数 ref 每次 render 先后收到 (null, el)**：registerCanvas(null) 里销毁播放器=自杀（playing 状态刷新→播放器被 dispose）。置空只清引用，清理交给卸载 effect。
4. **useBlackboard/useMemory/useProviders 是每组件实例的 hook**：子视图要用父级同一实例必须 props 传（ShotWorkshop 的三个 props）。
5. **React Flow 12 节点 data 必须兼容 Record<string, unknown>**：用 `type X = {...}` 别名，别用 interface（无隐式索引签名）。
6. **黑板 publish 按 type 去重**（每类型只留一条）：多卡产物必须聚合发布，逐条发布会互相覆盖只剩最后一条。
7. **中文 prompt 字符串里的英文撇号**（don't/singularity's）在单引号 TS 字符串里必须转义——写完扫一遍再 build。
8. **场景代码运行错误会被 try/catch 静默吞掉变成黑帧**：renderStill 返回 error 字段必须显式检查（现在生成时抛错卡片标 error）。曾因 motif 模板引用未定义变量导致 22 张卡全黑。
9. **canvas 全黑不一定是没画**：墨黑底像素和只有 31/765，先确认采样阈值，再查场景代码是否抛错。
10. **MCP server 的队列目录**用 `resolve(process.cwd(), '.queue')`（server 由 npm run mcp:pdoom 在项目根启动）；`root` 变量是 pdoom-video 的路径，别拿它拼。
11. **外部改 cards.json 有覆盖竞态**：前端 debounce 保存可能覆盖注入（真实场景安全；自动化测试必须等最终快照 rev>=1 落盘再注入）。
12. **本环境 Read 图片只回 CDN 链接**：截图先 PIL 缩小再 Read，仍被传 CDN 时用 `mcp__4_5v_mcp__analyze_image(远程URL)` 做视觉验收（OCR 有噪声，DOM 断言优先）。
13. 验收脚本跑无头 Edge：`executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'`。

## 8. 设计决策记录（为什么这样做）

- **场景代码只给 Canvas 2D 契约**（不给 three.js）：sucrase 沙箱 + Canvas2D 是零依赖最小可行；Three.js 场景类契约是 M3 计划。现有旧 Demo（`src/render/preview.ts`）有 three-webgl 沙箱可参考。
- **文件队列而非让 MCP server 起端口**：vite 中间件天然在 dev server 里、MCP 天然读文件系统，两侧零新增进程；协议就是一个目录三个文件。
- **批量 LLM 生成串行**：限流友好；MCP 批量则全部入队并行等 agent。
- **内置参考规划复刻 pdoom 真实剪辑**：22 窗口不是拍脑袋——切点逻辑（cutAtLine）与 pdoom timeline.ts 一致，提示词是其 TREATMENT.md 逐 plate 的中文压缩。这让"没配任何 LLM"的首次体验就是一支结构真实的 MV 规划。
- **段落导出用 MediaRecorder WebM**：浏览器内最小可行"单段渲染"；工程化离线导出（headless Chrome→ffmpeg，pdoom 的 app/scripts/render.ts 是完整范例）是 M4。

## 9. 下一步 roadmap（用户认可的方向，按优先级）

- **M3 真引擎契约**：Three.js 场景类（constructor({width,height,seed}) + render(f) + get object()），参考 pdoom ENGINE.md 和本项目 `src/render/preview.ts`；GLSL pass、后期（bloom/halation/grain）按需渐进。
- **M3.5 自动验证闭环**：LLM 生成代码若编译/运行失败，把错误回喂自动重试（目前失败只标错卡片）。这是质量跃升点。
- **M4 离线分段导出**：headless Chrome + ffmpeg（playwright-core 已在依赖里），按卡片窗口渲染 mp4 段 + 无损拼接；缓存 key = hash(场景代码+窗口+参数+引擎版本)——黑板 exact 策略已就绪。
- **MCP 卡片操作扩展**：重规划单卡、拆卡/合卡、改窗口（现在只有改提示词）。
- 多歌曲支持（full-song.json 参数化，换歌=换数据文件+mp3）。
- 卡片带 UX：拖动调窗口边界、分幕折叠分组。

## 10. 用户协作习惯（重要）

- 全程中文。**co-creation**：每个可验收的闭环做完就交付（build 过 + 自动化脚本全绿 + 浏览器打开给他看），他看效果给反馈，不喜欢就推翻重来。
- 诚实边界：跑不了的东西明说（比如当前 shell 缺 uv/bun/Chrome，真实 pdoom render 跑不了），绝不伪造成功。demo 和真实要标注清楚。
- 他喜欢"工程化让人能参与"：人的编辑点（提示词、时间窗、锁定）是一等公民。
- 验收脚本更新后要同步跑全量回归（五个 audit），别只跑新的。
- 持久记忆里有本项目完整历史（`video-graph-demo-project.md`），接手前先读。

## 11. 快速上手检查清单（新会话第一天）

1. `npm run dev` 起服务，curl `http://127.0.0.1:5188/queue/list` 确认中间件活着
2. 跑五个验收脚本确认全绿（基线）
3. 读 pdoom-video 的 TREATMENT.md / ENGINE.md 补美学与引擎背景
4. 改动前先看 §7 的坑，改 vite.config 后记得重启 dev server
5. 交付前：build 过 + 相关 audit 绿 + 浏览器打开给用户看

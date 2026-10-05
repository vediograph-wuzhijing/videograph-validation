# VideoGraph - 无止境

2026 xihack 大赛参赛项目 · 软件赛道。

本仓库的全部示例影片由本工具自动生成，见 **[video/](video/)** 目录（点击 mp4 可直接在线播放）。

| 影片 | 说明 | 时长 / 规模 | 文件 |
| --- | --- | --- | --- |
| THE LAST AUDIT · 独立创作 PV | AI 导演闭环实战：LLM 自主规划、写镜、自查、返修的原创 PV | 2′37″ / 22 镜 | [video/the-last-audit-pv.mp4](video/the-last-audit-pv.mp4) |
| 拾愿长安 · 开篇宣传片 | 外部 AI 素材（生图→图生视频→配音）+ 本引擎合成的电影化短片 | 2′37″ / 21 镜 | [video/shiyuan-changan-pv.mp4](video/shiyuan-changan-pv.mp4) |
| 西安 · 28 种艺术风格（长安三千年） | 一首歌遍历 28 种艺术风格的镜头合集 | 3′03″ / 30 镜 | [video/changan-art-styles.mp4](video/changan-art-styles.mp4) |
| FX BOX 特效箱展示片 | 用特效箱动效（制作时 330 个）串成的 60 镜展示片 | 4′00″ / 60 镜 | [video/fxbox-showreel.mp4](video/fxbox-showreel.mp4) |
| Sella 平台宣传片 · EN/FR 双语 | 商业宣传片：买菜 App 双语产品介绍 | 1′00″ / 14 镜 | [video/sella-promo-enfr.mp4](video/sella-promo-enfr.mp4) |
| ORÉLIA 香水广告 15 秒 | 虚构品牌商业广告，含原创配乐 | 0′15″ / 6 镜 | [video/orelia-15s.mp4](video/orelia-15s.mp4) |
| VideoGraph 宣传片 20s / 60s | 用本工具为自身制作的宣传片 | 0′20″ + 1′00″ | [20s](video/videograph-promo-20s.mp4) / [60s](video/videograph-promo-60s.mp4) |

以上影片的原始工程（1080p30 导出，含全部镜头源码、节奏与歌词方案）保存在本机 `projects/`，`video/` 为评审用压缩版。影片中的歌曲、歌词与字体权利归各自权利人，仅作演示；边界见 [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)。

---

VideoGraph 是面向产品宣发与音乐人 PV 的本地 AI 视频工程工作台——**LLM 的 After Effects**：LLM 经 MCP 建工程、分析音乐、规划镜头、写镜头代码、调节奏，并用节奏/画面感知工具自查；前端「审阅室」供人看片、定位意见、对比采用。工程可复现，支持镜头级局部修改与分段渲染缓存。

![审阅室](docs/review-room.png)

**已验证的关键数字**（出处与核对记录见 [ROADMAP.md](ROADMAP.md)）：

- **51 个 MCP 工具**（server `videograph` 0.7.0，工具表见 [docs/MCP-GUIDE.md](docs/MCP-GUIDE.md)，有文档同步测试保证不过期）。
- **特效箱 370 个动效**：245 个本项目原创 GLSL（`effects/box/`，逐文件记录 provenance）+ gl-transitions 125 个转场。
- **AI 导演闭环实跑两轮**（《THE LAST AUDIT》）：方案 → 下一步 → 租约/回执 → 证据化自评 → 人工接受。
- **22/22 分段缓存命中**（P(doom) 参考工程 22 镜 1080p 全片重导出）；宣传片 4 倍采样全片导出 6′17″ / 2′14″（本机实测）。
- **节奏报告**对参考片校准，宣传片实测节拍命中率 79% / 89% / 100%。
- 领域与契约测试 **161/161 通过**，`npm run build` 全绿。

## 快速运行

```sh
npm ci
npm run service       # 本地工程服务：http://127.0.0.1:5191
npm run dev           # 审阅室界面：http://127.0.0.1:5188/?view=project
npm run mcp           # MCP stdio 工具入口（供 Claude / GLM 等 LLM 连接）
```

环境：Node.js 24（使用内置 `node:sqlite`）、本机 ffmpeg/ffprobe，以及一个 Chromium 内核浏览器（Windows 默认 Edge；macOS / Linux 自动探测 Edge、Chrome、Chromium，可用 `EDGE_PATH` 指定；macOS 上 WebGL 走 Metal）。先启动 service 再打开界面。让任意支持 MCP 的 LLM 连接 `npm run mcp`，从 `direct_video` prompt 或 `project_director_next` 开始建片；动效/案例/提示词库按需从上游下载，不随本仓库分发（`effects/sources.json`）。用户素材、数据库、服务令牌与导出文件保留在本机，不提交 Git。

## 教模型怎么用：技能包（Skills）

VideoGraph 的操作者是 LLM，技能包就是写给模型看的操作手册：每个技能由一份 `SKILL.md` 与若干参考文档组成（工具契约、制作规则、提示词模板、质检清单），内容是"接到什么任务 → 按什么步骤 → 调哪些 MCP 工具 → 拿什么证据自查"。模型连接 `npm run mcp` 后经 MCP resources（`videograph://skills/...`）按需读取，也可直接读仓库中的文件。

| 技能 | 教模型做什么 | 什么时候用 |
| --- | --- | --- |
| [videograph-create](.agents/skills/videograph-create/SKILL.md) | 从一首本地音频新建工程到导出 MP4 的完整流程：歌曲分析 → 镜头规划 → 逐镜写场景 → 转场 → 审片（MCP 全引擎管线） | 「用这首歌做一支 PV」 |
| [videograph-aigc-film](.agents/skills/videograph-aigc-film/SKILL.md) | 外部 AIGC 素材（生图 / 图生视频 / TTS）+ 本引擎合成电影化短片：定角色 → 关键帧 → 图生视频 → 配音 → 叠层合成 → 审片闭环 | 有分镜剧本与生图/生视频 API 时 |
| [shotcraft](skills/shotcraft/SKILL.md) | 分镜 / 转场 / 特效 / 媒介风格通用技法库，含 VideoGraph 平台篇 | 设计镜头与视觉手法时按需加载 |

给模型的启动指令只需一句话，例如：**「连接 videograph MCP，读取 videograph-create 技能，用这首歌做一支 PV」**；技能会引导模型先读 [docs/MCP-GUIDE.md](docs/MCP-GUIDE.md)（已实现工具的权威契约），再开始创作。

## 工作方式

1. **建工程**：LLM 通过 MCP 上传任意音频 → 节拍/段落/歌词分析（词级对齐）→ 确认 → 镜头规划（服务端吸附拍点、不切词）。
2. **写镜头**：每镜是一份 TypeScript Scene 源码（Three.js/GLSL），LLM 逐镜编写提交；特效箱可按需套用 240+ 动效与转场。
3. **自查**：节奏表、帧序列、全片缩略图、节奏报告（运动能量对拍）等感知工具让 LLM 看到自己的画面并返修。
4. **人工闭环**：人在审阅室给意见（可带时间锚点/画面区域/必须保留项），AI 逐条响应、人对比采用；AI 不能替人接受。
5. **导出**：分段渲染缓存，镜头级修改只重算受影响段；导出清单记录引擎哈希、音频哈希与 credits。

## 仓库导航

- [ROADMAP.md](ROADMAP.md)：唯一计划与进度文档（当前阶段、已验收项目、未完成边界、多人并行协作规则）。
- [docs/MCP-GUIDE.md](docs/MCP-GUIDE.md)：MCP 工具参考与标准创作流程。
- **教模型用本工具的技能包**（videograph-create / videograph-aigc-film / shotcraft）：见上文「教模型怎么用：技能包（Skills）」一节。
- [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)：第三方来源与许可边界。
- [docs/FX-AUTHORING.md](docs/FX-AUTHORING.md)：特效箱动效编写规范。
- [HANDOFF.md](HANDOFF.md)：运行说明与历史交接；有冲突时以 ROADMAP 为准。
- `video/`：示例影片（本工具产物）。

## 检查

```sh
npm run build
node --test scripts/project-store-test.mjs scripts/lyrics-transitions-test.mjs   # 轻量领域测试，不启动服务或浏览器
node --test scripts/tests/brand scripts/tests/collaboration scripts/tests/docs scripts/tests/feedback   # 领域套件
npm run audit                              # 工程工作台浏览器验收；需先启动 service 和 dev
npm run audit:reference                    # 真实引擎验收；需只读参考目录
```

## Git 边界

跟踪：`src/`、`scripts/`、`examples/`、`effects/`、`skills/`、`docs/`、`video/`（示例影片）、依赖锁、构建配置与文档。

忽略：`node_modules/`、`dist/`、`.cache/`、`.queue/`、`projects/`、数据库、服务令牌、`.env*`、本机音频（`*.mp3`）与生成的验收图。

- `projects/` 中的工程版本由 SQLite 与不可变源码管理，**不等于已有 Git 备份**；重要工程应另做一致性备份。
- 不提交 API key、用户 BGM 源文件、字体副本或参考仓库的大文件。

## 来源与权利

参考引擎：`pdoom-video`（MIT）；字体、歌曲与歌词保留各自权利。详见 [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)。参考代码的 MIT 许可不覆盖歌曲/歌词。工程导入保留原始许可证与署名；独立创作示例的视觉代码和复用的引擎/音乐数据分别标记，详情见工程导出清单与 `engine/CREDITS.md`。

## 许可证

本仓库代码与文档以 [GNU GPL v3](LICENSE)（SPDX: `GPL-3.0-only`）发布，版权所有 © 2026 G1en-114。原始项目（原链）：<https://github.com/G1en-114/videograph-validation/>。

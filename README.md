# VideoGraph - 无止境

**LLM 的 After Effects**：面向产品宣传片与音乐人 PV 的本地 AI 视频工程工作台。AI 通过 MCP 建工程、分析歌曲、规划分镜、编写场景和自查；人在审阅室看片、提意见、比较并采用修改。

2026 xihack 大赛参赛项目 · 软件赛道。

**当前版本：0.2.0 · Windows x64 完整工作台**

[下载 Windows 工作台](https://github.com/vediograph-wuzhijing/videograph-validation/releases/download/v0.2.0/VideoGraph-0.2.0-windows-x64.zip) · [发行说明](https://github.com/vediograph-wuzhijing/videograph-validation/releases/tag/v0.2.0) · [校验文件](https://github.com/vediograph-wuzhijing/videograph-validation/releases/download/v0.2.0/VideoGraph-0.2.0-windows-x64.zip.sha256) · [文档中心](docs/README.md)

![审阅室](docs/review-room.png)

工程保存源码、素材、时间轴、意见和版本，支持镜头级修改与分段渲染缓存。审阅室图片为界面示例。

## 0.2.0 的核心改进

| 重点 | 本版能力 |
|---|---|
| 大工程稳定性 | 大任务记录外置、修订数据去重、任务摘要分页；重操作移出 HTTP 主线程，轻量版本轮询与服务状态诊断 |
| 连续画面自查 | filmstrip 返回带时间、拍点和歌词的连续帧拼图；支持约 2 秒 12 帧的局部检查，导演流程要求当前版本动态证据 |
| 快速迭代 | 未提交源码可做类型/初始化着色器检查、静帧和播放预览，不产生任务或修订；共享场景模块一次提交、多镜引用 |
| 引擎基础件 | 相机、世界卡片与投影，天空/海面/水下环境，逐字素动画、独立图层与选择性后期；可通过 MCP 检索 |
| 意见直达 AI | 按工程或镜头读取意见、锚点和保留项；AI 逐条回应，人比较采用，保留人工权限与版本保护 |

另外支持外部节拍、段落和歌词真值输入，以及按明确策略允许长音持续段切点。完整功能与边界见[本版说明](docs/releases/0.2.0.md)。

## Windows 下载与启动

1. 下载上方 ZIP 和 SHA-256 校验文件，核对校验值后解压到可写目录。
2. 运行 `Doctor.cmd` 检查环境；将 `workbench.example.json` 复制为 `workbench.json`，按[运行手册](docs/OPERATIONS.md#windows-02-工作台与分发)配置工具路径和端口。
3. 运行 `Start-Workbench.cmd`。默认审阅室地址为 <http://127.0.0.1:5188/?view=project>，HTTP 服务为 `127.0.0.1:5191`。
4. AI 客户端使用安装目录的 `MCP.cmd` 作为 stdio 入口；空闲时用 `Stop-Workbench.cmd` 正常停止工作台。

发行包包含 Node、离线 npm 依赖、审阅室、HTTP、65 项 MCP 工具、视频引擎、许可字体、分析适配和源码，无需另装 Node 或执行 `npm ci`。

渲染需要外部 **FFmpeg/ffprobe 与 Edge/Chromium**。自动歌曲分析另需 Python 和模型；这些配置与检查方法统一见[运行手册](docs/OPERATIONS.md)及[分析器环境](analyzer/environment.md)。已有节拍/歌词真值时可跳过模型分析。

## 让 AI 操作工程

先启动工作台，再由 AI 客户端拉起 MCP。连接参数、工具契约与错误处理见 [MCP 使用指南](docs/MCP-GUIDE.md)。未接 MCP 时，Windows 包也提供 `HTTP-Tools.cmd tools` 查看工具，`HTTP-Tools.cmd call <工具名> args.json` 调用。

仓库内置[制作与恢复技能](.agents/skills/videograph-create/SKILL.md)和 [shotcraft 技法库](skills/shotcraft/SKILL.md)，MCP 也暴露相应 resources。默认制作流程为：

- 开工先检索基础件、特效和转场；有参考作品先看抽帧与运动，再读实现。
- 草稿先检查和预览，只提交改变的镜头；每轮直接读审阅意见并检查连续帧。
- 导出前说明无法验证的播放、聆听等项，交给人确认；AI 自评不代替人工采用。

参考研究、混合媒介、文字 PV 配方和对拍方法见 [PV 制作流程](skills/shotcraft/references/pv-production.md)，可用 `craft_guide({topic:"pv-production"})` 读取。

## 从源码开发

需要 Node.js 24 和 npm。安装后可启动生产工作台：

```powershell
npm ci
npm run build
npm run workbench -- doctor
npm run workbench -- start
```

开发时使用两个终端分别运行 `npm run service` 和 `npm run dev`，MCP 客户端使用 `npm run mcp`。生产工作台与开发服务选择一种启动方式，端口和实例配置见[运行手册](docs/OPERATIONS.md)。

`npm run check` 执行类型、架构、文档与 portable 检查；完整媒体回归使用 `npm run check:full`，环境要求见[开发与维护](CONTRIBUTING.md)。本版验收记录随 [Release](https://github.com/vediograph-wuzhijing/videograph-validation/releases/tag/v0.2.0) 提供。

## OpenUtau 实验模块

保留 MIDI/假名或 JSON 乐谱、人声候选、外部干轨导入和测量报告等既有入口。**该模块在 0.2.0 冻结，仅修复已确认的 bug**，作为未来探索方向保留。现有模型调用效果尚不可靠，技术管线通过不代表能可靠制作歌声或听感已由人接受。

合成需要使用者自行提供合法声库与重采样器；支持边界见[歌声模块](docs/VOCAL.md)，冻结约定见 [AGENTS](AGENTS.md)。

## 文档与维护

[文档中心](docs/README.md)统一导航：[运行与排障](docs/OPERATIONS.md)、[当前架构](docs/ARCHITECTURE.md)、[存储与备份](docs/PROJECT-STORAGE.md)、[开发与维护](CONTRIBUTING.md)、[AI 协作约定](AGENTS.md)。计划、进度和剩余限制只在 [ROADMAP](ROADMAP.md) 维护。

## 来源与权利

**当前源码树和发行包不包含歌曲音源、声库、用户工程、模型权重或演示影片。** 本地素材保留，由使用者按许可自行配置；软件许可不授权再分发用户歌曲与声库。

参考引擎 `pdoom-video` 为 MIT；本版新歌工程已内置许可引擎和字体，使用者无需另行克隆参考仓库。字体、歌曲与歌词保留各自权利，导入与复用保留原始许可证和署名。逐项说明见[第三方与分发边界](docs/THIRD-PARTY.md)。

## 许可证

本仓库代码与文档以 [GNU GPL v3](LICENSE)（SPDX: `GPL-3.0-only`）发布，版权所有 © 2026 G1en-114。原始项目（原链）：<https://github.com/G1en-114/videograph-validation/>。

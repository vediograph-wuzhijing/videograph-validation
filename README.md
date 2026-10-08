# VideoGraph - 无止境

2026 xihack 大赛参赛项目 · 软件赛道。

0.2.0发布Windows完整工作台：审阅室、HTTP、MCP、视频引擎与分析适配。仓库与发行包不包含歌曲音源、声库、用户工程、模型或演示影片；这些文件保留在制作机器，由使用者按许可自行配置。

---

VideoGraph 是面向产品宣发与音乐人 PV 的本地 AI 视频工程工作台——**LLM 的 After Effects**：LLM 经 MCP 建工程、分析音乐、规划镜头、写镜头代码、调节奏，并用节奏/画面感知工具自查；前端「审阅室」供人看片、定位意见、对比采用。工程可复现，支持镜头级局部修改与分段渲染缓存。

![审阅室](docs/review-room.png)

工程内支持歌曲分析、镜头创作、特效与导演自评、人类反馈、分段缓存导出，以及 MIDI/假名或 JSON 乐谱生成人声、外部干轨候选并试听采用。已实现工具见 MCP 指南；验证结果、待完成能力与限制只维护在当前计划。

OpenUtau/歌声模块为未来探索方向，已在0.2.0冻结，仅修复已确认的bug。现有模型调用效果尚不可靠，现有入口保留；维护约定见[AGENTS](AGENTS.md)，使用边界见[歌声模块](docs/VOCAL.md)。

## 开始使用

```sh
npm ci
npm run service
```

另开终端运行 `npm run dev`，访问 `http://127.0.0.1:5188/?view=project`。AI 客户端通过 `npm run mcp` 连接本地工具。

**[打开文档中心](docs/README.md)**：运行/排障、开发检查、当前架构、MCP 工具、歌声配置、备份、AI 技能、许可和历史记录统一从这里进入。Windows 0.2完整包使用 Start-Workbench.cmd / MCP.cmd；新歌引擎已内置，外部工具配置与启动方法见运行手册。音源、声库与用户媒体不随软件包分发。

[当前计划与验收](ROADMAP.md) · [开发与维护](CONTRIBUTING.md) · [AI 协作约定](AGENTS.md)

## 来源与权利

参考引擎：`pdoom-video`（MIT）；字体、歌曲与歌词保留各自权利。详见 [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)。参考代码的 MIT 许可不覆盖歌曲/歌词。工程导入保留原始许可证与署名；独立创作示例的视觉代码和复用的引擎/音乐数据分别标记，详情见工程导出清单与 `engine/CREDITS.md`。

## 许可证

本仓库代码与文档以 [GNU GPL v3](LICENSE)（SPDX: `GPL-3.0-only`）发布，版权所有 © 2026 G1en-114。原始项目（原链）：<https://github.com/G1en-114/videograph-validation/>。

# VideoGraph 文档中心

发行说明：[VideoGraph 0.2.0](releases/0.2.0.md)。

从这里进入当前文档。运行方法、实现事实、计划进度各有一份维护来源；旧交接和审查记录放历史归档，版本号与验收数字不再复制到多个入口。

## 按任务阅读

| 我现在要做什么 | 入口 | 维护内容 |
|---|---|---|
| 启动、配置、排查本地服务 | [运行手册](OPERATIONS.md) | 环境、启动顺序、地址、独立实例与常见问题 |
| 让 AI 操作工程 | [MCP 使用指南](MCP-GUIDE.md) | 已实现工具、版本、权限、标准创作与恢复流程 |
| 制作并采用歌声（实验模块，0.2.0冻结） | [歌声模块](VOCAL.md) | 仅修复已确认的bug；声库配置、JSON 乐谱、CLI、工程接入与支持边界 |
| 修改代码、选择检查 | [开发与维护](../CONTRIBUTING.md) | 改动流程、测试/审计、CI、隔离与交付 |
| 理解代码职责 | [当前架构](ARCHITECTURE.md) | 服务、领域/存储、任务、前端与依赖边界 |
| 备份、诊断、恢复工程 | [工程存储与备份](PROJECT-STORAGE.md) | 不可变版本、一致快照 CLI、旧工程兼容 |
| 编写或收录动效 | [FX 编写指南](FX-AUTHORING.md) | 单文件动效、验收与来源规范 |
| 查下一步、认领与验收 | [当前计划](../ROADMAP.md) | 唯一计划、状态、风险、工作包和证据 |
| AI/开发者接手 | [共同协作约定](../AGENTS.md) | 修改边界、共享文件、权限、数据和文档同步 |
| 核对版权和第三方来源 | [第三方说明](THIRD-PARTY.md) | 参考引擎、代码、音频和分发边界 |

## 随模块维护的参考资料

这些文件由对应模块或 MCP 直接加载，保留原位置。主手册链接它们，不复制其具体契约。

| 模块 | 资料 |
|---|---|
| 分析器 | [Python 环境](../analyzer/environment.md)、[模型和许可](../analyzer/MODELS.md) |
| 引擎模板 | [场景分级与复用](../engine-base/SCENES.md)、[字体](../engine-base/FONTS.md) |
| AI 歌曲创作 | [videograph-create](../.agents/skills/videograph-create/SKILL.md)、[审片准则](../.agents/skills/videograph-create/references/aesthetic-review.md) |
| AIGC 短片 | [videograph-aigc-film](../.agents/skills/videograph-aigc-film/SKILL.md)、[制作参考](../.agents/skills/videograph-aigc-film/references/) |
| 通用镜头技法 | [shotcraft](../skills/shotcraft/SKILL.md)、[来源](../skills/shotcraft/SOURCES.md)、[平台说明](../skills/shotcraft/references/platform-videograph.md)、[技法参考](../skills/shotcraft/references/) |
| 示例与作品 | [宣传片提示词模板](examples/promo-prompt.md)、[项目与影片](../README.md) |

## 文档维护规则

- 操作步骤改运行/功能手册；代码职责改 ARCHITECTURE；检查流程改 CONTRIBUTING；协作规则改 AGENTS；计划和验收状态只改 ROADMAP。入口文件只导航。
- 历史审查、旧交接、原会话只归档到 [archive](archive/README.md)，注明日期和原来源。未完成需求必须登记到当前 ROADMAP，不能只留在旧文件。
- 新增当前手册须在本页登记。模块参考和技能留在源目录；不把用户工程或下载库里的 Markdown 当作项目手册搬运。
- 本地 Markdown 引用执行 `npm run check:docs`；该检查也纳入 `npm run check`/CI。MCP 工具/参数同步由已有 mcp-guide-sync 测试校验。
- [CLAUDE](../CLAUDE.md)、[HANDOFF](../HANDOFF.md)、[旧架构计划入口](ARCHITECTURE-NEXT.md) 仅保留兼容指引，不另维护说明或待办。

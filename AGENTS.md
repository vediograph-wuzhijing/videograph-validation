# VideoGraph 协作约定

本文件是开发者与 AI 的共同协作规则。开始先读 [文档中心](docs/README.md)、[ROADMAP](ROADMAP.md) 当前工作和认领，再按修改范围阅读 [CONTRIBUTING](CONTRIBUTING.md) 与 [当前架构](docs/ARCHITECTURE.md)。当前用户指令优先于默认约定。

- 全程中文。产品定位为 LLM 的 After Effects：AI 通过 MCP 操作，人在审阅室比较、提意见和采用。
- 所有计划、认领、进度和待办只更新 ROADMAP。历史文件不继续认领，不把旧“当前会话”当作在线负责人；共享接线、公共契约和依赖锁由集成者修改。
- 保护其他会话的已有改动；不通过整文件覆盖、reset --hard、force-push 或重写共享历史消除冲突。独立开发使用独立副本/分支，运行目录、工程数据库与服务凭证各自隔离。
- 不修改只读参考仓库 `../pdoom-video`、`../world-execute-pv`、`../flowvid`、`../ComfyUI`、`../ref-videos`。参考引擎作为只读输入或本项目内工程副本使用。
- 不提交缓存、队列、用户工程、令牌、密钥、声库、模型、用户音视频或 node_modules。忽略规则不是备份。显式选定的仓库演示影片按 README 的来源与许可说明维护；不要把新的用户导出当作演示资产提交。
- 保持 HTTP/MCP、修订号、inputToken、冻结任务与人工权限语义。AI 不能替人采用意见、解锁或采用人声候选；新模块遵守已登记的依赖方向。
- OpenUtau/歌声模块按用户指令冻结在0.2.0：`src/vocal/`、`src/server/vocal-*.mjs`、`src/server/mcp-vocal-tools.ts`、`src/project/VocalPanel.tsx`、`src/project/VocalImports.tsx`、`src/project/vocal.css`，以及共享入口中对应的歌声接口/导出接线，仅修复已确认的bug，不主动重构、优化、扩展功能或更换后端。修bug先记录复现与影响，做最小修复并验证回归；其他模块维护时保持现有歌声行为与接口。用户测试认为现有模型尚不能很好调用该工具，定位为未来探索方向，不将技术管线通过等同于模型可靠使用。原VOCAL-05/06扩展暂停，除非用户明确解除冻结；状态与证据见ROADMAP，支持边界见docs/VOCAL.md。
- FX 入库只收许可明确的代码（MIT/BSD/Apache-2.0/Zlib/ISC/CC0，字体 OFL），逐文件记录 provenance；无许可证只能参考技法，自行重写。第三方模型/声库/素材许可单独核对。
- MCP 名称、参数或语义变化时同步 [MCP-GUIDE](docs/MCP-GUIDE.md) 的 toolset 和相关技能；运行 sync-platform 生成工具表，shotcraft 内容变化升级版本。MCP resource URI 和技能路径是兼容接口。
- 验证使用隔离夹具，按风险执行 CONTRIBUTING 的检查；媒体写入审计不使用日常工程。区分代码完成、实际运行、人工接受；失败或未跑的检查如实记录，模板不冒充原创/真实用户验收。
- 未经用户要求不提交、推送或发布。操作前沿用会话已有授权，避免重复确认。

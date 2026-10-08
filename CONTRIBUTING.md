# 开发与维护

协作范围与数据纪律统一见 [AGENTS](AGENTS.md)，当前认领见 [ROADMAP](ROADMAP.md)，模块职责见 [当前架构](docs/ARCHITECTURE.md)。安装、启动、配置与排障只在 [运行手册](docs/OPERATIONS.md) 维护；其他资料见 [文档中心](docs/README.md)。

## 环境和检查

使用Node.js 24及npm锁文件安装依赖：

```powershell
npm ci
npm run check             # 前端/MCP类型、服务基础层类型、架构、文档引用、portable测试
npm run build             # 生产构建
npm run check:full        # 类型、架构、文档引用、全量测试、生产构建
```

完整媒体测试需要本机Chromium浏览器、ffmpeg/ffprobe及只读参考引擎；portable不依赖它们。纯类型检查可运行 `npm run typecheck`，模块边界检查可运行 `npm run check:architecture`。CI在Windows/Linux执行portable检查和构建；GPU、真实模型、声库与人工观感验证是单独的证据，不声称由CI覆盖。

`.editorconfig` 和 `.gitattributes` 约定UTF-8、LF、两空格；Python四空格。整理代码时只格式化相关模块，保留功能与审阅范围，避免把大量无关格式改动混进业务修改。

## 新增或修改功能

1. 在ROADMAP登记工作包和修改范围。共享入口、公共类型及依赖锁由集成者接线；当前用户指令优先于文件中的默认协作方式。
2. 先定义输入和版本语义，将业务命令放领域模块，HTTP/MCP仅适配。HTTP路由放 `src/server/routes/` 并在 `project-router.mjs` 注册；运行时依赖由 `service.mjs` 组装，不从入口模块反向获取全局变量。
3. 变更请求沿用 `body()` 的身份和权限校验，再由领域命令处理revision/inputToken。后台任务冻结输入，通过统一队列执行，半成品不得成为可读缓存或活动资源。
4. 前端共享类型放 `contracts.ts`，API传输放 `api.ts`；同步、预览通信和视图保持独立。避免在展示组件中复制轮询或业务闸门。
5. 为状态、事务、身份、失败恢复等高影响变更加有意义的回归。低影响文字/样式变更使用适当验证，不写只复述实现的测试。
6. 修改MCP名称、参数或语义时同步MCP-GUIDE及相关技能；类型/HTTP兼容修改同步调用方和操作文档。接口整理不要顺手改变公开行为。

## 验证隔离

测试和审计使用独立 `VIDEOGRAPH_PROJECTS`、端口和令牌文件；浏览器实例使用匹配的 `VITE_VIDEOGRAPH_SERVICE_URL` 和 `VIDEOGRAPH_STUDIO_ORIGINS`。不要在日常用户工程上跑写入型审计。双实例必须分开目录与凭证，不能复用同一个工程根目录执行写入任务。

`npm run audit:feedback` 使用独立工程验证HTTP/MCP、人回复、对比采用、冻结导出和增量缓存；UI意见审计入口为 `node scripts/tests/feedback/ui-feedback.audit.mjs`。新增审计的输入和结果放 `.cache/`，不要散落在仓库根目录。

新增服务配置集中在 `service-config.mjs` 校验，并同步示例和运行手册。重启与多实例方法遵循运行手册，不在交接文档复制 PID。

## 数据和交付

数据、参考仓库与提交边界遵循 AGENTS。不可变分析、文件与一致备份通过已有存储边界管理；Git忽略不是备份。依赖变化同步package-lock，操作命令使用跨平台Node runner。

交接注明具体改动、已跑检查、人工验收状态和剩余限制。不把模板结果当作用户工程验收，不把新增检查当作技术债全部清零。未经用户要求，不提交、推送或发布。

## 文档检查

新增手册在文档中心登记，先确定唯一维护来源，链接已有说明而非复制状态表。历史审查或会话归档注明来源日期，未完成需求留在当前 ROADMAP。

`npm run check:docs` 检查维护范围内的 Markdown 本地链接、图片、引用式链接及目标标题，跳过历史正文、代码块、外部 URL 和代码字体路径；不会联网核验第三方页面。该检查随 check/check:full 执行。MCP 工具表由 `node scripts/skills/sync-platform.mjs` 生成，参数/名称同步由 `scripts/tests/docs/mcp-guide-sync.test.mjs` 验证。

# 本地运行与排障

[文档中心](README.md) · [开发与维护](../CONTRIBUTING.md) · [MCP 使用指南](MCP-GUIDE.md)

## 环境与首次启动

需要 Node.js 24 及 npm、PATH 中的 ffmpeg/ffprobe，以及 Chromium 浏览器。Windows 默认检测 Edge；macOS/Linux 检测 Edge、Chrome、Chromium，可用 `EDGE_PATH` 指定可执行文件。歌曲分析的 Python/模型环境按 [分析器环境](../analyzer/environment.md) 单独配置；合成人声另需 [声库和重采样器](VOCAL.md)。

新歌工程使用随产品发布的 engine-base/runtime 引擎、许可字体和本项目基础件，不依赖同级参考仓库。原曲指纹导入仅在操作者另行提供合法的本地 ../pdoom-video 时可用。声库、音源、Python/模型和 FFmpeg 不随 Windows 包分发。

在仓库根目录安装依赖：

```sh
npm ci
```

分别在两个终端启动服务和界面：

```sh
npm run service
```

```sh
npm run dev
```

默认审阅室为 `http://127.0.0.1:5188/?view=project`，工程服务为 `http://127.0.0.1:5191`。服务健康查询 `GET /health`：

```powershell
Invoke-RestMethod http://127.0.0.1:5191/health
```

AI 使用 MCP stdio：由支持 MCP 的客户端启动 `npm run mcp`。连接配置、工具发现和制作流程以 MCP 指南为准；`mcp:pdoom` 只是保留的启动别名。

## 配置与独立实例

可从 [.env.example](../.env.example) 复制到 `.env.local`。service/mcp 脚本和 Vite 读取本地配置，文件不提交。默认值如下；代码增加配置时同步示例和本表。

| 配置 | 默认 / 作用 |
|---|---|
| `VIDEOGRAPH_SERVICE_PORT` | 5191；服务仅绑定 127.0.0.1 |
| `VIDEOGRAPH_SERVICE_URL` | `http://127.0.0.1:5191`；MCP/脚本连接服务 |
| `VITE_VIDEOGRAPH_SERVICE_URL` | 同上；前端连接服务 |
| `VIDEOGRAPH_STUDIO_ORIGINS` | `http://127.0.0.1:5188,http://localhost:5188`；明确的本地 HTTP 来源，不支持通配 |
| `VIDEOGRAPH_PROJECTS` | 仓库 `projects/`；工程根目录 |
| `VIDEOGRAPH_SERVICE_TOKEN_FILE` | `.cache/service-token`；MCP 凭据 |
| `VIDEOGRAPH_JOB_STALL_MS` | 600000；任务持续无状态/进度变化的停滞预算，单位毫秒 |
| `EDGE_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | 覆盖浏览器、ffmpeg 与 ffprobe 位置 |

同机第二套实例使用独立工作副本和工程目录/令牌，例如服务 5291、UI 5288。将两个 service URL、服务 port、Studio origins 一起改为对应地址，再运行 `npm run dev -- --port 5288 --strictPort`。MCP、UI 和服务必须指向同一套配置，不共写数据库或凭据。工程根目录在模块加载时确定，修改后需要启动新进程。

令牌由服务取得端口并初始化后生成。MCP 从令牌文件读取自身凭据；UI 从允许的 Origin 调 `/session` 取得独立人类凭据。不要手工给 AI UI 令牌，也不要把它们写入提示词/文档。当前边界只适用于可信本机用户，详见架构。

## 更新代码与停止服务

工程后端没有热重载：修改 server 代码后需要重启 service。修改 Vite 配置或环境变量后重启 dev。MCP 注册、schema 或技能内容更新后重连客户端，重新发现工具/资源。

先查询 health、任务列表及分析状态，再核验要停止的进程的可执行命令、工作目录和监听端口。使用所属终端的 Ctrl+C 正常退出；不要按历史文档的 PID 或仅凭端口号结束进程。保留正在运行的用户任务。工作台模式使用下文 status/stop，只停止属于本安装的实例。存在分析、渲染或维护操作时 stop 返回409，等待完成后再试。独立 npm run service 仍由所属终端正常退出。

## 常见问题

| 现象 | 处理 |
|---|---|
| UI 连不上 / MCP 读不到令牌 | 启动 service，查 health；核对 URL、工程根目录与 token file 是否属于同一实例 |
| `/session` 返回 403 | 核对 UI 实际 Origin 与允许列表，包括 localhost/127.0.0.1 和端口；Vite strictPort 防止静默换端口 |
| 更新后仍显示旧行为 | 后端重启；MCP 重连；前端刷新。重启会轮换凭据，过期会话需重新连接 |
| 409 版本或状态冲突 | 重读当前工程/目标修订及 token，再判断提交；不要去掉 expectedRevision 强行覆盖 |
| 导出被拒绝 | 检查分析确认、镜头生成/验证、未接受意见与导演闸门；技术完成不代替人工采用 |
| 歌声配置/别名缺失 | 先运行 vocal `check` 或 `project_vocal_check`，按真实声库别名写谱；不能猜测发音别名 |
| 浏览器/ffmpeg/Python 不可用 | 配置对应工具路径并执行模块自检；portable 检查不证明媒体环境已齐全 |
| 任务停滞或预览异常 | 查任务错误与本次运行日志；确认任务是否仍有进度。超长准备可调整停滞预算，不能通过无限等待隐藏错误 |

## 数据与备份

`projects/` 保存 SQLite、不可变分析/源码、素材和产物；`.cache/` 保存临时与下载缓存。它们被 Git 忽略，仍是本机数据。不要通过清理目录代替诊断或恢复；恢复操作不覆盖原工程。

使用 [工程存储与备份](PROJECT-STORAGE.md) 的 inspect/backup/restore CLI。模型许可见 [MODELS](../analyzer/MODELS.md)，示例影片和第三方权利见 [THIRD-PARTY](THIRD-PARTY.md)。当前实现及未支持能力以对应模块手册和 ROADMAP 为准。

## Windows 0.2 工作台与分发

解压到可写目录，先运行 Doctor.cmd，再将 workbench.example.json 复制为 workbench.json 配置外部工具。Start-Workbench.cmd 启动后台所属实例；Stop-Workbench.cmd 在空闲时正常停止；MCP.cmd 是 AI 客户端的 stdio 入口，HTTP-Tools.cmd tools 或 call <工具名> args.json 提供未接 MCP 时的发现/调用。内置 Node 和离线 npm 依赖，不需要 npm ci；FFmpeg/ffprobe、Edge/Chromium、Python/模型、合法声库/重采样器由使用者配置。Doctor 的 analysis-adapter 是文件/配置检查，不代表模型已成功推理。

源码目录也可先 npm run build，随后 npm run workbench -- start/status/stop/doctor。工作台的 studioPort、servicePort、projects 和外部工具路径读取 workbench.json；环境变量优先。UI 运行时注入 API 地址，MCP/HTTP 包装入口使用同一份配置，改端口不必重建。后台日志位于 .cache/workbench.log 与 workbench-error.log。每个新服务原子登记工程根目录归属；不同端口也不能共写。旧版进程没有此登记，升级时仍必须先由所属终端正常停止旧实例，不能与旧服务共用工程目录。

health 的 codeStale 比较启动时指纹与10秒缓存采样，UI 提示过期；还返回数据库/WAL体积、任务和操作积压、storageMigration。不会自动重启正在制作的用户任务。任务轮询先问 /projects/:id/version，变更后拉摘要分页（默认40、最多100），避免反复读取冻结输入。

发布前执行 npm run check:full 和 npm run package:windows。打包只复制明确的程序目录、许可引擎/字体、源码、手册与依赖；排除声库、音源、歌曲/MIDI/视频、projects、缓存、模型、凭据和本机配置。Vite 构建也仅复制公开图标/品牌演示，禁止 dist/audio 混入。同目录生成ZIP与.zip.sha256校验文件；release-manifest.json 列出逐文件 SHA-256；DEPENDENCY-LICENSES.json 与 runtime/NODE-LICENSE.txt 保留依赖通知。生成包只是本地构建，不执行上传。用户音源不得二次分发；本地工程备份另行保管，不放入软件分发包。

获得发布授权后，提交前对已暂存源码运行`node scripts/check-release-source.mjs`，检查完整Git索引中的媒体、声库/模型、私有配置及凭据；忽略规则不能排除已经被Git跟踪的文件。必须发布音源排除后的源码树，旧媒体仅从索引移除、本地保留，不重写已发布历史。最终ZIP用`node scripts/release-package.audit.mjs <ZIP路径>`在独立含空格目录解压，逐文件校验并实际启动HTTP/审阅室/MCP，验证后才上传包与校验文件。OpenUtau冻结约定和最新技能应在新包中；外部工具、模型、声库与人工听感验收仍单独记录。

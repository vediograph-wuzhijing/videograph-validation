# 工程存储与备份

工程元数据、历史和任务以 `project.sqlite` 为事实源。分析文件采用内容寻址的不可变版本；预览和后台导出根据工程或冻结快照中的 `analysisGeneration` 读取数据。

## 分析发布与兼容

新发布先在 `generations/.staging-<uuid>/` 写入完整文件，再发布为 `generations/<sha256>/`，最后在 SQLite 事务中校验文件并提交 `analysisGeneration` 指针与新的工程修订。一个版本包含 `analysis-v2.json`、`data/audio.json`、`data/lyrics.json`、`engine-manifest.json` 和记录各文件哈希的 `generation.json`。

文件写入、版本发布或事务回调失败时，活动指针保持旧版。普通异常清除本次 staging；进程被终止可能留下 staging 或已完整发布但未被引用的版本，它们不会成为活动输入。已冻结的任务保留自己的指针，后续修正分析不会改变该任务的数据。

没有 `analysisGeneration` 的旧工程继续读 `analysis/analysis-v2.json`、`engine/data/` 和根目录的 `engine-manifest.json`；第一次重新发布时自然迁移。旧目录不再同步改写。内部消费者通过 `project-generation.mjs` 的路径函数访问，外部操作者使用歌曲 HTTP/MCP 接口，不把旧目录当作最新数据。

分析文件逐个执行 fsync，SQLite 使用事务提交；Windows 不支持的目录 fsync 会跳过。已有测试覆盖文件写入异常、发布前后异常、子进程在提交前后退出和重开读取；尚未做断电、磁盘硬件故障或网络文件系统实验。

## 操作命令

在仓库根目录运行；与主服务相同，npm 命令加载 `.env.local`。自定义工程根目录用 `VIDEOGRAPH_PROJECTS`，恢复也写到该根目录。

```powershell
npm run project:backup -- inspect <projectId>
npm run project:backup -- backup <projectId> F:\backups\videograph\new-backup
npm run project:backup -- restore F:\backups\videograph\new-backup
npm run project:backup -- restore F:\backups\videograph\new-backup restored-project-id
```

`inspect` 检查 SQLite、当前与历史/冻结任务引用的分析版本、当前引擎和镜头源码哈希、已采用歌声，并列出 staging。它不会删除文件；staging 也可能属于正在运行的写入者。

备份通过 SQLite `VACUUM INTO` 取得一致数据库快照，不复制活动数据库或其 WAL/SHM/journal。随后复制工程文件，保留原媒体、源码、分析版本、歌声产物、历史、任务和导出；排除歌声音符缓存、临时工作目录与未发布的分析 staging。逐文件校验采用固定大小缓冲区，适用于大媒体文件。完整校验后才发布备份目录；目标已存在或位于源工程内部时拒绝。

恢复逐文件检查路径和 SHA-256，校验数据库及引用后才发布新工程目录；不会覆盖现有工程。恢复工程记录原工程 ID、修订和恢复时间，旧任务中的工程 ID 同步更新；原工程不变。queued/running 任务改为 interrupted，analysis-pending 改为 analysis-failed，需明确重试，不自动重复外部任务。

备份不包含仓库、node_modules、外部声库、resampler 或本机配置。另一台机器需要安装产品依赖并重新配置外部工具；已采用的混音文件随工程保留。备份清单用于检验文件完整性，不提供加密或签名。

## 保留边界

旧分析版本和 exports 不自动删除：历史和已冻结任务仍可能引用它们。进程强制退出留下的 staging，只能在核验无写入者后清理；完整旧版本的垃圾回收还需结合历史和任务引用。备份/恢复命令是本地维护入口，尚未接入 UI 或 MCP。schema migrations、磁盘配额和自动回收的后续状态统一见 ROADMAP。

## 大工程记录与维护

schema v2 使用 WAL。当前工程仍是一条完整 JSON，历史 revisions 采用 videograph-snapshot/v2 递归内容引用；大而相同的分析片段与源码按 SHA-256 共享到 .records/objects。任务的冻结输入与完整结果也外置，SQL 行只留参数/摘要/引用。分页任务列表不展开对象；单任务查询按需展开结果，工作进程才读取冻结工程。jobsVersion 独立递增，健康与版本接口不解析任务大行。进度写入复用冻结引用；终态不能被迟到的 watchdog/进度覆盖。

新服务在工作线程中进行可恢复的旧行迁移，不自动 VACUUM；健康端口先可用，health 报进度。新写入和迁移的 schema 初始化由 BEGIN IMMEDIATE 串行化。老服务/IPC 的写格式保持兼容；运行旧服务时不要对其工程手动迁移或清理。操作前先备份，并在空闲或隔离副本上维护：

```powershell
npm run project:maintenance -- migrate <projectId>
npm run project:maintenance -- migrate <projectId> --vacuum
npm run project:maintenance -- retain <projectId>
npm run project:maintenance -- retain <projectId> --apply
```

retain 默认只报告。保留最近100条任务与最近24小时、人工审阅/采用证据、当前工程与保留历史的所有引用；仅回收无人引用且超过至少1小时宽限的受管理 artifacts 与 .records 对象。不删 exports、原媒体、用户文件、分析 generation 或引擎；200条最近修订加初始修订仍保留。新服务每6小时对空闲工程执行此策略。事务租约阻止写入与回收交错，删除阶段再次持有 SQLite 写锁，失败可留下可重试的孤儿文件。活动任务拒绝清理，VACUUM 也只允许空闲工程。

备份包含外置对象，校验时还原历史/任务并检查哈希。不能只拿 project.sqlite 当作完整工程。保留策略不是磁盘硬配额；长期导出和分析版本由操作者在完整备份后管理。

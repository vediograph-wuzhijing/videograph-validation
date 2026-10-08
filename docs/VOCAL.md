# VOCAL — OpenUTAU 人声合成与工程集成

> [文档中心](README.md) · [MCP 工具契约](MCP-GUIDE.md)。本文维护使用、设计与支持边界；里程碑、验收和待完成能力只维护 [ROADMAP](../ROADMAP.md)。

> **维护策略：0.2.0冻结，仅修复已确认的bug。** 保留现有CLI、HTTP、MCP和审阅室入口，不主动增加功能、重构或更换后端。按用户实际测试，现有模型尚不能很好调用这一工具，因此作为未来探索方向保留；技术管线与客观报告通过不代表模型能可靠完成歌声制作。冻结范围及修复约定见[AGENTS](../AGENTS.md)，后续扩展暂停状态见[ROADMAP](../ROADMAP.md)。

## 这是什么

`src/vocal/` 把 UTAU/OpenUTAU 生态封装成可由CLI、HTTP或MCP调用的实验性歌声合成管线：写音符/歌词（plan JSON）→ 生成 USTX → 无头渲染人声 WAV → 工程候选混音 → 人工试听采用 → 视频预览与导出。词级时间来自乐谱，属于推算时间；辅音提前量和包络会影响实际声音边界，不能称为免校正的实测对齐。

## 格式与重采样契约

- **OpenUtau 没有官方无头渲染**（[issue #1615](https://github.com/openutau/OpenUtau/issues/1615)，closed as not planned；Core 库与 UI 有耦合）。所以本模块**不驱动 OpenUtau 本体渲染**，OpenUtau 安装只用于自检与互操作验证。
- 走**经典渲染契约自研管线**：USTX（YAML，`ustx_version: "0.10"`，snake_case）→ 逐音符调用外部重采样器 → Node 内 wavtool（重叠相加）。
- **重采样器契约有两种变体**（配置 `resamplerContract` 选择，默认 `classic`）：
  - `classic`（worldline.exe 等独立重采样器）：平直音高保留 11 参 `input output 音名 velocity flags offset durRequired consonant cutoff volume modulation`；有弯曲时追加 **`!tempo` 和 int12 base64**，共 13 参。不要使用缺 `!tempo` 的 12 参形式：本机 worldline 实测会忽略弯曲。worldline 内置 F0 分析，不需要 frq。
  - `openutau`（13 参，moresampler 等，对齐 `ExeResampler.cs`）：前 11 参同 + `!tempo` + int12 base64 音高（`#次数#` 游程压缩）。
  - 音名 = MusicMath 约定（C4=60）。
- **oto.ini 行格式**（两种工具通用）：`<文件名>.wav=<别名>,<offset>,<consonant>,<cutoff>,<preutter>,<overlap>`——文件在左、别名在右、5 个数值（均可省略默认 0，别名空则取文件名去扩展名）。**没有独立的 blank 字段**（offset/cutoff 就是左右 blank 边界）。
- **声库编码**：`character.yaml` 的 `text_file_encoding` 声明 → oto.ini 头部 `#Charset:` 声明 → UTF-8 严格解码失败退 Shift-JIS。老日文声库多为 Shift-JIS。
- 分辨率固定 480 tick/拍；音高点 `{x 毫秒(相对音符起点), y 0.1半音}`，即 `y=10` 为 +100 音分。USTX 线性 shape 为 `l`，JSON 接受 `lin` 并转换；还支持 `io/i/o/sp`。默认滑音从 -40ms 到 +40ms，`snapFirst` 对相邻音符接入前一音高。
- 音高数组每 **5 tick** 采样，间隔 `60000 / BPM / 480 * 5` 毫秒，160 BPM 为 3.90625ms。数组从原始 preutter 之前的时间轴开始，包含 skipOver，裁切后仍与绝对曲线对齐。
- `durRequired = ceil(max(实际音素长度 + skipOver, consonant) / 50 + 0.5) * 50`。实际长度包含有效 preutter 与邻接尾部调整；重采样器的网格补齐段在拼接前裁掉。
- 契约依据固定到 [OpenUtau ExeResampler](https://github.com/openutau/OpenUtau/blob/8945ee38832203caafccbd85ab4375783dc630f1/OpenUtau.Core/Classic/ExeResampler.cs)、[ResamplerItem](https://github.com/openutau/OpenUtau/blob/8945ee38832203caafccbd85ab4375783dc630f1/OpenUtau.Core/Classic/ResamplerItem.cs) 与 [UNote](https://github.com/openutau/OpenUtau/blob/8945ee38832203caafccbd85ab4375783dc630f1/OpenUtau.Core/Ustx/UNote.cs)。格式校验不等于 GUI 互操作验收。
- 我们写出的 USTX 全部为块式 YAML（OpenUtau 自己会混用流式，两种它都能读；本模块两种都能解析）。

## 配置（零硬编码路径）

解析优先级（高→低），任何一层配置后自动发现不再参与：

1. CLI 显式参数（`--resampler`、`--bank`、`--openutau-home`、`--resampler-contract`）
2. 环境变量：`VIDEOGRAPH_OPENUTAU_HOME`、`VIDEOGRAPH_OPENUTAU_RESAMPLER`、`VIDEOGRAPH_VOICEBANK_DIR`、`VIDEOGRAPH_OPENUTAU_CONTRACT`、`VIDEOGRAPH_VOCAL_CACHE`
3. 项目级 `.videograph/vocal.json`（**不要提交进 git：机器本地路径不入库**）
4. 用户级 `~/.videograph/vocal.json`
5. PATH 查找 → 平台标准安装位置（仅自动发现兜底）

项目与用户配置**按字段合并**。服务的项目级文件位于 `projects/<id>/.videograph/vocal.json`；用户级配置可供所有工程共用。环境变量 resampler 支持可执行文件字符串或 JSON argv 数组，例如 `["node","wrapper.mjs"]`。渲染只需重采样器和声库，OpenUtau 安装不是前提。

`vocal.json` 示例：

```json
{
  "openutauHome": "D:/tools/OpenUtau",
  "resampler": "D:/tools/worldline.exe",
  "resamplerContract": "classic",
  "voicebankDir": "D:/voicebanks/MyBank",
  "cacheDir": "D:/vocal-cache"
}
```

- `resampler` 也可以是 argv 头数组（包装脚本、测试桩用）：`"resampler": ["node", "resampler-stub.mjs"]`。`.bat/.cmd` 不能被直接执行。
- **渲染只需要 `resampler` 与 `voicebankDir`**；`openutauHome` 非必需。
- **重采样器从哪来**：moresampler 闭源且作者已丢失源码（社区分发，勿依赖）；推荐独立 `worldline.exe`——来自 [vlabeler-resampler-test](https://github.com/sdercolin/vlabeler-resampler-test) release（OpenUtau 的 worldline 独立构建，MIT）。声库与重采样器二进制由使用者提供、不入库、许可各自核对。

## 渲染缓存

逐音符按 vocal-note/v3 内容寻址，键包括重采样器可执行文件、argv 中已有脚本内容、输入 WAV 内容与契约参数（含实际音高数组、BPM、velocity）；同路径工具内容改变也重新渲染。包络、volume、dyn 和混音在重采样后应用，单独改这些参数可以复用原采样；曲线改变可能影响相邻音符的前置/尾部段，按实际参数失效。指纹覆盖直接工具/脚本，包装器的间接 DLL 等依赖未全部覆盖。

缓存保存在 `cacheDir`（默认 `~/.videograph/vocal-cache`），跨渲染复用仍匹配输入的音符；这不能作为视频公共库依赖隔离（改进建议 B2）的完成证据。`--no-cache` 关闭缓存；结果的 `cacheSummary.hits/misses` 报告实际命中。

## CLI

```bash
node src/vocal/cli.mjs check                                   # 自检：解析链结果 + 缺项指引
node src/vocal/cli.mjs make-ustx --plan plan.json --out song.ustx
node src/vocal/cli.mjs check-ustx --ustx song.ustx             # 结构自检
node src/vocal/cli.mjs make-ust --ustx song.ustx --out song.ust [--voice-dir DIR]
node src/vocal/cli.mjs render --ustx song.ustx --out vocal.wav [--work-dir DIR] [--bank DIR]
                            [--resampler PATH] [--resampler-contract classic|openutau] [--no-cache]
node src/vocal/cli.mjs extract-pitch --audio separated-vocal.wav --plan plan.json --out tuned-plan.json
                                   [--offset-ms 0] [--min-confidence 0.85] [--max-deviation 600] [--curve-tolerance 2]
node src/vocal/cli.mjs analyze-pitch --audio vocal.wav --plan tuned-plan.json --out pitch-report.json
```

所有命令支持 `--json`（机器可读）。退出码：`0` 成功 / `2` 配置缺失 / `3` 输入或渲染错误 / `1` 未预期。

### plan JSON schema（make-ustx 的输入）

```jsonc
{
  "name": "曲名",
  "tempo": 120,                       // 默认 120
  "key": 0,                           // 可选，C=0
  "tracks": [{ "singer": "声库名", "trackName": "主唱" }],
  "parts": [{
    "name": "A 段",
    "trackNo": 0,                     // 0 起
      "pitchDeviation": [{ "timeMs": 0, "cents": 0 }, { "timeMs": 1000, "cents": 80 }],
      "dynamics": [{ "timeMs": 0, "db": -6 }, { "timeMs": 1000, "db": 0 }],
    "notes": [{
      "lyric": "a s",                 // M2 约定：必须是 oto 别名本身（CVVC 链式自动展开见下）
      "pitch": "C4",                  // 或 "tone": 60（C4=60，与 OpenUtau 一致）
      "startBeats": 0,                // 或 "startTick"（相对全曲绝对位置）
      "durationBeats": 1,             // 或 "durationTicks"；两者必填其一
      "pitchCurve": [{ "x": -80, "y": -10, "shape": "lin" }, { "x": 80, "y": 0 }],
      "snapFirst": false,             // 自定义首点时关闭相邻音高自动接入
      "vibrato": { "length": 70, "period": 200, "depth": 40, "in": 10, "out": 10 },
      "volume": 85,                   // 默认 100，0..200；velocity/attack 同范围
      "decay": 10                     // 默认 0，0..100
    }]
  }]
}
```

`lyric: "R"` 表示休止（渲染跳过）。音符时间重叠会被拒绝；part 位置自动对齐到首音符。

### 音高、颤音和力度

逐音符 `pitchCurve`、`vibrato`、整段 `pitchDeviation` 叠加到同一条绝对音高时间轴，覆盖 preutter 与连音边界。颤音 `length` 为音符尾部启用比例，`period` 为毫秒，`depth` 为音分，`in/out` 是启用区间内的渐入/渐出百分比；可选 `shift`（0..100 相位）与 `drift`（-100..100 中心偏移比例）。`volLink` 非零显式拒绝，用 dyn 控制力度。

`part.pitchDeviation` 与 `part.dynamics` 的 `timeMs` 都是**全曲绝对毫秒**，严格递增。前者范围 ±1200 音分，映射到 USTX `pitd`；后者 -24..12 dB，映射到 `dyn` 的 0.1dB，-24 为静音。曲线端点外保持端值，需要回到零请写零点。合成时总偏移超出 int12 的 -2048..2047 会报错，不静默截断。逐音符 volume 与 dyn 相乘；相对力度保留，若干轨超过余量会统一衰减并在 `stemGain/warnings` 记录。

`velocity` 调整辅音伸缩、preutter 与 overlap；先布局所有相邻音符，再计算 skipOver、TailIntrude、TailOverlap 和五点包络。`attack/decay` 控制默认包络；可选 `envelope` 为恰好五个 `{x,y}` 点，x 是相对音符起点毫秒，y 是 0..400 的百分比，首末 y=0、首 x≤0、末 x>0，时间严格递增。它替换默认 attack/decay，仍乘 volume，起点两侧按实际音素范围调整。自定义包络存为 `videograph_envelope` 扩展，OpenUtau GUI 不执行此扩展。`sp` 使用本地 Hermite 插值，两点时为 sine-in-out；不声称与 GUI 样条逐采样相等。

### 从原唱提取整段 pitd

先提供**已分离的单声部人声 WAV**和时间匹配的 JSON 乐谱，运行 `extract-pitch`；它写出 `tuned-plan.json` 和 `.report.json`。算法实测 F0，减去乐谱已有音高/滑音/颤音，只把剩余偏差写到 `pitchDeviation`，避免已有颤音叠加两次；原 plan 文件保留。低置信度、无声及超出 `max-deviation` 的帧回到零偏移，明确记录原因，不跨无声区补出原唱。

`offset-ms` 定义为「乐谱时间 = 音频时间 + offset」，不自动猜起点；默认最大偏移 600 音分，需按匹配乐谱与音域核对倍频错误。默认简化误差不超过 2 音分，保留无声边界，减少长歌提交体积；`--curve-tolerance 0` 保留全部观测点。HTTP 提交体上限 1MB，超限时先简化或缩短处理范围。它不做人声分离或自动猜测音符时间；MIDI/假名入口见下文。

拿生成的 JSON 作为 `project_vocal_submit.plan`，再调用 `project_vocal_render` 即可转到目标声库。原唱的气声、音色与音量并不由 pitd 复制，分离伪影和倍频仍需要核验。

### 人声混音链

工程提交的 `mix` 是与 `plan` 并列的参数。省略 `processing` 保留已有增益/限制器行为；传 `"processing": {}` 启用默认 EQ → 压缩 → 立体声房间混响 → 原伴奏混合 → 限制器。可独立覆盖：

```json
{
  "backingGain": 0.7,
  "vocalGain": 1,
  "processing": {
    "eq": { "lowCutHz": 80, "lowGainDb": -2, "midHz": 2500, "midGainDb": 1, "highGainDb": 0 },
    "compressor": { "thresholdDb": -18, "ratio": 3, "attackMs": 8, "releaseMs": 100, "makeupDb": 0 },
    "reverb": { "wet": 0.15, "decayMs": 650, "roomSize": 1, "damping": 0.35 }
  }
}
```

EQ 为高通加 200Hz/可调中频/8000Hz 三段；混响使用延迟梳状滤波和扩散段，`wet=0` 关闭湿声。处理中间文件为 float32，保留增益余量，最终混音 44100Hz 双声道 PCM16，限制在 0.95，按原曲长度输出。曲尾混响会被原曲边界截断；参数与冻结任务一同保存，干轨仍可单独下载。

### 实测音高报告

每次渲染自动测量**实际写出的干轨**，CLI 写 `${outWav}.pitch.json`，工程候选增加不可变 `pitchReportFile`，MCP 的 `report.pitchQuality` 和审阅室「实测音高质检」提供摘要与逐音符诊断。JSON 包含逐帧 F0、置信度、乐谱音高、含曲线/颤音的目标音高、两种音分误差、可靠覆盖率与中位数/P95；长音另估计 3..12Hz 的起伏频率和深度。下载报告可核对颤音是否实际产生；`analyze-pitch` 可重新测任意与 plan 对齐的干轨。

检测为 FFT 加速 YIN，8kHz 分析率、64ms 窗、默认 10ms 步长和 0.85 置信阈值。辅音、气声、分离噪声、复音及倍频可能影响检测，快速变化会被分析窗平滑；短于 400ms 或幅度不足 3 音分时不报告可靠起伏。**null 是未可靠测出，不是唱准；这份报告用于技术自查，人工试听决定演唱接受。**

**CVVC 用法**：别名形态因声库而异（本机 Deepseek 声库：句首 `- か`、整音 `か`、过渡 `a s`/`a ky`、元音连接 `a あ`、拨音 `a ん`）。AI 写谱前先 `check` 看声库，再按别名表选词；自动音素展开（presamp.ini/phonemizer 等价物）尚未支持。另支持 MIDI 与假名逐音节配词，但不猜汉字读音、不执行完整 CVVC/presamp 音素拆分；需要过渡音素时仍显式写谱。

## 渲染管线与支持范围

`render`：结构自检 → oto 别名与邻接布局 → 全曲音高时间轴 → 内容寻址缓存/重采样 → 裁补齐段 → 五点包络与 dyn → 重叠相加 → 44100Hz/16bit 单声道干轨 → 实测音高。工程 worker 再处理混音链并发布候选。

当前实现的限制：

- 已支持曲线、颤音、pitd/dyn、五点包络和邻接尾部调整；仍无相位补偿。不同录音相位与极端 oto 需要试听，不承诺消除所有接缝。
- 只接受 vol/vel/atk/dec 音素表达及 pitd/dyn 曲线；非零 vibrato.vol_link、masked 曲线、track 音量/声像和 phonemizer 明确拒绝，避免默默丢掉调音。
- 仅支持单 voice_part；声库若带 subfolder oto，别名文件路径按各自 oto 所在目录解析。
- OpenUtau GUI 互操作（我们的 ustx 它能开、它的 ustx 我们能渲）待人工在 GUI 开档验证一次。

## 模块地图

| 文件 | 职责 |
|---|---|
| `yaml-lite.mjs` | USTX（YAML）子集读写器：块式 + 流式映射，写出对齐 YamlDotNet |
| `ustx.mjs` | USTX 0.10 生成器、标准表情表、音名换算、结构自检 |
| `ust.mjs` | 经典 UST 文本写出（互操作） |
| `oto.mjs` | oto.ini 解析（wav=别名 5 数）、编码声明（character.yaml/`#Charset:`/自动探测）、声库扫描、别名字典 |
| `config.mjs` | 外部工具解析链（env → 配置文件 → PATH → 平台候选） |
| `wav.mjs` | 16-bit PCM WAV 读写 |
| `resampler.mjs` | classic/openutau 双契约调用 + int12 音高编码 |
| `expressions.mjs` | 统一单位、曲线插值、颤音与跨音符音高模型；无文件/进程依赖 |
| `phoneme-layout.mjs` | oto 邻接布局、preutter/skipOver/尾部与五点包络/力度 |
| `pitch-analysis.mjs` | 独立实测 F0、目标对比报告、参考音高提取及有界简化 |
| `mix.mjs` | 混音参数规范、EQ/压缩滤镜与立体声房间混响 |
| `wavtool.mjs` | 重叠相加拼接 |
| `render.mjs` | 渲染编排 + 内容寻址缓存 |
| `cli.mjs` | 命令行入口 |
| `plan.mjs` | 工程乐谱支持范围、时长/表达校验、显示歌词和乐谱词级时间、混音增益 |
| `../server/vocal-project.mjs` | 乐谱独立版本、不可变产物、候选与人工采用/恢复；SQLite 事务内拒绝过时编辑 |
| `../server/vocal-worker.mjs` | 独立后台进程、冻结配置/输入、临时目录、取消、干轨与 FFmpeg 混音 |
| `../server/audio-track.mjs` | 预览/导出统一音轨选择；原音频不覆盖 |
| `../server/media-files.mjs` | 工程音频/产物流式响应、MIME、Range；解决 Windows 跨盘媒体读取 |
| `../server/mcp-vocal-tools.ts` | AI 的 get/check/submit/render/import-midi/import-audio 六个工具，不提供人工采用权限 |
| `../project/VocalPanel.tsx` | 审阅室歌声区：编辑、试听、采用、恢复；规划前明确应用乐谱歌词 |

## 工程中的完整流程

1. 用原音频创建工程并完成分析。原音频作为伴奏混音输入；这里不做人声分离，已有的原唱仍在原音频内。
2. AI 调 `project_vocal_check` 查真实别名，`project_vocal_get` 读取独立 `inputRevision`，再 `project_vocal_submit`。`lyric` 是 oto 发音别名；可选 `text` 是显示歌词，两者不能混用。
3. `project_vocal_render` 创建后台任务，输入包含冻结工程、乐谱版本和机器配置。与视频任务共用队列、任务查询、取消和重启恢复。每个任务使用独立临时目录，退出清理。
4. worker 保存不可变人声 WAV、混音 WAV、USTX、LRC、实测音高 JSON、缓存/工具指纹报告和词级时间；只有仍匹配乐谱版本、内容 token、原音频与时长的结果进入 candidate。过时结果可下载但不能采用。
5. 在审阅室「歌声制作」试听后采用。`active` 与 `draft/candidate` 分开；继续改谱不影响已采用声音。恢复原音频只清除 active，历史文件继续可追溯。
6. 预览与导出均选择 active 混音。导出冻结采用版本，校验音轨哈希，manifest 记录原音频 hash、采用混音 hash、歌声任务与报告。混音文件不计入画面引擎 hash，音轨变更复用画面缓存，但 productionSignature 改变，旧审片结论失效。宿主版本改变仍会使旧画面缓存失效；音轨独立复用不绕过画面宿主的版本键。
7. 若尚未规划镜头，可明确「将乐谱歌词用于视频分析」：转换成现有歌词契约，`lyrics.timingSource=score`、provenance.params 同步标记，工程回到 analysis-draft，重新核对、确认、规划。已规划工程不自动替换歌词或镜头，避免悄悄改变画面依据。

HTTP：`GET /projects/:id/vocal`、`GET .../vocal/check`、`POST .../vocal`（expectedInputRevision + plan + mix?）、`POST .../vocal/render`（expectedInputRevision）。人专用：`POST .../vocal/adopt`（expectedProjectRevision + expectedInputRevision + jobId）、`POST .../vocal/reset` 和 `POST .../vocal/lyrics`（expectedProjectRevision）。MCP 令牌访问人专用操作返回 403；请求体无法改变身份。

目前工程提交限制为固定 BPM、单轨单 part、1..2000 个音符、歌曲最长一小时；拒绝 phonemizer、未支持的表达字段、重叠和超时音符。默认 backingGain=0.7、vocalGain=1（可设 0..2）；支持范围和混音见上文。节拍与画面包络仍使用原音频分析，未重新估计生成歌声的包络。

验收：`node --test scripts/tests/vocal/expressions.test.mjs scripts/tests/vocal/integration.test.mjs` 验证已知信号基频/颤音、前置/尾部、缓存及 HTTP/MCP/worker/FFmpeg/MP4、权限/版本/取消。`node scripts/vocal-integration-audit.mjs --expressions` 使用本机声库同时验收曲线、力度、处理混音、报告下载和 UI 采用，只写 `.cache/vocal-expression-audit`；省略选项为基础接入验收。验收结果统一见 ROADMAP 的“最近交付与证据”。小屏保留原有 1100px 最小宽度限制。

测试：`node --test scripts/tests/vocal/yaml.test.mjs scripts/tests/vocal/ustx.test.mjs scripts/tests/vocal/ust-oto.test.mjs scripts/tests/vocal/config.test.mjs scripts/tests/vocal/render.test.mjs scripts/tests/vocal/cli.test.mjs`（Windows 下 `node --test` 传具体文件路径，不传目录）。

`node scripts/vocal-pitch-audit.mjs [--alias 元音别名]` 用本机配置实测平直基准、+200 音分局部曲线、+100 pitd、5Hz 颤音、160 BPM 八分音符及参考颤音提取再合成。WAV/USTX/逐帧报告只写 `.cache/vocal-pitch-audit`；不代替特定歌曲的音色或人工接受。

## 许可边界

OpenUtau 为 MIT：本模块只引用格式与命令行契约知识，未复制其代码。声库（如本机 Deepseek CVVC fixed：**禁止二次配布**）与重采样器二进制由使用者提供，许可各自核对，不入库（同 [AGENTS](../AGENTS.md) 数据纪律）。



## 输入与缓存边界

外部 USTX 的空元素、零 BPM、非法位置返回诊断；渲染显式拒绝多 tempo。WAV 检查 chunk 边界与帧对齐。内容寻址缓存使用校验后的 WAV；损坏缓存不能作为有效结果。支持范围和简化发音近似与上文一致，不因格式写出支持某字段而声称渲染支持它。

## MIDI、假名与外部人声

project_vocal_import_midi 或审阅室导入区将 SMF type0/1、PPQ 转成只读候选 plan。16MB/256轨/50万事件上限，明确选择 trackIndex/channel，拒绝复音、SMPTE/type2、悬空音符与错误事件。MIDI 变速先转绝对秒，再量化到固定BPM的480tick乐谱，报告最大半tick时间误差。歌词可来自逐音符MIDI事件、长度完全一致的音节数组或日语假名文本。假名按拗音/长音分配，CV/VCV/literal 模式只选择真实 oto 别名，aliasReport 列出缺项；prefix/suffix 用于显式选音阶。缺声库或别名不能声称已验证，不猜汉字读音、不做完整CVVC拆分。CLI：node src/vocal/cli.mjs import-midi --midi melody.mid --lyrics kana.txt --bank DIR --out plan.json。事件解析遵循 [MIDI Association 的 SMF 规范](https://midi.org/standard-midi-files-specification)，meta 与 sysex 后清除 running status。

project_vocal_import_audio（HTTP POST /projects/:id/vocal/import-audio）需要 expectedInputRevision + audioPath，可带 offsetMs、referencePath/referenceOffsetMs、plan、mix。先复制哈希冻结源文件，再由FFmpeg转换44100Hz单声道、偏移对齐、补齐歌曲长度；超长拒绝，处理后仍事务核验乐谱版本与原音频。导入不需要声库/重采样器，也不自动采用。没有 plan 时 USTX/LRC/F0 报告为空，不能凭空生成歌词时间。

mix.processing 另接受 exciter:{amount:0..0.5,frequencyHz:1000..10000,drive:1..8}、saturation:{amount:0..1,drive:1..8}、doubling:{wet:0..0.5,delayMs:5..50,depthMs:0..4,rateHz:0.05..3}。默认 amount/wet=0，保持旧处理行为；需显式调节。激励/饱和产生谐波，叠声以确定性微延迟拓宽立体声，不能恢复声库本来缺失的原唱音色，也不承诺补回固定10dB。

每个工程人声任务生成 bandReportFile：实际输出与可选参考干轨的分段频谱 RMS dBFS、峰值及差值，4096点 Hann FFT，最长均匀抽样6000窗。静音/超出采样Nyquist频段为null；不是0dB。参考文件随输入冻结，需自行提供同时间范围、相同响度基准和准确偏移；整体响度/留白差异会影响全轨能量，不能把能量差直接当作音色优劣。F0 逐帧数据留在报告文件，工程候选只存摘要，避免重新撑大数据库。

声库和一切音源由用户依法本地配置，不进入0.2软件分发包。渲染的人声与参考干轨属于用户工程媒体，备份可保留，不能混进软件上传。

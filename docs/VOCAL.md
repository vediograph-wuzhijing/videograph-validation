# VOCAL — OpenUTAU 人声合成集成（VOCAL-M1/M2）

> 计划、里程碑（VOCAL-M1～M5）与认领状态见 `ROADMAP.md` 第三节「VOCAL 冲刺」；本文只放使用与设计事实。

## 这是什么

`src/vocal/` 把 UTAU/OpenUTAU 生态封装成 AI 可用的歌声合成管线：写音符/歌词（plan JSON）→ 生成 USTX → 无头渲染人声 WAV。目标是替代"外部 TTS 凑合唱"的做法，并且**在生成音符时就拿到词级时间**（M3 接入工程后从源头解决歌词对齐，呼应改进建议 A1/A3）。

## 关键事实（2026-10-06 对 openutau/OpenUtau master 源码与格式文档核对）

- **OpenUtau 没有官方无头渲染**（[issue #1615](https://github.com/openutau/OpenUtau/issues/1615)，closed as not planned；Core 库与 UI 有耦合）。所以本模块**不驱动 OpenUtau 本体渲染**，OpenUtau 安装只用于自检与互操作验证。
- 走**经典渲染契约自研管线**：USTX（YAML，`ustx_version: "0.10"`，snake_case）→ 逐音符调用外部重采样器 → Node 内 wavtool（重叠相加）。
- **重采样器契约有两种变体**（配置 `resamplerContract` 选择，默认 `classic`）：
  - `classic`（11 参，worldline.exe 等独立重采样器）：`input output 音名 velocity flags offset durRequired consonant cutoff volume modulation [音高弯曲]`；平直音高省略末参；worldline 内置 f0 分析，**不需要 frq**。
  - `openutau`（13 参，moresampler 等，对齐 `ExeResampler.cs`）：前 11 参同 + `!tempo` + int12 base64 音高（`#次数#` 游程压缩）。
  - 音名 = MusicMath 约定（C4=60）。
- **oto.ini 行格式**（两种工具通用）：`<文件名>.wav=<别名>,<offset>,<consonant>,<cutoff>,<preutter>,<overlap>`——文件在左、别名在右、5 个数值（均可省略默认 0，别名空则取文件名去扩展名）。**没有独立的 blank 字段**（offset/cutoff 就是左右 blank 边界）。
- **声库编码**：`character.yaml` 的 `text_file_encoding` 声明 → oto.ini 头部 `#Charset:` 声明 → UTF-8 严格解码失败退 Shift-JIS。老日文声库多为 Shift-JIS。
- 工程事实：分辨率固定 480 tick/拍；音高点 `{x 毫秒(相对音符起点), y 0.1半音, shape io|lin|i|o|sp}`；默认滑音 Standard（-40ms/80ms）；颤音默认 period 175 / depth 25 / in 10 / out 10；标准表情 27 项（required：dyn/pitd/clr/eng/vel/vol/atk/dec；缩写含 `mod+`）。
- **durRequired 公式**（对齐 `ResamplerItem.cs`）：`max(音符时长, consonant)` 向上取整到 50ms 网格；M2 简化布局下 skipOver 与 durCorrection 为 0（完整音素布局属 M3）。
- 我们写出的 USTX 全部为块式 YAML（OpenUtau 自己会混用流式，两种它都能读；本模块两种都能解析）。

## 配置（零硬编码路径）

解析优先级（高→低），任何一层配置后自动发现不再参与：

1. CLI 显式参数（`--resampler`、`--bank`、`--openutau-home`、`--resampler-contract`）
2. 环境变量：`VIDEOGRAPH_OPENUTAU_HOME`、`VIDEOGRAPH_OPENUTAU_RESAMPLER`、`VIDEOGRAPH_VOICEBANK_DIR`、`VIDEOGRAPH_OPENUTAU_CONTRACT`、`VIDEOGRAPH_VOCAL_CACHE`
3. 项目级 `.videograph/vocal.json`（**不要提交进 git：机器本地路径不入库**）
4. 用户级 `~/.videograph/vocal.json`
5. PATH 查找 → 平台标准安装位置（仅自动发现兜底）

`vocal.json` 示例：

```json
{
  "openutauHome": "F:/aicg/tools/OpenUtau",
  "resampler": "F:/aicg/tools/worldline/resampler-test/worldline.exe",
  "resamplerContract": "classic",
  "voicebankDir": "F:/aicg/voicebanks/DeepseekCVVCVV",
  "cacheDir": "F:/aicg/vocal-cache"
}
```

- `resampler` 也可以是 argv 头数组（包装脚本、测试桩用）：`"resampler": ["node", "resampler-stub.mjs"]`。`.bat/.cmd` 不能被直接执行。
- **渲染只需要 `resampler` 与 `voicebankDir`**；`openutauHome` 非必需。
- **重采样器从哪来**：moresampler 闭源且作者已丢失源码（社区分发，勿依赖）；推荐独立 `worldline.exe`——来自 [vlabeler-resampler-test](https://github.com/sdercolin/vlabeler-resampler-test) release（OpenUtau 的 worldline 独立构建，MIT）。声库与重采样器二进制由使用者提供、不入库、许可各自核对。

## 渲染缓存（改进建议 B2）

逐音符按「重采样器 argv 头 + 输入 wav 内容哈希 + 契约参数」内容寻址，缓存于 `cacheDir`（默认 `~/.videograph/vocal-cache`）。同参数音符跨渲染直接复用——改动一个音符不再全片重算。`--no-cache` 关闭；渲染结果里 `cacheSummary.hits/misses` 如实报告命中情况。

## CLI

```bash
node src/vocal/cli.mjs check                                   # 自检：解析链结果 + 缺项指引
node src/vocal/cli.mjs make-ustx --plan plan.json --out song.ustx
node src/vocal/cli.mjs check-ustx --ustx song.ustx             # 结构自检
node src/vocal/cli.mjs make-ust --ustx song.ustx --out song.ust [--voice-dir DIR]
node src/vocal/cli.mjs render --ustx song.ustx --out vocal.wav [--work-dir DIR] [--bank DIR]
                            [--resampler PATH] [--resampler-contract classic|openutau] [--no-cache]
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
    "notes": [{
      "lyric": "a s",                 // M2 约定：必须是 oto 别名本身（CVVC 链式自动展开见下）
      "pitch": "C4",                  // 或 "tone": 60（C4=60，与 OpenUtau 一致）
      "startBeats": 0,                // 或 "startTick"（相对全曲绝对位置）
      "durationBeats": 1,             // 或 "durationTicks"；两者必填其一
      "pitchCurve": [{ "x": -40, "y": 0, "shape": "sp" }],  // 可选，默认平直滑音
      "vibrato": { "length": 40 }     // 可选，未给参数落 OpenUtau 默认
    }]
  }]
}
```

`lyric: "R"` 表示休止（渲染跳过）。音符时间重叠会被拒绝；part 位置自动对齐到首音符。

**CVVC 用法**：别名形态因声库而异（本机 Deepseek 声库：句首 `- か`、整音 `か`、过渡 `a s`/`a ky`、元音连接 `a あ`、拨音 `a ん`）。AI 写谱前先 `check` 看声库，再按别名表选词；自动音素展开（presamp.ini/phonemizer 等价物）在 M5。

## 渲染管线与 M2 状态

`render`：结构自检 → 逐音符 oto 别名查找 → 内容寻址缓存查命中 → 契约调用重采样器 → 重叠相加 → 44100Hz/16bit/单声道 WAV。

**M2 已真机验证**（2026-10-06，Deepseek CVVC fixed 声库 + worldline.exe）：7 音符 CVVC/VV 链端到端渲染成功；客观验证——时长符合公式、峰值 0.84 非静音、逐音符窗自相关基频随 C4→A4 上行（末两窗精确命中 441Hz）、二次渲染 7/7 缓存命中。

M2/M3 的已知近似（全部如实声明）：

- 音高固定平直（classic 契约省略音高弯曲参）；USTX 里写的 `pitchCurve` 自检通过但**渲染尚不使用**（M3，OpenUtau 按 5 tick 采样音高数组）。
- 包络为线性交叠（参考 `SharpWavtool` simple 模式），无相位补偿、无 p1–p5 包络（M3）；极端参数下可能有轻微 click。
- skipOver/durCorrection 按简化布局取 0（M2 布局下成立；TailIntrude/TailOverlap 精修属 M3）。
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
| `wavtool.mjs` | 重叠相加拼接 |
| `render.mjs` | 渲染编排 + 内容寻址缓存 |
| `cli.mjs` | 命令行入口 |

测试：`node --test scripts/tests/vocal/yaml.test.mjs scripts/tests/vocal/ustx.test.mjs scripts/tests/vocal/ust-oto.test.mjs scripts/tests/vocal/config.test.mjs scripts/tests/vocal/render.test.mjs scripts/tests/vocal/cli.test.mjs`（Windows 下 `node --test` 传具体文件路径，不传目录）。

## 许可边界

OpenUtau 为 MIT：本模块只引用格式与命令行契约知识，未复制其代码。声库（如本机 Deepseek CVVC fixed：**禁止二次配布**）与重采样器二进制由使用者提供，许可各自核对，不入库（同 CLAUDE.md 纪律）。

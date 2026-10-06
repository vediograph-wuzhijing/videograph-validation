# VOCAL — OpenUTAU 人声合成集成（VOCAL-M1）

> 计划、里程碑（VOCAL-M1～M5）与认领状态见 `ROADMAP.md` 第三节「VOCAL 冲刺」；本文只放使用与设计事实。

## 这是什么

`src/vocal/` 把 UTAU/OpenUTAU 生态封装成 AI 可用的歌声合成管线：写音符/歌词（plan JSON）→ 生成 USTX → 无头渲染人声 WAV。目标是替代"外部 TTS 凑合唱"的做法，并且**在生成音符时就拿到词级时间**（M3 接入工程后从源头解决歌词对齐，呼应改进建议 A1/A3）。

## 关键事实（2026-10-06 对 openutau/OpenUtau master 源码核对）

- **OpenUtau 没有官方无头渲染**（[issue #1615](https://github.com/openutau/OpenUtau/issues/1615)，closed as not planned；Core 库与 UI 有耦合）。所以本模块**不驱动 OpenUtau 本体渲染**，OpenUtau 安装只用于自检与 M2 互操作验证。
- 走**经典渲染契约自研管线**：USTX（YAML，`ustx_version: "0.10"`，snake_case）→ 逐音符按 OpenUtau `ExeResampler` 的 13 参命令行契约调用外部重采样器 → Node 内 wavtool（重叠相加）。
- 格式事实：分辨率固定 480 tick/拍；音高点 `{x: 毫秒(相对音符起点), y: 0.1半音, shape: io|lin|i|o|sp}`；默认滑音 Standard（-40ms/80ms）；颤音默认 period 175 / depth 25 / in 10 / out 10；标准表情 27 项（required：dyn/pitd/clr/eng/vel/vol/atk/dec；缩写含 `mod+`）。
- 我们写出的 USTX 全部为块式 YAML（OpenUtau 自己会混用流式，两种它都能读；本模块两种都能解析）。

## 配置（零硬编码路径）

解析优先级（高→低），任何一层配置后自动发现不再参与：

1. CLI 显式参数（`--resampler`、`--bank`、`--openutau-home`）
2. 环境变量：`VIDEOGRAPH_OPENUTAU_HOME`（安装目录）、`VIDEOGRAPH_OPENUTAU_RESAMPLER`（重采样器）、`VIDEOGRAPH_VOICEBANK_DIR`（声库）
3. 项目级 `.videograph/vocal.json`（**不要提交进 git：机器本地路径不入库**）
4. 用户级 `~/.videograph/vocal.json`
5. PATH 查找 → 平台标准安装位置（仅自动发现兜底）

`vocal.json` 示例：

```json
{
  "openutauHome": "D:/tools/OpenUtau",
  "resampler": "D:/tools/moresampler.exe",
  "voicebankDir": "D:/voicebanks/重音テト"
}
```

`resampler` 也可以是 argv 头数组（包装脚本、测试桩用）：`"resampler": ["node", "resampler-stub.mjs"]`。
注意：`.bat/.cmd` 不能被直接执行，请用 exe 或 argv 头数组包一层。

**渲染只需要 `resampler` 与 `voicebankDir`**；`openutauHome` 非必需。重采样器本体由使用者提供（任何实现 UTAU/OpenUtau 契约的 exe，如 moresampler），声库与重采样器的许可各自核对、不入库。

## CLI

```bash
node src/vocal/cli.mjs check                                   # 自检：解析链结果 + 缺项指引
node src/vocal/cli.mjs make-ustx --plan plan.json --out song.ustx
node src/vocal/cli.mjs check-ustx --ustx song.ustx             # 结构自检
node src/vocal/cli.mjs make-ust --ustx song.ustx --out song.ust [--voice-dir D:/banks/xxx]
node src/vocal/cli.mjs render --ustx song.ustx --out vocal.wav [--work-dir DIR] [--bank DIR] [--resampler PATH]
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
      "lyric": "ら",                  // M1 约定：必须是 oto 别名本身（CV 用法）
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

## 渲染管线与 M1 边界

`render`：结构自检 → 逐音符 oto 别名查找 → 契约调用重采样器（`input output 音名 velocity flags offset durRequired consonant cutoff volume modulation !tempo base64pitches`）→ 重叠相加 → 44100Hz/16bit/单声道 WAV。

M1 的已知近似（M2 逐项消掉，全部如实声明、不是完成态）：

- 音高固定平直（int12 全 0，5ms 密度）；USTX 里写的 `pitchCurve` 自检会通过，但**渲染尚不使用**。
- `durRequired = 音符时长 + overlap + 10ms`，是 OpenUtau `ResamplerItem` 语义的近似。
- 包络为线性交叠（参考 `SharpWavtool` simple 模式），无相位补偿，极端参数下可能有轻微 click。
- 仅支持单 voice_part；无渲染缓存（缓存键设计呼应改进建议 B2，属 M2）。
- 声库若带 subfolder oto，别名文件路径按各自 oto 所在目录解析。

## 模块地图

| 文件 | 职责 |
|---|---|
| `yaml-lite.mjs` | USTX（YAML）子集读写器：块式 + 流式映射，写出对齐 YamlDotNet |
| `ustx.mjs` | USTX 0.10 生成器、标准表情表、音名换算、结构自检 |
| `ust.mjs` | 经典 UST 文本写出（互操作） |
| `oto.mjs` | oto.ini 解析、声库扫描、别名字典 |
| `config.mjs` | 外部工具解析链（env → 配置文件 → PATH → 平台候选） |
| `wav.mjs` | 16-bit PCM WAV 读写 |
| `resampler.mjs` | 13 参契约调用 + int12 音高编码 |
| `wavtool.mjs` | 重叠相加拼接 |
| `render.mjs` | 渲染编排 |
| `cli.mjs` | 命令行入口 |

测试：`node --test scripts/tests/vocal/yaml.test.mjs scripts/tests/vocal/ustx.test.mjs scripts/tests/vocal/ust-oto.test.mjs scripts/tests/vocal/config.test.mjs scripts/tests/vocal/render.test.mjs scripts/tests/vocal/cli.test.mjs`（Windows 下 `node --test` 传具体文件路径，不传目录）。

## 许可边界

OpenUtau 为 MIT：本模块只引用格式与命令行契约知识，未复制其代码。声库、重采样器二进制由使用者提供，许可各自核对，不入库（同 CLAUDE.md 纪律）。

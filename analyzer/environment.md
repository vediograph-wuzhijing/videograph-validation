# analyzer/environment.md — 本地分析器运行环境（SONG-01）

> 建环境与下载模型前必须征得用户同意（ROADMAP SONG-01）。作者机基线：Windows、RTX 5070 Laptop 8GB（sm_120）、
> conda 25.5.1、ffmpeg 9 在 PATH（或 `FFMPEG_PATH`）、模型缓存统一 `<repo>/../.models`（`VIDEOGRAPH_MODELS_DIR` 可改，不进仓库）。

## 方案 A（默认，2026-10-02 用户已批准）：克隆现有 pytorch 环境

```sh
conda create -n videograph-analyzer --clone pytorch -y     # 复用 torch 2.8.0+cu128，免下 3GB
conda run -n videograph-analyzer python -m pip install -r analyzer/requirements-analyzer.txt
```

- 克隆约占 9GB。Python 3.9：依赖版本全部选仍支持 3.9 的（见 requirements）。
- qwen-asr 固定 `transformers==4.57.6`（与源环境一致）；`accelerate==1.12.0` 在克隆环境内升级。
- runner 找解释器的顺序：`VIDEOGRAPH_ANALYZER_PYTHON` → conda 环境 `videograph-analyzer`（由 `CONDA_PREFIX`/`CONDA_EXE`、常见安装位置或 `conda env list` 推出）→ PATH 上的 `python`。T3 同理（`VIDEOGRAPH_ANALYZER_T3_PYTHON` → `videograph-t3` → 主解释器）。
- 单次分析超时 `VIDEOGRAPH_ANALYZER_TIMEOUT_MS`（默认 30 分钟），超时结束整个进程树。

## 方案 B（A 出现依赖冲突时）：新建 Python 3.12 环境

```sh
conda create -n videograph-analyzer python=3.12 -y
conda run -n videograph-analyzer python -m pip install torch --index-url https://download.pytorch.org/whl/cu128   # ~3GB
conda run -n videograph-analyzer python -m pip install -r analyzer/requirements-analyzer.txt
```

B 下可升级 librosa 1.0 / demucs 4.1；版本变更必须同步 requirements 与 MODELS.md。

## macOS / Linux（Apple Silicon 已实测）

- 用 uv 建仓库内环境：`uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python torch==2.8.0 torchaudio==2.8.0 -r analyzer/requirements-analyzer.txt`，再把 `VIDEOGRAPH_ANALYZER_PYTHON` 指向 `.venv/bin/python`。
- 无 CUDA 时 beat_this 与 Qwen 自动走 CPU（M 系列芯片上 30 秒片段的识别 + 逐词对齐约 25 秒）。
- 模型默认放在仓库同级的 `.models`（`VIDEOGRAPH_MODELS_DIR` 可改）；访问不了 Hugging Face 时，Qwen 官方在 ModelScope 有同名仓库，下载后可按 HF 仓库 API 的 sha256 逐文件核对。

## 模型下载（逐项列出体积，用户同意后执行）

| 模型 | 体积（约） | 用途 | 许可状态 |
|---|---|---|---|
| beat_this 1.1.0 权重 | ~0.1GB | T1 节拍/下拍 | 代码与权重 MIT（README 声明）；训练数据部分受限，作者提示使用者自行判断 |
| Qwen/Qwen3-ForcedAligner-0.6B | ~1.2GB | T3 有歌词文本时强制对齐（中文字级/英文词级） | 模型卡标注 Apache-2.0；**实施时读权重仓库 LICENSE 原文存档后才算可商用** |
| Qwen/Qwen3-ASR-1.7B | ~3.5GB | T3 无文本时歌词草稿（fp16 推理约 4–5GB 显存，8GB 卡需实测） | 仓库 Apache-2.0；权重卡许可**待核实** |
| faster-whisper + large-v3 | 备选，默认不装 | ASR 兜底 | MIT（权重许可待核实） |

NC 或许可不明的（madmom、MMS_FA、whisperX 默认对齐模型、Demucs htdemucs 权重）不进默认链路；
Demucs 分轨（T2）只能由用户显式开启并记录在导出清单。

## 模型本地路径（local_dir 模式，绕开 Windows 符号链接特权）

权重不使用 hub 缓存快照（WinError 1314），统一实体拷贝：

- `<models>/local/qwen3-forced-aligner-0.6b`（环境变量 `VIDEOGRAPH_QWEN_ALIGNER_DIR`）
- `<models>/local/qwen3-asr-1.7b`（环境变量 `VIDEOGRAPH_QWEN_ASR_DIR`）
- `<models>/local/beat_this`（有 `.ckpt` 时直接加载，不走 torch.hub 下载）

`<models>` = `VIDEOGRAPH_MODELS_DIR`，默认仓库同级的 `.models`。`src/song/analyzer-runner.mjs` 启动子进程时注入这些默认值，`HF_HOME`/`TORCH_HOME` 默认也指向 `<models>`。
下载/续传：`python analyzer/download_models.py`（local_dir 模式；断线可直接重跑续传；任一模型失败退出码为 1）。

## 实测 API（qwen-asr 0.0.6，2026-10-02 于 T3 环境）

- 对齐：`Qwen3ForcedAligner.from_pretrained(path, dtype='float16', device_map='cuda')` → `align(audio, text, language='English')`（语言用全名，zh→Chinese）→ `result.items[].text/.start_time/.end_time`（秒）。**必须整篇歌词一次调用**（单行对全曲会把文本锚到音频开头）；时间戳粒度约 20ms。
- ASR：`Qwen3ASRModel.from_pretrained(path, dtype=..., device_map=...)` → `transcribe(audio, language='Chinese', return_time_stamps=True)` → `result.sentences[].text/.start_time/.end_time`。

## 自检

```sh
<analyzer-python> analyzer/doctor.py          # JSON 报告
<analyzer-python> analyzer/clicktrack_test.py # T1 验收：F≥0.98，bpm 误差 ≤0.5
```

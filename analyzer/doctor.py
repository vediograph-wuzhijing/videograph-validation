# doctor.py — SONG-01 环境自检：JSON 报告，不修改任何状态。
import json
import os
import platform
import shutil
import sys
from importlib.metadata import version as pkg_version, PackageNotFoundError
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from download_models import models_root  # noqa: E402

PACKAGES = ["librosa", "soundfile", "demucs", "beat_this", "faster_whisper", "qwen_asr", "transformers", "accelerate", "torch", "numpy", "scipy"]
MODELS = {
    "beat_this": ["beat_this"],
    "qwen3-forced-aligner-0.6b": ["qwen3-forced-aligner-0.6b", "models--qwen--qwen3-forcedaligner-0.6b", "qwen3-forcedaligner-0.6b"],
    "qwen3-asr-1.7b": ["qwen3-asr-1.7b", "models--qwen--qwen3-asr-1.7b"],
}


def model_present(names, roots):
    """大小写不敏感地找模型目录（macOS/Linux 文件系统区分大小写）。"""
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.is_dir() and any(name in path.name.lower() for name in names):
                return True
    return False


def main():
    report = {
        "python": platform.python_version(),
        "executable": sys.executable,
        "platform": platform.platform(),
        "packages": {},
        "cuda": {"available": False},
        "ffmpeg": None,
        "models": {},
        "cacheRoot": None,
        "disk": {},
    }
    for package in PACKAGES:
        try:
            report["packages"][package] = pkg_version(package.replace("_", "-") if package in ("beat_this", "qwen_asr", "faster_whisper") else package)
        except PackageNotFoundError:
            report["packages"][package] = None
    try:
        import torch
        report["cuda"]["available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info(0)
            report["cuda"].update({
                "device": torch.cuda.get_device_name(0),
                "capability": ".".join(map(str, torch.cuda.get_device_capability(0))),
                "vramFreeGB": round(free / 2**30, 2),
                "vramTotalGB": round(total / 2**30, 2),
                "sm120": torch.cuda.get_device_capability(0) >= (12, 0),
            })
    except Exception as error:
        report["cuda"]["error"] = str(error)
    ffmpeg = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    report["ffmpeg"] = ffmpeg
    root = models_root()
    cache_root = str(root)
    report["cacheRoot"] = cache_root
    roots = [root] + [Path(p) for p in {os.environ.get("HF_HOME"), os.environ.get("TORCH_HOME")} if p]
    for model, names in MODELS.items():
        report["models"][model] = model_present(names, roots)
    # Windows 按盘符；其他平台检查模型缓存所在磁盘（未配置时为仓库同级目录）
    targets = ("C:\\", "D:\\", "F:\\") if os.name == "nt" else (cache_root if Path(cache_root).exists() else str(Path(__file__).resolve().parents[2]),)
    for drive in targets:
        try:
            usage = shutil.disk_usage(drive)
            report["disk"][drive] = {"freeGB": round(usage.free / 2**30, 1), "totalGB": round(usage.total / 2**30, 1)}
        except OSError:
            pass
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

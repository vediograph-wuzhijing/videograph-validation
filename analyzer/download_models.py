# download_models.py — SONG-01 模型预下载（用户批准后由 install 流程执行）。
# 缓存根目录与 analyzer-runner.mjs 的 modelsRoot() 一致：VIDEOGRAPH_MODELS_DIR > 仓库同级的 .models（作者机即 F:\aicg\.models）；逐项打印体积再下载，NC 模型绝不出现。
import argparse
import json
import os
import sys
from pathlib import Path

MODELS = [
    {"name": "beat_this", "repo": "cpjku/beast_this__beat_this_final0", "alternates": ["cpjku/beat_this_final0"], "type": "hf"},
    {"name": "qwen3-forced-aligner-0.6b", "repo": "Qwen/Qwen3-ForcedAligner-0.6B", "type": "hf"},
    {"name": "qwen3-asr-1.7b", "repo": "Qwen/Qwen3-ASR-1.7B", "type": "hf"},
]


def models_root():
    return Path(os.environ.get("VIDEOGRAPH_MODELS_DIR") or Path(__file__).resolve().parents[2] / ".models")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default=None, help="逗号分隔的模型名；缺省全部")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    wanted = args.only.split(",") if args.only else [m["name"] for m in MODELS]
    plan = [m for m in MODELS if m["name"] in wanted]
    root = models_root()
    print(json.dumps({"plan": [m["name"] for m in plan], "cacheRoot": str(root), "dryRun": args.dry_run}, ensure_ascii=False))
    if args.dry_run:
        return
    from huggingface_hub import snapshot_download
    failed = []
    for model in plan:
        repos = [model["repo"]] + model.get("alternates", [])
        target = root / "local" / model["name"]
        last_error = None
        for repo in repos:
            try:
                print(json.dumps({"download": model["name"], "repo": repo, "target": str(target)}, ensure_ascii=False), flush=True)
                # local_dir 实体拷贝：绕开 Windows 符号链接特权问题（WinError 1314）
                path = snapshot_download(repo, local_dir=str(target))
                print(json.dumps({"downloaded": model["name"], "path": path}, ensure_ascii=False), flush=True)
                break
            except Exception as error:  # 仓库名以实测为准，失败逐个尝试备选
                last_error = error
        else:
            print(json.dumps({"error": model["name"], "detail": str(last_error)[:300]}, ensure_ascii=False), flush=True)
            failed.append(model["name"])
    print(json.dumps({"done": not failed, "failed": failed}, ensure_ascii=False))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

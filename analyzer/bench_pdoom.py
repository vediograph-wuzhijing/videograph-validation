# bench_pdoom.py — SONG-01/SONG-06 基准：pdoom 原 BGM 强制走新分析器，对比参考数据。
# 记录 beat F-measure；有对齐模型时再测词首时间中位/P90 误差。结果如实写入 ROADMAP（目标中位 ≤50ms）。
import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import analysis_lib as lib  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    script_dir = Path(__file__).parent
    default_root = script_dir.parent.parent / "pdoom-video"
    parser.add_argument("--audio", default=str(default_root / "audio" / "pdoom.mp3"))
    parser.add_argument("--reference-data", default=str(default_root / "data"))
    parser.add_argument("--lyrics-text", default=None, help="给出歌词文本则同时测 T3 词首误差")
    parser.add_argument("--language", default="en")
    parser.add_argument("--gpu", action="store_true", default=True)
    args = parser.parse_args()
    audio = Path(args.audio)
    reference = Path(args.reference_data)
    if not audio.exists():
        print(json.dumps({"error": f"音频不存在：{audio}"}))
        sys.exit(2)
    report = {"audio": str(audio), "reference": str(reference)}
    y = lib.load_mono(str(audio))
    beats, downbeats, bpm, method, confidence = lib.estimate_beats(y, audio_path=str(audio))
    report["t1"] = {
        "method": method, "confidence": confidence, "bpm": round(bpm, 3),
        "beats": len(beats), "downbeats": len(downbeats),
    }
    ref_audio_path = reference / "audio.json"
    if ref_audio_path.exists():
        reference_audio = json.loads(ref_audio_path.read_text(encoding="utf-8"))
        f_measure = lib.beat_f_measure(beats, reference_audio["beats"])
        report["t1"]["referenceBpm"] = reference_audio["bpm"]
        report["t1"]["beatFMeasureVsReference"] = round(f_measure, 4)
        report["t1"]["bpmErrorVsReference"] = round(abs(bpm - reference_audio["bpm"]), 3)
    if args.lyrics_text and (reference / "lyrics.json").exists():
        try:
            from analyze import align_with_qwen  # noqa: E402
            with tempfile.TemporaryDirectory() as tmp:
                wav = str(Path(tmp) / "audio.wav")
                import subprocess
                subprocess.run([os.environ.get("FFMPEG_PATH") or "ffmpeg", "-y", "-v", "error", "-i", str(audio), "-ar", str(lib.SR), wav], check=True, capture_output=True)
                import time
                started = time.time()
                aligned = align_with_qwen(wav, [line.strip() for line in args.lyrics_text.splitlines() if line.strip()], args.language, {"gpu": args.gpu})
                report["t3"] = {"seconds": round(time.time() - started, 1)}
            reference_lyrics = json.loads((reference / "lyrics.json").read_text(encoding="utf-8"))
            # 按行配对：对齐器可能把缩写拆成多个 token，跨行扁平索引配对会被错位污染。
            # 行首误差（每行第一个 token vs 参考行首词）免疫 token 数差异；词级只在词数相同的行内比较。
            line_errors = []
            word_errors = []
            for index, line in enumerate(aligned):
                if index >= len(reference_lyrics["lines"]) or not line:
                    continue
                reference_line = reference_lyrics["lines"][index]
                line_errors.append(abs(line[0]["start"] - reference_line["words"][0]["start"]) * 1000)
                if len(line) == len(reference_line["words"]):
                    for predicted, reference_word in zip(line, reference_line["words"]):
                        word_errors.append(abs(predicted["start"] - reference_word["start"]) * 1000)
            def stats(values):
                if not values:
                    return None
                ordered = sorted(values)
                return {"count": len(ordered), "median": round(ordered[len(ordered) // 2], 1), "p90": round(ordered[int(len(ordered) * 0.9)], 1)}
            report["t3"].update({
                "lineStartErrorMs": stats(line_errors),
                "wordOnsetErrorMs": stats(word_errors),
                "targetMedianMs": 50,
            })
        except Exception as error:
            report["t3"] = {"error": str(error)[:400]}
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

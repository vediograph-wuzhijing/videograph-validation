# analyze.py — SONG-01 分析 CLI：读 job JSON，跑 T0/T1/T3，产出 videograph-analysis/v2（原子写）。
# 用法：python analyze.py --spec job.json
# spec: {audioPath, outDir, stages?["t0","t1","t3","assemble"], language?, lyricsText?, lrcPath?, gpu?, title?}
# 每个阶段把 partial 写进 outDir（t0.json/t1.json/t3.json），因此 T0/T1 与 T3 可以分属两个解释器
# （T3 依赖 py3.12 的 qwen-asr；见 analyzer/environment.md）。stdout 输出进度 JSON 行。
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import analysis_lib as lib  # noqa: E402

SCHEMA = "videograph-analysis/v2"
ANALYZER_VERSION = "song01-v1"


def emit(message):
    print(json.dumps(message, ensure_ascii=False, allow_nan=False), flush=True)


def ffmpeg_bin():
    return os.environ.get("FFMPEG_PATH") or "ffmpeg"


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_partial(out_dir, name):
    path = out_dir / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def write_partial(out_dir, name, data):
    (out_dir / name).write_text(json.dumps(data, ensure_ascii=False, allow_nan=False), encoding="utf-8")


def stage_t0(spec, out_dir):
    """解码为 44.1k WAV；decoderOffset 按 ffmpeg gapless 约定为 0（与 pdoom 参考时间轴同一约定）。"""
    existing = read_partial(out_dir, "t0.json")
    if existing and Path(existing["wav"]).exists():
        emit({"stage": "t0", "status": "reused"})
        return existing
    emit({"stage": "t0", "status": "running"})
    wav = out_dir / "t0-decoded.wav"
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-i", spec["audioPath"], "-ar", str(lib.SR), wav],
                   check=True, capture_output=True)
    import soundfile as sf
    info = sf.info(wav)
    t0 = {"wav": str(wav), "duration": float(info.duration), "sampleRate": int(info.samplerate),
          "channels": int(info.channels), "decoderOffset": 0.0}
    write_partial(out_dir, "t0.json", t0)
    emit({"stage": "t0", "status": "done", "duration": t0["duration"], "sampleRate": t0["sampleRate"], "channels": t0["channels"]})
    return t0


def stage_t1(spec, out_dir):
    t0 = read_partial(out_dir, "t0.json")
    if not t0:
        raise RuntimeError("T1 需要 T0 的解码结果；请先跑 t0 阶段")
    emit({"stage": "t1", "status": "running"})
    started = time.time()
    y = lib.load_mono(t0["wav"])
    envelopes, fps, _ = lib.compute_envelopes(y)
    onsets = lib.percussion_onsets(y)
    # gpu=True 时交给 analysis_lib 自动选择（有 CUDA 用 CUDA，否则 CPU）；直接传 "cuda" 会在无 CUDA 的机器上让 beat_this 回退到 librosa
    device = None if spec.get("gpu", True) else "cpu"
    beats, downbeats, bpm, method, confidence = lib.estimate_beats(y, audio_path=t0["wav"], device=device)
    sections = lib.estimate_sections(y, downbeats=downbeats)
    t1 = {
        "envelopes": {**envelopes, "frameRate": fps},
        "onsets": onsets,
        "rhythm": {"beats": beats, "downbeats": downbeats, "bpm": bpm, "meter": 4, "method": method, "confidence": confidence},
        "sections": sections,
        "seconds": round(time.time() - started, 1),
    }
    write_partial(out_dir, "t1.json", t1)
    emit({"stage": "t1", "status": "done", "method": method, "bpm": bpm, "beats": len(beats), "sections": len(sections), "seconds": t1["seconds"]})
    return t1


def parse_lrc(text):
    import re
    lines = []
    for raw in text.splitlines():
        match = re.match(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$", raw.strip())
        if match:
            minutes, seconds, content = match.groups()
            lines.append({"start": int(minutes) * 60 + float(seconds), "text": content.strip()})
    return lines


def stage_t3(spec, out_dir):
    t0 = read_partial(out_dir, "t0.json")
    if not t0:
        raise RuntimeError("T3 需要 T0 的解码结果；请先跑 t0 阶段")
    emit({"stage": "t3", "status": "running"})
    started = time.time()
    language = spec.get("language") or "zh"
    text_lines, text_source = None, "asr"
    if spec.get("lyricsText"):
        text_source = "user"
        text_lines = [{"start": None, "text": line.strip()} for line in spec["lyricsText"].splitlines() if line.strip()]
    elif spec.get("lrcPath"):
        text_source = "lrc"
        text_lines = parse_lrc(Path(spec["lrcPath"]).read_text(encoding="utf-8"))
        if not text_lines:
            raise RuntimeError("LRC 里没有可解析的时间戳行")
    segments = analysis_segments(spec, t0, out_dir)
    if text_lines:
        if language in ("zh", "yue", "en"):
            aligned = align_lines_segmented(segments, [line["text"] for line in text_lines], language, spec)
        else:
            aligned = align_lines_sliding(t0["wav"], t0["duration"], [line["text"] for line in text_lines], language, spec)
        lines = fill_unaligned_lines([line["text"] for line in text_lines], aligned, t0["duration"])
        fallback = [index for index, line in enumerate(lines) if line.get("fallback")]
        result = {"lyrics": {"language": language, "textSource": text_source, "humanConfirmed": True, "lines": lines}, "mode": "align-segmented"}
        if fallback:
            result["fallbackLines"] = fallback
            result["warnings"] = [f"{len(fallback)} 行未能对齐，已按相邻行内插、词按字数摊开（conf 0.3），请在校正界面核对：第 {', '.join(str(i + 1) for i in fallback)} 行"]
    else:
        result = {"lyrics": transcribe_segmented(segments, language, spec), "mode": "asr-draft", "draft": True,
                  "warnings": ["ASR 歌词是草稿：必须经人确认后才能用于规划"]}
    result["seconds"] = round(time.time() - started, 1)
    write_partial(out_dir, "t3.json", result)
    emit({"stage": "t3", "status": "done", "mode": result["mode"], "seconds": result["seconds"]})
    return result


LANGUAGE_NAMES = {"zh": "Chinese", "en": "English", "yue": "Cantonese", "ja": "Japanese", "ko": "Korean"}


def _load_qwen_aligner(spec):
    """按实测 API：Qwen3ForcedAligner.from_pretrained(path) → align(audio, text, language)。"""
    try:
        from qwen_asr import Qwen3ForcedAligner  # type: ignore
    except ImportError as error:
        raise RuntimeError(f"qwen_asr 未安装或 API 变化（{error}）；请核对 qwen-asr 包文档后更新 analyzer/analyze.py 的 align_with_qwen") from error
    import torch
    path = os.environ.get("VIDEOGRAPH_QWEN_ALIGNER_DIR") or "Qwen/Qwen3-ForcedAligner-0.6B"
    kwargs = {"torch_dtype": torch.float16} if spec.get("gpu", True) and torch.cuda.is_available() else {}
    kwargs["device_map"] = "cuda" if spec.get("gpu", True) and torch.cuda.is_available() else "cpu"
    return Qwen3ForcedAligner.from_pretrained(path, **kwargs)


def _result_items(result):
    """ForcedAlignResult / list / dict 的统一 token 提取。"""
    items = getattr(result, "items", None)
    if items is None and isinstance(result, list):
        items = result
    return items or []


def align_with_qwen(wav, texts, language, spec):
    """Qwen3-ForcedAligner：整篇歌词一次调用 → 按行切分 token。

    实测语义（2026-10-02）：单行对全曲会把文本锚到音频开头（必须全文一次调用）；
    全文调用对长歌有单调漂移（pdoom 中位 ~6.8s）——分段对齐是达标路径（30s 段实测 <40ms），
    见 MODELS.md「对齐基准」。本函数返回的行时间按 token 顺序切分，供草稿/短歌使用。
    """
    aligner = _load_qwen_aligner(spec)
    lang_name = LANGUAGE_NAMES.get(language, language)
    output = aligner.align(wav, text="\n".join(texts), language=lang_name)
    tokens = []
    for item in _result_items(output[0] if isinstance(output, list) else output):
        text = str(getattr(item, "text", "") or "").strip()
        if not text:
            continue
        tokens.append({"w": text, "start": float(getattr(item, "start_time", 0.0)), "end": float(getattr(item, "end_time", 0.0)),
                       "conf": float(getattr(item, "confidence", 0.9))})
    # 按各行的词数切分 token 流（对齐器逐词出 token，与输入词序一致）
    results = []
    cursor = 0
    for text in texts:
        count = len(text.split())
        chunk = tokens[cursor:cursor + count]
        cursor += count
        results.append(chunk)
    return results


SEGMENT_SECONDS = 28.0
CJK_PUNCT = "。！？；，、,.!?;"


def _segment_audio(wav_path, duration, boundaries):
    """按边界切 ~SEGMENT_SECONDS 的 wav 段，返回 [(offset, path)]；临时文件由调用方清理。"""
    import soundfile as sf
    import librosa
    segments = []
    y, sr = librosa.load(wav_path, sr=16000, mono=True)
    cuts = [b for b in boundaries if 0.5 < b < duration - 0.5]
    if not cuts:
        cuts = [min(SEGMENT_SECONDS, duration / 2)]
    starts = [0.0]
    for cut in cuts:
        if cut - starts[-1] >= SEGMENT_SECONDS * 0.8:
            starts.append(cut)
    starts.append(duration)
    work = Path(wav_path).parent
    for index, (start, end) in enumerate(zip(starts, starts[1:])):
        path = work / f"t3-seg-{index:03d}.wav"
        sf.write(path, y[int(start * sr):int(end * sr)], sr)
        segments.append({"start": start, "end": end, "wav": str(path)})
    return segments


def analysis_segments(spec, t0, out_dir):
    """T3 分段：优先用 T1 下拍（读 t1.json）作边界，否则等时长切。"""
    t1 = read_partial(out_dir, "t1.json")
    boundaries = []
    if t1:
        boundaries = [d for d in t1.get("rhythm", {}).get("downbeats", [])]
    duration = t0["duration"]
    if not boundaries:
        count = max(1, round(duration / SEGMENT_SECONDS))
        boundaries = [duration * (i + 1) / count for i in range(count)]
    return _segment_audio(t0["wav"], duration, boundaries)


def _split_sentences(text):
    """ASR 文本切行：句末标点优先，逗号/顿号次之（中文唱词常只有逗号）。"""
    import re
    parts = re.split(r"(?<=[。！？；，、,.!?;])\s*", text)
    return [part.strip() for part in parts if part.strip()]


def _token_count(text):
    """中文按字符、西文按词计 token 配额。"""
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
    if cjk * 2 >= len(text.replace(" ", "")):
        return cjk
    return len(text.split())


LINE_WINDOW = 12.0


def _line_tokens(text):
    """兜底摊开用的词切分：中文按字、西文按空格（与 _token_count 同口径）。"""
    stripped = text.replace(" ", "")
    cjk = sum(1 for ch in stripped if "一" <= ch <= "鿿")
    if stripped and cjk * 2 >= len(stripped):
        return [ch for ch in stripped if ch not in CJK_PUNCT] or [stripped]
    return text.split() or [text.strip() or "…"]


def fill_unaligned_lines(texts, aligned, duration):
    """对齐失败的行：行界按前后已对齐行内插（连续失败行按字数分配间隙），词按字数比例摊开，
    conf 0.3 并标 fallback，交给人工校正。最后做单调钳制，保证通过契约（非空词、行首递增）。"""
    lines = [{"text": text, "words": list(aligned[i]) if i < len(aligned) and aligned[i] else []} for i, text in enumerate(texts)]
    index = 0
    while index < len(lines):
        if lines[index]["words"]:
            index += 1
            continue
        run_end = index
        while run_end < len(lines) and not lines[run_end]["words"]:
            run_end += 1
        gap_start = lines[index - 1]["words"][-1]["end"] if index > 0 else 0.0
        gap_end = lines[run_end]["words"][0]["start"] if run_end < len(lines) else duration
        if gap_end - gap_start < 0.1 * (run_end - index):
            gap_end = min(duration, gap_start + 0.1 * (run_end - index))
        weights = [max(1, len(lines[i]["text"].replace(" ", ""))) for i in range(index, run_end)]
        cursor = gap_start
        for offset, line_index in enumerate(range(index, run_end)):
            span = (gap_end - gap_start) * weights[offset] / sum(weights)
            tokens = _line_tokens(lines[line_index]["text"])
            sizes = [max(1, len(token)) for token in tokens]
            words, at = [], cursor
            for token, size in zip(tokens, sizes):
                step = span * size / sum(sizes)
                words.append({"w": token, "start": round(at, 3), "end": round(min(duration, at + step), 3), "conf": 0.3})
                at += step
            lines[line_index] = {"text": lines[line_index]["text"], "words": words, "fallback": True}
            cursor += span
        index = run_end
    fixed = _monotonic_lines(lines)
    for line in fixed:
        line["end"] = min(line["end"], duration)
        line["start"] = min(line["start"], line["end"])
    return fixed


def align_lines_sliding(wav, duration, texts, language, spec):
    """逐行锚点验证对齐： ForcedAligner 特征窗 30s，实测 ≥27s 大段在部分语言（日语实测）
    上塌缩（全零时间戳），且文本不在窗口内时会把词锚到窗口端点（假对齐、conf 不可用）。
    协议：候选锚点 = 人声带攻击点（HPSS melodic 起点，实测数据）+ 先验位置采样；
    对每个候选把该行文本对齐到 [锚-1.2, 锚+LINE_WINDOW] 窗口，只有当返回行跨度
    贴住锚点（±0.45s）、时长与字数相称且相对上一行单调时才接受（可证伪的一致性检查，
    假对齐会被端点偏置暴露）。全部候选失败 → 行界按邻居内插、词按字数比例摊（conf 0.3
    的 draft，待人校正），不伪造精度。"""
    aligner = _load_qwen_aligner(spec)
    lang_name = LANGUAGE_NAMES.get(language, language)
    import librosa
    import numpy as np
    import soundfile as sf
    y, sr = librosa.load(wav, sr=16000, mono=True)
    # 人声带攻击点（与 percussion_onsets 同源的 melodic 证据，只是这里按行锚候选复用）
    sys.path.insert(0, str(Path(__file__).parent))
    import analysis_lib as lib
    vocal_hits = [t for t, s in lib.percussion_onsets(y, sr)["vocal"] if s > 0.15]

    def expected_dur(text):
        return min(6.5, max(0.9, 0.145 * len(text.replace(" ", ""))))

    def try_candidate(index, cand, prev_start):
        w0 = max(0.0, cand - 1.2)
        w1 = min(duration, cand + LINE_WINDOW)
        if w1 - w0 < 2.5:
            return None
        path = Path(wav).parent / f"t3-line-{index}.wav"
        sf.write(path, y[int(w0 * sr):int(w1 * sr)], sr)
        try:
            output = aligner.align(path, text=texts[index], language=lang_name)
            items = _result_items(output[0] if isinstance(output, list) else output)
            tokens = []
            for item in items:
                piece = str(getattr(item, "text", "") or "").strip()
                st = w0 + float(getattr(item, "start_time", 0.0))
                en = w0 + float(getattr(item, "end_time", 0.0))
                if piece:
                    tokens.append({"w": piece, "start": st, "end": max(en, st), "conf": 0.8})
        except Exception:
            tokens = []
        finally:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        if not tokens:
            return None
        s0, s1 = tokens[0]["start"], tokens[-1]["end"]
        span = s1 - s0
        exp = expected_dur(texts[index])
        if abs(s0 - cand) > 0.45:            # 行起点必须贴住候选锚（端点偏置的假对齐过不了）
            return None
        if span < 0.45 * exp or span > 2.5 * exp + 0.8:  # 时长与字数相称
            return None
        if prev_start is not None and s0 < prev_start + 0.25:  # 行序单调
            return None
        return tokens

    results = []
    prev_start = None
    prior = 0.0
    prior_step = 5.5
    for index, text in enumerate(texts):
        cands = [t for t in vocal_hits if prior - 1.5 <= t <= prior + 9.0]
        cands = sorted(set(cands))[:6]
        if not cands or (not cands or cands[0] > prior + 2.0):
            cands = [prior] + cands
        got = None
        for cand in cands:
            got = try_candidate(index, cand, prev_start)
            if got:
                break
        if got:
            results.append(got)
            prev_start = got[0]["start"]
            prior = got[-1]["end"] + 0.15
        else:
            results.append([])  # 空词：由 stage_t3 按邻居内插兜底并标 draft
            prior += prior_step
    return results


def align_lines_segmented(segments, texts, language, spec):
    """用户文本路径：把行按时长比例分配到各段，段内整段对齐（30s 段实测 40ms 达标）。
    行归属是比例近似（段内精确）；段边界行的误差由 SONG-02 人工校正兜底。
    （日语等语言在大段上会拿到全零时间戳 conf=-1，这类语言由 stage_t3 分流到逐行滑窗。）"""
    aligner = _load_qwen_aligner(spec)
    lang_name = LANGUAGE_NAMES.get(language, language)
    total = sum(seg["end"] - seg["start"] for seg in segments)
    # 最大余数分配：段数多于行数时允许某段 0 行，配额不会出现负数。
    exact = [len(texts) * (seg["end"] - seg["start"]) / total for seg in segments]
    quota = [int(value) for value in exact]
    for i in sorted(range(len(exact)), key=lambda i: exact[i] - quota[i], reverse=True)[:len(texts) - sum(quota)]:
        quota[i] += 1
    results = [[]] * len(texts)
    cursor = 0
    for seg, count in zip(segments, quota):
        chunk_texts = texts[cursor:cursor + count]
        if not chunk_texts:
            continue
        try:
            output = aligner.align(seg["wav"], text="\n".join(chunk_texts), language=lang_name)
            tokens = []
            for item in _result_items(output[0] if isinstance(output, list) else output):
                text = str(getattr(item, "text", "") or "").strip()
                if not text:
                    continue
                tokens.append({"w": text, "start": seg["start"] + float(getattr(item, "start_time", 0.0)),
                               "end": seg["start"] + float(getattr(item, "end_time", 0.0)), "conf": 0.8})
            inner = 0
            for text in chunk_texts:
                take = _token_count(text)
                results[cursor + inner] = tokens[:take]
                tokens = tokens[take:]
                inner += 1
        except Exception:
            for inner in range(len(chunk_texts)):
                results[cursor + inner] = []
        cursor += count
    return results


def transcribe_segmented(segments, language, spec):
    """ASR 草稿路径：逐段转写，时间戳加段偏移，按标点切行（humanConfirmed=False）。"""
    from qwen_asr import Qwen3ASRModel
    import torch
    asr_dir = os.environ.get("VIDEOGRAPH_QWEN_ASR_DIR") or "Qwen/Qwen3-ASR-1.7B"
    aligner_dir = os.environ.get("VIDEOGRAPH_QWEN_ALIGNER_DIR") or "Qwen/Qwen3-ForcedAligner-0.6B"
    use_cuda = spec.get("gpu", True) and torch.cuda.is_available()
    kwargs = {"dtype": torch.float16, "device_map": "cuda"} if use_cuda else {}
    model = Qwen3ASRModel.from_pretrained(asr_dir, forced_aligner=aligner_dir, **kwargs)
    lang_name = LANGUAGE_NAMES.get(language, language)
    lines = []
    try:
        for seg in segments:
            outputs = model.transcribe(seg["wav"], language=lang_name, return_time_stamps=True)
            output = outputs[0] if outputs else None
            tokens = []
            for item in _result_items(getattr(output, "time_stamps", None)):
                text = str(getattr(item, "text", "") or "").strip()
                if not text:
                    continue
                tokens.append({"w": text, "start": seg["start"] + float(getattr(item, "start_time", 0.0)),
                               "end": seg["start"] + float(getattr(item, "end_time", 0.0)), "conf": 0.7})
            for sentence in _split_sentences(str(getattr(output, "text", "") or "")):
                count = _token_count(sentence)
                chunk = tokens[:count]
                tokens = tokens[count:]
                lines.append({
                    "text": sentence,
                    "start": chunk[0]["start"] if chunk else seg["start"],
                    "end": chunk[-1]["end"] if chunk else seg["end"],
                    "words": chunk,
                })
    finally:
        for seg in segments:
            try:
                Path(seg["wav"]).unlink(missing_ok=True)
            except OSError:
                pass
    return {"language": language, "textSource": "asr", "humanConfirmed": False, "lines": _monotonic_lines(lines)}


def _monotonic_lines(lines):
    """段间衔接：分段产出可能在段边界时间回退，做全局不减钳制并重算行界。
    只抬不压——段内误差 ~100ms 级，钳制不会放大漂移；契约要求行按时间排列。"""
    fixed = []
    prev_end = 0.0
    for line in lines:
        words = []
        for word in line.get("words", []):
            start = max(float(word["start"]), prev_end)
            end = max(float(word["end"]), start)
            words.append({**word, "start": start, "end": end})
            prev_end = end
        if words:
            fixed.append({**line, "start": words[0]["start"], "end": words[-1]["end"], "words": words})
        else:
            fixed.append({**line, "start": max(float(line.get("start", 0.0)), prev_end), "end": max(float(line.get("end", 0.0)), prev_end)})
    return fixed


def assemble(spec, out_dir):
    t0, t1, t3 = (read_partial(out_dir, name) for name in ("t0.json", "t1.json", "t3.json"))
    if not t0 or not t1:
        raise RuntimeError("assemble 需要 t0.json 与 t1.json")
    started = spec.get("startedAt") or int(time.time() * 1000)
    rhythm = t1["rhythm"]
    provenance = {
        "audio": {"tool": "videograph-analyzer", "version": ANALYZER_VERSION, "startedAt": started, "confidence": 1.0, "params": {"decoder": "ffmpeg gapless（与 pdoom 参考时间轴同一约定）"}},
        "rhythm": {"tool": "videograph-analyzer", "version": ANALYZER_VERSION, "startedAt": started, "confidence": rhythm["confidence"], "model": rhythm["method"], "params": {"fps": t1["envelopes"]["frameRate"]}},
        "sections": {"tool": "videograph-analyzer", "version": ANALYZER_VERSION, "startedAt": started, "confidence": 0.4, "params": {"method": "ssm-novelty", "labels": "unknown（由人在校正界面命名）"}},
        "envelopes": {"tool": "videograph-analyzer", "version": ANALYZER_VERSION, "startedAt": started, "confidence": 0.9, "params": {"window": lib.WIN / lib.SR, "smooth": [lib.SMOOTH_ATTACK, lib.SMOOTH_RELEASE], "normalize": "p99-clip"}},
        "onsets": {"tool": "videograph-analyzer", "version": ANALYZER_VERSION, "startedAt": started, "confidence": 0.7, "params": {"method": "hpss+band-flux"}},
    }
    analysis = {
        "schema": SCHEMA,
        "title": spec.get("title") or Path(spec["audioPath"]).stem,
        "audio": {"hash": sha256_file(spec["audioPath"]), "duration": t0["duration"], "sampleRate": t0["sampleRate"], "channels": t0["channels"], "decoderOffset": t0["decoderOffset"]},
        "rhythm": {"bpm": rhythm["bpm"], "beats": rhythm["beats"], "downbeats": rhythm["downbeats"], "meter": rhythm["meter"], "confidence": rhythm["confidence"]},
        "sections": t1["sections"],
        "envelopes": t1["envelopes"],
        "onsets": t1["onsets"],
        "overrides": [],
        "provenance": provenance,
    }
    if t3 and "lyrics" in t3:
        analysis["lyrics"] = t3["lyrics"]
        analysis["provenance"]["lyrics"] = {
            "tool": "videograph-analyzer", "version": ANALYZER_VERSION, "startedAt": started, "confidence": 0.6,
            "model": "Qwen3-ForcedAligner-0.6B" if str(t3.get("mode", "")).startswith("align") else "Qwen3-ASR-1.7B",
            "params": {"mode": t3.get("mode"), "draft": bool(t3.get("draft")), "fallbackLines": len(t3.get("fallbackLines", []))},
        }
    output = out_dir / "analysis-v2.json"
    temporary = out_dir / f".analysis-v2.{os.getpid()}.tmp"
    temporary.write_text(json.dumps(analysis, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, output)
    emit({"stage": "all", "status": "done", "file": str(output)})
    return analysis


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    args = parser.parse_args()
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    out_dir = Path(spec["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    stages = spec.get("stages") or ["t0", "t1", "t3", "assemble"]
    wants_t3 = "t3" in stages and (spec.get("lyricsText") or spec.get("lrcPath") or spec.get("asr"))
    if "t0" in stages:
        stage_t0(spec, out_dir)
    if "t1" in stages:
        if not read_partial(out_dir, "t0.json"):
            stage_t0(spec, out_dir)
        stage_t1(spec, out_dir)
    if wants_t3:
        if not read_partial(out_dir, "t0.json"):
            stage_t0(spec, out_dir)
        stage_t3(spec, out_dir)
    if "assemble" in stages:
        assemble(spec, out_dir)
    elif "t0" in stages and "t1" not in stages:
        emit({"stage": "partial", "status": "done", "note": "仅完成部分阶段"})


if __name__ == "__main__":
    main()

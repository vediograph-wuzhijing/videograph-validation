# analysis_lib.py — SONG-01 共享分析库：包络/鼓点/节拍/段落。
# 方法论对齐 pdoom 参考分析（100fps、46ms RMS 窗、单极平滑、99 分位归一化、HPSS 频段攻击点），
# 但不复制其手调常量；所有参数显式写出并进入 provenance。
import bisect
import numpy as np

SR = 44100
ENV_FPS = 100
HOP = int(SR * 0.01)          # 10ms 帧移
WIN = int(SR * 0.046)         # 46ms RMS 窗（≈pdoom）
SMOOTH_ATTACK = 0.010         # s
SMOOTH_RELEASE = 0.090        # s
BAND_LOW = 150.0              # Hz（low/mid 分界）
BAND_HIGH = 4000.0            # Hz（mid/high 分界）
KICK_MAX = 120.0
SNARE_LO, SNARE_HI = 1500.0, 5000.0
HAT_MIN = 7000.0


def load_mono(path, sr=SR):
    import librosa
    y, _ = librosa.load(path, sr=sr, mono=True)
    return y


def _one_pole(values, attack_s, release_s):
    a = float(np.exp(-1.0 / (attack_s * ENV_FPS)))
    r = float(np.exp(-1.0 / (release_s * ENV_FPS)))
    out = np.empty_like(values)
    acc = values[0]
    for i, v in enumerate(values):
        acc = a * acc + (1 - a) * v if v > acc else r * acc + (1 - r) * v
        out[i] = acc
    return out


def _normalize(values):
    peak = float(np.percentile(values, 99))
    if peak <= 1e-9:
        return np.zeros_like(values)
    return np.clip(values / peak, 0.0, 1.0)


def compute_envelopes(y, sr=SR, fps=ENV_FPS):
    """rms/low/mid/high 包络：STFT 频段能量 + 单极平滑 + 99 分位归一化（0..1）。"""
    import librosa
    hop = int(sr * 0.01)
    n_fft = 4096
    stft = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    band = lambda lo, hi: np.sum(stft[(freqs >= lo) & (freqs < hi)] ** 2, axis=0)
    energy = {
        "low": band(0, BAND_LOW),
        "mid": band(BAND_LOW, BAND_HIGH),
        "high": band(BAND_HIGH, sr / 2 + 1),
    }
    rms = librosa.feature.rms(y=y, frame_length=WIN, hop_length=hop)[0] ** 2
    frames = min(len(rms), min(len(v) for v in energy.values()))
    out = {}
    for key, values in [("low", energy["low"]), ("mid", energy["mid"]), ("high", energy["high"])]:
        smoothed = _one_pole(values[:frames], SMOOTH_ATTACK, SMOOTH_RELEASE)
        out[key] = _normalize(smoothed).astype(float).tolist()
    rms_smooth = _one_pole(rms[:frames], SMOOTH_ATTACK, SMOOTH_RELEASE)
    out["rms"] = _normalize(rms_smooth).astype(float).tolist()
    return out, fps, hop / sr


def _band_attacks(y, sr, lo, hi):
    import librosa
    S = np.abs(librosa.stft(y, n_fft=4096, hop_length=int(sr * 0.01)))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=4096)
    mask = (freqs >= lo) & (freqs < hi)
    flux = np.maximum(0.0, np.diff(S[mask], axis=1)).sum(axis=0)
    # 静音/该频段无能量：delta=0 时 peak_pick 会把平台当峰，强度再除以 0 得 NaN。
    if flux.size == 0 or float(flux.max()) <= 1e-9:
        return []
    peaks = librosa.util.peak_pick(flux, pre_max=8, post_max=8, pre_avg=16, post_avg=16, delta=flux.max() * 0.05, wait=10)
    times = librosa.frames_to_time(peaks, sr=sr, hop_length=int(sr * 0.01))
    peak_values = flux[peaks] if len(peaks) else np.array([])
    top = float(peak_values.max()) if len(peak_values) else 0.0
    if top <= 1e-9:
        return []
    strengths = peak_values / top * 0.9 + 0.05
    return [(float(t), float(s)) for t, s in zip(times, strengths)]


def _near(t, events, window):
    return any(abs(t - other) <= window for other, _ in events)


def percussion_onsets(y, sr=SR):
    """kick/snare/hat 攻击点（[time, strength]）：HPSS 打击成分 + 频段 flux 峰。
    vocal onset 无分轨时用「全混音中低频 onset − 已归入鼓组的事件」近似（provenance 标 hpss+band-flux）。"""
    import librosa
    percussive, _ = librosa.effects.hpss(y)
    kick = _band_attacks(percussive, sr, 20, KICK_MAX)
    snare = _band_attacks(percussive, sr, SNARE_LO, SNARE_HI)
    hat = _band_attacks(percussive, sr, HAT_MIN, sr / 2)
    hat = [(t, s) for t, s in hat if not _near(t, snare, 0.04) and not _near(t, kick, 0.03)]
    harmonic, _ = librosa.effects.hpss(y)
    melodic = [(t, s) for t, s in _band_attacks(harmonic, sr, 150, HAT_MIN)
               if not _near(t, kick, 0.03) and not _near(t, snare, 0.04) and not _near(t, hat, 0.03)]
    return {"kick": kick, "snare": snare, "hat": hat, "vocal": melodic}


def estimate_beats(y, sr=SR, meter=4, audio_path=None, device=None):
    """节拍/下拍：优先 beat_this（GPU 可用更快），失败回退 librosa beat_track + 相位推算（低置信）。"""
    import librosa
    try:
        beats, downbeats, method, confidence = _beats_via_beat_this(audio_path, device)
        if beats is not None and len(beats) > 4:
            # BPM 取拍位置线性拟合斜率：网格局部吸附有抖动，长程速率才是真实 BPM
            fit_bpm = 60.0 / float(np.polyfit(np.arange(len(beats)), np.asarray(beats, dtype=float), 1)[0])
            return list(map(float, beats)), list(map(float, downbeats)), fit_bpm, method, confidence
    except Exception as beat_this_error:  # 模型缺失/显存不足都回退，provenance 记录真实方法
        import sys as _sys
        print(f'WARNING beat_this fallback: {beat_this_error}', file=_sys.stderr)
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="time", trim=False)
    tempo_value = float(np.atleast_1d(tempo)[0])
    # 八度校正：对 t/2、t、2t 候选按「匹配到的 kick/snare 事件强度均值」评分——
    # 2× 网格在真实音乐里一半落在 hat/空档（强度≈0），均值减半即被淘汰；错拍半速时 2× 网格仍全踩强拍。
    onsets = percussion_onsets(y, sr)
    strong = sorted([(t, s) for key in ("kick", "snare") for t, s in onsets[key]])
    strong_times = [t for t, _ in strong]

    def grid_score(grid):
        total = 0.0
        for t in grid:
            best = 0.0
            index = bisect.bisect_left(strong_times, t - 0.06)
            while index < len(strong_times) and strong_times[index] <= t + 0.06:
                best = max(best, strong[index][1])
                index += 1
            total += best
        return total / max(1, len(grid))

    scored = []
    for candidate in (tempo_value / 2, tempo_value, tempo_value * 2):
        if not (20 <= candidate <= 400):
            continue
        _, grid = librosa.beat.beat_track(y=y, sr=sr, bpm=float(candidate), units="time", trim=False)
        if len(grid) < 4:
            continue
        scored.append((float(candidate), grid_score(np.asarray(grid, dtype=float)), np.asarray(grid, dtype=float)))
    if not scored:
        # 无节奏证据（静音/自由节拍/极短）：给常速网格的低置信草稿，由人在校正界面改，而不是让整份分析过不了契约。
        return fallback_grid(len(y) / sr, tempo_value, meter)
    best_score = max(score for _, score, _ in scored)
    qualified = [entry for entry in scored if entry[1] >= max(0.7 * best_score, 0.4)]
    if qualified:
        bpm_value, score, beats = max(qualified, key=lambda entry: entry[0])
        method, confidence = "librosa.beat_track+phase+octave", 0.5
    else:
        # 倍半评分不可信（最优网格也够不到绝对门槛）：librosa 的 tempo 先验在八度/附点上
        # 会选错（实测同一首歌 22.05k=161 / 44.1k=110），改用常速网格直搜；
        # 起始点太少搜不出网格才退回 librosa 原速网格。provenance 如实记录方法与置信度。
        grid = _onset_grid_beats(y, sr, onsets)
        if grid is not None:
            beats, method, confidence = grid, "onset-grid(constant-tempo)", 0.45
        else:
            beats = next((entry[2] for entry in scored if abs(entry[0] - tempo_value) < 1e-6), scored[0][2])
            method, confidence = "librosa.beat_track(no-octave,weak-percussion)", 0.3
    beats = np.asarray(beats, dtype=float)
    if len(beats) < 2:
        return fallback_grid(len(y) / sr, tempo_value, meter)
    strength_at = lambda t: max((s for events in onsets.values() for other, s in events if abs(other - t) < 0.05), default=0.0)
    best_offset, best_score = 0, -1.0
    for offset in range(meter):
        score = sum(strength_at(t) for i, t in enumerate(beats) if (i - offset) % meter == 0)
        if score > best_score:
            best_offset, best_score = offset, score
    downbeats = [float(t) for i, t in enumerate(beats) if (i - best_offset) % meter == 0]
    # BPM 取拍位置的线性拟合斜率：网格局部有抖动，长程速率才是真实 BPM
    fit_bpm = 60.0 / float(np.polyfit(np.arange(len(beats)), np.asarray(beats), 1)[0])
    return beats.tolist(), downbeats, fit_bpm, method, confidence


def fallback_grid(duration, tempo=0.0, meter=4):
    """常速兼底网格：tempo 不可信时取 120 BPM；置信度 0.1，method 如实标注。"""
    bpm = float(tempo) if 40.0 <= float(tempo or 0.0) <= 240.0 else 120.0
    period = 60.0 / bpm
    count = max(1, int(max(duration, 0.0) / period))
    beats = [round(i * period, 4) for i in range(count)]
    return beats, beats[::meter], bpm, "fallback-grid(no-rhythm-evidence)", 0.1


def _onset_grid_beats(y, sr, onsets):
    """常速拍网格直搜：谱通量起始包络自相关取拍级周期锚（0.30–0.67s），±10% 扫描，
    每周期 24 相位等步搜索；得分 = 网格点 ±60ms 内 kick/snare 命中强度均值
    （一维膨胀 max 向量化）。感知速度带（0.333–0.667s）内 ≥70% 全局最优分的候选优先
    （八度/附点歧义按惯例向人耳 tempo 收敛）；选中后近邻吸附一轮 + 线性拟合细化周期
    （DAW 常速曲目拍距恒定）。返回 (beats, method, confidence)；证据不足返回 None。"""
    import librosa
    from scipy.ndimage import maximum_filter1d
    strong = sorted([(t, s) for key in ("kick", "snare") for t, s in onsets[key]])
    if len(strong) < 16:
        return None
    times = np.asarray([t for t, _ in strong], dtype=float)
    res = 0.01
    bins = np.zeros(int(times.max() / res) + 2)
    np.add.at(bins, (times / res).astype(int), np.asarray([s for _, s in strong], dtype=float))
    dilated = maximum_filter1d(bins, size=13, mode="constant")  # ±60ms 窗口内最大命中强度

    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=512)
    env = env - float(env.mean())
    autocorr = np.correlate(env, env, "full")[len(env) - 1:]
    autocorr /= max(float(autocorr[0]), 1e-9)
    env_fps = sr / 512.0
    lo, hi = int(0.30 * env_fps), int(0.67 * env_fps) + 1
    if hi - lo < 8 or hi >= len(autocorr):
        return None
    anchor = float(np.argmax(autocorr[lo:hi]) + lo) / env_fps
    periods = [anchor * (1.0 + k * 0.002) for k in range(-50, 51)]  # ±10% 步长 0.2%
    best = best_band = None  # (score, period, phase)
    for period in periods:
        for phase in np.arange(0.0, period, period / 24.0):
            grid = np.arange(phase, bins.size * res, period)
            idx = (grid / res).astype(int)
            if idx.size == 0:
                continue
            score = float(dilated[idx].mean())
            if best is None or score > best[0]:
                best = (score, period, float(phase))
            if 0.333 <= period <= 0.667 and (best_band is None or score > best_band[0]):
                best_band = (score, period, float(phase))
    if best is None:
        return None
    score, period, phase = best_band if best_band is not None and best_band[0] >= 0.7 * best[0] else best
    beats = np.arange(phase, bins.size * res, period)
    pos = np.searchsorted(times, beats)
    snapped = []
    for i, beat in enumerate(beats):
        window = times[max(pos[i] - 3, 0):min(pos[i] + 4, len(times))]
        nearest = window[np.argmin(np.abs(window - beat))] if window.size else beat
        snapped.append(nearest if abs(nearest - beat) <= 0.08 else beat)
    snapped = np.asarray(snapped)
    if len(snapped) >= 8:
        slope = float(np.polyfit(np.arange(len(snapped)), snapped, 1)[0])
        if 0.5 * period <= slope <= 2.0 * period:
            period = slope
            beats = phase + np.arange(len(snapped)) * period
        else:
            beats = snapped
    if len(beats) < 8:
        return None
    return beats


def _local_beat_this_checkpoint():
    """download_models.py 下到 <models>/local/beat_this 的权重；离线机器有它就不走 torch.hub 下载。"""
    import os
    from pathlib import Path
    root = Path(os.environ.get("VIDEOGRAPH_MODELS_DIR") or Path(__file__).resolve().parents[2] / ".models")
    folder = root / "local" / "beat_this"
    found = sorted(folder.glob("final0*.ckpt")) or sorted(folder.glob("*.ckpt")) if folder.is_dir() else []
    return str(found[0]) if found else None


def _beats_via_beat_this(audio_path, device):
    import torch
    if device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        from beat_this.inference import File2Beats  # type: ignore
    except ImportError:
        from beat_this.inference.file2beats import File2Beats  # type: ignore
    f2b = File2Beats(checkpoint_path=_local_beat_this_checkpoint() or "final0", device=device)
    beats, downbeats = f2b(audio_path)
    return np.asarray(beats), np.asarray(downbeats), "beat_this(final0,%s)" % device, 0.9


def estimate_sections(y, sr=SR, downbeats=None, fps_hint=1.0):
    """段落：色度+MFCC 自相似矩阵 → 棋盘核新颖度曲线 → 峰值切分，吸附最近下拍。标签 v1=unknown。"""
    import librosa
    hop = int(sr * 1.0)  # 1s 分辨率足够段落级
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=hop)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=hop, n_mfcc=12)
    features = np.vstack([chroma, mfcc / (np.abs(mfcc).max() + 1e-9)])
    if features.shape[-1] < 2 * 8 + 1:  # 短音频（约 17 秒以下）不足以做 width=8 的自相似分析：整首一段
        return [{"start": 0.0, "end": len(y) / sr, "label": "unknown", "confidence": 0.3}]
    S = librosa.segment.recurrence_matrix(features, width=8, mode="affinity", metric="cosine", sym=True)
    # 新颖度：沿主对角线的亲和度差分（棋盘核的稳定近似，无额外依赖）
    diag = np.array([S[i, i + 8] if i + 8 < S.shape[0] else 0.0 for i in range(S.shape[0] - 8)])
    novelty = np.abs(np.diff(diag, n=1))
    if len(novelty) < 4:
        return [{"start": 0.0, "end": len(y) / sr, "label": "unknown", "confidence": 0.3}]
    peaks = librosa.util.peak_pick(novelty, pre_max=12, post_max=12, pre_avg=24, post_avg=24, delta=novelty.max() * 0.2, wait=20)
    bounds = sorted({0.0} | {float(p) for p in peaks} | {len(y) / sr})
    if downbeats:
        snapped = []
        for b in bounds:
            if b in (0.0, len(y) / sr):
                snapped.append(b)
                continue
            nearest = min(downbeats, key=lambda d: abs(d - b))
            snapped.append(float(nearest) if abs(nearest - b) <= 4.0 else b)
        bounds = sorted(set(snapped))
    return merge_short_sections(bounds, len(y) / sr)


def merge_short_sections(bounds, duration, min_len=5.0):
    """短段并入相邻段（不丢弃），保证段落首尾相接覆盖 [0, duration]。"""
    cuts = sorted({b for b in bounds if 0.0 < b < duration})
    edges = [0.0] + cuts + [duration]
    merged = [edges[0]]
    for edge in edges[1:-1]:
        if edge - merged[-1] >= min_len:
            merged.append(edge)
    if len(merged) > 1 and duration - merged[-1] < min_len:
        merged.pop()
    merged.append(duration)
    if len(merged) == 2:
        return [{"start": 0.0, "end": duration, "label": "unknown", "confidence": 0.3}]
    return [{"start": float(s), "end": float(e), "label": "unknown", "confidence": 0.4} for s, e in zip(merged, merged[1:])]


def beat_f_measure(predicted, reference, tolerance=0.07):
    """拍点 F 值（±tolerance 秒匹配）。"""
    if not predicted or not reference:
        return 0.0
    matched, used = 0, set()
    for t in predicted:
        for i, r in enumerate(reference):
            if i not in used and abs(t - r) <= tolerance:
                matched += 1
                used.add(i)
                break
    precision, recall = matched / len(predicted), matched / len(reference)
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0

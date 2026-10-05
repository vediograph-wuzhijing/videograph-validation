// planner.mjs — SONG-04 新歌镜头规划：通用切点生成 + 服务端校验。不绑定 pdoom 歌词。
// 切点规则（对齐 pdoom cutAtLine 的通用化）：歌词行 → 行首词之前的最近拍；器乐段 → 小节线/段落边界；
// 切点量化到输出帧；绝不落在一个词的中间。所有时间从分析数据推导，agent 的数字只作参考，不进结果。
import { SongError } from './contract.mjs';

export const DEFAULT_SHOT_RANGE = { min: 2, max: 12 };
const EPS = 1e-6;

const wordsOf = (analysis) => (analysis.lyrics?.lines ?? []).flatMap((line) => line.words.map((word) => ({ ...word, text: line.text })));

const midWord = (analysis, t) => wordsOf(analysis).some((word) => word.start + EPS < t && t < word.end - EPS);

function previousBeat(analysis, t) {
  const beats = analysis.rhythm.beats;
  let candidate = null;
  for (const beat of beats) {
    if (beat <= t + EPS) candidate = beat;
    else break;
  }
  return candidate;
}

function snapToFrame(t, fps) {
  return Math.round(t * fps) / fps;
}

/** 锚点先量化到帧，再重新检查词窗口；量化后落词中时继续回退到前一拍。 */
function safeBeatCut(analysis, beat, fps, label) {
  if (beat !== null) {
    const cut = Math.max(0, snapToFrame(beat, fps));
    if (!midWord(analysis, cut)) return cut;
  }
  const beats = analysis.rhythm.beats;
  for (let index = beats.length - 1; index >= 0; index--) {
    if (beat === null || beats[index] > beat + EPS) continue;
    const cut = Math.max(0, snapToFrame(beats[index], fps));
    if (!midWord(analysis, cut)) return cut;
  }
  const cut = snapToFrame(0, fps);
  if (!midWord(analysis, cut)) return cut;
  throw new SongError(`切点无法避开词中间${label ? `（${label}）` : ''}`);
}

/** 单个切点：锚定行（lineIndex，或 lineText[+occurrence]）→ 行首词之前最近拍，帧吸附后仍避开词；器乐锚定段落起点。 */
export function cutFromAnchor(analysis, anchor, { fps = 30 } = {}) {
  const duration = analysis.audio.duration;
  if (anchor.lineIndex !== undefined || anchor.lineText !== undefined) {
    const lines = analysis.lyrics?.lines ?? [];
    let line;
    if (anchor.lineIndex !== undefined) {
      line = Number.isInteger(anchor.lineIndex) ? lines[anchor.lineIndex] : undefined;
      if (!line) throw new SongError(`锚定歌词行不存在：#${anchor.lineIndex}`);
    } else {
      const exact = lines.filter((entry) => entry.text === anchor.lineText);
      const matches = exact.length ? exact : lines.filter((entry) => entry.text.includes(anchor.lineText));
      if (!matches.length) throw new SongError(`锚定歌词行不存在：「${String(anchor.lineText).slice(0, 60)}」`);
      // 重复的副歌不能默默选第一遍：那会把后面的切点拉回前面。
      if (anchor.occurrence === undefined && matches.length > 1) throw new SongError(`歌词行「${String(anchor.lineText).slice(0, 40)}」出现 ${matches.length} 次，请用 occurrence（1 起）或 lineIndex 指定`);
      line = matches[(anchor.occurrence ?? 1) - 1];
      if (!line) throw new SongError(`歌词行「${String(anchor.lineText).slice(0, 40)}」没有第 ${anchor.occurrence} 次出现（共 ${matches.length} 次）`);
    }
    return safeBeatCut(analysis, previousBeat(analysis, line.words[0].start), fps, `行「${line.text.slice(0, 40)}」`);
  }
  if (anchor.sectionIndex !== undefined) {
    const section = analysis.sections[anchor.sectionIndex];
    if (!section) throw new SongError(`锚定段落不存在：#${anchor.sectionIndex}`);
    return safeBeatCut(analysis, section.start, fps, `段落 #${anchor.sectionIndex}`);
  }
  if (anchor.t !== undefined) {
    const cut = snapToFrame(anchor.t, fps);
    if (cut < 0 || cut > duration) throw new SongError(`切点越界：${cut}`);
    if (midWord(analysis, cut)) throw new SongError(`切点 ${cut}s 落在一个词的中间`);
    return cut;
  }
  throw new SongError('切点需要 lineIndex/lineText/sectionIndex/t 之一');
}

/** 候选切点全集（给 agent 的选择菜单）：歌词行切点 + 段落边界 + 小节线，升序去重。 */
export function candidateCutPoints(analysis, { fps = 30, shotRange = DEFAULT_SHOT_RANGE } = {}) {
  const candidates = new Set();
  (analysis.lyrics?.lines ?? []).forEach((line, index) => {
    try {
      const cut = cutFromAnchor(analysis, { lineIndex: index }, { fps });
      candidates.add(cut);
    } catch { /* 行首词前无可用拍时跳过，不阻塞候选集 */ }
  });
  analysis.sections.forEach((section, index) => {
    if (section.start > 0) {
      try { candidates.add(cutFromAnchor(analysis, { sectionIndex: index }, { fps })); } catch { /* ignore */ }
    }
  });
  for (const downbeat of analysis.rhythm.downbeats) {
    try { candidates.add(safeBeatCut(analysis, downbeat, fps, '小节线')); } catch { /* ignore */ }
  }
  return [...candidates].sort((a, b) => a - b);
}

/**
 * 校验 agent 提交的规划并归一化成镜头窗口。
 * plan: [{ lineIndex | lineText(+occurrence) | sectionIndex | t, id?, title?, prompt? }]；时间一律由锚点从分析数据推导。
 * 返回 { shots, warnings }；shots: [{ id, title, start, end, anchor, status: 'needs-generation', source: 'ai-original' }]。
 */
export function validatePlan(plan, analysis, { fps = 30, shotRange = DEFAULT_SHOT_RANGE } = {}) {
  if (!Array.isArray(plan) || plan.length < 2) throw new SongError('规划至少需要 2 个镜头');
  if (plan.length > 60) throw new SongError('镜头数过多（>60），请拆分规划');
  const duration = analysis.audio.duration;
  const warnings = [];
  const cuts = [];
  plan.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new SongError(`plan[${index}] 必须是对象`);
    const cut = cutFromAnchor(analysis, entry, { fps });
    if (index > 0 && cut > duration - 1 / fps + EPS) throw new SongError(`plan[${index}] 切点 ${cut}s 距曲尾不足一帧（时长 ${duration}s），会产生空镜头`);
    if (index === 0 && cut !== 0) {
      warnings.push(`plan[0] 锚点切点为 ${cut}s，已强制为 0（覆盖全曲）`);
      cuts.push(0);
    } else {
      cuts.push(cut);
    }
  });
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] <= cuts[i - 1] + EPS) throw new SongError(`plan[${i}] 切点 ${cuts[i]}s 未严格递增（前一刀 ${cuts[i - 1]}s）`);
  }
  cuts.push(duration);
  const shots = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i], end = cuts[i + 1];
    const length = end - start;
    if (length <= EPS) throw new SongError(`镜头 ${i + 1} 时长为 ${length.toFixed(3)}s`);
    if (length < shotRange.min - EPS) warnings.push(`镜头 ${i + 1} 时长 ${length.toFixed(2)}s 低于建议下限 ${shotRange.min}s`);
    if (length > shotRange.max + EPS) warnings.push(`镜头 ${i + 1} 时长 ${length.toFixed(2)}s 超过建议上限 ${shotRange.max}s（请确认或拆分）`);
    const entry = plan[i];
    const anchor = entry.lineIndex !== undefined ? `歌词行 #${entry.lineIndex}`
      : entry.lineText !== undefined ? `歌词行「${String(entry.lineText).slice(0, 30)}」${entry.occurrence ? `第 ${entry.occurrence} 次` : ''}`
      : entry.sectionIndex !== undefined ? `段落 #${entry.sectionIndex}` : `t=${start.toFixed(2)}s`;
    shots.push({
      id: entry.id && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(entry.id) ? entry.id : `shot${String(i + 1).padStart(2, '0')}`,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim().slice(0, 60) : `镜头 ${i + 1}`,
      prompt: typeof entry.prompt === 'string' && entry.prompt.trim() ? entry.prompt.trim().slice(0, 12000) : '',
      start, end, anchor,
      status: 'needs-generation',
      source: 'ai-original',
    });
  }
  const ids = new Set();
  for (const shot of shots) {
    if (ids.has(shot.id)) throw new SongError(`镜头 id 重复：${shot.id}`);
    ids.add(shot.id);
  }
  return { shots, warnings };
}

/** 确定性兜底规划：每段一个镜头。仅用于测试/兜底，明确标注不是 AI 创作。 */
export function planFromSections(analysis, { fps = 30, shotRange = DEFAULT_SHOT_RANGE } = {}) {
  const duration = analysis.audio.duration;
  const cuts = [0, ...analysis.sections.flatMap((section, index) => {
    if (section.start <= EPS || section.start >= duration - EPS) return [];
    const cut = cutFromAnchor(analysis, { sectionIndex: index }, { fps });
    return cut > EPS && cut < duration - EPS ? [cut] : [];
  })];
  const unique = [...new Set(cuts)].sort((a, b) => a - b);
  if (unique[unique.length - 1] !== duration) unique.push(duration);
  const shots = [];
  for (let i = 0; i < unique.length - 1; i++) {
    const start = unique[i], end = unique[i + 1];
    if (end - start < shotRange.min - EPS && i > 0) {
      shots[shots.length - 1].end = end;
      continue;
    }
    shots.push({
      id: `section${String(i + 1).padStart(2, '0')}`,
      title: `段落 ${i + 1}`,
      prompt: `确定性兜底规划（非 AI 创作）：整段一镜，段落 ${analysis.sections.find((s) => s.start <= start + EPS && s.end > start + EPS)?.name ?? 'unknown'}。`,
      start, end,
      anchor: `段落 #${i}`,
      status: 'needs-generation',
      source: 'fallback-deterministic',
    });
  }
  return { shots, warnings: shots.some((shot) => shot.end - shot.start > shotRange.max + EPS) ? ['兜底规划存在超长镜头，仅用于测试'] : [] };
}

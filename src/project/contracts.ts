// Shared wire/view contracts; no browser, transport or UI dependencies.
export type FeedbackAspect = 'composition' | 'motion' | 'typography' | 'color' | 'timing' | 'lyrics' | 'other';
export interface FeedbackAnchor { t?: number; range?: { start: number; end: number }; lyricElementId?: string; region?: { x: number; y: number; w: number; h: number }; aspect?: FeedbackAspect }
export interface FeedbackThreadEntry { by: 'human' | 'mcp'; kind: 'question' | 'reply'; text: string; at: number }
export interface FeedbackResponse { outcome: 'addressed' | 'partial'; how: string; by: 'human' | 'mcp'; at: number; codeHash: string }
export interface ProjectFeedback {
  id: string; text: string; status: 'pending' | 'needs-clarification' | 'responded' | 'accepted'; baseInputRevision: number;
  author?: 'human' | 'mcp'; anchor?: FeedbackAnchor; preserve?: string[]; thread?: FeedbackThreadEntry[]; response?: FeedbackResponse;
}
export interface LyricElement { id?: string; name: string; quote: string; meaning: string; treatment: string; kind: 'entity' | 'action' | 'metaphor'; cueWord?: string; cue?: { word: string; start: number; end: number } }
export interface LyricPlan { summary: string; elements: LyricElement[]; instrumental?: boolean; status?: string }
export interface ShotLyricContext { lines: Array<{ lineIndex: number; text: string; start: number; end: number; words: Array<{ w: string; start: number; end: number }> }>; instrumental: boolean; rule: string }
export interface ProjectTransition {
  id: string; fromShotId: string; toShotId: string; intent: string; mode: 'cut' | 'dissolve' | 'wipe' | 'dip' | 'effect'; duration: number;
  easing: 'linear' | 'smooth'; direction: 'left' | 'right'; inputRevision: number; inputToken: string; status: string; locked: boolean;
  feedback?: ProjectFeedback[]; reviewBaseline?: { mode: string }; validation?: { samples: number; thumb: string; leftInputToken?: string; rightInputToken?: string };
}
export interface ProjectShot {
  id: string;
  title: string;
  module: string;
  start: number;
  end: number;
  params: Record<string, unknown>;
  prompt: string;
  inputRevision: number;
  inputToken: string;
  source: string;
  status: string;
  locked: boolean;
  feedback?: ProjectFeedback[];
  lyricPlan?: LyricPlan;
  effects?: Array<{ id: string; name: string; params: Record<string, unknown>; kind: string }>;
  reviewBaseline?: { module: string; validation?: { thumb: string } };
  reviewBaselineSources?: { left: Record<string, unknown>; right: Record<string, unknown> };
  validation?: { samples: number; thumb: string; checkedAt: number };
}
export interface SongSection { name: string; start: number; end: number }
export interface SongLine { text: string; start: number; end: number; words?: Array<{ w: string; start: number; end: number }> }
export interface VideoProject {
  analysisQuality?: {blocked:boolean;unreliableCount:number;totalLines:number;warnings:string[];tempoCandidates:number[]};
  id: string;
  name: string;
  revision: number;
  engineHash: string;
  audio: { name: string; hash: string };
  /** 新歌工程的阶段状态（SONG-05）；参考导入工程没有该字段。 */
  status?: 'analysis-pending' | 'analysis-failed' | 'analysis-draft' | 'analysis-confirmed' | 'planned';
  analysis: {
    source: string;
    note: string;
    error?: string;
    confirmedBy?: 'human' | 'mcp';
    stages?: string[];
    task?: string;
    cached?: boolean;
  };
  /** 新歌分析完成前歌曲派生数据尚未发布，必须允许为 null。 */
  song: { song: string; duration: number; bpm: number; sections?: SongSection[]; beats?: number[]; lines?: SongLine[] } | null;
  output: { fps: number; samples: number };
  credits: string;
  shots: ProjectShot[];
  transitions: ProjectTransition[];
}

export interface DirectorBrief {
  intent: string;
  audience: string;
  mustKeep: string[];
  mustAvoid: string[];
}
export interface DirectorStyle {
  medium: unknown;
  palette: unknown;
  typography: unknown;
  composition: unknown;
  motion: unknown;
  motif: unknown;
}
export interface DirectorRhythmSection { sectionIndex: number; energy: number; intent: string }
export interface DirectorShotPlan { shotId: string; subject: string; action: string; entrance: string; exit: string }
export interface DirectorPlan {
  version: string | number;
  brief: DirectorBrief;
  style: DirectorStyle;
  rhythm: { sections: DirectorRhythmSection[]; accents: unknown[] };
  shots: DirectorShotPlan[];
  [key: string]: unknown;
}
export interface DirectorAction {
  id: string;
  kind: string;
  targetKind?: string;
  targetId?: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  blocked?: boolean;
}
export interface DirectorReviewEvidence { jobId: string; file?: string; [key: string]: unknown }
export interface DirectorReviewIssue { severity: 'blocking' | 'warning' | 'intentional'; targetId?: string; t?: number; detail?: string }
export interface DirectorReview { current: boolean; humanAccepted?: boolean; acceptedAt?: number; summary?: string; evidence?: DirectorReviewEvidence[]; issues?: DirectorReviewIssue[] }
export interface DirectorSnapshot {
  projectId: string;
  revision: number;
  director: DirectorPlan | null;
  phase: string;
  actions: DirectorAction[];
  blockers: string[];
  review: DirectorReview;
  exportReady: boolean;
}

export interface AnalysisSummary {
  projectId?: string;
  status?: string;
  inputRevision: number;
  data: { audio?: { duration: number }; rhythm?: { bpm?: number; beats: number[]; downbeats: number[] }; sections?: SongSection[]; lyrics?: { lines: { text: string; start: number }[] } };
}
export interface StillsImage { t: number; file: string }
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted' | 'cancelled';
export interface CacheSummary { reused: number; rendered: number; reasons?: Record<string, number> }
export interface StillsSummary { targetKind: 'shot' | 'transition'; targetId: string; times: number[]; version: 'current' | 'before-feedback'; width: number }
export interface ProjectJob {
  id: string;
  kind: 'validate' | 'validate-transition' | 'export' | 'stills' | 'filmstrip' | 'contact-sheet' | 'rhythm' | 'analysis' | 'vocal';
  status: JobStatus;
  progress: number;
  detail?: string;
  error?: string;
  inputRevision: number;
  shotId?: string;
  transitionId?: string;
  stills?: StillsSummary;
  result?: { file?: string; frames?: number; seconds?: number; reports?: Array<{ cached: boolean; shotId?: string; missReason?: string[] }>; stills?: { images: StillsImage[] }; cacheSummary?: CacheSummary };
}
export interface ProjectSummary { id: string; name: string; shots: number; duration: number; revision: number }

export interface VocalMix {
  backingGain: number; vocalGain: number;
  processing?: {
    eq?: { lowCutHz?: number; lowGainDb?: number; midHz?: number; midGainDb?: number; highGainDb?: number };
    compressor?: { thresholdDb?: number; ratio?: number; attackMs?: number; releaseMs?: number; makeupDb?: number };
    reverb?: { wet?: number; decayMs?: number; roomSize?: number; damping?: number };
    exciter?: {amount?: number; frequencyHz?: number; drive?: number};
    saturation?: {amount?: number; drive?: number};
    doubling?: {wet?: number; delayMs?: number; depthMs?: number; rateHz?: number};
  };
}
export interface VocalPitchQuality {
  method: string; timingSource: string;
  summary: { voicedFrames: number; scoredFrames: number; medianAbsTargetErrorCents: number | null; p95AbsTargetErrorCents: number | null };
  notes: { index: number; lyric: string; tone: number; voicedCoverage: number; medianTargetErrorCents: number | null; p95AbsTargetErrorCents: number | null;
    expectedVibratoRateHz: number | null; measuredModulation: { rateHz: number | null; depthCents: number } | null }[];
  limitations: string[];
}
export interface VocalOutput {
  jobId: string; mixFile: string; stemFile: string; ustxFile: string | null; lrcFile: string | null; pitchReportFile?: string | null; bandReportFile?: string;
  lyrics: { lines: unknown[] } | null;
  report: { source?: string; noteCount?: number; bank?: { name: string }; warnings?: string[]; cacheSummary?: { hits: number; misses: number }; pitchQuality?: VocalPitchQuality };
}
export interface VocalState { projectRevision: number; inputRevision: number; draft: { source?: string; plan: Record<string, unknown> | null; mix: VocalMix } | null; candidate: VocalOutput | null; active: VocalOutput | null }
export interface VocalSetup { ready: boolean; error?: string; bank?: string; aliases?: string[]; aliasCount?: number }

// UI loading state is separate from the persisted director snapshot.
export type DirectorLoadState = {
  projectId: string;
  status: 'loading' | 'ready' | 'absent' | 'error';
  snapshot?: DirectorSnapshot;
  error?: string;
};

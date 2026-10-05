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

export class ProjectApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'ProjectApiError'; }
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
  kind: 'validate' | 'validate-transition' | 'export' | 'stills' | 'filmstrip' | 'contact-sheet' | 'rhythm' | 'analysis';
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

export const serviceUrl = (import.meta.env.VITE_VIDEOGRAPH_SERVICE_URL || 'http://127.0.0.1:5191').replace(/\/$/, '');
let token = '';
async function authorize() {
  let response: Response;
  try { response = await fetch(`${serviceUrl}/session`, { signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error(`无法连接本地工程服务（${serviceUrl}），请运行 npm run service`); }
  if (response.status === 403) throw new Error(`工程服务拒绝了当前页面来源 ${location.origin}：把它加入 VIDEOGRAPH_STUDIO_ORIGINS，或用 5188 端口打开审阅室`);
  if (!response.ok) throw new Error(`工程服务 /session 返回 HTTP ${response.status}`);
  token = (await response.json() as { token: string }).token;
}
// 非 JSON 响应（端口被别的程序占用、代理 502 页）要给出状态码，而不是 "Unexpected token <"。
async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) { token = ''; throw new ProjectApiError('工程服务已重启，请重试以重新连接', response.status); }
  const text = await response.text();
  let data: { error?: string } | null = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应，下面按状态码报错 */ }
  if (!response.ok) throw new ProjectApiError(data?.error ?? `HTTP ${response.status}${text ? `：${text.slice(0, 120)}` : ''}`, response.status);
  if (data === null) throw new ProjectApiError(`工程服务返回了非 JSON 响应（HTTP ${response.status}）`, response.status);
  return data as T;
}
export async function projectApi<T>(path: string, body?: unknown): Promise<T> {
  if (!token) await authorize();
  const response = await fetch(serviceUrl + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return readResponse<T>(response);
}
export async function importBgm(file: File): Promise<VideoProject> {
  if (!token) await authorize();
  const response = await fetch(`${serviceUrl}/import-audio`, { method: 'POST', signal: AbortSignal.timeout(300000), headers: { authorization: `Bearer ${token}`, 'x-file-name': encodeURIComponent(file.name) }, body: file });
  return readResponse<VideoProject>(response);
}
export const projectFile = (projectId: string, file: string) => `${serviceUrl}/projects/${encodeURIComponent(projectId)}/files/${file.split('/').map(encodeURIComponent).join('/')}`;

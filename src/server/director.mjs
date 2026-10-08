import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readProject, mutateProject, listJobs, readJob, projectDir, sha256, ProjectError } from './project-store.mjs';
import { analysisIdentity, productionIdentity, scopeIdentity } from './project-signatures.mjs';

const dimensions = ['composition', 'hierarchy', 'readability', 'semantics', 'rhythm', 'consistency', 'originality'];
const tools = { analysis: 'song_analysis_get', retry: 'song_analysis_retry', direction: 'project_director_submit', plan: 'project_plan_submit', generate: 'project_shot_source', transition: 'project_transition_get', validate: 'project_validate', 'validate-transition': 'project_transition_validate', stills: 'project_stills', filmstrip: 'project_filmstrip', rhythm: 'project_rhythm_report', 'contact-sheet': 'project_contact_sheet', review: 'project_review_submit', export: 'project_render' };
const check = (ok, text, status = 400) => { if (!ok) throw new ProjectError(text, status); };
const text = (value, name, max = 4000) => { check(typeof value === 'string' && value.trim() && value.length <= max, `${name} 需要非空文本（≤${max} 字符）`); return value.trim(); };
const object = (value, name) => { check(value && typeof value === 'object' && !Array.isArray(value), `${name} 需要对象`); return value; };
const strings = (value, name) => { check(Array.isArray(value) && value.length <= 20 && value.every((v) => typeof v === 'string' && v.length <= 300), `${name} 需要最多20项短文本`); return value; };
const signature = (value) => sha256(JSON.stringify(value));

// 签名缓存只在一次同步的只读计算（getDirector）内有效：期间不改任何工程对象，作用域结束即丢弃，写路径永远实时计算。
// 不加缓存时每个任务都要对整份歌曲分析（含包络，约 0.5MB）重复做 SHA-256，258 个任务的工程一次读取约 4.7 秒并阻塞服务。
let memoScope = null;
function memo(owner, key, compute) {
  if (!memoScope || !owner || typeof owner !== 'object') return compute();
  let entries = memoScope.get(owner);
  if (!entries) memoScope.set(owner, entries = new Map());
  if (!entries.has(key)) entries.set(key, compute());
  return entries.get(key);
}
function withSignatureMemo(read) {
  if (memoScope) return read();
  memoScope = new WeakMap();
  try { return read(); } finally { memoScope = null; }
}
export function analysisSignature(project) { return memo(project, 'analysis', () => analysisIdentity(project)); }
// 旧任务快照可能缺 shots/transitions（2026-09-30 前的反馈流程）；缺数组按空算，签名自然不匹配而非崩溃。
export function productionSignature(project) {
  return memo(project, 'production', () => productionSignatureRaw(project));
}
function productionSignatureRaw(project) {
  return productionIdentity(project, analysisSignature(project));
}
function scopeSignature(project, kind, targetId) {
  return memo(project, `scope:${kind}:${targetId}`, () => scopeSignatureRaw(project, kind, targetId));
}
function scopeSignatureRaw(project, kind, targetId) {
  return scopeIdentity(project, kind, targetId, analysisSignature(project));
}
export function jobMatches(project, job) {
  if ((!job?.input?.project && !job?.input?.scopeSignature) || job.projectId !== project.id) return false;
  const input = job.input;
  if (input.stills?.version === 'before-feedback') return false;
  const kind = input.shotId ? 'shot' : input.transitionId ? 'transition' : 'project';
  return scopeSignature(project, kind, input.shotId ?? input.transitionId) === (input.scopeSignature ?? scopeSignature(input.project, kind, input.shotId ?? input.transitionId));
}
const targetOf = (project, kind, id) => (kind === 'shot' ? project.shots : project.transitions).find((entry) => entry.id === id);
function validTechnical(project, target, kind) {
  if (target.status !== 'ready') return false;
  if (kind === 'transition' && target.mode === 'cut' && target.inputRevision === 0) return true;
  if (target.validation?.inputToken !== target.inputToken) return false;
  if (kind === 'transition') {
    return target.validation.leftInputToken === targetOf(project, 'shot', target.fromShotId)?.inputToken && target.validation.rightInputToken === targetOf(project, 'shot', target.toShotId)?.inputToken;
  }
  return true;
}
function reviewState(project) {
  const review = project.director?.review;
  return review ? { ...review, current: review.signature === productionSignature(project) } : { current: false };
}

export function submitDirector(id, expectedProjectRevision, input, author = 'mcp') {
  object(input, 'director');
  check(['mcp', 'human'].includes(author), 'invalid director author');
  check(Number.isInteger(expectedProjectRevision), '需要 expectedProjectRevision');
  const brief = object(input.brief, 'brief'), style = object(input.style, 'style'), rhythm = object(input.rhythm, 'rhythm');
  const prepared = {
    brief: { intent: text(brief.intent, 'brief.intent'), audience: text(brief.audience, 'brief.audience', 300), mustKeep: strings(brief.mustKeep ?? [], 'mustKeep'), mustAvoid: strings(brief.mustAvoid ?? [], 'mustAvoid') },
    style: Object.fromEntries(['medium', 'typography', 'composition', 'motion', 'motif'].map((key) => [key, text(style[key], `style.${key}`, 1000)])),
    rhythm: { sections: rhythm.sections, accents: rhythm.accents ?? [] },
    shots: input.shots ?? [],
    maxRepairs: input.maxRepairs ?? 2,
  };
  prepared.style.palette = strings(style.palette, 'style.palette');
  check(prepared.style.palette.length > 0, '色板不能为空');
  check(Number.isInteger(prepared.maxRepairs) && prepared.maxRepairs >= 0 && prepared.maxRepairs <= 2, 'maxRepairs 为0..2');
  check(Array.isArray(prepared.shots) && prepared.shots.length <= 60, 'shots 需要数组（≤60）');
  check(Array.isArray(rhythm.sections) && rhythm.sections.length > 0 && rhythm.sections.length <= 100, 'rhythm.sections 需要段落目标');
  check(Array.isArray(prepared.rhythm.accents) && prepared.rhythm.accents.length <= 200, 'accents 最多200项');
  return mutateProject(id, expectedProjectRevision, (project) => {
    check(project.song, '先等待音乐分析', 409);
    const indices = new Set();
    prepared.rhythm.sections = rhythm.sections.map((section) => {
      check(Number.isInteger(section.sectionIndex) && project.song.sections?.[section.sectionIndex], 'sectionIndex 不存在');
      check(!indices.has(section.sectionIndex), '段落目标重复'); indices.add(section.sectionIndex);
      check(Number.isInteger(section.energy) && section.energy >= 1 && section.energy <= 5, 'energy 为1..5');
      return { sectionIndex: section.sectionIndex, energy: section.energy, intent: text(section.intent, '段落意图', 1000) };
    });
    check(indices.size === (project.song.sections ?? []).length, '节奏方案必须覆盖全部音乐段落');
    const beats = project.song.beats ?? [];
    const lines = project.song.lines ?? [];
    prepared.rhythm.accents = prepared.rhythm.accents.map((accent) => {
      let t;
      if (Number.isInteger(accent.beatIndex)) { t = beats[accent.beatIndex]; check(Number.isFinite(t), 'beatIndex 不存在'); }
      else {
        check(Number.isInteger(accent.lineIndex) && Number.isInteger(accent.wordIndex), '重音需要 beatIndex 或 lineIndex+wordIndex');
        t = lines[accent.lineIndex]?.words?.[accent.wordIndex]?.start; check(Number.isFinite(t), '词锚不存在');
      }
      return { ...(accent.beatIndex !== undefined ? { beatIndex: accent.beatIndex } : { lineIndex: accent.lineIndex, wordIndex: accent.wordIndex }), t, intent: text(accent.intent, '重音意图', 500) };
    });
    const ids = new Set();
    prepared.shots = prepared.shots.map((entry) => {
      check(project.shots.some((s) => s.id === entry.shotId) && !ids.has(entry.shotId), '镜头 brief ID 不存在或重复'); ids.add(entry.shotId);
      return { shotId: entry.shotId, ...Object.fromEntries(['subject', 'action', 'entrance', 'exit'].map((key) => [key, text(entry[key], `shots.${key}`, 1000)])) };
    });
    const old = project.director;
    project.director = { ...prepared, version: (old?.version ?? 0) + 1, analysisSignature: analysisSignature(project), author, updatedAt: Date.now(), appliedShots: {}, appliedTransitions: {}, operations: {}, review: null };
    if (old) project.director.history = [...(old.history ?? []), { version: old.version, brief: old.brief, style: old.style, rhythm: old.rhythm, updatedAt: old.updatedAt }].slice(-10);
    return project;
  });
}

function action(project, kind, targetKind, targetId, reason, extra = {}) {
  const scope = kind === 'analysis' || kind === 'retry' || kind === 'direction' || kind === 'plan' ? signature({ analysis: analysisSignature(project), status: project.status, direction: project.director?.version }) : scopeSignature(project, targetKind, targetId);
  const id = `op-${signature({ kind, targetKind, targetId, scope }).slice(0, 32)}`;
  const target = targetOf(project, targetKind, targetId);
  const args = { projectId: project.id, ...(targetKind === 'shot' ? { shotId: targetId } : targetKind === 'transition' ? { transitionId: targetId } : {}), ...(kind === 'plan' ? { expectedInputRevision: project.revision } : {}), ...extra };
  const operation = project.director?.operations?.[id];
  return { id, kind, targetKind, targetId, scope, tool: tools[kind], args, reason, ...(target ? { expectedInputRevision: target.inputRevision } : {}), ...(operation ? { operation: { status: operation.status, attempts: operation.attempts, owner: operation.owner, leaseExpiresAt: operation.leaseExpiresAt, jobIds: operation.jobIds, error: operation.error } } : {}) };
}
function rawNext(project, jobs) {
  const blockers = [], actions = [];
  let phase = 'direction';
  const add = (...args) => actions.push(action(project, ...args));
  const allTargets = [...project.shots.map((target) => ({ target, kind: 'shot' })), ...project.transitions.map((target) => ({ target, kind: 'transition' }))];
  if (project.status === 'analysis-pending') return { phase: 'analysis', actions, blockers: ['音乐分析仍在运行'], exportReady: false };
  if (project.status === 'analysis-failed') { add('retry', 'project', project.id, project.analysis.error ?? '分析失败'); return { phase: 'analysis', actions, blockers, exportReady: false }; }
  if (project.status === 'analysis-draft') { add('analysis', 'project', project.id, '读分析与节奏表，可靠核查后确认'); return { phase: 'analysis', actions, blockers, exportReady: false }; }
  if (!project.director || project.director.analysisSignature !== analysisSignature(project)) {
    add('direction', 'project', project.id, project.director ? '分析已变，更新导演方案' : '提交创作简报、风格基准与节奏方案');
    return { phase, actions, blockers, exportReady: false };
  }
  if (project.status === 'analysis-confirmed') { add('plan', 'project', project.id, '读 cue sheet 并提交原创切点规划'); return { phase: 'planning', actions, blockers, exportReady: false }; }
  check(!project.status || project.status === 'planned', '不支持的工程阶段');
  if (!project.shots.length) return { phase: 'planning', actions, blockers: ['工程没有镜头'], exportReady: false };
  const briefIds = new Set(project.director.shots.map((s) => s.shotId));
  if (project.shots.some((s) => !briefIds.has(s.id))) { add('direction', 'project', project.id, '补齐每镜 subject/action/entrance/exit 制作 brief'); return { phase: 'direction', actions, blockers, exportReady: false }; }
  for (const { target, kind } of allTargets) {
    const notes = (target.feedback ?? []).filter((n) => n.status !== 'accepted');
    if (notes.some((n) => n.status === 'needs-clarification')) { blockers.push(`${target.id} 等待人工澄清`); continue; }
    if (target.locked && (target.status === 'needs-generation' || (kind === 'shot' ? project.director.appliedShots[target.id] !== project.director.version : project.director.appliedTransitions[target.id] !== project.director.version))) { blockers.push(`${target.id} 已锁定，等待人解锁`); continue; }
    const applied = kind === 'shot' ? project.director.appliedShots[target.id] : project.director.appliedTransitions[target.id];
    const failedValidation = jobs.find((job) => job.kind === (kind === 'shot' ? 'validate' : 'validate-transition') && jobMatches(project, job) && job.input[kind === 'shot' ? 'shotId' : 'transitionId'] === target.id);
    if (target.status === 'needs-generation' || notes.some((n) => n.status === 'pending') || applied !== project.director.version || (kind === 'shot' && !target.module) || failedValidation?.status === 'error') {
      if (target.locked) { blockers.push(`${target.id} 已锁定`); continue; }
      add(kind === 'shot' ? 'generate' : 'transition', kind, target.id, failedValidation?.status === 'error' ? `技术验证失败，读取诊断后修复：${failedValidation.error}` : notes.length ? '按锚点与 preserve 响应意见并复验' : '按导演 brief 完成场景/转场', { directorBrief: kind === 'shot' ? project.director.shots.find((s) => s.shotId === target.id) : undefined });
      continue;
    }
    if (!validTechnical(project, target, kind)) add(kind === 'shot' ? 'validate' : 'validate-transition', kind, target.id, '验证当前源码/配置及依赖版本');
    if (notes.some((n) => n.status === 'responded')) blockers.push(`${target.id} 候选等待人对比采用或拒绝`);
  }
  if (actions.length) return { phase: actions.some((a) => ['generate', 'transition'].includes(a.kind)) ? 'producing' : 'validating', actions, blockers, exportReady: false };
  phase = 'reviewing';
  const currentReview = reviewState(project);
  if (currentReview.current) {
    for (const issue of currentReview.issues.filter((i) => i.severity === 'blocking')) {
      const target = [...project.shots, ...project.transitions].find((t) => t.id === issue.targetId);
      if (!target) { blockers.push(`全片审片阻塞：${issue.detail}（定位到具体镜头/转场后返工）`); continue; }
      const kind = project.shots.includes(target) ? 'shot' : 'transition';
      if (target.locked) blockers.push(`${target.id} 已锁定，无法修复审片问题`);
      else add(kind === 'shot' ? 'generate' : 'transition', kind, target.id, `审片返工：${issue.detail}`);
    }
    if (actions.length) return { phase: 'repairing', actions, blockers, exportReady: false };
  }
  const done = (kind, targetKind, targetId) => jobs.some((job) => job.kind === kind && job.status === 'done' && jobMatches(project, job) && (targetKind === 'project' ? !job.input.shotId && !job.input.transitionId && (kind !== 'rhythm' || (job.input.ae.start <= 1 / project.output.fps && job.input.ae.end >= project.song.duration - 1 / project.output.fps)) : job.input[targetKind === 'shot' ? 'shotId' : 'transitionId'] === targetId));
  for (const shot of project.shots) {
    if (!done('stills', 'shot', shot.id)) add('stills', 'shot', shot.id, '看开头、中段、末尾构图', { version: 'current' });
    if (!done('filmstrip', 'shot', shot.id)) add('filmstrip', 'shot', shot.id, '看连续动作与音乐落点');
  }
  for (const t of project.transitions.filter((t) => t.mode !== 'cut')) if (!done('filmstrip', 'transition', t.id)) add('filmstrip', 'transition', t.id, '看转场接缝与歌词提前暴露');
  if (!done('contact-sheet', 'project', project.id)) add('contact-sheet', 'project', project.id, '查看全片一致性、画面雷同和色彩推进');
  if (!done('rhythm', 'project', project.id)) add('rhythm', 'project', project.id, '核查全片节奏问题及风格提示');
  if (actions.length) return { phase, actions, blockers, exportReady: false };
  const review = reviewState(project);
  if (!review.current || review.issues?.some((i) => i.severity === 'blocking')) { add('review', 'project', project.id, '提交逐项证据化自评，处理阻塞问题；自评不代表人采用'); return { phase, actions, blockers, exportReady: false }; }
  if (blockers.length) return { phase: 'awaiting-human', actions, blockers, exportReady: false };
  const exported = jobs.some((job) => job.kind === 'export' && job.status === 'done' && jobMatches(project, job));
  if (!exported) add('export', 'project', project.id, '导出已自查的当前冻结版本');
  return { phase: exported ? 'exported' : 'export-ready', actions, blockers, exportReady: true };
}

export function getDirector(id) {
  return withSignatureMemo(() => getDirectorUncached(id));
}
function getDirectorUncached(id) {
  const project = readProject(id);
  const result = rawNext(project, listJobs(id, 10000));
  for (const item of result.actions) {
    const op = project.director?.operations?.[item.id];
    if (op?.status === 'claimed' && op.leaseExpiresAt > Date.now()) { item.blocked = true; result.blockers.push(`${item.targetId}: ${op.owner} 持有任务租约`); }
    // 已有工程（参考导入、旧工程）还没有导演方案时，只有 direction 类待办，没有租约与修复预算可算。
    if (!project.director) continue;
    const used = ['generate', 'transition'].includes(item.kind) ? Object.values(project.director.operations).filter((entry) => entry.kind === item.kind && entry.targetId === item.targetId).reduce((sum, entry) => sum + entry.attempts, 0) : op?.attempts ?? 0;
    if (used >= 1 + project.director.maxRepairs && !(op?.status === 'claimed' && op.leaseExpiresAt > Date.now())) { item.blocked = true; result.blockers.push(`${item.targetId}: 已耗尽初次尝试与修复预算`); }
  }
  const resumable = Object.values(project.director?.operations ?? {}).filter((op) => op.status === 'claimed' && op.directorVersion === project.director.version).map((op) => ({ actionId: op.id, kind: op.kind, targetId: op.targetId, owner: op.owner, attemptToken: op.attemptToken, leaseExpiresAt: op.leaseExpiresAt, expired: op.leaseExpiresAt <= Date.now(), receipt: op.receipt, jobIds: op.jobIds }));
  return { projectId: id, revision: project.revision, director: project.director ?? null, resumable, review: reviewState(project), ...result, exportReady: result.exportReady && reviewState(project).humanAccepted === true && !result.actions.some((a) => a.blocked), rule: 'AI 自评不是人工采用；不自行解锁或接受意见。' };
}

export function claimDirector(id, actionId, owner, leaseSeconds = 300) {
  owner = text(owner, 'owner', 120);
  check(Number.isInteger(leaseSeconds) && leaseSeconds >= 30 && leaseSeconds <= 900, 'leaseSeconds 为30..900');
  const context = getDirector(id);
  const current = readProject(id);
  const prior = current.director?.operations?.[actionId];
  const item = context.actions.find((a) => a.id === actionId) ?? (prior?.status === 'claimed' && prior.directorVersion === current.director.version ? { id: prior.id, kind: prior.kind, targetKind: prior.targetKind, targetId: prior.targetId, scope: prior.scope } : null);
  check(item && !['direction', 'analysis', 'retry', 'plan'].includes(item.kind), '先完成分析/方案/规划，再 claim 制作任务', 409);
  let result;
  mutateProject(id, context.revision, (project) => {
    const ops = project.director.operations;
    const old = ops[actionId];
    if (old?.status === 'claimed' && old.leaseExpiresAt > Date.now()) {
      const target = targetOf(project, old.targetKind, old.targetId);
      check(['generate', 'transition'].includes(old.kind) ? (old.receipt?.inputToken ?? old.cursorToken ?? old.targetToken) === target?.inputToken : scopeSignature(project, old.targetKind, old.targetId) === old.scope, '操作依赖已被外部编辑改变', 409);
      check(old.owner === owner, '任务已由另一操作者 claim', 409);
      old.leaseExpiresAt = Date.now() + leaseSeconds * 1000;
      result = old; return project;
    }
    const used = ['generate', 'transition'].includes(item.kind) ? Object.values(ops).filter((entry) => entry.kind === item.kind && entry.targetId === item.targetId).reduce((sum, entry) => sum + entry.attempts, 0) : old?.attempts ?? 0;
    check(used < 1 + project.director.maxRepairs, '修复预算耗尽', 409);
    check(!Object.values(ops).some((entry) => entry.id !== actionId && entry.targetId === item.targetId && entry.targetKind === item.targetKind && entry.status === 'claimed' && entry.leaseExpiresAt > Date.now()), '同一目标还有未完成租约，请先完成或等待过期', 409);
    const target = targetOf(project, item.targetKind, item.targetId);
    const receipt = old?.receipt && old.receipt.inputToken === target?.inputToken ? old.receipt : undefined;
    check(context.actions.some((a) => a.id === actionId) || receipt || (!['generate', 'transition'].includes(item.kind) && scopeSignature(project, item.targetKind, item.targetId) === item.scope), '过期任务的输入已变，请领取新待办', 409);
    result = { id: actionId, kind: item.kind, targetKind: item.targetKind, targetId: item.targetId, scope: item.scope, directorVersion: project.director.version, targetToken: target?.inputToken, ...(receipt ? { receipt } : {}), status: 'claimed', owner, leaseExpiresAt: Date.now() + leaseSeconds * 1000, attemptToken: randomUUID(), attempts: (old?.attempts ?? 0) + 1, jobIds: old?.jobIds ?? [], createdAt: old?.createdAt ?? Date.now() };
    ops[actionId] = result; return project;
  });
  return { projectId: id, operation: result, action: item };
}

export function completeDirector(id, actionId, attemptToken, { jobIds = [], outcome = 'done', error } = {}) {
  check(['done', 'failed'].includes(outcome) && Array.isArray(jobIds) && jobIds.length <= 100, 'invalid completion');
  let result;
  const project0 = readProject(id);
  const old = project0.director?.operations?.[actionId];
  check(old && old.attemptToken === attemptToken, '操作 token 不匹配', 409);
  if (old.status === 'done') return { projectId: id, operation: old, idempotent: true };
  const jobs = jobIds.map((jid) => readJob(id, jid));
  mutateProject(id, project0.revision, (project) => {
    const op = project.director.operations[actionId];
    check(op.status === 'claimed' && op.leaseExpiresAt > Date.now() && op.directorVersion === project.director.version, '操作租约已过期', 409);
    const target = targetOf(project, op.targetKind, op.targetId);
    const produced = ['generate', 'transition'].includes(op.kind);
    check(produced ? (op.receipt && op.receipt.inputToken === target?.inputToken) : scopeSignature(project, op.targetKind, op.targetId) === op.scope, '结果已过期或没有本操作提交凭据', 409);
    check(jobs.every((job) => jobMatches(project, job) && (op.targetKind === 'shot' ? job.input.shotId === op.targetId : op.targetKind === 'transition' ? job.input.transitionId === op.targetId : !job.input.shotId && !job.input.transitionId)), '任务结果不属于当前目标/版本', 409);
    if (outcome === 'done') {
      if (produced) check(target?.codeHash && target.status !== 'needs-generation' && !(target.feedback ?? []).some((n) => ['pending', 'needs-clarification'].includes(n.status)), '未完成源码/转场或意见响应', 409);
      else if (['validate', 'validate-transition'].includes(op.kind)) check(validTechnical(project, target, op.targetKind) && jobs.some((j) => j.kind === op.kind && j.status === 'done'), '缺少当前版本的技术验证', 409);
      else if (op.kind === 'review') check(reviewState(project).current, '缺少当前自评', 409);
      else check(jobs.some((j) => j.kind === op.kind && j.status === 'done'), '缺少已完成的对应任务', 409);
    } else { check(jobs.some((j) => ['error', 'interrupted', 'cancelled'].includes(j.status)), '失败需引用真实失败任务', 409); }
    op.status = outcome === 'done' ? 'done' : 'failed'; op.jobIds = jobIds; op.error = error ? String(error).slice(0, 2000) : jobs.find((j) => j.error)?.error; op.finishedAt = Date.now(); result = op; return project;
  });
  return { projectId: id, operation: result };
}

function artifactFiles(job) {
  const result = job.result ?? {};
  return [...(result.images ?? []), ...(result.stills?.images ?? [])].map((i) => i.file).concat(result.file ? [result.file] : []);
}
export function submitReview(id, expectedProjectRevision, review) {
  object(review, 'review');
  const project = readProject(id);
  check(project.director, '先建立导演方案', 409);
  check(Number.isInteger(expectedProjectRevision), '需要 expectedProjectRevision');
  check(project.director.analysisSignature === analysisSignature(project), '导演方案分析依赖已过期', 409);
  const assessments = object(review.assessments, 'assessments');
  for (const dimension of dimensions) text(assessments[dimension], `assessments.${dimension}`, 2000);
  const summary = text(review.summary, 'summary', 3000);
  check(Array.isArray(review.evidence) && review.evidence.length > 0 && review.evidence.length <= 300, '需要真实证据（≤300）');
  check(Array.isArray(review.issues) && review.issues.length <= 100, 'issues 需要数组');
  const evidence = review.evidence.map((entry) => {
    const job = readJob(id, entry.jobId);
    check(job.status === 'done' && jobMatches(project, job), '证据未完成或已过期', 409);
    check(['stills', 'filmstrip', 'contact-sheet', 'rhythm'].includes(job.kind), '不是审片证据任务');
    const observation = text(entry.observation, '证据观察', 2000);
    const files = artifactFiles(job);
    const file = entry.file ?? files[0];
    check(typeof file === 'string' && files.includes(file) && /^artifacts\/[a-f0-9]{64}\.png$/.test(file), '证据文件不属于任务');
    const dir = realpathSync(projectDir(id));
    const path = resolve(dir, file);
    check(existsSync(path) && statSync(path).isFile() && realpathSync(path).startsWith(dir + sep), '证据文件不存在或越界');
    const contentHash = sha256(readFileSync(path));
    const declaredHash = files.includes(file) ? (Array.isArray(job.result?.images) ? job.result.images.find((image) => image.file === file)?.contentHash : job.result?.stills?.images?.find((image) => image.file === file)?.contentHash) : undefined;
    check(declaredHash && declaredHash === contentHash, '证据文件内容哈希缺失或与任务记录不匹配');
    const times = job.result.times ?? job.result.stills?.times ?? [];
    if (entry.t !== undefined) check(Number.isFinite(entry.t) && (times.length ? times.some((t) => Math.abs(t - entry.t) <= 1 / project.output.fps) : entry.t >= job.input.ae.start && entry.t <= job.input.ae.end), '证据时间未被任务采样');
    return { jobId: job.id, kind: job.kind, shotId: job.input.shotId, transitionId: job.input.transitionId, file, ...(entry.t !== undefined ? { t: entry.t } : {}), observation };
  });
  for (const shot of project.shots) for (const kind of ['stills', 'filmstrip']) check(evidence.some((e) => e.kind === kind && e.shotId === shot.id), `${shot.id} 缺少 ${kind} 证据`);
  for (const t of project.transitions.filter((t) => t.mode !== 'cut')) check(evidence.some((e) => e.kind === 'filmstrip' && e.transitionId === t.id), `${t.id} 缺转场动态证据`);
  for (const kind of ['contact-sheet', 'rhythm']) check(evidence.some((e) => {
    if (e.kind !== kind || e.shotId || e.transitionId) return false;
    const job = readJob(id, e.jobId);
    return kind !== 'rhythm' || (job.input.ae.start <= 1 / project.output.fps && job.input.ae.end >= project.song.duration - 1 / project.output.fps);
  }), `缺少全片 ${kind} 证据`);
  check(project.shots.every((s) => project.director.appliedShots[s.id] === project.director.version) && project.transitions.every((t) => project.director.appliedTransitions[t.id] === project.director.version), '导演方案尚未落实到所有镜头/转场', 409);
  const issues = review.issues.map((issue) => {
    check(['blocking', 'warning', 'intentional'].includes(issue.severity), 'issue severity 为 blocking/warning/intentional');
    if (issue.targetId) check([...project.shots, ...project.transitions].some((t) => t.id === issue.targetId), '问题目标不存在');
    if (issue.t !== undefined) check(Number.isFinite(issue.t) && issue.t >= 0 && issue.t <= project.song.duration, '问题时间越界');
    return { severity: issue.severity, ...(issue.targetId ? { targetId: issue.targetId } : {}), ...(issue.t !== undefined ? { t: issue.t } : {}), detail: text(issue.detail, '问题描述', 2000) };
  });
  check(allTechnical(project), '先完成当前版本技术验证', 409);
  return mutateProject(id, expectedProjectRevision, (current) => {
    check(productionSignature(current) === productionSignature(project), '审片输入已变', 409);
    current.director.review = { signature: productionSignature(current), summary, assessments: Object.fromEntries(dimensions.map((key) => [key, assessments[key]])), issues, evidence, protect: strings(review.protect ?? [], 'protect'), by: 'mcp', humanAccepted: false, submittedAt: Date.now() };
    return current;
  });
}
export function acceptDirectorReview(id, expectedProjectRevision) {
  check(Number.isSafeInteger(expectedProjectRevision) && expectedProjectRevision >= 0, '需要 expectedProjectRevision');
  return mutateProject(id, expectedProjectRevision, (project) => {
    const review = reviewState(project);
    check(review.current && review.issues.every((issue) => issue.severity !== 'blocking'), '只能接受当前版本且无阻塞问题的导演自评', 409);
    check(allTechnical(project), '先完成当前版本技术验证', 409);
    check(project.director?.review, '尚无可接受的导演自评', 409);
    project.director.review.humanAccepted = true;
    project.director.review.acceptedAt = Date.now();
    project.director.review.acceptedBy = 'human';
    return project;
  });
}
function allTechnical(project) { return project.shots.length > 0 && project.shots.every((s) => validTechnical(project, s, 'shot')) && project.transitions.every((t) => validTechnical(project, t, 'transition')); }
export function assertDirectorExport(project) {
  if (!project.director) return;
  check(project.director.analysisSignature === analysisSignature(project), '导演方案依赖的分析已变', 409);
  check(allTechnical(project), '导演流程要求全部当前版本技术验证通过', 409);
  const review = reviewState(project);
  check(review.current && review.humanAccepted === true && !review.issues.some((i) => i.severity === 'blocking'), '先完成当前版本的证据化审片、人工接受并消除阻塞问题', 409);
}

export function dispatchDirector(id, actionIds, attemptTokens, enqueue) {
  check(Array.isArray(actionIds) && actionIds.length > 0 && actionIds.length <= 100 && new Set(actionIds).size === actionIds.length, 'actionIds 为1..100个唯一ID');
  check(Array.isArray(attemptTokens) && attemptTokens.length === actionIds.length, 'attemptTokens 必须与 actionIds 对齐');
  const context = getDirector(id);
  const project = readProject(id);
  const selected = actionIds.map((aid, i) => {
    const op = project.director?.operations?.[aid];
    check(op?.status === 'claimed' && op.attemptToken === attemptTokens[i] && op.leaseExpiresAt > Date.now(), '先 claim 当前待办', 409);
    check(['validate', 'validate-transition', 'stills', 'filmstrip', 'rhythm', 'contact-sheet', 'export'].includes(op.kind), '此任务需要GLM判断，不能批量自动执行');
    check(op.directorVersion === project.director.version && scopeSignature(project, op.targetKind, op.targetId) === op.scope, '任务版本已过期', 409);
    const item = context.actions.find((a) => a.id === aid) ?? (op.jobIds.length ? { id: op.id } : null);
    check(item, '任务不再是当前待办', 409);
    return { op, item };
  });
  const results = selected.map(({ op, item }) => {
    const existing = (op.jobIds ?? []).map((jid) => readJob(id, jid)).find((j) => j.kind === op.kind && jobMatches(project, j) && !['error', 'cancelled', 'interrupted'].includes(j.status));
    if (existing) return { actionId: op.id, jobId: existing.id, status: existing.status, reused: true };
    const options = op.targetKind === 'shot' ? { shotId: op.targetId } : op.targetKind === 'transition' ? { transitionId: op.targetId } : {};
    const job = enqueue(id, op.kind, options);
    mutateProject(id, undefined, (current) => {
      const currentOp = current.director.operations[op.id];
      currentOp.jobIds = [...new Set([...(currentOp.jobIds ?? []), job.id])]; return current;
    });
    return { actionId: item.id, jobId: job.id, status: job.status, reused: false };
  });
  return { projectId: id, jobs: results };
}

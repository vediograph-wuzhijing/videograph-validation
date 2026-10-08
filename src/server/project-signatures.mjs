// Pure production identity shared by persistence, jobs and director decisions.
import { createHash } from 'node:crypto';
const signature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const analysisIdentity = project => signature({ audio: project.audio.hash, song: project.song });
const targetData = target => target && ({ id: target.id, token: target.inputToken, start: target.start, end: target.end, module: target.module, code: target.codeHash, params: target.params, post: target.post, mode: target.mode, duration: target.duration, from: target.fromShotId, to: target.toShotId });
export function productionIdentity(project, analysis = analysisIdentity(project)) {
  return signature({ engine: project.engineHash, analysis, soundtrack: project.vocal?.active?.mixHash ?? project.audio?.hash,
    output: project.output, direction: project.director?.version, shots: (project.shots ?? []).map(targetData), transitions: (project.transitions ?? []).map(targetData) });
}
export function scopeIdentity(project, kind, targetId, analysis = analysisIdentity(project)) {
  const shots = project.shots ?? [], transitions = project.transitions ?? [];
  if (kind === 'shot') return signature({ engine: project.engineHash, analysis, output: project.output, direction: project.director?.version,
    target: targetData(shots.find(s => s.id === targetId)), transitions: transitions.filter(t => t.fromShotId === targetId || t.toShotId === targetId)
      .map(t => ({ ...targetData(t), sides: shots.filter(s => s.id === t.fromShotId || s.id === t.toShotId).map(targetData) })) });
  if (kind === 'transition') {
    const t = transitions.find(entry => entry.id === targetId);
    return signature({ engine: project.engineHash, analysis, output: project.output, direction: project.director?.version,
      target: targetData(t), sides: shots.filter(s => s.id === t?.fromShotId || s.id === t?.toShotId).map(targetData) });
  }
  return productionIdentity(project, analysis);
}

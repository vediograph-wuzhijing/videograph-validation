import { join } from 'node:path';
import { readProject, projectDir } from './project-repository.mjs';
import { ProjectError } from './errors.mjs';
import { transitionPair, transitionWindow } from './transitions.mjs';
import { projectDataRoot } from './project-generation.mjs';
import { selectedAudio } from './audio-track.mjs';

export function prepareProjectPreview(id, options) {
  const project = readProject(id);
  const before = options.version === 'before-feedback';
  const transition = options.transitionId ? project.transitions.find((entry) => entry.id === options.transitionId) : null;
  if (options.transitionId && !transition) throw new ProjectError('transition not found', 404);
  const target = before ? transition ?? project.shots.find((shot) => shot.id === options.shotId) : null;
  if (before && !target?.reviewBaseline) throw new ProjectError('没有可比较的修改前版本');
  const key = `${id}:${options.transitionId ?? options.shotId ?? 'all'}:${before ? 'before' : 'current'}`;
  const transitions = before && transition ? project.transitions.map((entry) => entry.id === transition.id ? { ...entry, ...transition.reviewBaseline } : entry) : project.transitions;
  let shots = before && !transition ? project.shots.map((shot) => shot.id === target.id ? { ...shot, ...target.reviewBaseline } : shot) : project.shots;
  if (before && transition?.reviewBaselineSources) shots = shots.map((shot) => shot.id === transition.fromShotId ? { ...shot, ...transition.reviewBaselineSources.left } : shot.id === transition.toShotId ? { ...shot, ...transition.reviewBaselineSources.right } : shot);
  const serverOptions = { root: join(projectDir(id), 'engine'), dataRoot: projectDataRoot(projectDir(id), project), shots, transitions, fps: project.output.fps, audioFile: selectedAudio(project).engineFile };
  let range;
  if (transition) {
    const selectedTransition = transitions.find((entry) => entry.id === transition.id);
    const context = { ...project, shots };
    const window = transitionWindow(context, selectedTransition);
    const { left, right } = transitionPair(context, selectedTransition);
    range = { start: Math.max(left.start, window.start - .4), end: Math.min(right.end, window.end + .4), only: `${left.id},${right.id}` };
  } else if (options.shotId) {
    const selectedShot = shots.find((shot) => shot.id === options.shotId);
    if (!selectedShot) throw new ProjectError('shot not found', 404);
    range = { start: Math.round(selectedShot.start * project.output.fps) / project.output.fps,
      end: Math.round(selectedShot.end * project.output.fps) / project.output.fps, only: selectedShot.id };
  }
  return { key,revision:project.revision,serverOptions,range };
}
export async function createProjectPreview(previews,id,options,run) {
  const prepared = run ? await run('prepareProjectPreview',[id,options]) : prepareProjectPreview(id,options);
  const preview = await previews.get(prepared.key,prepared.revision,prepared.serverOptions);
  return {url:preview.server.url,revision:preview.revision,range:prepared.range};
}

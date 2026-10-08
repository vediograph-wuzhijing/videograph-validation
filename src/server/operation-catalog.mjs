// Fixed registry for worker execution. HTTP authorization stays in the host;
// workers never evaluate caller-supplied code or choose arbitrary module paths.
import * as repository from './project-repository.mjs';
import * as project from './project-store.mjs';
import * as song from './song-project.mjs';
import * as director from './director.mjs';
import * as vocal from './vocal-project.mjs';
import { createRenderJobs } from './render-jobs.mjs';
import { serviceDiagnostics } from './service-diagnostics.mjs';
const allowed = {
    repository: ['readProject', 'listProjects', 'listUnfinishedJobs', 'listJobsPage', 'projectVersion', 'readJob', 'readJobMetadata', 'saveJob', 'saveUnfinishedJob'],
    project: ['createProjectFromAudio', 'readShotSource', 'readShotLyricContext', 'submitShotSource', 'submitSceneModule', 'updateShot', 'addShotFeedback', 'acceptShotFeedback', 'rejectShotFeedback', 'askFeedback', 'replyFeedback', 'updateTransition', 'configureTransition'],
    song: ['confirmSongAnalysis', 'submitSongLyrics', 'submitPlan', 'retryAnalysis', 'patchSongAnalysis', 'analysisInput', 'completeAnalysis', 'failAnalysis', 'resumeExternalAnalysis'],
    director: ['getDirector', 'submitDirector', 'claimDirector', 'completeDirector', 'submitReview', 'acceptDirectorReview'],
    vocal: ['vocalState', 'checkVocal', 'importVocalMidi', 'submitExternalVocal', 'submitVocal', 'createVocalJob', 'adoptVocal', 'resetVocal'],
};
const modules = { repository, project, song, director, vocal };
export const operations = Object.fromEntries(Object.entries(allowed).flatMap(([module, names]) => names.map(name => [name, modules[module][name]])));
operations.getSongAnalysis = (id, query) => song.getSongAnalysis(id, new URLSearchParams(query));
operations.prepareRenderJob = (...args) => createRenderJobs({ enqueue() { } }).enqueue(...args);
operations.dispatchDirector = (...args) => director.dispatchDirector(...args, createRenderJobs({ enqueue() { } }).enqueue);
operations.serviceDiagnostics = serviceDiagnostics;
operations.prepareProjectPreview = async (...args) => (await import('./preview-project.mjs')).prepareProjectPreview(...args);
operations.feedbackInbox = project.feedbackInbox;
operations.effectLibrary = async () => {
    const { effects, problems, glTransitions } = await (await import('./fx/effects.mjs')).allEffects();
    return { effects: effects.filter(effect => !effect.unsupported), problems, glTransitions };
};
operations.migrateProjectStorage = async (...args) => (await import('./storage-maintenance.mjs')).migrateProjectStorage(...args);
operations.retainProjectStorage = async (...args) => (await import('./storage-retention.mjs')).retainProjectStorage(...args);
operations.analyzerSettings = async () => {
    const runner = await import('../song/analyzer-runner.mjs');
    return { python: runner.analyzerPython(), t3Python: runner.analyzerT3Python() };
};
for (const name of ['prepareSceneDraft', 'checkSceneDraft', 'sampleSceneDraft'])
    operations[name] = async (...args) => (await import('./scene-drafts.mjs'))[name](...args);
for (const name of ['sceneComponents', 'sceneComponent'])
    operations[name] = async (...args) => (await import('./scene-library.mjs'))[name](...args);

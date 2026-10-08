import { encodeSnapshot, decodeSnapshot, putRecordObject, getRecordObject } from './record-objects.mjs';
import { scopeIdentity } from './project-signatures.mjs';
export function encodeJobRecord(dir, job) {
    const { _recordRefs = {}, ...record } = job, refs = { ..._recordRefs };
    if (job.input?.project) {
        refs.input = putRecordObject(dir, encodeSnapshot(dir, job.input));
        const { project, configuration, ...parameters } = job.input;
        record.input = { ...parameters, projectRevision: project.revision,
            scopeSignature: scopeIdentity(project, parameters.shotId ? 'shot' : parameters.transitionId ? 'transition' : 'project', parameters.shotId ?? parameters.transitionId) };
    }
    if (job.result !== undefined && !job._resultSummary) {
        refs.result = putRecordObject(dir, encodeSnapshot(dir, job.result));
        record.result = resultSummary(job.result);
    }
    delete record._resultSummary;
    return { ...record, _recordRefs: refs, _resultSummary: refs.result !== undefined };
}
export function resultSummary(result) {
    if (!result || typeof result !== 'object')
        return result;
    return Object.fromEntries(['file', 'frames', 'seconds', 'cacheSummary', 'mixFile', 'stemFile', 'pitchReportFile', 'bandReportFile', 'stale', 'inputToken', 'mixHash', 'stemHash', 'timingSource']
        .filter(key => result[key] !== undefined).map(key => [key, result[key]]));
}
export function decodeJobRecord(dir, record, { input = true, result = true } = {}, cache = new Map()) {
    if (!record)
        return record;
    const restored = { ...record };
    if (input && record._recordRefs?.input)
        restored.input = decodeSnapshot(dir, getRecordObject(dir, record._recordRefs.input, cache), cache);
    if (result && record._recordRefs?.result) {
        restored.result = decodeSnapshot(dir, getRecordObject(dir, record._recordRefs.result, cache), cache);
        delete restored._resultSummary;
    }
    return restored;
}
export function jobSummary(job) {
    const { input, _recordRefs, _resultSummary, result, ...fields } = job;
    const parameters = input ? { ...input } : undefined;
    if (parameters?.project) {
        parameters.projectRevision = parameters.project.revision;
        parameters.scopeSignature = scopeIdentity(parameters.project, parameters.shotId ? 'shot' : parameters.transitionId ? 'transition' : 'project', parameters.shotId ?? parameters.transitionId);
        delete parameters.project;
    }
    if (parameters)
        delete parameters.configuration;
    return { ...fields, ...(parameters ? { input: parameters } : {}), ...(result === undefined ? {} : { result: resultSummary(result) }) };
}

// @ts-check
export class ProjectError extends Error {
  /** details 会并入错误响应体（例如重复建工程时的 existingProjects），供调用方据此改用已有资源。 */
  /** @param {string} message @param {number} [status] @param {Record<string, unknown>} [details] */
  constructor(message, status = 400, details) { super(message); this.status = status; if (details) this.details = details; }
}

/** @param {unknown} value @param {string} [name] */
export function requireRevision(value, name = 'expectedRevision') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ProjectError(`${name} must be a non-negative safe integer`, 400);
  return value;
}

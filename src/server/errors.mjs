export class ProjectError extends Error {
  /** details 会并入错误响应体（例如重复建工程时的 existingProjects），供调用方据此改用已有资源。 */
  constructor(message, status = 400, details) { super(message); this.status = status; if (details) this.details = details; }
}

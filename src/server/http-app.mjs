// @ts-check
// Transport and authorization only. Domain routes receive an already authenticated context.
import { createServiceAuth, authorizeMutation } from './auth.mjs';
import { readJsonObject, decodePath, publicError } from './http.mjs';

/** @typedef {import('node:http').IncomingMessage} Request */
/** @typedef {import('node:http').ServerResponse} Response */
/** @typedef {{ req: Request, res: Response, url: URL, parts: string[], id?: string,
 * actor: string | null, json: typeof json,
 * body: (request: Request) => Promise<Record<string, unknown>> }} RouteContext */
/** @typedef {(context: RouteContext) => Promise<boolean>} RouteHandler */

/** @param {Response} res @param {unknown} data @param {number} [status] */
export function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

/** @param {{ allowedOrigins: Set<string>, auth: ReturnType<typeof createServiceAuth>,
 * health: () => unknown, route: RouteHandler }} options */
export function createHttpHandler({ allowedOrigins, auth, health, route }) {
  /** @param {Request} req @param {Response} res */
  return async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) { json(res, { error: 'origin not allowed' }, 403); return; }
    if (origin) res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-file-name, authorization' });
      res.end(); return;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean).map(decodePath);
      if (url.pathname === '/session' && req.method === 'GET') { json(res, auth.session(origin)); return; }
      const artifactRead = req.method === 'GET' && parts[0] === 'projects' && parts[2] === 'files';
      const actor = url.pathname === '/health' || artifactRead ? null : auth.actor(req.headers.authorization);
      /** @param {Request} request */
      const body = async (request) => {
        const input = await readJsonObject(request);
        authorizeMutation(actor, parts, input);
        return { ...input, author: actor };
      };
      if (url.pathname === '/health') { json(res, health()); return; }
      if (!await route({ req, res, url, parts, actor, body, json })) json(res, { error: 'route not found' }, 404);
    } catch (error) {
      if (!res.headersSent) { const result = publicError(error); json(res, result.data, result.status); }
      else res.destroy();
    }
  };
}

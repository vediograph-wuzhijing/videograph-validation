import type { VideoProject } from './contracts';
export type * from './contracts';

export class ProjectApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'ProjectApiError'; }
}
declare global {interface Window {__VIDEOGRAPH_CONFIG__?: {serviceUrl?:string}}}
export const serviceUrl = (window.__VIDEOGRAPH_CONFIG__?.serviceUrl || import.meta.env.VITE_VIDEOGRAPH_SERVICE_URL || 'http://127.0.0.1:5191').replace(/\/$/, '');
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
  const response = await fetch(serviceUrl + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(/\/draft\/|\/vocal\/import-audio$/.test(path) ? 300000 : 15000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return readResponse<T>(response);
}
export async function importBgm(file: File): Promise<VideoProject> {
  if (!token) await authorize();
  const response = await fetch(`${serviceUrl}/import-audio`, { method: 'POST', signal: AbortSignal.timeout(300000), headers: { authorization: `Bearer ${token}`, 'x-file-name': encodeURIComponent(file.name) }, body: file });
  return readResponse<VideoProject>(response);
}
export const projectFile = (projectId: string, file: string) => `${serviceUrl}/projects/${encodeURIComponent(projectId)}/files/${file.split('/').map(encodeURIComponent).join('/')}`;

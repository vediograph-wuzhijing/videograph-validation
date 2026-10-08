import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { ProjectError } from './errors.mjs';
import { streamFile } from './http.mjs';

const TYPES = { '.png': 'image/png', '.mp4': 'video/mp4', '.json': 'application/json', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.lrc': 'text/plain; charset=utf-8', '.ustx': 'text/yaml; charset=utf-8', '.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon' };
export function serveFile(req, res, path) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new ProjectError('file not found', 404);
  const size = statSync(path).size;
  let start = 0, end = size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) throw new ProjectError('unsupported range', 416);
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (![start, end].every(Number.isSafeInteger) || start > end || start >= size) { res.setHeader('content-range', `bytes */${size}`); throw new ProjectError('invalid range', 416); }
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
  }
  res.writeHead(req.headers.range ? 206 : 200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-cache', 'accept-ranges': 'bytes', 'content-length': Math.max(0, end - start + 1) });
  if (req.method === 'HEAD' || !size) res.end(); else streamFile(res, path, { start, end });
}

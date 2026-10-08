// Portable workbench owner. Stop is an authenticated request to this exact
// instance, never a PID/port based kill. Busy projects prevent restart.
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, openSync, closeSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireProcessLease } from '../src/platform/process-lease.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)), cache = join(root, '.cache');
mkdirSync(cache, { recursive: true });
const configPath = join(root, 'workbench.json'), settings = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const uiPort = Number(process.env.VIDEOGRAPH_STUDIO_PORT ?? settings.studioPort ?? 5188), servicePort = Number(process.env.VIDEOGRAPH_SERVICE_PORT ?? settings.servicePort ?? 5191);
if (![uiPort, servicePort].every(p => Number.isInteger(p) && p > 0 && p <= 65535) || uiPort === servicePort)
    throw new Error('workbench ports must be distinct integers in 1..65535');
const url = `http://127.0.0.1:${uiPort}`, statePath = join(cache, 'workbench.json'), lockPath = join(cache, 'workbench-owner.sqlite');
process.env.VIDEOGRAPH_SERVICE_PORT = String(servicePort);
process.env.VIDEOGRAPH_SERVICE_URL = `http://127.0.0.1:${servicePort}`;
process.env.VIDEOGRAPH_STUDIO_ORIGINS = `${url},http://localhost:${uiPort}`;
process.env.VIDEOGRAPH_PROJECTS = resolve(root, process.env.VIDEOGRAPH_PROJECTS ?? settings.projects ?? 'projects');
process.env.VIDEOGRAPH_SERVICE_TOKEN_FILE = resolve(root, process.env.VIDEOGRAPH_SERVICE_TOKEN_FILE ?? '.cache/service-token');
for (const key of ['FFMPEG_PATH', 'FFPROBE_PATH', 'EDGE_PATH', 'VIDEOGRAPH_ANALYZER_PYTHON', 'VIDEOGRAPH_ANALYZER_T3_PYTHON', 'VIDEOGRAPH_MODELS_DIR', 'VIDEOGRAPH_VOICEBANK_DIR', 'VIDEOGRAPH_OPENUTAU_RESAMPLER'])
    if (settings[key] && !process.env[key])
        process.env[key] = settings[key];
async function control(action) {
    if (!existsSync(statePath))
        throw new Error('没有此安装的运行记录；不会停止其他服务');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.root !== root)
        throw new Error('工作台记录属于另一安装；不会停止其他服务');
    const response = await fetch(`${state.url}/__workbench/${action}`, { method: action === 'status' ? 'GET' : 'POST', headers: { authorization: `Bearer ${state.controlToken}` }, signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok)
        throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
}
async function serve() {
    const releaseOwnership = acquireProcessLease(lockPath);
    let service, server, closing = false;
    const controlToken = randomUUID() + randomUUID(), dist = join(root, 'dist'), startedAt = Date.now();
    const shutdown = async () => {
        if (closing)
            return;
        closing = true;
        try {
            try {
                await service?.close();
            }
            finally {
                if (server?.listening)
                    await new Promise(done => { server.close(done); server.closeIdleConnections(); });
            }
        }
        finally {
            if (existsSync(statePath) && JSON.parse(readFileSync(statePath, 'utf8')).pid === process.pid)
                unlinkSync(statePath);
            releaseOwnership();
        }
    };
    try {
        if (!existsSync(join(dist, 'index.html')))
            throw new Error('缺少前端构建；开发源码先运行 npm run build');
        const { createProjectService } = await import('../src/server/service.mjs');
        service = createProjectService();
        const { serveFile } = await import('../src/server/media-files.mjs');
        const status = () => ({ root, pid: process.pid, startedAt, url, serviceUrl: process.env.VIDEOGRAPH_SERVICE_URL, health: service.health() });
        const send = (res, value, statusCode = 200) => { res.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
        server = createServer(async (req, res) => {
            try {
                const pathname = new URL(req.url, 'http://localhost').pathname;
                if (pathname.startsWith('/__workbench/')) {
                    if (req.headers.authorization !== `Bearer ${controlToken}`) {
                        send(res, { error: 'workbench authorization required' }, 401);
                        return;
                    }
                    if (pathname === '/__workbench/status' && req.method === 'GET') {
                        send(res, status());
                        return;
                    }
                    if (pathname === '/__workbench/stop' && req.method === 'POST') {
                        try {
                            await service.prepareIdleStop();
                        }
                        catch (error) {
                            send(res, { error: error.message }, error.status ?? 500);
                            return;
                        }
                        send(res, { stopping: true, pid: process.pid });
                        void shutdown().catch(error => { console.error(error); process.exitCode = 1; });
                        return;
                    }
                    send(res, { error: 'unknown control operation' }, 404);
                    return;
                }
                if (!['GET', 'HEAD'].includes(req.method)) {
                    res.writeHead(405);
                    res.end();
                    return;
                }
                const path = resolve(dist, '.' + decodeURIComponent(pathname)), rel = relative(dist, path);
                if (rel.startsWith('..') || isAbsolute(rel)) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
                if (existsSync(path) && statSync(path).isFile() && pathname !== '/index.html') {
                    const actual = realpathSync(path), inside = relative(realpathSync(dist), actual);
                    if (inside.startsWith('..') || isAbsolute(inside))
                        throw new Error('invalid static path');
                    serveFile(req, res, path);
                    return;
                }
                if (pathname !== '/' && pathname !== '/index.html') {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                // Runtime configuration is inserted before the built module imports so
                // custom ports do not require a rebuild or depend on an author's .env.
                const html = readFileSync(join(dist, 'index.html'), 'utf8').replace('<head>', `<head><script>window.__VIDEOGRAPH_CONFIG__=${JSON.stringify({ serviceUrl: process.env.VIDEOGRAPH_SERVICE_URL })}</script>`);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(req.method === 'HEAD' ? undefined : html);
            }
            catch (error) {
                if (!res.headersSent)
                    send(res, { error: error.message }, 500);
                else
                    res.destroy();
            }
        });
        await new Promise((done, reject) => { server.once('error', reject); server.listen(uiPort, '127.0.0.1', done); });
        await service.start();
        writeFileSync(statePath, JSON.stringify({ ...status(), controlToken }), { mode: 0o600 });
        console.log(`VideoGraph ${JSON.parse(readFileSync(join(root, 'package.json'))).version} ${url}/?view=project`);
        const onSignal = () => void shutdown().catch(error => { console.error(error); process.exitCode = 1; });
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
    }
    catch (error) {
        await shutdown();
        throw error;
    }
}
async function start() {
    const stdout = openSync(join(cache, 'workbench.log'), 'a'), stderr = openSync(join(cache, 'workbench-error.log'), 'a');
    const child = spawn(process.execPath, ['--env-file-if-exists=.env.local', fileURLToPath(import.meta.url), 'serve'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr], env: process.env });
    child.unref();
    closeSync(stdout);
    closeSync(stderr);
    for (let i = 0; i < 450; i++) {
        await new Promise(done => setTimeout(done, 100));
        try {
            const result = await control('status');
            if (result.pid === child.pid) {
                console.log(JSON.stringify(result));
                return;
            }
        }
        catch { }
        if (child.exitCode !== null)
            throw new Error('工作台启动失败；查看 .cache/workbench-error.log');
    }
    throw new Error('工作台仍在初始化；查看 status 和 .cache/workbench-error.log');
}
const command = process.argv[2] ?? 'start';
try {
    if (command === 'serve')
        await serve();
    else if (command === 'start')
        await start();
    else if (command === 'status')
        console.log(JSON.stringify(await control('status'), null, 2));
    else if (command === 'stop')
        console.log(JSON.stringify(await control('stop')));
    else if (command === 'mcp')
        await import('../src/pdoom/mcp-server.ts');
    else if (command === 'http-tools') {
        process.argv.splice(2, 1);
        await import('./project-client.mjs');
    }
    else if (command === 'doctor') {
        const { browserPath } = await import('../src/server/browser.mjs');
        const checks = [];
        for (const [name, command] of [['ffmpeg', process.env.FFMPEG_PATH ?? 'ffmpeg'], ['ffprobe', process.env.FFPROBE_PATH ?? 'ffprobe']]) {
            try {
                const result = await promisify(execFile)(command, ['-version'], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
                checks.push({ name, ready: true, version: result.stdout.split('\n')[0] });
            }
            catch (error) {
                checks.push({ name, ready: false, error: error.message });
            }
        }
        checks.push({ name: 'browser', ready: existsSync(browserPath()) }, { name: 'analysis-adapter', ready: existsSync(join(root, 'analyzer/analyze.py')), pythonConfigured: Boolean(process.env.VIDEOGRAPH_ANALYZER_PYTHON), modelsExternal: true }, { name: 'voicebank', configured: Boolean(process.env.VIDEOGRAPH_VOICEBANK_DIR), external: true });
        console.log(JSON.stringify({ node: process.version, checks }, null, 2));
        if (checks.some(c => c.ready === false))
            process.exitCode = 2;
    }
    else
        throw new Error('Usage: workbench.mjs start | status | stop | doctor');
}
catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}

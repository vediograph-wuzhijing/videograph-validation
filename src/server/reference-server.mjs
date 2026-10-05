// reference-server.mjs — 在本产品进程中运行可信的 P(DOOM) 引擎，不修改参考仓库。
import { createServer, normalizePath } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { renderShotsWithTransitions } from './transitions.mjs';
import { FX_COMMON, hexToVec3, resolveParams } from '../fx/runtime.mjs';

const productRoot = fileURLToPath(new URL('../..', import.meta.url));

// 注入页面的宿主代码（转场/特效运行时）即渲染输入，分段缓存键用它的内容；
// 本文件里对引擎源码的补丁逻辑改变渲染结果时，必须同时修改 HOST_PATCH_VERSION。
export const HOST_PATCH_VERSION = 'reference-patch-v1';
export const hostRuntimeSource = () => `const FX_COMMON = ${JSON.stringify(FX_COMMON)};\n${hexToVec3.toString()}\n${resolveParams.toString()}\n${readFileSync(new URL('./transition-runtime.mjs', import.meta.url), 'utf8')}`;

/** framePort：渲染进程的帧 socket 端口；只有它会被写进 CSP 的 connect-src（预览不需要任何外连）。 */
export async function startReferenceServer({ root = resolve(productRoot, '../pdoom-video'), port = 0, shots, transitions = [], fps = 30, audioFile = 'audio/pdoom.mp3', framePort } = {}) {
  if (!/^audio\/[a-z0-9._-]+$/i.test(audioFile) || audioFile.includes('..')) throw new Error('audioFile 必须位于引擎 audio/ 目录');
  if (framePort !== undefined && !Number.isInteger(framePort)) throw new Error('framePort 必须是整数端口');
  // 引擎根目录取真实路径：路径含软链接时（如 macOS 临时目录 /var → /private/var），Vite 把模块解析到真实路径，
  // 与按原路径配置的 root/fs.allow 不一致，会导致注入的镜头表不生效（画面全空）。
  root = realpathSync(root);
  const renderShots = shots ? renderShotsWithTransitions(shots, transitions, fps) : null;
  const dependencies = transitions.filter((transition) => transition.mode !== 'cut').map(({ fromShotId, toShotId }) => [fromShotId, toShotId]);
  const app = join(root, 'app');
  // 每个实例独立的依赖缓存目录：多个预览/渲染实例共用一个目录会互相改写元数据。
  const cacheDir = resolve(productRoot, '.cache/reference-vite', `${process.pid}-${randomUUID()}`);
  const connectSrc = framePort ? `'self' ws://127.0.0.1:${framePort}` : "'self'";
  const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src ${connectSrc}; object-src 'none'; base-uri 'none'`;
  let middlewares;
  const http = createHttpServer((req, res) => { res.setHeader('Content-Security-Policy', csp); middlewares(req, res); });
  const server = await createServer({
    configFile: false,
    root: app,
    publicDir: 'public',
    cacheDir,
    logLevel: 'error',
    plugins: [{
      name: 'videograph-reference-assets',
      resolveId(id) { if (id === 'virtual:videograph-transitions') return '\0videograph-transitions'; },
      // 特效箱宿主所需的着色器公共库与参数解析，直接取自 src/fx/runtime.mjs（与特效箱预览同一份实现）。
      load(id) { if (id === '\0videograph-transitions') return hostRuntimeSource(); },
      transformIndexHtml() {
        return [{ tag: 'link', attrs: { rel: 'icon', type: 'image/svg+xml', href: `/@fs/${normalizePath(join(productRoot, 'public/favicon.svg'))}` }, injectTo: 'head' }];
      },
      configureServer(vite) {
        vite.middlewares.use((req, _res, next) => {
          if (['/audio/', '/data/'].some((prefix) => req.url?.startsWith(prefix))) {
            req.url = `/@fs/${encodeURI(normalizePath(root))}${req.url}`;
          }
          next();
        });
      },
      transform(code, id) {
        if (shots && normalizePath(id).endsWith('/src/main.ts')) {
          const patched = code.replace("new Audio('audio/pdoom.mp3')", `new Audio(${JSON.stringify(audioFile)})`).replace('await engine.init(onlySet ? (e) => onlySet.has(e.id) : undefined);', `if (onlySet) for (const [from, to] of ${JSON.stringify(dependencies)}) if (onlySet.has(to)) onlySet.add(from);\n await engine.init(onlySet ? (e) => onlySet.has(e.id) : undefined);`)
            .replace('TIMELINE = engine.timeline;', `TIMELINE = !EXPORT && ONLY ? engine.timeline.filter(e => ONLY.split(",").includes(e.id)).map(e => ({...e, ...${JSON.stringify(shots.map(({ id, start, end }) => ({ id, start: Math.round(start * fps) / fps, end: Math.round(end * fps) / fps })))}.find(s => s.id === e.id)})) : engine.timeline;`)
            .replace('scrub.max = String(engine.duration);', 'scrub.min = String(params.get("rangeStart") ?? TIMELINE[0]?.start ?? 0); scrub.max = String(params.get("rangeEnd") ?? TIMELINE[TIMELINE.length - 1]?.end ?? engine.duration);')
            .replace('let loop: [number, number] | null = null;', 'let loop: [number, number] | null = ONLY && TIMELINE.length ? [Number(scrub.min), Number(scrub.max)] : null;');
          // FB-02：被嵌入工程界面的播放器每 250ms 向父页广播当前时间，供“定位到当前预览时间”。
          // 只在作为 iframe 嵌入时广播；时间来源优先引擎显式钩子 __videographTime()，否则解析 #info 开头的时间。
          // targetOrigin 用 '*'：父页 origin（studio 端口）与预览服务器端口不同且不可知；
          // 接收侧在 ProjectStudio 校验 event.origin === 预览 origin 且 event.source === 预览 iframe，载荷只是播放头时间。
          return `${patched}\n;(function () {\n  if (window.top === window) return;\n  setInterval(() => {\n    try {\n      const hook = window.__videographTime;\n      const info = document.getElementById('info');\n      const parsed = info ? Number.parseFloat(info.textContent ?? '') : NaN;\n      const t = typeof hook === 'function' ? Number(hook()) : parsed;\n      if (Number.isFinite(t)) parent.postMessage({ type: 'videograph:time', t }, '*');\n    } catch (error) { /* 时间广播失败不影响播放器自身 */ }\n  }, 250);\n})();\n`;
        }
        if (!renderShots || !normalizePath(id).endsWith('/src/timeline.ts')) return;
        const imports = `import { wrapTransitionScene } from 'virtual:videograph-transitions';\n` + renderShots.map((shot, index) => `const vgLoad${index} = async () => { const mod = await import('/src/scenes/${shot.module ?? '_window-template'}.ts'); return {default: wrapTransitionScene(mod.default, ${JSON.stringify({ start: shot.start, end: shot.end, logicalStart: shot.logicalStart, logicalEnd: shot.logicalEnd, incomingTransition: shot.incomingTransition, effects: (shot.effects ?? []).map(({ id, glsl, params, bindings, specs, declaresUniforms }) => ({ id, glsl, params, bindings, specs, declaresUniforms })) })}, ${fps})}; };`).join('\n');
        return `${code.replace('export function makeTimeline(', 'function referenceTimeline(')}\n${imports}\nexport function makeTimeline(ly, au) {\n const original = referenceTimeline(ly, au);\n return [${renderShots.map((shot, index) => `({...original.find(e=>e.id===${JSON.stringify(shot.id)}), ...${JSON.stringify({ id: shot.id, start: shot.start, end: shot.end, params: shot.params ?? {}, post: shot.post ?? {} })}, load: vgLoad${index}})`).join(',')}];\n}`;
      },
    }],
    resolve: { alias: {
      three: resolve(productRoot, 'node_modules/three/build/three.module.js'),
      'opentype.js': resolve(productRoot, 'node_modules/opentype.js/dist/opentype.mjs'),
    } },
    optimizeDeps: { noDiscovery: true, include: [] },
    // 中间件模式 + 自己 listen(0)：由系统分配端口。先探测空闲端口再释放会留下被其他实例抢占的窗口（历史上的端口冲突），
    // 而 vite 自己监听时 port 0 会被当作默认端口 5173。vite 客户端的 HMR socket 挂在同一端口（同源，CSP 'self' 即可）。
    server: { middlewareMode: true, hmr: { server: http },
      fs: { allow: [root, join(productRoot, 'node_modules'), join(productRoot, 'public/favicon.svg')] } },
  });
  middlewares = server.middlewares;
  const close = async () => {
    try {
      await server.close();
      if (http.listening) { http.closeAllConnections(); await new Promise((done) => http.close(done)); }
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  };
  try {
    await new Promise((listening, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', listening); });
  } catch (error) { await close(); throw error; }
  const url = `http://127.0.0.1:${http.address().port}`;
  // 长驻的预览实例可能因 esbuild 子进程退出而对所有 /src/*.ts 返回 500（BUG-04）：复用前探活。
  const healthy = async () => {
    try { return (await fetch(`${url}/src/main.ts`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  };
  return { url, close, healthy };
}

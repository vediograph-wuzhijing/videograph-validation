// Ephemeral source overrides never enter engine files, revisions or the job table.
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { readProject, projectDir, productRoot, sha256 } from './project-repository.mjs';
import { ProjectError, requireRevision } from './errors.mjs';
import { projectDataRoot } from './project-generation.mjs';
import { selectedAudio } from './audio-track.mjs';
import { lintSceneCode } from '../song/scene-lint.mjs';
import { startReferenceServer } from './reference-server.mjs';
import { browserPath, angleArgs } from './browser.mjs';
import { withTimeout } from './render-cache.mjs';
import { pageSample, pageComposeGrid } from './ae-page.mjs';
export function prepareSceneDraft(id, options) {
    requireRevision(options.expectedProjectRevision, 'expectedProjectRevision');
    const project = readProject(id);
    if (project.revision !== options.expectedProjectRevision)
        throw new ProjectError('草稿基线已改变，请重新读取工程', 409);
    const shot = project.shots.find(s => s.id === options.shotId);
    if (!shot)
        throw new ProjectError('shot not found', 404);
    let code = options.code;
    const root = join(projectDir(id), 'engine');
    if (code === undefined)
        code = readFileSync(join(root, 'app/src/scenes', `${shot.module ?? '_window-template'}.ts`), 'utf8');
    if (typeof code !== 'string' || code.length < 20 || code.length > 200000)
        throw new ProjectError('invalid draft code');
    const params = options.params ?? shot.params;
    if (!params || typeof params !== 'object' || Array.isArray(params) || JSON.stringify(params).length > 16000)
        throw new ProjectError('invalid draft params');
    const module = `_draft-${sha256(code)}`;
    return { projectId: id, revision: project.revision, shot: { ...shot, module, params }, code,
        serverOptions: { root, dataRoot: projectDataRoot(projectDir(id), project), shots: project.shots.map(s => s.id === shot.id ? { ...s, module, params } : s),
            transitions: project.transitions, fps: project.output.fps, audioFile: selectedAudio(project).engineFile, sceneOverrides: { [module]: code } },
        lyricLint: lintSceneCode(code, { lyrics: { lines: project.song?.lines ?? [] } }) };
}
function checkTypes(draft) {
    const path = resolve(draft.serverOptions.root, 'app/src/scenes', `${draft.shot.module}.ts`);
    const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true, noEmit: true, skipLibCheck: true, allowJs: true, checkJs: false, allowSyntheticDefaultImports: true,
        paths: { three: [join(productRoot, 'node_modules/@types/three/index.d.ts')], 'opentype.js': [join(productRoot, 'node_modules/opentype.js/dist/opentype.mjs')] } };
    const host = ts.createCompilerHost(options), originalGet = host.getSourceFile, originalExists = host.fileExists;
    host.fileExists = file => resolve(file) === path || originalExists(file);
    host.getSourceFile = (file, language, onError, newFile) => resolve(file) === path ? ts.createSourceFile(file, draft.code, language, true) : originalGet(file, language, onError, newFile);
    const program = ts.createProgram([path], options, host);
    return ts.getPreEmitDiagnostics(program).filter(d => !d.file || resolve(d.file.fileName) === path).map(d => ({
        code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        ...(d.file && d.start !== undefined ? { line: d.file.getLineAndCharacterOfPosition(d.start).line + 1, column: d.file.getLineAndCharacterOfPosition(d.start).character + 1 } : {})
    }));
}
async function withDraftPage(draft, action) {
    let server, browser;
    try {
        server = await startReferenceServer(draft.serverOptions);
        browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: angleArgs() });
        const page = await browser.newPage(), errors = [];
        await page.addInitScript(() => {
            window.__vgShaderErrors = [];
            for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext])
                if (Type) {
                    const compile = Type.prototype.compileShader, link = Type.prototype.linkProgram;
                    Type.prototype.compileShader = function (shader) { const value = compile.call(this, shader); if (!this.getShaderParameter(shader, this.COMPILE_STATUS))
                        window.__vgShaderErrors.push(this.getShaderInfoLog(shader) || 'shader compilation failed'); return value; };
                    Type.prototype.linkProgram = function (program) { const value = link.call(this, program); if (!this.getProgramParameter(program, this.LINK_STATUS))
                        window.__vgShaderErrors.push(this.getProgramInfoLog(program) || 'shader link failed'); return value; };
                }
        });
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', msg => { if (msg.type() === 'error')
            errors.push(msg.text()); });
        await page.goto(`${server.url}/?export=1&only=${encodeURIComponent(draft.shot.id)}`, { timeout: 30000 });
        await page.waitForFunction(() => window.__pdoom?.ready, {}, { timeout: 30000 });
        return await withTimeout(action(page, errors), 30000, () => { void browser.close(); return new ProjectError('草稿检查超时，场景代码可能没有返回', 422); });
    }
    finally {
        await browser?.close();
        await server?.close();
    }
}
export async function checkSceneDraft(id, options) {
    const draft = prepareSceneDraft(id, options), diagnostics = checkTypes(draft);
    if (diagnostics.length || !draft.lyricLint.ok)
        return { ok: false, revision: draft.revision, diagnostics, lyricLint: draft.lyricLint };
    const shaders = await withDraftPage(draft, async (page, errors) => {
        const coverage = await page.evaluate(() => {
            const engine = window.__pdoom.engine;
            if (!engine?.renderer)
                return { supported: false, compiled: 0, reason: '该引擎未公开 WebGL 编译接口' };
            let compiled = 0, seen = new Set();
            function visit(value, depth = 0) {
                if (!value || typeof value !== 'object' || seen.has(value) || depth > 8 || seen.size > 10000)
                    return;
                seen.add(value);
                if (value.scene?.isScene && (value.cam?.isCamera || value.camera?.isCamera)) {
                    engine.renderer.compile(value.scene, value.cam ?? value.camera);
                    compiled++;
                    return;
                }
                if (value === engine.renderer || value instanceof HTMLElement || ArrayBuffer.isView(value) || value.isTexture || value.isBufferGeometry || value.isWebGLRenderTarget)
                    return;
                if (value instanceof Map)
                    for (const v of value.values())
                        visit(v, depth + 1);
                else
                    for (const v of Object.values(value))
                        visit(v, depth + 1);
            }
            visit(engine);
            return { supported: true, compiled, coverage: 'initialized-materials', deferred: '运行 render 时动态创建的着色器需要正式验证' };
        });
        const engineErrors = await page.evaluate(() => [...(window.__pdoom.errors ?? []), ...(window.__vgShaderErrors ?? [])]);
        return { ...coverage, errors: [...errors, ...engineErrors] };
    });
    return { ok: shaders.supported && !shaders.errors.length, revision: draft.revision, diagnostics, lyricLint: draft.lyricLint, shaders };
}
export async function sampleSceneDraft(id, options) {
    const draft = prepareSceneDraft(id, options), times = options.times ?? [draft.shot.start + (draft.shot.end - draft.shot.start) * .45];
    if (!Array.isArray(times) || !times.length || times.length > 12 || times.some(t => !Number.isFinite(t) || t < draft.shot.start || t >= draft.shot.end))
        throw new ProjectError('草稿 times 必须在镜头内，最多12帧');
    return withDraftPage(draft, async (page, errors) => {
        const sample = await page.evaluate(pageSample, { times, thumbWidth: 480 });
        if (errors.length || sample.errors.length)
            throw new ProjectError([...errors, ...sample.errors].join('\n').slice(0, 4000), 422);
        const tiles = sample.thumbs.map((png, i) => ({ png, lines: [`镜头 ${draft.shot.id}`, `${times[i].toFixed(3)}s · 未提交草稿`] }));
        const png = await page.evaluate(pageComposeGrid, { tiles, columns: Math.min(4, tiles.length), tileWidth: 480, title: '草稿预览' });
        return { revision: draft.revision, shotId: draft.shot.id, times, image: { mimeType: 'image/png', base64: png }, ephemeral: true };
    });
}

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {copyFileSync,mkdirSync} from 'node:fs';

// 旧演示视图的 dev 中间件（llm-proxy / pdoom-task / shot-queue）已随 CLEANUP-01 移除；
// 真实工作台只依赖 5191 工程服务，前端不再有自定义后端路由。
export default defineConfig({
  plugins: [react(), {name:'licensed-public-assets',apply:'build',closeBundle(){
    // Audio stays in the operator's local public directory, never in a build.
    mkdirSync('dist/brand-demo',{recursive:true});
    for(const file of ['favicon.svg','brand-demo/demo-library.json','brand-demo/demo-logo.svg'])copyFileSync(`public/${file}`,`dist/${file}`);
  }}],
  build:{copyPublicDir:false},
  // strictPort：工程服务只允许 5188 的 Origin 取令牌，自动换到 5189 会让 /session 403。
  // watch.ignored：工程数据与缓存不参与热更新；Windows 上被监视的新目录无法改名（分析结果发布会 EPERM）。
  server: { port: 5188, host: '127.0.0.1', strictPort: true, watch: { ignored: ['**/projects/**', '**/.cache/**'] } },
});

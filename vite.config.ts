import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 旧演示视图的 dev 中间件（llm-proxy / pdoom-task / shot-queue）已随 CLEANUP-01 移除；
// 真实工作台只依赖 5191 工程服务，前端不再有自定义后端路由。
export default defineConfig({
  plugins: [react()],
  // strictPort：工程服务只允许 5188 的 Origin 取令牌，自动换到 5189 会让 /session 403。
  server: { port: 5188, host: '127.0.0.1', strictPort: true },
});

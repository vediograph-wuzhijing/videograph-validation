// free-port.mjs — 让系统分配一个当前空闲的本机端口（listen(0)），代替测试里的随机/固定端口区间。
// 端口关闭后再交给子进程仍有极小的被抢占窗口；这比重叠的随机区间可靠得多。
import { createServer } from 'node:net';

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

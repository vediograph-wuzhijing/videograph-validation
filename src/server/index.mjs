// Executable entry point. Application composition is importable from service.mjs.
import { createProjectService } from './service.mjs';

const service = createProjectService();
const shutdown = () => { void service.close().catch((error) => { console.error(error); process.exitCode = 1; }); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  const { url } = await service.start();
  console.log(`VideoGraph project service ${url}`);
} catch (error) { console.error(error); process.exitCode = 1; }

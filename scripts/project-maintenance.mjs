import { migrateProjectStorage } from '../src/server/storage-maintenance.mjs';
import { retainProjectStorage } from '../src/server/storage-retention.mjs';
const [command, id, ...flags] = process.argv.slice(2);
try {
  if (!id || !['migrate','retain'].includes(command) || flags.some(f => !['--vacuum','--apply'].includes(f))) throw new Error('Usage: node scripts/project-maintenance.mjs migrate <projectId> [--vacuum] | retain <projectId> [--apply]');
  if (command === 'migrate') console.log(JSON.stringify(migrateProjectStorage(id, { vacuum: flags.includes('--vacuum') }), null, 2));
  else console.log(JSON.stringify(retainProjectStorage(id, { apply: flags.includes('--apply') }), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }

import { backupProject, restoreProject, inspectProjectStorage } from '../src/server/project-backup.mjs';
const [command, first, second] = process.argv.slice(2);
try {
  if (command === 'inspect' && first) console.log(JSON.stringify(inspectProjectStorage(first), null, 2));
  else if (command === 'backup' && first && second) console.log(JSON.stringify(backupProject(first, second), null, 2));
  else if (command === 'restore' && first) console.log(JSON.stringify(restoreProject(first, second ? { id: second } : {}), null, 2));
  else throw new Error('Usage: node scripts/project-backup.mjs inspect <projectId> | backup <projectId> <new-directory> | restore <backup-directory> [new-projectId]');
} catch (error) { console.error(error.message); process.exitCode = 1; }

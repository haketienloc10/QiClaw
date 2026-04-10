import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectoryPath = dirname(fileURLToPath(import.meta.url));
const projectRootPath = dirname(scriptDirectoryPath);

copyDirectory(
  join(projectRootPath, 'src', 'agent', 'builtin-packages'),
  join(projectRootPath, 'dist', 'agent', 'builtin-packages')
);

copyDirectory(
  join(projectRootPath, 'src/tools/python'),
  join(projectRootPath, 'dist/tools/python')
);

function copyDirectory(sourceDirectoryPath, destinationDirectoryPath) {
  mkdirSync(dirname(destinationDirectoryPath), { recursive: true });
  rmSync(destinationDirectoryPath, { recursive: true, force: true });
  cpSync(sourceDirectoryPath, destinationDirectoryPath, { recursive: true, force: true });
}

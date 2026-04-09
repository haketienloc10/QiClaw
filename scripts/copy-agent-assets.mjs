import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectoryPath = dirname(fileURLToPath(import.meta.url));
const projectRootPath = dirname(scriptDirectoryPath);
const sourceDirectoryPath = join(projectRootPath, 'src', 'agent', 'builtin-packages');
const destinationDirectoryPath = join(projectRootPath, 'dist', 'agent', 'builtin-packages');

mkdirSync(dirname(destinationDirectoryPath), { recursive: true });
cpSync(sourceDirectoryPath, destinationDirectoryPath, { recursive: true, force: true });

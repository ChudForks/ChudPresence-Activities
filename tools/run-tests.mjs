import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const tests = [];
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (/\.test\.(?:js|mjs)$/.test(entry.name)) tests.push(file);
  }
}
await collect(path.join(root, 'tools'));
await collect(path.join(root, 'activities'));
if (!tests.length) {
  console.error('No local tests found. Tests are kept locally and ignored by Git; use npm run check:contract, npm run check:catalog and npm run typecheck for tracked repository validation.');
  process.exit(1);
}
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
execFileSync(process.execPath, ['--test', ...tests.sort()], { cwd: root, stdio: 'inherit', env });

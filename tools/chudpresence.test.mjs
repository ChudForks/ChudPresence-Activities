import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'tools', 'chudpresence.mjs');

test('SDK scaffolds, type-checks, bundles, validates, and tests a TypeScript Activity', async (t) => {
  const id = `sdk-check-${randomUUID().replaceAll('-', '').toLowerCase()}`;
  const directory = path.join(root, 'activities', id);
  let created = false;
  t.after(async () => {
    if (!created) return;
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8'));
    assert.equal(metadata.id, id, 'only remove the package created by this test');
    await fs.rm(directory, { recursive: true });
    execFileSync(process.execPath, ['tools/build-catalog.mjs'], { cwd: root, stdio: 'ignore' });
  });

  await assert.rejects(fs.access(directory));
  created = true;
  execFileSync(process.execPath, [cli, 'activity', 'new', id], { cwd: root, stdio: 'inherit' });
  await fs.writeFile(path.join(directory, 'src', 'title.ts'), `export const title = 'Bundled helper';\n`);
  await fs.writeFile(path.join(directory, 'src', 'index.ts'), `import type { ActivityReport } from '@chudpresence/activity-sdk/types';\nimport { title } from './title.js';\ndeclare const ChudPresence: { report(report: ActivityReport): Promise<unknown> };\nconst report: ActivityReport = { kind: 'generic', media: { title } };\nvoid ChudPresence.report(report);\n`);

  execFileSync(process.execPath, [cli, 'activity', 'build', id], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [cli, 'activity', 'validate', id], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [cli, 'activity', 'test', id], { cwd: root, stdio: 'inherit' });
  const bundle = await fs.readFile(path.join(directory, 'activity.js'), 'utf8');
  assert.match(bundle, /Bundled helper/);
  assert.doesNotMatch(bundle, /^import\s/m);
});

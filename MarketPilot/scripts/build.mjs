import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const check = spawnSync(process.execPath, [join(root, 'scripts', 'check.mjs')], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status || 1);

async function copyRuntime(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['dist', 'docs', 'scripts', 'node_modules'].includes(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await copyRuntime(from, to);
    else if (!['package.json', '.gitignore'].includes(entry.name)) await cp(from, to);
  }
}

await rm(dist, { recursive: true, force: true });
await copyRuntime(root, dist);
console.log('build ok: ' + dist);

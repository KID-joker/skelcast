import { copyFile, chmod } from 'node:fs/promises';
await copyFile(new URL('../src/virtual.d.ts', import.meta.url), new URL('../dist/virtual.d.ts', import.meta.url));
await chmod(new URL('../dist/cli.js', import.meta.url), 0o755);

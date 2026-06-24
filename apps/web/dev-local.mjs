/**
 * dev-local.mjs — local dev boot for the web app, hardened for Node >= 22.4.
 *
 * Node 22.4+ (and Node 25) ship an EXPERIMENTAL global `localStorage`. Next.js
 * SSR trips over it ("TypeError: localStorage.getItem is not a function") unless
 * `--localstorage-file` points at a real file. We add that flag ONLY on Node
 * versions that expose the experimental API — it's an unknown option on older
 * Node, so the guard keeps this safe across versions. No-op on Node < 22.4.
 *
 * The proper long-term fix is to use Node 22 LTS (the project's engines target);
 * this wrapper just unblocks dev on bleeding-edge Node without a version manager.
 *
 *   pnpm --filter @sivihub/whatsapp-hub-web dev:local       # → http://localhost:3003
 *   PORT=3010 pnpm --filter @sivihub/whatsapp-hub-web dev:local
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [major, minor] = process.versions.node.split('.').map(Number);
const hasExperimentalLocalStorage = major > 22 || (major === 22 && minor >= 4);

if (hasExperimentalLocalStorage) {
  const flag = `--localstorage-file=${join(tmpdir(), 'sivi-whatsapp-hub-web-localstorage')}`;
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${flag}`.trim();
}

const port = process.env.PORT ?? '3003';
const child = spawn('next', ['dev', '-p', port], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));

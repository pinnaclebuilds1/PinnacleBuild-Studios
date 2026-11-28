/**
 * Bundles the hosted Worker (worker/index.mjs plus the shared server modules)
 * into a single ES module, because the hosting uploader publishes the listed
 * files as-is instead of resolving imports.
 *
 * Run with: npm run build:worker
 */
import { build } from 'esbuild';
import fs from 'node:fs';

fs.mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['worker/index.mjs'],
  outfile: 'dist/worker.mjs',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  legalComments: 'none',
  logLevel: 'info'
});

const size = fs.statSync('dist/worker.mjs').size;
console.log(`Bundled dist/worker.mjs (${Math.round(size / 1024)} KB)`);

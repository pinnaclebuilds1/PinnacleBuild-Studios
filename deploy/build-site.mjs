/**
 * Builds the static folder that gets published.
 *
 * index.html is the single source of truth; this copies it into public/ with the
 * API address for the host that will serve it, and copies the site's own media
 * alongside it.
 *
 *   node deploy/build-site.mjs                        # same-origin API: /api
 *   node deploy/build-site.mjs --api https://host/api  # absolute API (GitHub Pages)
 *
 * Run with: npm run build:site
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');
const API_LINE = /window\.PINNACLE_API\s*=\s*"[^"]*";/;

function apiFromArgs(args) {
  const inline = args.find((arg) => arg.startsWith('--api='));
  if (inline) return inline.slice('--api='.length);
  const index = args.indexOf('--api');
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return process.env.PB_PUBLIC_API || '/api';
}

const api = String(apiFromArgs(process.argv.slice(2)) || '/api').trim() || '/api';

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!API_LINE.test(html)) {
  throw new Error('index.html no longer has a window.PINNACLE_API = "..."; line, so the build cannot point it at a server.');
}
html = html.replace(API_LINE, `window.PINNACLE_API = ${JSON.stringify(api)};`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// Images and files that ship with the site (kept relative so any host works).
const media = path.join(ROOT, 'media');
const mediaOut = path.join(OUT, 'media');
fs.rmSync(mediaOut, { recursive: true, force: true });
if (fs.existsSync(media)) {
  fs.cpSync(media, mediaOut, { recursive: true });
}

const mediaCount = fs.existsSync(mediaOut) ? fs.readdirSync(mediaOut).length : 0;
console.log(`Built public/index.html (${Math.round(html.length / 1024)} KB) pointing at ${api}`);
if (mediaCount) console.log(`Copied ${mediaCount} media file(s) into public/media`);
